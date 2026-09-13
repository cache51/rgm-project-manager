/**
 * Database access.
 *
 * Two drivers sit behind one surface:
 *
 *   PGlite   Postgres compiled to WASM — the default, so the product runs and is
 *            tested with no database server installed
 *   pg       node-postgres, used when DATABASE_URL (or an injected pool) is set
 *
 * The surface is deliberately `pg`-shaped — `query(text, params) -> { rows }` —
 * so nothing above this file needs to know which one is in play. See db-pg.js for
 * why `transaction` is part of the contract rather than a raw BEGIN/COMMIT
 * helper: on a pooled driver those two statements can land on different
 * connections.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, '..', 'db', 'migrations');

/**
 * @param {object} [options]
 * @param {string} [options.dataDir]        PGlite data directory ('' = in-memory)
 * @param {string} [options.url]            connection string; implies the pg driver
 * @param {object} [options.pool]           an existing pg Pool or test double
 */
export async function createDb({ dataDir, url = null, pool = null } = {}) {
  const connectionString = url ?? process.env.DATABASE_URL ?? null;

  if (pool || connectionString) {
    const { createPgDb } = await import('./db-pg.js');
    return createPgDb({ connectionString, pool });
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const pglite = new PGlite(dataDir);
  await pglite.waitReady;

  return {
    driver: 'pglite',
    raw: pglite,

    async query(text, params) {
      const res = await pglite.query(text, params);
      return { rows: res.rows ?? [], rowCount: res.affectedRows ?? null };
    },

    async exec(sql) {
      await pglite.exec(sql);
    },

    /**
     * PGlite is a single connection shared by every concurrent request, so issuing
     * BEGIN/COMMIT as separate statements lets two requests interleave: one
     * request's COMMIT can commit another's half-finished work, and one request's
     * ROLLBACK can discard another's committed writes.
     *
     * PGlite's own `transaction` holds the connection exclusively for the duration
     * of the callback, which is the only correct way to do this here. The callback
     * receives a handle pinned to that transaction.
     */
    async transaction(fn) {
      return pglite.transaction(async (tx) => fn({
        async query(text, params) {
          const res = await tx.query(text, params);
          return { rows: res.rows ?? [], rowCount: res.affectedRows ?? null };
        },
        async exec(sql) {
          await tx.exec(sql);
        }
      }));
    },

    async close() {
      await pglite.close();
    }
  };
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

  for (const filename of migrationFiles()) {
    if (done.has(filename)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');

    // Migrations are self-contained and environment-tolerant: a step that needs
    // privileges the current role lacks degrades with a NOTICE instead of
    // failing. There is deliberately no "skip this here" convention — a skipped
    // migration is a schema difference between environments that nobody
    // remembers, which is how "it works on staging" happens.
    await db.exec(sql);
    await db.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
    applied.push(filename);
    log(`apply ${filename}`);
  }

  return { applied };
}

/** Convenience for tests: a fresh, fully migrated in-memory database. */
export async function freshDb() {
  const db = await createDb();
  await migrate(db);
  return db;
}

/**
 * Run `fn` inside a transaction, rolling back on any throw.
 *
 * Delegates to the driver's own `transaction`, because only the driver knows how
 * to pin a connection. The fallback exists for a bare `pg`-shaped object that
 * predates this contract.
 */
export async function withTransaction(db, fn) {
  if (typeof db.transaction === 'function') return db.transaction(fn);

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
