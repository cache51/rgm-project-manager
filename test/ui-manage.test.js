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
