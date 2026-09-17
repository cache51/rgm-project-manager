-- 015: emails carried on a bug, and notified when it is marked fixed.
--
-- The outbox addressed people only by user id (`recipient_id NOT NULL REFERENCES
-- users`), which cannot express "send this to an address". A developer wants the
-- tester who reported a bug — or a colleague not yet in the project — to hear
-- when the fix is ready to verify, so a recipient is now either a user or a
-- plain address, never both and never neither.

ALTER TABLE notifications_outbox
  ALTER COLUMN recipient_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS recipient_email text;

-- Exactly one form of address per row: a user OR an email. A row with neither
-- would sit in the outbox for ever, unsendable and unnoticed.
ALTER TABLE notifications_outbox
  ADD CONSTRAINT notifications_outbox_one_recipient
    CHECK ((recipient_id IS NULL) <> (recipient_email IS NULL));

-- The addresses a developer attached to one bug. Kept per bug, not per project:
-- the point is "tell these people about THIS report".
CREATE TABLE IF NOT EXISTS bug_watchers (
  bug_id   uuid NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  -- Stored normalized (trimmed, lowercased) so the same address twice is one row.
  email    text NOT NULL,
  added_by uuid REFERENCES users(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bug_id, email)
);

-- The retest notification looks the list up by bug, once per attempt.
CREATE INDEX IF NOT EXISTS bug_watchers_bug_idx ON bug_watchers (bug_id);