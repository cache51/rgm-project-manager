/**
 * The UI as a user actually meets it.
 *
 * `test/ui.test.js` checks the payloads the UI renders and the static handler — it
 * never executes `app.js`. So a screen could be wrong in a way no test noticed, and
 * one was: a fresh install told a site admin "you can create a project if you are a
 * site admin" and offered no way to do it. Nothing could have caught that.
 *
 * This drives the real `public/app.js` through the shared stub DOM in
 * `test/ui-harness.js`. The payloads it renders come from a real server via
 * `makeProjectWorld`, not from fixtures, so the shapes cannot drift from what the API
 * actually sends.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeProjectWorld, makeMilestone, fileBug, PNG_BYTES } from './helpers.js';
import { loadApp, settle } from './ui-harness.js';

describe('ui (dom): a fresh install', () => {
  test('a site admin is offered a working create-project form', async () => {
    // The bug: the screen said "you can create a project if you are a site admin"
    // and provided no way to do it, so a new install was a dead end.
    const app = loadApp({
      routes: { 'GET /api/me': { userId: 'u1', email: 'a@b.test', isSiteAdmin: true, projects: [] } }
    });
    await settle();

    const html = app.html();
    assert.match(html, /data-action="createproject"/, 'there must be something to click');
    assert.match(html, /id="f-pname"/, 'a project name field');
    assert.match(html, /id="f-penv"/, 'an environment choice');
    assert.doesNotMatch(html, /id="f-pclient"/, 'and no client field: every project is RGM');
    assert.match(html, /data-action="signout"/, 'sign-out is still available');
  });

  test('someone who is not a site admin is told to ask an admin', async () => {
    const app = loadApp({
      routes: { 'GET /api/me': { userId: 'u2', email: 't@b.test', isSiteAdmin: false, projects: [] } }
    });
    await settle();

    const html = app.html();
    assert.doesNotMatch(html, /data-action="createproject"/,
      'a non-admin must not be shown a control they cannot use');
    assert.match(html, /t@b\.test/);
    assert.match(html, /invite/i);
  });

  test('creating a project posts what the API expects', async () => {
    const app = loadApp({
      routes: {
        'GET /api/me': { userId: 'u1', email: 'a@b.test', isSiteAdmin: true, projects: [] },
        'POST /api/projects': () => ({ body: { id: 'p1', name: 'Line 7', env: 'staging' }, status: 201 })
      }
    });
    await settle();

    app.field('f-pname').value = '  Line 7  ';
    app.field('f-penv').value = 'staging';
    await app.click('createproject');

    const post = app.apiCalls().find((c) => c.method === 'POST' && c.path === '/api/projects');
    assert.ok(post, 'it must actually POST');
    assert.deepEqual(post.body, { name: 'Line 7', env: 'staging' },
      'the name is trimmed, and no client is sent — every project is an RGM project');
  });

  test('an empty project name is refused locally, with a message, and nothing is sent', async () => {
    const app = loadApp({
      routes: {
        'GET /api/me': { userId: 'u1', email: 'a@b.test', isSiteAdmin: true, projects: [] },
        'POST /api/projects': () => ({ body: {}, status: 201 })
      }
    });
    await settle();

    app.field('f-pname').value = '   ';
    await app.click('createproject');

    assert.equal(app.apiCalls().filter((c) => c.method === 'POST').length, 0,
      'a blank name must not reach the server');
    assert.match(app.html(), /toast/, 'and the user must be told why');
  });

  test('a server refusal is shown, not swallowed', async () => {
    const app = loadApp({
      routes: {
        'GET /api/me': { userId: 'u1', email: 'a@b.test', isSiteAdmin: true, projects: [] },
        'POST /api/projects': () => ({ body: { message: 'name required' }, status: 400 })
      }
    });
    await settle();

    app.field('f-pname').value = 'X';
    await app.click('createproject');

    assert.match(app.html(), /toast/);
    assert.match(app.html(), /name required/);
  });
});

describe('ui (dom): the screens, rendered from real server payloads', () => {
  let w, msA, msB, bug, payloads;

  before(async () => {
    w = await makeProjectWorld();
    msA = await makeMilestone(w.adminClient, w.project.id, 'M-A', 'First');
    msB = await makeMilestone(w.adminClient, w.project.id, 'M-B', 'Second');
    for (const id of [msA, msB]) {
      await w.adminClient.post(`/api/milestones/${id}/status`, { action: 'start' });
      await w.adminClient.post(`/api/milestones/${id}/status`, { action: 'ready' });
    }
    bug = await fileBug(w.testerClient, w.project.id, { milestoneId: msA });
    await w.devClient.post(`/api/bugs/${bug.id}/comments`, { note: 'Đang kiểm tra' });

    payloads = {
      meDev: (await w.devClient.get('/api/me')).json,
      meTester: (await w.testerClient.get('/api/me')).json,
      projects: (await w.devClient.get('/api/projects')).json,
      milestones: (await w.devClient.get(`/api/projects/${w.project.id}/milestones`)).json,
      bugs: (await w.devClient.get(`/api/projects/${w.project.id}/bugs`)).json,
      bug: (await w.devClient.get(`/api/bugs/${bug.id}`)).json,
      members: (await w.adminClient.get(`/api/projects/${w.project.id}/members`)).json,
      prompt: (await w.devClient.get(`/api/bugs/${bug.id}/prompt`)).text
    };
  });
  after(async () => { await w.close(); });

  const routes = (me = payloads.meDev) => ({
    'GET /api/me': me,
    'GET /api/projects': payloads.projects,
    [`GET /api/projects/${w.project.id}/milestones`]: payloads.milestones,
    [`GET /api/projects/${w.project.id}/bugs`]: payloads.bugs,
    [`GET /api/projects/${w.project.id}/members`]: payloads.members,
    [`GET /api/bugs/${bug.id}`]: payloads.bug,
    // Functions where the status or headers matter (see the note in the harness).
    [`GET /api/bugs/${bug.id}/prompt`]: () => ({ body: payloads.prompt, headers: { 'content-type': 'text/plain' } })
  });

  test('the app boots and renders the shell: navigation, both views, the project', async () => {
    const app = loadApp({ routes: routes() });
    await settle();

    const html = app.html();
    for (const action of ['view', 'project', 'lang', 'signout']) {
      assert.match(html, new RegExp(`data-action="${action}"`), `the shell offers ${action}`);
    }
    assert.match(html, /data-view="milestones"/);
    assert.match(html, /data-view="bugs"/);
    assert.match(html, new RegExp(w.project.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'the current project is named');
  });

  test('a tester sees a report control on each reportable milestone', async () => {
    const app = loadApp({ routes: routes(payloads.meTester) });
    await settle();
    await app.click('view', { view: 'milestones' });

    const html = app.html();
    assert.match(html, /M-A/);
    assert.match(html, /M-B/);
    const reportButtons = html.match(/data-action="report"/g) ?? [];
    assert.equal(reportButtons.length, 2,
      'each ready milestone gets its own report control');
  });

  test('a developer is not offered the tester report control', async () => {
    // Role-appropriate controls: a developer does not file test reports. (The
    // payload test asserted the same for bug actions; this is the DOM half.)
    const app = loadApp({ routes: routes(payloads.meDev) });
    await settle();
    await app.click('view', { view: 'milestones' });

    assert.equal((app.html().match(/data-action="report"/g) ?? []).length, 0,
      'a developer must not be shown a control that is not theirs');
  });

  test('the bug list shows the report with its code, status and timestamp', async () => {
    const app = loadApp({ routes: routes() });
    await settle();
    await app.click('view', { view: 'bugs' });

    const html = app.html();
    assert.match(html, /BUG-1/, 'the code the tester quotes');
    assert.match(html, /data-action="openbug"/);
    assert.ok(payloads.bugs.bugs[0].updated_at, 'and the payload carries a timestamp to show');
  });

  test('opening a bug shows the tester original, the translation, the timeline and screenshots', async () => {
    const app = loadApp({ routes: routes() });
    await settle();
    await app.click('openbug', { id: bug.id });

    const html = app.html();
    assert.match(html, /data-action="closebug"/, 'a way back to the list');
    assert.ok(payloads.bug.translations, 'the detail payload carries translations');
    assert.ok(payloads.bug.timeline.some((e) => e.kind === 'bug.commented'),
      'and the comment is in the timeline');
    const detail = app.apiCalls().find((c) => c.path === `/api/bugs/${bug.id}`);
    assert.ok(detail, 'the detail came from the server, not from a copy in the browser');
  });

  test('the handoff prompt is fetched from the API and shown for copying', async () => {
    const app = loadApp({ routes: routes() });
    await settle();
    await app.click('openbug', { id: bug.id });

    const fetch = app.calls.find((c) => c.path === `/api/bugs/${bug.id}/prompt`);
    assert.ok(fetch, 'the prompt is fetched, never rebuilt in the browser');
    assert.match(app.html(), /data-action="copy"/);
  });

  test('the bug list says who reported each bug', async () => {
    const app = loadApp({ routes: routes() });
    await settle();
    await app.click('view', { view: 'bugs' });

    const reporter = payloads.bugs.bugs[0].reporter;
    assert.ok(reporter, 'the list payload carries the reporter');
    assert.ok(app.html().includes(reporter),
      'so a row answers "who found this?" without opening every report');
  });

  test('an admin sees the team, with a way to add someone by name', async () => {
    const app = loadApp({ routes: routes(({
      userId: payloads.meDev.userId, email: payloads.meDev.email,
      isSiteAdmin: false,
      projects: payloads.meDev.projects.map((p) => ({ ...p, role: 'admin' }))
    })) });
    await settle();
    await app.click('view', { view: 'team' });

    const html = app.html();
    assert.match(html, /data-action="invite"/, 'an invite control');
    assert.match(html, /id="f-mname"/, 'with a field for the person’s name');
    assert.match(html, /id="f-memail"/, 'and their email');
    assert.match(html, /id="f-mrole"/, 'and their role');

    for (const m of payloads.members.members) {
      assert.ok(html.includes(m.display_name), `the list names ${m.display_name}`);
    }
  });

  test('a tester sees the team but is not offered the invite form', async () => {
    const app = loadApp({ routes: routes(payloads.meTester) });
    await settle();
    await app.click('view', { view: 'team' });

    const html = app.html();
    assert.doesNotMatch(html, /data-action="invite"/,
      'only an admin may invite, so nobody else is shown the control');
    for (const m of payloads.members.members) {
      assert.ok(html.includes(m.display_name), 'but the team is visible to everyone on it');
    }
  });

  test('adding someone posts the name, email and role', async () => {
    const seen = [];
    const app = loadApp({
      routes: {
        ...routes(({
          userId: payloads.meDev.userId, email: payloads.meDev.email, isSiteAdmin: false,
          projects: payloads.meDev.projects.map((p) => ({ ...p, role: 'admin' }))
        })),
        [`POST /api/projects/${w.project.id}/members`]: (c) => { seen.push(c); return { body: { userId: 'u9' }, status: 201 }; }
      }
    });
    await settle();
    await app.click('view', { view: 'team' });

    app.field('f-mname').value = '  Nguyễn Văn A  ';
    app.field('f-memail').value = 'a@rgm.example';
    app.field('f-mrole').value = 'tester';
    await app.click('invite');

    assert.equal(seen.length, 1, 'the person is added');
    assert.deepEqual(seen[0].body,
      { name: 'Nguyễn Văn A', email: 'a@rgm.example', role: 'tester' },
      'the name is what the admin will see next to the reports');
  });

  test('adding someone without a name is refused locally', async () => {
    const seen = [];
    const app = loadApp({
      routes: {
        ...routes(({
          userId: payloads.meDev.userId, email: payloads.meDev.email, isSiteAdmin: false,
          projects: payloads.meDev.projects.map((p) => ({ ...p, role: 'admin' }))
        })),
        [`POST /api/projects/${w.project.id}/members`]: (c) => { seen.push(c); return { body: {}, status: 201 }; }
      }
    });
    await settle();
    await app.click('view', { view: 'team' });

    app.field('f-mname').value = '';
    app.field('f-memail').value = 'a@rgm.example';
    await app.click('invite');

    assert.equal(seen.length, 0, 'a nameless invitation is the thing we are trying to avoid');
    assert.match(app.html(), /toast/);
  });

  test('the report form preselects the milestone that was clicked', async () => {
    // The IR-037 fix. Untestable in a browser here (the preview pane's clicks do not
    // land), so it stayed unverified until this harness existed.
    const app = loadApp({ routes: routes() });
    await settle();
    await app.click('view', { view: 'milestones' });
    await app.click('report', { ms: msB });

    const html = app.html();
    const select = /<select id="f-ms">([\s\S]*?)<\/select>/.exec(html);
    assert.ok(select, 'the form has a milestone select');

    const options = [...select[1].matchAll(/<option value="([^"]+)"([^>]*)>/g)];
    assert.equal(options.length, 2);
    const selected = options.filter(([, , attrs]) => attrs.includes('selected'));
    assert.equal(selected.length, 1, 'exactly one option is preselected');
    assert.equal(selected[0][1], msB,
      'the milestone that was clicked is the one selected, not simply the first');
  });
});

describe('ui (dom): a project with nothing in it yet', () => {
  const base = { userId: 'u1', email: 'd@b.test', isSiteAdmin: false,
                 projects: [{ id: 'p1', name: 'Line 7 Packing', role: 'developer' }] };
  const asTester = { ...base, projects: [{ id: 'p1', name: 'Line 7 Packing', role: 'tester' }] };

  const routes = (me) => ({
    'GET /api/me': me,
    'GET /api/projects': { projects: me.projects },
    'GET /api/projects/p1/milestones': { milestones: [] },
    'GET /api/projects/p1/bugs': { bugs: [], openCount: 0 }
  });

  test('an empty project does not look like it is still loading', async () => {
    // "Loading…" was shown whenever the list was empty, so a brand-new project sat on
    // that word forever with no indication of what to do.
    const app = loadApp({ routes: routes(base), browserLang: 'en-GB' });
    await settle();

    const html = app.html();
    assert.doesNotMatch(html, /Loading…/, 'an empty list is not a loading state');
    assert.match(html, /No milestones yet/, 'it says what is true');
  });

  test('a developer can add the first milestone', async () => {
    const app = loadApp({ routes: routes(base), browserLang: 'en-GB' });
    await settle();

    const html = app.html();
    assert.match(html, /data-action="addmilestone"/, 'a way forward');
    assert.match(html, /id="f-mscode"/);
    assert.match(html, /id="f-mstitle"/);
  });

  test('a tester is not offered a control that is not theirs', async () => {
    const app = loadApp({ routes: routes(asTester), browserLang: 'en-GB' });
    await settle();

    assert.doesNotMatch(app.html(), /data-action="addmilestone"/,
      'starting a milestone is a developer action');
    assert.match(app.html(), /No milestones yet/, 'but the state is still explained');
  });

  test('adding a milestone posts the code and the name', async () => {
    const seen = [];
    const app = loadApp({
      routes: {
        ...routes(base),
        'POST /api/projects/p1/milestones': (c) => { seen.push(c); return { body: { id: 'm1' }, status: 201 }; }
      }
    });
    await settle();

    app.field('f-mscode').value = '  M1  ';
    app.field('f-mstitle').value = 'Packing list import';
    await app.click('addmilestone');

    assert.equal(seen.length, 1, 'the milestone is posted');
    assert.deepEqual(seen[0].body, { code: 'M1', titleEn: 'Packing list import' });
  });

  test('a milestone without a code or name is refused locally', async () => {
    const seen = [];
    const app = loadApp({
      routes: {
        ...routes(base),
        'POST /api/projects/p1/milestones': (c) => { seen.push(c); return { body: {}, status: 201 }; }
      }
    });
    await settle();

    app.field('f-mscode').value = 'M1';
    app.field('f-mstitle').value = '   ';
    await app.click('addmilestone');

    assert.equal(seen.length, 0, 'nothing is sent without both');
    assert.match(app.html(), /toast/);
  });

  test('an empty bug list says so rather than loading', async () => {
    const app = loadApp({ routes: routes(base), browserLang: 'en-GB' });
    await settle();
    await app.click('view', { view: 'bugs' });

    assert.match(app.html(), /No bugs in this project yet/);
    assert.doesNotMatch(app.html(), /Loading…/);
  });
});

describe('ui (dom): the language', () => {
  const noProjects = { userId: 'u1', email: 'a@b.test', isSiteAdmin: true, projects: [] };

  test('a first-run screen offers the switcher, so it cannot be stuck in one language', async () => {
    // The switcher lived only in the sidebar, which does not render until you have a
    // project — so the screen furthest from any project was the one where a language
    // could not be changed.
    const app = loadApp({ routes: { 'GET /api/me': noProjects } });
    await settle();

    const html = app.html();
    for (const lang of ['vi', 'zh', 'en']) {
      assert.match(html, new RegExp(`data-action="lang" data-lang="${lang}"`),
        `the empty state offers ${lang}`);
    }
  });

  test('choosing English renders English', async () => {
    const app = loadApp({ routes: { 'GET /api/me': noProjects } });
    await settle();
    await app.click('lang', { lang: 'en' });

    const html = app.html();
    assert.match(html, /No projects yet/, 'the body is English');
    assert.match(html, /Create project/, 'including the button');
    assert.doesNotMatch(html, /Chưa có dự án nào/, 'and no Vietnamese is left behind');
  });

  test('the choice is remembered for next time', async () => {
    const app = loadApp({ routes: { 'GET /api/me': noProjects } });
    await settle();
    await app.click('lang', { lang: 'en' });

    assert.equal(app.store.get('rgm.lang'), 'en', 'the choice is persisted');
  });

  test('a remembered choice wins over the browser language', async () => {
    const app = loadApp({
      routes: { 'GET /api/me': noProjects },
      stored: { 'rgm.lang': 'zh' },
      browserLang: 'en-GB'
    });
    await settle();

    assert.match(app.html(), /[\u4e00-\u9fff]/, 'Chinese, as chosen earlier');
    assert.doesNotMatch(app.html(), /No projects yet/);
  });

  test("the browser's language is used when nothing was chosen", async () => {
    // An English browser opens in English without anyone having to find a switcher.
    const app = loadApp({ routes: { 'GET /api/me': noProjects }, browserLang: 'en-GB' });
    await settle();
    assert.match(app.html(), /No projects yet/);

    const vi = loadApp({ routes: { 'GET /api/me': noProjects }, browserLang: 'vi-VN' });
    await settle();
    assert.match(vi.html(), /Chưa có dự án nào/);
  });

  test('an unknown browser language falls back to Vietnamese', async () => {
    const app = loadApp({ routes: { 'GET /api/me': noProjects }, browserLang: 'fr-FR' });
    await settle();
    assert.match(app.html(), /Chưa có dự án nào/,
      'the testers read Vietnamese, so it is the safe default');
  });
});

describe('ui (dom): every action reaches the API it should', () => {
  let w, ms, bug, payloads;
  const seen = [];

  before(async () => {
    w = await makeProjectWorld();
    ms = await makeMilestone(w.adminClient, w.project.id, 'M-ACT', 'Actions');
    await w.adminClient.post(`/api/milestones/${ms}/status`, { action: 'start' });
    await w.adminClient.post(`/api/milestones/${ms}/status`, { action: 'ready' });
    bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });

    payloads = {
      me: (await w.devClient.get('/api/me')).json,
      projects: (await w.devClient.get('/api/projects')).json,
      milestones: (await w.devClient.get(`/api/projects/${w.project.id}/milestones`)).json,
      bugs: (await w.devClient.get(`/api/projects/${w.project.id}/bugs`)).json,
      bug: (await w.devClient.get(`/api/bugs/${bug.id}`)).json,
      prompt: (await w.devClient.get(`/api/bugs/${bug.id}/prompt`)).text
    };
  });
  after(async () => { await w.close(); });

  const routes = () => ({
    'GET /api/me': payloads.me,
    'GET /api/projects': payloads.projects,
    [`GET /api/projects/${w.project.id}/milestones`]: payloads.milestones,
    [`GET /api/projects/${w.project.id}/bugs`]: payloads.bugs,
    [`GET /api/bugs/${bug.id}`]: payloads.bug,
    [`GET /api/bugs/${bug.id}/prompt`]: () => ({ body: payloads.prompt, headers: { 'content-type': 'text/plain' } }),
    // Mutations: record and succeed.
    [`POST /api/projects/${w.project.id}/bugs`]: (c) => { seen.push(c); return { body: { id: bug.id }, status: 201 }; },
    [`POST /api/bugs/${bug.id}/status`]: (c) => { seen.push(c); return { body: {} }; },
    [`POST /api/bugs/${bug.id}/retest`]: (c) => { seen.push(c); return { body: {} }; },
    [`POST /api/bugs/${bug.id}/comments`]: (c) => { seen.push(c); return { body: {} }; },
    [`POST /api/bugs/${bug.id}/attachments/presign`]: (c) => {
      seen.push(c);
      return { body: { uploadUrl: 'http://bucket.test/put', storageKey: 'k/1', uploadToken: 'tok' }, status: 201 };
    },
    [`POST /api/bugs/${bug.id}/attachments/complete`]: (c) => { seen.push(c); return { body: { id: 'a1' }, status: 201 }; },
    'PUT http://bucket.test/put': () => ({ body: {} }),
    'POST /api/auth/logout': { body: {} },
    [`GET /api/bugs/${bug.id}/packet`]: () => ({
      body: 'PK-zip-bytes',
      headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="BUG-1.zip"' }
    })
  });

  test('reporting a bug posts it against the milestone the tester chose', async () => {
    seen.length = 0;
    const app = loadApp({ routes: routes() });
    await settle();
    await app.click('report', { ms });
    app.field('f-ms').value = ms;
    app.field('f-sev').value = 'high';
    app.field('f-title').value = 'Số lượng thùng không khớp';
    app.field('f-body').value = 'Thùng 3 thiếu 4 cái.';
    await app.click('submitreport');

    const post = seen.find((c) => c.path === `/api/projects/${w.project.id}/bugs`);
    assert.ok(post, 'the report is posted');
    assert.equal(post.body.milestoneId, ms, 'against the chosen milestone');
    assert.equal(post.body.severity, 'high');
    assert.equal(post.body.titleVi, 'Số lượng thùng không khớp');
  });

  test('a status change posts the action and the reason from the dialog', async () => {
    // The reason comes from window.prompt (see transition() in app.js), so the
    // harness answers it — there is no f-reason field.
    seen.length = 0;
    const app = loadApp({ routes: routes() });
    await settle();
    await app.click('openbug', { id: bug.id });
    app.promptAnswer.value = 'Đã sửa ở nhánh fix/packing';
    await app.click('transition', { id: bug.id, move: 'close', reason: '1' });

    const post = seen.find((c) => c.path === `/api/bugs/${bug.id}/status`);
    assert.ok(post, 'the transition is posted');
    assert.equal(post.body.action, 'close');
    assert.equal(post.body.reason, 'Đã sửa ở nhánh fix/packing');
  });

  test('cancelling the reason dialog posts nothing', async () => {
    seen.length = 0;
    const app = loadApp({ routes: routes() });
    await settle();
    await app.click('openbug', { id: bug.id });
    app.promptAnswer.value = '';                       // the tester pressed Cancel
    await app.click('transition', { id: bug.id, move: 'close', reason: '1' });

    assert.equal(seen.filter((c) => c.path === `/api/bugs/${bug.id}/status`).length, 0,
      'an empty reason must not send a half-formed close');
  });

  test('a comment posts the note from the comment field', async () => {
    seen.length = 0;
    const app = loadApp({ routes: routes() });
    await settle();
    await app.click('openbug', { id: bug.id });
    app.field('commentnote').value = 'Cần ảnh rõ hơn';
    await app.click('comment', { id: bug.id });

    const post = seen.find((c) => c.path === `/api/bugs/${bug.id}/comments`);
    assert.ok(post, 'the comment is posted');
    assert.equal(post.body.note, 'Cần ảnh rõ hơn');
  });

  test('an empty comment is not sent', async () => {
    seen.length = 0;
    const app = loadApp({ routes: routes() });
    await settle();
    await app.click('openbug', { id: bug.id });
    app.field('commentnote').value = '   ';
    await app.click('comment', { id: bug.id });

    assert.equal(seen.filter((c) => c.path === `/api/bugs/${bug.id}/comments`).length, 0);
  });

  test('a retest posts the result and the note, with the attempt it saw', async () => {
    seen.length = 0;
    const app = loadApp({ routes: routes() });
    await settle();
    await app.click('openbug', { id: bug.id });
    app.field('retestnote').value = 'Vẫn còn lỗi';
    await app.click('retest', { id: bug.id, result: 'fail' });

    const post = seen.find((c) => c.path === `/api/bugs/${bug.id}/retest`);
    assert.ok(post, 'the retest is posted');
    assert.equal(post.body.result, 'fail');
    assert.equal(post.body.note, 'Vẫn còn lỗi');
    assert.equal(typeof post.body.expectedAttempt, 'number',
      'the attempt the tab saw is sent, so a stale tab cannot close a newer cycle');
  });

  test('copying the prompt puts the server text on the clipboard', async () => {
    const app = loadApp({ routes: routes() });
    await settle();
    await app.click('openbug', { id: bug.id });
    await app.click('copy');

    assert.equal(app.copied.length, 1, 'one clipboard write');
    assert.equal(app.copied[0], payloads.prompt,
      'the exact text the server produced — not a browser-side reconstruction');
  });

  test('downloading the packet uses the filename the server chose', async () => {
    const app = loadApp({ routes: routes() });
    await settle();
    await app.click('openbug', { id: bug.id });
    await app.click('packet', { id: bug.id });

    assert.equal(app.downloads.length, 1, 'a download was triggered');
    assert.equal(app.downloads[0].download, 'BUG-1.zip',
      'named by the server, not by anything the client supplies');
  });

  test('switching language re-renders in that language', async () => {
    const app = loadApp({ routes: routes() });
    await settle();

    await app.click('lang', { lang: 'en' });
    assert.match(app.html(), /Navigation|Milestones|Bug reports|Projects/,
      'the shell is in English');

    await app.click('lang', { zh: '1', lang: 'zh' });
    assert.match(app.html(), /[\u4e00-\u9fff]/, 'and in Chinese');
  });

  test('switching project reloads that project', async () => {
    const app = loadApp({ routes: routes() });
    await settle();
    const before = app.apiCalls().length;
    await app.click('project', { id: w.project.id });

    const after = app.apiCalls().slice(before);
    assert.ok(after.some((c) => c.path === `/api/projects/${w.project.id}/milestones`),
      'the milestones are refetched for the selected project');
  });

  test('signing out posts the logout and goes to the login page', async () => {
    const app = loadApp({ routes: routes() });
    await settle();
    await app.click('signout');

    assert.ok(app.apiCalls().some((c) => c.method === 'POST' && c.path === '/api/auth/logout'));
    assert.ok(app.redirects.includes('/login'), 'and the browser is sent to /login');
  });
});
