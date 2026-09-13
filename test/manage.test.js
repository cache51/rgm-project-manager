/**
 * Editing and removing projects, milestones and bugs.
 *
 * These are the operations the UI could not reach at all. Two properties matter most
 * and are asserted directly: removal never destroys anything (the row and its history
 * survive, and it can be put back), and editing a tester's Vietnamese puts the derived
 * translation back in the queue — otherwise the developers keep reading a translation
 * of a sentence that has since been corrected.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeProjectWorld, makeMilestone, fileBug } from './helpers.js';

let w;
const base = () => `/api/projects/${w.project.id}`;

describe('managing projects, milestones and bugs', () => {
  before(async () => { w = await makeProjectWorld(); });
  after(async () => { await w.close(); });

  // ───────────────────────── projects ─────────────────────────

  test('a project can be renamed, and the change is visible and recorded', async () => {
    const res = await w.adminClient.patch(base(), { name: 'Packing Line 7' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.name, 'Packing Line 7');

    const listed = (await w.adminClient.get('/api/projects')).json.projects;
    assert.equal(listed.find((p) => p.id === w.project.id).name, 'Packing Line 7');

    const ev = await w.db.query(
      `SELECT payload FROM events WHERE project_id = $1 AND kind = 'project.updated'`,
      [w.project.id]);
    assert.equal(ev.rows.length, 1, 'the rename is attributable');
  });

  test('the environment can be changed but a blank name cannot', async () => {
    assert.equal((await w.adminClient.patch(base(), { env: 'production' })).json.env,
      'production');
    // The name is untouched by an env-only edit.
    assert.equal((await w.adminClient.get('/api/projects')).json.projects[0].name,
      'Packing Line 7');

    const blank = await w.adminClient.patch(base(), { name: '   ' });
    assert.equal(blank.status, 400);
    assert.equal(blank.json.error, 'bad_name');
  });

  test('a tester cannot rename a project', async () => {
    const res = await w.testerClient.patch(base(), { name: 'Mine now' });
    assert.equal(res.status, 403);
  });

  test('removing a project hides it and stops everything underneath it', async () => {
    // Something to survive the removal: a milestone with a bug and its attachments.
    const milestoneId = await makeMilestone(w.devClient, w.project.id, 'MP', 'Before removal');
    const bug = await fileBug(w.testerClient, w.project.id,
      { milestoneId, titleVi: 'Lỗi trước khi xoá dự án', bodyVi: 'Chi tiết' });
    w.bugBeforeRemoval = bug;

    const res = await w.adminClient.del(base());
    assert.equal(res.status, 200, res.text);

    const listed = (await w.adminClient.get('/api/projects')).json.projects;
    assert.equal(listed.find((p) => p.id === w.project.id), undefined,
      'gone from the list');
    const mine = (await w.adminClient.get('/api/me')).json.projects;
    assert.equal(mine.find((p) => p.id === w.project.id), undefined,
      'and gone from the sidebar');

    // 410, not 403: it was removed, which is not a permissions problem.
    const write = await w.adminClient.post(`${base()}/milestones`,
      { code: 'M9', titleEn: 'After removal' });
    assert.equal(write.status, 410);
    assert.equal(write.json.error, 'project_removed');
    assert.equal((await w.testerClient.get(`${base()}/milestones`)).status, 410);
  });

  test('nothing was destroyed, and restoring brings it all back', async () => {
    // The rows are still there, which is the whole point of a soft delete.
    const bugs = await w.db.query(
      'SELECT count(*)::int AS n FROM bugs WHERE project_id = $1 AND deleted_at IS NULL',
      [w.project.id]);
    assert.ok(bugs.rows[0].n > 0, 'the bug filed before the removal is still in the database');
    const still = await w.db.query('SELECT id FROM bugs WHERE id = $1',
      [w.bugBeforeRemoval.id]);
    assert.equal(still.rows.length, 1, 'and it is the same row, not a copy');

    const res = await w.adminClient.post(`${base()}/restore`, {});
    assert.equal(res.status, 200, res.text);
    const listed = (await w.adminClient.get('/api/projects')).json.projects;
    assert.ok(listed.find((p) => p.id === w.project.id), 'back in the list');

    const write = await w.adminClient.post(`${base()}/milestones`,
      { code: 'MR', titleEn: 'After restore' });
    assert.equal(write.status, 201, 'and writable again');

    const readable = await w.adminClient.get(`/api/bugs/${w.bugBeforeRemoval.id}`);
    assert.equal(readable.status, 200, 'its bugs are readable again');

    const ev = await w.db.query(
      `SELECT count(*)::int AS n FROM events
        WHERE project_id = $1 AND kind IN ('project.removed','project.restored')`,
      [w.project.id]);
    assert.equal(ev.rows[0].n, 2, 'both acts are on the record');
  });

  // ───────────────────────── milestones ─────────────────────────

  test('a milestone can be renamed, field by field', async () => {
    const id = await makeMilestone(w.devClient, w.project.id, 'M2', 'Second cut');
    const res = await w.devClient.patch(`/api/milestones/${id}`,
      { titleEn: 'Second cut, revised', titleVi: 'Lần cắt thứ hai' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.title_en, 'Second cut, revised');
    assert.equal(res.json.title_vi, 'Lần cắt thứ hai');

    // An unmentioned field is left alone, so a Vietnamese title can be set without
    // touching the English one and vice versa.
    const cleared = await w.devClient.patch(`/api/milestones/${id}`, { titleVi: null });
    assert.equal(cleared.json.title_vi, null, 'cleared');
    assert.equal(cleared.json.title_en, 'Second cut, revised', 'and English survived');
  });

  test('a milestone edit with no fields is refused, and a tester cannot make it', async () => {
    const id = await makeMilestone(w.devClient, w.project.id, 'M3');
    const empty = await w.devClient.patch(`/api/milestones/${id}`, {});
    assert.equal(empty.status, 400);
    assert.equal(empty.json.error, 'nothing_to_change');

    assert.equal((await w.testerClient.patch(`/api/milestones/${id}`,
      { titleEn: 'nope' })).status, 403);
  });

  test('removing a milestone hides it but keeps its bugs', async () => {
    const id = await makeMilestone(w.devClient, w.project.id, 'M4', 'Doomed');
    const bug = await fileBug(w.testerClient, w.project.id,
      { milestoneId: id, titleVi: 'Lỗi trên cột mốc bị xoá', bodyVi: 'Chi tiết' });

    assert.equal((await w.devClient.del(`/api/milestones/${id}`)).status, 200);

    const listed = (await w.adminClient.get(`${base()}/milestones`)).json.milestones;
    assert.equal(listed.find((m) => m.id === id), undefined, 'gone from the list');

    // The bug survives, attached to the milestone it was filed against.
    const still = await w.db.query('SELECT milestone_id FROM bugs WHERE id = $1', [bug.id]);
    assert.equal(still.rows[0].milestone_id, id);
    assert.equal((await w.adminClient.get(`/api/bugs/${bug.id}`)).status, 200,
      'and is still readable');

    // Reporting against a removed milestone is refused rather than quietly accepted.
    const res = await w.testerClient.post(`${base()}/bugs`,
      { milestoneId: id, severity: 'high', titleVi: 'x', bodyVi: 'y' });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'bad_milestone');
  });

  test('a removed milestone can be restored', async () => {
    const listed = await w.db.query(
      `SELECT id FROM milestones WHERE project_id = $1 AND code = 'M4'`, [w.project.id]);
    const id = listed.rows[0].id;

    const res = await w.devClient.post(`/api/milestones/${id}/restore`, {});
    assert.equal(res.status, 200, res.text);
    const after = (await w.adminClient.get(`${base()}/milestones`)).json.milestones;
    assert.ok(after.find((m) => m.id === id), 'back in the list');
  });

  // ───────────────────────── bugs ─────────────────────────

  test('the reporter can fix a typo, and only the changed field is retranslated', async () => {
    const milestoneId = await makeMilestone(w.devClient, w.project.id, 'M5');
    const bug = await fileBug(w.testerClient, w.project.id,
      { milestoneId, titleVi: 'Tiêu đề sai chính tả', bodyVi: 'Nội dung đúng' });

    // Pretend the worker has already translated both fields.
    await w.db.query(
      `UPDATE bug_translations SET status = 'done', text = 'translated'
        WHERE bug_id = $1`, [bug.id]);

    const res = await w.testerClient.patch(`/api/bugs/${bug.id}`,
      { titleVi: 'Tiêu đề đã sửa' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.title_vi, 'Tiêu đề đã sửa');

    const rows = await w.db.query(
      `SELECT field, status, text FROM bug_translations WHERE bug_id = $1 ORDER BY field`,
      [bug.id]);
    const byField = Object.fromEntries(rows.rows.map((r) => [r.field, r]));
    assert.equal(byField.title.status, 'pending', 'the edited field is queued again');
    assert.equal(byField.title.text, null, 'and its stale translation is dropped');
    assert.equal(byField.body.status, 'done', 'the untouched field is left alone');
    assert.equal(byField.body.text, 'translated');
  });

  test('editing the body leaves the title translation alone', async () => {
    const milestoneId = await makeMilestone(w.devClient, w.project.id, 'M6');
    const bug = await fileBug(w.testerClient, w.project.id,
      { milestoneId, titleVi: 'Giữ nguyên', bodyVi: 'Sửa phần này' });
    await w.db.query(
      `UPDATE bug_translations SET status = 'done', text = 'translated' WHERE bug_id = $1`,
      [bug.id]);

    await w.testerClient.patch(`/api/bugs/${bug.id}`, { bodyVi: 'Đã sửa nội dung' });
    const rows = await w.db.query(
      `SELECT field, status FROM bug_translations WHERE bug_id = $1`, [bug.id]);
    const byField = Object.fromEntries(rows.rows.map((r) => [r.field, r.status]));
    assert.equal(byField.body, 'pending');
    assert.equal(byField.title, 'done');

    // Sending the same text again is not an edit, so nothing is invalidated.
    await w.db.query(
      `UPDATE bug_translations SET status = 'done', text = 'translated' WHERE bug_id = $1`,
      [bug.id]);
    await w.testerClient.patch(`/api/bugs/${bug.id}`, { bodyVi: 'Đã sửa nội dung' });
    const again = await w.db.query(
      `SELECT status FROM bug_translations WHERE bug_id = $1 AND field = 'body'`, [bug.id]);
    assert.equal(again.rows[0].status, 'done', 'unchanged text does not requeue');
  });

  test('another tester cannot edit it, and an admin can', async () => {
    const milestoneId = await makeMilestone(w.devClient, w.project.id, 'M7');
    const bug = await fileBug(w.testerClient, w.project.id,
      { milestoneId, titleVi: 'Của tôi', bodyVi: 'Chi tiết' });

    const other = await w.devClient.patch(`/api/bugs/${bug.id}`, { titleVi: 'không phải của bạn' });
    assert.equal(other.status, 403, 'a developer did not report it');
    assert.equal(other.json.error, 'forbidden');

    const byAdmin = await w.adminClient.patch(`/api/bugs/${bug.id}`, { titleVi: 'Quản trị sửa' });
    assert.equal(byAdmin.status, 200);
  });

  test('a closed bug cannot be edited, and a bad severity is refused', async () => {
    const milestoneId = await makeMilestone(w.devClient, w.project.id, 'M8');
    const bug = await fileBug(w.testerClient, w.project.id,
      { milestoneId, titleVi: 'Sẽ đóng', bodyVi: 'Chi tiết' });

    const bad = await w.testerClient.patch(`/api/bugs/${bug.id}`, { severity: 'urgent' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'bad_severity');

    const closed = await w.devClient.post(`/api/bugs/${bug.id}/status`,
      { action: 'close', reason: 'not reproducible' });
    assert.equal(closed.status, 200, closed.text);

    const edit = await w.testerClient.patch(`/api/bugs/${bug.id}`, { titleVi: 'sửa sau khi đóng' });
    assert.equal(edit.status, 409);
    assert.equal(edit.json.error, 'bug_closed');
  });

  test('removing a bug hides it and refuses writes, and restoring brings it back', async () => {
    const milestoneId = await makeMilestone(w.devClient, w.project.id, 'M9');
    const bug = await fileBug(w.testerClient, w.project.id,
      { milestoneId, titleVi: 'Sẽ xoá', bodyVi: 'Chi tiết' });

    assert.equal((await w.testerClient.del(`/api/bugs/${bug.id}`)).status, 403,
      'a tester cannot remove evidence');
    assert.equal((await w.adminClient.del(`/api/bugs/${bug.id}`)).status, 200);

    const listed = (await w.adminClient.get(`${base()}/bugs`)).json.bugs;
    assert.equal(listed.find((b) => b.id === bug.id), undefined, 'gone from the list');
    const detail = await w.adminClient.get(`/api/bugs/${bug.id}`);
    assert.equal(detail.status, 410);
    assert.equal(detail.json.error, 'bug_removed');

    // The evidence is still in the database.
    const row = await w.db.query('SELECT deleted_at FROM bugs WHERE id = $1', [bug.id]);
    assert.ok(row.rows[0].deleted_at, 'soft: the row and its history remain');

    assert.equal((await w.adminClient.post(`/api/bugs/${bug.id}/restore`, {})).status, 200);
    assert.equal((await w.adminClient.get(`/api/bugs/${bug.id}`)).status, 200);
    const back = (await w.adminClient.get(`${base()}/bugs`)).json.bugs;
    assert.ok(back.find((b) => b.id === bug.id), 'and it is listed again');
  });

  test('every one of these acts is on the record', async () => {
    const kinds = await w.db.query(
      `SELECT kind, count(*)::int AS n FROM events
        WHERE kind IN ('project.updated','project.removed','project.restored',
                       'milestone.updated','milestone.removed','milestone.restored',
                       'bug.edited','bug.removed','bug.restored')
        GROUP BY kind ORDER BY kind`);
    const seen = Object.fromEntries(kinds.rows.map((r) => [r.kind, r.n]));
    for (const kind of ['project.updated', 'project.removed', 'project.restored',
                        'milestone.updated', 'milestone.removed', 'milestone.restored',
                        'bug.edited', 'bug.removed', 'bug.restored']) {
      assert.ok(seen[kind] > 0, `${kind} was never recorded`);
    }
  });
});
