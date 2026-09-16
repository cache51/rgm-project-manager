/**
 * The sign-in page, executed.
 *
 * There is no password and no emailed link: the page posts an address and, if an admin
 * has added it, gets a session back. This loads the real `public/login.js` in a stub DOM
 * and drives the flow plus the two failure paths.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, '..', 'public', 'login.js'), 'utf8');

async function settle(times = 40) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

function loadPage({ search = '', hash = '', routes = {} } = {}) {
  const calls = [];
  const redirects = [];
  const replaces = [];
  const elements = new Map();
  const listeners = {};

  const el = (id) => {
    if (!elements.has(id)) {
      elements.set(id, { id, textContent: '', value: '', disabled: false, style: {} });
    }
    return elements.get(id);
  };

  const form = {
    id: 'form',
    addEventListener: (ev, fn) => { listeners[ev] = fn; },
    style: {}
  };

  const document = {
    getElementById: (id) => (id === 'form' ? form : el(id))
  };

  const respond = (body, status = 200) => ({
    ok: status < 400,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body)
  });

  const ctx = {
    console,
    setTimeout, clearTimeout,
    URLSearchParams, URL,
    document,
    location: { search,
                // Modelled separately from `search`, exactly as a browser does:
                // a fixture that put the fragment text into `search` would let a
                // broken hash branch pass on the query branch's evidence.
                hash,
                href: `http://127.0.0.1:3000/login${search}${hash}`,
                pathname: '/login',
                replace: (u) => { replaces.push(u); redirects.push(u); } },
    history: {
      // Address-bar cleaning is not navigation: it must not disturb the
      // "never navigates anywhere but the app" assertions.
      replaceState: (_state, _title, url) => {
        replaces.push(`http://127.0.0.1:3000${url}`);
      }
    },
    fetch: async (path, opts = {}) => {
      const method = (opts.method ?? 'GET').toUpperCase();
      calls.push({ method, path, body: opts.body ? JSON.parse(opts.body) : null });
      const route = routes[`${method} ${path}`];
      if (typeof route === 'function') {
        const out = route() ?? {};
        return respond(out.body ?? {}, out.status ?? 200);
      }
      if (route !== undefined) return respond(route);
      return respond({}, 200);
    }
  };
  ctx.window = ctx;

  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx, { filename: 'public/login.js' });

  return {
    calls, redirects, replaces, el, form,
    /** True when a replace wiped the address bar down to bare /login. */
    locationCleaned: () => replaces.some((u) => /^http:\/\/127\.0\.0\.1:3000\/login\/?$/.test(u)
      || /^\/login\/?$/.test(u)),
    text: () => ({
      heading: el('heading').textContent,
      note: el('note').textContent,
      hint: el('hint').textContent
    }),
    submit: async (email) => {
      el('email').value = email;
      await listeners.submit({ preventDefault() {} });
      await settle();
    }
  };
}

describe('login page: an address in, a session out', () => {
  test('a known address is signed in and sent to the app', async () => {
    const page = loadPage({ routes: { 'POST /api/auth/direct': () => ({ body: { ok: true } }) } });
    await settle();
    await page.submit('linh@rgm.example');

    const post = page.calls.find((c) => c.path === '/api/auth/direct');
    assert.ok(post, 'the address is posted');
    assert.deepEqual(post.body, { email: 'linh@rgm.example' });
    assert.deepEqual(page.redirects, ['/'], 'and the browser goes to the app');
  });

  test('the address is trimmed, so a trailing space is not a different person', async () => {
    const page = loadPage({ routes: { 'POST /api/auth/direct': () => ({ body: { ok: true } }) } });
    await settle();
    await page.submit('  linh@rgm.example  ');

    assert.deepEqual(page.calls.find((c) => c.path === '/api/auth/direct').body,
      { email: 'linh@rgm.example' });
  });

  test('an unknown address is told what to do, and nobody is let in', async () => {
    const page = loadPage({
      routes: {
        'POST /api/auth/direct': () => ({
          body: { message: 'that address is not on any project yet — ask an admin to add you' },
          status: 404
        })
      }
    });
    await settle();
    await page.submit('stranger@example.com');

    const { heading, note, hint } = page.text();
    assert.match(heading, /did not work/i);
    assert.match(note, /ask an admin to add you/, 'the server reason, not just "failed"');
    assert.match(hint, /ask an admin/i);
    assert.deepEqual(page.redirects, [], 'and nobody is let in');
  });

  test('a request that fails outright is reported, and the button is usable again', async () => {
    const page = loadPage({
      routes: { 'POST /api/auth/direct': () => { throw new Error('boom'); } }
    });
    await settle();

    // The old page let this escape as an unhandled rejection, leaving a dead button
    // and no explanation. It is caught, shown, and the form stays usable.
    await page.submit('a@b.test');

    assert.match(page.text().heading, /did not work/i);
    assert.match(page.text().note, /boom/, 'the failure is visible, not swallowed');
    assert.equal(page.el('submit').disabled, false);
    assert.deepEqual(page.redirects, [], 'and nobody is let in');
  });

  test('a blank address is not sent anywhere', async () => {
    const page = loadPage({ routes: { 'POST /api/auth/direct': () => ({ body: { ok: true } }) } });
    await settle();
    await page.submit('   ');

    assert.equal(page.calls.length, 0, 'nothing to look up');
    assert.deepEqual(page.redirects, []);
  });

  test('sign-in never navigates anywhere but the app', async () => {
    // No redirect parameter is read at all, so there is no target to aim elsewhere —
    // which is why the previous open-redirect guard has no job here any more.
    for (const search of ['?next=https://evil.test/', '?next=//evil.test', '?token=stale']) {
      const page = loadPage({
        search,
        routes: { 'POST /api/auth/direct': () => ({ body: { ok: true } }) }
      });
      await settle();
      await page.submit('linh@rgm.example');

      assert.deepEqual(page.redirects, ['/'],
        `${search} must not change where sign-in lands`);
    }
  });

  test('a link secret in the fragment is wiped from the address bar (IR-018)', async () => {
    // Links carry the secret after '#', which servers never see. The page still
    // removes it, so it cannot leak into history, screenshots or the next paste
    // of the URL. `search` is empty here, as it is in a real fragment URL — the
    // hash branch is what has to do the work.
    for (const fragment of ['#token=abc', '#invite=xyz']) {
      const page = loadPage({
        hash: fragment,
        routes: { 'POST /api/auth/direct': () => ({ body: { ok: true } }) }
      });
      await settle();

      assert.ok(page.locationCleaned(),
        `${fragment} must be wiped from the address bar on load`);
      assert.equal(page.calls.length, 0,
        `${fragment} is never consumed by the browser (no token sign-in)`);
    }

    // And the older form, where the secret rode in the query string.
    const legacy = loadPage({
      search: '?token=old-style',
      routes: { 'POST /api/auth/direct': () => ({ body: { ok: true } }) }
    });
    await settle();
    assert.ok(legacy.locationCleaned(), 'a legacy query secret is wiped too');
  });

  test('the page does not mention links, passwords or tokens', async () => {
    // The copy is part of the change: no promise of an emailed link.
    const html = readFileSync(join(here, '..', 'public', 'login.html'), 'utf8');
    assert.match(html, /an admin added you with/);
    assert.doesNotMatch(html, /send a one-time|\bpassword\b|\btoken\b/i);
  });
});
