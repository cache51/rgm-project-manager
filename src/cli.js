#!/usr/bin/env node
/**
 * rgm — the developer-facing CLI (§10).
 *
 *   rgm login --url http://localhost:3000 --token <api-token>
 *   rgm projects
 *   rgm use <project-id-or-name>   # also binds the repository it is run in
 *   rgm project              # which project this directory works, and why
 *   rgm bugs --project "PO Auto-import"   # name it when one repository holds several
 *   rgm bugs
 *   rgm prompt 142            # print the agent handoff prompt to stdout
 *   rgm pull 142              # fetch the packet and extract it under .rgm/BUG-142
 *   # The way back for whoever is working a bug:
 *   rgm ask 142 "which warehouse is this lot in?"   # mailed to the reporter
 *   rgm questions 142        # questions and their answers, open or answered
 *   rgm comment 142 "fixed in abc1234"              # tell the tester what changed
 *   rgm fixed 142 --verified-by "test/packing.test.js: counts the last carton" \
 *                 --note "please re-check the packing list screen"
 *                            # hand it to the filer: fixed, awaiting verification.
 *                            # --verified-by is required: the tester needs to know
 *                            # what already proved it before they check it themselves.
 *   # Host-only one-shot task (no RGM login/token):
 *   rgm admin delete-project <uuid> --actor-email admin@example.com --reason "..." --force
 *
 * `pull` is the primary handoff path: it lands bug.md, meta.json and the
 * screenshots on disk, ready to hand to a coding agent. `fixed` deliberately
 * stops at "awaiting verification": closing a report is the filer's call.
 */
import { readFile, writeFile, mkdir, lstat, rm, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { readZip } from './unzip.js';
import { assertSafeRelativePath, packetPathFor } from './packet.js';
import { purgeProject } from './admin-purge.js';
import { createDb } from './db.js';
import { loadConfig as loadEnvironmentConfig } from './config.js';

export const CONFIG_PATH = process.env.RGM_CONFIG ?? join(homedir(), '.rgm', 'config.json');

/** The file that records which project a working directory pulls from. */
export const BINDING_FILE = 'project.json';

/**
 * Extract a packet archive into `targetDir`.
 *
 * Every entry name is validated before anything is written, so a hostile archive
 * cannot escape the target directory even if the server-side naming were
 * compromised. This is the second, independent line of defence for RGM3-007.
 *
 * @returns {Promise<string[]>} the entry names written
 */
export async function extractPacket(zipBuffer, targetDir) {
  const entries = readZip(zipBuffer);

  // Validate everything BEFORE writing anything: a bad archive must not leave a
  // half-extracted directory behind. Directory entries (name ending in "/") are
  // skipped rather than validated — archives produced by a standard zip tool
  // contain them, and their directories are created implicitly when their files
  // are written, so nothing is lost by ignoring them.
  const files = entries.filter(e => !e.name.endsWith('/'));
  for (const entry of files) {
    assertSafeRelativePath(entry.name);
  }

  // The packet directory and its parent must be real directories, not links.
  //
  // `assertNoSymlinkedAncestor` below only walks components *under* the target, so
  // a packet directory that is itself a symlink — `ln -s /somewhere/else
  // .rgm/BUG-1` — sent every `rm` and `writeFile` outside the packet tree
  // (RGM4-002). Checked before anything is written.
  await assertNotSymlink(targetDir, 'the packet directory');
  await assertNotSymlink(dirname(targetDir), 'the output root');

  await mkdir(targetDir, { recursive: true });
  const written = [];
  for (const entry of files) {
    // IR-010: validating the path string is not enough. If `.rgm/BUG-1/bug.md`
    // already exists as a symlink to a source file, a plain write follows it and
    // overwrites the source. Removing first discards the link itself, and `wx`
    // makes the write create a new file rather than follow one — so neither the
    // leaf nor an ancestor can be used to escape the packet directory.
    await assertNoSymlinkedAncestor(targetDir, entry.name);
    const path = packetPathFor(targetDir, entry.name);
    await mkdir(dirname(path), { recursive: true });
    await rm(path, { force: true });
    await writeFile(path, entry.data, { flag: 'wx' });
    written.push(entry.name);
  }
  return written;
}

/**
 * Refuse to use a path that is a symbolic link.
 *
 * A symlinked packet directory or output root places the whole extraction outside
 * the tree the caller believes it is writing into, and neither `rm` nor `writeFile`
 * respects that boundary (RGM4-002).
 */
async function assertNotSymlink(path, what) {
  let stat;
  try {
    stat = await lstat(path);
  } catch (err) {
    if (err.code === 'ENOENT') return;             // nothing there yet: it will be created
    throw err;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(
      `refusing to extract: ${what} ${path} is a symbolic link, which would place the `
      + `packet outside the intended directory — remove it, or pass --out elsewhere`);
  }
}

/**
 * Refuse to extract into a symlinked directory.
 *
 * Only components that already exist are checked; the rest are created as real
 * directories by `mkdir`.
 */
async function assertNoSymlinkedAncestor(targetDir, relPath) {
  const segments = relPath.split('/').slice(0, -1);
  let current = targetDir;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`refusing to extract through the symlinked directory ${current}`);
      }
    } catch (err) {
      if (err.code === 'ENOENT') return;             // will be created for real
      throw err;
    }
  }
}

/**
 * Walk up from `startDir` for the nearest repository binding, or null.
 *
 * The nearest one wins, so a checkout inside another checkout belongs to the
 * innermost project — the one someone actually bound.
 */
export async function findRepoBinding(dirs) {
  const list = typeof dirs === 'string' ? [dirs] : (dirs?.length ? dirs : [process.cwd()]);
  for (const start of list) {          // earlier directories take precedence
    let dir = start;
    for (;;) {
      try {
        const parsed = JSON.parse(await readFile(join(dir, '.rgm', BINDING_FILE), 'utf8'));
        if (parsed?.id) return { id: parsed.id, name: parsed.name ?? null, boundAt: dir };
        break;                         // a binding without an id is not a licence to guess
      } catch (err) {
        if (err.code !== 'ENOENT') break;         // unreadable is also not a licence to guess
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/**
 * Which project a command should work, and where that answer came from.
 *
 * A repository is the unit of work, and the project is a property of it: an agent
 * fixing bugs in one checkout must not depend on whichever project someone last
 * selected on this machine. That failure is not hypothetical — switching projects
 * in one repository and then pulling in another fetched the wrong project's bug
 * over the same path (RGM4-003), which is why `pull` started binding its output
 * directory. The binding is now the first answer for every command, found by
 * walking up from where the command runs; the environment and then the global
 * config remain for a machine that only ever works one project.
 */
export async function resolveProject({ cwd = process.cwd(), config = {}, env = process.env, explicit } = {}) {
  // An explicit choice wins, because a name given at the call is the one piece of
  // evidence that is not an inference: one repository can hold several projects
  // (a feature each), and then the directory alone cannot decide.
  if (explicit) return { id: explicit.id, name: explicit.name ?? null, source: 'argument' };
  // `cwd` may be a single directory or an ordered list — the MCP server passes the
  // session's repository first and its own process directory second, because it
  // may be launched from anywhere. (One level of nesting is flattened, so a
  // caller may pass `[rootsDir, ...more]` without spreading.)
  const bound = await findRepoBinding([].concat(cwd).flat(Infinity));
  if (bound) return bound;
  if (env.RGM_PROJECT_ID) return { id: env.RGM_PROJECT_ID, name: null, source: 'env' };
  if (config.projectId) return { id: config.projectId, name: config.projectName ?? null, source: 'config' };
  return null;
}

/** Bind this directory to a project, replacing a previous binding. */
export async function writeBinding(rootDir, project) {
  const path = join(rootDir, BINDING_FILE);
  let previous = null;
  try { previous = JSON.parse(await readFile(path, 'utf8')); } catch { previous = null; }

  await mkdir(rootDir, { recursive: true });
  await writeFile(path, `${JSON.stringify(
    { id: project.id, name: project.name ?? null, boundAt: new Date().toISOString() }, null, 2)}\n`);
  return previous;
}

/** The repository root, so a binding lands at the top of the checkout. */
export function repoRoot(startDir = process.cwd()) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'],
      { cwd: startDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || startDir;
  } catch {
    return startDir;   // not a repository: the directory itself is the unit
  }
}

/**
 * Make sure a pulled packet cannot be committed by accident (IR-035).
 *
 * Packets contain client bug reports and screenshots. A `<root>/.gitignore`
 * ignoring everything keeps `git add .` from staging them, without touching the
 * repository's own ignore file.
 */
export async function ensureIgnored(rootDir) {
  // A symlinked output root would carry the ignore file — and the packet with it —
  // outside the tree the user believes they are using (RGM4-002).
  await assertNotSymlink(rootDir, 'the output root');

  const ignorePath = join(rootDir, '.gitignore');
  try {
    await lstat(ignorePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    await mkdir(rootDir, { recursive: true });
    await writeFile(ignorePath, '# pulled packets are local working data\n*\n');
  }
}

/**
 * Bind an output directory to the project its packets come from.
 *
 * `rgm use <project>` writes its selection to the global `~/.rgm/config.json`, so it
 * applies to every repository on the machine. Switching projects while working in one
 * repository and then running `pull 1` in another fetched the *new* project's BUG-1 and
 * wrote it over `.rgm/BUG-1` — two clients' reports sharing one path. Checking the
 * packet against the global setting cannot catch that, because both sides agree; the
 * repository has to remember which project it belongs to (RGM4-003).
 *
 * The first pull in a directory establishes the binding, and later pulls must agree
 * with it. `--out` gives each project its own root when one repository genuinely needs
 * to pull from two.
 */
export async function bindProject(rootDir, project) {
  const path = join(rootDir, BINDING_FILE);
  let existing = null;
  try {
    existing = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;              // an unreadable binding is not a licence to guess
  }

  if (existing?.id && existing.id !== project.id) {
    throw new Error(
      `${rootDir} is bound to project '${existing.name ?? existing.id}' (${existing.id}), but this `
      + `CLI is set to ${project.id}. Packets from two projects would share one path — run `
      + `'rgm use <name>' for this repository's project, or pull into a separate --out directory.`);
  }

  if (!existing) {
    await mkdir(rootDir, { recursive: true });
    await writeFile(path, `${JSON.stringify({ id: project.id, name: project.name ?? null }, null, 2)}\n`);
    return { id: project.id, name: project.name ?? null };
  }
  return existing;
}

/**
 * Refuse a packet that belongs to a different project than the CLI is set to.
 *
 * Project selection is global and the output path is derived from the bug number,
 * so `rgm pull 1` in project A's repository could extract project B's BUG-1 over
 * the same directory — silently mixing two clients' reports (IR-009).
 *
 * `meta.json` is written by the server, so it is the packet's own statement of
 * where it came from. A packet that cannot be identified is refused rather than
 * written: an unattributable report in a repository is worse than no report.
 */
export function assertPacketBelongsToProject(zipBuffer, projectId) {
  const entry = readZip(zipBuffer).find((e) => e.name === 'meta.json');
  if (!entry) {
    throw new Error('refusing to extract: the packet has no meta.json to identify it');
  }

  let meta;
  try {
    meta = JSON.parse(Buffer.from(entry.data).toString('utf8'));
  } catch {
    throw new Error('refusing to extract: the packet meta.json is not readable');
  }

  const found = meta?.project?.id;
  if (!found) {
    throw new Error('refusing to extract: the packet does not name its project');
  }
  if (projectId && found !== projectId) {
    throw new Error(
      `packet belongs to '${meta.project.name ?? found}' (${found}), but this CLI is set `
      + `to a different project — run 'rgm use <project>' first, or pull into a `
      + `separate --out directory`);
  }
  return meta;
}

export async function loadConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  } catch {
    return { url: null, token: null, projectId: null };
  }
}

/**
 * Persist the CLI configuration.
 *
 * The file holds a long-lived API token, so it is written 0600 inside a 0700
 * directory. It used to be created with the process umask, which on a typical
 * machine means world-readable (IR-008).
 */
export async function saveConfig(config) {
  const dir = join(CONFIG_PATH, '..');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  // If the file already existed, `mode` is ignored by the OS; set it explicitly.
  await chmod(CONFIG_PATH, 0o600).catch(() => {});
}

/** Read a token from stdin, so it never appears in `ps` output. */
async function readTokenFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function api(config) {
  const base = config.url.replace(/\/+$/, '');
  const call = async (method, path, { accept = 'application/json', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        accept,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      // `body: undefined` means GET-shaped: no payload at all. Before this, the
      // option was silently dropped and every CLI POST arrived empty — the server
      // rejected it for a missing field, which reads as "the API changed" when
      // what happened is that nothing was ever sent.
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!res.ok) {
      let message = res.statusText;
      try { message = (await res.json()).message ?? message; } catch { /* not json */ }
      // Include the status: a CLI user needs to tell "bad token" from "not found".
      throw new Error(`${method} ${path} failed: ${res.status} ${message}`);
    }
    return res;
  };
  return { call, base };
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[a.slice(2)] = next;
        i++;
      } else {
        args[a.slice(2)] = true;
      }
    }
    else args._.push(a);
  }
  return args;
}

async function ownerAdminDelete(input) {
  if (process.env.RGM_ADMIN_ONESHOT !== 'true') {
    throw new Error(
      'permanent deletion only runs in the one-shot admin container; use docker compose run --rm admin ...');
  }
  const config = loadEnvironmentConfig(process.env);
  if (!config.databaseUrl) throw new Error('the one-shot admin container needs DATABASE_URL');
  const db = await createDb({ url: config.databaseUrl, dataDir: config.dataDir });
  try {
    return await purgeProject({ ...input, db, storage: config.storage });
  } finally {
    await db.close();
  }
}

export async function run(argv = process.argv.slice(2), { adminDelete = ownerAdminDelete } = {}) {
  const args = parseArgs(argv);
  const command = args._[0];

  if (command === 'admin' && args._[1] === 'delete-project') {
    const target = args._[2];
    if (!target) throw new Error('delete-project needs a project id');
    const actorEmail = args['actor-email'];
    if (typeof actorEmail !== 'string' || !actorEmail.trim()) {
      throw new Error('delete-project needs --actor-email <site-admin-email>');
    }
    const reason = args.reason;
    if (typeof reason !== 'string') {
      throw new Error('delete-project needs --reason "..." (at least 12 characters)');
    }
    if (reason.trim().length < 12) {
      throw new Error('--reason must be at least 12 characters — purging is irreversible');
    }
    const out = await adminDelete({
      actorEmail, projectId: target, reason,
      force: args.force === true || args.force === 'true'
    });
    return `purged ${out.name ?? target}\n  reason: ${out.reason ?? reason}`;
  }

  const config = await loadConfig();

  if (command === 'login') {
    // The token is a long-lived credential. `--token` puts it in the process list
    // for anyone who runs `ps`, so prefer stdin or the environment and say so.
    let token = args['token-stdin'] ? await readTokenFromStdin() : null;
    if (!token && process.env.RGM_TOKEN) token = process.env.RGM_TOKEN.trim();
    if (!token && args.token) {
      token = String(args.token);
      process.stderr.write(
        'warning: --token is visible to other users in the process list; '
        + 'prefer RGM_TOKEN=… rgm login --url …\n');
    }
    if (!args.url || !token) {
      throw new Error('login needs --url and a token (RGM_TOKEN, --token-stdin, or --token)');
    }
    await saveConfig({ ...config, url: args.url, token });
    return `saved credentials for ${args.url}`;
  }

  if (!config.url || !config.token) throw new Error('not signed in — run: rgm login --url ... --token ...');
  const { call } = api(config);

  /** A project by id or name, as the app knows it. */
  const findProject = async (wanted) => {
    const { projects } = await (await call('GET', '/api/projects')).json();
    const match = projects.find((p) => p.id === wanted || p.name === wanted);
    if (!match) {
      throw new Error(`no project matching ${wanted} — you can see: `
        + projects.map((p) => `${p.name} (${p.id})`).join(', '));
    }
    return match;
  };

  if (command === 'projects') {
    const res = await call('GET', '/api/projects');
    const { projects } = await res.json();
    return projects.map(p => `${p.id}  ${p.name} (${p.client}) — ${p.role}`).join('\n');
  }

  if (command === 'use') {
    const wanted = args._[1];
    if (!wanted) throw new Error('use needs a project id or name');
    const match = await findProject(wanted);
    await saveConfig({ ...config, projectId: match.id, projectName: match.name });

    // The repository remembers it too, so what an agent works is a property of the
    // checkout rather than of the last person to run this command anywhere on the
    // machine (resolveProject). `--global` says you meant the machine, not the repo.
    if (args.global) return `using ${match.name}`;

    const root = repoRoot(process.cwd());
    const previous = await writeBinding(join(root, '.rgm'), { id: match.id, name: match.name });
    const replaced = previous?.id && previous.id !== match.id
      ? ` (was ${previous.name ?? previous.id})` : '';
    return `using ${match.name}\n  bound ${root}/.rgm/${BINDING_FILE}${replaced}`;
  }


  // Which project this command works: one named at the call, else the repository it
  // runs in, else the environment, else the machine-wide selection (see
  // resolveProject — one repository can hold several projects, a feature each).
  const explicit = args.project ? await findProject(args.project) : null;
  const project = await resolveProject({ config, env: process.env, explicit });
  if (!project) {
    throw new Error('no project selected — run: rgm use <project>, or pull once to bind this directory');
  }
  const projectId = project.id;

  if (command === 'project') {
    const where = project.source === 'argument' ? `--project (${explicit.name})`
      : project.boundAt ? `${project.boundAt}/.rgm/${BINDING_FILE}`
        : project.source === 'env' ? 'RGM_PROJECT_ID' : '~/.rgm/config.json';
    return `${project.name ?? project.id}  (${project.id})\n  from ${where}`;
  }

  if (command === 'bugs') {
    const res = await call('GET', `/api/projects/${projectId}/bugs`);
    const { bugs, openCount } = await res.json();
    return [`open: ${openCount}`, ...bugs.map(b =>
      `${b.code}  ${b.status.padEnd(7)} ${b.severity.padEnd(6)} ${b.title_vi}`)].join('\n');
  }

  if (command === 'prompt' || command === 'pull') {
    const number = Number(args._[1]);
    if (!Number.isInteger(number)) throw new Error(`${command} needs a bug number`);

    const found = await call('GET', `/api/projects/${projectId}/bugs/by-number/${number}`);
    const { id, code } = await found.json();

    if (command === 'prompt') {
      const res = await call('GET', `/api/bugs/${id}/prompt`, { accept: 'text/markdown' });
      return await res.text();
    }

    const res = await call('GET', `/api/bugs/${id}/packet`, { accept: 'application/zip' });
    const zip = Buffer.from(await res.arrayBuffer());

    // Before anything is written: the packet must be from the project this
    // directory works (IR-009).
    assertPacketBelongsToProject(zip, projectId);

    const root = args.out ?? '.rgm';
    const outDir = join(root, code);
    await ensureIgnored(root);
    // The repository's own project, before anything is written, so a later pull
    // here cannot be redirected by a project selected elsewhere (RGM4-003).
    await bindProject(root, { id: projectId, name: project.name });
    const written = await extractPacket(zip, outDir);
    return `${code} -> ${outDir}\n  ${written.join('\n  ')}`;
  }

  /**
   * The agent's way back, from a shell: ask, read the answers, say what was
   * done, and hand the bug to the filer for verification.
   */
  const bugRef = async (position) => {
    const number = Number(args._[position]);
    if (!Number.isInteger(number)) throw new Error(`${command} needs a bug number`);
    const found = await call('GET', `/api/projects/${projectId}/bugs/by-number/${number}`);
    return found.json();
  };

  if (command === 'ask') {
    const question = args._.slice(2).join(' ').trim();
    if (!question) throw new Error('ask needs a question, e.g. rgm ask 7 "which warehouse?"');
    const { id, code } = await bugRef(1);
    // The payload goes under `body:` — the option, whose value becomes the JSON
    // envelope. The questions route reads the envelope's `body` field, hence the
    // nesting; both layers used to be absent (the option was dropped entirely).
    const res = await call('POST', `/api/bugs/${id}/questions`, { body: { body: question } });
    const out = await res.json();
    return `asked on ${code} (notified ${out.notified?.queued ?? 0} address(es))`;
  }

  if (command === 'questions') {
    const { id, code } = await bugRef(1);
    const res = await call('GET', `/api/bugs/${id}/questions`);
    const { open, questions } = await res.json();
    if (!questions.length) return `${code}: no questions`;
    return [`${code}: ${open} open`, ...questions.map((q) => q.open
      ? `  [open]     ${q.body}`
      : `  [answered] ${q.body}\n             -> ${q.answer.by}: ${q.answer.text}`)].join('\n');
  }

  if (command === 'comment') {
    const note = args._.slice(2).join(' ').trim();
    if (!note) throw new Error('comment needs a note, e.g. rgm comment 7 "fixed in commit abc123"');
    const { id, code } = await bugRef(1);
    await call('POST', `/api/bugs/${id}/comments`, { body: { note } });
    return `commented on ${code}`;
  }

  if (command === 'fixed') {
    const { id, code } = await bugRef(1);
    // Required, not suggested: a "fixed" with no evidence is a claim the tester
    // has to redo from scratch, and the report a self-test would have caught comes
    // straight back.
    const verifiedBy = String(args['verified-by'] ?? '').trim();
    if (!verifiedBy) {
      throw new Error('fixed needs --verified-by: what proves this is fixed — a test file and '
        + 'case name, an exact command, or how you reproduced the symptom and showed it gone');
    }
    const note = args.note ? String(args.note) : null;
    const before = await (await call('GET', `/api/bugs/${id}`)).json();
    if (before.status === 'retest') return `${code} is already awaiting verification`;
    if (before.status === 'closed') throw new Error(`${code} is closed — reopen it first`);
    await call('POST', `/api/bugs/${id}/comments`, {
      body: { note: [note, `Verified by: ${verifiedBy}`].filter(Boolean).join('\n\n') }
    });
    if (before.status === 'new') {
      await call('POST', `/api/bugs/${id}/status`, { body: { action: 'start_fixing' } });
    }
    await call('POST', `/api/bugs/${id}/status`, { body: { action: 'request_retest' } });
    return `${code} is now awaiting verification by the filer\n  what proves it: ${verifiedBy}`;
  }

  throw new Error(`unknown command '${command ?? ''}'`);
}

// Only run as a CLI when invoked directly, so tests can import the pieces.
// Resolve symlinks before comparing: npm link and ~/.local/bin/rgm launch this
// file through a symlink, and argv[1] then names the link, not the module —
// the old strict comparison silently exited 0 doing nothing, the worst kind
// of failure for an install path that is otherwise perfectly configured.
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])
  .catch(() => process.argv[1])).href) {
  try {
    const output = await run();
    if (output) process.stdout.write(output + '\n');
  } catch (err) {
    process.stderr.write(`rgm: ${err.message}\n`);
    process.exit(1);
  }
}
