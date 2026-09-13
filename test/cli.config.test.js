/**
 * The CLI's credential file (IR-008).
 *
 * `CONFIG_PATH` is resolved once at import time, so this file sets `RGM_CONFIG`
 * before importing the CLI — which is why it is separate from the other CLI tests.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'rgm-cli-cfg-'));
process.env.RGM_CONFIG = join(home, '.rgm', 'config.json');

const { saveConfig, CONFIG_PATH, loadConfig } = await import('../src/cli.js');

after(async () => { await rm(home, { recursive: true, force: true }); });

const modeOf = async (path) => (await stat(path)).mode & 0o777;

test('the credential file is 0600 inside a 0700 directory', async () => {
  await saveConfig({ url: 'http://127.0.0.1:3000', token: 'a-long-lived-token' });

  assert.equal(await modeOf(CONFIG_PATH), 0o600,
    'a world-readable token is readable by every account on the machine');
  assert.equal(await modeOf(dirname(CONFIG_PATH)), 0o700);
});

test('re-saving repairs permissions that were widened', async () => {
  // `writeFile`'s `mode` is ignored when the file already exists, so it is the
  // explicit chmod in saveConfig that makes this hold.
  await chmod(CONFIG_PATH, 0o644);
  await saveConfig({ url: 'http://127.0.0.1:3000', token: 'another-token' });
  assert.equal(await modeOf(CONFIG_PATH), 0o600);
});

test('the token survives a round trip', async () => {
  await saveConfig({ url: 'http://127.0.0.1:3000', token: 'round-trip', projectId: null });
  const config = await loadConfig();
  assert.equal(config.token, 'round-trip');
  assert.equal(config.url, 'http://127.0.0.1:3000');
});

test('a missing config reads as "not signed in" rather than throwing', async () => {
  await rm(CONFIG_PATH, { force: true });
  assert.deepEqual(await loadConfig(), { url: null, token: null, projectId: null });
});

test('a corrupt config also reads as "not signed in"', async () => {
  // Deliberate: the CLI's answer to an unusable config is to tell you to sign in,
  // and every command that needs credentials says so. Asserted so the behaviour is
  // a decision rather than an accident.
  await writeFile(CONFIG_PATH, '{ not json');
  assert.deepEqual(await loadConfig(), { url: null, token: null, projectId: null });
});

test('the file really does contain the token, in plain text', async () => {
  // Documented rather than glossed over: this is a file-credential store, not a
  // keychain. The permissions are the control.
  await saveConfig({ url: 'http://x', token: 'visible-on-disk' });
  const raw = await readFile(CONFIG_PATH, 'utf8');
  assert.match(raw, /visible-on-disk/);
  assert.equal(await modeOf(CONFIG_PATH), 0o600);
});
