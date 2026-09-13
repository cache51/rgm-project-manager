/**
 * Token scopes (IR-001).
 *
 * Scopes used to be checked at three call sites out of thirty-three, so a
 * `bug:read` token could change bug status and a read-only token could create
 * invitations or mint more tokens. They are now one table in `src/api.js`, and
 * this file holds two things in place: the coverage test, so a new route cannot
 * arrive unscoped, and the behaviour, so the policy is enforced rather than
 * merely declared.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeProjectWorld, makeMilestone, fileBug } from './helpers.js';
import { buildRoutes, SCOPE_POLICY, PUBLIC_ROUTES, PUBLIC, UNSPECIFIED } from '../src/api.js';

describe('token scopes: the policy covers every route', () => {
  const routes = buildRoutes().routes();
  const live = routes.map((r) => `${r.method} ${r.pattern}`);

  test('no route is left unspecified', () => {
    assert.ok(routes.length > 25, `sanity: expected the full route list, got ${routes.length}`);
    const unspecified = routes
      .filter((r) => r.scope === UNSPECIFIED)
      .map((r) => `${r.method} ${r.pattern}`);
    assert.deepEqual(unspecified, [],
      'these routes have no scope policy, and are denied at runtime');
  });

  test('the policy names no routes that no longer exist', () => {
    // A stale entry means the route that replaced it is silently uncovered.
    const known = new Set(live);
    const stale = [...Object.keys(SCOPE_POLICY), ...PUBLIC_ROUTES]
      .filter((key) => !known.has(key));
    assert.deepEqual(stale, [], 'the policy refers to routes that do not exist');
  });

  test('a route is either public or scoped, never both', () => {
    const both = routes
      .filter((r) => Object.prototype.hasOwnProperty.call(SCOPE_POLICY,
        `${r.method} ${r.pattern}`) && PUBLIC_ROUTES.has(`${r.method} ${r.pattern}`))
      .map((r) => `${r.method} ${r.pattern}`);
    assert.deepEqual(both, [], 'these routes are declared both public and scoped');
  });

  test('every scoped route names a real scope', () => {
    const allowed = new Set(['bug:read', 'bug:write', 'admin', null, PUBLIC]);
    for (const route of routes) {
      assert.ok(allowed.has(route.scope),
        `${route.method} ${route.pattern} has an unknown scope: ${route.scope}`);
    }
  });
});

describe('token scopes: a narrowed token cannot exceed them', () => {
  let w, bug;

  before(async () => {
    w = await makeProjectWorld();
    const ms = await makeMilestone(w.adminClient, w.project.id, 'M-SCOPE', 'Scope');
    bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
  });
  after(async () => { await w.close(); });

  const bearer = (token) => ({ authorization: `Bearer ${token}` });

  /** Mint a token through the real endpoint, as an admin session. */
  async function mint(scopes) {
    const res = await w.adminClient.post('/api/tokens', { name: 'test token', scopes });
    assert.equal(res.status, 201, res.text);
    return res.json.token;
  }

  test('a bug:read token can read', async () => {
    const token = await mint(['bug:read']);
    const res = await w.newClient().get(`/api/bugs/${bug.id}`, { headers: bearer(token) });
    assert.equal(res.status, 200, res.text);
  });

  test('a bug:read token cannot write', async () => {
    const token = await mint(['bug:read']);
    const res = await w.newClient().post(`/api/bugs/${bug.id}/attachments/presign`,
      { contentType: 'image/png', byteSize: 1000 }, { headers: bearer(token) });
    assert.equal(res.status, 403, res.text);
    assert.equal(res.json.error, 'insufficient_scope');
  });

  test('a bug:write token can write', async () => {
    const token = await mint(['bug:read', 'bug:write']);
    const res = await w.newClient().post(`/api/bugs/${bug.id}/attachments/presign`,
      { contentType: 'image/png', byteSize: 1000 }, { headers: bearer(token) });
    assert.equal(res.status, 201, res.text);
  });

  test('a read-only token cannot create an invitation', async () => {
    // The specific hole IR-001 named: every admin route was unscoped.
    const token = await mint(['bug:read']);
    const res = await w.newClient().post(`/api/projects/${w.project.id}/invites`,
      { email: 'smuggled@rgm.example', role: 'admin' }, { headers: bearer(token) });
    assert.equal(res.status, 403, res.text);
    assert.equal(res.json.error, 'insufficient_scope');

    const invited = await w.db.query(
      `SELECT 1 FROM invitations WHERE email = 'smuggled@rgm.example'`);
    assert.equal(invited.rows.length, 0, 'no invitation may have been created');
  });

  test('a read-only token cannot mint tokens or change a role', async () => {
    const token = await mint(['bug:read']);
    assert.equal((await w.newClient().post('/api/tokens',
      { name: 'escalation', scopes: ['admin'] }, { headers: bearer(token) })).status, 403);
    assert.equal((await w.newClient().get('/api/tokens',
      { headers: bearer(token) })).status, 403);

    const adminId = (await w.db.query(
      `SELECT id FROM users WHERE email = 'admin@rgm.example'`)).rows[0].id;
    assert.equal((await w.newClient().patch(
      `/api/projects/${w.project.id}/members/${adminId}`, { role: 'developer' },
      { headers: bearer(token) })).status, 403);
  });

  test('a bug:read token still cannot download nothing it should not', async () => {
    // The packet is a read, so bug:read is enough — but a token with no scopes
    // at all is not.
    const none = await mint([]);
    const res = await w.newClient().get(`/api/bugs/${bug.id}/packet`, { headers: bearer(none) });
    assert.equal(res.status, 403, res.text);
    assert.equal(res.json.error, 'insufficient_scope');
  });

  test('an admin token can administer', async () => {
    const token = await mint(['bug:read', 'admin']);
    const res = await w.newClient().get('/api/tokens', { headers: bearer(token) });
    assert.equal(res.status, 200, res.text);
  });

  test('a session is not scoped — the browser keeps full authority', async () => {
    // A signed-in developer has no `scopes` array; scopes narrow tokens only.
    const res = await w.devClient.post(`/api/bugs/${bug.id}/attachments/presign`,
      { contentType: 'image/png', byteSize: 1000 });
    assert.equal(res.status, 201, res.text);
  });
});
