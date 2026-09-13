/**
 * Authentication, session and authorization behaviour, exercised over HTTP.
 * These are the paths where a mistake is a security bug rather than a bug.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeProjectWorld, makeMilestone } from './helpers.js';
import { hashToken } from '../src/auth.js';

describe('auth: login', () => {
  let w;
  before(async () => { w = await makeProjectWorld(); });
  after(async () => { await w.close(); });

  test('the server is up', async () => {
    const res = await w.newClient().get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  });

  test('an unknown address gets the same response as a known one (no enumeration)', async () => {
    const unknown = await w.newClient().post('/api/auth/request-link', { email: 'nobody@x.example' });
    const known = await w.newClient().post('/api/auth/request-link', { email: 'admin@rgm.example' });
    assert.equal(unknown.status, 200);
    assert.equal(known.status, 200);
    assert.deepEqual(unknown.json, known.json);
  });

  test('a login link is single-use', async () => {
    const client = w.newClient();
    await w.db.query('DELETE FROM login_tokens');
    const before = w.mails.length;
    await w.newClient().post('/api/auth/request-link', { email: 'admin@rgm.example' });
    const token = w.mails.slice(before)[0].token;

    assert.equal((await client.post('/api/auth/consume', { token })).status, 200);
    const second = await w.newClient().post('/api/auth/consume', { token });
    assert.equal(second.status, 400);
    assert.equal(second.json.error, 'bad_token');
  });

  test('an expired login link is refused', async () => {
    const raw = 'expired-token-value';
    await w.db.query(
      `INSERT INTO login_tokens (user_id, token_hash, expires_at)
       SELECT id, $1, now() - interval '1 minute' FROM users WHERE email = 'admin@rgm.example'`,
      [hashToken(raw)]);
    const res = await w.newClient().post('/api/auth/consume', { token: raw });
    assert.equal(res.status, 400);
  });

  test('/api/me requires a session', async () => {
    assert.equal((await w.newClient().get('/api/me')).status, 401);
  });

  test('a session resolves to the signed-in user, and logout revokes it', async () => {
    const client = await w.loginAs('admin@rgm.example');
    const me = await client.get('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.email, 'admin@rgm.example');
    assert.equal(me.json.via, 'session');

    assert.equal((await client.post('/api/auth/logout')).status, 200);
    const after = await client.get('/api/me');
    assert.equal(after.status, 401);
  });

  test('the session cookie is opaque and revoking the row invalidates the cookie', async () => {
    const client = await w.loginAs('admin@rgm.example');
    assert.equal((await client.get('/api/me')).status, 200);

    const token = decodeURIComponent(client.cookie.split('=')[1]);
    // The database stores only a hash, never the cookie value itself.
    const stored = await w.db.query('SELECT token_hash FROM sessions WHERE token_hash = $1',
      [hashToken(token)]);
    assert.equal(stored.rows.length, 1);
    const plain = await w.db.query('SELECT 1 FROM sessions WHERE token_hash = $1', [token]);
    assert.equal(plain.rows.length, 0);

    await w.db.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1',
      [hashToken(token)]);
    assert.equal((await client.get('/api/me')).status, 401);
  });
});

describe('auth: authorization', () => {
  let w;
  before(async () => { w = await makeProjectWorld(); });
  after(async () => { await w.close(); });

  test('a member of one project cannot read another project (cross-project isolation)', async () => {
    // The outsider is a legitimate, signed-in user — but of a DIFFERENT project.
    // This is the RGM-001 concern: a valid account must not reach unrelated data.
    const otherId = (await w.db.query(
      `INSERT INTO projects (name, client) VALUES ('Other Site','ACME') RETURNING id`)).rows[0].id;
    await w.db.query('INSERT INTO project_counters (project_id) VALUES ($1)', [otherId]);

    const token = await w.invite({ projectId: otherId, email: 'outsider@x.example',
                                   role: 'tester', createdBy: w.admin.userId });
    await w.redeem(token);
    const client = await w.loginAs('outsider@x.example');

    const foreign = await client.get(`/api/projects/${w.project.id}/bugs`);
    assert.equal(foreign.status, 403);
    assert.equal(foreign.json.error, 'not_a_member');

    // Their own project is reachable, so the 403 above is isolation, not breakage.
    assert.equal((await client.get(`/api/projects/${otherId}/bugs`)).status, 200);
    assert.equal((await client.get(`/api/projects/${otherId}/members`)).status, 200);
  });

  test('a site admin with no membership still cannot read project data', async () => {
    // Bootstrap authority is not the same as project membership: the admin is
    // not a member of a second project until invited.
    const other = await w.db.query(
      `INSERT INTO projects (name, client) VALUES ('Other','ACME') RETURNING id`);
    const res = await w.adminClient.get(`/api/projects/${other.rows[0].id}/bugs`);
    assert.equal(res.status, 403);
  });

  test('only a site admin may create a project', async () => {
    assert.equal((await w.devClient.post('/api/projects',
      { name: 'Nope', client: 'X' })).status, 403);
    assert.equal((await w.adminClient.post('/api/projects',
      { name: 'Yes', client: 'X' })).status, 201);
  });

  test('a tester may file a bug but not create a milestone', async () => {
    const ms = await makeMilestone(w.adminClient, w.project.id, 'M-AUTH', 'Auth');
    const filed = await w.testerClient.post(`/api/projects/${w.project.id}/bugs`,
      { milestoneId: ms, severity: 'low', titleVi: 'x', bodyVi: 'y' });
    assert.equal(filed.status, 201);

    const milestone = await w.testerClient.post(`/api/projects/${w.project.id}/milestones`,
      { code: 'M-NO', titleEn: 'Nope' });
    assert.equal(milestone.status, 403);
  });

  test('only an admin may invite', async () => {
    assert.equal((await w.devClient.post(`/api/projects/${w.project.id}/invites`,
      { email: 'x@y.example', role: 'tester' })).status, 403);
    assert.equal((await w.testerClient.post(`/api/projects/${w.project.id}/invites`,
      { email: 'x@y.example', role: 'tester' })).status, 403);
    assert.equal((await w.adminClient.post(`/api/projects/${w.project.id}/invites`,
      { email: 'ok@y.example', role: 'tester' })).status, 201);
  });

  test('an invite cannot grant an unknown role', async () => {
    const res = await w.adminClient.post(`/api/projects/${w.project.id}/invites`,
      { email: 'z@y.example', role: 'superuser' });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'bad_role');
  });

  test('a demoted admin cannot restore their role with an old invitation', async () => {
    // IR-005: the role change left outstanding invitations alone, and redemption
    // restores the invited role — so a downgraded admin could redeem an
    // invitation issued while they were an admin and become one again.
    //
    // Its own world: this adds a second admin, and the last-admin test below
    // depends on there being exactly one.
    const w2 = await makeProjectWorld();
    try {
      // A second admin, so the project is not down to its last one.
      const second = await w2.invite({ projectId: w2.project.id,
        email: 'climber@rgm.example', role: 'admin', createdBy: w2.admin.userId });
      const secondId = (await w2.redeem(second)).userId;

      const third = 'stale@rgm.example';
      const first = await w2.invite({ projectId: w2.project.id, email: third,
        role: 'admin', createdBy: w2.admin.userId });
      const thirdId = (await w2.redeem(first)).userId;

      // A fresh admin invitation, left live, then they are demoted while holding it.
      const live = await w2.invite({ projectId: w2.project.id, email: third,
        role: 'admin', createdBy: w2.admin.userId });
      const demoted = await w2.adminClient.patch(
        `/api/projects/${w2.project.id}/members/${thirdId}`, { role: 'tester' });
      assert.equal(demoted.status, 200, demoted.text);
      assert.equal(demoted.json.role, 'tester');

      // The invitation issued while they were an admin is revoked by the change...
      // (A consumed invitation keeps revoked_at null — only the live one matters.)
      const liveRows = await w2.db.query(
        `SELECT revoked_at FROM invitations WHERE email = $1 AND consumed_at IS NULL`,
        [third]);
      assert.ok(liveRows.rows.length > 0, 'an unconsumed invitation exists');
      assert.ok(liveRows.rows.every(r => r.revoked_at !== null),
        'the live invitation must be revoked by the demotion');

      // ...so redeeming it cannot hand the admin role back.
      await assert.rejects(() => w2.redeem(live), /invit/i);
      const after = await w2.db.query(
        `SELECT role FROM active_memberships WHERE project_id = $1 AND user_id = $2`,
        [w2.project.id, thirdId]);
      assert.equal(after.rows[0].role, 'tester',
        'the demotion must stick; the invitation must not restore admin');

      // The project kept an admin.
      const still = await w2.db.query(
        `SELECT role FROM active_memberships WHERE project_id = $1 AND user_id = $2`,
        [w2.project.id, secondId]);
      assert.equal(still.rows[0].role, 'admin');
    } finally {
      await w2.close();
    }
  });

  test('an expired invitation does not block a replacement', async () => {
    // IR-016: the live-invitation index cannot exclude by expiry (`now()` is not
    // immutable), so an invitation nobody redeemed kept the next one un-issuable
    // for that address for ever.
    const email = 'lapsed@rgm.example';
    await w.db.query(
      `INSERT INTO invitations (project_id, email, role, token_hash, expires_at, created_by)
       VALUES ($1, $2, 'tester', 'stale-hash', now() - interval '1 hour', $3)`,
      [w.project.id, email, w.admin.userId]);

    const res = await w.adminClient.post(`/api/projects/${w.project.id}/invites`,
      { email, role: 'tester' });
    assert.equal(res.status, 201, res.text);

    const rows = await w.db.query(
      `SELECT revoked_at, consumed_at FROM invitations WHERE email = $1 ORDER BY created_at`,
      [email]);
    assert.equal(rows.rows.length, 2, 'the old invitation is retired, not deleted');
    assert.ok(rows.rows[0].revoked_at !== null, 'the expired one is revoked');
    assert.equal(rows.rows[1].revoked_at, null, 'and the new one is live');
    assert.equal(rows.rows[1].consumed_at, null);
  });

  test('an admin can change a member role, and it is audited', async () => {
    const devId = (await w.db.query(
      `SELECT id FROM users WHERE email = 'dev@rgm.example'`)).rows[0].id;

    const res = await w.adminClient.patch(`/api/projects/${w.project.id}/members/${devId}`,
      { role: 'tester' });
    assert.equal(res.status, 200);
    assert.equal(res.json.role, 'tester');

    // The audit trail records who changed what, not just that something changed.
    const events = await w.db.query(
      `SELECT kind, payload FROM events WHERE kind = 'membership.role_changed'`);
    assert.equal(events.rows.length, 1);
    assert.equal(events.rows[0].payload.from, 'developer');
    assert.equal(events.rows[0].payload.to, 'tester');

    // And the new role is what authorization now uses.
    assert.equal((await w.devClient.post(`/api/projects/${w.project.id}/milestones`,
      { code: 'M-AFTER', titleEn: 'x' })).status, 403,
      'a tester cannot create milestones');
  });

  test('the last admin cannot be demoted, or the project becomes unmanageable', async () => {
    const adminId = (await w.db.query(
      `SELECT id FROM users WHERE email = 'admin@rgm.example'`)).rows[0].id;

    const res = await w.adminClient.patch(`/api/projects/${w.project.id}/members/${adminId}`,
      { role: 'developer' });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'last_admin');

    // The admin still is one.
    const still = await w.db.query(
      `SELECT role FROM active_memberships WHERE project_id = $1 AND user_id = $2`,
      [w.project.id, adminId]);
    assert.equal(still.rows[0].role, 'admin');
  });

  test('a role change needs a valid role and an active membership', async () => {
    const devId = (await w.db.query(
      `SELECT id FROM users WHERE email = 'dev@rgm.example'`)).rows[0].id;
    assert.equal((await w.adminClient.patch(
      `/api/projects/${w.project.id}/members/${devId}`, { role: 'nope' })).status, 400);

    const ghost = '99999999-9999-9999-9999-999999999999';
    assert.equal((await w.adminClient.patch(
      `/api/projects/${w.project.id}/members/${ghost}`, { role: 'tester' })).status, 404);
  });

  test('a non-admin cannot change a role', async () => {
    const testerId = (await w.db.query(
      `SELECT id FROM users WHERE email = 'tester@rgm.example'`)).rows[0].id;
    assert.equal((await w.testerClient.patch(
      `/api/projects/${w.project.id}/members/${testerId}`, { role: 'admin' })).status, 403);
  });
});

describe('auth: membership revocation', () => {
  test('a revoked member loses access immediately, without the session being revoked', async () => {
    const w = await makeProjectWorld();
    try {
      // Add a second tester, sign in, confirm access.
      const token = await w.invite({ projectId: w.project.id, email: 'temp@rgm.example',
                                     role: 'tester', createdBy: w.admin.userId });
      await w.redeem(token);
      const temp = await w.loginAs('temp@rgm.example');
      const me = await temp.get('/api/me');
      assert.equal(me.json.projects.length, 1);

      const userId = me.json.userId;
      const removed = await w.adminClient.del(
        `/api/projects/${w.project.id}/members/${userId}`);
      assert.equal(removed.status, 200);

      // Same cookie, still a valid session — access is gone regardless.
      assert.equal((await temp.get('/api/me')).status, 200);
      assert.equal((await temp.get('/api/projects')).json.projects.length, 0);
      assert.equal((await temp.get(`/api/projects/${w.project.id}/bugs`)).status, 403);

      const sessions = await w.db.query(
        'SELECT revoked_at FROM sessions WHERE user_id = $1', [userId]);
      assert.ok(sessions.rows.every(s => s.revoked_at === null),
        'the session itself must still be valid; only membership changed');
    } finally { await w.close(); }
  });

  test('removing a member invalidates their outstanding invitation (the removal race)', async () => {
    const w = await makeProjectWorld();
    try {
      const email = 'race@rgm.example';
      const first = await w.invite({ projectId: w.project.id, email, role: 'tester',
                                     createdBy: w.admin.userId });
      await w.redeem(first);
      const client = await w.loginAs(email);
      const userId = (await client.get('/api/me')).json.userId;

      // A second invitation exists when the member is removed...
      const second = await w.invite({ projectId: w.project.id, email, role: 'tester',
                                      createdBy: w.admin.userId });
      await w.adminClient.del(`/api/projects/${w.project.id}/members/${userId}`);

      // ...and redeeming it must NOT restore access that was just taken away.
      await assert.rejects(() => w.redeem(second), /expired, revoked or already used/);
      assert.equal((await client.get(`/api/projects/${w.project.id}/bugs`)).status, 403);
    } finally { await w.close(); }
  });

  test('removal cancels queued notifications for that member', async () => {
    const w = await makeProjectWorld();
    try {
      const token = await w.invite({ projectId: w.project.id, email: 'queued@rgm.example',
                                     role: 'tester', createdBy: w.admin.userId });
      await w.redeem(token);
      const client = await w.loginAs('queued@rgm.example');
      const userId = (await client.get('/api/me')).json.userId;

      const ms = await makeMilestone(w.adminClient, w.project.id, 'M-Q', 'Queued');
      await w.adminClient.post(`/api/milestones/${ms}/status`, { action: 'start' });
      await w.adminClient.post(`/api/milestones/${ms}/status`, { action: 'ready' });

      const pending = await w.db.query(
        `SELECT count(*)::int AS c FROM notifications_outbox
          WHERE recipient_id = $1 AND status = 'pending'`, [userId]);
      assert.ok(pending.rows[0].c >= 1, 'a notification should be queued');

      const res = await w.adminClient.del(`/api/projects/${w.project.id}/members/${userId}`);
      assert.equal(res.status, 200);
      assert.ok(res.json.cancelledNotifications >= 1);

      const left = await w.db.query(
        `SELECT count(*)::int AS c FROM notifications_outbox
          WHERE recipient_id = $1 AND status = 'pending'`, [userId]);
      assert.equal(left.rows[0].c, 0);
    } finally { await w.close(); }
  });
});

describe('auth: api tokens', () => {
  let w;
  before(async () => { w = await makeProjectWorld(); });
  after(async () => { await w.close(); });

  test('a token is returned once, stored hashed, and is revocable', async () => {
    const created = await w.devClient.post('/api/tokens', { name: 'laptop', scopes: ['bug:read'] });
    assert.equal(created.status, 201);
    const { token, id } = created.json;
    assert.ok(token);

    const rows = await w.db.query('SELECT token_hash FROM api_tokens WHERE id = $1', [id]);
    assert.equal(rows.rows[0].token_hash, hashToken(token));

    const listed = await w.devClient.get('/api/tokens');
    assert.equal(listed.json.tokens.length, 1);
    assert.equal(listed.json.tokens[0].token, undefined, 'plaintext must never be listed');

    assert.equal((await w.devClient.del(`/api/tokens/${id}`)).status, 200);
    const bearer = { authorization: `Bearer ${token}` };
    assert.equal((await w.newClient().get('/api/me', { headers: bearer })).status, 401);
  });

  test('a read-only token can read but cannot write', async () => {
    const created = await w.devClient.post('/api/tokens', { name: 'cli', scopes: ['bug:read'] });
    const bearer = { authorization: `Bearer ${created.json.token}` };
    const cli = w.newClient();

    const ms = await makeMilestone(w.adminClient, w.project.id, 'M-TOK', 'Tokens');
    const read = await cli.get(`/api/projects/${w.project.id}/milestones`, { headers: bearer });
    assert.equal(read.status, 200);

    const write = await cli.post(`/api/projects/${w.project.id}/bugs`,
      { milestoneId: ms, severity: 'low', titleVi: 'x', bodyVi: 'y' }, { headers: bearer });
    assert.equal(write.status, 403);
    assert.equal(write.json.error, 'insufficient_scope');
  });

  test('a token may not mint another token', async () => {
    const created = await w.devClient.post('/api/tokens', { name: 'chain', scopes: ['bug:read'] });
    const res = await w.newClient().post('/api/tokens', { name: 'child' },
      { headers: { authorization: `Bearer ${created.json.token}` } });
    assert.equal(res.status, 403);
  });
});
