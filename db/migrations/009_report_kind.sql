-- A report is a bug or a feature request.
--
-- The workflow is the same for both — reported, picked up, done, verified, or sent
-- back — so this is one table with a kind rather than two, and the state machine
-- stays single. What differs is what the work is called ("fixed" versus "implemented")
-- and what the report is labelled: a feature request handed to a developer numbered
-- BUG-7, in the list, in the AI-agent prompt and in the packet filename, is wrong.
--
-- The number stays one sequence per project (the report's position), and the prefix
-- follows the kind — so a project can hold BUG-1 and REQ-4. Separate sequences would
-- mean a second counter and a second immutability guarantee to keep straight, for no
-- gain: the prefix already makes the kind unambiguous.

ALTER TABLE bugs ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'bug';

-- Added separately so the constraint is named and the migration is re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bugs_kind_valid') THEN
    ALTER TABLE bugs ADD CONSTRAINT bugs_kind_valid CHECK (kind IN ('bug', 'feature'));
  END IF;
END $$;

-- Listing a project's reports of one kind is a normal filter.
CREATE INDEX IF NOT EXISTS bugs_kind_idx ON bugs (project_id, kind) WHERE deleted_at IS NULL;
