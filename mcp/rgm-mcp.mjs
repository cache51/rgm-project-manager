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
import { extractPacket } from '../src/cli.js';

const CONFIG_PATH = process.env.RGM_CONFIG ?? join(homedir(), '.rgm', 'config.json');
const VERSION = '0.1.0';

async function loadConfig() {
  let file = {};
  try { file = JSON.parse(await readFile(CONFIG_PATH, 'utf8')); } catch { file = {}; }
  const url = process.env.RGM_URL ?? file.url;
  const token = process.env.RGM_TOKEN ?? file.token;
  const projectId = process.env.RGM_PROJECT_ID ?? file.projectId;
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

/** The project this agent works in: configured, or the only one it can see. */
async function project() {
  const cfg = await loadConfig();
  if (cfg.projectId) return cfg.projectId;
  const { projects } = await json('GET', '/api/projects');
  if (projects.length === 1) return projects[0].id;
  throw new Error('no project selected — run `rgm use <project>`, or set RGM_PROJECT_ID.'
    + ` Visible projects: ${projects.map((p) => `${p.name} (${p.id})`).join(', ')}`);
}

async function bugId(number) {
  const pid = await project();
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
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const pid = await project();
      const { bugs, openCount } = await json('GET', `/api/projects/${pid}/bugs`);
      const open = bugs.filter((b) => b.isOpen).sort((a, b) => a.bug_number - b.bug_number);
      if (!open.length) return text(`no unresolved bugs (${openCount} open)`);
      return text(open.map((b) => [
        b.code, b.status, b.severity, b.kind === 'feature' ? 'request' : 'bug',
        b.openQuestions ? `${b.openQuestions} unanswered question(s)` : null,
        b.title_vi
      ].filter(Boolean).join('  ')).join('\n'));
    }
  },
  {
    name: 'rgm_get_bug',
    description: 'Fetch one bug as the agent handoff prompt (tester\'s words, translations, '
      + 'status, attachments, and any questions still unanswered). Read this before starting.',
    inputSchema: {
      type: 'object',
      properties: { number: { type: 'integer', description: 'BUG number, e.g. 7 for BUG-7' } },
      required: ['number'], additionalProperties: false
    },
    async run({ number }) {
      const { id, code } = await bugId(number);
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
        dir: { type: 'string', description: 'where to unpack (default: .rgm)' }
      },
      required: ['number'], additionalProperties: false
    },
    async run({ number, dir }) {
      const { id, code } = await bugId(number);
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
        out: { type: 'string', description: 'where to write it (default: .rgm/<CODE>/<name>)' }
      },
      required: ['number', 'name'], additionalProperties: false
    },
    async run({ number, name, out }) {
      const { id, code } = await bugId(number);
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
        question: { type: 'string', description: 'what you need to know, as plainly as you can' }
      },
      required: ['number', 'question'], additionalProperties: false
    },
    async run({ number, question }) {
      const { id, code } = await bugId(number);
      const out = await json('POST', `/api/bugs/${id}/questions`, { body: question });
      return text(`asked on ${code} (id ${out.id}); notified ${out.notified?.queued ?? 0} address(es)`);
    }
  },
  {
    name: 'rgm_get_questions',
    description: 'Read the questions and answers on a bug. Use it to see whether a question you '
      + 'asked earlier has been answered before you carry on.',
    inputSchema: {
      type: 'object',
      properties: { number: { type: 'integer' } },
      required: ['number'], additionalProperties: false
    },
    async run({ number }) {
      const { id, code } = await bugId(number);
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
        note: { type: 'string' }
      },
      required: ['number', 'note'], additionalProperties: false
    },
    async run({ number, note }) {
      const { id, code } = await bugId(number);
      await json('POST', `/api/bugs/${id}/comments`, { note });
      return text(`commented on ${code}`);
    }
  },
  {
    name: 'rgm_mark_fixed',
    description: 'Mark a bug fixed so the FILER can verify it: moves it to "fixed — awaiting '
      + 'verification" (starting the fix first if nobody had). Only call this after you have '
      + 'verified the fix yourself — the tester\'s verification is what closes it. Optionally '
      + 'leaves a note for the tester in the same call.',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'integer' },
        note: { type: 'string', description: 'what to tell the tester about verifying this' }
      },
      required: ['number'], additionalProperties: false
    },
    async run({ number, note }) {
      const { id, code } = await bugId(number);
      const before = await json('GET', `/api/bugs/${id}`);
      if (before.status === 'retest') return text(`${code} is already awaiting verification`);
      if (before.status === 'closed') throw new Error(`${code} is closed — reopen it before marking it fixed`);
      if (note) await json('POST', `/api/bugs/${id}/comments`, { note });
      if (before.status === 'new') {
        await json('POST', `/api/bugs/${id}/status`, { action: 'start_fixing' });
      }
      await json('POST', `/api/bugs/${id}/status`, { action: 'request_retest' });
      const after = await json('GET', `/api/bugs/${id}`);
      return text(`${code} is now ${after.status} — awaiting verification by the filer`
        + (after.retestAttempt ? ` (attempt ${after.retestAttempt})` : ''));
    }
  }
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

async function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  const fail = (code, message) => process.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);

  if (method === 'initialize') {
    return reply({
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'rgm', version: VERSION }
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply({});
  if (method === 'tools/list') {
    return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (method === 'tools/call') {
    const tool = byName.get(params?.name);
    if (!tool) return fail(-32602, `unknown tool: ${params?.name}`);
    try {
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
  handle(msg).catch((err) => {
    process.stderr.write(`rgm-mcp: ${String(err?.message ?? err)}\n`);
  });
});