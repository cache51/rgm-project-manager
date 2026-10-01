/**
 * Screenshots on a reply.
 *
 * A tester who says "vẫn còn lỗi" almost always has a picture of it, and until now
 * the only way to attach one was to file a new bug — so replies arrived as text and
 * the picture either never came or came as a second report. A comment can now carry
 * screenshots: uploads that belong to the same bug, referenced by id.
 *
 * The id is the whole risk: it is a bare uuid, so without a check a comment could
 * point at another bug's evidence and the timeline would show a picture that was
 * never part of this report.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProjectWorld, makeMilestone, fileBug, PNG_BYTES } from './helpers.js';

/** Upload one screenshot against a bug and return its attachment id. */
async function shot(client, bugId, filename = 'reply.png') {
  const presign = (await client.post(`/api/bugs/${bugId}/attachments/presign`,
    { contentType: 'image/png', byteSize: PNG_BYTES.length })).json;
  assert.equal((await client.put(presign.uploadUrl, PNG_BYTES)).status, 201);
  const done = await client.post(`/api/bugs/${bugId}/attachments/complete`,
    { storageKey: presign.storageKey, uploadToken: presign.uploadToken, filename });
  assert.equal(done.status, 201, done.text);
  return done.json.id;
}

const payloadOf = (row) => (typeof row === 'string' ? JSON.parse(row) : row);

describe('a reply can carry a screenshot', () => {
  test('the comment references it and the timeline hands it back', async () => {
    const w = await makeProjectWorld();
    try {
      const ms = await makeMilestone(w.adminClient, w.project.id);
      const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      const id = await shot(w.devClient, bug.id, 'still-broken.png');

      const res = await w.devClient.post(`/api/bugs/${bug.id}/comments`,
        { note: 'vẫn còn lỗi, xem ảnh', attachmentIds: [id] });
      assert.equal(res.status, 201, res.text);

      const detail = (await w.devClient.get(`/api/bugs/${bug.id}`)).json;
      const comment = detail.timeline.find((e) => e.id === res.json.id);
      assert.equal(comment.attachments.length, 1);
      assert.equal(comment.attachments[0].id, id);
      assert.equal(comment.attachments[0].originalFilename, 'still-broken.png');
      assert.equal(comment.attachments[0].url, `/api/attachments/${id}`);
      assert.match(comment.attachments[0].name, /^screenshot_\d+\.png$/,
        'named like the packet entry, so the same picture has one name everywhere');
    } finally { await w.close(); }
  });

  test("another bug's screenshot is refused, and no comment is written", async () => {
    const w = await makeProjectWorld();
    try {
      const ms = await makeMilestone(w.adminClient, w.project.id);
      const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      const other = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      const stolen = await shot(w.devClient, other.id, 'private.png');

      const res = await w.devClient.post(`/api/bugs/${bug.id}/comments`,
        { note: 'look at this', attachmentIds: [stolen] });
      assert.equal(res.status, 400);
      assert.equal(res.json.error, 'bad_attachment');

      const events = await w.db.query(
        `SELECT count(*)::int AS n FROM events
          WHERE bug_id = $1 AND kind = 'bug.commented'`, [bug.id]);
      assert.equal(events.rows[0].n, 0, 'refused before anything is written');
    } finally { await w.close(); }
  });

  test('a malformed id is a 400, not a cast error', async () => {
    const w = await makeProjectWorld();
    try {
      const ms = await makeMilestone(w.adminClient, w.project.id);
      const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      const res = await w.devClient.post(`/api/bugs/${bug.id}/comments`,
        { note: 'x', attachmentIds: ['not-a-uuid'] });
      assert.equal(res.status, 400);
      assert.equal(res.json.error, 'bad_attachment');
    } finally { await w.close(); }
  });

  test('the same screenshot twice is one picture, not two', async () => {
    const w = await makeProjectWorld();
    try {
      const ms = await makeMilestone(w.adminClient, w.project.id);
      const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      const id = await shot(w.devClient, bug.id);
      const res = await w.devClient.post(`/api/bugs/${bug.id}/comments`,
        { note: 'x', attachmentIds: [id, id] });
      assert.equal(res.status, 201);
      const ev = await w.db.query('SELECT payload FROM events WHERE id = $1', [res.json.id]);
      assert.deepEqual(payloadOf(ev.rows[0].payload).attachmentIds, [id]);
    } finally { await w.close(); }
  });

  test('a comment without screenshots carries no attachment field at all', async () => {
    const w = await makeProjectWorld();
    try {
      const ms = await makeMilestone(w.adminClient, w.project.id);
      const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      const res = await w.devClient.post(`/api/bugs/${bug.id}/comments`, { note: 'plain' });
      assert.equal(res.status, 201);

      const ev = await w.db.query('SELECT payload FROM events WHERE id = $1', [res.json.id]);
      assert.equal(payloadOf(ev.rows[0].payload).attachmentIds, undefined,
        'older readers see the payload they always saw');
      const detail = (await w.devClient.get(`/api/bugs/${bug.id}`)).json;
      assert.deepEqual(detail.timeline.find((e) => e.id === res.json.id).attachments, []);
    } finally { await w.close(); }
  });

  test('the handoff prompt says which picture came with a comment', async () => {
    // Otherwise the agent reads a list of screenshots with no idea that one of them
    // is the reply to its own question.
    const w = await makeProjectWorld();
    try {
      const ms = await makeMilestone(w.adminClient, w.project.id);
      const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      await shot(w.testerClient, bug.id, 'filed-with-the-report.png');
      const id = await shot(w.devClient, bug.id, 'reply.png');
      await w.devClient.post(`/api/bugs/${bug.id}/comments`,
        { note: 'đã sửa, xem ảnh', attachmentIds: [id] });

      const prompt = (await w.devClient.get(`/api/bugs/${bug.id}/prompt?format=json`)).json.prompt;
      const line = prompt.split('\n').find((l) => l.includes('reply.png'));
      assert.ok(line, 'the reply screenshot is listed');
      assert.match(line, /came with a comment by dev\b/,
        'named by display name, the same as the timeline');
      const filed = prompt.split('\n').find((l) => l.includes('filed-with-the-report.png'));
      assert.ok(!/came with a comment/.test(filed),
        'a report screenshot is not labelled as a reply');
    } finally { await w.close(); }
  });
});