/**
 * Background worker: drains the translation queue and the notification outbox.
 * Run with `npm run worker`.
 *
 * Every job is claimed under a lease, so several workers can run concurrently and
 * a worker that dies mid-job has its work reclaimed rather than lost. Exhausted
 * jobs are parked so they stop being retried forever but remain visible.
 *
 * The database, translation provider and mailer all come from the same
 * configuration the server uses — otherwise a worker can quietly write to a
 * different bucket or translate through a different provider than the API
 * advertises.
 */
import { randomUUID } from 'node:crypto';
import { createDb } from './db.js';
import { loadConfig } from './config.js';
import { parkExhaustedTranslations, parkExhaustedOutbox, ClaimPolicy } from './claim.js';
import { runBugTranslations, runEventTranslations } from './translate.js';
import { runOutbox } from './notify.js';

const config = loadConfig();
const IDLE_MS = Number(process.env.WORKER_IDLE_MS ?? 2000);
const workerId = process.env.WORKER_ID ?? randomUUID();

const provider = config.translationProvider;
const sender = config.mailer;

const db = await createDb({ dataDir: config.dataDir, url: config.databaseUrl });

process.stdout.write(`worker ${workerId} starting\n`);
for (const [key, value] of Object.entries(config.describe())) {
  process.stdout.write(`  ${key}: ${value}\n`);
}
process.stdout.write(`  lease: ${ClaimPolicy.leaseSeconds}s, max attempts: ${ClaimPolicy.maxAttempts}\n`);

let stopping = false;
const stop = () => { stopping = true; };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

while (!stopping) {
  const [bugs, events, outbox] = await Promise.all([
    runBugTranslations(db, provider, { workerId, glossary: config.glossary }),
    runEventTranslations(db, provider, { workerId, glossary: config.glossary }),
    runOutbox(db, sender, { workerId, baseUrl: config.publicUrl })
  ]);

  for (const r of [...bugs, ...events]) {
    if (r.status !== 'done') {
      process.stdout.write(`[translate] ${r.status} ${r.field}/${r.lang} ${r.error ?? ''}\n`);
    }
  }
  for (const r of outbox) {
    if (r.status !== 'sent') process.stdout.write(`[notify] ${r.status} ${r.error ?? ''}\n`);
  }

  const didWork = bugs.length + events.length + outbox.length > 0;
  if (!didWork) {
    // Park exhausted jobs only when idle, so the sweep never races a live lease.
    const parked = [
      ...(await parkExhaustedTranslations(db)).map(r => `bug ${r.bug_id}`),
      ...(await parkExhaustedOutbox(db)).map(r => `outbox ${r.id}`)
    ];
    for (const p of parked) process.stdout.write(`[park] ${p} exhausted\n`);
    await new Promise(r => setTimeout(r, IDLE_MS));
  }
}

process.stdout.write('worker stopping\n');
if (db.close) await db.close();
