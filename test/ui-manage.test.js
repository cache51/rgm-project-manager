/**
 * The editing and removing controls, driven as a user would.
 *
 * Two things these are really guarding:
 *
 *   - A control that would fail is not rendered. A tester is never shown "Remove
 *     project"; the API would refuse it, so offering it would be a lie.
 *   - A removal asks before it acts. Declining must send nothing at all — not a
 *     request whose result is then discarded.
 *
 * It uses the shared harness in `test/ui-harness.js` rather than its own copy: a
 * hand-rolled copy that omitted `document.cookie` made every call throw and every
 * screen render empty, which turned "this control is not shown" into a free pass.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeProjectWorld, makeMilestone, fileBug } from './helpers.js';
import { loadApp, settle } from './ui-harness.js';

describe('ui (dom): editing and removing', () => {
  let w, bug, msId, payloads, projectRoutes;

  before(async () => {
    w = await makeProjectWorld();
    msId = await makeMilestone(w.adminClient, w.project.id, 'M1', 'First cut');
    await w.adminClient.post(`/api/milestones/${msId}/status`, { action: 'start' });
    await w.adminClient.post(`/api/milestones/${msId}/status`, { action: 'ready' });
    bug = await fileBug(w.testerClient, w.project.id, { milestoneId: msId });

    payloads = {
      meDev: (await w.devClient.get('/api/me')).json,
      meTester: (await w.testerClient.get('/api/me')).json,
      projects: (await w.devClient.get('/api/projects')).json,
      milestones: (await w.devClient.get(`/api/projects/${w.project.id}/milestones`)).json,
      bugs: (await w.devClient.get(`/api/projects/${w.project.id}/bugs`)).json,
      bug: (await w.devClient.get(`/api/bugs/${bug.id}`)).json
    };

    projectRoutes = (me) => ({
      'GET /api/me': me,
      'GET /api/projects': payloads.projects,
      [`GET /api/projects/${w.project.id}/milestones`]: payloads.milestones,
      [`GET /api/projects/${w.project.id}/bugs`]: payloads.bugs,
      [`GET /api/projects/${w.project.id}/members`]: { members: [] },
      [`GET /api/bugs/${bug.id}`]: payloads.bug,
      'GET /api/projects/removed': { projects: [] },
      [`GET /api/projects/${w.project.id}/milestones/removed`]: { milestones: [] },
      [`GET /api/projects/${w.project.id}/bugs/removed`]: { bugs: [] }
    });
  });
  after(async () => { await w.close(); });

  test('a developer is offered edit and remove on a milestone', async () => {
    const app = loadApp({ routes: projectRoutes(payloads.meDev) });
    await settle();

    const html = app.html();
    assert.match(html, /data-action="renamemilestone"/);
    assert.match(html, /data-action="removemilestone"/);
  });

  test('a tester is not offered controls that would be refused', async () => {
    const app = loadApp({ routes: projectRoutes(payloads.meTester) });
    await settle();

    const html = app.html();
    assert.doesNotMatch(html, /data-action="renamemilestone"/,
      'a tester cannot rename a milestone');
    assert.doesNotMatch(html, /data-action="removemilestone"/);
    assert.doesNotMatch(html, /data-action="removeproject"/,
      'a tester cannot remove a project');
  });

  test('renaming a milestone sends the new name, and nothing when cancelled', async () => {
    const app = loadApp({ routes: projectRoutes(payloads.meDev) });
    await settle();

    // A prompt answered with nothing means the user changed their mind.
    app.promptAnswer.value = '';
    await app.click('renamemilestone', { id: msId });
    assert.equal(app.calls.filter((c) => c.method === 'PATCH').length, 0,
      'an empty name sends nothing');

    app.promptAnswer.value = '  Renamed by the test  ';
    await app.click('renamemilestone', { id: msId });
    const patch = app.calls.find((c) => c.method === 'PATCH');
    assert.ok(patch, 'the rename is sent');
    assert.equal(patch.path, `/api/milestones/${msId}`);
    assert.deepEqual(patch.body, { titleEn: 'Renamed by the test' }, 'and trimmed');
  });

  test('removing asks first, and a declined confirmation sends nothing at all', async () => {
    const app = loadApp({ routes: projectRoutes(payloads.meDev) });
    await settle();

    app.confirmAnswer.value = false;
    await app.click('removemilestone', { id: msId });
    assert.equal(app.calls.filter((c) => c.method === 'DELETE').length, 0,
      'declining must not send a request that is then discarded');

    app.confirmAnswer.value = true;
    await app.click('removemilestone', { id: msId });
    const del = app.calls.find((c) => c.method === 'DELETE');
    assert.ok(del, 'accepting sends it');
    assert.equal(del.path, `/api/milestones/${msId}`);
  });

  test('the reporter gets an editor pre-filled with what they wrote', async () => {
    // Sign in as the tester who filed it, on their own bug.
    const app = loadApp({ routes: projectRoutes(payloads.meTester) });
    await app.click('openbug', { id: bug.id });
    assert.match(app.html(), /data-action="editbug"/, 'the reporter may correct it');

    await app.click('editbug');
    const form = app.html();
    assert.match(form, /id="f-etitle"/);
    assert.match(form, /id="f-ebody"/);
    assert.match(form, /id="f-eseverity"/);
    assert.match(form, new RegExp(payloads.bug.titleVi.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'the editor starts from the current text');
  });

  test('saving the editor sends the corrected text and severity', async () => {
    const app = loadApp({ routes: projectRoutes(payloads.meTester) });
    await app.click('openbug', { id: bug.id });
    await app.click('editbug');

    app.field('f-etitle').value = 'Tiêu đề đã sửa';
    app.field('f-ebody').value = 'Nội dung đã sửa';
    app.field('f-eseverity').value = 'low';
    await app.click('savebug', { id: bug.id });

    const patch = app.calls.find((c) => c.method === 'PATCH');
    assert.ok(patch, 'the correction is sent');
    assert.equal(patch.path, `/api/bugs/${bug.id}`);
    assert.deepEqual(patch.body,
      { titleVi: 'Tiêu đề đã sửa', bodyVi: 'Nội dung đã sửa', severity: 'low' });
  });

  test('an empty title or body is refused before it is sent', async () => {
    const app = loadApp({ routes: projectRoutes(payloads.meTester) });
    await app.click('openbug', { id: bug.id });
    await app.click('editbug');

    app.field('f-etitle').value = '';
    app.field('f-ebody').value = 'Nội dung';
    await app.click('savebug', { id: bug.id });
    assert.equal(app.calls.filter((c) => c.method === 'PATCH').length, 0);
  });

  test('a closed bug offers no editor, whoever you are', async () => {
    // A closed bug describes a fix that shipped; the server refuses edits to one, so
    // the UI must not offer them either.
    const closed = { ...payloads.bug, status: 'closed' };
    const routes = { ...projectRoutes(payloads.meTester), [`GET /api/bugs/${bug.id}`]: closed };
    const app = loadApp({ routes });
    await app.click('openbug', { id: bug.id });

    assert.doesNotMatch(app.html(), /data-action="editbug"/);
  });

  test('removed rows come back with a restore control', async () => {
    const routes = {
      ...projectRoutes(payloads.meDev),
      [`GET /api/projects/${w.project.id}/milestones/removed`]: {
        milestones: [{ id: 'gone-1', code: 'M9', title_en: 'Removed one', status: 'planned' }]
      }
    };
    const app = loadApp({ routes });
    await settle();

    assert.match(app.html(), /Removed one/, 'the removed milestone is listed');
    const restore = app.html().match(/data-action="restoremilestone" data-id="([^"]+)"/);
    assert.ok(restore, 'with a way back');
    assert.equal(restore[1], 'gone-1');

    await app.click('restoremilestone', { id: 'gone-1' });
    const post = app.calls.find((c) => c.method === 'POST' && c.path.includes('/restore'));
    assert.ok(post, 'and it restores');
    assert.equal(post.path, '/api/milestones/gone-1/restore');
  });

  test('a site admin can start a second project, not only the first', async () => {
    // The create-project form lived only inside the first-run screen, which renders
    // only when you have no projects — so having one made a second impossible.
    const meAdmin = {
      ...payloads.meDev, isSiteAdmin: true,
      projects: payloads.meDev.projects.map((p) => ({ ...p, role: 'admin' }))
    };
    const created = [];
    const app = loadApp({
      routes: {
        ...projectRoutes(meAdmin),
        // A real server answers for the new project too — empty, but a 200. Without
        // these the harness falls back to `{}`, which is not a shape the API sends.
        'GET /api/projects/project-new/milestones': { milestones: [] },
        'GET /api/projects/project-new/bugs': { bugs: [], openCount: 0 },
        'POST /api/projects': (c) => {
          created.push(c);
          return { body: { id: 'project-new', name: 'Line 8 Packing' }, status: 201 };
        }
      }
    });
    await settle();

    assert.match(app.html(), /data-action="newproject"/, 'the sidebar offers it');
    await app.click('newproject');
    assert.match(app.html(), /id="f-pname"/, 'and asking for it reveals the form');

    app.field('f-pname').value = 'Line 8 Packing';
    app.field('f-penv').value = 'staging';
    await app.click('createproject');

    assert.equal(created.length, 1, 'the second project is created');
    assert.deepEqual(created[0].body, { name: 'Line 8 Packing', env: 'staging' });
  });

  test('a developer can add a second milestone, not only the first', async () => {
    const app = loadApp({ routes: projectRoutes(payloads.meDev) });
    await settle();

    // This world already has a milestone, so this is exactly the case that was a dead
    // end: the form used to render only when the list was empty.
    assert.ok(payloads.milestones.milestones.length > 0, 'the world has a milestone');
    assert.match(app.html(), /data-action="showaddms"/, 'the list offers Add milestone');
    assert.doesNotMatch(app.html(), /id="f-mscode"/,
      'and keeps the form out of the way until it is asked for');

    await app.click('showaddms');
    assert.match(app.html(), /id="f-mscode"/, 'the form appears');

    app.field('f-mscode').value = 'M2';
    app.field('f-mstitle').value = 'Second cut';
    await app.click('addmilestone');

    const post = app.calls.find((c) =>
      c.method === 'POST' && String(c.path).includes('/milestones'));
    assert.ok(post, 'the second milestone is created');
    assert.deepEqual(post.body, { code: 'M2', titleEn: 'Second cut' });
  });

  test('a tester is offered neither the milestone form nor the moves', async () => {
    // `availableActions` is computed per role by the server, so it cannot be replayed
    // from a developer's payload: the fixture has to carry what a tester would receive.
    const asTester = {
      milestones: payloads.milestones.milestones.map((m) => ({ ...m, availableActions: [] }))
    };
    const app = loadApp({
      routes: { ...projectRoutes(payloads.meTester),
                [`GET /api/projects/${w.project.id}/milestones`]: asTester }
    });
    await settle();

    assert.doesNotMatch(app.html(), /data-action="showaddms"/);
    assert.doesNotMatch(app.html(), /data-action="mstransition"/);
    assert.match(app.html(), /data-action="report"/, 'but reporting is still theirs');
  });

  test('the bug list colours each bug by its state, in the workflow colours', async () => {
    // red while the problem is there, light green when a developer says it is fixed and
    // it is waiting to be checked, green when it is done.
    const one = payloads.bugs.bugs[0];
    const four = {
      bugs: [
        { ...one, id: 'b-new', status: 'new' },
        { ...one, id: 'b-fixing', status: 'fixing' },
        { ...one, id: 'b-retest', status: 'retest' },
        { ...one, id: 'b-closed', status: 'closed' }
      ],
      openCount: 3
    };
    const app = loadApp({
      routes: { ...projectRoutes(payloads.meDev),
                [`GET /api/projects/${w.project.id}/bugs`]: four }
    });
    await settle();
    await app.click('view', { view: 'bugs' });

    const html = app.html();
    const count = (cls) => (html.match(new RegExp(`class="st ${cls}"`, 'g')) ?? []).length;
    assert.equal(count('open'), 2, 'reported and being fixed both read as "not fixed yet"');
    assert.equal(count('fixed'), 1, 'marked fixed, waiting to be verified');
    assert.equal(count('verified'), 1, 'done');
    assert.equal(count('plan'), 0, 'the old grey/indigo/amber scheme is gone');
  });

  test('the move buttons are worded as work, not as API actions', async () => {
    const fixing = {
      ...payloads.bug, status: 'fixing',
      availableActions: [{ action: 'request_retest', to: 'retest', requiresReason: false }]
    };
    const app = loadApp({
      routes: { ...projectRoutes(payloads.meDev), [`GET /api/bugs/${bug.id}`]: fixing },
      browserLang: 'en-GB'
    });
    await app.click('openbug', { id: bug.id });

    const html = app.html();
    assert.match(html, /Mark as fixed/, 'a developer reads what they are doing');
    assert.doesNotMatch(html, /request retest/, 'not the state machine\'s name for it');
  });

  test('a tester can verify or send back, in those words', async () => {
    const waiting = { ...payloads.bug, status: 'retest', availableActions: [] };
    const app = loadApp({
      routes: { ...projectRoutes(payloads.meTester), [`GET /api/bugs/${bug.id}`]: waiting },
      browserLang: 'en-GB'
    });
    await app.click('openbug', { id: bug.id });

    const html = app.html();
    assert.match(html, /Fix verified/, 'the verify control');
    assert.match(html, /Still broken — send back/, 'and the one that turns it red again');
    assert.match(html, /Fixed — awaiting verification/, 'and the state says what it wants');
  });

  test('a ready milestone offers both a bug and a feature request', async () => {
    const app = loadApp({ routes: projectRoutes(payloads.meTester), browserLang: 'en-GB' });
    await settle();

    const html = app.html();
    assert.match(html, /data-action="report"[^>]*data-kind="bug"/, 'report a bug');
    assert.match(html, /data-action="report"[^>]*data-kind="feature"/, 'or ask for a feature');
    assert.match(html, /Request feature/);
  });

  test('asking for a feature opens the form on it, and files it as one', async () => {
    const seen = [];
    const app = loadApp({
      routes: {
        ...projectRoutes(payloads.meTester),
        [`POST /api/projects/${w.project.id}/bugs`]: (c) => {
          seen.push(c);
          return { body: { id: 'r1', code: 'REQ-1', kind: 'feature' }, status: 201 };
        }
      },
      browserLang: 'en-GB'
    });
    await settle();
    await app.click('report', { ms: msId, kind: 'feature' });

    assert.match(app.html(), /<option value="feature" selected>/,
      'the form opens on what you pressed, without asking again');

    // The harness stubs getElementById, so the submit path is driven by setting the
    // fields — the assertion above is what covers the default.
    app.field('f-ms').value = msId;
    app.field('f-kind').value = 'feature';
    app.field('f-sev').value = 'medium';
    app.field('f-title').value = 'Cần thêm cột ngày giao hàng';
    app.field('f-body').value = 'Màn hình đóng gói chưa có cột này.';
    await app.click('submitreport');

    assert.equal(seen.length, 1, 'the report is filed');
    assert.equal(seen[0].body.kind, 'feature', 'as a feature request');
    assert.equal(seen[0].body.titleVi, 'Cần thêm cột ngày giao hàng');
  });

  test('a feature request is never marked "fixed"', async () => {
    const feature = {
      ...payloads.bug, kind: 'feature', status: 'fixing',
      availableActions: [{ action: 'request_retest', to: 'retest', requiresReason: false }]
    };
    const app = loadApp({
      routes: { ...projectRoutes(payloads.meDev), [`GET /api/bugs/${bug.id}`]: feature },
      browserLang: 'en-GB'
    });
    await app.click('openbug', { id: bug.id });

    const html = app.html();
    assert.match(html, /Mark as implemented/, 'the move is to implement it');
    assert.doesNotMatch(html, /Mark as fixed/, 'nothing was broken');
    assert.match(html, /Implemented — awaiting verification/, 'and so does the state');
    assert.match(html, /✨ Feature request/, 'and it says what kind of report it is');
  });

  test('a feature waiting to be checked is verified, not "fixed"', async () => {
    const waiting = { ...payloads.bug, kind: 'feature', status: 'retest', availableActions: [] };
    const app = loadApp({
      routes: { ...projectRoutes(payloads.meTester), [`GET /api/bugs/${bug.id}`]: waiting },
      browserLang: 'en-GB'
    });
    await app.click('openbug', { id: bug.id });

    const html = app.html();
    assert.match(html, /Feature verified/, 'the tester confirms the feature');
    assert.match(html, /Not done — send back/, 'or sends it back');
    assert.doesNotMatch(html, /Still broken/, 'nothing is broken');
  });

  test('the list marks which reports are requests', async () => {
    const one = payloads.bugs.bugs[0];
    const list = {
      bugs: [
        { ...one, id: 'b1', kind: 'bug', code: 'BUG-1' },
        { ...one, id: 'f1', kind: 'feature', code: 'REQ-2', title_vi: 'Cần thêm cột ngày' }
      ],
      openCount: 2
    };
    const app = loadApp({
      routes: { ...projectRoutes(payloads.meDev),
                [`GET /api/projects/${w.project.id}/bugs`]: list },
      browserLang: 'en-GB'
    });
    await settle();
    await app.click('view', { view: 'bugs' });

    const html = app.html();
    assert.match(html, /REQ-2/, 'a request keeps its own code');
    assert.match(html, /✨ Cần thêm cột ngày/, 'and is marked as one');
    assert.match(html, /🐞 /, 'while a bug is marked as a bug');
  });

  test('an admin sees change-role and remove for each member', async () => {
    const members = { members: [
      { id: 'u1', email: 'a@b.test', display_name: 'Linh', role: 'tester' },
      { id: 'u2', email: 'c@d.test', display_name: 'Wei', role: 'developer' }
    ] };
    const meAdmin = { ...payloads.meDev,
      projects: payloads.meDev.projects.map((p) => ({ ...p, role: 'admin' })) };
    const routes = {
      ...projectRoutes(meAdmin),
      [`GET /api/projects/${w.project.id}/members`]: members
    };

    const app = loadApp({ routes });
    await app.click('view', { view: 'team' });

    const html = app.html();
    assert.match(html, /data-action="removemember" data-id="u1"/);
    // A role button is only offered for a role the person does not already have.
    // \s+ because the attributes wrap across lines in the template.
    assert.match(html, /data-action="setrole" data-id="u1"\s+data-role="admin"/);
    assert.doesNotMatch(html, /data-action="setrole" data-id="u1"\s+data-role="tester"/,
      'offering the role they already have would be noise');

    await app.click('removemember', { id: 'u1' });
    const del = app.calls.find((c) => c.method === 'DELETE');
    assert.ok(del, 'removal is sent');
    assert.equal(del.path, `/api/projects/${w.project.id}/members/u1`);
  });
});
