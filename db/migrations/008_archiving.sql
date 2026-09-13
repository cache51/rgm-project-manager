-- Removing a project or a milestone, the way a bug is already removed.
--
-- `bugs.deleted_at` has existed since 001_init as a soft delete (RGM2-012) and the bug
-- read paths already honour it — but nothing could ever set it, so there was no way to
-- remove a bug at all. Projects and milestones had no equivalent column.
--
-- This adds the same column to those two tables rather than introducing a second
-- concept called "archive": one name, one meaning, and the bug paths that already
-- filter on it start working.
--
-- Nothing here deletes a row. A bug is evidence — of what a tester saw, when, and with
-- which screenshot — and a project holds that whole history. The schema's
-- ON DELETE CASCADE would take the attachments, translations, events and invitations
-- with it, silently and irreversibly, as a side effect of one request. Removal is a
-- timestamp; restoring is an UPDATE.

ALTER TABLE projects   ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE milestones ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Nullable and unset for everything already here, so existing rows are adopted as live
-- without a rewrite.

-- The read paths filter on `deleted_at IS NULL`; these keep the filters from becoming
-- sequential scans.
CREATE INDEX IF NOT EXISTS projects_live_idx
  ON projects (name) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS milestones_live_idx
  ON milestones (project_id, code) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS bugs_live_idx
  ON bugs (project_id, created_at DESC) WHERE deleted_at IS NULL;
