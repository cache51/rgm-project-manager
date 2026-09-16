-- 014: a structured close reason.
--
-- Closing a bug used to carry only free text, so "this is a duplicate of BUG-7"
-- and "won't fix" were indistinguishable to anything but a reader. A developer
-- now closes as either a duplicate — naming the bug it duplicates — or a
-- rejection with a reason. Both keep the free-text reason (it is translated for
-- the reporter); the kind and the reference make the decision queryable and
-- let the timeline and the packet say which bug won.
ALTER TABLE bugs
  ADD COLUMN IF NOT EXISTS close_kind text
    CHECK (close_kind IS NULL OR close_kind IN ('duplicate', 'rejected')),
  ADD COLUMN IF NOT EXISTS close_ref_bug_id uuid REFERENCES bugs(id);

-- A bug cannot be its own duplicate, and the reference must live in the same
-- project (the server checks too; this makes it impossible to forget).
ALTER TABLE bugs
  ADD CONSTRAINT bugs_close_ref_not_self
    CHECK (close_ref_bug_id IS NULL OR close_ref_bug_id <> id);
