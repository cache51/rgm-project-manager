-- 005_runtime_role.sql — supersede the old name additively, never rename it
--
-- Closes IR-004 for installations that already applied the old 002, and closes
-- RGM4-004 for this file's first attempt at doing so.
--
-- History, because it matters here:
--
--   The first 002 created `rgm_app` with grants only on `events`. That name implied
--   the application's runtime role, but the role could not read `users`, `bugs` or
--   anything else, so a deployment that used it was broken (IR-004).
--
--   The first version of THIS file (then named 005_runtime_role_rename.sql) renamed
--   it: `ALTER ROLE rgm_app RENAME TO rgm_runtime`. That is worse than the problem it
--   fixed. Role names are **cluster-wide**, so renaming changes the identity for
--   every other database on the server — their grants follow the new name — and it
--   breaks any login an operator created under that name, including a DATABASE_URL
--   that authenticates as it (RGM4-004).
--
-- What this does instead:
--
--   * Introduces `rgm_runtime` additively (created by 002 on fresh installs).
--   * Where `rgm_app` still exists, GRANTs the runtime group to it, so a deployment
--     that relied on that name regains the access the old migration denied it —
--     without its identity changing.
--   * Never renames, never drops. Removing a role is an operator's decision, made
--     with knowledge of what else on the cluster depends on it.

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rgm_app')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rgm_runtime') THEN
    EXECUTE 'GRANT rgm_runtime TO rgm_app';
    RAISE NOTICE 'rgm_app now inherits rgm_runtime; its identity is unchanged';
  END IF;
END
$migration$;
