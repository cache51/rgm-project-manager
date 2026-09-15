/**
 * What `complete` validates, and when (IR-013).
 *
 * The race the finding describes — replace the staged object between the `HEAD`
 * and the promotion — cannot be scheduled deterministically from outside. What it
 * produces can be asserted exactly, though: whether completion reads the key the
 * client still holds a capability for, or the key it has moved the object to.
 *
 * This uses an in-memory storage double so it can see which keys are read. It
 * implements the same surface as `FsStorage`, including `promote`.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './helpers.js';
import { bootstrap } from '../src/auth.js';
import { purgeProject } from '../src/admin-purge.js';

function spyStorage() {
  const objects = new Map();
  const tokens = new Map();
  const heads = [];
  let counter = 0;
  let headSize = null;
  let failPromotionAfterCopy = false;

  return {
    heads,
    objects,
    /** Force `head` to report a size, to exercise the post-promotion rejection. */
    setHeadSize: (value) => { headSize = value; },
    failNextPromotionAfterCopy: () => { failPromotionAfterCopy = true; },
    keyFor: (projectId, bugId) => `${projectId}/${bugId}/obj${++counter}`,

    presignUpload({ key, contentType }) {
      // The token must be a single path segment, so it cannot be the key itself.
      const token = `t${++counter}`;
      tokens.set(token, { key, ct: contentType });
      return { key, url: `/api/uploads/${token}`, token, headers: {},
        expiresAt: Math.floor(Date.now() / 1000) + 300 };
    },

    verifyUpload(token) {
      const claim = tokens.get(token);
      if (!claim) throw new Error('unknown capability');
      return claim;
    },

    async put(key, bytes) {
      objects.set(key, Buffer.from(bytes));
      return { key, byteSize: bytes.length };
    },
    async get(key) {
      const value = objects.get(key);
      if (!value) throw new Error(`no object at ${key}`);
      return value;
    },
    async head(key) {
      heads.push(key);
      const value = objects.get(key);
      if (!value) return null;
      return { key, byteSize: headSize ?? value.length, contentType: 'image/png' };
    },
    async delete(key) { objects.delete(key); },
    async promote(fromKey, toKey) {
      if (!objects.has(fromKey)) throw new Error(`nothing to promote at ${fromKey}`);
      objects.set(toKey, objects.get(fromKey));
      if (failPromotionAfterCopy) {
        failPromotionAfterCopy = false;
        throw new Error('simulated S3 source-delete failure after copy');
      }
      objects.delete(fromKey);
      return { key: toKey };
    }
  };
}

describe('completion validates the object that will be served (IR-013)', () => {
  test('the promoted key is what gets checked, not the staged one', async () => {
    const storage = spyStorage();
    const w = await makeWorld({ storage });
    try {
      const admin = await bootstrap(w.db, 'uploader@rgm.example');
      const client = w.newClient();
      await w.loginAs('uploader@rgm.example', client);

      const project = (await client.post('/api/projects',
        { name: 'Uploads', client: 'ACME' })).json;
      const milestone = (await client.post(`/api/projects/${project.id}/milestones`,
        { code: 'M-UP', titleEn: 'Uploads' })).json;
      const bug = (await client.post(`/api/projects/${project.id}/bugs`,
        { milestoneId: milestone.id, severity: 'high', titleVi: 'Thiếu hàng',
          bodyVi: 'Thiếu 3 thùng' })).json;

      const signed = (await client.post(`/api/bugs/${bug.id}/attachments/presign`,
        { contentType: 'image/png', byteSize: 64 })).json;
      await client.put(signed.uploadUrl, Buffer.alloc(64, 7));

      storage.heads.length = 0;              // ignore anything the presign looked at
      const done = await client.post(`/api/bugs/${bug.id}/attachments/complete`,
        { storageKey: signed.storageKey, uploadToken: signed.uploadToken,
          filename: 'shot.png' });
      assert.equal(done.status, 201, done.text);

      // The key the client holds a capability for stays valid until it expires, so
      // a `PUT` could replace it after any check made against it. The staged key is
      // read once to answer a friendly 400 for an upload that never happened; the
      // authoritative check — size and type, the values that get recorded — is made
      // against the promoted key, which the client cannot write to (IR-013).
      const stored = await w.db.query(
        `SELECT storage_key, byte_size, content_type FROM bug_attachments WHERE bug_id = $1`,
        [bug.id]);
      assert.equal(stored.rows.length, 1);
      assert.notEqual(stored.rows[0].storage_key, signed.storageKey,
        'the row must point at the promoted key, which the client cannot write to');
      assert.ok(storage.objects.has(stored.rows[0].storage_key),
        'and that key must actually hold the bytes');
      assert.equal(storage.heads.at(-1), stored.rows[0].storage_key,
        'the last check must be against the promoted key, not the staged one');
      assert.equal(typeof stored.rows[0].byte_size, 'number',
        'a bigint column comes back as a *string* from node-postgres, which is why '
        + 'byte_size is an integer (migration 006)');
      assert.equal(stored.rows[0].byte_size, 64);
      assert.equal(stored.rows[0].content_type, 'image/png');
    } finally {
      await w.close();
    }
  });

  test('a rejected upload is removed rather than orphaned', async () => {
    const storage = spyStorage();
    const w = await makeWorld({ storage });
    try {
      const admin = await bootstrap(w.db, 'uploader2@rgm.example');
      const client = w.newClient();
      await w.loginAs('uploader2@rgm.example', client);

      const project = (await client.post('/api/projects',
        { name: 'Orphans', client: 'ACME' })).json;
      const milestone = (await client.post(`/api/projects/${project.id}/milestones`,
        { code: 'M-OR', titleEn: 'Orphans' })).json;
      const bug = (await client.post(`/api/projects/${project.id}/bugs`,
        { milestoneId: milestone.id, severity: 'low', titleVi: 'a', bodyVi: 'b' })).json;

      const signed = (await client.post(`/api/bugs/${bug.id}/attachments/presign`,
        { contentType: 'image/png', byteSize: 64 })).json;
      await client.put(signed.uploadUrl, Buffer.alloc(64, 7));

      // Report an over-limit size for the object as it is found after promotion,
      // which is the path that only exists because validation now happens there.
      storage.setHeadSize(9_000_000);

      const res = await client.post(`/api/bugs/${bug.id}/attachments/complete`,
        { storageKey: signed.storageKey, uploadToken: signed.uploadToken,
          filename: 'big.png' });
      assert.equal(res.status, 400, res.text);
      assert.equal(res.json.error, 'too_large');

      assert.equal(storage.objects.size, 0,
        'the refused object must be removed, not left for nobody to reference');
      const listed = (await client.get(`/api/bugs/${bug.id}`)).json;
      assert.equal(listed.attachments.length, 0);
    } finally {
      await w.close();
    }
  });

  test('a partial promotion keeps both keys discoverable for purge', async () => {
    const storage = spyStorage();
    const w = await makeWorld({ storage });
    try {
      await bootstrap(w.db, 'promotion-failure@rgm.example');
      const client = w.newClient();
      await w.loginAs('promotion-failure@rgm.example', client);

      const project = (await client.post('/api/projects',
        { name: 'Promotion failure', client: 'ACME' })).json;
      const milestone = (await client.post(`/api/projects/${project.id}/milestones`,
        { code: 'M-PF', titleEn: 'Promotion failure' })).json;
      const bug = (await client.post(`/api/projects/${project.id}/bugs`,
        { milestoneId: milestone.id, severity: 'high', titleVi: 'a', bodyVi: 'b' })).json;
      const signed = (await client.post(`/api/bugs/${bug.id}/attachments/presign`,
        { contentType: 'image/png', byteSize: 64 })).json;
      await client.put(signed.uploadUrl, Buffer.alloc(64, 7));

      storage.failNextPromotionAfterCopy();
      const failed = await client.post(`/api/bugs/${bug.id}/attachments/complete`, {
        storageKey: signed.storageKey,
        uploadToken: signed.uploadToken,
        filename: 'partial.png'
      });
      assert.equal(failed.status, 409, failed.text);

      const finalKey = [...storage.objects.keys()].find(key => key !== signed.storageKey);
      assert.ok(finalKey, 'precondition: the external copy created the final object');
      const pending = await w.db.query(
        `SELECT storage_key, to_jsonb(pending_uploads)->>'final_storage_key' AS final_storage_key
           FROM pending_uploads WHERE storage_key = $1`, [signed.storageKey]);
      assert.equal(pending.rows.length, 1);
      assert.equal(pending.rows[0].final_storage_key, finalKey,
        'the final key must commit before the external copy is attempted');

      await purgeProject({
        db: w.db,
        storage,
        actorEmail: 'promotion-failure@rgm.example',
        projectId: project.id,
        reason: 'remove partial promotion test project',
        force: true
      });
      assert.equal(storage.objects.size, 0, 'purge must delete staging and copied final objects');
      const audit = await w.db.query(
        `SELECT metadata FROM admin_audit_log WHERE target_id = $1`, [project.id]);
      assert.deepEqual(audit.rows[0].metadata.storageKeys, [finalKey, signed.storageKey].sort());
    } finally {
      await w.close();
    }
  });
});
