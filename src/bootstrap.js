/**
 * Create the first site admin. Run with `npm run bootstrap -- you@example.com`.
 *
 * Without this there is no way to obtain the first account: every other path
 * (invitation) requires an existing project and an existing admin, so a fresh
 * deployment would be unreachable. It refuses to create a second site admin.
 */
import { createDb, migrate } from './db.js';
import { bootstrap } from './auth.js';

const email = process.argv[2];
if (!email) {
  process.stderr.write('usage: npm run bootstrap -- you@example.com\n');
  process.exit(2);
}

const db = await createDb({ dataDir: process.env.PGLITE_DIR });
await migrate(db);

const result = await bootstrap(db, email);
if (result.created) {
  process.stdout.write(`site admin created: ${result.email}\n` +
    `sign in at ${process.env.PUBLIC_URL ?? 'http://127.0.0.1:3000'}\n`);
} else {
  process.stdout.write(`not created — ${result.reason}\n`);
}

if (db.close) await db.close();
