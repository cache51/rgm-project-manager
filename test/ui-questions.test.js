/**
 * A question waiting for the person reading the app, shown where they look.
 *
 * On 6 Oct the developer on rgm-leave-app said the tester would not know a question
 * was waiting for her. The list did carry a small "chờ trả lời" tag, but it did not
 * say whose answer was wanted, and the status beside it said something else: a
 * question on a report already in retest looked exactly like a report waiting to be
 * verified. And the app opens on the milestones, where nothing was said at all.
 *
 * The payloads come from a real server, fetched as the tester and as the developer,
 * so the field the screen reads is the field the API sends.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeProjectWorld, makeMilestone, fileBug } from './helpers.js';
import { loadApp, settle } from './ui-harness.js';

/** One list row, from its opening tag to the next row's. */
function rowFor(html, id) {
  const start = html.indexOf(`data-action="openbug" data-id="${id}"`);
  assert.ok(start > -1, `no row for ${id}`);
  const end = html.indexOf('data-action="openbug"', start + 1);
  return html.slice(start, end === -1 ? undefined : end);
}

/** The inside of the sidebar's "bug list" item. */
function navToBugs(html) {
  const m = html.match(/data-action="view" data-view="bugs">([\s\S]*?)<\/div>/);
  assert.ok(m, 'no bug-list item in the sidebar');
  return m[1];
}

/** The inside of one project's row in the sidebar. */
function projectRow(html, projectId) {
  const m = html.match(new RegExp(`data-action="project" data-id="${projectId}">([\\s\\S]*?)</div>`));
  assert.ok(m, `no sidebar row for ${projectId}`);
  return m[1];
}

describe('ui (dom): a question waiting for the reader', () => {
  let w, ms, waiting, newer, asked, payloads;

  before(async () => {
    w = await makeProjectWorld();
    ms = await makeMilestone(w.adminClient, w.project.id, 'M-1', 'First');
    for (const action of ['start', 'ready']) {
      await w.adminClient.post(`/api/milestones/${ms}/status`, { action });
    }
    // The case that was reported: a report already marked fixed, then a question on it.
    waiting = await fileBug(w.testerClient, w.project.id,
      { milestoneId: ms, titleVi: 'Sai số lượng thùng' });
    for (const action of ['start_fixing', 'request_retest']) {
      await w.devClient.post(`/api/bugs/${waiting.id}/status`, { action });
    }
    // A newer report nobody has asked about: the server lists it first.
    newer = await fileBug(w.testerClient, w.project.id,
      { milestoneId: ms, titleVi: 'Nút in bị mờ' });
    asked = (await w.devClient.post(`/api/bugs/${waiting.id}/questions`,
      { body: 'Bạn nhập bằng file Excel hay nhập tay?' })).json;

    const get = async (client, path) => (await client.get(path)).json;
    const list = `/api/projects/${w.project.id}/bugs`;
    payloads = {
      meTester: await get(w.testerClient, '/api/me'),
      meDev: await get(w.devClient, '/api/me'),
      projects: await get(w.testerClient, '/api/projects'),
      milestones: await get(w.testerClient, `/api/projects/${w.project.id}/milestones`),
      testerList: await get(w.testerClient, list),
      devList: await get(w.devClient, list),
      testerDetail: await get(w.testerClient, `/api/bugs/${waiting.id}`),
      devDetail: await get(w.devClient, `/api/bugs/${waiting.id}`)
    };
    // And the same screens once she has answered.
    await w.testerClient.post(`/api/bugs/${waiting.id}/questions/${asked.id}/answer`,
      { answer: 'Nhập bằng file Excel.' });
    payloads.testerListAnswered = await get(w.testerClient, list);
    payloads.testerDetailAnswered = await get(w.testerClient, `/api/bugs/${waiting.id}`);
  });
  after(async () => { await w.close(); });

  const routes = ({ me = payloads.meTester, list = payloads.testerList,
                    detail = payloads.testerDetail } = {}) => ({
    'GET /api/me': me,
    'GET /api/projects': payloads.projects,
    [`GET /api/projects/${w.project.id}/milestones`]: payloads.milestones,
    [`GET /api/projects/${w.project.id}/bugs`]: list,
    [`GET /api/bugs/${waiting.id}`]: detail,
    [`GET /api/bugs/${waiting.id}/prompt`]: () =>
      ({ body: 'prompt', headers: { 'content-type': 'text/plain' } })
  });

  test('the reporter is told the question is hers, in words that say so', async () => {
    const app = loadApp({ routes: routes() });
    await settle();
    await app.click('view', { view: 'bugs' });

    const row = rowFor(app.html(), waiting.id);
    assert.match(row, /Câu hỏi chờ bạn trả lời/);
    assert.doesNotMatch(row, />💬 chờ trả lời</,
      'not the old tag as well — it never said whose answer was wanted');
    assert.match(row, /Đã sửa — chờ xác nhận/, 'the status is still shown as it is');
    assert.doesNotMatch(rowFor(app.html(), newer.id), /Câu hỏi chờ bạn trả lời/,
      'and only on the report that has one');
  });

  test('it says the same in English', async () => {
    const app = loadApp({ routes: routes(), browserLang: 'en-GB' });
    await settle();
    await app.click('view', { view: 'bugs' });

    assert.match(rowFor(app.html(), waiting.id), /Question for you/);
  });

  test('the report waiting for her is listed first, above newer ones', async () => {
    assert.equal(payloads.testerList.bugs[0].id, newer.id,
      'the server still sends the newest first — the order is the screen\'s');
    const app = loadApp({ routes: routes() });
    await settle();
    await app.click('view', { view: 'bugs' });

    const html = app.html();
    assert.ok(html.indexOf(`data-id="${waiting.id}"`) < html.indexOf(`data-id="${newer.id}"`));
  });

  test('the developer who asked sees an answer is pending, not a question for them', async () => {
    const app = loadApp({ routes: routes({ me: payloads.meDev, list: payloads.devList }) });
    await settle();

    assert.doesNotMatch(app.html(), /data-action="questionsforyou"/,
      'nothing on the first screen says they are being asked');
    await app.click('view', { view: 'bugs' });
    const html = app.html();
    assert.match(rowFor(html, waiting.id), />💬 chờ trả lời</);
    assert.doesNotMatch(html, /Câu hỏi chờ bạn trả lời/);
    assert.ok(html.indexOf(`data-id="${newer.id}"`) < html.indexOf(`data-id="${waiting.id}"`),
      'and their list keeps its order');
  });

  test('the screen she lands on says a question is waiting, and where', async () => {
    const app = loadApp({ routes: routes() });
    await settle();   // the app opens on the milestones

    const html = app.html();
    assert.match(html, /data-action="questionsforyou"[^>]*>[\s\S]*?Câu hỏi chờ bạn trả lời: 1/);
    assert.match(navToBugs(html), /💬 1/, 'the sidebar\'s bug list counts it');
    assert.match(projectRow(html, w.project.id), /💬 1/,
      'and so does the project, for a tester who works on several');
    // A bare "💬 1" is a number to a screen reader; the words go with it.
    assert.match(navToBugs(html), /class="vh"[^>]*>[^<]*Câu hỏi chờ bạn trả lời/);
    assert.match(projectRow(html, w.project.id), /class="vh"[^>]*>[^<]*Câu hỏi chờ bạn trả lời/);
  });

  test('that hint opens the list narrowed to her questions, one click from everything', async () => {
    const app = loadApp({ routes: routes() });
    await settle();
    await app.click('questionsforyou');

    let html = app.html();
    assert.match(html, new RegExp(`data-id="${waiting.id}"`));
    assert.doesNotMatch(html, new RegExp(`data-id="${newer.id}"`), 'only what is waiting for her');
    assert.match(html, /class="chip on"[^>]*data-filter="forYou"/, 'and the filter says it is on');
    assert.match(html, /<button[^>]*aria-pressed="true"[^>]*data-filter="forYou"/,
      'to a screen reader as well as by its colour');
    // The harness hands a click its dataset, so the markup has to be checked to
    // know the button really carries what the click below pretends it does.
    assert.match(html, /<button[^>]*aria-pressed="false"[^>]*data-action="bugfilter"\s+data-filter="all"/);

    await app.click('bugfilter', { filter: 'all' });
    assert.match(app.html(), new RegExp(`data-id="${newer.id}"`), 'everything again');

    await app.click('bugfilter', { filter: 'forYou' });
    await app.click('view', { view: 'milestones' });
    await app.click('view', { view: 'bugs' });
    html = app.html();
    assert.match(html, new RegExp(`data-id="${newer.id}"`),
      'leaving the list drops the filter, so it is never stuck narrowed');
  });

  test('a report filed from the narrowed list is not hidden by it', async () => {
    const app = loadApp({ routes: {
      ...routes(),
      [`POST /api/projects/${w.project.id}/bugs`]: () =>
        ({ status: 201, body: { id: 'b-new', code: 'BUG-9', kind: 'bug' } })
    } });
    await settle();
    await app.click('questionsforyou');
    await app.click('report', { ms, kind: 'bug' });
    app.field('f-ms').value = ms;
    app.field('f-sev').value = 'low';
    app.field('f-title').value = 'Chữ trên nhãn bị cắt';
    app.field('f-body').value = 'Nhãn thùng 5 mất chữ cuối.';
    await app.click('submitreport');

    // Her new report has no question, so a list still narrowed would show her a
    // "saved" notice and no report. Filing it lands on the whole list.
    assert.match(app.html(), new RegExp(`data-id="${newer.id}"`));
  });

  test('a list once narrowed does not narrow itself again on a later question', async () => {
    let answered = false;
    const app = loadApp({ routes: {
      ...routes(),
      [`GET /api/projects/${w.project.id}/bugs`]: () =>
        ({ body: answered ? payloads.testerListAnswered : payloads.testerList }),
      [`GET /api/bugs/${waiting.id}`]: () =>
        ({ body: answered ? payloads.testerDetailAnswered : payloads.testerDetail })
    } });
    await settle();
    await app.click('questionsforyou');
    answered = true;              // answered elsewhere — in another tab, or by a comment
    await app.click('openbug', { id: waiting.id });
    await app.click('closebug');
    answered = false;             // and later a new question arrives
    await app.click('openbug', { id: waiting.id });
    await app.click('closebug');

    assert.match(app.html(), new RegExp(`data-id="${newer.id}"`),
      'she did not ask to narrow it this time');
  });

  test('the developer finds the question where it always was, not dressed as theirs', async () => {
    const app = loadApp({ routes: routes({ me: payloads.meDev, list: payloads.devList,
                                           detail: payloads.devDetail }) });
    await settle();
    await app.click('openbug', { id: waiting.id });

    const html = app.html();
    assert.ok(html.indexOf(`id="answer-${asked.id}"`) > html.indexOf('id="commentnote"'),
      'amber at the top means "you are being asked"; the asker is not');
    assert.doesNotMatch(html, /class="card ask"/);
  });

  test('opening the report puts the question above the verify buttons', async () => {
    const app = loadApp({ routes: routes() });
    await settle();
    await app.click('openbug', { id: waiting.id });

    const html = app.html();
    const question = html.indexOf(`id="answer-${asked.id}"`);
    const verify = html.indexOf('data-action="retest"');
    assert.ok(question > -1, 'the question can be answered here');
    assert.ok(verify > -1, 'and the report is waiting to be verified');
    assert.ok(question < verify,
      'she reads the question before she is offered "verified", not after the timeline');
  });

  test('once she has answered, nothing says she is being asked', async () => {
    let answered = false;
    const app = loadApp({ routes: {
      ...routes(),
      [`GET /api/projects/${w.project.id}/bugs`]: () =>
        ({ body: answered ? payloads.testerListAnswered : payloads.testerList }),
      [`GET /api/bugs/${waiting.id}`]: () =>
        ({ body: answered ? payloads.testerDetailAnswered : payloads.testerDetail }),
      [`POST /api/bugs/${waiting.id}/questions/${asked.id}/answer`]: () => {
        answered = true;
        return { body: { id: asked.id } };
      }
    } });
    await settle();
    await app.click('questionsforyou');
    await app.click('openbug', { id: waiting.id });

    app.input(`answer-${asked.id}`, 'Nhập bằng file Excel.');
    await app.click('answerquestion', { id: waiting.id, qid: asked.id });
    assert.doesNotMatch(navToBugs(app.html()), /💬/,
      'the sidebar is cleared by the answer, not by the next visit to the list');

    await app.click('closebug');
    const html = app.html();
    assert.match(html, new RegExp(`data-id="${newer.id}"`),
      'the narrowed list does not leave an empty screen behind');
    assert.doesNotMatch(html, /Câu hỏi chờ bạn trả lời/);
    assert.doesNotMatch(html, /data-action="bugfilter"/, 'and there is nothing left to filter');
  });
});
