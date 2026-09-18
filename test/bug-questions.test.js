/**
 * Questions asked about a bug, and the answers to them.
 *
 * The handoff used to be one-way — a prompt out, work back — so whoever was
 * fixing a report had nowhere to go when it did not add up. A question is
 * mailed to the people who can answer it (the reporter, and the bug's own
 * address list) and stays open until one of them answers, which is what makes
 * "the agent is blocked on us" visible.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeProjectWorld, makeMilestone, fileBug } from './helpers.js';
import { runOutbox, RecordingSender } from '../src/notify.js';

describe('a bug carries the questions asked about it', () => {
  let w, ms;

  before(async () => {
    w = await makeProjectWorld();
    ms = await makeMilestone(w.adminClient, w.project.id, 'M-1', 'First');
    for (const action of ['start', 'ready']) {
      await w.adminClient.post(`/api/milestones/${ms}/status`, { action });
    }
    // Drain the milestone readiness notice so every test starts from an empty
    // outbox (otherwise assertions depend on which test runs first).
    await runOutbox(w.db, RecordingSender(), { workerId: randomUUID() });
  });
  after(async () => { await w.close(); });

  const ask = (client, bugId, body) => client.post(`/api/bugs/${bugId}/questions`, { body });
  const answer = (client, bugId, qid, text) =>
    client.post(`/api/bugs/${bugId}/questions/${qid}/answer`, { answer: text });
  const detail = async (bugId) => (await w.devClient.get(`/api/bugs/${bugId}`)).json;
  const drain = async (questionId) => {
    const sender = RecordingSender();
    await runOutbox(w.db, sender, { workerId: randomUUID(), baseUrl: 'http://app.test' });
    // Only this question's notices: another test may have left one queued, and a
    // drain that picks it up would make this assertion depend on file position.
    return sender.sent.filter((m) => m.kind === 'bug.question'
      && String(m.dedupeKey).includes(questionId));
  };

  test('a question is stored, attributed, and open', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    const res = await ask(w.devClient, bug.id,
      'Which warehouse is NV311-AW22 received into — the supplier one or QC?');
    assert.equal(res.status, 201, res.text);
    assert.ok(res.json.id, 'the question has an identity');
    assert.ok(res.json.askedAt, 'and a timestamp');

    const d = await detail(bug.id);
    assert.equal(d.questions.open, 1);
    const q = d.questions.questions[0];
    assert.match(q.body, /Which warehouse/);
    assert.match(String(q.askedBy), /dev/i, 'attributed to whoever asked');
    assert.equal(q.open, true);
    assert.equal(q.answer, null, 'nothing is invented as an answer');
  });

  test('asking mails the reporter and the bug\'s addresses, each exactly once', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    await w.devClient.post(`/api/bugs/${bug.id}/watchers`, { email: 'krixi@rgmdn.com' });
    // The reporter's own address on the list must not mean two copies.
    await w.devClient.post(`/api/bugs/${bug.id}/watchers`, { email: 'tester@rgm.example' });

    const res = await ask(w.devClient, bug.id, 'Where do I see the packing list?');
    assert.equal(res.json.notified.queued, 2, 'reporter + the one other address');

    const mail = await drain(res.json.id);
    assert.deepEqual(mail.map((m) => m.to).sort(),
      ['krixi@rgmdn.com', 'tester@rgm.example']);

    const msg = mail[0];
    assert.match(msg.subject, /cần bạn làm rõ/, 'the subject says what is wanted');
    assert.match(msg.body, /Where do I see the packing list\?/, 'the question itself is in the mail');
    assert.match(msg.body, new RegExp(bug.code), 'and the bug it is about');
    assert.match(msg.body, /http:\/\/app\.test/, 'with a way back into the app');
  });

  test('any member can answer, and the question stops being open', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    const asked = await ask(w.devClient, bug.id, 'Which screen shows the lot?');
    // The tester filed it, so the tester is who knows.
    const answered = await answer(w.testerClient, bug.id, asked.json.id,
      'The receiving screen — second tab.');
    assert.equal(answered.status, 200, answered.text);
    assert.ok(answered.json.answeredAt);

    const d = await detail(bug.id);
    assert.equal(d.questions.open, 0);
    const q = d.questions.questions[0];
    assert.equal(q.open, false);
    assert.match(q.answer.text, /second tab/);
    assert.match(String(q.answer.by), /tester/i, 'and the answer names who gave it');
  });

  test('a second answer is refused instead of overwriting the first', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    const asked = await ask(w.devClient, bug.id, 'Is this the same as BUG-2?');
    await answer(w.testerClient, bug.id, asked.json.id, 'No — different lot.');

    const again = await answer(w.devClient, bug.id, asked.json.id, 'Actually it is.');
    assert.equal(again.status, 409, again.text);
    assert.match((await detail(bug.id)).questions.questions[0].answer.text, /different lot/);
  });

  test('an empty question or answer is refused', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    assert.equal((await ask(w.devClient, bug.id, '   ')).status, 400);
    const asked = await ask(w.devClient, bug.id, 'Anything?');
    assert.equal((await answer(w.testerClient, bug.id, asked.json.id, '  ')).status, 400);
  });

  test('the bug list says which bug is waiting on an answer', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    const rowOf = async () => (await w.devClient.get(`/api/projects/${w.project.id}/bugs`))
      .json.bugs.find((b) => b.id === bug.id);

    assert.equal((await rowOf()).openQuestions, 0);

    const asked = await ask(w.devClient, bug.id, 'Need the exact screen name.');
    assert.equal((await rowOf()).openQuestions, 1, 'the list shows the question is waiting');

    await answer(w.testerClient, bug.id, asked.json.id, 'Packing list detail.');
    assert.equal((await rowOf()).openQuestions, 0, 'and clears when it is answered');
  });

  test('the timeline records the asking and the answering', async () => {
    const bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    const asked = await ask(w.devClient, bug.id, 'Which unit is the carton count in?');
    await answer(w.testerClient, bug.id, asked.json.id, 'Cartons, not pieces.');

    const kinds = (await detail(bug.id)).timeline.map((e) => e.kind);
    assert.ok(kinds.includes('bug.question'), 'the question is in the history');
    assert.ok(kinds.includes('bug.question_answered'), 'so is the answer');
  });

  test('a question cannot be asked on a bug in a project you are not in', async () => {
    const other = await makeProjectWorld();
    try {
      const otherMs = await makeMilestone(other.adminClient, other.project.id, 'M-1', 'First');
      const theirs = await fileBug(other.testerClient, other.project.id, { milestoneId: otherMs });
      const res = await ask(w.devClient, theirs.id, 'let me in');
      assert.ok(res.status === 403 || res.status === 404,
        `expected the outsider to be refused, got ${res.status}`);
    } finally { await other.close(); }
  });
});