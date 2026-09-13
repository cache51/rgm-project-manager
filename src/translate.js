/**
 * Translation queue and worker (§8).
 *
 * Design points the reviews forced:
 *  - rows are created in the SAME transaction as their subject, so the queue is
 *    durable and a crash between the two is impossible (RGM-004)
 *  - a bug is always accepted; a translation outage never blocks reporting
 *  - completion is conditional on the CURRENT claim (`claimed_by`), so a reclaimed
 *    job cannot be overwritten by the worker that lost its lease (RGM-S1-002)
 *  - `event_translations` exists so a Vietnamese retest note is readable — that
 *    was a real gap (RGM2-005)
 */
import { claimTranslation, ClaimPolicy } from './claim.js';

/** Domain vocabulary. Mitigation for risk R1 (generic MT mangles garment jargon). */
export const DEFAULT_GLOSSARY = Object.freeze({
  carton: 'thùng',
  techpack: 'techpack',
  'packing list': 'bảng đóng gói',
  PO: 'đơn đặt hàng',
  milestone: 'cột mốc'
});

/** Deterministic provider for tests. Clearly not a real translation. */
export const StubProvider = (name = 'stub') => ({
  name,
  model: 'stub-v1',
  async translate({ text, to }) { return `«${to}» ${text}`; }
});

/** Always fails — used to prove bugs survive a translation outage. */
export const FailingProvider = (message = 'provider unavailable') => ({
  name: 'failing',
  model: 'failing-v1',
  async translate() { throw new Error(message); }
});

/** Queue both fields for a new bug. Call INSIDE the bug-insert transaction. */
export async function enqueueBugTranslations(db, { bugId, langs = ['zh', 'en'] }) {
  for (const field of ['title', 'body']) {
    for (const lang of langs) {
      await db.query(
        `INSERT INTO bug_translations (bug_id, field, lang, status)
         VALUES ($1, $2, $3, 'pending')
         ON CONFLICT (bug_id, field, lang) DO NOTHING`, [bugId, field, lang]);
    }
  }
}

/** Queue a translation for an event note (a retest-fail reason, a comment). */
export async function enqueueEventTranslation(db, { eventId, note, langs = ['zh', 'en'] }) {
  if (!note || !String(note).trim()) return;
  for (const lang of langs) {
    await db.query(
      `INSERT INTO event_translations (event_id, field, lang, status)
       VALUES ($1, 'note', $2, 'pending')
       ON CONFLICT (event_id, field, lang) DO NOTHING`, [eventId, lang]);
  }
}

async function sourceText(db, bugId, field) {
  const col = field === 'title' ? 'title_vi' : 'body_vi';
  const r = await db.query(`SELECT ${col} AS text FROM bugs WHERE id = $1`, [bugId]);
  if (!r.rows.length) return null;
  return r.rows[0].text;
}

/**
 * Drain queued bug translations. Returns what happened to each claimed job.
 * Errors are recorded per language and never thrown, so one bad language cannot
 * abort the batch.
 */
export async function runBugTranslations(db, provider, { workerId, max = 50,
                                                          policy = ClaimPolicy,
                                                          glossary = DEFAULT_GLOSSARY } = {}) {
  const results = [];

  for (let i = 0; i < max; i++) {
    const job = await claimTranslation(db, workerId, policy);
    if (!job) break;

    const { bug_id: bugId, field, lang } = job;
    try {
      const source = await sourceText(db, bugId, field);
      if (source === null) throw new Error(`bug ${bugId} vanished`);

      const text = await provider.translate({ text: source, from: 'vi', to: lang, glossary });

      const done = await db.query(
        `UPDATE bug_translations
            SET status = 'done', text = $1, provider = $2, model = $3,
                error = NULL, updated_at = now()
          WHERE bug_id = $4 AND field = $5 AND lang = $6
            AND status = 'running' AND claimed_by = $7
          RETURNING bug_id`,
        [text, provider.name, provider.model ?? null, bugId, field, lang, workerId]);

      // zero rows means the lease was reclaimed by someone else — do not retry
      results.push({ bugId, field, lang, status: done.rows.length ? 'done' : 'superseded' });
    } catch (err) {
      await db.query(
        `UPDATE bug_translations
            SET status = 'failed', error = $1, updated_at = now()
          WHERE bug_id = $2 AND field = $3 AND lang = $4 AND claimed_by = $5`,
        [String(err.message).slice(0, 500), bugId, field, lang, workerId]);
      results.push({ bugId, field, lang, status: 'failed', error: err.message });
    }
  }

  return results;
}

/** Drain queued event-note translations under the same lease rules. */
export async function runEventTranslations(db, provider, { workerId, max = 50,
                                                           policy = ClaimPolicy,
                                                           glossary = DEFAULT_GLOSSARY } = {}) {
  const results = [];

  for (let i = 0; i < max; i++) {
    const claimed = await db.query(
      `UPDATE event_translations AS t
          SET status = 'running', claimed_by = $1,
              attempts = t.attempts + 1,
              lease_until = now() + make_interval(secs => $2::int),
              updated_at = now()
        WHERE (t.event_id, t.field, t.lang) IN (
                SELECT event_id, field, lang FROM event_translations
                 WHERE (status = 'pending' OR (status = 'running' AND lease_until < now()))
                   AND attempts < $3::int
                 ORDER BY updated_at
                 FOR UPDATE SKIP LOCKED
                 LIMIT 1)
        RETURNING event_id, field, lang, attempts`,
      [workerId, policy.leaseSeconds, policy.maxAttempts]);

    if (!claimed.rows.length) break;
    const { event_id: eventId, field, lang } = claimed.rows[0];

    try {
      // IR-028: close and reopen store their text as `payload.reason`, while this
      // read only `payload.note` — so every such translation failed with "has no
      // note to translate" even against a healthy provider. Both are accepted, and
      // coalescing on read also repairs rows already written.
      const src = await db.query(
        `SELECT COALESCE(payload->>'note', payload->>'reason') AS note
           FROM events WHERE id = $1`,
        [eventId]);
      const note = src.rows[0]?.note;
      if (!note) throw new Error(`event ${eventId} has no note to translate`);

      const text = await provider.translate({ text: note, from: 'vi', to: lang, glossary });
      const done = await db.query(
        `UPDATE event_translations
            SET status = 'done', text = $1, provider = $2, model = $3,
                error = NULL, updated_at = now()
          WHERE event_id = $4 AND field = $5 AND lang = $6
            AND status = 'running' AND claimed_by = $7
          RETURNING event_id`,
        [text, provider.name, provider.model ?? null, eventId, field, lang, workerId]);

      results.push({ eventId, field, lang, status: done.rows.length ? 'done' : 'superseded' });
    } catch (err) {
      await db.query(
        `UPDATE event_translations SET status = 'failed', error = $1, updated_at = now()
          WHERE event_id = $2 AND field = $3 AND lang = $4 AND claimed_by = $5`,
        [String(err.message).slice(0, 500), eventId, field, lang, workerId]);
      results.push({ eventId, field, lang, status: 'failed', error: err.message });
    }
  }

  return results;
}

/** Operator action: clear a failure so the job can be claimed again. */
export async function retryTranslation(db, { bugId, field, lang }) {
  const r = await db.query(
    `UPDATE bug_translations
        SET status = 'pending', error = NULL, attempts = 0, lease_until = NULL,
            claimed_by = NULL, updated_at = now()
      WHERE bug_id = $1 AND field = $2 AND lang = $3 AND status = 'failed'
      RETURNING bug_id, field, lang`, [bugId, field, lang]);
  return r.rows[0] ?? null;
}
