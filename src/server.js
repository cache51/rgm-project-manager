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
import { FsStorage } from './storage.js';
import { buildRoutes } from './api.js';
import { resolveActor, sendJson, sendBytes, redirect, parseCookies,
         serializeCookie } from './http.js';
import { resolveSession, resolveApiToken } from './auth.js';

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
  onError = null
}) {
  const router = buildRoutes();

  const server = createServer((req, res) => {
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
    if (!match) {
      sendJson(res, 404, { error: 'not_found', message: 'no such endpoint' });
      return;
    }
    if (match.allowed === 'method') {
      sendJson(res, 405, { error: 'method_not_allowed', message: `${req.method} not supported` });
      return;
    }

    const ctx = {
      db, storage, deliver, secureCookies, onError, url,
      params: match.params,
      actor: null
    };

    // Resolve identity before the handler so every route sees the same actor.
    resolveActor(req, { db, resolveSession, resolveApiToken })
      .then((actor) => {
        ctx.actor = actor;
        return match.handler(req, res, ctx);
      })
      .catch((err) => {
        if (!res.headersSent) {
          sendJson(res, 500, { error: 'internal_error', message: 'unexpected server error' });
        } else {
          res.end();
        }
        if (onError) onError(err);
      });
  });

  return { server, router };
}

/** Build a fully-wired app backed by a real (PGlite) database. */
export async function createAppFromEnv(env = process.env) {
  const db = env.PGLITE_DIR
    ? await createDb({ dataDir: env.PGLITE_DIR })
    : await createDb();
  await migrate(db);

  const storage = new FsStorage({
    root: env.STORAGE_DIR ?? './.rgm/storage',
    secret: env.STORAGE_SECRET ?? 'dev-secret-change-me'
  });

  // Default mailer: log the link. Production replaces this with an SMTP client.
  const deliver = async (msg) => {
    process.stdout.write(`[mail] to=${msg.to} kind=${msg.kind} token=${msg.token}\n`);
  };

  return { ...createApp({ db, storage, deliver }), db, storage };
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
  const { url } = await listen(app, { port: Number(process.env.PORT ?? 3000) });
  process.stdout.write(`RGM Project Manager listening on ${url}\n`);
  const shutdown = () => app.server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
