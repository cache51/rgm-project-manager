/**
 * The workflow as it is described by the people using it:
 *
 *   a tester reports it          -> open     (red)
 *   a developer marks it fixed   -> fixed    (light green, waiting to be checked)
 *   the tester verifies it       -> closed   (green)
 *   or the tester says it is not -> open     (red again)
 *
 * This walks the whole loop over real HTTP, against a real server, checking the state
 * after every step and who is allowed to take each one. The state machine is the
 * product here, so the assertions are about states and roles rather than internals.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeProjectWorld, makeMilestone, fileBug } from './helpers.js';

let w, milestoneId;

const statusOf = async (id) =>
  (await w.db.query('SELECT status FROM bugs WHERE id = $1', [id])).rows[0].status;

describe('the fix-and-verify loop', () => {
  before(async () => {
    w = await makeProjectWorld();
    milestoneId = await makeMilestone(w.devClient, w.project.id, 'M1', 'First cut');
    await w.devClient.post(`/api/milestones/${milestoneId}/status`, { action: 'start' });
    await w.devClient.post(`/api/milestones/${milestoneId}/status`, { action: 'ready' });
  });
  after(async () => { await w.close(); });

  test('a tester reports it, and it starts open', async () => {
    const bug = await fileBug(w.testerClient, w.project.id,
      { milestoneId, titleVi: 'Thiếu 3 thùng', bodyVi: 'Kiểm tra lúc 14h' });
    w.bug = bug;

    assert.equal(await statusOf(bug.id), 'new');
    const detail = (await w.testerClient.get(`/api/bugs/${bug.id}`)).json;
    assert.equal(detail.isOpen, true, 'and it counts as open');
  });

  test('a developer marks it fixed, and it becomes fixed', async () => {
    // Two moves, because the machine records who is working on it: claim it, then hand
    // it back for checking.
    const started = await w.devClient.post(`/api/bugs/${w.bug.id}/status`,
      { action: 'start_fixing' });
    assert.equal(started.status, 200, started.text);
    assert.equal(await statusOf(w.bug.id), 'fixing');

    const fixed = await w.devClient.post(`/api/bugs/${w.bug.id}/status`,
      { action: 'request_retest' });
    assert.equal(fixed.status, 200, fixed.text);
    assert.equal(await statusOf(w.bug.id), 'retest', 'now waiting to be checked');
  });

  test('a tester can send it back when the fix is not there', async () => {
    const res = await w.testerClient.post(`/api/bugs/${w.bug.id}/retest`,
      { result: 'fail', note: 'Vẫn còn thiếu', expectedAttempt: 1 });
    assert.equal(res.status, 200, res.text);
    assert.equal(await statusOf(w.bug.id), 'fixing', 'red again: the problem is back');

    const detail = (await w.testerClient.get(`/api/bugs/${w.bug.id}`)).json;
    assert.equal(detail.isOpen, true, 'and it is open again');
  });

  test('the developer can mark it fixed again after the send-back', async () => {
    const res = await w.devClient.post(`/api/bugs/${w.bug.id}/status`,
      { action: 'request_retest' });
    assert.equal(res.status, 200, res.text);
    assert.equal(await statusOf(w.bug.id), 'retest');
  });

  test('the tester verifies the fix and it closes', async () => {
    const res = await w.testerClient.post(`/api/bugs/${w.bug.id}/retest`,
      { result: 'pass', note: 'Đã đủ hàng', expectedAttempt: 2 });
    assert.equal(res.status, 200, res.text);
    assert.equal(await statusOf(w.bug.id), 'closed');

    const detail = (await w.testerClient.get(`/api/bugs/${w.bug.id}`)).json;
    assert.equal(detail.isOpen, false, 'and it stops counting as open');
  });

  test('a closed bug can be reopened by a developer, and the reason is recorded', async () => {
    const res = await w.devClient.post(`/api/bugs/${w.bug.id}/status`,
      { action: 'reopen', reason: 'the customer saw it again' });
    assert.equal(res.status, 200, res.text);
    assert.equal(await statusOf(w.bug.id), 'fixing', 'red again');

    // An event's kind names the state it moved INTO (`bug.fixing`), which is what makes
    // the timeline readable — so the reason travels in its payload.
    const ev = await w.db.query(
      `SELECT kind, payload FROM events WHERE bug_id = $1
        ORDER BY id DESC LIMIT 1`, [w.bug.id]);
    assert.equal(ev.rows[0].kind, 'bug.fixing');
    assert.match(JSON.stringify(ev.rows[0].payload), /customer saw it again/,
      'why it came back is on the record');
  });

  test('the whole loop is on the timeline, in order', async () => {
    const detail = (await w.devClient.get(`/api/bugs/${w.bug.id}`)).json;
    const moves = detail.timeline.map((e) => e.kind);

    assert.ok(moves.includes('bug.filed'), 'the report itself');
    assert.ok(moves.includes('bug.retest'), 'marked fixed');
    assert.ok(moves.includes('bug.retest_pass'), 'verified');
    assert.ok(moves.includes('bug.retest_fail'), 'and sent back once');
    assert.ok(moves.filter((k) => k === 'bug.fixing').length >= 2,
      'sent back, and then reopened — both land in fixing');

    // And the reason written when it was reopened is readable in the viewer's voice.
    const reopened = detail.timeline.filter((e) => e.kind === 'bug.fixing').pop();
    assert.match(reopened.note ?? reopened.reason ?? '', /customer saw it again/);
  });

  test('the roles that may move it are the ones intended', async () => {
    const fresh = await fileBug(w.testerClient, w.project.id,
      { milestoneId, titleVi: 'Chỉ dev mới được chuyển', bodyVi: 'Chi tiết' });

    // A tester cannot claim or fix anything.
    assert.equal((await w.testerClient.post(`/api/bugs/${fresh.id}/status`,
      { action: 'start_fixing' })).status, 403);
    assert.equal((await w.testerClient.post(`/api/bugs/${fresh.id}/status`,
      { action: 'request_retest' })).status, 403);
    // And cannot verify something that is not awaiting verification.
    assert.equal((await w.testerClient.post(`/api/bugs/${fresh.id}/retest`,
      { result: 'pass' })).status, 409);
  });

  test('verifying without a fix in between is refused', async () => {
    const fresh = await fileBug(w.testerClient, w.project.id,
      { milestoneId, titleVi: 'Chưa sửa mà đã xác nhận', bodyVi: 'Chi tiết' });

    const res = await w.testerClient.post(`/api/bugs/${fresh.id}/retest`,
      { result: 'pass' });
    assert.equal(res.status, 409, 'there is nothing to verify yet');
    assert.equal(await statusOf(fresh.id), 'new', 'and the state did not move');
  });
});
