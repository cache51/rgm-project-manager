/**
 * CSRF, rate limiting and the migration path.
 *
 * These are the parts where a mistake is a vulnerability rather than a bug, so
 * each test names the attack it rules out.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { makeWorld, makeProjectWorld, makeMilestone, freshDb, testDriver } from './helpers.js';
import { bootstrap, createProject, hashToken } from '../src/auth.js';
import { migrate, migrationFiles, withTransaction } from '../src/db.js';
import { hit, prune, LIMITS } from '../src/ratelimit.js';
import { verifyDatabaseRoleBoundary, csrfRequired } from '../src/server.js';

/** Send a path verbatim, without the client library normalising it. */
function rawGet(origin, path) {
  const u = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: u.hostname, port: u.port, path, method: 'GET' },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
    req.on('error', reject);
    req.end();
  });
}

test('health fails closed when a required database pool is unavailable', async () => {
  const w = await makeWorld({ onError: () => {} });
  const original = w.db.query.bind(w.db);
  w.db.query = async () => { throw new Error('simulated database outage'); };
  try {
    const response = await fetch(`${w.url}/api/health`);
    assert.equal(response.status, 500);
  } finally {
    w.db.query = original;
    await w.close();
  }
});

test('startup rejects an owner or privileged runtime database identity', async () => {
  const identity = ({ user, superuser = false, owner = false, purge = false,
    mark = false, auditWrite = false, projectDelete = false, cleanupWrite = false,
    eventWrite = false }) => ({
    query: async () => ({ rows: [{
      session_user: user,
      is_superuser: superuser,
      owns_events: owner,
      can_purge: purge,
      can_mark_cleanup: mark,
      can_write_audit: auditWrite,
      can_delete_projects: projectDelete,
      can_write_cleanup: cleanupWrite,
      can_mutate_events: eventWrite
    }] })
  });

  await assert.rejects(
    () => verifyDatabaseRoleBoundary({ db: identity({ user: 'owner', owner: true }) }),
    /runtime database login.*owner/i);
  await assert.rejects(
    () => verifyDatabaseRoleBoundary({ db: identity({ user: 'rgm_app', purge: true }) }),
    /runtime database login.*purge authority/i);
  await assert.rejects(
    () => verifyDatabaseRoleBoundary({ db: identity({ user: 'rgm_app', auditWrite: true }) }),
    /runtime database login.*direct audit writes/i);
  await assert.rejects(
    () => verifyDatabaseRoleBoundary({ db: identity({ user: 'rgm_app', projectDelete: true }) }),
    /runtime database login.*direct project deletion/i);
  await assert.rejects(
    () => verifyDatabaseRoleBoundary({ db: identity({ user: 'rgm_app', cleanupWrite: true }) }),
    /runtime database login.*cleanup queue writes/i);
  await assert.rejects(
    () => verifyDatabaseRoleBoundary({ db: identity({ user: 'rgm_app', eventWrite: true }) }),
    /runtime database login.*event mutation/i);
  await assert.doesNotReject(() => verifyDatabaseRoleBoundary({
    db: identity({ user: 'rgm_app' })
  }));
});

describe('csrf: cookie-authenticated writes', () => {
  let w, ms;

  /** A fresh bug in 'new' status, for tests that assert nothing changed. */
  const newBug = async () => (await w.testerClient.post(`/api/projects/${w.project.id}/bugs`,
    { milestoneId: ms, severity: 'high', titleVi: 'Thiếu hàng', bodyVi: 'Thiếu 3 cái' })).json.id;

  before(async () => {
    w = await makeProjectWorld();
    ms = await makeMilestone(w.adminClient, w.project.id, 'M-CSRF', 'CSRF');
  });
  after(async () => { await w.close(); });

  test('direct email sign-in works with a stale session cookie and no csrf cookie', async () => {
    const stale = w.newClient();
    await w.loginAs('dev@rgm.example', stale);
    const sessionBefore = stale.cookie;
    assert.match(sessionBefore, /^session=.+/,
      'there must be a session cookie to replace, or the comparison below is vacuous');
    stale.dropCsrf();

    const signedIn = await stale.post('/api/auth/direct', { email: 'dev@rgm.example' });
    assert.equal(signedIn.status, 200, signedIn.text);
    assert.ok(stale.csrf, 'the csrf cookie the app must echo comes back');
    assert.notEqual(stale.cookie, sessionBefore,
      'sign-in replaces the stale session rather than adopting it');
    assert.equal((await stale.get('/api/me')).status, 200,
      'and the replacement session really is signed in');
  });

  test('the direct-sign-in exemption matches that path and nothing near it', () => {
    // A prefix-matching exemption would also exempt these, and the handler behind
    // them is not the sign-in handler — so the boundary is asserted, not implied.
    assert.equal(csrfRequired('POST', '/api/auth/direct'), false);
    for (const path of ['/api/auth/directly', '/api/auth/directx', '/api/auth/direct/extra',
                        '/api/auth/direct/', '/api/auth/DIRECT']) {
      assert.equal(csrfRequired('POST', path), true, `${path} must still require the header`);
    }
  });

  test('a sign-in link is still exempt, and an invitation is too', async () => {
    // IR-017: redemption is capability-addressed, so the session cookie must not
    // decide whether it works. The browser flow is /login?invite=… from someone who
    // already has a session, and login.js sends no CSRF header — while this test
    // client adds one automatically, which is exactly how the break stayed hidden.
    const invite = await w.invite({ projectId: w.project.id,
      email: 'joiner@rgm.example', role: 'tester', createdBy: w.admin.userId });

    const signedIn = w.newClient();
    await w.loginAs('dev@rgm.example', signedIn);
    signedIn.dropCsrf();                      // as the browser would send it

    const redeemed = await signedIn.post('/api/invites/redeem', { token: invite });
    assert.equal(redeemed.status, 200, redeemed.text);

    // The exemption is that one endpoint, not a hole in the rule: an ordinary
    // cookie-authenticated write still needs the header.
    const refused = await signedIn.post(`/api/projects/${w.project.id}/milestones`,
      { code: 'M-NOCSRF', titleEn: 'x' });
    assert.equal(refused.status, 403, refused.text);
    assert.equal(refused.json.error, 'csrf_failed');
  });

  test('the session cookie is HttpOnly and the csrf cookie is not', async () => {
    const client = w.newClient();
    const before = w.mails.length;
    await client.post('/api/auth/request-link', { email: 'dev@rgm.example' });
    const token = w.mails.slice(before).find((m) => m.kind === 'login').token;
    const res = await client.post('/api/auth/consume', { token });
    assert.equal(res.status, 200);

    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith('session='));
    const csrf = cookies.find((c) => c.startsWith('csrf='));
    assert.ok(session && csrf, 'both cookies must be set');
    assert.match(session, /HttpOnly/, 'the session cookie must not be readable by script');
    assert.ok(!/HttpOnly/.test(csrf),
      'the csrf cookie must be readable, or the app cannot echo it back');
    assert.match(csrf, /SameSite=Lax/);
  });

  test('the csrf secret is stored only as a hash', async () => {
    const client = await w.loginAs('dev@rgm.example');
    const plaintext = client.csrf;
    assert.ok(plaintext, 'the client holds the token');

    const stored = await w.db.query('SELECT 1 FROM sessions WHERE csrf_hash = $1',
      [hashToken(plaintext)]);
    assert.equal(stored.rows.length, 1, 'the hash is what is stored');

    const leak = await w.db.query('SELECT 1 FROM sessions WHERE csrf_hash = $1', [plaintext]);
    assert.equal(leak.rows.length, 0, 'the plaintext must never be at rest');
  });

  test('a cookie-authenticated write without the header is refused', async () => {
    const bug = await newBug();
    const client = await w.loginAs('dev@rgm.example');
    client.dropCsrf();   // everything a cross-site page can achieve: cookie yes, token no

    const res = await client.post(`/api/bugs/${bug}/status`, { action: 'start_fixing' });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'csrf_failed');

    const unchanged = await w.devClient.get(`/api/bugs/${bug}`);
    assert.equal(unchanged.json.status, 'new', 'the write must not have happened');
  });

  test('a wrong token is refused', async () => {
    const bug = await newBug();
    const client = await w.loginAs('dev@rgm.example');
    const res = await client.post(`/api/bugs/${bug}/status`, { action: 'start_fixing' },
      { headers: { 'x-csrf-token': 'not-the-right-token' } });
    assert.equal(res.status, 403);
  });

  test("another session's token is refused — bound, not merely double-submitted", async () => {
    const bug = await newBug();
    const victim = await w.loginAs('dev@rgm.example');
    const attacker = await w.loginAs('admin@rgm.example');

    const res = await victim.post(`/api/bugs/${bug}/status`, { action: 'start_fixing' },
      { headers: { 'x-csrf-token': attacker.csrf } });
    assert.equal(res.status, 403,
      'plain double-submit would have accepted this; the binding is what rejects it');
  });

  test('reads do not need a token', async () => {
    const client = await w.loginAs('dev@rgm.example');
    client.dropCsrf();
    assert.equal((await client.get(`/api/projects/${w.project.id}/bugs`)).status, 200);
  });

  test('a bearer token needs no CSRF token: it is not ambient authority', async () => {
    const created = await w.devClient.post('/api/tokens', { name: 'cli', scopes: ['bug:write'] });
    const bearerMs = await makeMilestone(w.adminClient, w.project.id, 'M-BEARER', 'Bearer');
    const res = await w.newClient().post(`/api/projects/${w.project.id}/bugs`,
      { milestoneId: bearerMs, severity: 'low', titleVi: 'x', bodyVi: 'y' },
      { headers: { authorization: `Bearer ${created.json.token}` } });
    assert.equal(res.status, 201);
  });

  test('the pre-session endpoints are exempt, or nobody could ever sign in', async () => {
    assert.equal((await w.newClient().post('/api/auth/request-link',
      { email: 'dev@rgm.example' })).status, 200);
  });

  test('a session with no recorded csrf hash fails closed', async () => {
    const bug = await newBug();
    const client = await w.loginAs('dev@rgm.example');

    const saved = await w.db.query(
      'SELECT id, csrf_hash FROM sessions WHERE revoked_at IS NULL');
    await w.db.query('UPDATE sessions SET csrf_hash = NULL WHERE revoked_at IS NULL');
    try {
      const res = await client.post(`/api/bugs/${bug}/status`, { action: 'start_fixing' });
      assert.equal(res.status, 403, 'deny rather than allow when the binding is absent');
      assert.equal(res.json.error, 'csrf_failed');
    } finally {
      for (const row of saved.rows) {
        await w.db.query('UPDATE sessions SET csrf_hash = $1 WHERE id = $2',
          [row.csrf_hash, row.id]);
      }
    }
  });

  test('logout also requires the token', async () => {
    const client = await w.loginAs('dev@rgm.example');
    client.dropCsrf();
    assert.equal((await client.post('/api/auth/logout')).status, 403);
  });
});

describe('rate limiting', () => {
  const tight = {
    loginLinkPerEmail: { limit: 2, windowSeconds: 900 },
    loginLinkPerIp: { limit: 500, windowSeconds: 900 },
    consumePerIp: { limit: 3, windowSeconds: 900 }
  };
  let w;
  before(async () => {
    w = await makeWorld({ limits: tight });
    const admin = await bootstrap(w.db, 'admin@rgm.example');
    await createProject(w.db, { name: 'P', client: 'C', createdBy: admin.userId });
  });
  after(async () => { await w.close(); });

  test('the per-address limit trips and says when to retry', async () => {
    const client = w.newClient();
    for (let i = 0; i < tight.loginLinkPerEmail.limit; i++) {
      assert.equal((await client.post('/api/auth/request-link',
        { email: 'admin@rgm.example' })).status, 200);
    }
    const over = await client.post('/api/auth/request-link', { email: 'admin@rgm.example' });
    assert.equal(over.status, 429);
    assert.equal(over.json.error, 'rate_limited');
    assert.ok(over.json.retryAfter > 0);
    assert.equal(over.headers.get('retry-after'), String(over.json.retryAfter));
  });

  test('a non-existent address is limited identically, so it reveals nothing', async () => {
    const client = w.newClient();
    for (let i = 0; i < tight.loginLinkPerEmail.limit; i++) {
      await client.post('/api/auth/request-link', { email: 'ghost@nowhere.example' });
    }
    const over = await client.post('/api/auth/request-link', { email: 'ghost@nowhere.example' });
    assert.equal(over.status, 429, 'the same outcome a real address gets');
  });

  test('the limit is per address, not global', async () => {
    const client = w.newClient();
    assert.equal((await client.post('/api/auth/request-link',
      { email: 'admin@rgm.example' })).status, 429, 'still exhausted');
    const other = await client.post('/api/auth/request-link', { email: 'other@rgm.example' });
    assert.notEqual(other.status, 429, 'one exhausted address must not lock out another');
  });

  test('sign-in attempts are limited per source', async () => {
    const client = w.newClient();
    for (let i = 0; i < tight.consumePerIp.limit; i++) {
      await client.post('/api/auth/consume', { token: 'guessing' });
    }
    const over = await client.post('/api/auth/consume', { token: 'guessing' });
    assert.equal(over.status, 429);
    assert.equal(over.json.error, 'rate_limited');
  });

  test('hits are recorded in the database, not in process memory', async () => {
    const rows = await w.db.query('SELECT bucket FROM rate_limit_hits');
    assert.ok(rows.rows.some((r) => r.bucket.startsWith('login:email:')), 'per-address bucket');
    assert.ok(rows.rows.some((r) => r.bucket.startsWith('login:ip:')), 'per-source bucket');
    assert.ok(rows.rows.some((r) => r.bucket.startsWith('consume:ip:')), 'consume bucket');
  });

  test('prune drops windows that can no longer be reached', async () => {
    const db = await freshDb();
    await hit(db, 'test:bucket', { limit: 1, windowSeconds: 60,
      now: new Date(Date.now() - 48 * 3600 * 1000) });
    assert.equal(await prune(db, { olderThanSeconds: 3600 }), 1);
    await db.close();
  });

  test('the shipped defaults are coherent', () => {
    assert.ok(LIMITS.loginLinkPerEmail.limit >= 5);
    assert.ok(LIMITS.loginLinkPerIp.limit >= LIMITS.loginLinkPerEmail.limit,
      'the per-source limit must not be tighter than the per-address one, or one '
      + 'noisy address would lock out everyone behind the same NAT');
  });
});

describe('robustness: a request must not be able to kill the process', () => {
  let w;
  before(async () => { w = await makeProjectWorld(); });
  after(async () => { await w.close(); });

  test('a malformed URL escape on a matching route is a 400, not a crash', async () => {
    // IR-002: decodeURIComponent threw straight out of the HTTP listener, so one
    // unauthenticated request was an outage. Reproduced by running the server and
    // sending `GET /api/bugs/%` — the process exited with URIError.
    const res = await rawGet(w.url, '/api/bugs/%');
    assert.equal(res.status, 400);
    assert.match(res.body, /bad_request/);

    // The real assertion: the process is still serving.
    assert.equal((await fetch(`${w.url}/api/health`)).status, 200);
  });

  test('other malformed escapes do not take it down either', async () => {
    for (const path of ['/api/bugs/%E0%A4%A', '/api/projects/%C3%28', '/api/uploads/%FF',
                        '/api/projects/%/members/%']) {
      const res = await rawGet(w.url, path);
      assert.ok([400, 404].includes(res.status), `${path} → ${res.status}`);
    }
    assert.equal((await fetch(`${w.url}/api/health`)).status, 200);
  });
});

describe('concurrency: transactions must not interleave', () => {
  test('concurrent transactions neither lose work nor resurrect rollbacks', async () => {
    // IR-003: the embedded driver is one connection shared by every request. When
    // BEGIN/COMMIT were issued as separate statements, concurrent transactions
    // interleaved — a rollback could discard a neighbour's committed rows.
    const db = await freshDb();
    try {
      const N = 20;
      await Promise.all(Array.from({ length: N }, (_, i) =>
        withTransaction(db, async (tx) => {
          await tx.query('INSERT INTO users (email, display_name) VALUES ($1, $2)',
            [`u${i}@rgm.example`, `user ${i}`]);
          // Yield, so the other transactions genuinely overlap.
          await new Promise((r) => setTimeout(r, i % 3));
          if (i % 5 === 0) throw new Error('deliberate rollback');
          return i;
        }).catch(() => null)));

      const rows = await db.query('SELECT email FROM users');
      const committed = new Set(rows.rows.map((r) => r.email));
      for (let i = 0; i < N; i++) {
        if (i % 5 === 0) {
          assert.ok(!committed.has(`u${i}@rgm.example`),
            `u${i} rolled back but its row survived`);
        } else {
          assert.ok(committed.has(`u${i}@rgm.example`),
            `u${i} committed but its row is missing`);
        }
      }
    } finally {
      await db.close();
    }
  });
});

describe('migrations', () => {
  test('hard purge adds no long-lived database role or transient runtime grant', async () => {
    const sql = await readFile(new URL('../db/migrations/013_purge_executor.sql', import.meta.url),
      'utf8');
    assert.doesNotMatch(sql, /CREATE\s+ROLE|rgm_purge_executor/i);
    assert.match(sql,
      /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'rgm_runtime'\)[\s\S]*REVOKE EXECUTE ON FUNCTION admin_purge_project[\s\S]*REVOKE ALL ON admin_storage_cleanup FROM rgm_runtime/i,
      'runtime revocations must be conditional on role existence and fail closed when it exists');
    const guarded = await readFile(new URL('../db/migrations/012_guarded_admin_purge.sql',
      import.meta.url), 'utf8');
    assert.doesNotMatch(guarded,
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+admin_purge_project[\s\S]*?TO\s+rgm_runtime/i,
      'runtime must never receive purge authority, even between migrations');
    assert.doesNotMatch(guarded, /EXCEPTION\s+WHEN\s+insufficient_privilege/i,
      'a failed runtime DELETE revocation must abort the migration');
    const privileges = await readFile(new URL('../db/migrations/002_privileges.sql',
      import.meta.url), 'utf8');
    assert.doesNotMatch(privileges, /insufficient privilege to grant on public: skipping/i,
      'failed event ACL revocation must abort rather than leave mutable audit rows');
    const auditCreate = await readFile(new URL('../db/migrations/010_admin_audit.sql',
      import.meta.url), 'utf8');
    assert.match(auditCreate,
      /REVOKE\s+INSERT,\s*UPDATE,\s*DELETE,\s*TRUNCATE\s+ON\s+admin_audit_log\s+FROM\s+rgm_runtime/i,
      'audit mutation rights must be revoked in the table-creation migration');
    const auditGuard = await readFile(new URL('../db/migrations/011_admin_audit_append_only.sql',
      import.meta.url), 'utf8');
    assert.doesNotMatch(auditGuard, /GRANT\s+SELECT,\s*INSERT\s+ON\s+admin_audit_log/i,
      'a later migration must never re-grant runtime audit insertion');
  });

  test('the suite is running on the driver the environment selected', async () => {
    const db = await freshDb();
    assert.ok(['pglite', 'pg'].includes(db.driver), `unexpected driver ${db.driver}`);
    assert.equal(db.driver, testDriver(),
      'RGM_TEST_DRIVER=pg must actually switch the driver, or the CI matrix is a lie');
    await db.close();
  });

  test('every migration applies in order and is recorded', async () => {
    const db = await freshDb();
    const applied = (await db.query(
      'SELECT filename FROM schema_migrations ORDER BY filename')).rows.map((r) => r.filename);
    assert.deepEqual(applied, migrationFiles(), 'all files applied, in filename order');
    assert.ok(applied.length >= 4, `expected the full set, got ${applied.length}`);
    await db.close();
  });

  test('migrating twice is a no-op, so a restart is safe', async () => {
    const db = await freshDb();
    assert.equal((await migrate(db)).applied.length, 0);
    await db.close();
  });

  test('an existing database gains new migrations without losing data', async () => {
    const db = await freshDb();
    const email = 'kept@rgm.example';
    await db.query(`INSERT INTO users (email, display_name) VALUES ($1, 'kept')`, [email]);

    assert.equal((await migrate(db)).applied.length, 0, 'nothing re-applied');
    const still = await db.query('SELECT 1 FROM users WHERE email = $1', [email]);
    assert.equal(still.rows.length, 1, 'data must survive a re-run');
    await db.close();
  });

  test('the privileges migration applies and grants exactly what it claims', async () => {
    const db = await freshDb();

    const roles = await db.query(
      `SELECT rolname, rolsuper, rolcanlogin FROM pg_roles
        WHERE rolname IN ('rgm_runtime', 'rgm_auditor') ORDER BY rolname`);
    assert.equal(roles.rows.length, 2, 'both roles should exist in this environment');
    for (const role of roles.rows) {
      assert.equal(role.rolsuper, false, `${role.rolname} must not be a superuser`);
      assert.equal(role.rolcanlogin, false, `${role.rolname} must not be able to log in`);
    }

    // IR-004: the runtime role has to be able to do what the application does.
    // It previously held grants on `events` alone, so a deployment that used it
    // could not read `users`, `sessions` or `active_memberships`, and could not
    // start. Naming the tables the application actually touches is what makes the
    // role usable rather than merely present.
    const runtimeTables = await db.query(
      `SELECT DISTINCT table_name FROM information_schema.role_table_grants
        WHERE grantee = 'rgm_runtime'`);
    const names = new Set(runtimeTables.rows.map((r) => r.table_name));
    for (const needed of ['users', 'sessions', 'active_memberships', 'rate_limit_hits',
                          'bugs', 'milestones', 'projects', 'events']) {
      assert.ok(names.has(needed), `rgm_runtime must be able to reach ${needed}`);
    }

    // ...but the audit trail stays append-only, by grant as well as by trigger.
    const app = await db.query(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'rgm_runtime' AND table_name = 'events' ORDER BY privilege_type`);
    assert.deepEqual(app.rows.map((r) => r.privilege_type), ['INSERT', 'SELECT'],
      'append-only at the DB level, not just in a trigger');

    // The auditor may read everything and write nothing.
    const auditor = await db.query(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'rgm_auditor' AND table_name = 'events'`);
    assert.deepEqual(auditor.rows.map((r) => r.privilege_type), ['SELECT']);

    // A pre-existing `rgm_app` must keep its identity — role names are cluster-wide,
    // so renaming it (as this fix first did) followed for every other database on the
    // server and broke any login created under that name (RGM4-004). It should
    // instead inherit the runtime group, which is the access the old migration denied
    // it, without its name changing.
    const stale = await db.query(`SELECT 1 FROM pg_roles WHERE rolname = 'rgm_app'`);
    if (stale.rows.length) {
      const inherits = await db.query(
        `SELECT 1 FROM pg_auth_members m
           JOIN pg_roles r ON r.oid = m.member
           JOIN pg_roles g ON g.oid = m.roleid
          WHERE r.rolname = 'rgm_app' AND g.rolname = 'rgm_runtime'`);
      assert.equal(inherits.rows.length, 1,
        'a pre-existing rgm_app must inherit rgm_runtime, not be renamed');
    }

    await db.close();
  });

  test('rgm_runtime may append to events and may neither rewrite nor delete them', async () => {
    const db = await freshDb();
    const admin = await bootstrap(db, 'acl@rgm.example');
    const project = await createProject(db, { name: 'ACL', client: 'X',
                                               createdBy: admin.userId });

    // Actually assume the role on one pinned connection. A standalone SET ROLE
    // through a pool can affect one connection while the checked statement lands
    // on another, making the test silently run as the owner.
    const before = (await db.query('SELECT count(*)::int AS c FROM events')).rows[0].c;
    await db.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE rgm_runtime');
      await tx.query(
        `INSERT INTO events (project_id, actor_id, kind, payload)
         VALUES ($1, $2, 'acl.test', '{}'::jsonb)`, [project.id, admin.userId]);
    });
    assert.equal((await db.query('SELECT count(*)::int AS c FROM events')).rows[0].c,
      before + 1, 'the append landed');

    for (const [action, expected] of [
      [tx => tx.query(`UPDATE events SET kind = 'x'`), /permission denied|append-only/],
      [tx => tx.query('DELETE FROM events'), /permission denied|append-only/],
      [tx => tx.exec('TRUNCATE events'), /permission denied|append-only|cannot truncate/]
    ]) {
      await assert.rejects(
        () => db.transaction(async (tx) => {
          await tx.exec('SET LOCAL ROLE rgm_runtime');
          await action(tx);
        }), expected);
    }

    assert.equal((await db.query('SELECT count(*)::int AS c FROM events')).rows[0].c,
      before + 1, 'failed mutations changed nothing');
    await db.close();
  });

  test('rgm_runtime cannot impersonate a site admin or fabricate purge audit rows', async () => {
    const db = await freshDb();
    const admin = await bootstrap(db, 'purge-acl@rgm.example');
    const project = await createProject(db, { name: 'Runtime purge ACL', client: 'X',
                                               createdBy: admin.userId });
    await db.query(`UPDATE projects SET deleted_at = now() WHERE id = $1`, [project.id]);

    const asRole = (role, action) => db.transaction(async (tx) => {
      await tx.exec(`SET LOCAL ROLE ${role}`);
      return action(tx);
    });

    await assert.rejects(
      () => asRole('rgm_runtime', tx =>
        tx.exec('ALTER TABLE events DISABLE TRIGGER events_no_update')),
      /permission denied|must be owner/i);
    await assert.rejects(
      () => asRole('rgm_runtime', tx => tx.query(
        `SELECT * FROM admin_purge_project($1, $2, $3, false)`,
        ['purge-acl@rgm.example', project.id, 'runtime must not impersonate this admin'])),
      /permission denied/i);
    await assert.rejects(
      () => asRole('rgm_runtime', tx => tx.query(
        `INSERT INTO admin_audit_log
           (actor_id, action, target_id, target_name, reason)
         VALUES ($1, 'project.purged', $2, 'forged', 'forged audit reason')`,
        [admin.userId, project.id])),
      /permission denied/i);
    await assert.rejects(
      () => asRole('rgm_runtime', tx =>
        tx.query(`DELETE FROM admin_audit_log WHERE target_id = $1`, [project.id])),
      /permission denied|append-only/i);

    const purged = await db.query(
      `SELECT project_name, storage_keys
         FROM admin_purge_project($1, $2, $3, false)`,
      ['purge-acl@rgm.example', project.id, 'one-shot owner task writes tombstone']);
    assert.equal(purged.rows[0].project_name, 'Runtime purge ACL');
    assert.deepEqual(purged.rows[0].storage_keys, []);

    assert.equal((await db.query(
      `SELECT count(*)::int AS c FROM projects WHERE id = $1`, [project.id])).rows[0].c, 0);
    assert.equal((await db.query(
      `SELECT count(*)::int AS c FROM admin_audit_log WHERE target_id = $1`,
      [project.id])).rows[0].c, 1);
    await db.close();
  });

  test('the append-only trigger holds even for a role that owns nothing', async () => {
    const db = await freshDb();
    const admin = await bootstrap(db, 'audit@rgm.example');
    await createProject(db, { name: 'Audit', client: 'X', createdBy: admin.userId });
    const projectId = (await db.query('SELECT id FROM projects LIMIT 1')).rows[0].id;

    await db.query(
      `INSERT INTO events (project_id, actor_id, kind, payload)
       VALUES ($1, $2, 'test.event', '{}'::jsonb)`, [projectId, admin.userId]);

    // Two independent defences: the trigger, and the grant.
    await assert.rejects(() => db.query(`UPDATE events SET kind = 'rewritten'`), /append-only/);
    await assert.rejects(() => db.query('DELETE FROM events'), /append-only/);
    await db.close();
  });

  test('the csrf column and the rate limit table are usable', async () => {
    const db = await freshDb();
    await db.query(`INSERT INTO users (email, display_name) VALUES ('a@b.c','a')`);
    await db.query(
      `INSERT INTO sessions (user_id, token_hash, absolute_expires_at)
       SELECT id, 'h', now() + interval '1 day' FROM users WHERE email = 'a@b.c'`);
    assert.equal((await db.query('SELECT csrf_hash FROM sessions')).rows[0].csrf_hash, null);

    assert.equal((await hit(db, 'smoke', { limit: 1, windowSeconds: 60 })).allowed, true);
    assert.equal((await hit(db, 'smoke', { limit: 1, windowSeconds: 60 })).allowed, false);
    await db.close();
  });
});
