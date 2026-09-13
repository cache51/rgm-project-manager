/**
 * A very small HTTP toolkit: router, body readers, response helpers, cookies.
 * No framework — the API surface is ~20 routes and Node's http module is enough,
 * which keeps the whole thing dependency-free and directly testable.
 */
import { HttpError } from './auth.js';

export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler) =>
    routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });

  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    put: (p, h) => add('PUT', p, h),
    del: (p, h) => add('DELETE', p, h),

    match(method, pathname) {
      const parts = pathname.split('/').filter(Boolean);
      let pathMatched = false;
      for (const r of routes) {
        if (r.parts.length !== parts.length) continue;
        const params = {};
        let ok = true;
        for (let i = 0; i < r.parts.length; i++) {
          const seg = r.parts[i];
          if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
          else if (seg !== parts[i]) { ok = false; break; }
        }
        if (!ok) continue;
        pathMatched = true;
        if (r.method === method) return { handler: r.handler, params, allowed: null };
      }
      return pathMatched ? { handler: null, params: null, allowed: 'method' } : null;
    }
  };
}

export async function readBytes(req, { limit = 8_000_000 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'too_large', `body exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, opts) {
  const buf = await readBytes(req, opts);
  if (!buf.length) return {};
  try {
    const parsed = JSON.parse(buf.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'bad_json', 'body must be a JSON object');
    }
    return parsed;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'bad_json', 'body is not valid JSON');
  }
}

export function sendJson(res, status, obj, headers = {}) {
  const body = Buffer.from(JSON.stringify(obj ?? null));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    ...headers
  });
  res.end(body);
}

export function sendBytes(res, status, bytes, contentType, headers = {}) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    ...headers
  });
  res.end(body);
}

export function redirect(res, location, headers = {}) {
  res.writeHead(302, { location, ...headers });
  res.end();
}

// ───────────────────────── cookies ─────────────────────────

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, httpOnly = true, secure = false,
                                               sameSite = 'Lax', path = '/' } = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) bits.push('HttpOnly');
  if (secure) bits.push('Secure');
  if (maxAge !== undefined) bits.push(`Max-Age=${maxAge}`);
  return bits.join('; ');
}

// ───────────────────────── request context ─────────────────────────

const BEARER = /^Bearer\s+(.+)$/i;

/**
 * Resolve the actor for a request: API token first (the CLI path), then session
 * cookie. Neither is required — routes decide whether an anonymous caller is
 * acceptable.
 */
export async function resolveActor(req, { db, resolveSession, resolveApiToken }) {
  const header = req.headers.authorization ?? '';
  const bearer = header.match(BEARER);
  if (bearer) {
    const actor = await resolveApiToken(db, bearer[1]);
    return actor ?? null;
  }
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.session) return (await resolveSession(db, cookies.session)) ?? null;
  return null;
}

/** Wrap a handler so thrown domain errors become clean JSON responses. */
export function handle(fn) {
  return async (req, res, ctx) => {
    try {
      await fn(req, res, ctx);
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      if (err instanceof HttpError) {
        const body = { error: err.code, message: err.message };
        const headers = {};
        if (err.retryAfter) {
          body.retryAfter = err.retryAfter;
          headers['retry-after'] = String(err.retryAfter);
        }
        if (err.details) body.details = err.details;
        sendJson(res, err.status, body, headers);
        return;
      }
      // Domain errors carry a stable code; map them onto status codes rather than
      // letting a rejected transition surface as an internal error.
      if (err?.name === 'TransitionError') {
        sendJson(res, 409, { error: err.code ?? 'illegal_transition', message: err.message });
        return;
      }
      if (err?.name === 'StorageError') {
        sendJson(res, 400, { error: err.code ?? 'storage_error', message: err.message });
        return;
      }
      if (err instanceof RangeError) {
        sendJson(res, 400, { error: 'bad_request', message: err.message });
        return;
      }
      // Unexpected errors are reported without leaking internals.
      sendJson(res, 500, { error: 'internal_error', message: 'unexpected server error' });
      if (ctx?.onError) ctx.onError(err);
    }
  };
}
