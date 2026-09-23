/**
 * The installer, which is the step most likely to break quietly: it edits someone
 * else's config file and links a directory into their home. Nothing here needs
 * opencode or codex to be installed — the harness-facing checks are the last two
 * lines of its output and are deliberately not asserted on, so this file tests the
 * part that runs everywhere, including CI.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'scripts', 'install-agent.mjs');
const homes = [];
after(async () => { for (const h of homes) await rm(h, { recursive: true, force: true }); });

/** A throwaway HOME, so a test can never touch the machine it runs on. */
async function fakeHome() {
  const home = await mkdtemp(join(tmpdir(), 'rgm-install-'));
  homes.push(home);
  return home;
}

const install = (home, ...args) => spawnSync(process.execPath, [SCRIPT, ...args],
  { encoding: 'utf8', env: { ...process.env, HOME: home } });

const opencodeConfig = (home) => join(home, '.config', 'opencode', 'opencode.jsonc');

test('it refuses to guess which agent it is being installed for', () => {
  const res = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--harness opencode or --harness codex/);
  assert.match(res.stderr, /claude plugin install rgm@rgm/,
    'and says why Claude needs none of this');
});

test('a fresh machine gets a working-looking config with absolute paths', async () => {
  const home = await fakeHome();
  const res = install(home, '--harness', 'opencode');
  assert.equal(res.status, 0, res.stderr);

  const config = JSON.parse(await readFile(opencodeConfig(home), 'utf8'));
  assert.equal(config.mcp.rgm.type, 'local');
  assert.equal(config.mcp.rgm.enabled, true);
  assert.equal(config.$schema, 'https://opencode.ai/config.json',
    'the schema line is what makes an editor catch a mistake');
  const [cmd, script] = config.mcp.rgm.command;
  assert.equal(cmd, 'node');
  assert.ok(script.startsWith('/'), 'an absolute path: a relative one depends on cwd');
  assert.ok(existsSync(script), `the server it points at must exist (${script})`);
});

test('the skill lands where both harnesses look, as a link not a copy', async () => {
  const home = await fakeHome();
  install(home, '--harness', 'opencode');

  const link = join(home, '.agents', 'skills', 'bug-intake');
  assert.ok(lstatSync(link).isSymbolicLink(), 'a copy would freeze the loop at install day');
  assert.ok(existsSync(join(link, 'SKILL.md')));
});

test('an existing config is merged, not replaced', async () => {
  const home = await fakeHome();
  await mkdir(dirname(opencodeConfig(home)), { recursive: true });
  await writeFile(opencodeConfig(home), `{
  // my other server, and a comment OpenCode allows
  "mcp": { "other": { "type": "remote", "url": "https://example.com/mcp" } },
  "model": "opencode/big-pickle",
}
`);

  const res = install(home, '--harness', 'opencode');
  assert.equal(res.status, 0, res.stderr);

  const config = JSON.parse(await readFile(opencodeConfig(home), 'utf8'));
  assert.equal(config.mcp.other.url, 'https://example.com/mcp', 'the other server survives');
  assert.equal(config.model, 'opencode/big-pickle', 'and so does everything else');
  assert.equal(config.mcp.rgm.type, 'local', 'with rgm added beside it');
});

test('a config it cannot parse is left exactly as it was', async () => {
  const home = await fakeHome();
  await mkdir(dirname(opencodeConfig(home)), { recursive: true });
  const broken = '{\n  "mcp": { "half": \n}\n';
  await writeFile(opencodeConfig(home), broken);

  const res = install(home, '--harness', 'opencode');
  assert.match(res.stderr, /could not be parsed/);
  assert.match(res.stderr, /by hand/, 'and prints the block to paste instead');
  assert.equal(await readFile(opencodeConfig(home), 'utf8'), broken,
    'rewriting a config it did not understand is how an afternoon disappears');
  assert.ok(existsSync(join(home, '.agents', 'skills', 'bug-intake', 'SKILL.md')),
    'the skill is independent of the MCP registration, so it still lands');
});

test('running it twice does not accumulate junk', async () => {
  const home = await fakeHome();
  install(home, '--harness', 'opencode');
  const first = await readFile(opencodeConfig(home), 'utf8');
  const res = install(home, '--harness', 'opencode');

  assert.equal(res.status, 0);
  assert.equal(await readFile(opencodeConfig(home), 'utf8'), first, 'idempotent');
  assert.equal(Object.keys(JSON.parse(first).mcp).length, 1, 'one rgm, not two');
});