/**
 * CI-only: apply every migration to a real Postgres and verify the grants.
 *
 * This ran as a `node -e '...'` in the workflow, and broke twice over shell
 * quoting — a single apostrophe in a comment (`application's work`) closed the
 * quoted string and Node saw a truncated script (a SyntaxError, not a grant
 * failure). A real file removes shell quoting from the picture entirely, so a
 * red run means the grants are wrong, which is the only thing worth failing on.
 *
 * Needs DATABASE_URL (the workflow's postgres service).
 */
import { createDb, migrate, migrationFiles } from '../src/db.js';

const db = await createDb();
try {
  const { applied } = await migrate(db, { log: console.log });
  const files = migrationFiles();
  if (applied.length !== files.length) {
    throw new Error(`applied ${applied.length} of ${files.length} migrations`);
  }
  const roles = await db.query(
    "SELECT rolname FROM pg_roles WHERE rolname LIKE $$rgm_%$$");
  if (roles.rows.length !== 2) {
    throw new Error(`expected rgm_runtime and rgm_auditor, got ${roles.rows.length}`);
  }
  // The runtime role has to be able to do the application's work —
  // it held only `events` once, which made it unusable as one (IR-004).
  await db.query('SET ROLE rgm_runtime');
  const readable = await db.query('SELECT count(*)::int AS c FROM users');
  if (readable.rows[0].c !== 0) throw new Error('unexpected rows in users');
  await db.query('RESET ROLE');
  const users = await db.query('SELECT to_regclass($$public.users$$) AS t');
  if (!users.rows[0].t) throw new Error('users table missing');
  console.log('migrations, roles and the runtime grants verified against real Postgres');
} finally {
  await db.close();
}
