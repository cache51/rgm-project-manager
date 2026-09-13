/**
 * Fixed-window rate limiting.
 *
 * Only the unauthenticated endpoints are limited, because they are the only ones
 * an attacker can reach without credentials. The counter lives in the database so
 * that running several app processes does not multiply the effective limit — an
 * in-memory counter would, silently, which is worse than no limit because it
 * looks like one.
 *
 * A fixed window can admit up to 2x the limit across a window boundary. That is
 * acceptable here: these limits exist to stop mail-bombing and credential
 * stuffing, not to shape traffic precisely.
 */

/** Limits, in one place, so they can be reasoned about together. */
export const LIMITS = Object.freeze({
  // Per address: stops one person being mail-bombed. Not a security boundary —
  // links are single-use and expire in 15 minutes.
  loginLinkPerEmail: { limit: 10, windowSeconds: 900 },
  // Per source: the actual abuse control.
  loginLinkPerIp: { limit: 60, windowSeconds: 900 },
  // Token guessing is infeasible (256-bit), so this is only flood protection.
  consumePerIp: { limit: 60, windowSeconds: 900 }
});

const windowStartFor = (now, windowSeconds) =>
  new Date(Math.floor(now.getTime() / (windowSeconds * 1000)) * windowSeconds * 1000);

/**
 * Record a hit and report whether the caller is still within its limit.
 * @returns {Promise<{allowed: boolean, count: number, limit: number, resetAt: Date, retryAfter: number}>}
 */
export async function hit(db, bucket, { limit, windowSeconds, now = new Date() } = {}) {
  const windowStart = windowStartFor(now, windowSeconds);

  const res = await db.query(
    `INSERT INTO rate_limit_hits (bucket, window_start, count)
     VALUES ($1, $2, 1)
     ON CONFLICT (bucket, window_start)
     DO UPDATE SET count = rate_limit_hits.count + 1
     RETURNING count`, [bucket, windowStart]);

  const count = res.rows[0].count;
  const resetAt = new Date(windowStart.getTime() + windowSeconds * 1000);
  return {
    allowed: count <= limit,
    count,
    limit,
    resetAt,
    retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000))
  };
}

/**
 * Apply several limits at once; all must pass. Counts are recorded even when an
 * earlier limit already failed, so a caller hammering the endpoint keeps being
 * counted rather than resetting the window by tripping a different bucket.
 */
export async function enforce(db, checks) {
  const results = [];
  for (const [bucket, options] of checks) {
    results.push({ bucket, ...(await hit(db, bucket, options)) });
  }
  const failed = results.find((r) => !r.allowed);
  return { allowed: !failed, results, failed: failed ?? null };
}

/** Drop windows that can no longer be hit. Safe to call periodically. */
export async function prune(db, { olderThanSeconds = 24 * 3600, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - olderThanSeconds * 1000);
  const res = await db.query(
    'DELETE FROM rate_limit_hits WHERE window_start < $1 RETURNING bucket', [cutoff]);
  return res.rows.length;
}
