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

Sign-in is the real magic-link flow: `/login` requests a link, and the dev mailer
prints it to the server console as `[mail] … token=…`. Open `/login?token=…` (or use
the printed URL) to get a session.

| Screen | What it does |
|---|---|
| Milestones | Cards per milestone; a tester only sees **Report bug** on a `ready` milestone |
| Bugs | Rows with severity, status, milestone, attachment count and timestamps |
| Bug detail | Vietnamese original beside the translation, the activity timeline with translated notes, real screenshot downloads, the server-built prompt for the AI agent, and role-appropriate actions |
| Report | Vietnamese title/body + screenshots, uploaded through the real two-phase flow |

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
| `STORAGE_DIR` / `STORAGE_SECRET` | Local object storage, and the HMAC key for upload capabilities. |
| `S3_ENDPOINT` `S3_BUCKET` `S3_ACCESS_KEY_ID` `S3_SECRET_ACCESS_KEY` | Store attachments in a bucket instead. `S3_REGION`, `S3_FORCE_PATH_STYLE` (default true — MinIO needs it). |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `MAIL_FROM` | Send real mail over SMTP. `SMTP_SECURE=true` for implicit TLS, `REQUIRE_TLS=true` to demand STARTTLS. |
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
npm test          # 130 tests against a real Postgres (WASM) over real HTTP
npm run migrate
npm start         # http://127.0.0.1:3000
npm run worker    # drains the translation queue and the notification outbox
npx rgm login --url http://127.0.0.1:3000 --token <api-token>
npx rgm pull 1    # write .rgm/BUG-1/{bug.md,meta.json,screenshot_01.png}
```

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
| `src/worker.js` | Background loop for translations + notifications |

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

