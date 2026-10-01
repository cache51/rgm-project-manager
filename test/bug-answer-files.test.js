/**
 * Files on an answer.
 *
 * A question can ask for a file — "please attach the Excel form you use" — and an
 * answer that cannot carry it leaves the agent waiting for something the tester has
 * no way to hand over. These tests cover the answer path and the widening of the
 * accepted types that makes it possible at all.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProjectWorld, makeMilestone, fileBug } from './helpers.js';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const BYTES = Buffer.from('504b0304140000000800', 'hex');   // the start of a real zip/xlsx

/** Upload one file against a bug and return its attachment id. */
async function upload(client, bugId, { filename = 'form.xlsx', type = XLSX, bytes = BYTES } = {}) {
  const signed = (await client.post(`/api/bugs/${bugId}/attachments/presign`,
    { contentType: type, byteSize: bytes.length })).json;
  await client.put(signed.uploadUrl, bytes, { 'content-type': type });
  const done = await client.post(`/api/bugs/${bugId}/attachments/complete`, {
    storageKey: signed.storageKey, uploadToken: signed.uploadToken,
    filename, contentType: type
  });
  assert.equal(done.status, 201, done.text);
  return done.json.id;
}

async function askQuestion(client, bugId, body = 'Please attach the Excel form you use.') {
  const res = await client.post(`/api/bugs/${bugId}/questions`, { body });
  assert.equal(res.status, 201, res.text);
  return res.json.id;
}

describe('an answer can carry a file', () => {
  test('the workbook lands on the answer and the timeline hands it back', async () => {
    const w = await makeProjectWorld();
    try {
      const ms = await makeMilestone(w.adminClient, w.project.id);
      const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      const questionId = await askQuestion(w.devClient, bug.id);
      const fileId = await upload(w.testerClient, bug.id);

      const answered = await w.testerClient.post(
        `/api/bugs/${bug.id}/questions/${questionId}/answer`,
        { answer: 'Đây là file Excel mẫu chúng tôi dùng.', attachmentIds: [fileId] });
      assert.equal(answered.status, 200, answered.text);

      const detail = (await w.testerClient.get(`/api/bugs/${bug.id}`)).json;
      const entry = detail.timeline.find((e) => e.kind === 'bug.question_answered');
      assert.equal(entry.attachments.length, 1, 'the answer shows the file it carried');
      assert.equal(entry.attachments[0].id, fileId);
      assert.equal(entry.attachments[0].originalFilename, 'form.xlsx');
      assert.equal(entry.attachments[0].name, 'file_01.xlsx',
        'named as a file, not as a screenshot — the agent reads this name in the packet');
      assert.equal(detail.questions.questions.find((q) => q.id === questionId).open, false);
    } finally { await w.close(); }
  });

  test('an answer with a foreign file changes nothing — the question stays open', async () => {
    const w = await makeProjectWorld();
    try {
      const ms = await makeMilestone(w.adminClient, w.project.id);
      const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      const other = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      const questionId = await askQuestion(w.devClient, bug.id);
      const stolen = await upload(w.testerClient, other.id, { filename: 'other.xlsx' });

      const res = await w.testerClient.post(
        `/api/bugs/${bug.id}/questions/${questionId}/answer`,
        { answer: 'see attached', attachmentIds: [stolen] });
      assert.equal(res.status, 400, res.text);
      assert.equal(res.json.error, 'bad_attachment');

      const q = (await w.testerClient.get(`/api/bugs/${bug.id}`)).json
        .questions.questions.find((x) => x.id === questionId);
      assert.equal(q.open, true, 'the refusal rolled the whole answer back');
    } finally { await w.close(); }
  });

  test('an answer without files is unchanged', async () => {
    const w = await makeProjectWorld();
    try {
      const ms = await makeMilestone(w.adminClient, w.project.id);
      const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      const questionId = await askQuestion(w.devClient, bug.id);
      const res = await w.testerClient.post(
        `/api/bugs/${bug.id}/questions/${questionId}/answer`, { answer: 'Sea.' });
      assert.equal(res.status, 200, res.text);

      const ev = await w.db.query(
        `SELECT payload FROM events WHERE bug_id = $1 AND kind = 'bug.question_answered'`,
        [bug.id]);
      const payload = typeof ev.rows[0].payload === 'string'
        ? JSON.parse(ev.rows[0].payload) : ev.rows[0].payload;
      assert.equal(payload.attachmentIds, undefined, 'no empty list is stored');
    } finally { await w.close(); }
  });
});

describe('the types a bug accepts', () => {
  test('a workbook, a PDF and a CSV are accepted', async () => {
    const w = await makeProjectWorld();
    try {
      const ms = await makeMilestone(w.adminClient, w.project.id);
      const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      for (const [type, filename] of [
        [XLSX, 'form.xlsx'],
        ['application/pdf', 'spec.pdf'],
        ['text/csv', 'export.csv'],
        ['application/vnd.ms-excel', 'legacy.xls']
      ]) {
        const id = await upload(w.devClient, bug.id, { type, filename });
        assert.ok(id, `${filename} should be accepted`);
      }
      const list = (await w.devClient.get(`/api/bugs/${bug.id}`)).json.attachments
        .map((a) => a.name);
      assert.deepEqual(list, ['file_01.xlsx', 'file_02.pdf', 'file_03.csv', 'file_04.xls'],
        'each name says what the file is');
    } finally { await w.close(); }
  });

  test('something executable is still refused', async () => {
    const w = await makeProjectWorld();
    try {
      const ms = await makeMilestone(w.adminClient, w.project.id);
      const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      const res = await w.devClient.post(`/api/bugs/${bug.id}/attachments/presign`,
        { contentType: 'application/x-msdownload', byteSize: 100 });
      assert.equal(res.status, 400);
      assert.equal(res.json.error, 'bad_type');
    } finally { await w.close(); }
  });

  test('an image keeps its screenshot name, so nothing that works today moved', async () => {
    const w = await makeProjectWorld();
    try {
      const ms = await makeMilestone(w.adminClient, w.project.id);
      const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      await upload(w.devClient, bug.id,
        { type: 'image/png', filename: 'shot.png', bytes: Buffer.from('89504e470d0a1a0a', 'hex') });
      const list = (await w.devClient.get(`/api/bugs/${bug.id}`)).json.attachments;
      assert.equal(list[0].name, 'screenshot_01.png');
    } finally { await w.close(); }
  });
});