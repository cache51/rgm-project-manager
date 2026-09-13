/**
 * Storage drivers: the filesystem one and the S3-compatible one.
 *
 * The S3 test runs against a local stub that VERIFIES AWS Signature Version 4
 * with its own independent implementation. Reusing the module's own encoder would
 * only prove the code agrees with itself, so the stub reimplements the canonical
 * request, the string-to-sign and the key derivation from the spec.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '../src/storage.js';
import { S3Storage } from '../src/storage-s3.js';
import { makeWorld, makeMilestone, fileBug, PNG_BYTES } from './helpers.js';

// ───────── an independent SigV4 implementation, used only to check ours ─────────

const sha256hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/** RFC 3986. Written from the spec, deliberately not imported. */
function enc(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function verifySigV4({ method, url, headers, body, accessKeyId, secretAccessKey, region }) {
  const amzDate = headers['x-amz-date'] ?? url.searchParams.get('X-Amz-Date');
  if (!amzDate) return { ok: false, reason: 'no x-amz-date' };
  const dateStamp = String(amzDate).slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;

  let signedHeaders;
  let provided;
  let credential;
  let payloadHash;

  const auth = headers.authorization;
  if (auth) {
    const m = /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/
      .exec(auth);
    if (!m) return { ok: false, reason: `malformed Authorization: ${auth}` };
    [, credential, signedHeaders, provided] = m;
    payloadHash = headers['x-amz-content-sha256'];
    if (payloadHash !== sha256hex(body)) {
      return { ok: false, reason: 'x-amz-content-sha256 does not match the body' };
    }
  } else {
    credential = url.searchParams.get('X-Amz-Credential');
    signedHeaders = url.searchParams.get('X-Amz-SignedHeaders');
    provided = url.searchParams.get('X-Amz-Signature');
    payloadHash = 'UNSIGNED-PAYLOAD';
    if (!provided) return { ok: false, reason: 'no signature' };
  }

  const expectedCredential = `${accessKeyId}/${scope}`;
  if (credential !== expectedCredential) {
    return { ok: false, reason: `credential ${credential} != ${expectedCredential}` };
  }

  const names = String(signedHeaders).split(';');
  for (const name of names) {
    if (name !== 'host' && headers[name] === undefined) {
      return { ok: false, reason: `signed header ${name} was not sent` };
    }
  }
  const canonicalHeaders = names
    .map((n) => `${n}:${String(headers[n]).trim()}\n`).join('');

  const canonicalQuery = [...url.searchParams.entries()]
    .filter(([k]) => k !== 'X-Amz-Signature')
    .map(([k, v]) => [enc(k), enc(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [method, url.pathname, canonicalQuery, canonicalHeaders,
    signedHeaders, payloadHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope,
    sha256hex(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), 's3'),
    'aws4_request');
  const expected = createHmac('sha256', key).update(stringToSign).digest('hex');

  if (expected !== provided) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}

// ───────────────────────── a minimal, signature-checking S3 stub ─────────────────

async function startS3Stub({ accessKeyId, secretAccessKey, region, bucket }) {
  const objects = new Map();
  const requests = [];
  const rejections = [];

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://127.0.0.1');
      const prefix = `/${bucket}/`;
      const key = decodeURIComponent(url.pathname.startsWith(prefix)
        ? url.pathname.slice(prefix.length) : url.pathname);
      requests.push({ method: req.method, key, url: url.toString() });

      const verdict = verifySigV4({
        method: req.method, url, headers: req.headers, body,
        accessKeyId, secretAccessKey, region
      });
      if (!verdict.ok) {
        rejections.push({ method: req.method, key, reason: verdict.reason });
        res.writeHead(403, { 'content-type': 'application/xml' });
        res.end(`<Error><Code>SignatureDoesNotMatch</Code><Message>${verdict.reason}</Message></Error>`);
        return;
      }

      if (req.method === 'PUT') {
        objects.set(key, { body, contentType: req.headers['content-type'] ?? null });
        res.writeHead(200, { etag: `"${sha256hex(body)}"` });
        res.end();
        return;
      }
      if (req.method === 'GET') {
        const o = objects.get(key);
        if (!o) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': o.contentType ?? 'application/octet-stream',
                             'content-length': o.body.length });
        res.end(o.body);
        return;
      }
      if (req.method === 'HEAD') {
        const o = objects.get(key);
        if (!o) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': o.contentType ?? '',
                             'content-length': o.body.length });
        res.end();
        return;
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(405);
      res.end();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    url: `http://127.0.0.1:${port}`,
    objects, requests, rejections,
    close: () => new Promise((r) => server.close(r))
  };
}

describe('fs storage', () => {
  let dir, storage;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rgm-fs-'));
    storage = new FsStorage({ root: dir, secret: 's' });
  });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  test('round-trips bytes and reports size', async () => {
    const key = storage.keyFor('11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222');
    assert.match(key, /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);

    await storage.put(key, PNG_BYTES);
    assert.equal((await storage.head(key)).byteSize, PNG_BYTES.length);
    assert.ok((await storage.get(key)).equals(PNG_BYTES));
    await storage.delete(key);
    assert.equal(await storage.head(key), null);
  });

  test('a tampered or expired capability is refused', async () => {
    const { token } = storage.presignUpload({ key: storage.keyFor(
      '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'),
      contentType: 'image/png' });
    assert.throws(() => storage.verifyUpload(`${token.slice(0, -2)}xx`), /signature mismatch/);
    assert.throws(() => storage.verifyUpload('garbage'), /malformed/);

    const expired = storage.presignUpload({
      key: storage.keyFor('11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333'),
      contentType: 'image/png', expiresInSeconds: -1
    });
    assert.throws(() => storage.verifyUpload(expired.token), /expired/);
  });

  test('the key shape is enforced before any filesystem access', async () => {
    await assert.rejects(
      () => storage.put('../../etc/evil', Buffer.from('x')),
      (err) => err.code === 'bad_key');
    await assert.rejects(
      () => storage.get('not-a-key-shape'),
      (err) => err.code === 'bad_key');
  });
});

describe('s3 storage', () => {
  const creds = {
    accessKeyId: 'AKIATESTTESTTESTTEST',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    bucket: 'rgm-attachments'
  };
  let stub, storage, dir;

  before(async () => {
    stub = await startS3Stub(creds);
    dir = await mkdtemp(join(tmpdir(), 'rgm-s3-'));
    storage = new S3Storage({ ...creds, endpoint: stub.url, forcePathStyle: true });
  });
  after(async () => {
    await stub.close();
    await rm(dir, { recursive: true, force: true });
  });

  test('a presigned PUT verifies against an independent implementation', async () => {
    const key = storage.keyFor('11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222');
    const signed = storage.presignUpload({ key, contentType: 'image/png' });

    const url = new URL(signed.url);
    assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
    assert.ok(url.searchParams.get('X-Amz-Signature'));
    assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'content-type;host');
    assert.ok(signed.expiresAt > Date.now() / 1000);

    // Upload exactly as a browser would: the signed headers, verbatim.
    const res = await fetch(signed.url, {
      method: 'PUT', body: PNG_BYTES, headers: signed.headers
    });
    assert.equal(res.status, 200, await res.text().catch(() => ''));
    assert.equal(stub.rejections.length, 0, JSON.stringify(stub.rejections));
  });

  test('a signature that does not cover the body is detected', async () => {
    const key = storage.keyFor('11111111-1111-1111-1111-111111111111',
      '44444444-4444-4444-4444-444444444444');
    const signed = storage.presignUpload({ key, contentType: 'image/png' });

    // Swap the path for another key: the signature no longer matches.
    const tampered = signed.url.replace(/\/([0-9a-f-]{36})$/, '/$1');
    const moved = `${tampered.split('?')[0].replace(/\/$/, '')}-other?${tampered.split('?')[1]}`;
    const res = await fetch(moved, { method: 'PUT', body: PNG_BYTES, headers: signed.headers });
    assert.equal(res.status, 403, 'a URL for a different key must not be accepted');
    assert.ok(stub.rejections.length > 0);
  });

  test('put, head, get and delete all sign correctly', async () => {
    const baseline = stub.rejections.length;
    const key = storage.keyFor('11111111-1111-1111-1111-111111111111',
      '55555555-5555-5555-5555-555555555555');

    await storage.put(key, PNG_BYTES, { contentType: 'image/png' });
    const head = await storage.head(key);
    assert.equal(head.byteSize, PNG_BYTES.length);
    assert.equal(head.contentType, 'image/png', 'the bucket reports the type back');

    assert.ok((await storage.get(key)).equals(PNG_BYTES));

    await storage.delete(key);
    assert.equal(await storage.head(key), null, 'a deleted object is gone');
    assert.equal(stub.rejections.length, baseline,
      `unexpected rejections: ${JSON.stringify(stub.rejections.slice(baseline))}`);
  });

  test('a missing object heads as null rather than throwing', async () => {
    const key = storage.keyFor('11111111-1111-1111-1111-111111111111',
      '66666666-6666-6666-6666-666666666666');
    assert.equal(await storage.head(key), null);
  });

  test('presigned downloads are signed too', async () => {
    const baseline = stub.rejections.length;
    const key = storage.keyFor('11111111-1111-1111-1111-111111111111',
      '77777777-7777-7777-7777-777777777777');
    await storage.put(key, PNG_BYTES, { contentType: 'image/png' });

    const { url } = storage.presignDownload({ key });
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES));
    assert.equal(stub.rejections.length, baseline,
      `unexpected rejections: ${JSON.stringify(stub.rejections.slice(baseline))}`);
  });
});

describe('the api on the s3 driver', () => {
  const creds = {
    accessKeyId: 'AKIATESTTESTTESTTEST',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    bucket: 'rgm-attachments'
  };
  let w, stub, ms, bug;

  before(async () => {
    stub = await startS3Stub(creds);
    const storage = new S3Storage({ ...creds, endpoint: stub.url, forcePathStyle: true });
    w = await makeWorld({ storage });
    // build a project world by hand, since makeProjectWorld makes its own world
    const { bootstrap, createProject } = await import('../src/auth.js');
    const admin = await bootstrap(w.db, 'admin@rgm.example');
    const project = await createProject(w.db, { name: 'S3', client: 'LWMS',
                                                createdBy: admin.userId });
    w.project = project;
    w.admin = admin;
    for (const [email, role] of [['dev@rgm.example', 'developer'],
                                 ['tester@rgm.example', 'tester']]) {
      const token = await w.invite({ projectId: project.id, email, role,
                                     createdBy: admin.userId });
      await w.redeem(token);
    }
    w.adminClient = await w.loginAs('admin@rgm.example');
    w.devClient = await w.loginAs('dev@rgm.example');
    w.testerClient = await w.loginAs('tester@rgm.example');
    ms = await makeMilestone(w.adminClient, project.id, 'M-S3', 'S3');
    bug = await fileBug(w.testerClient, project.id, { milestoneId: ms });
  });
  after(async () => {
    await w.close();
    await stub.close();
  });

  test('presign returns a direct-to-bucket url and no local token', async () => {
    const res = await w.testerClient.post(`/api/bugs/${bug.id}/attachments/presign`,
      { contentType: 'image/png', byteSize: PNG_BYTES.length });
    assert.equal(res.status, 201);
    assert.equal(res.json.uploadToken, null,
      'the signature is the capability; there is no local token');
    assert.ok(res.json.uploadUrl.startsWith(stub.url), 'the URL points at the bucket');
    assert.deepEqual(res.json.uploadHeaders, { 'content-type': 'image/png' });
  });

  test('the proxying upload route is not available on this driver', async () => {
    const res = await w.testerClient.put('/api/uploads/anything', PNG_BYTES);
    assert.equal(res.status, 404);
    assert.equal(res.json.error, 'no_upload_proxy');
  });

  test('a full upload through the bucket produces a downloadable attachment', async () => {
    const signed = (await w.testerClient.post(`/api/bugs/${bug.id}/attachments/presign`,
      { contentType: 'image/png', byteSize: PNG_BYTES.length })).json;

    // The browser uploads straight to storage, using the signed headers.
    const put = await fetch(signed.uploadUrl, {
      method: 'PUT', body: PNG_BYTES, headers: signed.uploadHeaders
    });
    assert.equal(put.status, 200, await put.text().catch(() => ''));

    const done = await w.testerClient.post(`/api/bugs/${bug.id}/attachments/complete`,
      { storageKey: signed.storageKey, filename: 'thùng 3.png' });
    assert.equal(done.status, 201, done.text);
    assert.equal(done.json.content_type, 'image/png');

    const payload = (await w.testerClient.get(`/api/bugs/${bug.id}`)).json;
    const att = payload.attachments.find((a) => a.id === done.json.id);
    assert.equal(att.originalFilename, 'thùng 3.png');
    assert.equal(att.name, 'screenshot_01.png');

    // The API reads it back out of the bucket and serves it.
    const download = await w.devClient.get(att.url);
    assert.equal(download.status, 200);
    assert.equal(download.contentType, 'image/png');
    assert.ok(download.buf.equals(PNG_BYTES));
  });

  test('complete refuses a key that belongs to another bug, on this driver too', async () => {
    const other = await fileBug(w.testerClient, w.project.id, { milestoneId: ms });
    const signed = (await w.testerClient.post(`/api/bugs/${other.id}/attachments/presign`,
      { contentType: 'image/png', byteSize: PNG_BYTES.length })).json;
    await fetch(signed.uploadUrl, {
      method: 'PUT', body: PNG_BYTES, headers: signed.uploadHeaders
    });

    const res = await w.testerClient.post(`/api/bugs/${bug.id}/attachments/complete`,
      { storageKey: signed.storageKey, filename: 'x.png' });
    assert.equal(res.status, 403, 'the prefix check is driver-independent');
  });

  test('complete refuses a key that was never uploaded', async () => {
    const key = `${w.project.id}/${bug.id}/99999999-9999-9999-9999-999999999999`;
    const res = await w.testerClient.post(`/api/bugs/${bug.id}/attachments/complete`,
      { storageKey: key, filename: 'ghost.png' });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'upload_missing');
  });

  test('the packet still assembles and is a valid archive', async () => {
    const baseline = stub.rejections.length;
    const packet = await w.devClient.get(`/api/bugs/${bug.id}/packet`);
    assert.equal(packet.status, 200);
    assert.equal(packet.buf.subarray(0, 2).toString(), 'PK');
    const { readZip } = await import('../src/unzip.js');
    const names = readZip(packet.buf).map((e) => e.name);
    assert.ok(names.includes('bug.md') && names.includes('meta.json'));
    assert.ok(names.some((n) => n.startsWith('screenshot_')));
    assert.equal(stub.rejections.length, baseline,
      `unexpected rejections: ${JSON.stringify(stub.rejections.slice(baseline))}`);
  });
});
