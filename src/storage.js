/**
 * Object storage for screenshots.
 *
 * The interface is deliberately the shape an S3/MinIO client has (put/get/delete
 * plus presigned URLs), so moving to a real bucket means implementing this class
 * against the SDK rather than touching callers.
 *
 * Two-phase upload is what makes the "no multipart parser" design work:
 *   1. the client requests an upload URL for a key the SERVER chooses
 *   2. the client PUTs raw bytes to that URL
 *   3. the client calls `complete`, and the server HEADs the object
 * A presigned PUT is a capability, so the token binds key + content-type + expiry
 * and is HMAC-signed (RGM3-004).
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class StorageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

export class FsStorage {
  #secret;

  constructor({ root, secret = 'dev-secret-change-me' }) {
    this.root = root;
    this.#secret = secret;
  }

  #sign(data) {
    return createHmac('sha256', this.#secret).update(data).digest('base64url');
  }

  /** Server-assigned key. Never derived from a tester-supplied filename. */
  keyFor(projectId, bugId) {
    return `${projectId}/${bugId}/${randomUUID()}`;
  }

  #path(key) {
    if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(key)) {
      throw new StorageError('bad_key', `refusing to touch unexpected key shape: ${key}`);
    }
    return join(this.root, key);
  }

  /** Issue a signed PUT capability bound to the key, type and expiry. */
  presignUpload({ key, contentType, expiresInSeconds = 300 }) {
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const body = Buffer.from(JSON.stringify({ key, ct: contentType, exp })).toString('base64url');
    const token = `${body}.${this.#sign(body)}`;
    return {
      key,
      // This driver proxies the upload, so the URL points back at our own API.
      url: `/api/uploads/${encodeURIComponent(token)}`,
      token,
      headers: { 'content-type': contentType },
      expiresAt: exp
    };
  }

  /** Verify a PUT capability. Throws rather than returning a falsy value. */
  verifyUpload(token) {
    const [body, sig] = String(token ?? '').split('.');
    if (!body || !sig) throw new StorageError('bad_token', 'malformed upload token');
    const expected = this.#sign(body);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new StorageError('bad_signature', 'upload token signature mismatch');
    }
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (claims.exp < Math.floor(Date.now() / 1000)) {
      throw new StorageError('expired', 'upload token expired');
    }
    return claims;
  }

  async put(key, bytes) {
    const p = this.#path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
    return { key, byteSize: bytes.length };
  }

  async get(key) {
    return readFile(this.#path(key));
  }

  async head(key) {
    try {
      const s = await stat(this.#path(key));
      return { key, byteSize: s.size };
    } catch {
      return null;
    }
  }

  async delete(key) {
    await rm(this.#path(key), { force: true });
  }
}
