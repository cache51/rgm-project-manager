/**
 * Test harness: one isolated database, one real HTTP server on a real socket,
 * one mail sink, one temp storage root, per world. Tests talk to the API over
 * HTTP rather than calling handlers directly, so routing, cookies and error
 * mapping are all exercised.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb } from '../src/db.js';
import { FsStorage } from '../src/storage.js';
import { createApp, listen } from '../src/server.js';
import { bootstrap, createProject, requestLoginLink, createInvite,
         redeemInvite } from '../src/auth.js';

function makeClient(baseUrl) {
  let cookie = null;

  const request = async (method, path, { body, headers = {}, raw = false } = {}) => {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    let payload = body;
    if (body !== undefined && !raw) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(baseUrl + path, { method, headers: h, body: payload });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];

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
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; }
  };
}

export async function makeWorld() {
  const dir = await mkdtemp(join(tmpdir(), 'rgm-test-'));
  const db = await freshDb();
  const mails = [];
  const deliver = async (msg) => { mails.push(msg); };
  const storage = new FsStorage({ root: join(dir, 'storage'), secret: 'test-secret' });
  const app = createApp({ db, storage, deliver,
    onError: (err) => console.error('[server error]', err) });
  const { url } = await listen(app, { port: 0 });

  const world = {
    db, app, storage, mails, url, dir, deliver,

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
