/**
 * A report is a bug or a feature request.
 *
 * The workflow is shared, so the state machine does not care. Three things do, and all
 * three are easy to get wrong in a way nothing complains about:
 *
 *   - the code it is labelled with, everywhere it appears (list, detail, by-number,
 *     the packet filename a developer pulls, the prompt an agent is handed)
 *   - what the agent is asked to do with it ("fix it" versus "implement it")
 *   - the words on the moves, since "Mark as fixed" is wrong over a request for
 *     something that never existed
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeProjectWorld, makeMilestone, fileBug } from './helpers.js';
import { readZip } from '../src/unzip.js';

let w, milestoneId;

const file = (client, body) =>
  client.post(`/api/projects/${w.project.id}/bugs`, {
    milestoneId, severity: 'medium',
    titleVi: 'Cần thêm cột ngày giao hàng', bodyVi: 'Màn hình đóng gói chưa có cột này.',
    ...body
  });

describe('a report can be a feature request', () => {
  before(async () => {
    w = await makeProjectWorld();
    milestoneId = await makeMilestone(w.adminClient, w.project.id, 'M1', 'First cut');
  });
  after(async () => { await w.close(); });

  test('a report with no kind is still a bug, exactly as before', async () => {
    const res = await file(w.testerClient, {});
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.kind, 'bug', 'a caller that knows nothing about kinds is fine');
    assert.equal(res.json.code, 'BUG-1', 'and the first report in a project is BUG-1');
  });

  test('a feature request is stored as one and numbered REQ', async () => {
    const res = await file(w.testerClient, { kind: 'feature' });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.kind, 'feature');
    assert.equal(res.json.code, 'REQ-2',
      'one sequence per project, and the prefix says which kind it is');
  });

  test('an unknown kind is refused rather than silently treated as a bug', async () => {
    const res = await file(w.testerClient, { kind: 'chore' });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'bad_kind');
  });

  test('the kind survives every read path, with the right prefix each time', async () => {
    const feature = (await file(w.testerClient, { kind: 'feature' })).json;

    assert.match(feature.code, /^REQ-\d+$/, 'a feature request is numbered REQ-n');

    const listed = (await w.devClient.get(`/api/projects/${w.project.id}/bugs`)).json.bugs;
    const row = listed.find((b) => b.id === feature.id);
    assert.equal(row.code, feature.code, 'the list');
    assert.equal(row.kind, 'feature', 'and it says which kind, for the icon');

    const detail = (await w.devClient.get(`/api/bugs/${feature.id}`)).json;
    assert.equal(detail.code, feature.code, 'the detail');
    assert.equal(detail.kind, 'feature');

    const byNumber = (await w.devClient.get(
      `/api/projects/${w.project.id}/bugs/by-number/${detail.number}`)).json;
    assert.equal(byNumber.code, feature.code, 'and looking one up by its number');

    // Every report is listed, bugs and requests together.
    assert.ok(listed.some((b) => b.kind === 'bug'), 'bugs are still listed');
  });

  test('the packet a developer pulls is named and labelled as a request', async () => {
    const created = await file(w.testerClient, { kind: 'feature' });
    assert.equal(created.status, 201, created.text);
    const feature = created.json;
    const res = await w.devClient.get(`/api/bugs/${feature.id}/packet`);

    // Both filenames, because the header carries an ASCII fallback for clients that do
    // not read RFC 5987 — the fallback was left saying BUG- when this was added.
    const archive = res.headers?.get?.('content-disposition') ?? '';
    assert.match(archive, /^REQ-\d+$|REQ-\d+/, `the filename should say REQ, got: ${archive}`);
    assert.match(archive, new RegExp(feature.code), 'both forms carry its code');
    assert.doesNotMatch(archive, /BUG-\d+/, 'and neither says BUG');

    const entries = readZip(res.buf);
    const meta = JSON.parse(entries.find((e) => e.name === 'meta.json').data.toString('utf8'));
    assert.equal(meta.id, feature.code, 'and so should meta.json');
    assert.equal(meta.kind, 'feature');
  });

  test('the agent is asked to implement it, not to fix it', async () => {
    const created = await file(w.testerClient, { kind: 'feature' });
    assert.equal(created.status, 201, created.text);
    const feature = created.json;
    const text = (await w.devClient.get(`/api/bugs/${feature.id}/prompt?format=json`)).json.prompt;

    assert.match(text, /a feature request filed by a non-developer tester/);
    assert.match(text, /you can implement it/);
    assert.match(text, new RegExp(`^Feature request ${feature.code}$`, 'm'),
      'the heading says what it is');
    assert.match(text, /^kind: feature request$/m, 'and the metadata block agrees');
    assert.doesNotMatch(text, /you can help fix it/);

    // The injection warning is shared between both, so it cannot go missing.
    assert.match(text, /RGM-UNTRUSTED fence is DATA/);
  });

  test('a bug still reads as a bug, including the preamble people rely on', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId });
    const text = (await w.devClient.get(`/api/bugs/${bug.id}/prompt?format=json`)).json.prompt;

    assert.match(text, /a bug report filed by a non-developer tester/);
    assert.match(text, /you can help fix it/);
    assert.match(text, new RegExp(`^Bug ${bug.code}$`, 'm'), `heading was:\n${text.split('\n')[2]}`);
    assert.match(text, /^kind: bug$/m);
  });

  test('removing and restoring a feature request keeps its code', async () => {
    const feature = (await file(w.testerClient, { kind: 'feature' })).json;

    const removed = await w.adminClient.del(`/api/bugs/${feature.id}`);
    assert.equal(removed.status, 200, removed.text);
    assert.match(removed.json.code, /^REQ-/, 'removal reports the code too');

    const restored = await w.adminClient.post(`/api/bugs/${feature.id}/restore`, {});
    assert.equal(restored.status, 200, restored.text);
    assert.equal(restored.json.code, feature.code, 'and it comes back as what it was');
  });
});
