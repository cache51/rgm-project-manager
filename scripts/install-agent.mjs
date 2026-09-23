#!/usr/bin/env node
/**
 * Wire this repository into a coding agent, from a fresh machine.
 *
 *   node scripts/install-agent.mjs --harness opencode
 *   node scripts/install-agent.mjs --harness codex
 *   node scripts/install-agent.mjs --harness opencode --check
 *
 * Runs the same on macOS, Linux and Windows: every path is built from the user's
 * home, and the skill is linked as a junction on Windows, where a directory
 * symlink would need administrator rights.
 *
 * Everything here has been done by hand too many times, and every step has a way
 * of looking finished when it is not:
 *
 *   - the MCP server imports ../src/cli.js, so copying mcp/rgm-mcp.mjs alone
 *     produces a server that cannot start;
 *   - a config file written with a relative path works only while the shell is
 *     somewhere convenient;
 *   - a skill installed for a harness that already gets it from a plugin is
 *     listed twice, which Codex answers by trimming every description to fit;
 *   - and none of it says anything until credentials exist, at which point the
 *     agent looks broken rather than unconfigured.
 *
 * So this writes absolute paths, merges rather than replaces, refuses to touch a
 * config it cannot parse, and ends by telling the operator exactly what is left.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, readFile, symlink, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const MCP = join(REPO, 'mcp', 'rgm-mcp.mjs');
const SKILL = join(REPO, 'skills', 'bug-intake');
const REMOTE = 'https://github.com/cache51/rgm-project-manager.git';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? true);
};
const harness = String(flag('harness', '')).toLowerCase();
const check = args.includes('--check');
const url = String(flag('url', 'http://192.168.168.92:3000'));
const home = process.env.RGM_INSTALL_HOME ?? homedir();   // a test can point this elsewhere

if (!['opencode', 'codex'].includes(harness)) {
  console.error('which agent? pass --harness opencode or --harness codex\n'
    + '(Claude Code installs this repository as a plugin: '
    + 'claude plugin marketplace add cache51/rgm-project-manager, then '
    + 'claude plugin install rgm@rgm — it needs nothing from this script.)');
  process.exit(2);
}

const say = (line = '') => process.stdout.write(`${line}\n`);

/**
 * Run another program.
 *
 * On Windows the agent CLIs are `.cmd` shims, and Node refuses to spawn those
 * directly (it stopped implying a shell, and the old behaviour now raises EINVAL),
 * so those go through cmd.exe — which is also what resolves them from PATH. `git`
 * and `node` are real executables and are spawned as such everywhere.
 */
function run(cmd, argv, opts = {}) {
  const base = { encoding: 'utf8', ...opts };
  return process.platform === 'win32' && !['git', 'node'].includes(cmd)
    ? spawnSync('cmd.exe', ['/c', cmd, ...argv], base)
    : spawnSync(cmd, argv, base);
}
const sh = (cmd, argv) => run(cmd, argv);

/** The checkout this script belongs to, cloned if it is not one. */
async function ensureCheckout() {
  if (existsSync(MCP)) return REPO;
  const dest = join(home, '.rgm-checkout');
  if (existsSync(join(dest, 'mcp', 'rgm-mcp.mjs'))) return dest;
  say(`this script is not inside a checkout — cloning into ${dest}`);
  const clone = sh('git', ['clone', '--depth', '1', REMOTE, dest]);
  if (clone.status !== 0) {
    console.error(`git clone failed:\n${clone.stderr ?? ''}`);
    process.exit(1);
  }
  return dest;
}

/**
 * Merge `mcp.rgm` into an OpenCode config, or say why it will not.
 *
 * OpenCode's config is JSONC and it hard-fails on a bad field, so a file that
 * cannot be parsed is left exactly as it is: printing the block to paste costs
 * the operator ten seconds, and silently rewriting someone's config costs them an
 * afternoon.
 */
async function installOpencode(repo) {
  const dir = join(home, '.config', 'opencode');
  const file = join(dir, 'opencode.jsonc');
  const block = {
    type: 'local',
    command: ['node', join(repo, 'mcp', 'rgm-mcp.mjs')],
    enabled: true
  };

  let config = { $schema: 'https://opencode.ai/config.json' };
  let existed = false;
  if (existsSync(file)) {
    existed = true;
    const raw = await readFile(file, 'utf8');
    try {
      // Comments and trailing commas are valid JSONC and invalid JSON; neither is
      // worth a parser dependency here, so both are stripped before parsing.
      config = JSON.parse(raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
        .replace(/,(\s*[}\]])/g, '$1'));
    } catch (err) {
      console.error(`${file} could not be parsed (${err.message}).\n`
        + 'Leaving it untouched. Add this by hand:\n\n'
        + `${JSON.stringify({ mcp: { rgm: block } }, null, 2)}\n`);
      return false;
    }
  }

  config.mcp = { ...(config.mcp ?? {}), rgm: block };
  await mkdir(dir, { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  say(`${existed ? 'merged into' : 'wrote'} ${file}`);
  return true;
}

async function installCodex(repo) {
  const already = sh('codex', ['mcp', 'get', 'rgm']);
  if (already.status === 0) {
    say('codex already has an `rgm` server — leaving it (undo: codex mcp remove rgm)');
    return true;
  }
  const add = sh('codex', ['mcp', 'add', 'rgm', '--', 'node', join(repo, 'mcp', 'rgm-mcp.mjs')]);
  if (add.status !== 0) {
    console.error(`codex mcp add failed:\n${add.stderr ?? add.stdout ?? ''}`);
    return false;
  }
  say('registered `rgm` with codex (global)');
  return true;
}

/**
 * The skill, in the directory Codex and OpenCode both read.
 *
 * A symlink, not a copy: the loop is still being written, and a copy silently
 * becomes the version from the day it was installed.
 */
async function installSkill(repo) {
  const dir = join(home, '.agents', 'skills');
  const link = join(dir, 'bug-intake');
  await mkdir(dir, { recursive: true });
  await rm(link, { recursive: true, force: true });
  const target = join(repo, 'skills', 'bug-intake');
  // A junction on Windows: a directory symlink there needs administrator rights or
  // developer mode, and neither harness cares how the directory is linked. An
  // install that fails because of a policy setting is worse than one that links.
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  say(`linked ${link} → ${target}`);
}

/**
 * Ask the harness itself whether it can see what was just installed.
 *
 * Two things this got wrong first: OpenCode writes ANSI colour codes *between*
 * the words ("rgm \e[90mconnected"), so a plain match for "rgm connected" says no
 * while the server is up; and its skill dump is cut off at ~16 KB when stdout is a
 * pipe, so searching the piped text for a skill reports missing for a skill that
 * is installed. Hence: strip colour, and let the skill dump land in a real file.
 */
const plain = (text) => String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '');

function dumpToFile(cmd, argv) {
  const file = join(tmpdir(), `rgm-verify-${process.pid}.txt`);
  const fd = openSync(file, 'w');
  try {
    run(cmd, argv, { stdio: ['ignore', fd, 'ignore'] });
  } finally {
    closeSync(fd);
  }
  const text = readFileSync(file, 'utf8');
  rmSync(file, { force: true });
  return text;
}

function verify(harness) {
  say('\nverifying');
  if (harness === 'opencode') {
    const mcp = plain(sh('opencode', ['mcp', 'list']).stdout);
    say(`  opencode mcp list:    ${/rgm\s+connected/i.test(mcp) ? 'rgm connected' : 'rgm NOT connected'}`);
    const skills = dumpToFile('opencode', ['debug', 'skill']);
    say(`  opencode debug skill: ${skills.includes('bug-intake') ? 'bug-intake found' : 'bug-intake MISSING'}`);
  } else {
    const mcp = sh('codex', ['mcp', 'get', 'rgm']);
    say(`  codex mcp get rgm:    ${mcp.status === 0 ? 'registered' : 'NOT registered'}`);
    const prompt = dumpToFile('codex', ['debug', 'prompt-input']);
    say(`  codex skills:         ${prompt.includes('bug-intake') ? 'bug-intake visible' : 'bug-intake MISSING'}`);
  }
}

const repo = await ensureCheckout();
if (check) {
  verify(harness);
  process.exit(0);
}

const ok = harness === 'opencode' ? await installOpencode(repo) : await installCodex(repo);
// The skill does not depend on the MCP registration, so it is installed either way:
// a config left for the operator to paste by hand should not also cost them the loop.
await installSkill(repo);
if (!ok) say('\nthe MCP registration above needs a hand — the rest is done.');

say(`
next, once — credentials are shared by the MCP server and the CLI:
  node ${join(repo, 'src', 'cli.js')} login --url ${url} --token <api-token>
  node ${join(repo, 'src', 'cli.js')} use "<project>"     # the board this agent works

the token is minted by an admin in the app (POST /api/tokens, scopes
bug:read + bug:write), and the agent only sees projects the account is a member of.`);

verify(harness);