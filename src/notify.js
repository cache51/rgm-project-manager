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
 * Queue "this fix is ready to verify" for every address attached to the bug.
 * Call INSIDE the transition transaction, so a crash cannot mark a bug fixed
 * without queueing the notice that says so.
 *
 * The attempt number is part of the dedupe key: a genuinely new fix cycle
 * notifies again, while a retry of the same transition stays one message.
 */
export async function enqueueRetestNotifications(db, {
  projectId, bugId, code, titleVi = null, projectName = null, attempt
}) {
  const watchers = await db.query(
    `SELECT email FROM bug_watchers WHERE bug_id = $1 ORDER BY added_at, email`, [bugId]);

  let queued = 0;
  for (const w of watchers.rows) {
    const key = `bug.retest:${bugId}:attempt${attempt}:${w.email}`;
    const res = await db.query(
      `INSERT INTO notifications_outbox
         (kind, project_id, subject_id, recipient_email, dedupe_key, payload)
       VALUES ('bug.retest', $1, $2, $3, $4, $5)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [projectId, bugId, w.email, key,
        JSON.stringify({ code, title: titleVi, projectName, attempt })]);
    queued += res.rows.length;
  }
  return { recipients: watchers.rows.length, queued };
}

/**
 * Queue "someone working this bug needs an answer" for everyone who can give
 * one: the reporter, the project's developers, and the bug's own address list.
 *
 * A bug always has a tester (who filed it) and developers (who can act on it),
 * so the question goes to both roles rather than only the reporter — a question
 * that reaches one person who is off shift is a question nobody answers. People
 * are queued as users where possible (so a membership removed before delivery
 * still stops the mail) and as bare addresses otherwise, deduplicated by address
 * so being both the reporter and a watcher does not mean two copies.
 */
export async function enqueueQuestionNotifications(db, {
  projectId, bugId, questionId, code, titleVi = null, projectName = null, question = null
}) {
  const who = await db.query(
    `SELECT b.reporter_id, u.email AS reporter_email
       FROM bugs b LEFT JOIN users u ON u.id = b.reporter_id
      WHERE b.id = $1`, [bugId]);
  const reporterId = who.rows[0]?.reporter_id ?? null;
  const reporterEmail = who.rows[0]?.reporter_email ?? null;

  const members = await db.query(
    `SELECT u.id AS user_id, u.email
       FROM active_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.project_id = $1 AND m.role IN ('developer', 'admin')
      ORDER BY u.email`, [projectId]);
  const watchers = await db.query(
    `SELECT email FROM bug_watchers WHERE bug_id = $1 ORDER BY added_at, email`, [bugId]);

  const recipients = [];
  const seen = new Set();
  const add = (userId, email) => {
    const key = String(email ?? '').toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    recipients.push({ userId, email });
  };
  add(reporterId, reporterEmail);
  for (const m of members.rows) add(m.user_id, m.email);
  for (const w of watchers.rows) add(null, w.email);

  const payload = JSON.stringify({ code, title: titleVi, projectName, questionId, question });
  let queued = 0;
  for (const r of recipients) {
    const key = r.userId
      ? `bug.question:${questionId}:user:${r.userId}`
      : `bug.question:${questionId}:${r.email}`;
    const res = await db.query(
      `INSERT INTO notifications_outbox
         (kind, project_id, subject_id, recipient_id, recipient_email, dedupe_key, payload)
       VALUES ('bug.question', $1, $2, $3, $4, $5, $6)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      // The outbox carries exactly one of the two: a user id when there is one,
      // so delivery re-checks the membership, an address otherwise.
      [projectId, bugId, r.userId, r.userId ? null : r.email, key, payload]);
    queued += res.rows.length;
  }

  return { recipients: recipients.length, queued };
}

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
export function composeNotification(n, { baseUrl = null } = {}) {
  const payload = n.payload ?? {};
  if (n.kind === 'milestone.ready') {
    const code = payload.milestoneCode ?? 'milestone';
    return {
      subject: `[RGM] ${code} sẵn sàng kiểm thử`,
      body: [
        `Cột mốc ${code} đã sẵn sàng để kiểm thử.`,
        '',
        'Mở ứng dụng để xem các cột mốc và gửi lỗi kèm ảnh chụp màn hình:',
        // The base URL has to arrive as an argument: the outbox row has no such
        // column, so reading `n.baseUrl` always produced the placeholder (IR-024).
        baseUrl ?? '(chưa cấu hình địa chỉ ứng dụng)',
        '',
        `-- `,
        `Thông báo: ${n.kind}`,
        `Mã: ${n.dedupe_key}`
      ].join('\n')
    };
  }
  if (n.kind === 'bug.retest') {
    const code = payload.code ?? 'bug';
    return {
      subject: `[RGM] ${code} đã sửa — chờ xác nhận`,
      body: [
        payload.projectName ? `Dự án: ${payload.projectName}` : null,
        `${code}${payload.title ? ` — ${payload.title}` : ''}`,
        '',
        'Developer đã đánh dấu lỗi này là đã sửa. Hãy kiểm tra lại trên bản dựng mới,',
        'rồi xác nhận đã sửa hoặc trả lại kèm ghi chú.',
        '',
        baseUrl ?? '(chưa cấu hình địa chỉ ứng dụng)',
        '',
        '-- ',
        `Thông báo: ${n.kind}`,
        `Mã: ${n.dedupe_key}`
      ].filter((line) => line !== null).join('\n')
    };
  }
  if (n.kind === 'bug.question') {
    const code = payload.code ?? 'bug';
    return {
      subject: `[RGM] ${code} — cần bạn làm rõ`,
      body: [
        payload.projectName ? `Dự án: ${payload.projectName}` : null,
        `${code}${payload.title ? ` — ${payload.title}` : ''}`,
        '',
        'Người (hoặc agent) đang xử lý lỗi này cần bạn làm rõ một điểm:',
        '',
        payload.question ?? '(không có nội dung)',
        '',
        'Trả lời bằng một bình luận ngay trên lỗi này trong ứng dụng:',
        baseUrl ?? '(chưa cấu hình địa chỉ ứng dụng)',
        '',
        '-- ',
        `Thông báo: ${n.kind}`,
        `Mã: ${n.dedupe_key}`
      ].filter((line) => line !== null).join('\n')
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

    // A recipient is either a user (email read from their row) or a bare address
    // attached to the bug, so the join has to be outer.
    const r = await db.query(
      `SELECT o.*, COALESCE(u.email, o.recipient_email) AS email
         FROM notifications_outbox o
         LEFT JOIN users u ON u.id = o.recipient_id
        WHERE o.id = $1`, [job.id]);
    const n = r.rows[0];

    // Re-check at delivery time: a member removed while delivery was backlogged
    // must not be mailed. An address attached to a bug has no membership to
    // check — it was authorized when the developer added it.
    if (n.recipient_id) {
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
    }

    try {
      const message = composeNotification(n, { baseUrl });
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
