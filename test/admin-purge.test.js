/**
 * The host-authorized hard-purge operation.
 *
 * Three properties must hold:
 *
 *   1. Site-admin only — a project-level admin gets 403.
 *   2. A purge is refused on a project that has not been soft-deleted first.
 *      The audit trail is intact until the operator confirms the soft delete.
 *   3. The events trigger is restored after the cleanup. If it weren't, a later
 *      audit-trail INSERT could be silently UPDATEd or DELETEd by a future
 *      caller, and the protection would never be noticed until an investigation
 *      turned it back on.
 *
 * The CLI command is exercised separately; the HTTP server intentionally has no
 * permanent-delete route.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeProjectWorld, PNG_BYTES } from './helpers.js';
import { cleanPendingStorage } from '../scripts/cleanup-storage.mjs';
import { purgeProject, AdminPurgeError } from '../src/admin-purge.js';

let w, siteAdminClient, projectAdminClient, projectId;

async function purge(id, body = {}, actorEmail = 'admin@rgm.example') {
  try {
    const purged = await purgeProject({
      db: w.db, storage: w.storage, actorEmail, projectId: id,
      reason: body.reason, force: body.force === true, onError: () => {}
    });
    return { status: 200, json: { ok: true, purged }, text: JSON.stringify(purged) };
  } catch (err) {
    if (!(err instanceof AdminPurgeError)) throw err;
    return { status: err.status, json: { error: err.code, message: err.message }, text: err.message };
  }
}

describe('purging a project', () => {
  before(async () => {
    w = await makeProjectWorld({ onError: () => {} });

    // makeProjectWorld already created admin@rgm.example as a site admin and
    // signed it in. That is the only site admin we need.
    siteAdminClient = w.adminClient;

    // A *second* project, with dev@rgm.example as its project-level admin (NOT
    // a site admin).
    const secondProject = await siteAdminClient.post(`/api/projects`,
      { name: 'Disposable', client: 'RGM', env: 'staging' });
    assert.equal(secondProject.status, 201, secondProject.text);
    projectId = secondProject.json.id;

    // Promote dev to admin on the second project so the role check matters.
    const promoted = await siteAdminClient.post(`/api/projects/${projectId}/members`,
      { email: 'dev@rgm.example', name: 'Dev', role: 'admin' });
    assert.equal(promoted.status, 201, promoted.text);

    // Add the tester to the second project so they can file reports against it.
    const testerAdded = await siteAdminClient.post(`/api/projects/${projectId}/members`,
      { email: 'tester@rgm.example', name: 'Tester', role: 'tester' });
    assert.equal(testerAdded.status, 201, testerAdded.text);

    // Re-sign the affected users so the new role is bound to their sessions.
    projectAdminClient = await w.loginAs('dev@rgm.example');
    w.testerClient = await w.loginAs('tester@rgm.example');
  });

  after(async () => { if (w) await w.close(); });

  test('a project-level admin is not a site admin and is refused', async () => {
    const res = await purge(projectId,
      { reason: 'measured against role escalation' }, 'dev@rgm.example');
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'not_site_admin');
  });

  test('the HTTP server exposes no permanent-delete route', async () => {
    const res = await siteAdminClient.post(`/api/admin/projects/${projectId}/purge`,
      { reason: 'browser email sign-in is not purge authority' });
    assert.equal(res.status, 404);
  });

  test('a missing or short reason is refused before any SQL runs', async () => {
    const tooShort = await purge(projectId, { reason: 'too short' });
    assert.equal(tooShort.status, 400);
    assert.equal(tooShort.json.error, 'bad_reason');

    const missing = await purge(projectId, {});
    assert.equal(missing.status, 400);
    assert.equal(missing.json.error, 'bad_reason');
  });

  test('a live project cannot be purged — soft delete must come first', async () => {
    const res = await purge(projectId, { reason: 'must do the soft delete first' });
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'not_removed');
  });

  test('force purging removes a live row, records force, and leaves the events trigger armed', async () => {
    // Add a milestone + bug so the events table has something to drop.
    const milestone = await w.adminClient.post(`/api/projects/${projectId}/milestones`,
      { code: 'M1', titleEn: 'First cut' });
    const milestoneId = milestone.json.id;
    const bug = await w.testerClient.post(`/api/projects/${projectId}/bugs`, {
      milestoneId, severity: 'high',
      titleVi: 'Thiếu 3 thùng', bodyVi: 'Kho thiếu 3 thùng ở mã hàng A2.'
    });
    assert.equal(bug.status, 201, bug.text);

    const presign = await w.testerClient.post(
      `/api/bugs/${bug.json.id}/attachments/presign`,
      { contentType: 'image/png', byteSize: PNG_BYTES.length });
    assert.equal(presign.status, 201, presign.text);
    await w.testerClient.put(presign.json.uploadUrl, PNG_BYTES);
    const completed = await w.testerClient.post(
      `/api/bugs/${bug.json.id}/attachments/complete`, {
        storageKey: presign.json.storageKey,
        uploadToken: presign.json.uploadToken,
        filename: 'purge-proof.png'
      });
    assert.equal(completed.status, 201, completed.text);
    const attachmentKey = await w.db.query(
      `SELECT storage_key FROM bug_attachments WHERE id = $1`, [completed.json.id])
      .then(r => r.rows[0].storage_key);
    assert.ok(await w.storage.head(attachmentKey),
      'precondition: attachment object exists');

    // Pre-condition: events table has rows for this project.
    const before = await w.db.query(
      `SELECT count(*)::int AS n FROM events WHERE project_id = $1`, [projectId]);
    assert.ok(before.rows[0].n > 0, 'precondition: there are events to delete');

    // Force is the explicit escape hatch for a live project. Without it, the
    // preceding test proved the endpoint returns 409 and changes nothing.
    const purged = await purge(projectId,
      { reason: 'integration test cleanup, was never real', force: true });
    assert.equal(purged.status, 200, purged.text);
    assert.equal(purged.json.ok, true);
    assert.equal(purged.json.purged.name, 'Disposable');
    assert.equal(purged.json.purged.reason, 'integration test cleanup, was never real');

    // The row itself is gone.
    const after = await w.db.query(
      `SELECT count(*)::int AS n FROM projects WHERE id = $1`, [projectId]);
    assert.equal(after.rows[0].n, 0);

    // The operator-level audit log has the row that survives the project's
    // deletion. Without admin_audit_log, a project.purged event would CASCADE
    // away with the project row, leaving "who did this and why?" unanswerable.
    const audit = await w.db.query(
      `SELECT actor_id, action, target_name, reason, metadata FROM admin_audit_log
       WHERE target_id = $1 AND action = 'project.purged'`, [projectId]);
    assert.equal(audit.rows.length, 1, 'the purge is in admin_audit_log');
    assert.equal(audit.rows[0].target_name, 'Disposable');
    assert.equal(audit.rows[0].actor_id, null,
      'host authorization must not impersonate a browser-authenticated user');
    assert.equal(audit.rows[0].metadata.authorization, 'docker-host');
    assert.equal(audit.rows[0].metadata.actorEmail, 'admin@rgm.example');
    assert.equal(audit.rows[0].reason, 'integration test cleanup, was never real');
    assert.equal(audit.rows[0].metadata.force, true);
    assert.deepEqual(audit.rows[0].metadata.storageKeys, [attachmentKey]);
    assert.equal(await w.storage.head(attachmentKey), null,
      'purge removes the attachment object, not only its database row');

    // The events trigger is re-enabled. The previous DELETE removed every event
    // for the purged project, so a follow-up DELETE would have nothing to act on
    // and so would not trigger — which is not the same as "the trigger is armed".
    // Insert an event into a temporary project, then try to delete it: the
    // trigger must refuse. If the trigger had not been re-enabled, the DELETE
    // would succeed and the test would fail with "0 rejections".
    const tempProj = await w.db.query(
      `INSERT INTO projects (name, client) VALUES ('trigger check', 'RGM') RETURNing id`)
      .then(r => r.rows[0].id);
    await w.db.query(
      `INSERT INTO events (project_id, kind, payload) VALUES ($1, 'trigger.check', '{}'::jsonb)`,
      [tempProj]);
    await assert.rejects(
      w.db.query(`DELETE FROM events WHERE project_id = $1`, [tempProj]),
      /append-only/);

    // The trigger names exist on the events table.
    const still = await w.db.query(
      `SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         WHERE c.relname = 'events' AND NOT t.tgisinternal`);
    const names = still.rows.map(r => r.tgname);
    assert.ok(names.includes('events_no_update'),
      `events_no_update must be re-enabled, saw: ${names.join(', ')}`);
    assert.ok(names.includes('events_no_truncate'),
      `events_no_truncate must be re-enabled, saw: ${names.join(', ')}`);

    await assert.rejects(
      w.db.query(`UPDATE admin_audit_log SET reason = 'rewritten reason is still long enough' WHERE target_id = $1`,
        [projectId]),
      /append-only|restrict_violation/i);
    await assert.rejects(
      w.db.query(`DELETE FROM admin_audit_log WHERE target_id = $1`, [projectId]),
      /append-only|restrict_violation/i);
    await assert.rejects(
      w.db.query(`TRUNCATE admin_audit_log CASCADE`),
      /append-only|restrict_violation/i);

    // Cleanup: the temp project, but only with the trigger disable path again.
    await w.db.query(`ALTER TABLE events DISABLE TRIGGER events_no_update`);
    await w.db.query(`ALTER TABLE events DISABLE TRIGGER events_no_truncate`);
    await w.db.query(`DELETE FROM events WHERE project_id = $1`, [tempProj]);
    await w.db.query(`DELETE FROM projects WHERE id = $1`, [tempProj]);
    await w.db.query(`ALTER TABLE events ENABLE TRIGGER events_no_update`);
    await w.db.query(`ALTER TABLE events ENABLE TRIGGER events_no_truncate`);
  });

  test('a failed object deletion is persisted and the same purge command retries it', async () => {
    const created = await siteAdminClient.post('/api/projects',
      { name: 'Cleanup retry target', client: 'RGM', env: 'staging' });
    assert.equal(created.status, 201, created.text);
    const id = created.json.id;
    const member = await siteAdminClient.post(`/api/projects/${id}/members`,
      { email: 'tester@rgm.example', name: 'Tester', role: 'tester' });
    assert.equal(member.status, 201, member.text);
    const milestone = await siteAdminClient.post(`/api/projects/${id}/milestones`,
      { code: 'CLEAN', titleEn: 'Cleanup retry' });
    const bug = await w.testerClient.post(`/api/projects/${id}/bugs`, {
      milestoneId: milestone.json.id,
      severity: 'medium',
      titleVi: 'Dọn ảnh thất bại',
      bodyVi: 'Lần chạy lại phải xóa ảnh còn sót.'
    });
    const presign = await w.testerClient.post(
      `/api/bugs/${bug.json.id}/attachments/presign`,
      { contentType: 'image/png', byteSize: PNG_BYTES.length });
    await w.testerClient.put(presign.json.uploadUrl, PNG_BYTES);
    const completed = await w.testerClient.post(
      `/api/bugs/${bug.json.id}/attachments/complete`, {
        storageKey: presign.json.storageKey,
        uploadToken: presign.json.uploadToken,
        filename: 'retry.png'
      });
    assert.equal(completed.status, 201, completed.text);
    const key = await w.db.query(
      `SELECT storage_key FROM bug_attachments WHERE id = $1`, [completed.json.id])
      .then(r => r.rows[0].storage_key);

    const originalDelete = w.storage.delete.bind(w.storage);
    let failOnce = true;
    w.storage.delete = async candidate => {
      if (candidate === key && failOnce) {
        failOnce = false;
        throw new Error('simulated object-store outage');
      }
      return originalDelete(candidate);
    };

    const reason = 'retry object cleanup after simulated outage';
    try {
      const first = await purge(id, { reason, force: true });
      assert.equal(first.status, 500, first.text);
      assert.equal(first.json.error, 'storage_cleanup_failed');
      assert.ok(await w.storage.head(key), 'object remains after the simulated outage');
    } finally {
      w.storage.delete = originalDelete;
    }

    const cleaned = await cleanPendingStorage({ db: w.db, storage: w.storage });
    assert.equal(cleaned.cleaned, 1);
    assert.equal(cleaned.failed, 0);

    const retried = await purge(id,
      { reason: 'a different retry reason must not rewrite the tombstone', force: true });
    assert.equal(retried.status, 200, retried.text);
    assert.equal(retried.json.purged.reason, reason,
      'retry response must report the immutable audit reason');
    assert.equal(retried.json.purged.force, true);
    assert.equal(await w.storage.head(key), null);
    const audit = await w.db.query(
      `SELECT count(*)::int AS c FROM admin_audit_log WHERE target_id = $1`, [id]);
    assert.equal(audit.rows[0].c, 1, 'retry must not fabricate a second tombstone');
    const cleanup = await w.db.query(
      `SELECT cleaned_at FROM admin_storage_cleanup WHERE project_id = $1 AND storage_key = $2`,
      [id, key]);
    assert.equal(cleanup.rows.length, 1);
    assert.ok(cleanup.rows[0].cleaned_at, 'the persisted cleanup item is complete');
  });

  test('an outstanding app-local upload is revoked and erased by immediate purge', async () => {
    const created = await siteAdminClient.post('/api/projects',
      { name: 'Staged upload purge target', client: 'RGM', env: 'staging' });
    assert.equal(created.status, 201, created.text);
    const id = created.json.id;
    const member = await siteAdminClient.post(`/api/projects/${id}/members`,
      { email: 'tester@rgm.example', name: 'Tester', role: 'tester' });
    assert.equal(member.status, 201, member.text);
    const milestone = await siteAdminClient.post(`/api/projects/${id}/milestones`,
      { code: 'STAGE', titleEn: 'Staged upload' });
    const bug = await w.testerClient.post(`/api/projects/${id}/bugs`, {
      milestoneId: milestone.json.id,
      severity: 'high',
      titleVi: 'Ảnh chưa hoàn tất',
      bodyVi: 'Purge phải chờ capability hết hạn và xóa object staging.'
    });
    assert.equal(bug.status, 201, bug.text);
    const presign = await w.testerClient.post(
      `/api/bugs/${bug.json.id}/attachments/presign`,
      { contentType: 'image/png', byteSize: PNG_BYTES.length });
    assert.equal(presign.status, 201, presign.text);
    const uploaded = await w.testerClient.put(presign.json.uploadUrl, PNG_BYTES);
    assert.equal(uploaded.status, 201, uploaded.text);
    assert.ok(await w.storage.head(presign.json.storageKey));

    const removed = await siteAdminClient.del(`/api/projects/${id}`);
    assert.equal(removed.status, 200, removed.text);
    const purged = await purge(id, { reason: 'staged upload capability is revoked now' });
    assert.equal(purged.status, 200, purged.text);
    assert.equal(await w.storage.head(presign.json.storageKey), null,
      'the staged object is included in durable cleanup immediately');

    const replay = await w.testerClient.put(presign.json.uploadUrl, PNG_BYTES);
    assert.equal(replay.status, 410, replay.text);
    assert.equal(replay.json.error, 'upload_revoked');
  });

  test('a purge locks the removed project against a concurrent restore',
    { skip: !process.env.RGM_TEST_PG_URL }, async () => {
      const created = await siteAdminClient.post('/api/projects',
        { name: 'Purge race target', client: 'RGM', env: 'staging' });
      const id = created.json.id;
      const removed = await siteAdminClient.del(`/api/projects/${id}`);
      assert.equal(removed.status, 200, removed.text);

      let releaseEvents;
      let eventsLocked;
      const release = new Promise(resolve => { releaseEvents = resolve; });
      const locked = new Promise(resolve => { eventsLocked = resolve; });
      const blocker = w.db.transaction(async tx => {
        await tx.query('LOCK TABLE events IN ACCESS EXCLUSIVE MODE');
        eventsLocked();
        await release;
      });
      await locked;

      const purgePromise = purge(id, { reason: 'concurrent restore must not win this race' });

      // Wait until the guarded function has locked the project row and is blocked
      // acquiring the events-table lock. Exclude this polling query itself.
      let purgeBlocked = false;
      for (let i = 0; i < 100; i++) {
        const active = await w.db.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE pid <> pg_backend_pid()
              AND query LIKE '%admin_purge_project%'
              AND wait_event_type = 'Lock'`);
        if (active.rows[0].n > 0) { purgeBlocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (!purgeBlocked) {
        releaseEvents();
        await Promise.allSettled([purgePromise, blocker]);
        assert.fail('purge never reached the trigger lock');
      }

      let restoreSettled = false;
      const restorePromise = w.db.query(
        `UPDATE projects SET deleted_at = NULL WHERE id = $1 RETURNING id`, [id])
        .then(res => { restoreSettled = true; return res; });
      await new Promise(resolve => setTimeout(resolve, 100));
      const settledBeforePurge = restoreSettled;

      // Always release the table lock before asserting so a failing old
      // implementation cannot leave a blocked request or connection behind.
      releaseEvents();
      const [purged, restored] = await Promise.all([purgePromise, restorePromise]);
      await blocker;
      assert.equal(settledBeforePurge, false,
        'restore must wait on the project row held by purge');
      assert.equal(purged.status, 200, purged.text);
      assert.equal(restored.rows.length, 0,
        'the waiting restore must not revive a project after purge');
    });

  test('an in-flight attachment completion cannot escape purge storage cleanup',
    { skip: !process.env.RGM_TEST_PG_URL, timeout: 15000 }, async () => {
      const created = await siteAdminClient.post('/api/projects',
        { name: 'Attachment race target', client: 'RGM', env: 'staging' });
      assert.equal(created.status, 201, created.text);
      const id = created.json.id;
      const member = await siteAdminClient.post(`/api/projects/${id}/members`,
        { email: 'tester@rgm.example', name: 'Tester', role: 'tester' });
      assert.equal(member.status, 201, member.text);

      const milestone = await siteAdminClient.post(`/api/projects/${id}/milestones`,
        { code: 'RACE', titleEn: 'Attachment race' });
      assert.equal(milestone.status, 201, milestone.text);
      const bug = await w.testerClient.post(`/api/projects/${id}/bugs`, {
        milestoneId: milestone.json.id,
        severity: 'high',
        titleVi: 'Ảnh đang hoàn tất',
        bodyVi: 'Ảnh phải được dọn ngay cả khi hoàn tất đồng thời với purge.'
      });
      assert.equal(bug.status, 201, bug.text);

      const stagedKey = `${id}/${bug.json.id}/11111111-1111-4111-8111-111111111111`;
      const finalKey = `${id}/${bug.json.id}/22222222-2222-4222-8222-222222222222`;
      const originalKeyFor = w.storage.keyFor.bind(w.storage);
      const keys = [stagedKey, finalKey];
      w.storage.keyFor = () => keys.shift();

      let releaseBug;
      let bugLocked;
      const release = new Promise(resolve => { releaseBug = resolve; });
      const locked = new Promise(resolve => { bugLocked = resolve; });
      let blocker;
      try {
        const presign = await w.testerClient.post(
          `/api/bugs/${bug.json.id}/attachments/presign`,
          { contentType: 'image/png', byteSize: PNG_BYTES.length });
        assert.equal(presign.status, 201, presign.text);
        assert.equal(presign.json.storageKey, stagedKey);
        await w.testerClient.put(presign.json.uploadUrl, PNG_BYTES);

        blocker = w.db.transaction(async tx => {
          await tx.query('SELECT id FROM bugs WHERE id = $1 FOR UPDATE', [bug.json.id]);
          bugLocked();
          await release;
        });
        await locked;

        const completionPromise = w.testerClient.post(
          `/api/bugs/${bug.json.id}/attachments/complete`, {
            storageKey: presign.json.storageKey,
            uploadToken: presign.json.uploadToken,
            filename: 'race.png'
          });

        let completionBlocked = false;
        for (let i = 0; i < 100; i++) {
          const active = await w.db.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE pid <> pg_backend_pid()
                AND query LIKE 'SELECT id FROM bugs WHERE id = $1 FOR UPDATE%'
                AND wait_event_type = 'Lock'`);
          if (active.rows[0].n > 0) { completionBlocked = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (!completionBlocked) {
          releaseBug();
          await Promise.allSettled([completionPromise, blocker]);
          assert.fail('attachment completion never reached the held bug row');
        }

        const purgePromise = purge(id, {
          reason: 'attachment completion race integration cleanup', force: true
        });
        await new Promise(resolve => setTimeout(resolve, 100));
        releaseBug();

        const [completed, purged] = await Promise.all([completionPromise, purgePromise]);
        await blocker;
        assert.equal(completed.status, 201, completed.text);
        assert.equal(purged.status, 200, purged.text);
        assert.equal(await w.storage.head(finalKey), null,
          'the object promoted by the in-flight completion must be deleted by purge');
        const audit = await w.db.query(
          `SELECT metadata FROM admin_audit_log WHERE target_id = $1`, [id]);
        assert.deepEqual(audit.rows[0].metadata.storageKeys, [finalKey]);
      } finally {
        w.storage.keyFor = originalKeyFor;
        if (releaseBug) releaseBug();
        if (blocker) await blocker.catch(() => {});
      }
    });
});
