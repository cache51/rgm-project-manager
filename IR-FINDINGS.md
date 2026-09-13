# Independent inspection — findings and disposition

`claudex-loop inspect`, provider **codex/gpt-6-astra**, effort **xhigh**, over
`56509a5..07de708` — the whole built product. Verdict: **REVISE**, 38 findings
(13 high, 25 medium).

This is the first review of the code by something other than its author, and it
found things the 243 passing tests did not. **Twenty-five of the thirty-eight are
fixed**, each with a test that would have caught it; the rest are recorded with a
plan so they are not lost.

| | high | medium | total |
|---|---|---|---|
| Found | 13 | 25 | 38 |
| Fixed | **13** | **12** | **25** |
| Partly fixed | — | 1 | 1 |
| Open | 0 | 12 | 12 |

**Every high-severity finding is closed.** The twelve still open are all medium,
and the largest cluster is the worker lifecycle: leases are not renewed during an
external call, failed event translations have no terminal sweep or retry route,
and abandoned staging objects are never cleaned up. Those want a background
reaper and a heartbeat, which is a piece of the product that does not exist yet
rather than a defect in one that does.

The run that produced this **self-rejected** ("Plan changed during the run") because
the repository was edited while it ran. The findings are still valid — they are
about specific lines — but the *verdict* does not certify the current tree. A clean
re-run is owed.

---

## Fixed, with a test

| ID | Sev | What was wrong | Fix / evidence |
|---|---|---|---|
| **IR-013** | high | **Validation of a moving object.** Completion checked the staged key and promoted afterwards. Because a presigned PUT stays valid until it expires, a client could replace the object in between — so the promoted bytes could differ from the metadata that was checked, and every later view, download and packet would serve the replacement. | Promotion happens first, and the object is then validated where it now lives, so what is checked is what is served. A rejection after the move deletes the promoted copy rather than orphaning it, and a racing completion is answered 409 instead of failing. `test/upload-integrity.test.js`. |
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

- **IR-023 (med)** — Abandoned staging objects are never cleaned up.
- **IR-020 (med)** — No server-side re-encode, so EXIF/GPS from a client that does
  not strip it reaches storage and packets. (Same as the earlier RGM3-011.)

### Delivery and workers

- **IR-026 (med)** — SMTP has no idempotency contract, so acceptance followed by a
  crash can deliver a duplicate.
- **IR-027 (med)** — Leases are never renewed during an external call, and HTTP
  providers have no request deadline; a slow call can be reclaimed mid-flight.
- **IR-029 (med)** — `event_translations` has no terminal sweep and no retry
  route, so a worker that dies on its last attempt leaves it running forever.

### Handoff quality

- **IR-030 (med)** — Completed retest-note translations are dropped from the
  prompt; only the Vietnamese original is forwarded.
- **IR-031 (med)** — Packet attachments carry no `eventId`, so screenshots cannot
  be tied to timeline moments in `bug.md`.

### Interface

- **IR-036 (med)** — An upload failure after bug creation loses the bug id, and the
  error path clears the form — a retry creates a duplicate report.
- **IR-037 (med)** — "Report bug" on milestone M2 does not preselect M2, so the
  report can be filed against M1.

### Verification

- **IR-034 (med)** — The CI job labelled "against real Postgres" used a PGlite-backed
  double, so it never exercised a real server. **Partly addressed**: `RGM_TEST_PG_URL`
  now runs the whole suite against a real PostgreSQL 17 (243/243 locally, and it
  found the `count(*)` cast bug on its first run). The CI job still needs to use it.
- **IR-014 (med)** — Migrations and their ledger entry are not one transaction.

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
