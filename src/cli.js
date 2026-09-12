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
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
    const path = packetPathFor(targetDir, entry.name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, entry.data);
    written.push(entry.name);
  }
  return written;
}

export async function loadConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  } catch {
    return { url: null, token: null, projectId: null };
  }
}

export async function saveConfig(config) {
  await mkdir(join(CONFIG_PATH, '..'), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
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
    if (!args.url || !args.token) throw new Error('login needs --url and --token');
    await saveConfig({ ...config, url: args.url, token: args.token });
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
    const outDir = join(args.out ?? '.rgm', code);
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
