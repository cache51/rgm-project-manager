# PLAN — RGM Project Manager

Developer ↔ tester communication hub for multiple internal projects.

*v3 — closes all open items from the round-2 dual review (Codex RGM-010…022,
Claude RGM2-001…016). Round history and dispositions: `PLAN-REVIEW-LOG.md`.*

> **Superseded in part by `PLAN-v4.md`.** This document is the design as
> intended; the product now exists, so where the two disagree the code and its
> tests are authoritative. `PLAN-v4.md` records the disposition of every round-3
> finding, with evidence, and names the two that remain open.

## Problem

Testers (Vietnamese speakers) test a build after a developer marks a milestone
complete. When something breaks they describe it over chat, in Vietnamese, with
screenshots pasted wherever. The developer (Chinese/English speaker) reads
Vietnamese, mentally translates, reconstructs the repro, and hand-copies it into
an AI agent. Every hop loses context and nothing is recorded.

## Outcome

A tester files a bug against a milestone with screenshots. The developer opens it,
reads the original **and** a translation, sees a timestamped history, downloads the
screenshots, and gets the whole thing — text *and* images — into their coding agent
with one command. Multiple projects run side by side, isolated from each other.

## Scope (v1)

- Projects, each with members and its own milestones/bugs
- Milestone lifecycle `planned → in_progress → ready → done`
- Bug lifecycle with an **explicitly enumerated** transition table (§9)
- Screenshot upload via two-phase presigned PUT (§8)
- Per-language, fault-tolerant translation of bug **and** event text (§8)
- Append-only timestamped activity trail (§6)
- Ready-notification, durably queued and deduplicated (§11)
- **Agent handoff and attachment download surfaces** (§10)

Out of scope v1: free-form chat threads, email digests, native apps, per-brand
portal integration, SSO, hard delete.

## Decisions (challenge these)

1. **Next.js 15 (App Router, TS) + Postgres + S3-compatible object storage.**
   Postgres is required rather than merely chosen: §6 and §8 depend on
   `FOR UPDATE SKIP LOCKED` and multi-writer transactions, which SQLite cannot
   provide. MinIO keeps screenshots on-prem if required. Deploy target open.
2. **Passwordless email login, no passwords** (§4). Login is a **separate flow
   from invitations** — this distinction is the fix for the highest-severity
   round-2 finding.
3. **Translation is per-language, per-field, asynchronous, never blocking** (§8).
4. **Every entity has `created_at`; every state change appends an immutable event** (§6).
5. **Agent handoff is file-based** — a clipboard cannot carry screenshots (§10).
6. **Translation provider:** named and swappable behind `provider`/`model`
   columns; sends bug body and event notes off-host (§13, Q3).

---

## §1 Authorization model

**One rule:** every request resolves an actor and the *target resource's* project,
then requires an **active** membership for that pair — `revoked_at IS NULL`
(closes RGM-011) — with a role permitting the action. Project scope is derived
from the resource, never from the request body or a query parameter.

| Action | site admin | project admin | developer | tester |
|---|---|---|---|---|
| Create project | ✔ | — | — | — |
| Edit project, **create invitation**, remove member | ✔ | ✔ | — | — |
| Create/edit milestone, milestone status | ✔ | ✔ | ✔ | — |
| File bug, attach screenshots | ✔ | ✔ | ✔ | ✔ |
| `new→fixing`, `fixing→retest` | ✔ | ✔ | ✔ | — |
| Record retest result (`pass`/`fail`) | ✔ | ✔ | ✔ | ✔ |
| Read bug, read prompt, **download attachment** | ✔ | ✔ | ✔ | ✔ |
| Comment, retry a failed translation | ✔ | ✔ | ✔ | ✔ |
| Reopen a closed bug | ✔ | ✔ | ✔ | — |

**Invitations are admin-only in the matrix, the API, the repository, and the
verification steps** — closing the round-2 self-contradiction (RGM-010).

**Revocation is enforced in one place.** A single helper
`activeMembership(actor, projectId)` is the only way the repository layer may
authorize; it hard-codes `revoked_at IS NULL`. Recipient queries (notification
fan-out, invitation creation) use the same helper, so a removed member can never
be selected as a recipient (RGM-011).

**Referential integrity.** Every table that can be referenced by a composite FK
declares `UNIQUE (project_id, id)` — **including `bugs`**, which the round-2
review correctly identified as missing and therefore making
`bug_attachments`' FK invalid (RGM-016). Verified by running migrations in CI.

**Attachments.** Private bucket, no public URLs. Download requires the membership
check and returns a **5-minute signed URL**. Keys embed a random component.
Every download appends an `attachment_downloaded` audit event (§6).

## §2 Bug display numbers

```
bugs.bug_number              integer NOT NULL, UNIQUE (project_id, bug_number)
project_counters(project_id PK, next_bug_number)
```

Allocated with `UPDATE project_counters … RETURNING` **inside the bug-insert
transaction**. Numbers are immutable and never reused, including after a soft
delete. `BUG-142` resolves only within a project; the API rejects a bare number
without project scope.

## §3 Site-level authority — closes RGM-014 / RGM2-002

```
users.is_site_admin boolean NOT NULL DEFAULT false   -- set by bootstrap
```

Project-scoped roles remain in `memberships`; the *site* role is separate because
project creation must work before any project exists.

- `POST /api/projects` requires `is_site_admin`.
- Project creation happens in **one transaction**: insert `projects`, insert the
  creator's `admin` membership, insert the `project_counters` row. A project can
  never exist without an admin or a counter (closes RGM-014's "creator under a
  membership-dependent rule" gap).
- The last site admin cannot be removed; `bootstrap` refuses to mint a second one.

## §4 Authentication — closes RGM-013 / RGM2-001, RGM-010

Passwordless login, distinct from invitations, with the token in the **request
body, never the URL** (RGM2-016).

```
login_tokens(id, user_id, token_hash, expires_at, consumed_at, requested_ip, created_at)
sessions(id, user_id, token_hash, issued_at, last_seen_at, absolute_expires_at, revoked_at)
```

- `POST /api/auth/request-link {email}` → **always 200**, identical timing whether
  or not the account exists (no user enumeration). Sends only if the user exists
  and has at least one active membership. Rate-limited per email and per IP.
- `POST /api/auth/consume {token}` → one atomic `UPDATE … WHERE token_hash=$1 AND
  consumed_at IS NULL AND expires_at > now() RETURNING user_id`. Issues a session
  cookie (`HttpOnly; Secure; SameSite=Lax`), 15-minute token TTL.
- **Session scope:** one user-level session, not per-project (Claude's Q2 answer —
  §1 already checks membership per request, so per-project sessions add
  complexity for no gain). `last_seen_at` updated; **idle timeout 12 h**,
  absolute lifetime 30 days.
- **Revocation:** removing a membership revokes nothing globally but immediately
  denies every request via `activeMembership`; an explicit sign-out, an account
  switcher, and prominent display of the signed-in account on the bug form cover
  shared floor devices (§12).
- Invitations do not create sessions. An invitation links to this login flow.

## §5 Invitations — closes RGM-012, RGM-015

```
invitations(id, project_id, email, role, token_hash, expires_at,
            consumed_at, revoked_at, created_by, created_at)
```

- Random token, stored hashed, single-use, TTL 72 h, **admin-only creation**.
- **Redemption is one transaction** (RGM-015): consume the invitation, upsert the
  user, upsert the membership, and append the audit event — all or nothing. A
  failure after consumption cannot leave access half-granted.
- **Removing a membership also invalidates every outstanding invitation** for that
  `(project_id, normalized email)` in the same transaction (RGM-012), so a second,
  unused invitation cannot restore removed access.
- Removal and redemption **serialize on a per-`(project, email)` advisory lock**,
  so an older invitation can never win a race against a removal.
- Emails are normalized (lowercased, trimmed) on both write paths.

## §6 Timestamps, events, and atomicity — closes RGM-016/2-003, RGM-017

Typed foreign keys replace the polymorphic design the reviewers showed is not
expressible with the promised constraints:

```
events(id, seq BIGSERIAL, project_id UUID NOT NULL,
       bug_id UUID NULL, milestone_id UUID NULL,
       actor_id UUID NOT NULL, session_id UUID NULL,
       kind event_kind NOT NULL, payload jsonb NOT NULL DEFAULT '{}',
       at timestamptz NOT NULL DEFAULT now(),
       CHECK (num_nonnulls(bug_id, milestone_id) = 1),
       FOREIGN KEY (project_id, bug_id)       REFERENCES bugs(project_id, id),
       FOREIGN KEY (project_id, milestone_id) REFERENCES milestones(project_id, id))
```

`subject_type/subject_id` is derived for reads, not stored — so an event cannot
point at a subject in another project, and the FK is real.

**Privileges (RGM-017).** The application role gets `SELECT, INSERT` on `events`
plus `USAGE` on its sequence. `UPDATE`, `DELETE`, `TRUNCATE` are denied — the
insert-only *intent* is kept, but the role can still read timelines and run the
`max(events.at)` reconciliation. Migrations and ownership sit under a separate role.

**Atomicity.** Every state change runs in one transaction: validate transition →
update entity → insert event → update the `updated_at` cache. A forced failure
inserting the event rolls back the status change, so current state and history
cannot disagree. Writers take `SELECT … FOR UPDATE` on the subject row; every
transition is validated against the state read inside that lock.

**Ordering** uses `seq`; `at` is displayed. Timestamps are `timestamptz` in UTC,
rendered in the project timezone (default `Asia/Ho_Chi_Minh`).

## §7 Lifecycle — closes RGM2-010

Explicit table; `*→retest` no longer exists, so `closed→retest` and `new→retest`
are unrepresentable:

| From → To | Actor | Requires |
|---|---|---|
| milestone `planned→in_progress` | developer+ | — |
| milestone `in_progress→ready` | developer+ | writes outbox row (§11) |
| milestone `ready→done` | developer+ | — |
| milestone `any→planned` | project admin | reason |
| bug `new→fixing` | developer+ | — |
| bug `fixing→retest` | developer+ | sets `retest_assignee_id` (§12) |
| bug `retest→fixing` | tester+ | retest **fail**, current attempt |
| bug `retest→closed` | tester+ | retest **pass**, current attempt |
| bug `new\|fixing→closed` | developer+ | reason required |
| bug `closed→fixing` | developer+ | reason required (reopen; earlier closure is not rewritten) |

**Open-bug definition:** every state except `closed`. Sidebar counts, nav badge,
and header all derive from this one helper.

## §8 Upload and translation — closes RGM2-004, RGM2-005, RGM2-006

### Two-phase upload (RGM2-006)

Object PUTs must not run inside the counter transaction, or the
`project_counters` row lock is held across multi-MB transfers and every tester
serializes behind one lock.

1. `POST /api/projects/:id/bugs` — bug + counter + translation rows. Small and fast.
2. `POST /api/bugs/:id/attachments/presign` → signed PUT URL for
   `project/bug/random`; returns the key.
3. Client PUTs directly to storage (also where §14's downscale + EXIF strip happen).
4. `POST /api/bugs/:id/attachments/complete` → server `HEAD`s the object,
   validates size and content-type, inserts the row. Unconfirmed keys are garbage
   collected after 24 h.

### Translation, per language and per field (RGM2-005)

Two typed tables, so FKs survive (the reason not to generalize into one
polymorphic table):

```
bug_translations(bug_id, field, lang, status, provider, model, text, error,
                 attempts, lease_until, claimed_by, updated_at)
                 PK (bug_id, field, lang)          field: title | body
event_translations(event_id, field, lang, …)
                 PK (event_id, field, lang)        field: note
```

A tester's Vietnamese **retest-fail note lives on an event** and was previously
untranslated, so the developer hit Vietnamese mid-timeline; `event_translations`
closes that. Translation rows are created in the same transaction as their
subject, so the rows *are* the durable queue.

### Leases (RGM-018 / RGM2-004)

`SKIP LOCKED` only guards while a transaction is open. With an explicit lease:

```sql
UPDATE translations SET status='running', claimed_by=$worker,
       lease_until = now() + interval '2 minutes'
WHERE id = (SELECT id FROM translations
            WHERE status='pending' AND (lease_until IS NULL OR lease_until < now())
            ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING *;
```

- A worker that commits `running` and dies leaves an expired lease; the row is
  reclaimed, `attempts` increments, and after N attempts it parks at `failed`.
- Long provider calls extend the lease with a heartbeat.
- Verification kills a worker mid-job and asserts reclaim — not just recovery from
  `pending`.

**A bug is always accepted.** The Vietnamese original is the source of truth; a
translation outage degrades reading, never reporting. The prompt endpoint omits a
missing translation and marks it `unavailable (pending|failed)`; it never blocks
and never fabricates.

## §9 Data model (v3)

```
users(id, email UNIQUE, display_name, locale, is_site_admin, created_at)
projects(id, name, client, env, timezone, created_at)
memberships(project_id, user_id, role, revoked_at, created_at)  PK(project_id,user_id)
sessions(id, user_id, token_hash, issued_at, last_seen_at, absolute_expires_at, revoked_at)
login_tokens(id, user_id, token_hash, expires_at, consumed_at, requested_ip, created_at)
invitations(id, project_id, email, role, token_hash, expires_at, consumed_at,
            revoked_at, created_by, created_at)
api_tokens(id, user_id, name, token_hash, scopes, expires_at, revoked_at, last_used_at)
project_counters(project_id PK, next_bug_number)
milestones(id, project_id, code, title_*, status, due_at, completed_at, updated_at,
           created_at, UNIQUE(project_id,id), UNIQUE(project_id,code))
bugs(id, project_id, milestone_id, bug_number, reporter_id, retest_assignee_id,
     retest_attempt, severity, status, title_vi, body_vi, deleted_at,
     created_at, updated_at,
     UNIQUE(project_id,id), UNIQUE(project_id,bug_number),
     FK (project_id, milestone_id) → milestones(project_id,id))
bug_attachments(id, bug_id, project_id, storage_key, filename, byte_size,
                content_type, uploaded_at,
                FK (project_id, bug_id) → bugs(project_id,id))
bug_translations / event_translations   — see §8
events(...)                             — see §6
notifications_outbox(id, kind, project_id, subject_id, recipient_id, dedupe_key UNIQUE,
                     status, lease_until, claimed_by, attempts, provider_message_id,
                     sent_at, error, created_at)
```

Deletion (RGM2-012): v1 has **no hard delete**. `bugs.deleted_at` is a soft
delete, appended with a `deleted` event and excluded from open-bug counts. Numbers
are never reused.

## §10 Downloading and agent handoff — *where the developer gets the files*

Three surfaces, all behind the same membership check, all audited.

**1. In the bug detail UI.** Each screenshot renders inline; clicking opens the
full image, and a **Download all (N)** control produces a zip. Filenames are
preserved but normalized, and the zip is named `BUG-142-<slug>.zip`.

**2. CLI — the lowest-effort path into a coding agent.**

```
$ rgm link <project-id>          # writes .rgm.json binding repo → project (once)
$ rgm pull 142
✔ .rgm/BUG-142/bug.md
✔ .rgm/BUG-142/meta.json
✔ .rgm/BUG-142/screenshot_01.png
✔ .rgm/BUG-142/screenshot_02.png
→ now say: "fix BUG-142"
```

- `bug.md` is built by the **same server-side function** as the clipboard payload,
  so the two can never drift.
- Each screenshot is linked in `bug.md` to the timeline moment it was attached.
- The packet's project metadata is validated against `.rgm.json` **before** any
  file is written, so a stale binding cannot pull the wrong project's bug.
- `.rgm/` ignores itself via `.rgm/.gitignore` containing `*` — a shared tracked
  file is never mutated.
- `rgm pull` resolves the display number through
  `GET /api/projects/:id/bugs/by-number/:n`, authorized by membership (RGM-021).

**3. API.** `GET /api/attachments/:id` → `302` to a 5-minute signed URL;
`GET /api/bugs/:id/packet` → the zip the CLI consumes.

**Machine credentials (RGM-022).** `api_tokens` are hashed at rest, bound to a
user, **scoped** to the operations the CLI needs, expire (default 90 days), and
are revocable per device. Removing a membership or changing a role immediately
removes the corresponding scope, because scopes are re-checked against
`activeMembership` on every request. `rgm auth` stores the token in the OS
keychain, never in the repo. Blast radius of a lost laptop is documented in §13.

**Clipboard** remains a one-click fallback for the text half of a single bug.

## §11 Notifications — closes RGM-020 / RGM2-007

- The milestone→`ready` transition writes the outbox row **in the same transaction**.
- Channel v1: email to every **active** tester membership. Destination: an
  authenticated link to that milestone's tester view.
- **Delivery guarantee stated honestly: at-least-once with provider-side
  deduplication — not exactly-once.** A unique `dedupe_key` prevents duplicate
  outbox *rows*; it cannot prevent a second *email* if the provider accepts and
  the worker crashes before recording. Mitigation: the same `dedupe_key` is passed
  as the provider's idempotency key **and** as the RFC 5322 `Message-ID`, a
  `sending` state is written under the §8 lease, and `provider_message_id` is
  persisted.
- Verification 8 asserts no duplicate *delivery* against a cooperating provider,
  and that a mid-send crash retries without a second mail.

## §12 Retest — closes RGM-019 / RGM2-011

- `bugs.retest_assignee_id` is set during `fixing→retest`, with an event. If left
  null, **any active tester member of the project** may record the result — which
  matches the §1 table and is the honest reading of "assigned to retest".
- `bugs.retest_attempt` increments on every entry into `retest`. The result request
  carries `expected_attempt`; a stale result is rejected under the subject lock, so
  a delayed `pass` from cycle 1 cannot close cycle 3.
- A `fail` returns the bug to `fixing` on the **same** bug; no duplicate, history intact.

## §13 Data handling and provider — closes RGM2-016

Decision 1 favours on-prem, but bug bodies contain client names and PO numbers.
Therefore: the translation provider is **named in config**, its retention terms
recorded, and the integration sits behind `provider`/`model` columns so it can be
swapped for a self-hosted model without schema change. Q3 in the open questions
asks whether that is sufficient or whether a self-hosted translator must be the
default for v1. EXIF is stripped client-side at upload (§8), so screenshots do not
leak GPS or device identity. **Known blast radius of a stolen developer laptop:**
every bug, comment, and screenshot in every project that developer belongs to,
plus status-write authority — bounded by token expiry (§10).

## §14 API surface (v3)

```
POST   /api/auth/request-link              always 200
POST   /api/auth/consume                   body token → session
POST   /api/projects                       site admin only
POST   /api/projects/:id/milestones        developer+
POST   /api/milestones/:id/status          developer+ ; event + outbox
POST   /api/invites                        admin only
POST   /api/invites/:token/redeem          anonymous ; atomic
DELETE /api/projects/:id/members/:userId   admin ; revokes sessions + invites
POST   /api/projects/:id/bugs              tester+ ; small, no uploads
POST   /api/bugs/:id/attachments/presign   tester+ ; signed PUT
POST   /api/bugs/:id/attachments/complete  tester+ ; HEAD + row
POST   /api/bugs/:id/status                developer+
POST   /api/bugs/:id/retest                tester+ ; {result, note, expected_attempt}
POST   /api/bugs/:id/comments              tester+ ; note, translated
POST   /api/bugs/:id/translations/:lang/retry  tester+
GET    /api/projects/:id/bugs/by-number/:n tester+ ; CLI number resolution
GET    /api/bugs/:id                       scoped read
GET    /api/bugs/:id/prompt                text block ; never blocks on translation
GET    /api/bugs/:id/packet                zip (CLI target)
GET    /api/attachments/:id                → 302 to 5-min signed URL
```

## §15 Verification

1. **Empty DB → working system.** `bootstrap` + `seed:project`; no manual SQL.
2. **Cross-project isolation.** Same-named milestone `M2` in A and B; a bug in A
   referencing B's milestone **fails at the FK**; a B-only actor cannot read A's
   bug, prompt, packet, or attachment. Automated, not eyeballed.
3. **Invite contract.** Consumed invite refused; expired/revoked refused; removing
   a member invalidates their other outstanding invitations and immediately denies
   their requests.
4. **Auth.** Requesting a link for an unknown email returns 200 and sends nothing;
   a consumed or expired login token is refused; idle timeout expires a session.
5. **Translation resilience.** Provider stubbed to fail → bug still created, original
   renders, language shows `failed`, retry succeeds. **Worker killed after committing
   `running` is reclaimed by lease expiry.**
6. **Retest note translated.** A Vietnamese retest-fail note produces a
   `zh`/`en` event translation, and the developer timeline shows no raw Vietnamese.
7. **Atomicity.** Forced failure inserting the event rolls back the status change;
   repeated for retest and for reopen.
8. **Notification.** `ready` emails each active tester exactly once with a working
   link; repeating the transition does not re-notify; a crash mid-send retries
   without a duplicate delivery.
9. **Attachments.** Bug detail download works; `.rgm/` packet contains every
   screenshot; `bug.md` is byte-identical to the clipboard payload; a stale
   `.rgm.json` binding refuses to write.
10. **Upload path.** A 6 MB screenshot from a 390 px viewport is downscaled, EXIF
    stripped, uploaded via presigned PUT, and never holds the counter lock — 50
    concurrent bug creations yield 50 distinct numbers (§2).
11. **Transitions.** `closed→retest` and `new→retest` are rejected; a stale
    `expected_attempt` is rejected.
12. **Privileges.** The app role is refused `UPDATE`/`DELETE` on `events` but can
    `SELECT` the timeline.

Proof command: `pnpm test && pnpm run e2e:smoke`

## Open questions for the reviewer

- Q1: Postgres is now a requirement (§6, §8), not a preference — does that settle
  the stack question, or should the existing Python/FastAPI tooling be reused?
- Q2: Is one user-level session with a 12 h idle timeout the right call for shared
  floor devices, versus shorter per-action auth?
- Q3: Must the translator be self-hosted for v1 given §13, or is a named cloud
  provider with recorded terms sufficient for internal bug reports?
- Q4: Are 90-day scoped API tokens acceptable, or do they need rotation enforced?
- Q5: Does the §11 at-least-once-with-dedupe guarantee meet the operational bar,
  or is a transactional outbox with provider receipts required?

## Risks

- R1 Translation quality on garment jargon — mitigated by a glossary.
- R2 Tester adoption mid-season — mitigated by §11 linking testers directly.
- R3 Android/Chrome device estate — camera-roll upload only.
- R4 Developer laptop holding an `rgm` token (§10, §13).
- R5 Scope growth: v3 is a full specification; the build should be sliced so §4/§5
  (auth) land before §8 (translation) and §10 (CLI).
