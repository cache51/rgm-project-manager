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
  // The name goes in here rather than through the caller's argument list: every
  // mail needs it now, and this is the one enqueue that did not already have the
  // project row. Read in the same transaction, so a rename mid-flight cannot
  // mean the notice describes a project by a name that no longer matches.
  const proj = await db.query(`SELECT name FROM projects WHERE id = $1`, [projectId]);
  const projectName = proj.rows[0]?.name ?? null;

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
        JSON.stringify({ milestoneCode, generation, projectName })]);
    queued += res.rows.length;
  }
  return { recipients: recipients.rows.length, queued };
}

const backoffSeconds = (attempts) => Math.min(300, 2 ** Math.min(attempts, 8));

/**
 * Queue one mail per bug event: the reporter addressed in `To:` — the person
 * the event is asking something of — and everyone else who needs to know on
 * `cc_recipients`. One addressed mail beats N separate copies: no mailbox gets
 * the same notice three times, and recipients can see they are not alone in
 * being told.
 *
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
  if (!watchers.rows.length) return { recipients: 0, queued: 0 };

  const everyone = watchers.rows.map((w) => w.email);
  const [primary, ...cc] = everyone;
  const payload = JSON.stringify({ code, title: titleVi, projectName, attempt });
  const res = await db.query(
    `INSERT INTO notifications_outbox
       (kind, project_id, subject_id, recipient_email, cc_recipients, dedupe_key, payload)
     VALUES ('bug.retest', $1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [projectId, bugId, primary, JSON.stringify(cc),
      `bug.retest:${bugId}:attempt${attempt}`, payload]);
  return { recipients: everyone.length, queued: res.rows.length };
}

/** The whole audience of a question, deduplicated, asker excluded, in order. */
async function questionAudience(db, { projectId, bugId, reporterId, reporterEmail, askerId }) {
  let askerEmail = null;
  if (askerId) {
    const a = await db.query('SELECT email FROM users WHERE id = $1', [askerId]);
    askerEmail = a.rows[0]?.email ?? null;
  }

  const members = await db.query(
    `SELECT u.id AS user_id, u.email
       FROM active_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.project_id = $1 AND m.role IN ('developer', 'admin')
      ORDER BY u.email`, [projectId]);
  const watchers = await db.query(
    `SELECT email FROM bug_watchers WHERE bug_id = $1 ORDER BY added_at, email`, [bugId]);

  // The asker needs no copy of its own question — and in life the asker is an
  // agent whose address is not a mailbox at all: mailing it produced a 550 that
  // retried its way to parked (seen on the first production run).
  const audience = [];
  const seen = new Set();
  const add = (userId, email) => {
    if (askerId && userId === askerId) return;
    const key = String(email ?? '').toLowerCase();
    if (askerEmail && key === String(askerEmail).toLowerCase()) return;
    if (!key || seen.has(key)) return;
    seen.add(key);
    audience.push({ userId, email });
  };
  add(reporterId, reporterEmail);            // first = primary: the one who knows
  for (const m of members.rows) add(m.user_id, m.email);
  for (const w of watchers.rows) add(null, w.email);
  return audience;
}

/**
 * Queue "someone working this bug needs an answer" as ONE mail: the reporter in
 * `To:`, the project's developers and the bug's own address list on Cc.
 *
 * A question that reaches one person who is off shift is a question nobody
 * answers, so the whole audience is addressed — but in a single message, not
 * one message per person. People ride as user ids where they have accounts (so
 * delivery re-checks the membership, RGM3-010) and as bare addresses otherwise.
 */
export async function enqueueQuestionNotifications(db, {
  projectId, bugId, questionId, code, titleVi = null, projectName = null, question = null,
  askerId = null
}) {
  const who = await db.query(
    `SELECT b.reporter_id, u.email AS reporter_email
       FROM bugs b LEFT JOIN users u ON u.id = b.reporter_id
      WHERE b.id = $1`, [bugId]);

  const audience = await questionAudience(db, {
    projectId, bugId,
    reporterId: who.rows[0]?.reporter_id ?? null,
    reporterEmail: who.rows[0]?.reporter_email ?? null,
    askerId
  });
  if (!audience.length) return { recipients: 0, queued: 0 };

  const payload = JSON.stringify({ code, title: titleVi, projectName, questionId, question });
  const [primary, ...cc] = audience;
  const res = await db.query(
    `INSERT INTO notifications_outbox
       (kind, project_id, subject_id, recipient_id, recipient_email, cc_recipients,
        dedupe_key, payload)
     VALUES ('bug.question', $1, $2, $3, $4, $5::jsonb, $6, $7)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [projectId, bugId, primary.userId, primary.userId ? null : primary.email,
      // The primary's bare address is already covered by the re-check; cc rows
      // carry userId where they have one so delivery can re-check those too.
      JSON.stringify(cc.map((c) => c.userId ? { userId: c.userId, email: c.email } : c.email)),
      `bug.question:${questionId}`, payload]);

  return { recipients: audience.length, queued: res.rows.length };
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
  // The project leads the subject: a tester on several projects sorts mail by it,
  // and a bare "BUG-7" means nothing across three boards.
  const where = payload.projectName ? `[RGM] ${payload.projectName} — ` : '[RGM] ';
  if (n.kind === 'milestone.ready') {
    const code = payload.milestoneCode ?? 'milestone';
    return {
      subject: `${where}${code} sẵn sàng kiểm thử`,
      body: [
        payload.projectName ? `Dự án: ${payload.projectName}` : null,
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
      ].filter((line) => line !== null).join('\n')
    };
  }
  if (n.kind === 'bug.retest') {
    const code = payload.code ?? 'bug';
    return {
      subject: `${where}${code} đã sửa — chờ xác nhận`,
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
      subject: `${where}${code} — cần bạn làm rõ`,
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

    // Resolve Cc the same way the primary is resolved: a userId becomes the
    // user's *current* address — re-checked for membership, so a member removed
    // while delivery was backlogged drops off the list (RGM3-010) — and a bare
    // address stays as it was queued.
    const ccList = Array.isArray(n.cc_recipients) ? n.cc_recipients : [];
    const ccEmails = [];
    const ccIds = [];
    for (const entry of ccList) {
      if (typeof entry === 'string') { if (entry) ccEmails.push(entry); continue; }
      if (entry?.userId) ccIds.push({ userId: entry.userId, fallback: entry.email ?? null });
      else if (entry?.email) ccEmails.push(entry.email);
    }
    if (ccIds.length) {
      const still = await db.query(
        `SELECT m.user_id, u.email FROM active_memberships m
           JOIN users u ON u.id = m.user_id
          WHERE m.project_id = $1 AND m.user_id = ANY($2::uuid[])`,
        [n.project_id, ccIds.map((c) => c.userId)]);
      const byId = new Map(still.rows.map((row) => [String(row.user_id), row.email]));
      for (const c of ccIds) {
        const email = byId.get(String(c.userId)) ?? c.fallback;
        if (byId.has(String(c.userId)) && email) ccEmails.push(email);
      }
    }

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
        cc: ccEmails,
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
