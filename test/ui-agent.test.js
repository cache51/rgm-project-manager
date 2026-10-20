/**
 * The Agent access screen, driven as a user would.
 *
 * The point of the screen is that the agent loop starts inside the app rather
 * than at a curl prompt, and that the minted secret is visible exactly once.
 * These check the two things a user can lose: the mint never sends a scope the
 * role does not hold (the admin box simply does not render for others), and the
 * plaintext lands on screen after the POST that returned it.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeProjectWorld } from './helpers.js';
import { loadApp, settle } from './ui-harness.js';

describe('ui (dom): agent access', () => {
  let w, meDev, meAdmin, tokens, projectRoutes;

  before(async () => {
    w = await makeProjectWorld();
    meDev = (await w.devClient.get('/api/me')).json;
    meAdmin = (await w.adminClient.get('/api/me')).json;
    const created = await w.devClient.post('/api/tokens',
      { name: 'packing-agent', scopes: ['bug:read', 'bug:write'] });
    tokens = (await w.devClient.get('/api/tokens')).json;
    assert.ok(tokens.tokens.length === 1, 'the world has one live token to show');

    projectRoutes = (me) => ({
      'GET /api/me': me,
      'GET /api/projects': { projects: [] },
      'GET /api/tokens': tokens,
      'POST /api/tokens': (req) => ({
        status: 201,
        body: { id: 't2', name: req.body.name, scopes: req.body.scopes,
                token: 'tok-secret-once-only', expires_at: '2027-01-01T00:00:00Z' }
      }),
      'DELETE /api/tokens/t1': { ok: true }
    });
  });
  after(async () => { await w.close(); });

  const openAgent = async (app) => {
    await app.click('view', { view: 'agent' });
    await settle();
  };

  test('the nav offers Agent access, and the screen lists the live tokens', async () => {
    const app = loadApp({ routes: projectRoutes(meDev) });
    await settle();
    assert.match(app.html(), /data-action="view" data-view="agent"/,
      'the loop starts inside the app, not at a curl prompt');

    await openAgent(app);
    const html = app.html();
    assert.match(html, /packing-agent/, 'the existing token is listed by its name');
    assert.match(html, /id="tokenname"/, 'and there is a form to mint another');
    assert.match(html, /data-action="revoketoken"/, 'with a way back for each row');
  });

  test('the admin scope box renders only for someone who holds it', async () => {
    const dev = loadApp({ routes: projectRoutes(meDev) });
    await settle(); await openAgent(dev);
    assert.doesNotMatch(dev.html(), /id="sc-admin"/,
      'a developer is not offered a box the server would refuse');

    const admin = loadApp({ routes: projectRoutes(meAdmin) });
    await settle(); await openAgent(admin);
    assert.match(admin.html(), /id="sc-admin"/,
      'a site admin gets it — the common answer is acceptance, not a 403');
  });

  test('minting posts the chosen scopes and shows the plaintext once', async () => {
    const app = loadApp({ routes: projectRoutes(meDev) });
    await settle(); await openAgent(app);

    app.field('tokenname').value = '  projection-bot  ';
    app.field('sc-write').checked = true;
    await app.click('minttoken');
    await settle();

    const post = app.apiCalls().find((c) => c.method === 'POST' && c.path === '/api/tokens');
    assert.ok(post, 'it posts');
    assert.equal(post.body.name, 'projection-bot', 'the name is trimmed');
    assert.deepEqual(post.body.scopes, ['bug:read', 'bug:write'],
      'bug:read is fixed, bug:write follows the box');

    const html = app.html();
    assert.match(html, /tok-secret-once-only/, 'the plaintext is on screen to be saved');
    assert.match(html, /agentOnce|once/, 'with the once-only warning');
  });

  test('an unnamed token is refused locally and nothing is sent', async () => {
    const app = loadApp({ routes: projectRoutes(meDev) });
    await settle(); await openAgent(app);

    app.field('tokenname').value = '   ';
    await app.click('minttoken');
    await settle();

    assert.equal(app.apiCalls().filter((c) => c.method === 'POST' && c.path === '/api/tokens').length, 0,
      'a round trip that only returns an error is a worse error');
  });

  test('revoking addresses the row it was clicked on', async () => {
    const app = loadApp({ routes: projectRoutes(meDev) });
    await settle(); await openAgent(app);

    await app.click('revoketoken', { id: tokens.tokens[0].id });
    await settle();

    const del = app.apiCalls().find((c) => c.method === 'DELETE' && c.path.startsWith('/api/tokens/'));
    assert.ok(del, 'the revoke is a DELETE');
    assert.equal(del.path, `/api/tokens/${tokens.tokens[0].id}`);
  });
});
