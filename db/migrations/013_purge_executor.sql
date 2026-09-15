-- 013_purge_executor.sql — isolate purge authority and persist object cleanup
--
-- rgm_runtime is used by every app/worker database session. It must not be able
-- to turn a caller-supplied user id into site-admin authority, forge a tombstone,
-- or mutate the object-cleanup queue. Hard purge runs only in an explicit
-- one-shot container with the existing migration-owner connection.

CREATE TABLE admin_storage_cleanup (
  audit_id    bigint NOT NULL REFERENCES admin_audit_log(id),
  project_id  uuid NOT NULL,
  storage_key text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  cleaned_at  timestamptz,
  PRIMARY KEY (audit_id, storage_key),
  UNIQUE (project_id, storage_key)
);

CREATE INDEX admin_storage_cleanup_pending_idx
  ON admin_storage_cleanup (project_id, created_at)
  WHERE cleaned_at IS NULL;

-- Every issued app-local upload capability is tracked until completion. Purge
-- deletes the row under the project lock, which revokes the capability before
-- its staging and any claimed final key join the durable object-cleanup queue.
CREATE TABLE pending_uploads (
  storage_key       text PRIMARY KEY,
  final_storage_key text,
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  bug_id            uuid NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pending_uploads_project_expiry_idx
  ON pending_uploads (project_id, expires_at);

DROP FUNCTION admin_purge_project(uuid, uuid, text, boolean);

CREATE FUNCTION admin_purge_project(
  p_actor_email text,
  p_project_id uuid,
  p_reason text,
  p_force boolean DEFAULT false
) RETURNS TABLE(project_name text, storage_keys text[], audit_reason text, audit_force boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_project_name text;
  v_storage_keys text[];
  v_audit_id bigint;
  v_reason text;
  v_force boolean;
  v_actor_email text;
BEGIN
  SELECT email INTO v_actor_email
    FROM public.users
   WHERE lower(email) = lower(btrim(p_actor_email))
     AND is_site_admin = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'site administrator required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 12 THEN
    RAISE EXCEPTION 'a meaningful purge reason is required'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT p.name
    INTO v_project_name
    FROM public.projects p
   WHERE p.id = p_project_id
     AND (p.deleted_at IS NOT NULL OR COALESCE(p_force, false))
   FOR UPDATE;

  IF NOT FOUND THEN
    -- The database purge may already have committed while object cleanup failed
    -- or the app crashed. Return the original tombstone and only pending keys so
    -- rerunning the exact CLI command safely resumes cleanup without a new audit.
    SELECT a.id, a.target_name, a.reason, COALESCE((a.metadata->>'force')::boolean, false)
      INTO v_audit_id, v_project_name, v_reason, v_force
      FROM public.admin_audit_log a
     WHERE a.target_id = p_project_id::text
       AND a.action = 'project.purged'
     ORDER BY a.at DESC
     LIMIT 1;
    IF NOT FOUND THEN
      RETURN;
    END IF;

    SELECT COALESCE(array_agg(c.storage_key ORDER BY c.storage_key), ARRAY[]::text[])
      INTO v_storage_keys
      FROM public.admin_storage_cleanup c
     WHERE c.audit_id = v_audit_id
       AND c.cleaned_at IS NULL;

    project_name := v_project_name;
    storage_keys := v_storage_keys;
    audit_reason := v_reason;
    audit_force := v_force;
    RETURN NEXT;
    RETURN;
  END IF;


  SELECT COALESCE(array_agg(keys.storage_key ORDER BY keys.storage_key), ARRAY[]::text[])
    INTO v_storage_keys
    FROM (
      SELECT a.storage_key
        FROM public.bug_attachments a
       WHERE a.project_id = p_project_id
      UNION
      SELECT u.storage_key
        FROM public.pending_uploads u
       WHERE u.project_id = p_project_id
      UNION
      SELECT u.final_storage_key
        FROM public.pending_uploads u
       WHERE u.project_id = p_project_id
         AND u.final_storage_key IS NOT NULL
    ) AS keys;

  v_reason := btrim(p_reason);
  v_force := COALESCE(p_force, false);

  ALTER TABLE public.events DISABLE TRIGGER events_no_update;
  ALTER TABLE public.events DISABLE TRIGGER events_no_truncate;

  INSERT INTO public.admin_audit_log
    (actor_id, action, target_id, target_name, reason, metadata)
  VALUES (
    NULL,
    'project.purged',
    p_project_id,
    v_project_name,
    v_reason,
    jsonb_build_object(
      'force', v_force,
      'storageKeys', to_jsonb(v_storage_keys),
      'authorization', 'docker-host',
      'actorEmail', v_actor_email
    )
  )
  RETURNING id INTO v_audit_id;

  INSERT INTO public.admin_storage_cleanup (audit_id, project_id, storage_key)
  SELECT v_audit_id, p_project_id, key
    FROM unnest(v_storage_keys) AS key;

  DELETE FROM public.event_translations
   WHERE event_id IN (SELECT id FROM public.events WHERE project_id = p_project_id);
  DELETE FROM public.bug_translations
   WHERE bug_id IN (SELECT id FROM public.bugs WHERE project_id = p_project_id);
  DELETE FROM public.pending_uploads WHERE project_id = p_project_id;
  DELETE FROM public.bug_attachments WHERE project_id = p_project_id;
  DELETE FROM public.notifications_outbox WHERE project_id = p_project_id;
  DELETE FROM public.events WHERE project_id = p_project_id;
  DELETE FROM public.bugs WHERE project_id = p_project_id;
  DELETE FROM public.milestones WHERE project_id = p_project_id;
  DELETE FROM public.memberships WHERE project_id = p_project_id;
  DELETE FROM public.invitations WHERE project_id = p_project_id;
  DELETE FROM public.project_counters WHERE project_id = p_project_id;
  DELETE FROM public.projects WHERE id = p_project_id;

  ALTER TABLE public.events ENABLE TRIGGER events_no_update;
  ALTER TABLE public.events ENABLE TRIGGER events_no_truncate;

  project_name := v_project_name;
  storage_keys := v_storage_keys;
  audit_reason := v_reason;
  audit_force := v_force;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION admin_mark_storage_cleaned(
  p_project_id uuid,
  p_storage_key text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.admin_storage_cleanup
     SET cleaned_at = COALESCE(cleaned_at, now())
   WHERE project_id = p_project_id
     AND storage_key = p_storage_key;
  RETURN FOUND;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rgm_runtime') THEN
    REVOKE EXECUTE ON FUNCTION admin_purge_project(text, uuid, text, boolean) FROM rgm_runtime;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON admin_audit_log FROM rgm_runtime;
    REVOKE ALL ON admin_storage_cleanup FROM rgm_runtime;
  END IF;
END;
$$;

REVOKE ALL ON admin_storage_cleanup FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_purge_project(text, uuid, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_mark_storage_cleaned(uuid, text) FROM PUBLIC;
