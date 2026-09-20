/**
 * The addresses carried on a bug, and the notice they get when the fix is ready.
 *
 * A developer attaches the people who should hear "this is fixed, please verify"
 * — usually the tester who reported it, who need not be a project member — and
 * the transition into retest mails exactly that list.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeProjectWorld, makeMilestone, fileBug } from './helpers.js';
import { runOutbox, RecordingSender } from '../src/notify.js';

describe('a bug carries the addresses that hear about the fix', () => {
  let w, ms;

  before(async () => {
    w = await makeProjectWorld();
    ms = await makeMilestone(w.adminClient, w.project.id, 'M-1', 'First');
    for (const action of ['start', 'ready']) {
      await w.adminClient.post(`/api/milestones/${ms}/status`, { action });
    }
    // Marking the milestone ready queues a notice for the project's testers. Drain
    // it here so every test below starts from an empty outbox: otherwise the first
    // test to drain would deliver the readiness mail (and only later tests would
    // see a clean queue, which is an assertion that depends on file position).
    await runOutbox(w.db, RecordingSender(), { workerId: randomUUID() });
  });
  after(async () => { await w.close(); });

  /** Only the notices this feature sends: the outbox is shared with milestones. */
  const retestMails = (sender) => sender.sent.filter((m) => m.kind === 'bug.retest');

  const add = (client, bugId, email) =>
    client.post(`/api/bugs/${bugId}/watchers`, { email });
  const detail = async (bugId) => (await w.devClient.get(`/api/bugs/${bugId}`)).json;

  test('a developer attaches an address, and it lands on the bug, normalized', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    const res = await add(w.devClient, bug.id, '  Krixi@Rgmdn.com  ');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.email, 'krixi@rgmdn.com');

    const d = await detail(bug.id);
    assert.deepEqual(d.watchers.map((x) => x.email), ['krixi@rgmdn.com']);
    assert.ok(d.watchers[0].addedAt, 'and timestamped');
    assert.ok(d.watchers[0].addedBy, 'and attributed');
  });

  test('the same address twice is one row', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    await add(w.devClient, bug.id, 'a@b.test');
    const again = await add(w.devClient, bug.id, 'A@B.test');
    assert.equal(again.json.added, false, 'the second add is a no-op');
    assert.equal((await detail(bug.id)).watchers.length, 1);
  });

  test('a malformed address is refused rather than queued', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    for (const bad of ['', 'nope', 'no@dot', 'two@@at.test', 'spaces in@a.test']) {
      const res = await add(w.devClient, bug.id, bad);
      assert.equal(res.status, 400, `${JSON.stringify(bad)} → ${res.status}`);
      assert.equal(res.json.error, 'bad_email');
    }
    assert.equal((await detail(bug.id)).watchers.length, 0);
  });

  test('only a developer or an admin may change the list', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    const byTester = await add(w.testerClient, bug.id, 'krixi@rgmdn.com');
    assert.equal(byTester.status, 403);
    assert.equal((await detail(bug.id)).watchers.length, 0);
  });

  test('an address can be taken off, and one that is not there is a 404', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    await add(w.devClient, bug.id, 'krixi@rgmdn.com');
    const gone = await w.devClient.del(`/api/bugs/${bug.id}/watchers/krixi%40rgmdn.com`);
    assert.equal(gone.status, 200, gone.text);
    assert.equal((await detail(bug.id)).watchers.length, 0);

    const again = await w.devClient.del(`/api/bugs/${bug.id}/watchers/krixi%40rgmdn.com`);
    assert.equal(again.status, 404);
  });

  test('the list is bounded', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    for (let i = 0; i < 10; i++) {
      assert.equal((await add(w.devClient, bug.id, `t${i}@rgmdn.com`)).status, 200);
    }
    const eleventh = await add(w.devClient, bug.id, 't10@rgmdn.com');
    assert.equal(eleventh.status, 409);
    assert.equal(eleventh.json.error, 'too_many_watchers');
    assert.equal((await detail(bug.id)).watchers.length, 10);
  });

  test('marking a bug fixed mails every address on it, and only those', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    await add(w.devClient, bug.id, 'krixi@rgmdn.com');
    await add(w.devClient, bug.id, 'tuongvi@rgmdn.com');
    await w.devClient.post(`/api/bugs/${bug.id}/status`, { action: 'start_fixing' });

    const moved = await w.devClient.post(`/api/bugs/${bug.id}/status`,
      { action: 'request_retest' });
    assert.equal(moved.json.status, 'retest');
    // One addressed mail, not one per address: two people are told in a single
    // notice, so no mailbox gets the same fix twice.
    assert.equal(moved.json.notified.recipients, 2, 'the audience is still two people');
    assert.equal(moved.json.notified.queued, 1, '...but exactly one mail is queued');

    const sender = RecordingSender();
    await runOutbox(w.db, sender, { workerId: randomUUID(), baseUrl: 'http://app.test' });
    const sent = retestMails(sender);
    assert.equal(sent.length, 1, 'one message, not two');
    assert.equal(sent[0].to, 'krixi@rgmdn.com', 'the first address is the addressee');

    const msg = sent[0];
    assert.deepEqual(msg.cc, ['tuongvi@rgmdn.com'],
      'the other address rides on Cc — together they get it, once each');
    assert.match(msg.subject, /đã sửa — chờ xác nhận/, 'the subject says why');
    // A tester watching several projects picks the mail up by its subject; a bare
    // BUG-7 says which bug and none about which project.
    assert.match(msg.subject, /Packing Line/, 'the subject names the project');
    assert.match(msg.body, new RegExp(bug.code), 'and the body names the bug');
    assert.match(msg.body, /http:\/\/app\.test/, 'with a way back into the app');
    assert.equal(msg.idempotencyKey, msg.dedupeKey, 'the key is the idempotency key');
  });

  test('a second fix cycle notifies again; the same cycle does not double-send', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    await add(w.devClient, bug.id, 'krixi@rgmdn.com');
    await w.devClient.post(`/api/bugs/${bug.id}/status`, { action: 'start_fixing' });
    await w.devClient.post(`/api/bugs/${bug.id}/status`, { action: 'request_retest' });

    const count = async () => Number((await w.db.query(
      `SELECT count(*)::int AS n FROM notifications_outbox WHERE subject_id = $1`,
      [bug.id])).rows[0].n);
    assert.equal(await count(), 1, 'one for attempt 1');

    // The tester sends it back, the developer fixes it again: a new attempt.
    await w.testerClient.post(`/api/bugs/${bug.id}/retest`,
      { result: 'fail', note: 'vẫn lỗi', expectedAttempt: 1 });
    await w.devClient.post(`/api/bugs/${bug.id}/status`, { action: 'request_retest' });
    assert.equal(await count(), 2, 'attempt 2 is a new notice, not a suppressed one');

    // Draining twice must not deliver the same message twice.
    const sender = RecordingSender();
    await runOutbox(w.db, sender, { workerId: randomUUID() });
    await runOutbox(w.db, sender, { workerId: randomUUID() });
    assert.equal(retestMails(sender).length, 2);
  });

  test('a bug with nobody attached notifies nobody and still transitions', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    await w.devClient.post(`/api/bugs/${bug.id}/status`, { action: 'start_fixing' });
    const moved = await w.devClient.post(`/api/bugs/${bug.id}/status`,
      { action: 'request_retest' });
    assert.equal(moved.json.status, 'retest');
    assert.equal(moved.json.notified.queued, 0);

    const sender = RecordingSender();
    await runOutbox(w.db, sender, { workerId: randomUUID() });
    assert.equal(retestMails(sender).length, 0);
  });

  test('an address attached to the bug is not dropped as a non-member', async () => {
    // The membership re-check exists for user recipients; a bare address has no
    // membership, and cancelling it would silently lose the notice.
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    await add(w.devClient, bug.id, 'outsider@elsewhere.test');
    await w.devClient.post(`/api/bugs/${bug.id}/status`, { action: 'start_fixing' });
    await w.devClient.post(`/api/bugs/${bug.id}/status`, { action: 'request_retest' });

    const sender = RecordingSender();
    await runOutbox(w.db, sender, { workerId: randomUUID() });
    assert.deepEqual(retestMails(sender).map((m) => m.to), ['outsider@elsewhere.test']);
    const rows = await w.db.query(
      `SELECT status FROM notifications_outbox WHERE subject_id = $1`, [bug.id]);
    assert.deepEqual(rows.rows.map((r) => r.status), ['sent']);
  });
});