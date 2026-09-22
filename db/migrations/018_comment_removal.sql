-- 018: withdrawing a comment nobody has answered yet.
--
-- A developer writes a note on a bug — "fixed in abc1234", a correction, a detail
-- they have since learned better — and sometimes it is wrong, premature, or on the
-- wrong bug. Until now there was no way to take it back: the timeline only grew, so
-- the wrong sentence stayed the last thing the tester read, and the tester acted on
-- it.
--
-- The timeline is `events`, and `events` is append-only in the database itself (the
-- events_no_update trigger from 001_init, and rgm_runtime holds neither UPDATE nor
-- DELETE on it). That is not an obstacle to route around: it is what makes "what the
-- tester saw, and when" trustworthy. So removal is not an UPDATE of the comment and
-- not a DELETE of it — it is a new fact recorded beside it: this comment was
-- withdrawn, by whom, at what time. Restoring one is deleting this row.
--
-- The gate is the answer, not seniority: only a comment that nobody has answered can
-- be withdrawn. Once someone has replied, the two are a conversation and both halves
-- belong to the record — which is the same rule the question loop already uses
-- (016): an answer has to come from someone other than the person who asked.
--
-- The author may withdraw their own; a project admin may withdraw any unanswered one.
-- Nothing here is visible in the timeline once removed — the point is that the wrong
-- sentence stops being read — and nothing is destroyed: the comment row itself is
-- still in `events` for the audit trail.
CREATE TABLE IF NOT EXISTS comment_removals (
  -- One row per withdrawn comment: a second removal cannot quietly restate who
  -- removed it or when.
  event_id   bigint PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  removed_by uuid NOT NULL REFERENCES users(id),
  removed_at timestamptz NOT NULL DEFAULT now()
);

-- The read path filters comments through `NOT EXISTS (... WHERE event_id = e.id)`,
-- keyed by the primary key above; this keeps the withdrawals themselves listable
-- (which is what an audit looks at) without a scan.
CREATE INDEX IF NOT EXISTS comment_removals_when_idx
  ON comment_removals (removed_at DESC);