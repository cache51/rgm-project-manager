#!/usr/bin/env node
/**
 * rgm-mcp — RGM's bug intake, as MCP tools.
 *
 * The product exists to carry a tester's report to whoever fixes it, and until
 * now that meant a person copying a prompt into an agent. This is the same
 * handoff with the agent driving: point it at a project, take the unresolved
 * bugs one at a time, pull the screenshots, ask when the report does not add up,
 * comment what was done, and leave the bug waiting for the filer to verify —
 * verification stays with the person who reported it.
 *
 * Credentials are the CLI's own (~/.rgm/config.json from `rgm login`), or
 * RGM_URL/RGM_TOKEN/RGM_PROJECT_ID in the environment. Nothing is stored here.
 *
 * Transport: MCP over stdio, newline-delimited JSON-RPC. No dependencies.
 */
import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
// The same extractor `rgm pull` uses, so the MCP inherits its path-traversal and
// symlink checks rather than unzipping by hand.
import { extractPacket, resolveProject } from '../src/cli.js';

const CONFIG_PATH = process.env.RGM_CONFIG ?? join(homedir(), '.rgm', 'config.json');
const VERSION = '0.1.0';

/**
 * Every tool that touches a bug takes the same optional project, because one
 * repository can hold several projects — a feature each — and then the directory
 * alone cannot decide which one is meant.
 */
const PROJECT_ARG = {
  project: {
    type: 'string',
    description: 'Project name or id. Needed only when this repository works more than one '
      + 'project; it overrides the repository binding.'
  }
};

async function loadConfig() {
  let file = {};
  try { file = JSON.parse(await readFile(CONFIG_PATH, 'utf8')); } catch { file = {}; }
  const url = process.env.RGM_URL ?? file.url;
  const token = process.env.RGM_TOKEN ?? file.token;
  // The project is not decided here: resolveProject() answers from the directory
  // this server was started in (the repository the agent is working in), then the
  // environment, then the machine-wide selection.
  const projectId = file.projectId ?? null;
  if (!url || !token) {
    throw new Error('no RGM credentials — run: rgm login --url <app-url> --token <api-token>'
      + ` (looked in ${CONFIG_PATH})`);
  }
  return { url: String(url).replace(/\/+$/, ''), token, projectId };
}

async function call(method, path, body) {
  const cfg = await loadConfig();
  const res = await fetch(`${cfg.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`${method} ${path} failed: ${res.status} ${detail}`);
  }
  return res;
}

async function json(method, path, body) {
  const res = await call(method, path, body);
  return res.json();
}

/**
 * The project this agent works in. In order: a project named at the call (see
 * projectInfo's `wanted`), the repository the *client session* is open in — asked
 * over MCP roots, because the plugin's server process starts wherever the harness
 * felt like, not necessarily in the user's checkout — then this process's own
 * directory, RGM_PROJECT_ID, and the machine-wide selection. A bug in the wrong
 * project is a fix nobody wanted, so every source is reported by name in the
 * output (RGM4-003). The last resort is the only visible project.
 */
async function projectInfo(wanted) {
  if (wanted) {
    const { projects } = await json('GET', '/api/projects');
    const match = projects.find((p) => p.id === wanted || p.name === wanted);
    if (!match) {
      throw new Error(`no project matching ${wanted} — you can see: `
        + projects.map((p) => `${p.name} (${p.id})`).join(', '));
    }
    return { id: match.id, name: match.name, where: 'the project argument' };
  }

  const cfg = await loadConfig();
  const resolved = await resolveProject({
    cwd: [...clientRoots(), process.cwd()],   // session repository first
    config: { projectId: cfg.projectId },
    env: process.env
  });
  if (resolved) {
    const inSessionRepo = resolved.boundAt
      && clientRoots().some((r) => resolved.boundAt === r || resolved.boundAt.startsWith(`${r}/`));
    return {
      id: resolved.id,
      name: resolved.name ?? null,
      where: resolved.boundAt
        ? `${resolved.boundAt}/.rgm/project.json${inSessionRepo ? ' (the session repository)' : ''}`
        : resolved.source === 'env' ? 'RGM_PROJECT_ID'
          : '~/.rgm/config.json (machine-wide)'
    };
  }
  const { projects } = await json('GET', '/api/projects');
  if (projects.length === 1) {
    return { id: projects[0].id, name: projects[0].name, where: 'the only project this token sees' };
  }
  throw new Error('no project selected — run `rgm use <project>` in this repository, '
    + 'or set RGM_PROJECT_ID.'
    + ` Visible projects: ${projects.map((p) => `${p.name} (${p.id})`).join(', ')}`);
}

async function project(wanted) { return (await projectInfo(wanted)).id; }

async function bugId(number, wanted) {
  const pid = await project(wanted);
  const found = await json('GET', `/api/projects/${pid}/bugs/by-number/${Number(number)}`);
  return { id: found.id, code: found.code, projectId: pid };
}

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

const TOOLS = [
  {
    name: 'rgm_projects',
    description: 'List the RGM projects this agent can see, with its role in each.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const { projects } = await json('GET', '/api/projects');
      return text(projects.map((p) => `${p.name}\t${p.role}\t${p.id}`).join('\n') || 'no projects');
    }
  },
  {
    name: 'rgm_list_bugs',
    description: 'List the unresolved bugs in this agent\'s project, oldest first, one line each. '
      + 'Work them one at a time: fetch with rgm_get_bug, verify, then rgm_mark_fixed.',
    inputSchema: { type: 'object', properties: { ...PROJECT_ARG }, additionalProperties: false },
    async run({ project: wanted }) {
      const p = await projectInfo(wanted);
      const { bugs, openCount } = await json('GET', `/api/projects/${p.id}/bugs`);
      const open = bugs.filter((b) => b.isOpen).sort((a, b) => a.bug_number - b.bug_number);
      // The project and where that answer came from, first, so an agent working
      // the wrong repository sees it in the call it was already going to make.
      const header = `project: ${p.name ?? p.id}  (from ${p.where})`;
      if (!open.length) return text(`${header}\nno unresolved bugs (${openCount} open)`);
      return text([header, ...open.map((b) => [
        b.code, b.status, b.severity, b.kind === 'feature' ? 'request' : 'bug',
        b.openQuestions ? `${b.openQuestions} unanswered question(s)` : null,
        b.title_vi
      ].filter(Boolean).join('  '))].join('\n'));
    }
  },
  {
    name: 'rgm_get_bug',
    description: 'Fetch one bug as the agent handoff prompt (tester\'s words, translations, '
      + 'status, attachments, and any questions still unanswered). Read this before starting.',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'integer', description: 'BUG number, e.g. 7 for BUG-7' },
        ...PROJECT_ARG
      },
      required: ['number'], additionalProperties: false
    },
    async run({ number, project: wanted }) {
      const { id, code } = await bugId(number, wanted);
      const [promptRes, bug] = await Promise.all([
        call('GET', `/api/bugs/${id}/prompt`),
        json('GET', `/api/bugs/${id}`)
      ]);
      const prompt = await promptRes.text();
      const open = (bug.questions?.questions ?? []).filter((q) => q.open);
      const header = [
        `# ${code} — ${bug.status} (${bug.severity})`,
        `project: ${bug.projectId}   milestone: ${bug.milestone?.code ?? '?'}`,
        `available actions: ${(bug.availableActions ?? [])
          .map((a) => (typeof a === 'string' ? a : [a.action ?? a.name, a.to].filter(Boolean).join(' → ')))
          .join(', ') || 'none'}`,
        open.length
          ? `UNANSWERED QUESTIONS (${open.length}) — ask again or wait; do not guess:\n`
            + open.map((q) => `- ${q.body}`).join('\n')
          : 'no unanswered questions',
        bug.attachments?.length
          ? `ATTACHMENTS (${bug.attachments.length}) — save these and look at them before deciding `
            + 'the report is clear; a screenshot often answers what the text does not:\n'
            + bug.attachments.map((a) => `- ${a.name} (${a.contentType}, ${a.byteSize} bytes)`).join('\n')
            + '\n  then: rgm_get_packet (all of them) or rgm_get_attachment (one)'
          : 'no attachments',
        '', '---', ''
      ].join('\n');
      return text(header + prompt);
    }
  },
  {
    name: 'rgm_get_packet',
    description: 'Download a bug\'s screenshots and bug.md into .rgm/<CODE>/ in the current '
      + 'directory, and return the file paths so you can look at the images. Do this before '
      + 'deciding a report is clear enough to act on.',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'integer' },
        dir: { type: 'string', description: 'where to unpack (default: .rgm)' },
        ...PROJECT_ARG
      },
      required: ['number'], additionalProperties: false
    },
    async run({ number, dir, project: wanted }) {
      const { id, code } = await bugId(number, wanted);
      const res = await call('GET', `/api/bugs/${id}/packet`);
      const zip = Buffer.from(await res.arrayBuffer());
      const outDir = join(dir ?? '.rgm', code);
      // Extracted, not merely downloaded: an agent that has to stop and unzip is
      // an agent that may never look at the screenshot at all.
      const written = await extractPacket(zip, outDir);
      return text([`${code}: ${written.length} file(s) in ${outDir}`, ''
      ].concat(written.map((f) => `  ${join(outDir, f)}`)).join('\n'));
    }
  },
  {
    name: 'rgm_get_attachment',
    description: 'Save one attachment (a screenshot) of a bug to a file so you can look at it. '
      + 'Names come from rgm_get_bug; rgm_get_packet saves every attachment at once.',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'integer' },
        name: { type: 'string', description: 'attachment name, e.g. screenshot_01.png' },
        out: { type: 'string', description: 'where to write it (default: .rgm/<CODE>/<name>)' },
        ...PROJECT_ARG
      },
      required: ['number', 'name'], additionalProperties: false
    },
    async run({ number, name, out, project: wanted }) {
      const { id, code } = await bugId(number, wanted);
      const bug = await json('GET', `/api/bugs/${id}`);
      const all = bug.attachments ?? [];
      const att = all.find((a) => a.name === name || a.originalFilename === name);
      if (!att) {
        throw new Error(`no attachment named "${name}" on ${code}`
          + (all.length ? ` — it has: ${all.map((a) => a.name).join(', ')}` : ' — it has none'));
      }
      const res = await call('GET', att.url);
      const bytes = Buffer.from(await res.arrayBuffer());
      const target = out ?? join('.rgm', code, att.name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      return text(`wrote ${target} (${bytes.byteLength} bytes, ${att.contentType ?? 'unknown type'})`);
    }
  },
  {
    name: 'rgm_ask_question',
    description: 'Ask the reporter to clarify something the report does not settle. It is emailed '
      + 'to the reporter and the bug\'s notification list, and stays open until answered — so ask, '
      + 'then continue with another bug or poll rgm_get_questions rather than guessing.',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'integer' },
        question: { type: 'string', description: 'what you need to know, as plainly as you can' },
        ...PROJECT_ARG
      },
      required: ['number', 'question'], additionalProperties: false
    },
    async run({ number, question, project: wanted }) {
      const { id, code } = await bugId(number, wanted);
      const out = await json('POST', `/api/bugs/${id}/questions`, { body: question });
      return text(`asked on ${code} (id ${out.id}); one mail to `
        + `${out.notified?.recipients ?? 0} recipient(s)`);
    }
  },
  {
    name: 'rgm_get_questions',
    description: 'Read the questions and answers on a bug. Use it to see whether a question you '
      + 'asked earlier has been answered before you carry on.',
    inputSchema: {
      type: 'object',
      properties: { number: { type: 'integer' }, ...PROJECT_ARG },
      required: ['number'], additionalProperties: false
    },
    async run({ number, project: wanted }) {
      const { id, code } = await bugId(number, wanted);
      const { open, questions } = await json('GET', `/api/bugs/${id}/questions`);
      if (!questions.length) return text(`${code}: no questions`);
      return text(`${code}: ${open} open\n` + questions.map((q) => {
        const answer = q.open ? '(unanswered)' : `answered by ${q.answer.by}: ${q.answer.text}`;
        return `- [${q.open ? 'open' : 'answered'}] ${q.body}\n    ${answer}`;
      }).join('\n'));
    }
  },
  {
    name: 'rgm_comment',
    description: 'Leave a note on the bug — what you changed, where, and anything the tester '
      + 'should look at when they verify. Keep it to what a tester needs to read.',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'integer' },
        note: { type: 'string' },
        ...PROJECT_ARG
      },
      required: ['number', 'note'], additionalProperties: false
    },
    async run({ number, note, project: wanted }) {
      const { id, code } = await bugId(number, wanted);
      await json('POST', `/api/bugs/${id}/comments`, { note });
      return text(`commented on ${code}`);
    }
  },
  {
    name: 'rgm_mark_fixed',
    description: 'Mark a bug fixed so the FILER can verify it: moves it to "fixed — awaiting '
      + 'verification" (starting the fix first if nobody had). Only call this after you have '
      + 'verified the fix yourself, and say what did the verifying: write a test that reproduces '
      + 'the report first, watch it fail, make it pass, and pass that test file (or the exact '
      + 'command, or how you checked it if the symptom cannot be automated) as verified_by. '
      + 'The tester closes the bug, not you.',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'integer' },
        verified_by: {
          type: 'string',
          description: 'what proves this is fixed — a test file and case name, or a command, or '
            + 'how you reproduced the original symptom and showed it gone'
        },
        note: { type: 'string', description: 'what to tell the tester about verifying this' },
        ...PROJECT_ARG
      },
      required: ['number', 'verified_by'], additionalProperties: false
    },
    async run({ number, verified_by: verifiedBy, note, project: wanted }) {
      // Required, not suggested: a "fixed" with no evidence is a claim the tester
      // has to re-do from scratch, and the report a self-test would have caught
      // comes straight back.
      const evidence = String(verifiedBy ?? '').trim();
      if (!evidence) {
        throw new Error('verified_by is required — write a test that reproduces the bug first '
          + '(watch it fail), make it pass, then name it here (or the exact command, or how you '
          + 'checked a symptom that cannot be automated)');
      }
      const { id, code } = await bugId(number, wanted);
      const before = await json('GET', `/api/bugs/${id}`);
      if (before.status === 'retest') return text(`${code} is already awaiting verification`);
      if (before.status === 'closed') throw new Error(`${code} is closed — reopen it before marking it fixed`);
      await json('POST', `/api/bugs/${id}/comments`, {
        note: [note, `Verified by: ${evidence}`].filter(Boolean).join('\n\n')
      });
      if (before.status === 'new') {
        await json('POST', `/api/bugs/${id}/status`, { action: 'start_fixing' });
      }
      await json('POST', `/api/bugs/${id}/status`, { action: 'request_retest' });
      const after = await json('GET', `/api/bugs/${id}`);
      return text(`${code} is now ${after.status} — awaiting verification by the filer`
        + (after.retestAttempt ? ` (attempt ${after.retestAttempt})` : '')
        + `\nwhat proves it: ${evidence}`);
    }
  }
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * MCP roots: the client's open directories, learned once per session.
 *
 * A plugin's server process starts wherever the harness launched it — not
 * necessarily inside the repository the user is working in, which is the whole
 * point of the binding. The protocol has exactly this answer: the client
 * advertises `roots`, the server asks `roots/list`, and the notification keeps
 * it current if the session moves. Claude Code implements roots; a client that
 * does not simply never gets asked, and the resolution falls through to this
 * process's own directory as before.
 */
let clientRootsList = null;
let rootsPoll = null;
let clientHasRoots = false;
let outboundId = 0;
const pendingOutbound = new Map();

function clientRoots() {
  return clientRootsList ?? [];
}

function noteClient(name) {
  process.stderr.write(`rgm-mcp: client ${name ?? 'unknown'}\n`);
}

async function pollRoots() {
  try {
    const { roots } = await request('roots/list');
    clientRootsList = (roots ?? []).map((r) => rootToPath(r.uri)).filter(Boolean);
  } catch {
    clientRootsList = [];   // roots came and went; the fall-through order still holds
  }
}

/** file:///Users/nelchan/... -> /Users/nelchan/..., percent-decoded. */
function rootToPath(uri) {
  const u = String(uri ?? '');
  if (!u.startsWith('file://')) return null;
  try { return decodeURIComponent(new URL(u).pathname); } catch { return null; }
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

/** An outbound request to the client, correlated by id, with a timeout. */
function request(method, params) {
  const id = `srv-${++outboundId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingOutbound.delete(id);
      reject(new Error(`${method} timed out`));
    }, 2000);
    pendingOutbound.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

async function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  if (method === 'initialize') {
    noteClient(params?.clientInfo?.name);
    // Roots are a *client* capability: this server may ask for the session's
    // directories only if the client said it has them.
    clientHasRoots = Boolean(params?.capabilities?.roots);
    return reply({
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'rgm', version: VERSION }
    });
  }
  if (method === 'notifications/initialized') {
    if (clientHasRoots) rootsPoll = pollRoots();   // before any tool can run
    return;
  }
  if (method === 'notifications/roots/list_changed') return void pollRoots();
  if (method === 'notifications/cancelled') return;
  if (method === 'ping') return reply({});
  if (method === 'tools/list') {
    if (rootsPoll) await rootsPoll.catch(() => {});   // the first call must not lose the race
    return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (method === 'tools/call') {
    const tool = byName.get(params?.name);
    if (!tool) return fail(-32602, `unknown tool: ${params?.name}`);
    try {
      if (rootsPoll) await rootsPoll.catch(() => {});
      return reply(await tool.run(params?.arguments ?? {}));
    } catch (err) {
      // A tool failure is a result the agent can read and act on, not a crash.
      return reply({ content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true });
    }
  }
  if (id !== undefined) fail(-32601, `unsupported method: ${method}`);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }

  // A response to one of our outbound requests (roots/list) resolves it;
  // anything else is a request/notification from the client.
  if (msg.id !== undefined && !msg.method && (msg.result !== undefined || msg.error !== undefined)) {
    const waiter = pendingOutbound.get(String(msg.id));
    if (waiter) {
      pendingOutbound.delete(String(msg.id));
      if (msg.error) waiter.reject(new Error(msg.error.message ?? 'client error'));
      else waiter.resolve(msg.result);
    }
    return;
  }

  handle(msg).catch((err) => {
    process.stderr.write(`rgm-mcp: ${String(err?.message ?? err)}\n`);
  });
});