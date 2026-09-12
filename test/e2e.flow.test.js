/**
 * The whole journey, once, end to end:
 *
 *   admin creates a project -> invites a Vietnamese tester and a Chinese-reading
 *   developer -> both sign in -> developer marks a milestone ready -> the tester
 *   is notified -> files a bug with a screenshot in Vietnamese -> it is translated
 *   -> the developer reads it and pulls the agent handoff packet -> fixes ->
 *   retest fails with a Vietnamese note -> that note is translated -> fixed again
 *   -> retest passes -> closed.
 *
 * This is the only test that exercises every layer together; the focused suites
 * above explain *why* each step behaves as it does.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeWorld, PNG_BYTES } from './helpers.js';
import { bootstrap, createProject } from '../src/auth.js';
import { runBugTranslations, runEventTranslations, StubProvider } from '../src/translate.js';
import { runOutbox, RecordingSender } from '../src/notify.js';

const run = promisify(execFile);

describe('end to end: a milestone, a bug, a fix and a verifiable handoff', () => {
  let w;
  const sender = RecordingSender();
  const workerId = () => randomUUID();
  let worker;

  let adminClient, devClient, testerClient;
  let project, milestone, bug;

  before(async () => {
    w = await makeWorld();

    // ── 1. the first site admin exists and creates the project ──
    const admin = await bootstrap(w.db, 'yuen@rgm.example');
    project = await createProject(w.db, {
      name: 'Packing Line', client: 'LWMS', env: 'staging', createdBy: admin.userId
    });
    adminClient = await w.loginAs('yuen@rgm.example');

    // ── 2. a Vietnamese tester and a Chinese-reading developer are invited ──
    for (const [email, role] of [['linh@rgm.example', 'tester'],
                                 ['wei@rgm.example', 'developer']]) {
      const token = await w.invite({ projectId: project.id, email, role,
                                     createdBy: admin.userId });
      await w.redeem(token);
    }
    testerClient = await w.loginAs('linh@rgm.example');
    devClient = await w.loginAs('wei@rgm.example');

    // ── 3. the developer plans a milestone ──
    milestone = (await devClient.post(`/api/projects/${project.id}/milestones`,
      { code: 'M1', titleEn: 'First cut', titleVi: 'Bản cắt đầu', titleZh: '首版' })).json.id;
  });

  after(async () => { await w.close(); });

  test('both members can see the project they were invited to', async () => {
    for (const client of [adminClient, devClient, testerClient]) {
      const res = await client.get('/api/projects');
      assert.equal(res.json.projects.length, 1);
      assert.equal(res.json.projects[0].id, project.id);
    }
    const members = await adminClient.get(`/api/projects/${project.id}/members`);
    assert.deepEqual(
      members.json.members.map(m => m.role).sort(),
      ['admin', 'developer', 'tester']);
  });

  test('marking the milestone ready notifies the tester, once', async () => {
    await devClient.post(`/api/milestones/${milestone}/status`, { action: 'start' });
    const ready = await devClient.post(`/api/milestones/${milestone}/status`, { action: 'ready' });
    assert.equal(ready.json.milestone.status, 'ready');
    assert.equal(ready.json.notified.recipients, 1, 'exactly the one tester');

    worker = sender;
    const first = await runOutbox(w.db, sender, { workerId: workerId() });
    assert.equal(first.length, 1);
    assert.equal(first[0].status, 'sent');
    assert.equal(sender.sent.length, 1);
    assert.equal(sender.sent[0].to, 'linh@rgm.example');

    // Running the worker again must not send a second time.
    const second = await runOutbox(w.db, sender, { workerId: workerId() });
    assert.equal(second.length, 0);
    assert.equal(sender.sent.length, 1, 'delivery must not duplicate on a re-run');

    // The provider received a stable idempotency key.
    assert.match(sender.sent[0].idempotencyKey, /^milestone\.ready:/);
  });

  test('a second readiness cycle does notify again', async () => {
    // in_progress -> ready -> done -> reset -> in_progress -> ready
    await devClient.post(`/api/milestones/${milestone}/status`, { action: 'finish' });
    await adminClient.post(`/api/milestones/${milestone}/status`,
      { action: 'reset', reason: 'khách hàng đổi yêu cầu' });
    await devClient.post(`/api/milestones/${milestone}/status`, { action: 'start' });
    const ready = await devClient.post(`/api/milestones/${milestone}/status`, { action: 'ready' });
    assert.equal(ready.json.milestone.ready_count, 2,
      'the dedupe key includes the generation, so a real second notice is not suppressed');

    const delivered = await runOutbox(w.db, sender, { workerId: workerId() });
    assert.equal(delivered.length, 1);
    assert.equal(sender.sent.length, 2);
  });

  test('the tester files a bug in Vietnamese with a screenshot', async () => {
    const filed = await testerClient.post(`/api/projects/${project.id}/bugs`, {
      milestoneId: milestone,
      severity: 'high',
      titleVi: 'Số lượng thùng không khớp',
      bodyVi: 'Thùng thứ 3 chỉ có 47 cái, bảng đóng gói ghi 50 cái.'
    });
    assert.equal(filed.status, 201);
    bug = filed.json;
    assert.equal(bug.code, 'BUG-1');

    // two-phase upload: presign, PUT the bytes, complete
    const presign = (await testerClient.post(`/api/bugs/${bug.id}/attachments/presign`,
      { contentType: 'image/png', byteSize: PNG_BYTES.length })).json;
    assert.equal((await testerClient.put(presign.uploadUrl, PNG_BYTES)).status, 201);
    const attached = await testerClient.post(`/api/bugs/${bug.id}/attachments/complete`,
      { storageKey: presign.storageKey, uploadToken: presign.uploadToken,
        filename: 'thùng 3.png' });
    assert.equal(attached.status, 201);
  });

  test('the queue is drained and the developer can read it in Chinese', async () => {
    const translations = await runBugTranslations(w.db, StubProvider(), { workerId: workerId() });
    const mine = translations.filter(r => r.bugId === bug.id);
    assert.equal(mine.length, 4);
    assert.ok(mine.every(r => r.status === 'done'));

    const payload = (await devClient.get(`/api/bugs/${bug.id}`)).json;
    assert.equal(payload.translations.title.zh.status, 'done');
    assert.match(payload.translations.body.zh.text, /^«zh» /);
    assert.equal(payload.attachments.length, 1);
    assert.equal(payload.attachments[0].originalFilename, 'thùng 3.png');
    assert.equal(payload.attachments[0].name, 'screenshot_01.png');
  });

  test('the developer pulls a packet and reads the prompt', async () => {
    const prompt = await devClient.get(`/api/bugs/${bug.id}/prompt`);
    assert.equal(prompt.status, 200);
    assert.match(prompt.text, /Số lượng thùng không khớp/);
    assert.match(prompt.text, /RGM-UNTRUSTED/);
    assert.match(prompt.text, /«zh»/);

    const packet = await devClient.get(`/api/bugs/${bug.id}/packet`);
    assert.equal(packet.status, 200);
    const path = join(w.dir, 'e2e-packet.zip');
    await writeFile(path, packet.buf);
    const { stdout: list } = await run('unzip', ['-Z1', path]);
    assert.deepEqual(list.trim().split('\n'),
      ['bug.md', 'meta.json', 'screenshot_01.png']);
    const { stdout: test } = await run('unzip', ['-t', path]);
    assert.match(test, /No errors detected/);
  });

  test('a fix is requested, retested, and fails with a Vietnamese note that gets translated', async () => {
    assert.equal((await devClient.post(`/api/bugs/${bug.id}/status`,
      { action: 'start_fixing' })).json.status, 'fixing');

    const requested = await devClient.post(`/api/bugs/${bug.id}/status`,
      { action: 'request_retest' });
    assert.equal(requested.json.status, 'retest');
    assert.equal(requested.json.retest_attempt, 1);

    const failed = await testerClient.post(`/api/bugs/${bug.id}/retest`, {
      result: 'fail',
      expectedAttempt: 1,
      note: 'Đã đếm lại, vẫn thiếu 3 cái ở thùng 3'
    });
    assert.equal(failed.json.status, 'fixing');

    await runBugTranslations(w.db, StubProvider(), { workerId: workerId() });
    await runEventTranslations(w.db, StubProvider(), { workerId: workerId() });

    const payload = (await devClient.get(`/api/bugs/${bug.id}`)).json;
    const noteEvent = payload.timeline.find(e => e.kind === 'bug.retest_fail');
    assert.ok(noteEvent, 'the failure is on the timeline');
    assert.equal(noteEvent.note, 'Đã đếm lại, vẫn thiếu 3 cái ở thùng 3');
    assert.equal(noteEvent.noteTranslations.zh.status, 'done',
      'the developer can read why it failed');
  });

  test('the second attempt is a different attempt number, and the first one is now stale', async () => {
    const requested = await devClient.post(`/api/bugs/${bug.id}/status`,
      { action: 'request_retest' });
    assert.equal(requested.json.retest_attempt, 2);

    const stale = await testerClient.post(`/api/bugs/${bug.id}/retest`,
      { result: 'pass', expectedAttempt: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error, 'STALE_ATTEMPT');
  });

  test('the retest passes and the bug closes', async () => {
    const passed = await testerClient.post(`/api/bugs/${bug.id}/retest`,
      { result: 'pass', expectedAttempt: 2, note: 'Đã đủ 50 cái' });
    assert.equal(passed.json.status, 'closed');

    const payload = (await devClient.get(`/api/bugs/${bug.id}`)).json;
    assert.equal(payload.isOpen, false);
    assert.equal(payload.availableActions.some(a => a.action === 'reopen'), true);
  });

  test('the timeline is complete and every entry is timestamped', async () => {
    const payload = (await devClient.get(`/api/bugs/${bug.id}`)).json;
    const kinds = payload.timeline.map(e => e.kind);
    for (const expected of ['bug.filed', 'bug.attachment_added', 'bug.fixing',
                            'bug.retest', 'bug.retest_fail', 'bug.retest_pass']) {
      assert.ok(kinds.includes(expected), `timeline should contain ${expected}`);
    }
    // There is no separate "closed" event: a passing retest IS the close, so the
    // closing entry is the retest_pass — and it records the resulting status.
    const closing = payload.timeline.find(e => e.kind === 'bug.retest_pass');
    assert.equal(closing.to, 'closed');
    assert.equal(closing.result, 'pass');

    for (const event of payload.timeline) {
      assert.ok(event.at, `event ${event.kind} must carry a timestamp`);
      assert.ok(!Number.isNaN(Date.parse(event.at)), `event ${event.kind} timestamp must parse`);
      assert.ok(event.actor, `event ${event.kind} must name an actor`);
    }
    const times = payload.timeline.map(e => Date.parse(e.at));
    assert.deepEqual(times, [...times].sort((a, b) => a - b), 'timeline is in order');
  });

  test('the bug list reflects the closed state and the counts agree', async () => {
    const list = await testerClient.get(`/api/projects/${project.id}/bugs`);
    assert.equal(list.json.bugs.length, 1);
    assert.equal(list.json.openCount, 0);
    assert.equal(list.json.bugs[0].status, 'closed');
  });

  test('the events table is append-only: history cannot be rewritten', async () => {
    await assert.rejects(
      () => w.db.query('UPDATE events SET kind = $1', ['tampered']),
      /append-only/);
    await assert.rejects(
      () => w.db.query('DELETE FROM events'),
      /append-only/);
  });
});
