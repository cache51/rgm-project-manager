/**
 * Bug lifecycle: numbering, transitions, retest attempts and translation.
 * The transition table is pure and unit-tested elsewhere; these tests prove the
 * HTTP layer and the database actually enforce it.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeProjectWorld, makeMilestone, fileBug } from './helpers.js';
import { runBugTranslations, runEventTranslations, StubProvider,
         FailingProvider } from '../src/translate.js';

describe('bugs: filing and numbering', () => {
  let w, ms;
  before(async () => {
    w = await makeProjectWorld();
    ms = await makeMilestone(w.adminClient, w.project.id, 'M-NUM', 'Numbering');
  });
  after(async () => { await w.close(); });

  test('a tester files a bug and gets the next per-project number', async () => {
    const first = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    const second = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    assert.equal(first.code, 'BUG-1');
    assert.equal(second.code, 'BUG-2');
  });

  test('numbers are independent between projects', async () => {
    const otherId = (await w.db.query(
      `INSERT INTO projects (name, client) VALUES ('Second','ACME') RETURNING id`)).rows[0].id;
    await w.db.query('INSERT INTO project_counters (project_id) VALUES ($1)', [otherId]);
    const token = await w.invite({ projectId: otherId, email: 'p2@rgm.example', role: 'developer',
                                   createdBy: w.admin.userId });
    await w.redeem(token);
    const client = await w.loginAs('p2@rgm.example');
    const otherMs = await makeMilestone(client, otherId, 'M1', 'Other');

    const bug = await fileBug(client, otherId, { milestoneId: otherMs });
    assert.equal(bug.code, 'BUG-1', 'the second project starts its own sequence at 1');
  });

  test('a milestone from another project is refused', async () => {
    // This tester IS a member of the other project, so a 400 below can only come
    // from the milestone check — not from an authorization failure.
    const otherId = (await w.db.query(
      `INSERT INTO projects (name, client) VALUES ('Third','ACME') RETURNING id`)).rows[0].id;
    await w.db.query('INSERT INTO project_counters (project_id) VALUES ($1)', [otherId]);
    const token = await w.invite({ projectId: otherId, email: 'p3@rgm.example',
                                   role: 'developer', createdBy: w.admin.userId });
    await w.redeem(token);
    const client = await w.loginAs('p3@rgm.example');
    const otherMs = await makeMilestone(client, otherId, 'M1', 'Third');

    // Their own project works end to end...
    assert.equal((await fileBug(client, otherId, { milestoneId: otherMs })).code, 'BUG-1');

    // ...but this project's milestone does not belong there.
    const foreign = await client.post(`/api/projects/${otherId}/bugs`,
      { milestoneId: ms, severity: 'low', titleVi: 'x', bodyVi: 'y' });
    assert.equal(foreign.status, 400);
    assert.equal(foreign.json.error, 'bad_milestone');
  });

  test('missing fields and bad severity are rejected', async () => {
    assert.equal((await w.testerClient.post(`/api/projects/${w.project.id}/bugs`,
      { milestoneId: ms, severity: 'low', titleVi: 'only a title' })).status, 400);
    assert.equal((await w.testerClient.post(`/api/projects/${w.project.id}/bugs`,
      { milestoneId: ms, severity: 'urgent', titleVi: 'a', bodyVi: 'b' })).status, 400);
  });

  test('the list reports which bugs are open, counting everything not closed', async () => {
    const list = await w.testerClient.get(`/api/projects/${w.project.id}/bugs`);
    assert.equal(list.status, 200);
    // The counter is derived from the same predicate as each row's flag.
    assert.equal(list.json.openCount, list.json.bugs.filter(b => b.isOpen).length);
    assert.ok(list.json.openCount >= 2, 'bugs filed earlier in this suite');
    assert.equal(list.json.bugs.filter(b => b.isOpen).length,
                 list.json.bugs.filter(b => b.status !== 'closed').length,
                 'open must mean exactly "not closed"');
  });

  test('a bug can be found by its human number', async () => {
    const found = await w.testerClient.get(`/api/projects/${w.project.id}/bugs/by-number/1`);
    assert.equal(found.status, 200);
    assert.equal(found.json.code, 'BUG-1');

    const missing = await w.testerClient.get(`/api/projects/${w.project.id}/bugs/by-number/999`);
    assert.equal(missing.status, 404);
  });
});

describe('bugs: lifecycle transitions', () => {
  let w, ms;
  before(async () => {
    w = await makeProjectWorld();
    ms = await makeMilestone(w.adminClient, w.project.id, 'M-LIFE', 'Lifecycle');
  });
  after(async () => { await w.close(); });

  test('new -> fixing -> retest -> closed', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });

    let res = await w.devClient.post(`/api/bugs/${bug.id}/status`, { action: 'start_fixing' });
    assert.equal(res.json.status, 'fixing');

    res = await w.devClient.post(`/api/bugs/${bug.id}/status`, { action: 'request_retest' });
    assert.equal(res.json.status, 'retest');
    assert.equal(res.json.retest_attempt, 1, 'requesting a retest starts a new attempt');

    res = await w.testerClient.post(`/api/bugs/${bug.id}/retest`,
      { result: 'pass', expectedAttempt: 1 });
    assert.equal(res.json.status, 'closed');
  });

  test('a retest failure returns the bug to fixing', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    await w.devClient.post(`/api/bugs/${bug.id}/status`, { action: 'start_fixing' });
    await w.devClient.post(`/api/bugs/${bug.id}/status`, { action: 'request_retest' });

    const res = await w.testerClient.post(`/api/bugs/${bug.id}/retest`,
      { result: 'fail', expectedAttempt: 1, note: 'Vẫn còn lỗi ở thùng thứ 3' });
    assert.equal(res.json.status, 'fixing');
  });

  test('an illegal transition is refused, not silently ignored', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    // `new -> retest` was allowed by the old `*->retest` wildcard.
    const res = await w.devClient.post(`/api/bugs/${bug.id}/status`, { action: 'request_retest' });
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'ILLEGAL_TRANSITION');

    // ...and the bug is untouched.
    const after = await w.devClient.get(`/api/bugs/${bug.id}`);
    assert.equal(after.json.status, 'new');
  });

  test('closing requires a reason', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    const noReason = await w.devClient.post(`/api/bugs/${bug.id}/status`, { action: 'close' });
    assert.equal(noReason.status, 409);
    assert.equal(noReason.json.error, 'REASON_REQUIRED');

    const withReason = await w.devClient.post(`/api/bugs/${bug.id}/status`,
      { action: 'close', reason: 'Không tái hiện được' });
    assert.equal(withReason.json.status, 'closed');
  });

  test('a tester cannot perform a developer-only transition', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    const res = await w.testerClient.post(`/api/bugs/${bug.id}/status`,
      { action: 'start_fixing' });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'forbidden');

    // Refused by role before the transition table is even consulted; the bug is
    // unchanged either way.
    assert.equal((await w.devClient.get(`/api/bugs/${bug.id}`)).json.status, 'new');
  });

  test('a stale retest result is refused, so an old cycle cannot close a new one', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    await w.devClient.post(`/api/bugs/${bug.id}/status`, { action: 'start_fixing' });
    await w.devClient.post(`/api/bugs/${bug.id}/status`, { action: 'request_retest' });   // attempt 1
    await w.testerClient.post(`/api/bugs/${bug.id}/retest`,
      { result: 'fail', expectedAttempt: 1 });                                            // back to fixing
    await w.devClient.post(`/api/bugs/${bug.id}/status`, { action: 'request_retest' });   // attempt 2

    // A tester still holding the attempt-1 page submits late.
    const stale = await w.testerClient.post(`/api/bugs/${bug.id}/retest`,
      { result: 'pass', expectedAttempt: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error, 'STALE_ATTEMPT');

    // The current attempt still works.
    const fresh = await w.testerClient.post(`/api/bugs/${bug.id}/retest`,
      { result: 'pass', expectedAttempt: 2 });
    assert.equal(fresh.json.status, 'closed');
  });

  test('an assigned retest can only be recorded by the assignee', async () => {
    // A second tester joins the project.
    const token = await w.invite({ projectId: w.project.id, email: 'tester2@rgm.example',
                                   role: 'tester', createdBy: w.admin.userId });
    await w.redeem(token);
    const tester2 = await w.loginAs('tester2@rgm.example');
    const tester2Id = (await tester2.get('/api/me')).json.userId;

    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    await w.devClient.post(`/api/bugs/${bug.id}/status`, { action: 'start_fixing' });
    await w.devClient.post(`/api/bugs/${bug.id}/status`,
      { action: 'request_retest', assigneeId: tester2Id });

    const wrongTester = await w.testerClient.post(`/api/bugs/${bug.id}/retest`,
      { result: 'pass', expectedAttempt: 1 });
    assert.equal(wrongTester.status, 403);

    const rightTester = await tester2.post(`/api/bugs/${bug.id}/retest`,
      { result: 'pass', expectedAttempt: 1 });
    assert.equal(rightTester.json.status, 'closed');
  });

  test('an assignee who is not a member of the project is refused', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    await w.devClient.post(`/api/bugs/${bug.id}/status`, { action: 'start_fixing' });
    const res = await w.devClient.post(`/api/bugs/${bug.id}/status`,
      { action: 'request_retest', assigneeId: randomUUID() });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'bad_assignee');
  });
});

describe('bugs: translation', () => {
  let w, ms;
  before(async () => {
    w = await makeProjectWorld();
    ms = await makeMilestone(w.adminClient, w.project.id, 'M-TR', 'Translation');
  });
  after(async () => { await w.close(); });

  test('filing a bug queues zh and en for both title and body, in the same transaction', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    const rows = await w.db.query(
      `SELECT field, lang, status FROM bug_translations WHERE bug_id = $1
        ORDER BY field, lang`, [bug.id]);
    assert.equal(rows.rows.length, 4);
    assert.ok(rows.rows.every(r => r.status === 'pending'));
  });

  test('the worker drains the queue and the result is readable', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    const results = await runBugTranslations(w.db, StubProvider(), { workerId: randomUUID() });

    // Exactly this bug's four jobs must complete (earlier tests leave rows behind).
    const mine = results.filter(r => r.bugId === bug.id);
    assert.equal(mine.length, 4);
    assert.ok(mine.every(r => r.status === 'done'));

    const payload = (await w.devClient.get(`/api/bugs/${bug.id}`)).json;
    assert.equal(payload.translations.body.zh.status, 'done');
    assert.match(payload.translations.body.zh.text, /^«zh» /);
    assert.match(payload.translations.body.en.text, /^«en» /);
  });

  test('a translation outage does not lose the bug — it stays reportable', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    const results = await runBugTranslations(w.db, FailingProvider('upstream 503'),
      { workerId: randomUUID() });
    assert.ok(results.length >= 4);
    assert.ok(results.every(r => r.status === 'failed'));

    // The report itself is intact and readable in the original language.
    const payload = (await w.devClient.get(`/api/bugs/${bug.id}`)).json;
    assert.equal(payload.status, 'new');
    assert.equal(payload.titleVi, 'Thiếu hàng');
    assert.equal(payload.translations.body.zh.status, 'failed');
    assert.match(payload.translations.body.zh.error, /503/);

    // And a retry can clear the failure for the next pass.
    const retry = await w.devClient.post(`/api/bugs/${bug.id}/translations/zh/retry`,
      { field: 'body' });
    assert.equal(retry.status, 200);
    const again = await runBugTranslations(w.db, StubProvider(), { workerId: randomUUID() });
    assert.ok(again.some(r => r.status === 'done'));
  });

  test('a Vietnamese retest note is translated, and appears on the timeline', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    await w.devClient.post(`/api/bugs/${bug.id}/status`, { action: 'start_fixing' });
    await w.devClient.post(`/api/bugs/${bug.id}/status`, { action: 'request_retest' });
    await w.testerClient.post(`/api/bugs/${bug.id}/retest`,
      { result: 'fail', expectedAttempt: 1, note: 'Thùng thứ 3 vẫn bị lệch' });

    await runBugTranslations(w.db, StubProvider(), { workerId: randomUUID() });
    await runEventTranslations(w.db, StubProvider(), { workerId: randomUUID() });

    const payload = (await w.devClient.get(`/api/bugs/${bug.id}`)).json;
    const failed = payload.timeline.find(e => e.kind === 'bug.retest_fail');
    assert.ok(failed, 'the retest failure should be on the timeline');
    assert.equal(failed.note, 'Thùng thứ 3 vẫn bị lệch');
    assert.equal(failed.noteTranslations.zh.status, 'done',
      'the note must be readable to a Chinese-speaking developer (RGM2-005)');
  });

  test('the handoff prompt renders timestamps in the project timezone, not raw UTC', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    const prompt = await w.devClient.get(`/api/bugs/${bug.id}/prompt`);
    const payload = (await w.devClient.get(`/api/bugs/${bug.id}`)).json;

    assert.match(prompt.text, /Asia\/Ho_Chi_Minh/, 'the zone must be named in the prompt');
    assert.ok(!prompt.text.includes(payload.createdAt),
      'the raw UTC instant must not be what the agent is handed — the UI shows local time');
  });

  test('the prompt carries title translations and reports a partial failure', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    await runBugTranslations(w.db, StubProvider(), { workerId: randomUUID() });

    const full = await w.devClient.get(`/api/bugs/${bug.id}/prompt`);
    assert.match(full.text, /BUG_TITLE_ZH/, 'the title must be translated in the prompt');
    assert.match(full.text, /Translation coverage: complete/);

    // Now make one language fail and re-request: the prompt must say so rather
    // than quietly showing a zh-only report (RGM-S1-006).
    await w.db.query(
      `UPDATE bug_translations SET status = 'failed', error = 'upstream 503'
        WHERE bug_id = $1 AND field = 'body' AND lang = 'en'`, [bug.id]);

    const partial = await w.devClient.get(`/api/bugs/${bug.id}/prompt`);
    assert.equal((partial.text.match(/BUG_BODY_EN/g) ?? []).length, 0,
      'the missing translation has no block');
    assert.match(partial.text, /Translation coverage: INCOMPLETE/);
    assert.match(partial.text, /body\/en failed \(upstream 503\)/);
  });

  test('the handoff prompt carries the timeline note inside an untrusted fence', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    await w.devClient.post(`/api/bugs/${bug.id}/comments`, { note: 'Đã kiểm tra lại máy' });
    await runBugTranslations(w.db, StubProvider(), { workerId: randomUUID() });
    await runEventTranslations(w.db, StubProvider(), { workerId: randomUUID() });

    const res = await w.devClient.get(`/api/bugs/${bug.id}/prompt`);
    assert.equal(res.status, 200);
    assert.equal(res.contentType.startsWith('text/markdown'), true);
    assert.match(res.text, /RGM-UNTRUSTED/);
    assert.match(res.text, /Đã kiểm tra lại máy/);
    assert.match(res.text, /--- BEGIN UNTRUSTED REPORT/);
  });
});
