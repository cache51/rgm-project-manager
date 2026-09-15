/**
 * Background worker: drains the translation queue and the notification outbox.
 * Run with `npm run worker` — for deployments with a real Postgres, where a second
 * process can share the database.
 *
 * With the embedded database this process cannot start at all (PGlite takes a single
 * process); the server runs the same loop in-process instead. See src/worker-loop.js.
 */
import { randomUUID } from 'node:crypto';
import { createDb } from './db.js';
import { loadConfig } from './config.js';
import { ClaimPolicy } from './claim.js';
import { startWorkerLoop } from './worker-loop.js';
import { verifyDatabaseRoleBoundary } from './server.js';

const config = loadConfig();
const workerId = process.env.WORKER_ID ?? randomUUID();
const idleMs = Number(process.env.WORKER_IDLE_MS ?? 2000);

const db = await createDb({ dataDir: config.dataDir, url: config.databaseUrl });
if (config.databaseUrl) await verifyDatabaseRoleBoundary({ db });

process.stdout.write(`worker ${workerId} starting\n`);
for (const [key, value] of Object.entries(config.describe())) {
  process.stdout.write(`  ${key}: ${value}\n`);
}
process.stdout.write(`  lease: ${ClaimPolicy.leaseSeconds}s, max attempts: ${ClaimPolicy.maxAttempts}\n`);

const loop = startWorkerLoop(db, {
  provider: config.translationProvider,
  sender: config.mailer,
  workerId,
  glossary: config.glossary,
  baseUrl: config.publicUrl,
  idleMs,
  log: (line) => process.stdout.write(`${line}\n`)
});

const stop = () => loop.stop();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await loop.done;
process.stdout.write('worker stopping\n');
if (db.close) await db.close();
