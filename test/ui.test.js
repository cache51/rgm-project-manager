/**
 * The web UI layer: static serving, path containment, and the property that
 * matters most — the UI does not re-implement the prompt or the packet.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeProjectWorld, makeMilestone, fileBug } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');

/** Send a request line verbatim, bypassing any client-side path normalisation. */
function rawRequest(port, target) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

describe('ui: static serving', () => {
  let w, port;
  before(async () => {
    w = await makeProjectWorld();
    port = new URL(w.url).port;
  });
  after(async () => { await w.close(); });

  test('the app shell is served at the root', async () => {
    const res = await w.newClient().get('/');
    assert.equal(res.status, 200);
    assert.match(res.contentType, /text\/html/);
    assert.match(res.text, /\/app\.js/);
    assert.match(res.text, /id="app"/);
  });

  test('the sign-in page is served', async () => {
    const res = await w.newClient().get('/login');
    assert.equal(res.status, 200);
    assert.match(res.text, /\/login\.js/);
    assert.match(res.text, /an admin added you with/);
    assert.doesNotMatch(res.text, /send a one-time|password/i,
      'the page must not promise a link or ask for a password');
  });

  test('assets are served with the right content types', async () => {
    for (const [path, expected] of [['/styles.css', /text\/css/], ['/ui.css', /text\/css/],
                                    ['/app.js', /javascript/], ['/login.js', /javascript/]]) {
      const res = await w.newClient().get(path);
      assert.equal(res.status, 200, `${path} should be served`);
      assert.match(res.contentType, expected, `${path} content type`);
    }
  });

  test('an unknown page is a 404, not a crash', async () => {
    assert.equal((await w.newClient().get('/nope')).status, 404);
  });

  test('/api paths are handled by the API, never by the static handler', async () => {
    const res = await w.newClient().get('/api/nonexistent');
    assert.equal(res.status, 404);
    assert.equal(res.json.error, 'not_found');
    assert.match(res.contentType, /application\/json/);
  });

  test('static files are GET-only', async () => {
    assert.equal((await w.newClient().post('/app.js', {})).status, 405);
  });

  test('a raw ../ request cannot escape the public directory', async () => {
    const response = await rawRequest(port, '/../package.json');
    assert.match(response, /^HTTP\/1\.1 (403|404)/, 'must not serve a file above public/');
    assert.ok(!response.includes('"name": "rgm-project-manager"'),
      'package.json contents must not leak');
  });

  test('a percent-encoded traversal is refused', async () => {
    for (const target of ['/%2e%2e/package.json', '/..%2fpackage.json',
                          '/%2e%2e%2f%2e%2e%2fetc/passwd']) {
      const res = await w.newClient().get(target);
      assert.ok([403, 404].includes(res.status), `${target} -> ${res.status}`);
      assert.ok(!res.text.includes('"name": "rgm-project-manager"'), `${target} leaked a file`);
    }
  });

  test('the source directory is not reachable through the public root', async () => {
    const res = await w.newClient().get('/%2e%2e/src/api.js');
    assert.ok([403, 404].includes(res.status));
    assert.ok(!res.text.includes('buildRoutes'), 'server source must not be served');
  });
});

describe('ui: no duplicated handoff logic', () => {
  test('the UI fetches the prompt from the API instead of rebuilding it', async () => {
    const app = await readFile(join(ROOT, 'public', 'app.js'), 'utf8');

    // The whole point of wiring the UI up: the browser must not own a second
    // implementation of the prompt or the packet layout.
    assert.ok(!/RGM-UNTRUSTED/.test(app),
      'the fence token must not appear in client code — that would mean a second builder');
    assert.ok(!/PREAMBLE/.test(app));
    assert.ok(!/function\s+buildPrompt/.test(app));
    assert.ok(!/makeZip|crc32|CRC/.test(app), 'the client must not build its own zip');
    assert.ok(!/meta\.json/.test(app), 'the client must not lay out the packet itself');

    // ...and it does fetch them from the server.
    assert.match(app, /\/api\/bugs\/\$\{[^}]+\}\/prompt/);
    assert.match(app, /\/api\/bugs\/\$\{[^}]+\}\/packet/);
  });

  test('the UI escapes untrusted text before interpolating it into HTML', async () => {
    const app = await readFile(join(ROOT, 'public', 'app.js'), 'utf8');
    assert.match(app, /const esc = /, 'an escape helper must exist');

    // Collect every value that actually passes through esc(), then assert the
    // tester-controlled fields are among them.
    const escaped = [...app.matchAll(/esc\(([^)]*)\)/g)].map((m) => m[1]);
    for (const field of ['title_vi', 'bodyVi', 'originalFilename', 'name', 'actor', 'text', 'note']) {
      assert.ok(escaped.some((v) => v.includes(field)),
        `${field} must be rendered through esc()`);
    }
  });

  test('the mock and the real UI are separate, and the mock is documented as historical', async () => {
    const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
    assert.match(readme, /mockups\/tester-dev-portal\.html/);
    assert.match(readme, /public\//, 'the README must point at the real UI');
  });
});

describe('ui: the data the UI renders', () => {
  let w, ms, bug;
  before(async () => {
    w = await makeProjectWorld();
    ms = await makeMilestone(w.adminClient, w.project.id, 'M-UI', 'UI milestone');
    await w.adminClient.post(`/api/milestones/${ms}/status`, { action: 'start' });
    await w.adminClient.post(`/api/milestones/${ms}/status`, { action: 'ready' });
    bug = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    await w.devClient.post(`/api/bugs/${bug.id}/comments`, { note: 'Đang kiểm tra' });
  });
  after(async () => { await w.close(); });

  test('the milestone list tells a tester which milestones are reportable', async () => {
    const res = await w.testerClient.get(`/api/projects/${w.project.id}/milestones`);
    const ready = res.json.milestones.filter(m => m.status === 'ready');
    assert.equal(ready.length, 1);
    assert.equal(ready[0].code, 'M-UI');
  });

  test('the bug list carries what the rows render', async () => {
    const res = await w.testerClient.get(`/api/projects/${w.project.id}/bugs`);
    const row = res.json.bugs[0];
    assert.equal(row.code, 'BUG-1');
    assert.ok(row.title_vi, 'rows show the Vietnamese title');
    assert.equal(typeof row.attachments, 'number');
    assert.ok(row.updated_at, 'rows show a timestamp');
  });

  test('the detail payload carries translations, timeline and role-appropriate actions', async () => {
    const asDev = (await w.devClient.get(`/api/bugs/${bug.id}`)).json;
    assert.ok(asDev.translations.body, 'translations are present for the viewer language');
    assert.ok(asDev.timeline.some(e => e.kind === 'bug.commented'));
    assert.equal(asDev.attachments.length, 0);

    // A developer can start fixing; a tester is not offered that action.
    assert.ok(asDev.availableActions.some(a => a.action === 'start_fixing'));
    const asTester = (await w.testerClient.get(`/api/bugs/${bug.id}`)).json;
    assert.ok(!asTester.availableActions.some(a => a.action === 'start_fixing'),
      'a tester must not be shown a developer-only action');
  });

  test('the note a tester writes is available in the viewer language once translated', async () => {
    const { runBugTranslations, runEventTranslations, StubProvider } = await import('../src/translate.js');
    const { randomUUID } = await import('node:crypto');
    await runBugTranslations(w.db, StubProvider(), { workerId: randomUUID() });
    await runEventTranslations(w.db, StubProvider(), { workerId: randomUUID() });

    const payload = (await w.devClient.get(`/api/bugs/${bug.id}`)).json;
    const commented = payload.timeline.find(e => e.kind === 'bug.commented');
    assert.equal(commented.note, 'Đang kiểm tra');
    assert.equal(commented.noteTranslations.zh.status, 'done');
  });
});
