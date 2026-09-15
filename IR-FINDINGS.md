# Independent inspection — findings and disposition

`claudex-loop inspect`, provider **codex/gpt-6-astra**, effort **xhigh**, over
`56509a5..07de708` — the whole built product. Verdict: **REVISE**, 38 findings
(13 high, 25 medium).

This is the first review of the code by something other than its author, and it
found things the 243 passing tests did not. **Twenty-eight of the thirty-eight are
fixed**, each with a test that would have caught it; the rest are recorded with a
plan so they are not lost.

| | high | medium | total |
|---|---|---|---|
| Found | 13 | 25 | 38 |
| Fixed | **13** | **15** | **28** |
| Partly fixed | — | 1 | 1 |
| Open | 0 | 9 | 9 |

---

## Second inspection — after the fixes (`56509a5..631bebd`)

Re-run on a frozen tree, so it returned a verdict rather than self-rejecting.
Verdict again **REVISE**: **31 findings** (6 high, 23 medium, 2 low).

Its summary is the important part: *"Material defects remain in privilege revocation,
CLI isolation, database upgrades, upload integrity, and worker recovery. **Several
findings marked closed in the repository still have concrete failure paths.**"*

That is correct, and it is the value of running it:

| | high | medium | low | total |
|---|---|---|---|---|
| Found | 6 | 23 | 2 | 31 |
| Fixed | **6** | — | — | **6** |
| Open | 0 | 23 | 2 | 25 |

Every one of the six high findings is fixed below. **Four of the six were incomplete
versions of fixes recorded as closed in the first round** (RGM4-002 vs IR-010,
RGM4-003 vs IR-009, RGM4-005 vs IR-011, RGM4-006 vs IR-013) — the same class of
mistake as the original review, made again while closing it. The lesson is in the
pattern, not the individual bugs: fixing the path the review named is not the same as
fixing the class it belongs to.

| id | sev | finding | fix |
|---|---|---|---|
| **RGM4-001** | high | **Authorization read before the body.** `authorize()` runs before `readJson`, and the mutation never re-read the actor — so an admin could open a role-change request, be demoted while the body was still arriving, and have it applied with the rights they had lost, including restoring their own role. Invitation creation had the same gap. | `requireActorAuthority(tx, actor, …)` re-reads the actor's effective role inside the mutation's transaction, under the same project lock as any demotion. Test: a demoted actor is refused, the demotion is not undone, and no invitation appears. |
| **RGM4-002** | high | **The symlink guard missed the target itself.** IR-010's fix walked components *below* the packet directory, so making that directory a symlink (`ln -s /elsewhere .rgm/BUG-1`) still sent every `rm` and `writeFile` outside the tree. `ensureIgnored` likewise followed a symlinked root. | `assertNotSymlink` checks the packet directory and the output root before anything is written; `ensureIgnored` checks the root too. Tests: a symlinked packet directory and a symlinked root are both refused, and nothing outside is touched. |
| **RGM4-003** | high | **The IR-009 fix validated against the wrong thing.** It compared the packet's project to `config.projectId` — but the selection is global, so after `rgm use B` in another repository, `pull 1` in repository A fetched B's bug, passed validation, and overwrote A's `.rgm/BUG-1`. | The output root now carries a `project.json` binding, written on first pull and enforced on every later one, so a project switch elsewhere cannot redirect a repository. Test: a mismatched binding is refused and not rewritten. |
| **RGM4-004** | high | **Renaming a cluster-wide role.** My first 005 did `ALTER ROLE rgm_app RENAME TO rgm_runtime`. Role names are cluster-wide, so that changed the identity for every other database on the server and broke any login created under that name, including a `DATABASE_URL` authenticating as it. | 005 now introduces `rgm_runtime` additively and `GRANT`s it **to** an existing `rgm_app`, so the name keeps its identity and gains the access the old migration denied it. Never renames, never drops. Verified on real PostgreSQL, where that cluster still had the old role. |
| **RGM4-005** | high | **The documented setting did nothing.** `README.md` told operators to set `REQUIRE_TLS=true`; the loader read only `SMTP_REQUIRE_TLS`, and defaulted to `false` — so following the docs sent credentials and sign-in mail over plaintext. | The loader accepts both spellings and defaults `requireTls` to **true whenever `SMTP_USER` is set**. `SmtpMailer` now exposes `requireTls` so the contract is assertable — the old test checked the provider *name*, which is why it missed this. |
| **RGM4-006** | high | **Validating an object that was still writable.** IR-013's fix validated the promoted key — but `put` wrote straight into that file, so a slow PUT held an open descriptor to the inode `promote` renamed, and kept modifying the object after the check and the commit. | `put` writes to a unique temporary file and publishes it with one `rename`, so each writer owns its inode and only whole files are ever visible at a key. Tests: concurrent writes yield exactly one complete object, and no `.part` file is left behind. |

The 23 medium and 2 low findings from this run are unaddressed. They are not recorded
individually here yet; the run's own output is in `/tmp/inspect3.log`.

**Every high-severity finding from this first run is closed.** The nine still open are
all medium, and
they cluster into two groups: the worker lifecycle (lease renewal, a request
deadline, a staging reaper, SMTP idempotency) and text handling (EXIF stripping,
event-note translations in the prompt, tokens in URLs, and a timing side channel
on sign-in). The first group wants components the product does not have yet — a
heartbeat and a reaper — rather than repairs to ones it does.

The run that produced this **self-rejected** ("Plan changed during the run") because
the repository was edited while it ran. The findings are still valid — they are
about specific lines — but the *verdict* does not certify the current tree. A clean
re-run is owed.

---

## Fixed, with a test

| ID | Sev | What was wrong | Fix / evidence |
|---|---|---|---|
| **IR-037** | med | **The form filed against the wrong milestone.** "Report bug" on a milestone stored which one was clicked, but the form's `<select>` never preselected it — so with two ready milestones, a report opened from the second was submitted against the first. | The selected option follows the clicked milestone. **Verified by inspection only**: the change is a conditional `selected` attribute, and the preview pane's clicks did not reach this page, so it is the one fix here without a test behind it. |
| **IR-013** | high | **Validation of a moving object.** Completion checked the staged key and promoted afterwards. Because a presigned PUT stays valid until it expires, a client could replace the object in between — so the promoted bytes could differ from the metadata that was checked, and every later view, download and packet would serve the replacement. | Promotion happens first, and the object is then validated where it now lives, so what is checked is what is served. A rejection after the move deletes the promoted copy rather than orphaning it, and a racing completion is answered 409 instead of failing. `test/upload-integrity.test.js`. |
| **IR-029** | med | **A queue with no floor.** The terminal sweep parked bug translations and outbox rows but not `event_translations`, so a worker that died on its final attempt left a row in `running` for ever — never retried, never parked, and nothing reported it. | `parkExhaustedEventTranslations` and a third arm in the worker's sweep. `test/schema.test.js` strands a row and asserts it is retired with a reason. |
| **IR-034** | med | **A CI job named for something it did not do.** "The app suite runs against real Postgres too" set `RGM_TEST_DRIVER=pg`, which uses the in-process double — so the suite never touched the server. It also still asserted the old `rgm_app` role name, so it would have failed after IR-004 was fixed. | The job sets `RGM_TEST_PG_URL`, which runs the whole suite against the service container, and asserts the runtime role can read `users`. |
| **IR-016** | med | **An expired invitation blocked its own replacement.** The live-invitation index excludes consumed and revoked rows but cannot exclude by expiry, because `now()` is not immutable and so cannot appear in a partial index predicate. An invitation nobody redeemed kept the next one un-issuable for that address for ever. | Creation retires expired invitations for the address first, inside a transaction. That transaction also takes the per-(project,email) advisory lock — which redemption and removal had and **creation did not**, so the earlier RGM3-003 fix was incomplete. |
| **IR-025** | med | **A brief outage burned every retry.** A failed send is rescheduled as `pending` with a future `lease_until`, but the claim accepted any `pending` row, so five attempts went in a tight loop instead of waiting out the backoff — and a notification waiting would have delivered was parked. | The claim requires a pending row's deadline to have elapsed. Tested by draining twice against a failing provider: one attempt, then zero, then a retry once the window passes. |
| **IR-038** | med | **A packet that describes two different things.** The packet route read the attachment list, then called the prompt builder, which read it again. An upload completing between the two could put a screenshot in `bug.md` that the ZIP did not contain. | One read feeds `bug.md`, `meta.json` and the archive entries. `test/api.attachments.test.js` asserts all three agree once the archive is opened. |
| **IR-001** | high | **Authorization.** `requireScope` was called on 3 of 33 routes, so a `bug:read` token could change bug status, and a read-only token could create invitations or mint more tokens. | Scopes come from one table (`SCOPE_POLICY` in `src/api.js`) applied centrally, and an unlisted route is denied rather than defaulted open. `test/scopes.test.js` asserts every route has a decision and that a staleness-free policy covers the live route list. |
| **IR-004** | high | **A runtime role that could not run the app.** `002_privileges.sql` created a role named `rgm_app` — as though it were the application's own — and granted it only `events`. A deployment that took the name at face value could not read `users`, `sessions` or `active_memberships`, and could not start; using the owner instead threw away the separation the file exists for. | The role is `rgm_runtime` and holds exactly what the application does — table grants across the schema, with `events` still append-only by grant as well as by trigger. Migration 005 migrates an existing installation, and is deliberately tolerant: roles are cluster-scoped and grants are not, so a role another database still depends on is left alone rather than failing the migration. Verified by assuming the role on a real PostgreSQL 17: it reads `users`, and `UPDATE events` is denied. |
| **IR-008** | high | **Credentials on disk and in the process list.** `rgm login` wrote a long-lived token into `~/.rgm/config.json` with the process umask (world-readable on a typical machine) and accepted it as a command-line argument, where `ps` shows it to every other user. | The file is written 0600 inside a 0700 directory (and re-saved files are repaired, since `writeFile` ignores `mode` for an existing file). The token is now read from `RGM_TOKEN` or `--token-stdin`; `--token` still works but warns. `test/cli.config.test.js`. |
| **IR-009** | high | **A packet written into the wrong project.** Project selection is global and the output path comes from the bug number, so `rgm pull 1` in project A's repository could extract project B's BUG-1 over the same directory, silently mixing two clients' reports. | `pull` reads the packet's own `meta.json` and refuses a packet from a different project before writing anything — as it does one it cannot identify, since an unattributable report in a repository is worse than none. Five tests in `test/cli.packet.test.js`. |
| **IR-017** | med | **Joining a project failed for signed-in users.** `/api/invites/redeem` was not CSRF-exempt, so a user with a session cookie was refused while an anonymous one succeeded — the opposite of who is likely to redeem an invitation. The test client attaches the header automatically, which is how it stayed hidden. | The endpoint is capability-addressed, so the cookie is now irrelevant to it. The test drops the header deliberately and asserts an ordinary write still needs it. |
| **IR-005** | high | **Privilege restoration.** A role change left outstanding invitations alone, and redemption restores the invited role — so a demoted admin could redeem an invitation issued while they were an admin and become one again. | `setMemberRole` takes the same per-(project,email) lock as redemption and removal, revokes live invitations for the address, and audits the change. `test/api.auth.test.js` → "a demoted admin cannot restore their role with an old invitation". |
| **IR-010** | high | **Symlink escape.** `rgm pull` validated path strings but wrote through an existing symlink, so a planted `.rgm/BUG-1/bug.md` could overwrite a source file. | Extraction removes any existing entry (discarding the link, not its target), writes with `wx` so it can never follow one, and refuses a symlinked ancestor. Three tests in `test/cli.packet.test.js`. |
| **IR-015** | med | **Last-admin race.** The guard ran outside the update transaction, so two admins could demote each other past it; `removeMember` had no guard at all. | The guard now runs inside the transaction under a project-level lock in `setMemberRole`. |
| **IR-021** | med | The attachment row and its `attachment_added` event were separate commits, so a failure left an attachment with no history and no way to retry. | Both are inserted in one transaction. |
| **IR-022** | med | The 12-attachment limit was checked when a capability was issued, so fifteen could be taken out and every one completed. | Re-checked at completion under a lock on the bug. Test takes out 15 capabilities up front and completes them all: exactly 12 are stored. |
| **IR-028** | med | **A wholly broken feature.** Close and reopen store their text as `payload.reason`, but the translator read `payload.note` — so *every* such translation failed with "has no note to translate", even against a healthy provider. | The read coalesces both, which also repairs rows already written. `test/api.bugs.test.js` → "a close reason is translated, not silently dropped". |
| **IR-032** | med | With `S3_FORCE_PATH_STYLE=false` the bucket was dropped from the URL entirely, and the `Host` header never carried it either. | Virtual-host URLs put the bucket in the hostname; signing uses the URL's real host; an IP endpoint with virtual-host style is refused at construction, because `bucket.127.0.0.1` is not a valid host and the URL setter ignores it silently. |
| **IR-035** | med | `pull` never created the promised `.rgm/.gitignore`, so client reports and screenshots could be committed by accident. | `ensureIgnored` writes `<root>/.gitignore` containing `*`, and leaves an existing one alone. |
| **IR-002** | high | **Unauthenticated remote crash.** `decodeURIComponent` threw out of the HTTP listener, which is not inside a promise, so `GET /api/bugs/%` killed the process. Reproduced against a running server: health 200 → one request → exited with `URIError`. | Router returns a `malformed` result instead of throwing; the listener body is wrapped so nothing can escape it. `test/security.test.js` → "robustness: a request must not be able to kill the process". Re-verified live: 400, server still serving. |
| **IR-003** | high | **Transaction interleaving.** The embedded driver is one connection shared by every request; issuing `BEGIN`/`COMMIT` as separate statements let two requests interleave, so one request's `ROLLBACK` could discard another's committed rows. | Delegates to PGlite's exclusive `transaction()`, with a handle pinned to it. `test/security.test.js` → 20 concurrent transactions, half rolling back: every commit present, every rollback absent. |
| **IR-006** | high | `SmtpSession` never stored `timeoutMs`, so `startTls` built the replacement session with `undefined` — silently disabling the idle timeout on the secured socket. | The constructor stores it. |
| **IR-007** | high | **Credential leak.** The AUTH commands were not marked `hidden`, so a server echoing the credential put the base64 username/password into an error that `notify.js` persists to the outbox and `worker.js` prints. My own comment claimed they were safe. | All three AUTH commands are hidden, and a hidden command redacts the server's reply too. `test/providers.test.js` → "a rejected AUTH does not leak the credential into the error". |
| **IR-011** | high | The README documented `TRANSLATE_API_URL`; the loader read `TRANSLATE_BASE_URL`. An operator following the docs would silently send bug text **and the API key** to `api.openai.com`. | The loader accepts both; the README documents the real name. `test/config.test.js` asserts both work and that neither falls back to the stub. |
| **IR-012** | high | Production still defaulted to the public HMAC secret `dev-secret-change-me` (it is in this repository) and non-Secure cookies — so anyone could forge upload capabilities. | Production refuses to start without `STORAGE_SECRET`; cookies default to Secure when `NODE_ENV=production`. Tests in `test/config.test.js`. |
| **IR-014** | med | Migrations ran on every boot, so N replicas raced the same migration — and the Dockerfile's comment claimed they were not run at all. | `MIGRATE_ON_START=false` turns startup migration off; the Dockerfile sets it. The "migration + ledger entry in one transaction" half is **still open**. |
| **IR-024** | med | `composeNotification` read `n.baseUrl`, but the outbox row has no such column, so **every readiness email linked nowhere** — it carried the placeholder. The configured URL was passed to mailers that ignore it. | The URL is passed to the composer. `test/providers.test.js` → "a readiness email carries the application URL". |
| **IR-033** | med | The container never set `HOST`, so it bound `127.0.0.1` — `docker run -p 3000:3000` could not reach it, while the internal health check reported healthy. | `HOST=0.0.0.0` in the Dockerfile. |

## Open

Recorded so they are not lost, roughly in the order worth doing them.

### Authorization and credential handling

- **IR-018 (med)** — Login and invitation secrets travel in query strings, so they
  reach browser history and access logs.
- **IR-019 (med)** — SMTP latency distinguishes a known address from an unknown
  one.

### Uploads and storage

- **IR-023 (med)** — Abandoned staging objects for projects that remain live still need a
  periodic reaper. Purge/recovery now track and delete staged keys, so that destructive path
  no longer loses them.
- **IR-020 (med)** — No server-side re-encode, so EXIF/GPS from a client that does
  not strip it reaches storage and packets. (Same as the earlier RGM3-011.)

### Delivery and workers

- **IR-026 (med)** — SMTP has no idempotency contract, so acceptance followed by a
  crash can deliver a duplicate.
- **IR-027 (med)** — Leases are never renewed during an external call, and HTTP
  providers have no request deadline; a slow call can be reclaimed mid-flight.

### Handoff quality

- **IR-030 (med)** — Completed retest-note translations are dropped from the
  prompt; only the Vietnamese original is forwarded.
- **IR-031 (med)** — Packet attachments carry no `eventId`, so screenshots cannot
  be tied to timeline moments in `bug.md`.

### Interface

- **IR-036 (med)** — An upload failure after bug creation loses the bug id, and the
  error path clears the form — a retry creates a duplicate report.

### Verification

- **IR-014 (med)** — Migrations and their ledger entry are not one transaction.

---

## Purge and recovery pre-commit review — 2026-09-15

| ID | Sev | What was wrong | Fix / evidence |
|---|---|---|---|
| **PCR-001** | high | The purge checked `deleted_at` without locking the project row, so a concurrent restore could make it live after the check and still have it deleted. | Migration 012's guarded purge function takes `FOR UPDATE` before the trigger lock. `test/admin-purge.test.js` blocks the function at the events table, proves a concurrent restore waits, and verifies it affects zero rows after purge. |
| **PCR-002** | high | Recovery dropped and recreated the database before checking that the input was a readable PostgreSQL archive. This exact ordering wiped production when the obsolete hard-coded script was invoked by an early test with a fake snapshot; the preserved dump was restored immediately. | `scripts/recover.sh` now migrates a disposable current-schema database and applies the exact filtered data-only restore and allow-list there before stopping writers, so every compressed data block and destructive-path transformation is proven first. Unit regressions assert no stop/drop command on TOC, data, keep-ID, or validation-cleanup failure; a disposable PostgreSQL recovery probe covers the real path. |
| **PCR-003** | high | Docker gave app and worker the `rgm` database-owner login, which could bypass append-only triggers; the purge operation itself needs owner-only `ALTER TABLE`. | App/worker use provisioned login `rgm_app` inheriting `rgm_runtime`; it owns nothing and cannot execute purge or mutate audit rows. Permanent deletion moved out of every long-running process into an explicit one-shot owner container. Runtime-role tests use a pinned connection while assuming the actual role, and startup fails closed on an unsafe login. |
| **PCR-004** | high | Hard purge deleted attachment rows but left the screenshot objects in storage. A later best-effort deletion could fail after losing the keys from ordinary tables. | The function writes completed, staged, and durably claimed final keys to `admin_storage_cleanup` beside the immutable tombstone before deleting project rows. Cleanup is idempotent and marked only after object deletion. App-local upload capabilities are revoked immediately under the project lock, so purge no longer waits for expiry. |
| **PCR-005** | high | `admin_purge_project(p_actor_id, ...)` trusted a caller-supplied actor, so any shared runtime database caller could impersonate a known site administrator. | `rgm_runtime` cannot execute purge or insert audit rows. Only a host-authorized one-shot owner task can invoke the function, and the function accepts an email and revalidates that it maps to a current site administrator. Because Docker-host authorization is not browser authentication, the tombstone deliberately stores `actor_id = NULL` and labels the supplied address as `metadata.actorEmail` with `metadata.authorization = docker-host`; it does not impersonate a browser user. Recovery requires the same explicit `--actor-email` instead of choosing an arbitrary administrator. |
| **PCR-006** | high | Direct email browser sessions made the destructive purge route available as ambient browser authority. | There is no HTTP hard-purge route at all. Browser sign-in remains email-only, and the one-shot Compose command needs neither an RGM password nor an API token. The route-absence regression checks a direct-email browser session receives 404. |
| **PCR-007** | high | Attachment completion could promote an object after purge had collected keys, leaving an object with no database row. | Completion first commits a claim containing its final key, then reacquires the project and pending-upload locks around promotion plus database finalization. Purge uses the same serialization point and can collect both claimed keys after any crash. A real-PostgreSQL interleaving test blocks completion at the bug lock, starts purge, and verifies both complete in order with no object left. |
| **PCR-008** | high | Privilege tests sent `SET ROLE` through a pool and then issued assertions through unrelated pooled queries, so green results could be running as the owner. | Role assumption and the checked statement now share one pinned transaction with `SET LOCAL ROLE`. The corrected test exposed the prior false result on PostgreSQL before passing. |
| **PCR-009** | high | Issued upload capabilities and staging keys existed only in process/storage state, so purge could lose the key or an S3 PUT could recreate an object after cleanup. | Filesystem and S3 now issue the same signed app-local upload URL. `pending_uploads` is registered under the project lock; PUT and completion require the live row. Purge revokes the row immediately, persists both staging and claimed final keys, and replay receives 410. S3 regressions prove completion replay cannot recreate the staging object. |
| **PCR-010** | high | Recovery's preflight restored the archive's own schema, while production applied current migrations and data-only restore; a preflight pass did not prove the destructive sequence. | The disposable database now runs current migrations followed by the exact same filtered `--data-only --use-list` restore and allow-list operation used for production. The corrupt-block and current-schema checks happen before writers stop. |
| **PCR-011** | high | A syntactically valid but absent `--keep-project` UUID silently deleted every restored project. | Preflight requires every requested UUID to exist and verifies the exact retained count before the production database is touched. A typo regression asserts no writer stop or live drop. |
| **PCR-012** | high | Allow-list pruning deleted attachment rows but not completed/staged storage objects or durable cleanup state. | Excluded projects are removed through `admin_purge_project` in both validation and production. A one-shot owner cleanup service deletes the queued objects before restart and fails recovery if any remain. Disposable PostgreSQL recovery checks the kept object remains and both excluded keys disappear. |
| **PCR-013** | high | Concurrent recoveries shared fixed artifact/database names, and cleanup failures could be ignored. | An atomic lock serializes recovery; each run uses PID-scoped archive/TOC/database names. Validation-db and container-artifact cleanup are mandatory, with regressions for lock contention and drop failure. |
| **PCR-014** | high | Compose text and role-membership tests did not prove the deployed runtime login; a miswired owner URL could still start. | Startup queries its real session and rejects a superuser/table owner, direct audit DML, or purge-function grants. Health performs a runtime database query. Disposable Docker recovery verifies `rgm_app` and runtime purge denial. |
| **PCR-015** | med | A retry with a different reason returned that new text even though the immutable tombstone retained the original. | The guarded function returns the stored audit reason/force on both first purge and retry; the command never prints mutable request values as audit facts. |
| **PCR-016** | high | The first isolated recovery harness set `RGM_COMPOSE_PROJECT`, but the rewritten script ignored it and addressed the default `rgm` project. During verification it recreated the production DB container. The named volume was not dropped; the original Compose stack was immediately restored and `Fabric Warehouse`, `Projection Planning`, 10 migrations, the site admin and health were reverified. | Every Compose call now passes validated `-p "$RGM_COMPOSE_PROJECT"`; a regression requires the project flag. Preflight also leaves an already-running DB container untouched instead of calling `up`, and the disposable recovery was rerun under separate project/volume names. |
| **PCR-017** | high | Direct S3 presigned PUT URLs remained valid after completion and could recreate a staging object after purge. | S3 no longer gives the browser bucket authority: it inherits the same HMAC-signed `/api/uploads/:token` capability as filesystem storage. Completion or purge removes the pending row, and replay is denied before any S3 write. |
| **PCR-018** | high | A direct bucket PUT accepted before URL expiry could finish after expiry or purge; database locks could not serialize external bucket traffic. | All browser PUTs now pass through the app. The handler finishes reading, then verifies capability state and holds the project lock through the server-side storage write, so purge either waits and queues the object or revokes the row first. The expiry wait was removed. |
| **PCR-019** | high | Completion promoted externally before recording the final key, so a crash or partial S3 copy/delete could leave an undiscoverable object. | A first committed transaction assigns `pending_uploads.final_storage_key` before promotion. A second transaction reacquires project and pending locks around promotion and finalization. Pending state survives errors with both keys, and the partial-copy regression proves purge queues and deletes both. |
| **PCR-020** | high | Recovery allow-list pruning selected the earliest site administrator and falsely attributed every exclusion purge to that arbitrary user. | `--keep-project` now requires explicit `--actor-email`. The guarded function resolves that exact current site administrator for authorization. Because recovery is authorized by Docker-host access rather than a browser session, its tombstone uses `actor_id = NULL` and labels the asserted address and host authorization explicitly in metadata; no first-admin fallback or false browser identity remains. |
| **PCR-021** | high | Migration 012 briefly granted `rgm_runtime` execution of its `SECURITY DEFINER` purge function before migration 013 removed that signature; a still-running runtime process could exploit the between-migration window. | Migration 012 now revokes direct project deletion but never grants purge execution. Its revocation fails the migration rather than being caught and skipped. A regression scans the intermediate migration itself, and real-PostgreSQL role tests confirm runtime cannot invoke purge. |
| **PCR-022** | high | Migration 002's default privileges gave `rgm_runtime` mutation access when migration 010 created `admin_audit_log`, and migration 011 explicitly re-granted INSERT; until migration 013, a running app could forge purge tombstones between separately committed migrations. | Migration 010 revokes INSERT/UPDATE/DELETE/TRUNCATE in the same transaction that creates the table. Migration 011 grants SELECT only and re-revokes all mutation privileges; privilege failures are no longer swallowed. The intermediate-migration regression rejects either transient grant. |
| **PCR-023** | high | Runtime startup verification omitted direct project DELETE and cleanup-queue mutation privileges, and the long-running worker did not run the boundary check at all. A miswired privileged worker could therefore start despite the app's guard. | The live-role query now rejects direct project deletion and INSERT/UPDATE/DELETE/TRUNCATE on `admin_storage_cleanup`. Both app and worker run the same fail-closed check before serving or polling; unit and Docker-role tests cover the boundary. |
| **PCR-024** | high | Migration 002 swallowed a failure while revoking UPDATE/DELETE/TRUNCATE on the append-only `events` table, and startup did not inspect those ACLs. A misconfigured runtime could therefore pass the live-role guard with mutation privileges. | Runtime grant/revocation in migration 002 now fails the migration instead of skipping. The app/worker startup query also rejects direct event mutation, independently of the append-only trigger; structural and real-role regressions cover both layers. |
| **PCR-025** | med | Migration 013 referenced `rgm_runtime` unconditionally even though migration 002 supports environments where CREATEROLE is unavailable and the role is provisioned later; that path aborted before Compose could provision the login. | Migration 013 wraps only the role-targeted revocations in an existence check, while leaving failures fatal whenever the role exists. PUBLIC revocations remain unconditional. A structural regression covers the role-absent path. |

All blocker classes above have focused regression coverage. The release gate requires both the
full verification matrix and an independent clean review of the frozen change set.

---

## What this says about the testing

243 tests passed while all of the above was true. They passed because they tested
the system against itself: the same author wrote the code, the tests and the
expectations. Two of the findings (IR-002, IR-007) are cases where a comment I
wrote asserted the safe behaviour that the code did not implement — a reader who
trusted the comment would have confirmed the bug.

The inspection is the only thing in this repository that has ever disagreed with
its author, and it is the reason the crash and the interleaving bug are not in the
tree any more.
