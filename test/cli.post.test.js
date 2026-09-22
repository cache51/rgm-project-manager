/**
 * The CLI's POST commands carry their payload (the bug report from the field).
 *
 * A `--project`-style report came in: `rgm ask` reached the server with no body
 * and was rejected for a missing field — "the CLI sends a field the server
 * rejects", read as an API mismatch when nothing had ever been sent at all.
 * `api().call` destructured `{ accept }` from its options and dropped `body`,
 * so ask, comment and both of fixed's status actions posted `{}` silently.
 * These tests speak to a recording stand-in so no command can regress into
 * shouting at the app with an empty envelope again.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'rgm-cli-post-'));
process.env.RGM_CONFIG = join(home, '.rgm', 'config.json');

const { saveConfig, run } = await import('../src/cli.js');
after(async () => { await rm(home, { recursive: true, force: true }); });

/** Stand in for the app: record every request, answer like the real routes. */
function recorder(bug = {}) {
  const seen = [];
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const body = opts.body === undefined ? undefined : JSON.parse(opts.body);
    seen.push({ method: opts.method ?? 'GET', path, body,
      contentType: opts.headers?.['content-type'] ?? null });

    const json = (obj) => ({ ok: true, status: 200, statusText: 'OK',
      json: async () => obj, text: async () => JSON.stringify(obj) });
    if (path.endsWith('/by-number/7')) return json({ id: 'bug-7', code: 'BUG-7' });
    if (path === '/api/bugs/bug-7') {
      return json({ status: bug.status ?? 'fixing', ...bug });
    }
    if (path.endsWith('/questions') && opts.method === 'POST') {
      return json({ id: 'q1', notified: { queued: 1 } });
    }
    if (path.endsWith('/questions')) return json({ open: 0, questions: [] });
    if (path.endsWith('/comments') && opts.method === 'POST') return json({ id: 42 });
    return json({ ok: true });
  };
  return {
    seen,
    restore() { globalThis.fetch = fetchBefore; }
  };
}

test('before anything else: the CLI is signed in with a project', async () => {
  await saveConfig({ url: 'http://127.0.0.1:9', token: 'post-test',
    projectId: 'p-one', projectName: 'Project One' });
  assert.ok(true);
});

test('rgm ask delivers the question where the server reads it', async () => {
  const r = recorder();
  try {
    const out = await run(['ask', '7', 'which warehouse is this lot in?']);
    const post = r.seen.find((s) => s.method === 'POST' && s.path.endsWith('/questions'));

    assert.ok(post, 'a question POST was made');
    assert.deepEqual(post.body, { body: 'which warehouse is this lot in?' },
      'the server reads `body` — an empty or misnamed payload is a 400 the user blames on the API');
    assert.equal(post.contentType, 'application/json',
      'without a content-type the server never parses the body at all');
    assert.match(out, /asked on BUG-7/);
  } finally { r.restore(); }
});

test('rgm comment delivers the note, and says which comment it made', async () => {
  const r = recorder();
  try {
    const out = await run(['comment', '7', 'fixed in abc1234']);
    const post = r.seen.find((s) => s.path.endsWith('/comments'));

    assert.deepEqual(post.body, { note: 'fixed in abc1234' });
    assert.equal(post.contentType, 'application/json');
    // The id is the only handle `uncomment` can be given, so it has to come back.
    assert.match(out, /\(comment 42\)/);
  } finally { r.restore(); }
});

test('rgm uncomment takes that comment back', async () => {
  const r = recorder();
  try {
    const out = await run(['uncomment', '7', '42']);
    const del = r.seen.find((s) => s.method === 'DELETE');

    assert.ok(del, 'the removal is a request; a local note to itself removes nothing');
    assert.equal(del.path, '/api/bugs/bug-7/comments/42');
    assert.match(out, /removed comment 42 from BUG-7/);
  } finally { r.restore(); }
});

test('rgm uncomment without an id refuses, and sends nothing', async () => {
  const r = recorder();
  try {
    await assert.rejects(() => run(['uncomment', '7']), /needs the comment id/);
    await assert.rejects(() => run(['uncomment', '7', 'not-a-number']),
      /needs the comment id/);
    assert.deepEqual(r.seen.filter((s) => s.method === 'DELETE'), [],
      'a malformed id must not become a request that removes the wrong thing');
  } finally { r.restore(); }
});

test('rgm fixed carries the action to both status transitions', async () => {
  const r = recorder({ status: 'new' });
  try {
    await run(['fixed', '7', '--verified-by', 'test/packing.test.js: counts the last carton']);
    const posts = r.seen.filter((s) => s.method === 'POST' && s.path.endsWith('/status'));

    assert.deepEqual(posts.map((p) => p.body),
      [{ action: 'start_fixing' }, { action: 'request_retest' }],
      'an action-less status POST is rejected — the handoff to the tester silently never happens');
    const comment = r.seen.find((s) => s.path.endsWith('/comments'));
    assert.match(comment.body.note, /Verified by: test\/packing\.test\.js/);
  } finally { r.restore(); }
});

test('GET-shaped calls still send no body and no content-type', async () => {
  const r = recorder();
  try {
    await run(['questions', '7']);
    const get = r.seen.find((s) => s.method === 'GET' && s.path.endsWith('/questions'));

    assert.equal(get.body, undefined);
    assert.equal(get.contentType, null, 'JSON content-type on a GET invites the server to await a body that is not there');
  } finally { r.restore(); }
});

test('the CLI runs when launched through a symlink, the way npm link installs it', async () => {
  // The direct-invocation guard compares import.meta.url to argv[1]. A symlinked
  // launcher (npm link, ~/.local/bin/rgm) names the link, and the old strict
  // string match exited 0 silently — perfectly configured, visibly dead.
  // No server here on purpose: an unsignable config must still produce a real
  // complaint ("not signed in"), which is what proves the command ran at all.
  const { symlink } = await import('node:fs/promises');
  const { spawn: spawnChild } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const dir = await mkdtemp(join(tmpdir(), 'rgm-cli-symlink-'));
  const link = join(dir, 'rgm');
  await symlink(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js'), link);

  const out = await new Promise((resolve, reject) => {
    const child = spawnChild(process.execPath, [link, 'projects'], {
      env: { ...process.env, RGM_CONFIG: join(dir, 'no-such-config.json') },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

  assert.ok(out.stdout || out.stderr,
    'a symlinked CLI that prints nothing and exits 0 is invisible death: every npm-link user has it');
  assert.match(out.stdout + out.stderr, /not signed in|Fabric Warehouse|http/,
    'the command ran and said something about the world it expected');
  await rm(dir, { recursive: true, force: true });
});
