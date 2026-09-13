/**
 * Ready-notification outbox (§11).
 *
 *  - the outbox row is written in the SAME transaction as the milestone
 *    transition, so a tester is never notified by a side effect that can be lost
 *  - delivery is at-least-once with provider-side deduplication, NOT exactly-once:
 *    `dedupe_key` prevents duplicate rows, and is also handed to the provider as
 *    its idempotency key (and as the Message-ID) so a retry after a crash does not
 *    send a second mail (RGM-020 / RGM2-007)
 *  - the recipient's membership is re-checked at send time, so someone removed
 *    while delivery was backlogged is not mailed (RGM3-010)
 */
import { claimOutbox, ClaimPolicy } from './claim.js';

/** Test double: records what would have been delivered. */
export const RecordingSender = () => {
  const sent = [];
  return {
    name: 'recording',
    sent,
    async send(msg) { sent.push(msg); return { messageId: `msg-${sent.length}` }; }
  };
};

/** Always fails, for retry/backoff tests. */
export const FailingSender = (message = 'smtp down') => ({
  name: 'failing',
  async send() { throw new Error(message); }
});

/**
 * Queue one notification per active tester. Call INSIDE the transition
 * transaction. `generation` is the milestone's ready_count, so a legitimate
 * second readiness cycle is not suppressed as a duplicate (RGM3-011).
 */
export async function enqueueReadyNotifications(db, {
  projectId, milestoneId, generation, milestoneCode = null
}) {
  const recipients = await db.query(
    `SELECT user_id FROM active_memberships WHERE project_id = $1 AND role = 'tester'`,
    [projectId]);

  let queued = 0;
  for (const r of recipients.rows) {
    const key = `milestone.ready:${milestoneId}:gen${generation}:${r.user_id}`;
    const res = await db.query(
      `INSERT INTO notifications_outbox
         (kind, project_id, subject_id, recipient_id, dedupe_key, payload)
       VALUES ('milestone.ready', $1, $2, $3, $4, $5)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [projectId, milestoneId, r.user_id, key,
        JSON.stringify({ milestoneCode, generation })]);
    queued += res.rows.length;
  }
  return { recipients: recipients.rows.length, queued };
}

const backoffSeconds = (attempts) => Math.min(300, 2 ** Math.min(attempts, 8));

/**
 * Compose the human-facing message.
 *
 * This belongs here rather than in the mailer: what a notification says is a
 * product decision, and every transport (SMTP, an HTTP provider, the console)
 * should send the same words. The first revision passed only ids to the mailer,
 * so a real transport had a recipient and no message.
 *
 * Vietnamese first, because the recipient of a readiness notice is the tester.
 */
export function composeNotification(n) {
  const payload = n.payload ?? {};
  if (n.kind === 'milestone.ready') {
    const code = payload.milestoneCode ?? 'milestone';
    return {
      subject: `[RGM] ${code} sẵn sàng kiểm thử`,
      body: [
        `Cột mốc ${code} đã sẵn sàng để kiểm thử.`,
        '',
        'Mở ứng dụng để xem các cột mốc và gửi lỗi kèm ảnh chụp màn hình:',
        n.baseUrl ?? '(chưa cấu hình địa chỉ ứng dụng)',
        '',
        `-- `,
        `Thông báo: ${n.kind}`,
        `Mã: ${n.dedupe_key}`
      ].join('\n')
    };
  }
  return {
    subject: `[RGM] ${n.kind}`,
    body: JSON.stringify(payload, null, 2)
  };
}

/**
 * Drain the outbox. A send failure is recorded and retried with backoff; it never
 * reverts the milestone transition.
 */
export async function runOutbox(db, sender, { workerId, max = 50,
                                              policy = ClaimPolicy, baseUrl = null } = {}) {
  const results = [];

  for (let i = 0; i < max; i++) {
    const job = await claimOutbox(db, workerId, policy);
    if (!job) break;

    const r = await db.query(
      `SELECT o.*, u.email FROM notifications_outbox o
         JOIN users u ON u.id = o.recipient_id WHERE o.id = $1`, [job.id]);
    const n = r.rows[0];

    // Re-check at delivery time: a member removed while delivery was backlogged
    // must not be mailed.
    const stillActive = await db.query(
      `SELECT 1 FROM active_memberships WHERE project_id = $1 AND user_id = $2`,
      [n.project_id, n.recipient_id]);
    if (!stillActive.rows.length) {
      await db.query(
        `UPDATE notifications_outbox SET status = 'cancelled', error = 'recipient no longer a member'
          WHERE id = $1`, [n.id]);
      results.push({ id: n.id, status: 'cancelled' });
      continue;
    }

    try {
      const message = composeNotification(n);
      const res = await sender.send({
        to: n.email,
        kind: n.kind,
        subjectId: n.subject_id,
        // Same key as the provider idempotency key and the Message-ID.
        idempotencyKey: n.dedupe_key,
        dedupeKey: n.dedupe_key,
        payload: n.payload,
        baseUrl,
        subject: message.subject,
        body: message.body
      });
      await db.query(
        `UPDATE notifications_outbox
            SET status = 'sent', sent_at = now(), provider_message_id = $1, error = NULL
          WHERE id = $2 AND claimed_by = $3`,
        [res?.messageId ?? null, n.id, workerId]);
      results.push({ id: n.id, status: 'sent', messageId: res?.messageId ?? null });
    } catch (err) {
      // Release the claim with a backoff window; the lease doubles as the delay.
      await db.query(
        `UPDATE notifications_outbox
            SET status = 'pending', error = $1, claimed_by = NULL,
                lease_until = now() + make_interval(secs => $2::int)
          WHERE id = $3 AND claimed_by = $4`,
        [String(err.message).slice(0, 500), backoffSeconds(n.attempts), n.id, workerId]);
      results.push({ id: n.id, status: 'retry', error: err.message });
    }
  }

  return results;
}
