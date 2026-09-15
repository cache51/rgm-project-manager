/**
 * The stub DOM the UI is executed in.
 *
 * Shared deliberately. `test/ui-dom.test.js` and `test/ui-manage.test.js` both drive
 * the real `public/app.js`, and a second, hand-rolled copy of this harness is how a
 * test came to pass for the wrong reason: the copy omitted `document.cookie`, so every
 * `api()` call threw, the screen rendered nothing, and "no forbidden control is shown"
 * was trivially true against an empty page. One harness, one set of behaviours.
 *
 * The app reaches only for document/location/fetch/navigator.clipboard/URL, so no
 * browser and no dependency is needed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
export const SOURCE = readFileSync(join(here, '..', 'public', 'app.js'), 'utf8');

/** Let every pending microtask and timer callback run. */
export async function settle(times = 60) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

/**
 * Load app.js in a stub DOM.
 *
 * `routes` maps "METHOD /path" to either a payload, or a function receiving the
 * recorded call and returning { body, status, headers }.
 */
export function loadApp({ routes = {}, stored = {}, browserLang = '' } = {}) {
  const calls = [];
  const fields = new Map();
  const copied = [];
  const downloads = [];
  const listeners = {};
  const timers = [];
  const redirects = [];
  const promptAnswer = { value: '' };
  // Removals ask for confirmation first. The harness answers it so both branches can
  // be driven: a declined confirmation must send nothing at all.
  const confirmAnswer = { value: true };

  // A tiny localStorage: the app remembers the language choice, and that has to be
  // assertable without a browser.
  const store = new Map(Object.entries(stored));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };

  const decodeHtml = (value) => String(value ?? '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  const renderedValue = (id) => {
    const input = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
    if (input) return decodeHtml(input[0].match(/\bvalue="([^"]*)"/)?.[1] ?? '');
    const textarea = html.match(new RegExp(`<textarea[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/textarea>`));
    if (textarea) return decodeHtml(textarea[1]);
    const select = html.match(new RegExp(`<select[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/select>`));
    if (select) {
      const selected = select[1].match(/<option[^>]*value="([^"]*)"[^>]*selected[^>]*>/)
        ?? select[1].match(/<option[^>]*value="([^"]*)"[^>]*>/);
      return decodeHtml(selected?.[1] ?? '');
    }
    return '';
  };

  const field = (id) => {
    if (!fields.has(id)) fields.set(id, { id, value: renderedValue(id), files: [] });
    return fields.get(id);
  };

  let html = '';
  const appEl = {
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value;
      // Replacing innerHTML creates new controls in a browser. In particular, a
      // file input is empty after a re-render and must be filled again by the user.
      fields.clear();
    },
    addEventListener: (ev, fn) => { listeners[ev] = fn; }
  };

  const document = {
    getElementById: (id) => (id === 'app' ? appEl : field(id)),
    addEventListener: () => {},
    querySelector: () => null,
    // Reads as '' unless a test sets a cookie; without this key every api() call
    // throws before a request is even made.
    cookie: '',
    body: { appendChild() {} },
    createRange: () => ({ selectNodeContents() {} }),
    createElement: () => ({
      href: '', download: '', style: {},
      click() { downloads.push({ href: this.href, download: this.download }); },
      remove() {}, appendChild() {}
    })
  };

  const respond = (body, status = 200, headers = {}) => {
    const h = { 'content-type': 'application/json', ...headers };
    return {
      ok: status < 400,
      status,
      headers: { get: (k) => h[String(k).toLowerCase()] ?? null },
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body, null, 2)),
      blob: async () => ({ size: typeof body === 'string' ? body.length : 4096 })
    };
  };

  const ctx = {
    console,
    setTimeout: (fn, ms, ...args) => {
      if (ms >= 4000) { timers.push(() => fn(...args)); return timers.length; }
      return setTimeout(fn, ms, ...args);
    },
    clearTimeout, setInterval, clearInterval,
    document,
    location: { replace: (u) => redirects.push(u), href: 'http://127.0.0.1:3000/' },
    navigator: { clipboard: { writeText: async (t) => { copied.push(t); } }, language: browserLang },
    localStorage,
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL() {} },
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    // The status-change reason comes from a window.prompt dialog — see transition()
    // in app.js. The harness answers it so the flow can be driven.
    prompt: () => promptAnswer.value,
    confirm: () => confirmAnswer.value,
    fetch: async (path, opts = {}) => {
      const method = (opts.method ?? 'GET').toUpperCase();
      // A JSON body is a string and is recorded parsed; an upload body is a File.
      // Snapshot its metadata instead of retaining a mutable, potentially large body.
      const call = opts.body === undefined ? { method, path, body: null }
        : typeof opts.body === 'string'
          ? { method, path, body: JSON.parse(opts.body) }
          : { method, path, body: null, file: {
              name: opts.body.name, size: opts.body.size, type: opts.body.type,
              lastModified: opts.body.lastModified
            } };
      calls.push(call);

      const route = routes[`${method} ${path}`];
      if (typeof route === 'function') {
        const out = (await route(call)) ?? {};
        return respond(out.body ?? {}, out.status ?? 200, out.headers);
      }
      // A plain value is the payload. Nothing is inferred from its shape: a bug
      // payload has a `status` field ('new'), and an earlier version of this harness
      // mistook that for a response descriptor — so `res.status` became the string
      // 'new' and the app threw it as an error message. Use a function when the
      // status or headers matter.
      if (route !== undefined) return respond(route);
      return respond({}, 200);
    }
  };
  ctx.window = ctx;

  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx, { filename: 'public/app.js' });

  return {
    calls, copied, downloads, listeners, fields, redirects, promptAnswer, confirmAnswer, store,
    ctx,
    html: () => appEl.innerHTML,
    field: (id) => field(id),
    runTimers() { while (timers.length) timers.shift()(); },
    apiCalls: () => calls.filter((c) => String(c.path).startsWith('/api/')),
    input(id, value) {
      const el = field(id);
      el.value = value;
      listeners.input?.({ target: el });
    },
    /** Invoke the app's delegated click handler as a browser would. */
    async click(action, dataset = {}) {
      const el = { dataset: { action, ...dataset } };
      await listeners.click({
        target: { closest: () => el },
        preventDefault() {}
      });
      await settle();
    }
  };
}
