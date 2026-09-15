-- Operator-level audit log. Survives project deletion.
--
-- The events table is the in-project audit log: a project lives, bugs are filed,
-- events accumulate, the project is soft-deleted, restored or kept. That model
-- breaks at the moment of a hard purge — the project_id that all events point at
-- disappears, and ON DELETE CASCADE takes the audit trail with it.
--
-- admin_audit_log is a parallel log for actions that are *about* a project but are
-- not tied to its lifecycle: the moment an operator chose to erase it. Rows here
-- have no FK to projects — the operator's identity and the project name at the
-- time of action are recorded in the row itself. So a purge leaves a permanent
-- answer to "who removed this and why", even though the project no longer exists.
--
-- The `target_name` column captures the project's name at the moment of the
-- action. A project can be renamed and later purged; the audit log records the
-- name as it was when the action happened, not what it was when the audit row is
-- read — because the project row no longer exists to look it up against.
CREATE TABLE admin_audit_log (
  id          bigserial PRIMARY KEY,
  -- The operator who took the action. CASCADE with the user is wrong — a former
  -- employee's action against a deleted project should still be in the log. SET
  -- NULL keeps the row but loses the actor, which is the lesser evil.
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  -- What was done. New kinds can be added (admin.role_change, etc.) — the kinds
  -- here are global, not per-project.
  action      text NOT NULL CHECK (action IN ('project.purged')),
  -- The target project's id at the time of action. UUID is just text for this
  -- purpose, so it is stored as text to allow sentinel values if future actions
  -- ever need them.
  target_id   text NOT NULL,
  target_name text NOT NULL,
  -- The reason the operator gave. The CREATE TABLE constraint is the same 12-char
  -- floor the application enforces, so a log entry is by definition well-formed.
  reason      text NOT NULL CHECK (length(reason) >= 12),
  -- Optional extras — e.g. force-flag, secondary action fields.
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);

-- "Who purged this and when?" — every audit query starts here.
CREATE INDEX admin_audit_log_target_idx ON admin_audit_log (target_id, at DESC);
CREATE INDEX admin_audit_log_actor_idx ON admin_audit_log (actor_id, at DESC);

-- A row whose project_id still exists is interesting; an index makes that case
-- fast too.
CREATE INDEX admin_audit_log_action_idx ON admin_audit_log (action, at DESC);

-- Migration 002 grants runtime DML on future tables. Remove mutation authority in
-- the same transaction that creates this security-sensitive table, so there is no
-- between-migration window in which a running app can forge purge tombstones.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rgm_runtime') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON admin_audit_log FROM rgm_runtime;
  END IF;
END;
$$;
