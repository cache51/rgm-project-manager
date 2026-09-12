-- 002_privileges.sql — role separation for the events table
-- @skip-when: no-roles
-- Closes RGM-017 / RGM-S1-009.
--
-- 001_init.sql's comment claimed this file existed; it did not. The append-only
-- trigger in 001 is the guarantee that survives any role, and this migration is
-- defence in depth: the application connects as `rgm_app` and can only read and
-- append history, never rewrite it.
--
-- NOT executed by `npm test`: PGlite runs single-user and cannot create roles, so
-- the suite verifies the trigger instead. Apply this with the migration owner
-- against a real cluster, AFTER the two roles exist:
--
--   CREATE ROLE rgm_owner LOGIN PASSWORD '…';   -- owns the schema, runs migrations
--   CREATE ROLE rgm_app   LOGIN PASSWORD '…';   -- the application connects as this

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rgm_app') THEN
    RAISE EXCEPTION
      'role rgm_app must exist before 002_privileges.sql can be applied';
  END IF;
END
$$;

-- Start from a clean slate for the application role.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM rgm_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM rgm_app;
GRANT  USAGE ON SCHEMA public TO rgm_app;

-- ── the narrow surface: history is readable and appendable, nothing else ──
GRANT  SELECT, INSERT      ON events           TO rgm_app;
GRANT  USAGE               ON SEQUENCE events_id_seq TO rgm_app;
REVOKE UPDATE, DELETE, TRUNCATE ON events      FROM rgm_app;

-- ── everything else the application legitimately needs ──
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users,
  projects,
  memberships,
  login_tokens,
  sessions,
  api_tokens,
  invitations,
  project_counters,
  milestones,
  bugs,
  bug_attachments,
  bug_translations,
  event_translations,
  notifications_outbox
TO rgm_app;

-- The application must not be able to turn the trigger off, nor to hand itself
-- privileges later. Only the owner may ALTER these objects.
REVOKE ALL ON FUNCTION events_append_only() FROM PUBLIC;

-- New tables created later must not be reachable by default.
ALTER DEFAULT PRIVILEGES FOR ROLE rgm_owner IN SCHEMA public
  REVOKE ALL ON TABLES FROM rgm_app;

COMMIT;
