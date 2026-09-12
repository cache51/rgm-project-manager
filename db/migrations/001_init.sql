-- RGM Project Manager — initial schema
--
-- This migration closes the two round-3 blockers, plus the schema defects the
-- reviewers found:
--
--   RGM3-001 / RGM3-002  events could only have a bug OR milestone subject, so
--                        the invitation-redemption and membership audit events
--                        required by §5 were UNINSERTABLE — the "atomic"
--                        redemption transaction could never commit.
--                        Fixed: typed nullable subject columns covering project,
--                        bug, milestone, membership and invitation, with a CHECK
--                        allowing at most one (and zero for project-level events).
--
--   RGM-016 / RGM2-003   bug_attachments referenced bugs(project_id, id) while
--                        bugs declared only UNIQUE(project_id, bug_number).
--                        Postgres requires the referenced columns to be unique,
--                        so that FK did not compile. Fixed: every table that is
--                        the target of a composite FK declares UNIQUE(project_id, id).
--
-- Also encoded here: leases (RGM-018/RGM2-004), per-field translations so retest
-- notes are translated (RGM2-005), bug display numbers (RGM-008), the readiness
-- generation used in the outbox dedupe key (RGM3-011), soft delete (RGM2-012),
-- and an append-only trigger on events that holds regardless of DB role
-- (RGM-005 / RGM-017).

BEGIN;

-- ─────────────────────────── identity ───────────────────────────
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  locale        text NOT NULL DEFAULT 'vi' CHECK (locale IN ('vi','zh','en')),
  -- Site authority is separate from project roles: project creation must work
  -- before any project exists (RGM-014 / RGM2-002).
  is_site_admin boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (email = lower(email))          -- normalised on write, enforced here
);

CREATE TABLE projects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  client     text NOT NULL,
  env        text NOT NULL DEFAULT 'staging',
  timezone   text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Role is per (project, user); a revoked row is retained for history but must
-- never satisfy an authorization check (RGM-011). `active_memberships` below is
-- the ONLY view that defines "active", so there is one place to get it right.
CREATE TABLE memberships (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('admin','developer','tester')),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE VIEW active_memberships AS
  SELECT project_id, user_id, role
  FROM memberships
  WHERE revoked_at IS NULL;

-- ─────────────────────────── auth (§4) ───────────────────────────
CREATE TABLE login_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  requested_ip inet,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- One user-level session, not per project (Claude's Q2 answer): authorization is
-- already checked per request against active_memberships, so per-project sessions
-- add complexity for no gain.
CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash         text NOT NULL UNIQUE,
  issued_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  revoked_at         timestamptz
);

-- Machine credentials for the CLI (§10). Scoped, expiring, revocable per device.
CREATE TABLE api_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  scopes       text[] NOT NULL DEFAULT ARRAY['bug:read']::text[],
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  email       text NOT NULL,
  role        text NOT NULL CHECK (role IN ('admin','developer','tester')),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at  timestamptz,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (email = lower(email)),
  -- target of a composite FK from events
  UNIQUE (project_id, id)
);
-- One live invitation per (project, email): a second create must not silently
-- coexist with an older one that removal is about to invalidate (RGM-012).
CREATE UNIQUE INDEX invitations_one_live
  ON invitations (project_id, email)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

-- ─────────────────────── milestones & bugs ───────────────────────
CREATE TABLE project_counters (
  project_id      uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  next_bug_number integer NOT NULL DEFAULT 1 CHECK (next_bug_number > 0)
);

CREATE TABLE milestones (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code         text NOT NULL,
  title_vi     text,
  title_zh     text,
  title_en     text NOT NULL,
  status       text NOT NULL DEFAULT 'planned'
                 CHECK (status IN ('planned','in_progress','ready','done')),
  due_at       timestamptz,
  completed_at timestamptz,
  -- Increments on every entry into 'ready'. Part of the outbox dedupe key, so a
  -- legitimate second ready transition is NOT suppressed (RGM3-011).
  ready_count  integer NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, code),
  -- required so bugs / events can reference (project_id, id)
  UNIQUE (project_id, id)
);

CREATE TABLE bugs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id        uuid NOT NULL,
  -- Immutable, never reused, unique per project (RGM-008).
  bug_number          integer NOT NULL CHECK (bug_number > 0),
  reporter_id         uuid NOT NULL REFERENCES users(id),
  retest_assignee_id  uuid REFERENCES users(id),
  retest_attempt      integer NOT NULL DEFAULT 0 CHECK (retest_attempt >= 0),
  severity            text NOT NULL CHECK (severity IN ('high','medium','low')),
  status              text NOT NULL DEFAULT 'new'
                        CHECK (status IN ('new','fixing','retest','closed')),
  title_vi            text NOT NULL,
  body_vi             text NOT NULL,
  deleted_at          timestamptz,        -- soft delete only (RGM2-012)
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, bug_number),
  -- required so bug_attachments / events can reference (project_id, id)
  UNIQUE (project_id, id),
  -- A bug can never point at another project's milestone.
  FOREIGN KEY (project_id, milestone_id)
    REFERENCES milestones (project_id, id) ON DELETE RESTRICT
);

CREATE TABLE bug_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL,
  bug_id       uuid NOT NULL,
  storage_key  text NOT NULL UNIQUE,
  -- Tester-supplied. Kept as DATA only; never used as a path on disk (RGM3-007).
  filename     text NOT NULL,
  byte_size    bigint NOT NULL CHECK (byte_size > 0),
  content_type text NOT NULL CHECK (content_type LIKE 'image/%'),
  uploaded_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, bug_id)
    REFERENCES bugs (project_id, id) ON DELETE CASCADE
);

-- ─────────────────── translation (per field) ───────────────────
-- Two typed tables rather than one polymorphic table, so referential integrity
-- survives. `event_translations` is what makes a Vietnamese retest-fail note
-- readable to the developer (RGM2-005).
CREATE TABLE bug_translations (
  bug_id     uuid NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  field      text NOT NULL CHECK (field IN ('title','body')),
  lang       text NOT NULL CHECK (lang IN ('vi','zh','en')),
  status     text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','running','done','failed')),
  provider   text,
  model      text,
  text       text,
  error      text,
  attempts   integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- Lease, not just SKIP LOCKED: a worker that commits 'running' then dies must
  -- become reclaimable (RGM-018 / RGM2-004).
  lease_until timestamptz,
  claimed_by  uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bug_id, field, lang),
  CHECK (status <> 'done'  OR text IS NOT NULL),
  CHECK (status <> 'failed' OR error IS NOT NULL)
);

-- ───────────────────────── events (§6) ─────────────────────────
-- Typed nullable subject columns. `num_nonnulls(...) <= 1` rather than `= 1`, so
-- project-level events (invitation redeemed, member removed) are representable —
-- this is the fix for RGM3-001 / RGM3-002.
CREATE TABLE events (
  id                 bigserial PRIMARY KEY,
  project_id         uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  bug_id             uuid,
  milestone_id       uuid,
  membership_user_id uuid,
  invitation_id      uuid,
  actor_id           uuid REFERENCES users(id),
  session_id         uuid REFERENCES sessions(id),
  kind               text NOT NULL,
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(bug_id, milestone_id, membership_user_id, invitation_id) <= 1),
  FOREIGN KEY (project_id, bug_id)             REFERENCES bugs (project_id, id),
  FOREIGN KEY (project_id, milestone_id)       REFERENCES milestones (project_id, id),
  FOREIGN KEY (project_id, membership_user_id) REFERENCES memberships (project_id, user_id),
  FOREIGN KEY (project_id, invitation_id)      REFERENCES invitations (project_id, id)
);

CREATE INDEX events_project_seq  ON events (project_id, id);
CREATE INDEX events_bug          ON events (bug_id, id)         WHERE bug_id IS NOT NULL;
CREATE INDEX events_milestone    ON events (milestone_id, id)   WHERE milestone_id IS NOT NULL;

-- ─────────────── event translations (retest notes) ───────────────
-- Declared AFTER events so `event_id` can match `events.id` (bigserial → bigint)
-- and carry a real foreign key. The first revision typed it `uuid`, which neither
-- matched the referenced column nor permitted any constraint: orphan translations
-- were representable and the intended one-transaction insert was impossible.
CREATE TABLE event_translations (
  event_id    bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  field       text NOT NULL CHECK (field = 'note'),
  lang        text NOT NULL CHECK (lang IN ('vi','zh','en')),
  status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','running','done','failed')),
  provider    text,
  model       text,
  text        text,
  error       text,
  attempts    integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until timestamptz,
  claimed_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, field, lang),
  CHECK (status <> 'done'   OR text  IS NOT NULL),
  CHECK (status <> 'failed' OR error IS NOT NULL)
);

CREATE INDEX event_translations_claimable
  ON event_translations (status, lease_until);

-- Append-only enforced in the database, so it holds regardless of which role the
-- application connects as (RGM-005). The app role is additionally granted only
-- SELECT + INSERT (see 002_privileges.sql), but a trigger cannot be forgotten by
-- a future migration that adds a DELETE endpoint.
CREATE FUNCTION events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'events is append-only (attempted %)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_no_update BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_append_only();

CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION events_append_only();

-- ──────────────────── notifications (§11) ────────────────────
CREATE TABLE notifications_outbox (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                text NOT NULL,
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subject_id          uuid,
  recipient_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Includes the milestone's ready_count, so a genuine second readiness notice
  -- is not suppressed as a duplicate (RGM3-011).
  dedupe_key          text NOT NULL UNIQUE,
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','running','sending','sent','failed','cancelled')),
  attempts            integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until         timestamptz,
  claimed_by          uuid,
  provider_message_id text,
  error               text,
  sent_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_claimable ON notifications_outbox (status, lease_until);

COMMIT;
