# RGM Project Manager

Tool to manage **developer ↔ tester** communication across multiple projects.

- Testers write in **Vietnamese**; developers read **中文 / English**.
- A developer marks a milestone complete → tester tests it → tester files a bug with
  **screenshots + a description in Vietnamese**.
- The developer sees the original **plus an auto-translation**, and one click copies a
  pre-formatted block straight into an AI agent (Claude / Codex) — replacing the current
  manual copy-paste step.

## Mock UI

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

The **mock** is sample data only — nothing persists, no backend.

The **build** has started. Slice 1 implements the audit foundation and the
agent-handoff contracts (PLAN.md §6, §8, §10) — the parts the reviews showed were
load-bearing:

```bash
npm install
npm test          # 46 tests, all against a real Postgres (WASM), no server needed
```

### Slice 1 — what exists

| Path | Closes |
|---|---|
| `db/migrations/001_init.sql` | **RGM3-001/RGM3-002** — the `CHECK` that made invitation redemption uncommittable; **RGM-016** — composite FKs (adds the missing `UNIQUE(project_id, id)`); plus RGM-011, RGM-012, RGM-008, RGM3-011, RGM2-012 |
| `src/transitions.js` | **RGM2-010** — explicit transition table; `closed→retest` / `new→retest` are now unrepresentable, stale retests rejected |
| `src/prompt.js` | **RGM3-014** — prompt-injection boundary: fixed preamble, tokenised fences, region markers that untrusted text cannot forge |
| `src/packet.js` | **RGM3-007** — zip-slip: packet entries are server-named, tester filenames are data only |
| `src/claim.js` | **RGM3-006/RGM3-001** — lease claim that can actually reclaim a dead worker |
| `test/schema.test.js` | executes the real migration and asserts the constraints, per test |

### Deliberate deviations from PLAN.md

Each is a judgement call, not an oversight — challenge them:

1. **Plain ESM JavaScript, not TypeScript.** No build step means the contracts are
   runnable and testable immediately. They port to TS trivially when the Next.js
   app lands. The plan's stack choice (§Decisions 1) still stands for the app.
2. **PGlite for tests** (Postgres compiled to WASM) because no Postgres server is
   installed and the Docker daemon is down. Semantics are real Postgres, so the
   composite FKs, `CHECK`s, partial unique indexes, triggers and
   `FOR UPDATE SKIP LOCKED` claims are genuinely exercised.
3. **No Next.js app yet.** These are framework-agnostic modules; the web layer is
   the next slice.

### Not built yet

Auth endpoints, HTTP routes, the upload path, translation workers, the CLI, and
the web UI. The plan is v3 and **unapproved** — both reviewers returned REVISE
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

