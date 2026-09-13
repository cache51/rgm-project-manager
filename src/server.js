/**
 * Application assembly and HTTP server.
 *
 * `createApp` is deliberately dependency-injected so tests can drive the real
 * server over a real socket with a real database, and production can swap the
 * storage, mailer and database without touching routes.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve, extname, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, migrate } from './db.js';
import { buildRoutes, PUBLIC, UNSPECIFIED } from './api.js';
import { resolveActor, sendJson, sendBytes } from './http.js';
import { resolveSession, resolveApiToken, verifyCsrfToken, HttpError } from './auth.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Routes where the session cookie is not the source of authority, so a CSRF
 * token cannot be required:
 *   - the two sign-in endpoints run before a session exists
 *   - upload URLs carry a signed capability, which a cross-site page cannot guess
 */
const CSRF_EXEMPT = [
  /^\/api\/auth\/request-link$/,
  /^\/api\/auth\/consume$/,
  /^\/api\/uploads\//,
  // Capability-addressed: the invitation token IS the authority, and it is a
  // single-use secret an attacker cannot guess. Requiring a CSRF header here made
  // redemption depend on unrelated ambient state — a signed-in user (whose
  // browser attaches a session cookie) was refused while an anonymous one
  // succeeded, which is why joining a project failed for exactly the people most
  // likely to do it (IR-017).
  /^\/api\/invites\/redeem$/
];

export function csrfRequired(method, pathname) {
  if (SAFE_METHODS.has(method)) return false;
  return !CSRF_EXEMPT.some((re) => re.test(pathname));
}

const here = dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = join(here, '..', 'public');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

/**
 * Serve a file from public/.
 *
 * The path is decoded, resolved and then checked to be inside PUBLIC_DIR, so
 * neither `../` nor a percent-encoded `%2e%2e%2f` can escape the directory.
 */
async function serveStatic(pathname, res) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 400, { error: 'bad_path', message: 'malformed path' });
    return;
  }
  rel = rel.replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  else if (!extname(rel)) rel += '.html';

  const target = resolve(PUBLIC_DIR, rel);
  const inside = target === PUBLIC_DIR || target.startsWith(PUBLIC_DIR + sep);
  if (!inside) {
    sendJson(res, 403, { error: 'forbidden', message: 'path escapes the public directory' });
    return;
  }

  try {
    const data = await readFile(target);
    sendBytes(res, 200, data, CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
      { 'cache-control': 'no-store' });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      sendJson(res, 404, { error: 'not_found', message: 'no such file' });
      return;
    }
    throw err;
  }
}

export function createApp({
  db,
  storage,
  deliver = null,
  secureCookies = false,
  limits = null,
  onError = null
}) {
  const router = buildRoutes();

  const server = createServer((req, res) => {
    // Nothing may escape the listener body. This callback runs in the HTTP server,
    // not inside a promise, so any uncaught throw is an unhandled exception and
    // takes the whole process down — reachable with a single unauthenticated
    // request. `handleRequest` throws on purpose in places; the guard is the
    // backstop that makes a bug there a 500 instead of an outage.
    try {
      handleRequest(req, res);
    } catch (err) {
      if (onError) onError(err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal_error', message: 'unexpected server error' });
      } else {
        res.end();
      }
    }
  });

  function handleRequest(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      sendJson(res, 400, { error: 'bad_url', message: 'malformed request target' });
      return;
    }

    // Everything outside /api/ is a static asset. The UI is plain files served by
    // this same process, so there is no build step and no second origin.
    if (!url.pathname.startsWith('/api')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method_not_allowed', message: 'static files are GET-only' });
        return;
      }
      serveStatic(url.pathname, res).catch((err) => {
        if (!res.headersSent) {
          sendJson(res, 500, { error: 'internal_error', message: 'unexpected server error' });
        }
        if (onError) onError(err);
      });
      return;
    }

    const match = router.match(req.method, url.pathname);
    if (match?.malformed) {
      // The path contained an escape sequence that is not valid UTF-8. Answering
      // 400 is the whole point of `match` returning it rather than throwing.
      sendJson(res, 400, { error: 'bad_request', message: 'malformed URL escape' });
      return;
    }
    if (!match) {
      sendJson(res, 404, { error: 'not_found', message: 'no such endpoint' });
      return;
    }
    if (match.allowed === 'method') {
      sendJson(res, 405, { error: 'method_not_allowed', message: `${req.method} not supported` });
      return;
    }

    const ctx = {
      db, storage, deliver, secureCookies, limits, onError, url,
      params: match.params,
      actor: null
    };

    // Resolve identity before the handler so every route sees the same actor.
    resolveActor(req, { db, resolveSession, resolveApiToken })
      .then((actor) => {
        ctx.actor = actor;

        // Token scopes, from the route's policy. A signed-in browser is the user's
        // full authority and is not scoped; a token is narrowed. This never grants
        // more than the user has — `authorize` still runs the membership check
        // inside every handler.
        if (actor?.via === 'api_token') {
          if (match.scope === UNSPECIFIED) {
            throw new HttpError(403, 'no_scope_policy',
              'this route has no scope policy; refusing to guess');
          }
          if (match.scope && match.scope !== PUBLIC && !actor.scopes?.includes(match.scope)) {
            throw new HttpError(403, 'insufficient_scope',
              `this token lacks the ${match.scope} scope`);
          }
        }

        // A cookie-authenticated write must prove it read the CSRF cookie. This
        // is the one place it is checked, so no route can forget it. Bearer
        // tokens are exempt: they are not attached automatically by a browser.
        if (csrfRequired(req.method, url.pathname) && actor?.via === 'session'
            && !verifyCsrfToken(actor, req.headers['x-csrf-token'])) {
          throw new HttpError(403, 'csrf_failed',
            'missing or invalid CSRF token; send x-csrf-token from the csrf cookie');
        }
        return match.handler(req, res, ctx);
      })
      .catch((err) => {
        if (res.headersSent) { res.end(); return; }
        if (err instanceof HttpError) {
          sendJson(res, err.status, { error: err.code, message: err.message });
          return;
        }
        sendJson(res, 500, { error: 'internal_error', message: 'unexpected server error' });
        if (onError) onError(err);
      });
  }

  return { server, router };
}

/** Build a fully-wired app from the environment. */
export async function createAppFromEnv(env = process.env) {
  const { loadConfig } = await import('./config.js');
  const config = loadConfig(env);

  const db = await createDb({ dataDir: config.dataDir, url: config.databaseUrl });
  if (config.migrateOnStart) await migrate(db);

  const app = createApp({
    db,
    storage: config.storage,
    deliver: config.deliver,
    secureCookies: config.secureCookies
  });

  return { ...app, db, config };
}

/** Start listening; resolves once the socket is open. */
export async function listen(app, { port = 3000, host = '127.0.0.1' } = {}) {
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, host, resolve);
  });
  const addr = app.server.address();
  return { url: `http://${host}:${addr.port}`, port: addr.port };
}

// Run directly: `npm start`
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await createAppFromEnv();
  const { url } = await listen(app, { port: app.config.port, host: app.config.host });

  process.stdout.write(`RGM Project Manager listening on ${url}\n`);
  // State what was chosen, so "which mailer is this using?" is answered at boot
  // rather than discovered in production.
  for (const [key, value] of Object.entries(app.config.describe())) {
    process.stdout.write(`  ${key}: ${value}\n`);
  }

  const shutdown = () => app.server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
