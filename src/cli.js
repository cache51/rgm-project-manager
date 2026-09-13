#!/usr/bin/env node
/**
 * rgm — the developer-facing CLI (§10).
 *
 *   rgm login --url http://localhost:3000 --token <api-token>
 *   rgm projects
 *   rgm use <project-id-or-name>
 *   rgm bugs
 *   rgm prompt 142            # print the agent handoff prompt to stdout
 *   rgm pull 142              # fetch the packet and extract it under .rgm/BUG-142
 *
 * `pull` is the primary handoff path: it lands bug.md, meta.json and the
 * screenshots on disk, ready to hand to a coding agent.
 */
import { readFile, writeFile, mkdir, lstat, rm, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readZip } from './unzip.js';
import { assertSafeRelativePath, packetPathFor } from './packet.js';

export const CONFIG_PATH = process.env.RGM_CONFIG ?? join(homedir(), '.rgm', 'config.json');

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
 * Make sure a pulled packet cannot be committed by accident (IR-035).
 *
 * Packets contain client bug reports and screenshots. A `<root>/.gitignore`
 * ignoring everything keeps `git add .` from staging them, without touching the
 * repository's own ignore file.
 */
export async function ensureIgnored(rootDir) {
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
  const call = async (method, path, { accept = 'application/json' } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${config.token}`, accept }
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
    if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
    else args._.push(a);
  }
  return args;
}

export async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0];
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

  if (command === 'projects') {
    const res = await call('GET', '/api/projects');
    const { projects } = await res.json();
    return projects.map(p => `${p.id}  ${p.name} (${p.client}) — ${p.role}`).join('\n');
  }

  if (command === 'use') {
    const wanted = args._[1];
    if (!wanted) throw new Error('use needs a project id or name');
    const res = await call('GET', '/api/projects');
    const { projects } = await res.json();
    const match = projects.find(p => p.id === wanted || p.name === wanted);
    if (!match) throw new Error(`no project matching ${wanted}`);
    await saveConfig({ ...config, projectId: match.id });
    return `using ${match.name}`;
  }

  if (!config.projectId) throw new Error('no project selected — run: rgm use <project>');

  if (command === 'bugs') {
    const res = await call('GET', `/api/projects/${config.projectId}/bugs`);
    const { bugs, openCount } = await res.json();
    return [`open: ${openCount}`, ...bugs.map(b =>
      `${b.code}  ${b.status.padEnd(7)} ${b.severity.padEnd(6)} ${b.title_vi}`)].join('\n');
  }

  if (command === 'prompt' || command === 'pull') {
    const number = Number(args._[1]);
    if (!Number.isInteger(number)) throw new Error(`${command} needs a bug number`);

    const found = await call('GET', `/api/projects/${config.projectId}/bugs/by-number/${number}`);
    const { id, code } = await found.json();

    if (command === 'prompt') {
      const res = await call('GET', `/api/bugs/${id}/prompt`, { accept: 'text/markdown' });
      return await res.text();
    }

    const res = await call('GET', `/api/bugs/${id}/packet`, { accept: 'application/zip' });
    const zip = Buffer.from(await res.arrayBuffer());

    // Before anything is written: the packet must be from the project this CLI is
    // set to (IR-009).
    assertPacketBelongsToProject(zip, config.projectId);

    const root = args.out ?? '.rgm';
    const outDir = join(root, code);
    await ensureIgnored(root);
    const written = await extractPacket(zip, outDir);
    return `${code} -> ${outDir}\n  ${written.join('\n  ')}`;
  }

  throw new Error(`unknown command '${command ?? ''}'`);
}

// Only run as a CLI when invoked directly, so tests can import the pieces.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const output = await run();
    if (output) process.stdout.write(output + '\n');
  } catch (err) {
    process.stderr.write(`rgm: ${err.message}\n`);
    process.exit(1);
  }
}
