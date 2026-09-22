# RGM Project Manager

Tool to manage **developer ↔ tester** communication across multiple projects.

- Testers write in **Vietnamese**; developers read **中文 / English**.
- A developer marks a milestone complete → tester tests it → tester files a bug with
  **screenshots + a description in Vietnamese**.
- The developer sees the original **plus an auto-translation**, and one click copies a
  pre-formatted block straight into an AI agent (Claude / Codex) — replacing the current
  manual copy-paste step.

## The web UI

`public/` — served by the API server itself, so there is no build step, no second
origin, and no bundler to keep in sync. Plain ES modules calling the real API.

```bash
npm start          # then open http://127.0.0.1:3000
```

Sign-in is an email address and nothing else — no password, no emailed link. `/login`
takes the address an admin added you with, matches it against the people on the
project, and opens a session; the role comes from that membership.

```bash
npm run bootstrap -- you@example.com   # creates the site admin, then:
bash scripts/dev-login.sh              # prints the sign-in URL to open
```

To put someone on a project, an admin uses **Team → Add someone to the project**
(name, email, role). It applies immediately: there is no invitation to deliver and no
mailer to deliver it with. Ask an admin if your address is not recognised.

> **What this does not prove.** Anyone who can reach the URL can sign in as any address
> an admin has added, including an admin's. The audit trail therefore records the
> address someone *claimed*, not one they proved. That is a deliberate trade for an
> internal tool on a private network; it would not be acceptable on the public
> internet. The magic-link and API-token endpoints still exist in the API
> (`POST /api/auth/request-link`, `POST /api/auth/consume`) if that changes.

| Screen | What it does |
|---|---|
| Milestones | Cards per milestone; a tester only sees **Report bug** on a `ready` milestone. Developers get **Add milestone** when the project has none |
| Bugs | Rows with severity, status, reporter, milestone, attachment count and timestamps |
| Bug detail | Vietnamese original beside the translation, the activity timeline with translated notes, real screenshot downloads, the server-built prompt for the AI agent, and role-appropriate actions |
| Team | Who is on the project, and (admins) a form to add someone by name, email and role |
| Report | Vietnamese title/body + screenshots, uploaded through the real two-phase flow |

## A report is a bug or a feature request

Both are filed the same way, from a `ready` milestone: **🐞 Report bug** or
**✨ Request feature**. The form opens on whichever you pressed and lets you change it.

| | Bug | Feature request |
|---|---|---|
| Code | `BUG-4` | `REQ-4` |
| Picked up | Start fixing | Start working |
| Handed back | Mark as fixed | Mark as implemented |
| State while waiting | Fixed — awaiting verification | Implemented — awaiting verification |
| Checked by the tester | Fix verified | Feature verified |
| Sent back | Still broken — send back | Not done — send back |

One sequence per project, and the prefix says which kind it is — so a project can hold
`BUG-1` and `REQ-4`. The code follows the report everywhere: the list, the detail, looking
one up by its number, the packet filename a developer pulls (both the RFC 5987 form and
the ASCII fallback), `meta.json` inside the packet, and the prompt an AI agent is handed.

**The agent is told which it is.** A bug report's prompt says *"you can help fix it"*; a
feature request's says *"you can implement it"*, and the metadata block carries
`kind: feature request`. Asking an agent to fix a request for something that does not
exist yet is how you get a workaround instead of the feature.

The workflow itself is identical — one state machine, not two — because the steps are
the same: someone reports it, someone does the work, someone checks it.

## Handing a bug to a coding agent

An agent can work a project's bugs directly instead of a person copying a prompt into
it. It authenticates with an API token (`bug:read` + `bug:write`) and reaches the
product either through the `rgm` CLI or through MCP (`mcp/rgm-mcp.mjs`), which expose
the same loop:

| Tool | What it does |
|---|---|
| `rgm_list_bugs` | the unresolved bugs in the configured project, oldest first |
| `rgm_get_bug` | the handoff prompt: the tester's words, the translation, the status |
| `rgm_get_packet` / `rgm_get_attachment` | the screenshots, written to disk so they can be looked at |
| `rgm_ask_question` | ask the reporter (and the project's developers) to clarify |
| `rgm_get_questions` | whether the answer has arrived |
| `rgm_comment` | what was changed, in words a tester can act on |
| `rgm_remove_comment` | take back a comment of its own that nobody has answered yet |
| `rgm_mark_fixed` | hand it back: *fixed — awaiting verification*, with the test that proves it |

Two rules are built in rather than documented and hoped for: an agent can ask but
**cannot verify** (only the filer closes a report), and a question stays open until a
member answers it — by using the answer box or simply by commenting on the bug, which
counts as the answer because that is how the testers and developers already reply.

The asking agent is only as useful as the report it was given, so the prompt keeps the
tester's text fenced as data (see `src/prompt.js`) and the question is emailed to the
reporter *and* the project's developers, so a question nobody is on shift to answer
still reaches someone who can act on it.

### Installing it

This repository is its own plugin marketplace, so an agent gets the MCP server, the
skill and the CLI in one install:

**Claude Code**

```
/plugin marketplace add cache51/rgm-project-manager
/plugin install rgm@rgm
```

**Codex**

```
codex plugin marketplace add cache51/rgm-project-manager
codex plugin add rgm@rgm
```

Codex plugins carry skills, so its MCP server is registered separately (either form):

```
codex mcp add rgm -- node /path/to/rgm-project-manager/mcp/rgm-mcp.mjs
```

```toml
# ~/.codex/config.toml
[mcp_servers.rgm]
command = "node"
args = ["/path/to/rgm-project-manager/mcp/rgm-mcp.mjs"]
```

**Any other MCP client** — the server is stdio and has no dependencies, so point it at
`mcp/rgm-mcp.mjs` directly:

```json
{ "mcpServers": { "rgm": { "command": "node", "args": ["/path/to/rgm-project-manager/mcp/rgm-mcp.mjs"] } } }
```

Then, once, the credentials the server and the CLI share. There is no password: the
address *is* the identity, and the token is minted in the app (`POST /api/tokens`,
scopes `bug:read` + `bug:write`).

```
rgm login --url http://192.168.168.92:3000 --token <api-token>
rgm use "Fabric Warehouse"    # the project this agent works
```

Nothing else to configure — both entry points read the same `~/.rgm/config.json`. An
agent that has not signed in yet gets told exactly that when it calls a tool, rather
than an empty result.

### Asking for work

**A repository is a project.** An agent works the project of the checkout its *session*
is open in. Claude Code's plugin server learns that checkout over MCP roots (the client
tells the server its open directories — the server process itself may start anywhere);
`rgm use "<project>"` inside a directory binds it (`.rgm/project.json`), and the nearest
binding wins, so feature directories can each bind their own project. Resolution order:
a project named at the call, then the session repository, then this process's directory,
then `RGM_PROJECT_ID`, then the machine-wide `~/.rgm/config.json` — and every answer
says where it came from, so a wrong project is visible, never inferred.
`rgm project` prints which one applies to the shell it runs in. Then ask in whatever
words you normally use:

```
/rgm:bug-intake                        # the project's unresolved bugs, oldest first,
                                       # one at a time, to completion
/rgm:bug-intake BUG-7                  # just that one
/rgm:bug-intake the packing-list bug   # found by its description
```

Or skip the slash command: *"work the RGM bugs the testers filed"* invokes the skill by
itself, because that is what its description says it is for. To switch project, say so —
the agent runs `rgm use "<project>"` first.

### One repository, several projects

A project is often a *feature*, and one repository can hold several — so the binding is
per directory, not per repository, and a "project name" is only a label on the app's
side. Two shapes, both covered:

- **The features live in their own directories.** `rgm use "<project>"` inside that
  directory binds the subtree. The nearest binding wins, so `apps/packing/` can work
  one project while `apps/projection/` works another inside the same checkout, and two
  agents can work both at once.
- **Two projects share one directory.** Name the project at the call:
  `rgm bugs --project "PO Auto-import"`, or the same `project` argument on any MCP tool.
  An explicit name beats the binding, and the output says where the answer came from
  (`from the project argument`), so the wrong project is visible rather than inferred —
  a name that matches nothing is an error, never a silent fallback.

Pulling packets for two projects into one directory would put both under `.rgm/<CODE>`,
which is exactly the collision `pull` refuses, so give the second one its own root:
`rgm pull 12 --out .rgm/po-auto-import`.

From a shell, the same loop without an agent in the middle:

```
rgm bugs                  # the unresolved list
rgm prompt 7              # the handoff prompt for BUG-7, on stdout
rgm ask 7 "which warehouse?"   # question to the reporter
rgm questions 7           # the answer, once it arrives
```

## The fix-and-verify loop

```
tester reports          dev claims it        dev marks it fixed      tester checks it
   bug is OPEN   ──►   still OPEN    ──►   FIXED, awaiting   ──►   ── pass ──►  CLOSED
   ● red               ● red               verification             ● green
                                            ● light green       └─ fail ──►  OPEN (red again)
```

| State | Reads as | Colour | Who moves it on |
|---|---|---|---|
| `new` | Open | ● red | the tester reports it; a developer can also close it with a reason |
| `fixing` | Being fixed | ● red | developer: **Start fixing**; a failed verification lands here too, so a reopened bug is red again |
| `retest` | Fixed — awaiting verification | ● light green | developer: **Mark as fixed** |
| `closed` | Closed | ● green | tester: **Fix verified**, or the developer reopens it with a reason |

Red means the problem is still there — whether nobody has looked at it, someone is
fixing it, or a tester just sent it back. That is deliberate: to a tester scanning the
list those all mean the same thing, and the state name says which it is. The buttons
carry the words the work is described in ("Mark as fixed"), not the state machine's
names for them (`request_retest`).

Every move is a state machine on the server, so the API refuses an illegal one — a
tester cannot verify a fix that was never claimed, and cannot claim one at all. The
browser is never the thing enforcing that; it is told which moves are legal
(`availableActions`) and offers exactly those.


## Managing the data: add, change, remove

| What | In the UI | Who |
|---|---|---|
| Create a project | Sidebar → **＋ Create project** (also on the first-run screen) | site admin |
| Rename / re-environment a project | Sidebar → **✎ Rename project** | project admin |
| Remove a project | Sidebar → **🗑 Remove** | project admin |
| Restore a removed project | Sidebar → **Removed** → **Restore** | project admin |
| Create a milestone | Milestones → **＋ Add milestone** above the list | admin, developer |
| Rename a milestone | Milestone card → **✎ Edit** | admin, developer |
| Move a milestone along | Milestone card → its lifecycle buttons (`start → in_progress`, `ready`, `finish`, `reset`) | admin, developer |
| Remove / restore a milestone | Card → **🗑 Remove** / **Removed** section → **Restore** | admin, developer |
| Report a bug | Milestones → **🐞 Report bug** (on a `ready` milestone) | any member |
| Correct a report | Bug detail → **✎ Edit this report** | the reporter, or an admin, while it is open |
| Move a bug along / retest | Bug detail → the action buttons | by role and state |
| Comment | Bug detail → **Add comment** | any member |
| Remove / restore a bug | Bug detail → **🗑 Remove** / Bugs → **Removed** → **Restore** | project admin |
| Add a person | Team → **Add someone to the project** | project admin |
| Change someone's role | Team → a **Role: …** chip on their row | project admin |
| Remove a person | Team → **🗑 Remove** | project admin |

Two rules the UI follows rather than duplicating:

- **Which moves are legal comes from the server.** Each milestone carries an
  `availableActions` list computed by the same state machine the route enforces, so the
  buttons offered are the ones that will be accepted. A client-side copy of the state
  machine would drift and start offering moves the API refuses.
- **A control that would be refused is not rendered.** A tester is never shown "Remove
  project".

**Removal is always a soft delete.** The row and its history stay in the database — a
bug is evidence, and a project holds that history — so the thing stops being listed and
stops accepting writes, and restoring is an `UPDATE`. Nothing in the app destroys a row.
A write to something removed answers **410 Gone** rather than 403: it was removed, which
is not a permissions problem, and "forbidden" would send someone hunting for a
permissions issue that is not there.

**Correcting a report re-queues its translation.** The translations are derived from the
Vietnamese, so editing it makes them wrong; the field whose text actually changed goes
back to `pending` and the worker redoes it. Without that, the developers would keep
reading a translation of the sentence the tester had already corrected.

The same operations over HTTP, and the token scope each needs:

| Method and path | Does | Scope |
|---|---|---|
| `POST /api/projects` | create | `admin` |
| `PATCH /api/projects/:id` | rename, change env or timezone | `admin` |
| `DELETE /api/projects/:id` | remove (soft) | `admin` |
| `POST /api/projects/:id/restore` | bring back | `admin` |
| `GET /api/projects/removed` | what you can bring back | `bug:read` |
| `POST /api/projects/:id/milestones` | create | `bug:write` |
| `PATCH /api/milestones/:id` | rename, set or clear a due date | `bug:write` |
| `POST /api/milestones/:id/status` | `start` / `ready` / `finish` / `reset` | `bug:write` |
| `DELETE /api/milestones/:id` · `POST …/restore` | remove, bring back | `bug:write` |
| `POST /api/projects/:id/bugs` | report | `bug:write` |
| `PATCH /api/bugs/:id` | correct title, body or severity | `bug:write` |
| `POST /api/bugs/:id/status` | the lifecycle transitions | `bug:write` |
| `DELETE /api/bugs/:id` · `POST …/restore` | remove, bring back | `admin` |
| `POST /api/projects/:id/members` | add someone (email → role, immediately) | `admin` |
| `PATCH /api/projects/:id/members/:userId` | change a role | `admin` |
| `DELETE /api/projects/:id/members/:userId` | remove from the project | `admin` |

Two things the UI deliberately does **not** do:

1. **It does not build the handoff prompt.** It calls `GET /api/bugs/:id/prompt`.
   The mock had its own `aiPrompt` implementation; that duplication was the largest
   drift risk in the repo, and this removes it. `test/ui.test.js` asserts the fence
   token never appears in client code.
2. **It does not lay out the packet.** It downloads `GET /api/bugs/:id/packet` and
   saves the archive the server produced.

## Configuration

Everything is environment-driven, through one loader (`src/config.js`) that the
server and the worker share — so they cannot disagree about which database,
bucket, mailer or translation provider they are using.

| Variable | Effect |
|---|---|
| `DATABASE_URL` | Use a real Postgres server (`pg`). Unset → the embedded PGlite. |
| `PGLITE_DIR` | Where the embedded database keeps its files. Unset → in-memory. |
| `STORAGE_DIR` / `STORAGE_SECRET` | Local object storage, and the HMAC key for app-local upload capabilities. `STORAGE_SECRET` is also required with S3 in production. |
| `S3_ENDPOINT` `S3_BUCKET` `S3_ACCESS_KEY_ID` `S3_SECRET_ACCESS_KEY` | Store attachment bytes in a bucket instead. Browser uploads still use the app-local capability URL; the app writes to S3 under the project lock. `S3_REGION`, `S3_FORCE_PATH_STYLE` (default true — MinIO needs it). |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `MAIL_FROM` | Send real mail over SMTP. `SMTP_SECURE=true` for implicit TLS. `SMTP_REQUIRE_TLS` demands STARTTLS and **defaults to true whenever `SMTP_USER` is set**; set it to `false` explicitly to allow plaintext (dev only). The older spelling `REQUIRE_TLS` is still read. |
| `EMAIL_API_ENDPOINT` `EMAIL_API_KEY` | Send mail through an HTTP provider instead — takes precedence over SMTP. |
| `TRANSLATE_PROVIDER` | `stub` (default), `openai`, or `deepl`. |
| `TRANSLATE_BASE_URL` `TRANSLATE_API_KEY` `TRANSLATE_MODEL` | For `openai`-compatible endpoints. `TRANSLATE_API_URL` is accepted as an alias. `DEEPL_API_KEY` for `deepl`. |
| `PORT` `HOST` `PUBLIC_URL` `SECURE_COOKIES` | Server binding, and the base URL that sign-in and invite links are built from. |

With nothing set the app runs entirely locally: embedded database, a `./.rgm`
storage directory, mail printed to the console, and the stub translator.
`npm start` prints the resolved configuration at boot.

### Mock vs. build

`mockups/tester-dev-portal.html` is the reviewed **design reference** — sample data,
no backend, its own duplicate implementations. `public/` is the real thing. Keep the
mock for design discussion, but treat `public/` as the source of truth; if they
disagree, the mock is out of date.

## Mock UI (design reference)

`mockups/tester-dev-portal.html` — single self-contained file, no build, no network.
Open it in a browser.

### Screens

| Role | Screen | What it shows |
|---|---|---|
| 🧪 Tester (Tiếng Việt) | Milestones | Only milestones in the `ready` state expose a **Báo lỗi** button |
| 🧪 Tester | Bug form | Vietnamese description + screenshot upload (mock) |
| 💻 Developer (中文 / EN) | Bug inbox | Severity, tester, PO/milestone tags, screenshot thumbnails |
| 💻 Developer | Bug detail | Vietnamese original + translation side by side, status chips, **Copy for AI** |

### Deep links

Useful for demos, reviews and screenshots:

```
?role=dev&lang=zh&project=packing&view=bugs&bug=BUG-142
?role=dev&lang=en&project=leave&view=bugs&bug=BUG-118
?role=dev&project=lwms&view=bugs          # empty-state check
```

Params: `role=tester|dev`, `lang=vi|zh|en`, `project=<id>`, `view=milestones|bugs`, `bug=<BUG-ID>`.

Note: the Hermes preview pane strips the query string, so deep links only work in a real
browser.

### Projects in the mock

| id | Project | Client | Open bugs (not closed) |
|---|---|---|---|
| `packing` | Packing List Automation | Lucky Brand | 3 |
| `leave` | HR Leave Request System | RGM — Internal | 1 |
| `ie` | IE Balance & Line Arrangement | Internal — IE | 1 |
| `lwms` | Laundry Warehouse Management | Internal — Warehouse | 0 |

Each project owns its own milestones and bugs; the sidebar count, nav badge and header
all scope to the selected project.

## Timestamps

Everything carries a time. Absolute timestamps are shown with a relative hint
("1 小時前") derived from a pinned mock clock (`NOW = 2026-09-12 11:05 +07:00`),
so the sample data stays internally consistent whenever you open it.

| Where | What is stamped |
|---|---|
| Sidebar | last sync |
| Header | selected project's last activity |
| Milestone card | completed at, last updated |
| Bug row | reported at, last updated |
| Bug detail → 基本資訊 | reported, last updated |
| Bug detail → 活動時間軸 | every event: filed, auto-translated, status change, comment |

The activity timeline is the important one: each entry records **who** did
**what** **when**, plus any note. That is the audit trail, and in the real build
it must come from an append-only events table — never from mutable columns.

## Status

The **mock** (`mockups/tester-dev-portal.html`) is sample data only — nothing persists, no backend. It shows the intended UX shape (vi/zh/en, multi-project, timestamps, download UI).

The **build** is a working, tested server + worker + CLI.

```bash
npm install
npm test          # 459 tests against a real Postgres (WASM) over real HTTP
npm run migrate
npm start         # http://127.0.0.1:3000
npm run worker    # drains the translation queue and the notification outbox — for a
                  # real Postgres. With the embedded database this cannot start (PGlite
                  # takes a single process), so the server runs the same loop in-process
npx rgm login --url http://127.0.0.1:3000 --token <api-token>
npx rgm pull 1              # write .rgm/BUG-1/{bug.md,meta.json,screenshot_01.png}
npx rgm admin delete-project <id> --reason "..."   # hard-delete an old project; the
                                                   # reason is recorded in admin_audit_log
                                                   # and survives the row's deletion
```

### CLI: `rgm admin delete-project`

The HTTP API has a soft delete (`DELETE /api/projects/:id`) that keeps the data and
lets it be restored — the right answer for accidents. The CLI exposes a hard delete
for the case where the operator wants the row gone, with a written reason:

```
docker compose --profile admin run --rm admin admin delete-project <project-id> \
  --actor-email yuen.chan@gmail.com --reason "was a duplicate of HR Leave App"
# For a live project, bypass the soft-delete precondition explicitly:
docker compose --profile admin run --rm admin admin delete-project <project-id> \
  --actor-email yuen.chan@gmail.com --reason "disposable test project, confirmed" --force
```

The reason must be at least 12 characters in both the command and guarded database function,
and is recorded in `admin_audit_log` — a parallel audit table that has no FK to `projects`
and so survives the project's deletion. The table is append-only, and its metadata
records the attachment object keys removed from storage. The result:

```
purged HR Leave App
  reason: was a duplicate of HR Leave App
```

Permanent deletion is not an HTTP route and needs no RGM password or API token. It runs only
as an explicit one-shot Compose task on the deployment host, reusing the existing migration-
owner connection; `--actor-email` must map to a site administrator. Because host authorization
is not browser authentication, the tombstone keeps `actor_id` null and records the supplied
email explicitly as `metadata.actorEmail` with `metadata.authorization = docker-host` rather
than falsely claiming a browser-authenticated identity.
Ordinary browser access remains direct email-to-role sign-in with no password. Without `--force`,
the project must already have been removed through the normal soft-delete path. The command
never soft-deletes as a side effect. `--force` permits purging a live project and that choice is
stored in the audit metadata. If object storage is temporarily unavailable, the database purge
is committed, cleanup remains in `admin_storage_cleanup`, and rerunning the command retries only
the pending objects while returning the original immutable reason/force values. Issued upload
capabilities are tracked in the database and every storage backend proxies PUT through the app.
Purge takes the same project lock, revokes outstanding capabilities immediately, and durably
queues both staging and claimed final object keys before deleting project rows.

The Compose deployment has only its existing PostgreSQL owner credential plus the generated
non-owner `RGM_RUNTIME_PASSWORD`; neither is an RGM sign-in password. Browser users enter only
an email address. App and worker run as `rgm_app` and never receive the owner connection; only
one-shot migration/recovery/admin containers receive it. Startup fails closed if the runtime
login is an owner/superuser or has purge/audit mutation privileges, and `/api/health` proves that
runtime database connection can execute a query.

### Database recovery

`scripts/recover.sh` restores a PostgreSQL custom-format dump into the local Compose
deployment. Run it on the deployment host from the repository root:

```bash
scripts/recover.sh /path/to/rgm.dump --confirm-drop-database rgm

# Optional: retain only these project UUIDs from the snapshot
scripts/recover.sh /path/to/rgm.dump --confirm-drop-database rgm \
  --actor-email yuen.chan@gmail.com \
  --keep-project 11111111-1111-4111-8111-111111111111 \
  --keep-project 22222222-2222-4222-8222-222222222222
```

The exact database-name confirmation is mandatory and one recovery runs at a time. Recovery
filters the archive's table of contents, creates a disposable database, applies the current
migrations, and runs the **same filtered data-only restore and project allow-list** intended
for production. That proves every compressed data block, current-schema mapping, and requested
keep UUID before writers stop. Only then does it recreate/migrate production and repeat the
validated sequence with `pg_restore --exit-on-error`. Excluded projects go through the guarded
purge function so completed and staged objects enter durable cleanup; a one-shot owner service
deletes them before writers restart. Per-run archive/TOC copies and the validation database must
be removed successfully. Any restore or object-cleanup error is fatal and leaves app/worker
stopped. With no `--keep-project` options, every project in the snapshot is retained.
When an allow-list is supplied, `--actor-email` is mandatory, must resolve to a current site
administrator in the restored data, and that exact user is recorded on each exclusion purge.

### What is built

| Path | What it does |
|---|---|
| `db/migrations/001_init.sql` | The schema. Typed event subjects (**RGM3-001/002**), composite FKs (**RGM-016**), leases, per-field translations, bug numbering, append-only `events` trigger |
| `src/auth.js` | Login links, sessions, API tokens, invitations, membership revocation. `activeMembership` is the single definition of "is this actor a member" |
| `src/api.js` | Every HTTP route. Each one authorizes against the **target resource's** project |
| `src/server.js` | App assembly + `node:http` server |
| `src/transitions.js` | Explicit transition tables (**RGM2-010**); `closed→retest` / `new→retest` unrepresentable |
| `src/prompt.js` | Prompt-injection boundary (**RGM3-014**): fixed preamble, tokenised fences |
| `src/packet.js` | Zip-slip defence (**RGM3-007**): server-named entries, tester filenames are data |
| `src/claim.js` | Lease claims that actually reclaim a dead worker (**RGM3-006**) |
| `src/translate.js` | Translation queue + worker; per-language status; event notes translated (**RGM2-005**) |
| `src/notify.js` | Outbox worker; dedupe key doubles as the provider idempotency key (**RGM-020**) |
| `src/storage.js` | Screenshot storage behind an S3-shaped interface; HMAC-signed upload capabilities |
| `src/zip.js` / `src/unzip.js` | Dependency-free ZIP writer and reader (STORE + DEFLATE) |
| `src/cli.js` | `rgm` — the developer handoff CLI (§10) |
| `src/worker.js` | Background loop for translations + notifications (separate process, real Postgres) |
| `src/worker-loop.js` | The same loop as a function, so the server can run it when the database is embedded |

### Deliberate deviations from PLAN.md

Each is a judgement call, not an oversight — challenge them:

1. **Plain ESM JavaScript, not TypeScript.** No build step, so the whole system runs
   and is testable immediately.
2. **PGlite as the database**, not a Postgres server — none is installed on this
   machine and the Docker daemon was down. It *is* Postgres (compiled to WASM), so
   composite FKs, `CHECK`s, partial indexes, triggers, `plpgsql` and
   `FOR UPDATE SKIP LOCKED` are all genuinely exercised. `src/db.js` is the only file
   that knows this; its surface is `pg`-shaped.
3. **No Next.js app.** The plan's stack choice still stands for the UI; the API is
   framework-agnostic and the mock is not yet wired to it.
4. **Local filesystem storage, not S3.** `FsStorage` implements the same shape
   (put/get/head/delete + presigned URLs) so a real bucket is a drop-in.
5. **Stub translation provider.** `StubProvider` is deterministic and clearly fake;
   a real MT or LLM provider plugs in at the same seam (`provider.translate`).

### Not built yet

- The **web UI** — the mock is still a standalone file with its own duplicate
  `aiPrompt` and `packetFiles` implementations. It must be rewired to call
  `GET /api/bugs/:id/prompt` instead, or the two prompt builders will drift. This is
  the largest remaining piece of drift in the repo.
- A **real translation provider** and a **real mailer** (both are behind seams).
- **RGM-S1-006** (open): `buildPrompt` never renders `translations.title`, and reports
  unavailability only when *both* body languages are missing.
- The plan is still v3 and **unapproved** — both reviewers returned REVISE
  (see `PLAN-REVIEW-LOG.md`).

### Model allocation for the loop

Chosen per role rather than using one model throughout — the expensive model goes
where a mistake is most costly:

| Role | Model | Effort | Why |
|---|---|---|---|
| Recon | Claude `sonnet` | low | mechanical repo/file reading |
| Plan review | Codex `gpt-6-astra` | xhigh | adversarial critique; errors are cheapest to catch here |
| Build | Claude `opus` | high | implementation against a settled plan |
| Final inspection | Codex `gpt-6-astra` | high | independent verification of built code |

