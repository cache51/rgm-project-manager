/**
 * The queue drain loop, as a function rather than a script.
 *
 * It lives here so that both entrypoints can run it. The embedded database (PGlite)
 * accepts a single process, so a separate `npm run worker` can never share a data
 * directory with the server: it dies on startup and the queue sits undrained — in
 * exactly the deployment people run locally, where translations of tester notes and
 * outgoing notifications are the point. A real Postgres still gets its own worker
 * process; nothing about the lease-based claiming changes either way.
 *
 * Jobs are claimed under a lease, so several loops can run concurrently and one that
 * dies mid-job has its work reclaimed. Exhausted jobs are parked so they stop being
 * retried forever while remaining visible.
 */
import { parkExhaustedTranslations, parkExhaustedEventTranslations,
         parkExhaustedOutbox } from './claim.js';
import { runBugTranslations, runEventTranslations } from './translate.js';
import { runOutbox } from './notify.js';

export const DEFAULT_IDLE_MS = 2000;

/** Claim and run everything currently due. Returns the per-queue results. */
export async function drainOnce(db, { provider, sender, workerId, glossary, baseUrl }) {
  const [bugs, events, outbox] = await Promise.all([
    runBugTranslations(db, provider, { workerId, glossary }),
    runEventTranslations(db, provider, { workerId, glossary }),
    runOutbox(db, sender, { workerId, baseUrl })
  ]);
  return { bugs, events, outbox };
}

/**
 * Park jobs that have exhausted their attempts.
 *
 * Only when idle, so the sweep never races a live lease. All three queues are swept:
 * leaving event translations out once left a row stuck in `running` for ever, with no
 * retry and no trace (IR-029).
 */
export async function parkExhausted(db) {
  return [
    ...(await parkExhaustedTranslations(db)).map((r) => `bug ${r.bug_id}`),
    ...(await parkExhaustedEventTranslations(db)).map((r) => `event ${r.event_id}`),
    ...(await parkExhaustedOutbox(db)).map((r) => `outbox ${r.id}`)
  ];
}

/**
 * Run `drainOnce` until stopped. Returns a handle: `stop()` asks the loop to finish
 * its current pass, `done` resolves when it has.
 */
export function startWorkerLoop(db, { provider, sender, workerId, glossary, baseUrl,
                                      idleMs = DEFAULT_IDLE_MS, log = () => {} }) {
  let stopping = false;

  const done = (async () => {
    while (!stopping) {
      const { bugs, events, outbox } = await drainOnce(db,
        { provider, sender, workerId, glossary, baseUrl });

      for (const r of [...bugs, ...events]) {
        if (r.status !== 'done') log(`[translate] ${r.status} ${r.field}/${r.lang} ${r.error ?? ''}`);
      }
      for (const r of outbox) {
        if (r.status !== 'sent') log(`[notify] ${r.status} ${r.error ?? ''}`);
      }

      // Idle means nothing was even due; that is when it is safe to sweep.
      if (bugs.length + events.length + outbox.length === 0) {
        for (const p of await parkExhausted(db)) log(`[park] ${p} exhausted`);
        if (!stopping) await new Promise((r) => setTimeout(r, idleMs));
      }
    }
  })();

  return { stop() { stopping = true; }, done };
}
