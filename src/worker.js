/**
 * Background worker: drains the translation queue and the notification outbox.
 * Run with `npm run worker`.
 *
 * Every job is claimed under a lease, so several workers can run concurrently and
 * a worker that dies mid-job has its work reclaimed rather than lost. Exhausted
 * jobs are parked so they stop being retried forever but remain visible.
 */
import { randomUUID } from 'node:crypto';
import { createDb } from './db.js';
import { claimTranslation, claimOutbox, parkExhaustedTranslations,
         parkExhaustedOutbox, ClaimPolicy } from './claim.js';
import { runBugTranslations, runEventTranslations, StubProvider } from './translate.js';
import { runOutbox } from './notify.js';

const IDLE_MS = Number(process.env.WORKER_IDLE_MS ?? 2000);
const workerId = process.env.WORKER_ID ?? randomUUID();

/**
 * The translation provider. The stub is clearly marked: a real deployment must
 * supply a provider (the glossary handling lives in translate.js).
 */
const provider = StubProvider('stub');

const sender = {
  name: 'stdout',
  async send(msg) {
    process.stdout.write(`[notify] to=${msg.to} kind=${msg.kind} key=${msg.dedupeKey}\n`);
    return { messageId: `local-${msg.dedupeKey}` };
  }
};

const db = await createDb({ dataDir: process.env.PGLITE_DIR });
process.stdout.write(`worker ${workerId} starting (lease ${ClaimPolicy.leaseSeconds}s, ` +
  `max ${ClaimPolicy.maxAttempts} attempts)\n`);

let stopping = false;
const stop = () => { stopping = true; };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

while (!stopping) {
  const [bugs, events, outbox] = await Promise.all([
    runBugTranslations(db, provider, { workerId }),
    runEventTranslations(db, provider, { workerId }),
    runOutbox(db, sender, { workerId })
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
