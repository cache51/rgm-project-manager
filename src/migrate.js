/**
 * Apply pending migrations. Run with `npm run migrate`.
 *
 * Migrations are recorded in `schema_migrations` so re-running is a no-op, and a
 * migration that needs a real cluster (role creation) is reported as skipped
 * rather than silently forgotten.
 */
import { createDb, migrate } from './db.js';

const db = await createDb({ dataDir: process.env.PGLITE_DIR });
const { applied } = await migrate(db, {
  log: (line) => process.stdout.write(`  ${line}\n`)
});

process.stdout.write(`migrations: ${applied.length} applied\n`);

if (db.close) await db.close();
