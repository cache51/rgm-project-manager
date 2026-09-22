/**
 * Withdrawing a comment nobody has answered yet.
 *
 * The case this exists for: a developer posts "fixed in abc1234" on the wrong
 * commit, and until now the only correction was another comment — the wrong
 * sentence stayed on the bug and the tester worked from it. What must NOT become
 * possible is erasing a conversation: once someone replies, both halves are the
 * record, and that holds for admins too.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProjectWorld, makeMilestone, fileBug } from './helpers.js';

/** Post a comment and return its event id (what removal addresses). */
async function note(client, bugId, text) {
  const res = await client.post(`/api/bugs/${bugId}/comments`, { note: text });
  assert.equal(res.status, 201, `comment failed: ${res.text}`);
  return res.json.id;
}

const timelineIds = async (client, bugId) =>
  (await client.get(`/api/bugs/${bugId}`)).json.timeline.map((e) => e.id);

describe('a developer takes back an unanswered comment', () => {
  test('the author can withdraw their own comment, and it leaves the timeline only', async () => {
    const w = await makeProjectWorld();
    try {
      const ms = await makeMilestone(w.adminClient, w.project.id);
      const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      const id = await note(w.devClient, bug.id, 'fixed in abc1234');

      assert.ok((await timelineIds(w.devClient, bug.id)).includes(id));
      const res = await w.devClient.del(`/api/bugs/${bug.id}/comments/${id}`);
      assert.equal(res.status, 200, res.text);
      assert.ok(!(await timelineIds(w.devClient, bug.id)).includes(id),
        'a withdrawn comment is not read by anyone again');

      // Nothing is destroyed: the comment is still there, with who took it back
      // and when beside it. That is the difference between removal and erasure.
      const kept = await w.db.query('SELECT kind, payload FROM events WHERE id = $1', [id]);
      assert.equal(kept.rows.length, 1, 'the comment row survives in the append-only log');
      const removal = await w.db.query(
        'SELECT removed_by, removed_at FROM comment_removals WHERE event_id = $1', [id]);
      assert.equal(removal.rows.length, 1);
      assert.ok(removal.rows[0].removed_at, 'removal is timestamped');
      const dev = await w.db.query(`SELECT id FROM users WHERE email = 'dev@rgm.example'`);
      assert.equal(String(removal.rows[0].removed_by), String(dev.rows[0].id),
        'and attributed to whoever took it back');
    } finally { await w.close(); }
  });

  test('a comment someone has answered stays, and says who answered it', async () => {
    const w = await makeProjectWorld();
    try {
      const ms = await makeMilestone(w.adminClient, w.project.id);
      const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      const id = await note(w.devClient, bug.id, 'fixed in abc1234');
      await note(w.testerClient, bug.id, 'vẫn còn lỗi');

      const res = await w.devClient.del(`/api/bugs/${bug.id}/comments/${id}`);
      assert.equal(res.status, 409);
      assert.equal(res.json.error, 'comment_answered');
      assert.match(res.json.message, /answered by/, 'the refusal names the answer');
      assert.ok((await timelineIds(w.devClient, bug.id)).includes(id),
        'and the exchange is still readable');
    } finally { await w.close(); }
  });

  test('your own follow-up does not lock your first comment', async () => {
    // An answer has to come from someone else — the rule the question loop uses,
    // so that adding a detail does not silently make what you said permanent.
    const w = await makeProjectWorld();
    try {
      const ms = await makeMilestone(w.adminClient, w.project.id);
      const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      const first = await note(w.devClient, bug.id, 'fixed in abc1234');
      await note(w.devClient, bug.id, 'sorry — abc1250');

      const res = await w.devClient.del(`/api/bugs/${bug.id}/comments/${first}`);
      assert.equal(res.status, 200, res.text);
    } finally { await w.close(); }
  });

  test('a status change is not an answer', async () => {
    const w = await makeProjectWorld();
    try {
      const ms = await makeMilestone(w.adminClient, w.project.id);
      const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      const id = await note(w.devClient, bug.id, 'looking at the pick list');
      await w.devClient.post(`/api/bugs/${bug.id}/status`, { action: 'start_fixing' });

      const res = await w.devClient.del(`/api/bugs/${bug.id}/comments/${id}`);
      assert.equal(res.status, 200, 'only a reply locks a comment, not the clock');
    } finally { await w.close(); }
  });
});

describe('who may take a comment back', () => {
  test("a developer cannot withdraw someone else's comment", async () => {
    const w = await makeProjectWorld();
    try {
      const ms = await makeMilestone(w.adminClient, w.project.id);
      const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      const id = await note(w.testerClient, bug.id, 'máy bị kẹt');

      const res = await w.devClient.del(`/api/bugs/${bug.id}/comments/${id}`);
      assert.equal(res.status, 403);
      assert.ok((await timelineIds(w.testerClient, bug.id)).includes(id),
        "a tester's words are not a developer's to delete");
    } finally { await w.close(); }
  });

  test('an admin may clear an unanswered comment that is not theirs', async () => {
    const w = await makeProjectWorld();
    try {
      const ms = await makeMilestone(w.adminClient, w.project.id);
      const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      const id = await note(w.testerClient, bug.id, 'máy bị kẹt');

      const res = await w.adminClient.del(`/api/bugs/${bug.id}/comments/${id}`);
      assert.equal(res.status, 200, res.text);
    } finally { await w.close(); }
  });

  test('an admin cannot clear an answered one either — the reply is the record', async () => {
    const w = await makeProjectWorld();
    try {
      const ms = await makeMilestone(w.adminClient, w.project.id);
      const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      const id = await note(w.devClient, bug.id, 'fixed in abc1234');
      await note(w.testerClient, bug.id, 'vẫn còn lỗi');

      const res = await w.adminClient.del(`/api/bugs/${bug.id}/comments/${id}`);
      assert.equal(res.status, 409);
    } finally { await w.close(); }
  });

  test('a member of another project cannot reach the comment at all', async () => {
    const w = await makeProjectWorld();
    try {
      const other = await w.adminClient.post('/api/projects', { name: 'Other Board' });
      assert.equal(other.status, 201, other.text);
      const ms = await makeMilestone(w.adminClient, other.json.id);
      const bug = await fileBug(w.adminClient, other.json.id, { milestoneId: ms });
      const id = await note(w.adminClient, bug.id, 'internal note');

      const res = await w.devClient.del(`/api/bugs/${bug.id}/comments/${id}`);
      assert.equal(res.status, 403, 'authorization happens before anything is looked up');
      const still = await w.db.query(
        'SELECT 1 FROM comment_removals WHERE event_id = $1', [id]);
      assert.equal(still.rows.length, 0);
    } finally { await w.close(); }
  });
});

describe('what removal refuses to touch', () => {
  test('a non-comment event cannot be withdrawn', async () => {
    const w = await makeProjectWorld();
    try {
      const ms = await makeMilestone(w.adminClient, w.project.id);
      const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      const filed = await w.db.query(
        `SELECT id FROM events WHERE bug_id = $1 AND kind <> 'bug.commented' LIMIT 1`,
        [bug.id]);

      const res = await w.devClient.del(
        `/api/bugs/${bug.id}/comments/${filed.rows[0].id}`);
      assert.equal(res.status, 404, 'only a comment is a comment');
    } finally { await w.close(); }
  });

  test('a junk id is a 404, not a database error', async () => {
    const w = await makeProjectWorld();
    try {
      const ms = await makeMilestone(w.adminClient, w.project.id);
      const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      const res = await w.devClient.del(`/api/bugs/${bug.id}/comments/not-a-number`);
      assert.equal(res.status, 404);
    } finally { await w.close(); }
  });

  test('removing twice is a 404 the second time', async () => {
    const w = await makeProjectWorld();
    try {
      const ms = await makeMilestone(w.adminClient, w.project.id);
      const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      const id = await note(w.devClient, bug.id, 'fixed in abc1234');

      assert.equal((await w.devClient.del(`/api/bugs/${bug.id}/comments/${id}`)).status, 200);
      assert.equal((await w.devClient.del(`/api/bugs/${bug.id}/comments/${id}`)).status, 404);
    } finally { await w.close(); }
  });
});

describe('the page and the agent are told the same thing', () => {
  test('canRemove follows one rule: mine, or any, while nobody has answered it', async () => {
    const w = await makeProjectWorld();
    try {
      const ms = await makeMilestone(w.adminClient, w.project.id);
      const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      await note(w.testerClient, bug.id, 'còn thiếu 2 thùng');
      await note(w.devClient, bug.id, 'fixed in abc1234');

      const byId = async (client) => Object.fromEntries(
        (await client.get(`/api/bugs/${bug.id}`)).json.timeline.map((e) => [e.id, e.canRemove]));

      // Only the last comment can be unanswered, so the tester adds one and every
      // role looks at that same comment.
      const last = await note(w.testerClient, bug.id, 'à, tìm ra rồi');
      assert.equal((await byId(w.testerClient))[last], true, 'the author: mine, unanswered');
      assert.equal((await byId(w.devClient))[last], false, "another developer: not mine to withdraw");
      assert.equal((await byId(w.adminClient))[last], true, 'an admin may clear any unanswered one');

      // ...and the developer's own, once it is the last, is theirs to take back.
      const devNote = await note(w.devClient, bug.id, 'đã sửa ở abc1250');
      const dev = await byId(w.devClient);
      assert.equal(dev[devNote], true, 'the author again, on a fresh comment');
      assert.equal(dev[last], false, 'and the earlier one is now answered — locked for its author');
      assert.equal((await byId(w.adminClient))[last], false,
        'locked for the admin too: the reply is the record');
    } finally { await w.close(); }
  });

  test('an answered comment is locked in the page view too', async () => {
    const w = await makeProjectWorld();
    try {
      const ms = await makeMilestone(w.adminClient, w.project.id);
      const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      const id = await note(w.devClient, bug.id, 'fixed in abc1234');
      await note(w.testerClient, bug.id, 'vẫn còn lỗi');

      const seen = (await w.devClient.get(`/api/bugs/${bug.id}`)).json.timeline
        .find((e) => e.id === id);
      assert.equal(seen.canRemove, false);
    } finally { await w.close(); }
  });

  test('a withdrawn comment is gone from the agent prompt too', async () => {
    // The prompt is what a coding agent reads; leaving the withdrawn sentence in
    // it would reintroduce exactly the wrong instruction that was taken back.
    const w = await makeProjectWorld();
    try {
      const ms = await makeMilestone(w.adminClient, w.project.id);
      const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
      const id = await note(w.devClient, bug.id, 'fixed in commit DEADBEEF');

      const before = await w.devClient.get(`/api/bugs/${bug.id}/prompt?format=json`);
      assert.match(before.json.prompt, /DEADBEEF/);

      await w.devClient.del(`/api/bugs/${bug.id}/comments/${id}`);

      const after = await w.devClient.get(`/api/bugs/${bug.id}/prompt?format=json`);
      assert.doesNotMatch(after.json.prompt, /DEADBEEF/);
    } finally { await w.close(); }
  });
});