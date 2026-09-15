export class AdminPurgeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AdminPurgeError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Permanently remove one project from an owner-authorized one-shot process.
 * Browser sessions and long-running app/worker processes never receive this DB
 * authority.
 */
export async function purgeProject({
  db, storage, actorEmail, projectId, reason, force = false, onError = null
}) {
  const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
  if (trimmedReason.length < 12) {
    throw new AdminPurgeError(400, 'bad_reason',
      'reason must be at least 12 characters — purging is irreversible');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(String(projectId ?? ''))) {
    throw new AdminPurgeError(400, 'bad_project_id', 'project id must be a UUID');
  }
  const email = String(actorEmail ?? '').trim().toLowerCase();
  if (!email) {
    throw new AdminPurgeError(403, 'not_site_admin',
      'purging a project requires the email of a site administrator');
  }

  let dbResult;
  try {
    dbResult = await db.query(
      `SELECT project_name, storage_keys, audit_reason, audit_force
         FROM admin_purge_project($1, $2, $3, $4)`,
      [email, projectId, trimmedReason, force === true]);
  } catch (error) {
    if (error?.code === '42501' && /site administrator required/i.test(error.message)) {
      throw new AdminPurgeError(403, 'not_site_admin',
        'purging a project requires the email of a site administrator');
    }
    throw error;
  }
  if (!dbResult.rows[0]) {
    throw new AdminPurgeError(409, 'not_removed',
      'purge only acts on already-removed projects — archive it first');
  }

  const row = dbResult.rows[0];
  const storageKeys = row.storage_keys ?? [];
  const storageFailures = [];
  for (const key of storageKeys) {
    try {
      await storage.delete(key);
      const marked = await db.query(
        `SELECT admin_mark_storage_cleaned($1, $2) AS cleaned`, [projectId, key]);
      if (marked.rows[0]?.cleaned !== true) {
        throw new Error('purge cleanup item was not recorded');
      }
    } catch (error) {
      storageFailures.push(key);
      if (onError) onError(error);
    }
  }
  if (storageFailures.length) {
    throw new AdminPurgeError(500, 'storage_cleanup_failed',
      `project was purged, but ${storageFailures.length} attachment object(s) remain; `
      + 'rerun the same purge command to retry their persisted cleanup');
  }

  return {
    name: row.project_name,
    reason: row.audit_reason,
    force: row.audit_force
  };
}
