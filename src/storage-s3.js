/**
 * S3-compatible object storage (AWS S3, MinIO, Cloudflare R2, Backblaze B2 …).
 *
 * Implements the same surface as FsStorage so the swap is a one-line change in
 * the assembly, with one difference: uploads go DIRECTLY from the browser to the
 * bucket, so there is no proxied `/api/uploads/:token` hop and no local token to
 * verify. The presigned URL *is* the capability — its signature is what the
 * bucket checks.
 *
 * AWS Signature Version 4 is implemented here rather than pulled in as a
 * dependency, and `test/storage.test.js` verifies it by recomputing the signature
 * server-side, so the signing is exercised rather than assumed.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding. encodeURIComponent leaves !'()* which SigV4 does not allow. */
const uriEncode = (value) => encodeURIComponent(String(value))
  .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Encode a path, keeping the separators. */
const encodePath = (path) => path.split('/').map(uriEncode).join('/');

const amzDate = (date) => date.toISOString().replace(/[:-]|\.\d{3}/g, '');

export function signingKey(secretAccessKey, dateStamp, region, service = SERVICE) {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service),
    'aws4_request');
}

export class S3Storage {
  constructor({
    endpoint,
    bucket,
    region = 'us-east-1',
    accessKeyId,
    secretAccessKey,
    forcePathStyle = true,
    fetchImpl = fetch
  }) {
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      throw new Error('S3Storage needs endpoint, bucket, accessKeyId and secretAccessKey');
    }
    this.endpoint = String(endpoint).replace(/\/+$/, '');
    this.bucket = bucket;
    this.region = region;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.forcePathStyle = forcePathStyle;
    this.fetch = fetchImpl;
  }

  /** Same shape as FsStorage: server-chosen, never derived from a filename. */
  keyFor(projectId, bugId) {
    return `${projectId}/${bugId}/${randomUUID()}`;
  }

  #host() {
    return new URL(this.endpoint).host;
  }

  /** Path-style (`host/bucket/key`) is what MinIO and friends expect. */
  #objectUrl(key) {
    const suffix = this.forcePathStyle ? `/${this.bucket}/${encodePath(key)}` : `/${encodePath(key)}`;
    return new URL(suffix, this.endpoint);
  }

  #scope(dateStamp) {
    return `${dateStamp}/${this.region}/${SERVICE}/aws4_request`;
  }

  /**
   * Build the SigV4 signature for a request.
   * Returned separately from the fetch so tests can reproduce it.
   */
  sign({ method, url, headers, payloadHash, now = new Date() }) {
    const stamp = amzDate(now);
    const dateStamp = stamp.slice(0, 8);

    const canonicalHeaders = Object.keys(headers)
      .map((name) => name.toLowerCase())
      .sort()
      .map((name) => `${name}:${String(headers[name]).trim()}\n`)
      .join('');
    const signedHeaders = Object.keys(headers)
      .map((name) => name.toLowerCase()).sort().join(';');

    const canonicalQuery = [...url.searchParams.entries()]
      .map(([k, v]) => [uriEncode(k), uriEncode(v)])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');

    const canonicalRequest = [
      method,
      url.pathname,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join('\n');

    const stringToSign = [
      ALGORITHM, stamp, this.#scope(dateStamp), sha256Hex(canonicalRequest)
    ].join('\n');

    const signature = createHmac('sha256',
      signingKey(this.secretAccessKey, dateStamp, this.region))
      .update(stringToSign).digest('hex');

    const authorization = `${ALGORITHM} Credential=${this.accessKeyId}/${this.#scope(dateStamp)}, `
      + `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return { signature, authorization, signedHeaders, canonicalRequest, stringToSign, stamp };
  }

  /** A signed request to send now. */
  async #send(method, url, { payload = Buffer.alloc(0), contentType = null, extra = {} } = {}) {
    const headers = { host: this.#host(), ...extra };
    if (contentType) headers['content-type'] = contentType;

    const payloadHash = method === 'GET' || method === 'HEAD'
      ? sha256Hex('')
      : sha256Hex(payload);

    const date = new Date();
    headers['x-amz-date'] = amzDate(date);
    headers['x-amz-content-sha256'] = payloadHash;

    const { authorization } = this.sign({ method, url, headers, payloadHash, now: date });
    headers.authorization = authorization;

    const res = await this.fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : payload
    });
    return res;
  }

  /**
   * Presign a PUT. The bucket validates the signature, so no local token exists —
   * the caller uploads straight to the returned URL.
   */
  presignUpload({ key, contentType, expiresInSeconds = 300, now = new Date() }) {
    const url = this.#objectUrl(key);
    const stamp = amzDate(now);
    const dateStamp = stamp.slice(0, 8);

    url.searchParams.set('X-Amz-Algorithm', ALGORITHM);
    url.searchParams.set('X-Amz-Credential', `${this.accessKeyId}/${this.#scope(dateStamp)}`);
    url.searchParams.set('X-Amz-Date', stamp);
    url.searchParams.set('X-Amz-Expires', String(expiresInSeconds));
    url.searchParams.set('X-Amz-SignedHeaders', 'content-type;host');

    // The signature must cover content-type, or a client could upload anything.
    const headers = { host: this.#host(), 'content-type': contentType };
    const { signature } = this.sign({
      method: 'PUT', url, headers, payloadHash: UNSIGNED_PAYLOAD, now
    });
    url.searchParams.set('X-Amz-Signature', signature);

    return {
      key,
      url: url.toString(),
      // The browser must send exactly these signed headers.
      headers: { 'content-type': contentType },
      expiresAt: Math.floor(now.getTime() / 1000) + expiresInSeconds
    };
  }

  /** A presigned GET, so the API can redirect instead of proxying bytes. */
  presignDownload({ key, expiresInSeconds = 300, now = new Date() }) {
    const url = this.#objectUrl(key);
    const stamp = amzDate(now);
    const dateStamp = stamp.slice(0, 8);

    url.searchParams.set('X-Amz-Algorithm', ALGORITHM);
    url.searchParams.set('X-Amz-Credential', `${this.accessKeyId}/${this.#scope(dateStamp)}`);
    url.searchParams.set('X-Amz-Date', stamp);
    url.searchParams.set('X-Amz-Expires', String(expiresInSeconds));
    url.searchParams.set('X-Amz-SignedHeaders', 'host');

    const { signature } = this.sign({
      method: 'GET', url, headers: { host: this.#host() },
      payloadHash: UNSIGNED_PAYLOAD, now
    });
    url.searchParams.set('X-Amz-Signature', signature);

    return {
      url: url.toString(),
      expiresAt: Math.floor(now.getTime() / 1000) + expiresInSeconds
    };
  }

  async put(key, bytes, { contentType = 'application/octet-stream' } = {}) {
    const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const res = await this.#send('PUT', this.#objectUrl(key), { payload: body, contentType });
    if (!res.ok) {
      throw new Error(`S3 PUT ${key} failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
    return { key, byteSize: body.length };
  }

  async get(key) {
    const res = await this.#send('GET', this.#objectUrl(key));
    if (!res.ok) {
      throw new Error(`S3 GET ${key} failed: ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /** @returns {Promise<{byteSize:number, contentType:string|null}|null>} */
  async head(key) {
    const res = await this.#send('HEAD', this.#objectUrl(key));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 HEAD ${key} failed: ${res.status}`);
    const length = res.headers.get('content-length');
    return {
      key,
      byteSize: length === null ? null : Number(length),
      contentType: res.headers.get('content-type')
    };
  }

  async delete(key) {
    const res = await this.#send('DELETE', this.#objectUrl(key));
    if (!res.ok && res.status !== 404) {
      throw new Error(`S3 DELETE ${key} failed: ${res.status}`);
    }
  }

  /**
   * Server-side copy, then remove the source.
   *
   * RGM3-005: the presigned PUT the client holds stays valid until it expires, so
   * the object it validated must not be the object later served. Copying to a key
   * no capability was ever issued for closes that window — and doing it
   * server-side means the bytes never pass through the app.
   */
  async promote(fromKey, toKey) {
    const url = this.#objectUrl(toKey);
    const headers = {
      host: this.#host(),
      // CopyObject takes the source as a signed header, not a path segment.
      'x-amz-copy-source': `/${this.bucket}/${encodePath(fromKey)}`,
      'x-amz-metadata-directive': 'COPY'
    };
    const payloadHash = sha256Hex('');
    headers['x-amz-content-sha256'] = payloadHash;
    const date = new Date();
    headers['x-amz-date'] = amzDate(date);

    const { authorization } = this.sign({
      method: 'PUT', url, headers, payloadHash, now: date
    });
    headers.authorization = authorization;

    const res = await this.fetch(url, { method: 'PUT', headers });
    if (!res.ok) {
      throw new Error(`S3 COPY ${fromKey} → ${toKey} failed: ${res.status} `
        + `${await res.text().catch(() => '')}`);
    }
    await this.delete(fromKey);
    return { key: toKey };
  }
}
