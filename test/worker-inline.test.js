/**
 * The queue drains locally, or it does not.
 *
 * The embedded database accepts one process, so `npm run worker` cannot share it. If
 * nothing else drains the queue, a tester's Vietnamese note is never translated — the
 * one thing the developers depend on — and the failure is completely silent. These
 * tests pin the wiring down, and then prove a translation actually comes out.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeProjectWorld, makeMilestone, fileBug } from './helpers.js';
import { startQueueLoop, shutdownApp } from '../src/server.js';
import { drainOnce } from '../src/worker-loop.js';
import { loadConfig } from '../src/config.js';

let w;

// The real provider and glossary, from the same config the server loads, so the test
// exercises the path that runs rather than a stub of it. The sender records instead of
// sending, so the test is quiet and can assert on what would have gone out.
const base = loadConfig({ PGLITE_DIR: '/tmp/rgm-inline-unused' });
const sent = [];
const sender = {
  name: 'recording',
  async send(msg) { sent.push(msg); return { messageId: `m-${sent.length}` }; }
};

const configFor = (inlineWorker) => ({
  inlineWorker,
  translationProvider: base.translationProvider,
  mailer: sender,
  glossary: base.glossary,
  publicUrl: base.publicUrl
});

const loopArgs = () => ({
  // A uuid, because `claimed_by` is a uuid column.
  provider: base.translationProvider, sender, workerId: randomUUID(),
  glossary: base.glossary, baseUrl: base.publicUrl
});

describe('queue: the server drains it when the embedded database cannot be shared', () => {
  // Inside the suite: a top-level `before` does not apply to a nested suite, which
  // silently left every test without a world.
  before(async () => { w = await makeProjectWorld(); });
  after(async () => { await w.close(); });

  test('the server claims the queue when the config says so', async () => {
    const loop = startQueueLoop({ db: w.db, config: configFor(true) });
    assert.ok(loop, 'with the embedded database the server must drain the queue');
    loop.stop();
    await loop.done;
  });

  test('it leaves the queue alone when a separate worker owns it', () => {
    // A real Postgres deployment runs its own worker; two drains would fight over the
    // same leases.
    assert.equal(startQueueLoop({ db: w.db, config: configFor(false) }), null);
  });

  test('a tester note really is translated by a drain pass', async () => {
    // A developer creates the milestone (testers may not); the tester files the bug.
    const milestoneId = await makeMilestone(w.devClient, w.project.id, 'M1');
    const bug = await fileBug(w.testerClient, w.project.id, {
      milestoneId, titleVi: 'Đường may bị lệch',
      bodyVi: 'Mép vải bên trái lệch 3mm so với đường chuẩn.'
    });

    const queued = await w.db.query(
      `SELECT field, status FROM bug_translations WHERE bug_id = $1 ORDER BY field`,
      [bug.id]);
    assert.ok(queued.rows.length > 0, 'filing a bug queues its translation');
    assert.ok(queued.rows.every((r) => r.status !== 'done'), 'and none of it is done yet');

    const results = await drainOnce(w.db, loopArgs());
    assert.ok(results.bugs.length > 0, 'the pass found the queued work');

    const done = await w.db.query(
      `SELECT field, lang, status, text FROM bug_translations
        WHERE bug_id = $1 AND status = 'done' ORDER BY field`, [bug.id]);
    assert.ok(done.rows.length > 0, 'and completed it');
    for (const row of done.rows) {
      assert.ok(row.text, `${row.field}/${row.lang} has translated text`);
    }
  });

  test('stopping the loop actually ends it', async () => {
    const loop = startQueueLoop({ db: w.db, config: configFor(true) });
    loop.stop();
    // Resolves rather than hanging: the loop checks between passes.
    await Promise.race([
      loop.done,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('the loop did not stop')), 5000))
    ]);
  });

  test('a pass with nothing to do is not an error', async () => {
    // The loop runs this every couple of seconds for the life of the process; an empty
    // queue must be a no-op, not a crash.
    const results = await drainOnce(w.db, loopArgs());
    assert.deepEqual([results.bugs.length, results.events.length, results.outbox.length],
      [0, 0, 0]);
  });

  test('shutting down flushes the database before exiting', async () => {
    // The embedded engine runs with fsync disabled, so exiting with buffered writes
    // loses them. A restart once discarded a project, its memberships, its milestone
    // and its sessions for exactly this reason. Order matters too: the queue stops
    // first, or it can write after the close.
    const order = [];
    let closed = false;
    const app = {
      db: { close: async () => { closed = true; order.push('db'); } },
      server: { close: (cb) => { order.push('server'); cb(); } }
    };
    const loop = { stop: () => order.push('stop'), done: Promise.resolve() };

    await shutdownApp(app, { loop, onExit: () => order.push('exit') });

    assert.ok(closed, 'the database is closed, which is what flushes it');
    assert.deepEqual(order, ['stop', 'db', 'server', 'exit'],
      'the queue stops first and the process exits last');
  });

  test('shutdown still flushes when the queue loop is broken', async () => {
    // A loop that already threw must not prevent the flush — that is the whole point.
    const order = [];
    const app = {
      db: { close: async () => order.push('db') },
      server: { close: (cb) => cb() }
    };
    const loop = { stop() {}, done: Promise.reject(new Error('loop died')) };

    await shutdownApp(app, { loop, onExit: () => order.push('exit') });
    assert.deepEqual(order, ['db', 'exit']);
  });
});
