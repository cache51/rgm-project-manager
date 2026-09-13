/**
 * Test harness: one isolated database, one real HTTP server on a real socket,
 * one mail sink, one temp storage root, per world. Tests talk to the API over
 * HTTP rather than calling handlers directly, so routing, cookies and error
 * mapping are all exercised.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb as freshPgliteDb, migrate } from '../src/db.js';
import { createPgDb } from '../src/db-pg.js';
import { FsStorage } from '../src/storage.js';
import { createApp, listen } from '../src/server.js';
import { bootstrap, createProject, requestLoginLink, createInvite,
         redeemInvite } from '../src/auth.js';

/**
 * The whole suite runs twice in CI: once on the PGlite driver, once on the pg
 * driver. `RGM_TEST_DRIVER=pg` selects the latter, which is what proves the two
 * drivers are actually interchangeable rather than merely similar.
 */
export const testDriver = () =>
  (process.env.RGM_TEST_DRIVER === 'pg' ? 'pg' : 'pglite');

/**
 * A `pg.Pool`-shaped double backed by one PGlite instance.
 *
 * It emulates a pool of size one: `connect()` hands out a handle over the same
 * connection. That is enough to exercise the part of the pg driver that matters —
 * that a transaction pins a client and issues BEGIN/COMMIT on it — without
 * needing a Postgres server.
 *
 * The subtlety: node-postgres uses the SIMPLE query protocol when there are no
 * parameters, which executes several statements AND returns the rows of the last
 * one. So "no parameters" does not mean "not a query". A paramless SELECT must
 * still return rows, while a multi-statement migration must not be fed to
 * PGlite's `query()` (which rejects more than one statement).
 */
function looksMultiStatement(sql) {
  const stripped = String(sql)
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return /;[\s\S]*\S/.test(stripped);
}

function pgliteAsPgPool(pglite) {
  const query = async (text, params) => {
    const hasParams = params !== undefined && params !== null;
    if (!hasParams && looksMultiStatement(text)) {
      await pglite.exec(text);
      return { rows: [], rowCount: null };
    }
    const res = hasParams ? await pglite.query(text, params) : await pglite.query(text);
    return { rows: res.rows ?? [], rowCount: res.affectedRows ?? null };
  };

  return {
    query,
    async connect() {
      return { query, release() { /* nothing to return to a pool of one */ } };
    },
    async end() { /* the caller owns the PGlite instance */ }
  };
}

/** A fresh, migrated database on whichever driver the environment selects. */
export async function freshDb() {
  if (testDriver() === 'pg') {
    const { PGlite } = await import('@electric-sql/pglite');
    const pglite = new PGlite();
    await pglite.waitReady;
    const db = await createPgDb({ pool: pgliteAsPgPool(pglite) });
    await migrate(db);
    return db;
  }
  return freshPgliteDb();
}

function makeClient(baseUrl) {
  let sessionToken = null;
  let csrfToken = null;

  const request = async (method, path, { body, headers = {}, raw = false } = {}) => {
    const h = { ...headers };
    const cookies = [];
    if (sessionToken !== null) cookies.push(`session=${sessionToken}`);
    if (csrfToken !== null) cookies.push(`csrf=${encodeURIComponent(csrfToken)}`);
    if (cookies.length) h.cookie = cookies.join('; ');

    // What the browser app does: read the csrf cookie, echo it in a header.
    // Tests that want to simulate a cross-site request call dropCsrf() first.
    const safe = ['GET', 'HEAD', 'OPTIONS'].includes(method);
    if (csrfToken && !safe && h['x-csrf-token'] === undefined) {
      h['x-csrf-token'] = csrfToken;
    }

    let payload = body;
    if (body !== undefined && !raw) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(baseUrl + path, { method, headers: h, body: payload });

    const setCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);
    for (const raw of setCookies) {
      const pair = raw.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1);
      if (name === 'session') sessionToken = value === '' ? null : value;
      if (name === 'csrf') csrfToken = value === '' ? null : decodeURIComponent(value);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') ?? '';
    let json = null;
    if (contentType.includes('application/json')) {
      try { json = JSON.parse(buf.toString('utf8')); } catch { json = null; }
    }
    return { status: res.status, json, buf, text: buf.toString('utf8'),
             contentType, headers: res.headers };
  };

  return {
    get: (p, o) => request('GET', p, o),
    post: (p, b, o) => request('POST', p, { ...o, body: b }),
    put: (p, b, o) => request('PUT', p, { ...o, body: b, raw: true }),
    del: (p, o) => request('DELETE', p, o),
    request,
    get cookie() { return sessionToken === null ? '' : `session=${sessionToken}`; },
    set cookie(v) { sessionToken = v === null ? null : String(v).replace(/^session=/, ''); },
    get csrf() { return csrfToken; },
    // Simulate a request a browser sends without the app's help.
    dropCsrf() { csrfToken = null; },
    dropSession() { sessionToken = null; }
  };
}

export async function makeWorld({ limits = null, storage = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rgm-test-'));
  const db = await freshDb();
  const mails = [];
  const deliver = async (msg) => { mails.push(msg); };
  const storageImpl = storage ?? new FsStorage({
    root: join(dir, 'storage'), secret: 'test-secret'
  });
  const app = createApp({ db, storage: storageImpl, deliver, limits,
    onError: (err) => console.error('[server error]', err) });
  const { url } = await listen(app, { port: 0 });

  const world = {
    db, app, storage: storageImpl, mails, url, dir, deliver,

    newClient: () => makeClient(url),

    /** Sign a user in through the real login-link flow; returns a client. */
    async loginAs(email, client = makeClient(url)) {
      const before = mails.length;
      await requestLoginLink(db, email, { deliver });
      const mail = mails.slice(before).find(m => m.kind === 'login');
      if (!mail) throw new Error(`no login link issued for ${email}`);
      const res = await client.post('/api/auth/consume', { token: mail.token });
      if (res.status !== 200) throw new Error(`login failed: ${res.text}`);
      return client;
    },

    /** Create an invitation and redeem it, returning the invited user's id. */
    async invite({ projectId, email, role, createdBy }) {
      const before = mails.length;
      await createInvite(db, { projectId, email, role, createdBy, deliver });
      const mail = mails.slice(before).find(m => m.kind === 'invite');
      if (!mail) throw new Error(`no invite issued for ${email}`);
      return mail.token;
    },

    async redeem(token) { return redeemInvite(db, token); },

    async close() {
      await new Promise(r => app.server.close(r));
      if (db.close) await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  };

  return world;
}

/**
 * A populated world: one project with an admin, a developer and a tester, all
 * with sessions. The shape most tests actually need.
 */
export async function makeProjectWorld() {
  const world = await makeWorld();
  const { db } = world;

  const admin = await bootstrap(db, 'admin@rgm.example');
  const project = await createProject(db, {
    name: 'Packing Line', client: 'LWMS', env: 'staging', createdBy: admin.userId
  });

  for (const [email, role] of [['dev@rgm.example', 'developer'], ['tester@rgm.example', 'tester']]) {
    const token = await world.invite({ projectId: project.id, email, role,
                                       createdBy: admin.userId });
    await world.redeem(token);
  }

  return {
    ...world,
    admin, project,
    adminClient: await world.loginAs('admin@rgm.example'),
    devClient: await world.loginAs('dev@rgm.example'),
    testerClient: await world.loginAs('tester@rgm.example')
  };
}

/** Helper: create a milestone and return its id. */
export async function makeMilestone(client, projectId, code = 'M1', titleEn = 'First cut') {
  const res = await client.post(`/api/projects/${projectId}/milestones`,
    { code, titleEn });
  if (res.status !== 201) throw new Error(`milestone failed: ${res.text}`);
  return res.json.id;
}

/** Helper: file a bug and return { id, code }. */
export async function fileBug(client, projectId, { milestoneId, severity = 'high',
                                                   titleVi = 'Thiếu hàng',
                                                   bodyVi = 'Thùng bị thiếu 3 cái' } = {}) {
  const res = await client.post(`/api/projects/${projectId}/bugs`,
    { milestoneId, severity, titleVi, bodyVi });
  if (res.status !== 201) throw new Error(`bug failed: ${res.text}`);
  return res.json;
}

/** A tiny but real PNG. */
export const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64');
