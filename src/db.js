/**
 * Database access.
 *
 * The driver here is PGlite (Postgres compiled to WASM) so the whole product runs
 * and is tested with no database server. The surface is deliberately `pg`-shaped
 * (`query(sql, params) -> { rows }`), so swapping in `node-postgres` against a
 * real cluster means changing `createDb` only.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, '..', 'db', 'migrations');

/** Migrations that need a real cluster (role creation) are skipped in-process. */
const SKIP_MARKER = '-- @skip-when: no-roles';

export async function createDb({ dataDir } = {}) {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(dataDir);
  await db.waitReady;
  return db;
}

export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
}

export async function migrate(db, { log = () => {} } = {}) {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const done = new Set(
    (await db.query('SELECT filename FROM schema_migrations')).rows.map(r => r.filename));

  const applied = [];
  const skipped = [];

  for (const filename of migrationFiles()) {
    if (done.has(filename)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');

    if (sql.includes(SKIP_MARKER)) {
      skipped.push(filename);
      log(`skip ${filename} (needs role creation — apply manually against a real cluster)`);
      continue;
    }

    await db.exec(sql);
    await db.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
    applied.push(filename);
    log(`apply ${filename}`);
  }

  return { applied, skipped };
}

/** Convenience for tests: a fresh, fully migrated in-memory database. */
export async function freshDb() {
  const db = await createDb();
  await migrate(db);
  return db;
}

/**
 * Run `fn` inside a transaction, rolling back on any throw. Written against plain
 * BEGIN/COMMIT rather than a driver-specific helper so it works identically on
 * PGlite and node-postgres.
 */
export async function withTransaction(db, fn) {
  await db.exec('BEGIN');
  try {
    const out = await fn(db);
    await db.exec('COMMIT');
    return out;
  } catch (err) {
    try { await db.exec('ROLLBACK'); } catch { /* connection already unwound */ }
    throw err;
  }
}
