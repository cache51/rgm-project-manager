/**
 * Lease-based job claiming (closes RGM3-006 / RGM3-001).
 *
 * The plan previously specified:
 *
 *     WHERE status = 'pending' AND (lease_until IS NULL OR lease_until < now())
 *     FOR UPDATE SKIP LOCKED
 *
 * Both round-3 reviewers independently showed that predicate can NEVER reclaim a
 * worker which committed `running` and then died: the `status = 'pending'` filter
 * excludes exactly the rows the lease exists to rescue. The lease was decorative.
 *
 * The corrected predicate below claims a row when it is pending, OR when it is
 * running with an expired lease. Every claim increments `attempts`, so a
 * poisoned job cannot be retried forever.
 */

const LEASE_SECONDS = 120;
const MAX_ATTEMPTS = 5;

/** Claim one translation job, or zero rows if none is claimable. */
export const CLAIM_TRANSLATION_SQL = `
UPDATE bug_translations AS t
   SET status      = 'running',
       claimed_by  = $1,
       attempts    = t.attempts + 1,
       lease_until = now() + make_interval(secs => $2::int),
       updated_at  = now()
 WHERE (t.bug_id, t.field, t.lang) IN (
         SELECT bug_id, field, lang
           FROM bug_translations
          WHERE (status = 'pending' OR (status = 'running' AND lease_until < now()))
            AND attempts < $3::int
          ORDER BY updated_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
 )
RETURNING bug_id, field, lang, status, attempts, lease_until;
`;

/** Claim one outbox notification under the same rules. */
export const CLAIM_OUTBOX_SQL = `
UPDATE notifications_outbox AS o
   SET status      = 'sending',
       claimed_by  = $1,
       attempts    = o.attempts + 1,
       lease_until = now() + make_interval(secs => $2::int)
 WHERE o.id IN (
         SELECT id
           FROM notifications_outbox
          WHERE (
                  -- A fresh row, or one whose backoff has elapsed. A failed send
                  -- is rescheduled as pending with a future lease_until, so
                  -- accepting pending rows unconditionally burned every attempt in
                  -- a tight loop instead of waiting out the retry window (IR-025).
                  (status = 'pending' AND (lease_until IS NULL OR lease_until <= now()))
                  OR (status IN ('running','sending') AND lease_until < now())
                )
            AND attempts < $3::int
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
 )
RETURNING id, status, attempts, lease_until;
`;

/**
 * Park exhausted jobs so they stop being reclaimed (visible, not silently lost).
 *
 * The lease check is load-bearing: the claim increments `attempts` as it grants a
 * fresh lease, so a job on its final permitted attempt is legitimately running.
 * Without `lease_until < now()` a concurrent sweep would mark that live job
 * `failed` and discard its valid result (RGM-S1-002).
 */
export const PARK_EXHAUSTED_TRANSLATIONS_SQL = `
UPDATE bug_translations
   SET status = 'failed',
       error  = coalesce(error, 'exhausted ' || attempts || ' attempts'),
       updated_at = now()
 WHERE status IN ('pending','running')
   AND attempts >= $1::int
   AND (lease_until IS NULL OR lease_until < now())
RETURNING bug_id, field, lang, attempts;
`;

/**
 * The outbox needs the same terminal transition. The first revision only parked
 * translations, so a notification whose final attempt committed `sending` and
 * then crashed stayed `sending` forever — unreclaimable and un-parkable
 * (RGM-S1-003).
 */
export const PARK_EXHAUSTED_OUTBOX_SQL = `
UPDATE notifications_outbox
   SET status = 'failed',
       error  = coalesce(error, 'exhausted ' || attempts || ' attempts')
 WHERE status IN ('pending','running','sending')
   AND attempts >= $1::int
   AND (lease_until IS NULL OR lease_until < now())
RETURNING id, attempts;
`;

/**
 * Reclaim threshold used by the worker. Exported so tests and callers agree.
 */
export const ClaimPolicy = Object.freeze({
  leaseSeconds: LEASE_SECONDS,
  maxAttempts: MAX_ATTEMPTS
});

/** Convenience wrapper: run the translation claim with the default policy. */
export async function claimTranslation(db, workerId, policy = ClaimPolicy) {
  const res = await db.query(CLAIM_TRANSLATION_SQL,
    [workerId, policy.leaseSeconds, policy.maxAttempts]);
  return res.rows[0] ?? null;
}

export async function claimOutbox(db, workerId, policy = ClaimPolicy) {
  const res = await db.query(CLAIM_OUTBOX_SQL,
    [workerId, policy.leaseSeconds, policy.maxAttempts]);
  return res.rows[0] ?? null;
}

export async function parkExhaustedTranslations(db, policy = ClaimPolicy) {
  const res = await db.query(PARK_EXHAUSTED_TRANSLATIONS_SQL, [policy.maxAttempts]);
  return res.rows;
}

export async function parkExhaustedOutbox(db, policy = ClaimPolicy) {
  const res = await db.query(PARK_EXHAUSTED_OUTBOX_SQL, [policy.maxAttempts]);
  return res.rows;
}
