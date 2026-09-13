/**
 * The sign-in page, executed.
 *
 * This is the first screen anyone meets, and it had no test at all: the payload
 * tests never load it, so a broken sign-in or an open redirect would have shipped.
 *
 * Loads the real `public/login.js` in a stub DOM and drives both halves of the flow
 * plus both failure paths.
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

/** Load login.js as the page would, with `search` as the query string. */
function loadPage({ search = '', routes = {} } = {}) {
  const calls = [];
  const redirects = [];
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
    // A fresh vm context has the language built-ins but not the WHATWG ones the page
    // uses; a browser would have both.
    URLSearchParams,
    URL,
    document,
    location: {
      search,
      replace: (u) => redirects.push(u),
      href: `http://127.0.0.1:3000/login${search}`
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
    calls, redirects, el, form,
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

describe('login page: requesting a link', () => {
  test('submitting an address asks for a link without revealing whether it exists', async () => {
    const page = loadPage({ routes: { 'POST /api/auth/request-link': () => ({ body: { ok: true } }) } });
    await settle();
    await page.submit('someone@rgm.example');

    const post = page.calls.find((c) => c.path === '/api/auth/request-link');
    assert.ok(post, 'the request is posted');
    assert.deepEqual(post.body, { email: 'someone@rgm.example' });

    const { heading, note } = page.text();
    assert.match(heading, /inbox/i);
    assert.match(note, /If .* has access/, 'phrased so it cannot be used to probe for accounts');
    assert.doesNotMatch(note, /sent to|delivered/i);
  });

  test('the local-development hint says where the link actually goes', async () => {
    const page = loadPage({ routes: { 'POST /api/auth/request-link': () => ({ body: { ok: true } }) } });
    await settle();
    await page.submit('a@b.test');

    assert.match(page.text().hint, /server console|\[mail\]/,
      'in development the mailer prints to the log, and the page must say so');
  });

  test('the submit button is re-enabled after a failed request', async () => {
    const page = loadPage({
      routes: { 'POST /api/auth/request-link': () => { throw new Error('boom'); } }
    });
    await settle();

    await assert.rejects(() => page.submit('a@b.test'));
    assert.equal(page.el('submit').disabled, false,
      'a thrown request must not leave the form permanently disabled');
  });
});

describe('login page: consuming a sign-in link', () => {
  test('a valid token signs in and lands on the app', async () => {
    const page = loadPage({
      search: '?token=tok-123',
      routes: { 'POST /api/auth/consume': () => ({ body: { ok: true } }) }
    });
    await settle();

    const post = page.calls.find((c) => c.path === '/api/auth/consume');
    assert.ok(post, 'the token is exchanged');
    assert.deepEqual(post.body, { token: 'tok-123' });
    assert.deepEqual(page.redirects, ['/'], 'and the browser goes to the app');
    assert.equal(page.el('field').style.display, 'none', 'the form is out of the way');
  });

  test('a local next path is honoured', async () => {
    const page = loadPage({
      search: '?token=tok-123&next=/bugs',
      routes: { 'POST /api/auth/consume': () => ({ body: { ok: true } }) }
    });
    await settle();

    assert.deepEqual(page.redirects, ['/bugs']);
  });

  test('an off-site next is refused, so a link cannot be used as an open redirect', async () => {
    // The security-relevant branch: `next` must be a local path.
    for (const hostile of ['https://evil.test/', '//evil.test', 'javascript:alert(1)']) {
      const page = loadPage({
        search: `?token=tok-123&next=${encodeURIComponent(hostile)}`,
        routes: { 'POST /api/auth/consume': () => ({ body: { ok: true } }) }
      });
      await settle();

      assert.deepEqual(page.redirects, ['/'],
        `next=${hostile} must not be followed`);
    }
  });

  test('a rejected token explains itself and offers a new link', async () => {
    const page = loadPage({
      search: '?token=stale',
      routes: { 'POST /api/auth/consume': () => ({ body: { message: 'link expired' }, status: 400 }) }
    });
    await settle();

    const { heading, note, hint } = page.text();
    assert.match(heading, /did not work/i);
    assert.match(note, /link expired/, 'the server reason is shown, not just "failed"');
    assert.match(hint, /single-use|expire/i);
    assert.equal(page.el('submit').textContent, 'Send a new link');
    assert.deepEqual(page.redirects, [], 'and nobody is sent anywhere');
  });
});

describe('login page: an invitation', () => {
  test('redeeming an invitation grants membership and then asks for the email', async () => {
    const page = loadPage({
      search: '?invite=inv-9',
      routes: { 'POST /api/invites/redeem': () => ({ body: { ok: true } }) }
    });
    await settle();

    const post = page.calls.find((c) => c.path === '/api/invites/redeem');
    assert.ok(post, 'the invitation is redeemed');
    assert.deepEqual(post.body, { token: 'inv-9' });

    const { heading, note } = page.text();
    assert.match(heading, /joined/i);
    assert.match(note, /email/i, 'joining is not signing in — it asks for the address next');
    assert.equal(page.el('field').style.display, '', 'the email field comes back');
  });

  test('a rejected invitation explains the rules', async () => {
    const page = loadPage({
      search: '?invite=used',
      routes: { 'POST /api/invites/redeem': () => ({ body: { message: 'invitation already used' }, status: 400 }) }
    });
    await settle();

    const { heading, note, hint } = page.text();
    assert.match(heading, /did not work/i);
    assert.match(note, /already used/);
    assert.match(hint, /single-use|expire|cancelled/i,
      'the page explains why an invitation can stop working');
  });

  test('an invitation does not sign anyone in by itself', async () => {
    const page = loadPage({
      search: '?invite=inv-9',
      routes: { 'POST /api/invites/redeem': () => ({ body: { ok: true } }) }
    });
    await settle();

    assert.equal(page.calls.filter((c) => c.path === '/api/auth/consume').length, 0,
      'redemption is not a sign-in');
    assert.deepEqual(page.redirects, [], 'so it must not navigate to the app');
  });
});
