/**
 * Application assembly and HTTP server.
 *
 * `createApp` is deliberately dependency-injected so tests can drive the real
 * server over a real socket with a real database, and production can swap the
 * storage, mailer and database without touching routes.
 */
import { createServer } from 'node:http';
import { createDb, migrate } from './db.js';
import { FsStorage } from './storage.js';
import { buildRoutes } from './api.js';
import { resolveActor, sendJson } from './http.js';
import { resolveSession, resolveApiToken } from './auth.js';

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
