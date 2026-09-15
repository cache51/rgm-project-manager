-- 012_guarded_admin_purge.sql — privileged purge without an owner-login app
--
-- The runtime role cannot disable the append-only events triggers. This tightly
-- scoped SECURITY DEFINER function is the sole exception: it re-checks site-admin
-- status and every purge guard, writes the immutable tombstone, and removes the
-- project in one statement transaction.

CREATE FUNCTION admin_purge_project(
  p_actor_id uuid,
  p_project_id uuid,
  p_reason text,
  p_force boolean DEFAULT false
) RETURNS TABLE(project_name text, storage_keys text[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_project_name text;
  v_storage_keys text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users
     WHERE id = p_actor_id AND is_site_admin = true
  ) THEN
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
    RETURN;
  END IF;

  SELECT COALESCE(array_agg(a.storage_key ORDER BY a.id), ARRAY[]::text[])
    INTO v_storage_keys
    FROM public.bug_attachments a
   WHERE a.project_id = p_project_id;

  ALTER TABLE public.events DISABLE TRIGGER events_no_update;
  ALTER TABLE public.events DISABLE TRIGGER events_no_truncate;

  INSERT INTO public.admin_audit_log
    (actor_id, action, target_id, target_name, reason, metadata)
  VALUES (
    p_actor_id,
    'project.purged',
    p_project_id,
    v_project_name,
    btrim(p_reason),
    jsonb_build_object(
      'force', COALESCE(p_force, false),
      'storageKeys', to_jsonb(v_storage_keys)
    )
  );

  DELETE FROM public.event_translations
   WHERE event_id IN (SELECT id FROM public.events WHERE project_id = p_project_id);
  DELETE FROM public.bug_translations
   WHERE bug_id IN (SELECT id FROM public.bugs WHERE project_id = p_project_id);
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
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION admin_purge_project(uuid, uuid, text, boolean) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rgm_runtime') THEN
    REVOKE DELETE ON projects FROM rgm_runtime;
  END IF;
END;
$$;
