# PLAN-REVIEW-LOG — RGM Project Manager

Two rounds of the `claudex-loop` plan review. Round 2 ran **both providers in
parallel**, each reviewing independently in its own session, with no sight of the
other's findings.

---

## Round 1 — plan v1

| | |
|---|---|
| Plan | `PLAN.md` v1 |
| Plan SHA256 | `2b3f8d86bfd9089d14ec3d41fabb25c2fa2591e3d3a9c33299c199be7e6e857f` |
| Reviewer | Codex `gpt-6-astra`, effort `xhigh` |
| Verdict | **REVISE** |
| Findings | 9 (4 high, 5 medium) |
| Usage / time | 203,778 in / 7,328 out · 266 s |

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| RGM-001 | high | `bugs.project_id` and `milestone_id` independent — cross-project reference possible; endpoints don't authorize against the target resource | → §1 in v2 |
| RGM-002 | high | Invitations had no consumption/expiry/revocation contract | → §3 in v2 |
| RGM-003 | med | No bootstrap — empty DB cannot invoke developer-only operations | → §4 in v2 |
| RGM-004 | high | Async translation with no durable scheduling/retry/failure state | → §5 in v2 |
| RGM-005 | high | Append-only events don't make updates atomic. **The mock itself exhibited this** (`BUG-142`) | **Fixed in mock** → §6 in v2 |
| RGM-006 | med | Failed retest had no path back to `fixing` | → §7 in v2 |
| RGM-007 | med | `openBugs` excluded `retest`; `closed` wasn't a state | **Fixed in mock** → §7 in v2 |
| RGM-008 | med | No bug display-number allocation | → §2 in v2 |
| RGM-009 | med | Ready-notification undefined | → §9 in v2 |

---

## Round 2 — plan v2, dual review

| | Codex | Claude |
|---|---|---|
| Model | `gpt-6-astra` | `claude-fable-5-1` |
| Effort | `xhigh` | `xhigh` |
| Verdict | **REVISE** | **REVISE** |
| Findings | 13 (4 high, 9 med) | 16 (2 high, 9 med, 5 low) |
| Usage | 198,378 in / 10,173 out | 156,957 in / 27,733 out (20,122 thinking) |
| Cost | — | $2.62 |
| Time | 347 s | 354 s |
| Plan SHA256 | `a0b4dc70b527e8e29591b543d9e5ba4610e448cb92a6ecd86a4440a3d6d602ec` | same |

Both reviewers independently read all four repo files and **confirmed the
round-1 mock fixes** (`BUG-142` now `fixing`; `openBugs` excludes `closed`).
Neither saw the other's output.

### Where both agreed — highest confidence

| Issue | Codex | Claude |
|---|---|---|
| **No sign-in mechanism exists.** Invitations were separated from sessions, but nothing ever creates a session — blocks verification 1, 3, 8 | RGM-013 (high) | RGM2-001 (high) |
| **Admin has no home.** Roles live only in `memberships(project_id,…)`, but `bootstrap` creates an admin before any project exists | RGM-014 (med) | RGM2-002 (high) |
| Polymorphic `events(subject_type, subject_id)` cannot carry the promised composite FK | RGM-016 (med) | RGM2-003 (med) |
| `SKIP LOCKED` has no lease expiry — a worker crashing after committing `running` orphans the job | RGM-018 (med) | RGM2-004 (med) |
| Outbox `dedupe_key` prevents duplicate *rows*, not duplicate *emails* | RGM-020 (med) | RGM2-007 (med) |
| `rgm pull 142` has no repo→project binding or scoped number resolution | RGM-021 (med) | RGM2-008 (med) |
| Machine token identity/expiry/revocation undefined | RGM-022 (med) | RGM2-008 (med) |
| Retest authorization references an assignment that doesn't exist | RGM-019 (med) | RGM2-011 (med) |

### Codex-only findings

| ID | Sev | Finding |
|---|---|---|
| RGM-010 | high | **Self-contradiction I introduced**: the API lets developers create invitations, but the §1 matrix reserves invites for admins |
| RGM-011 | high | The auth rule ignores `memberships.revoked_at` — a revoked row still satisfies it |
| RGM-012 | high | Removing a member does not invalidate their *outstanding* invitations; consume-one-after-removal restores access |
| RGM-015 | med | "Atomic" redemption only updates `consumed_at`; membership grant is outside the transaction |
| RGM-017 | med | INSERT-only role on `events` cannot read timelines or run the `max(events.at)` reconciliation — contradicts §6 |

**RGM-016 is a concrete technical error:** `bug_attachments` references
`bugs(project_id, id)`, but `bugs` declares only `UNIQUE(project_id, bug_number)`.
Postgres requires the referenced columns to carry a unique constraint, so that FK
does not compile as written. Correct.

### Claude-only findings

| ID | Sev | Finding |
|---|---|---|
| RGM2-005 | med | Translation keyed `(bug_id, lang)` covers only the bug body — the tester's Vietnamese **retest-fail note lives in `events.payload`** and is never queued |
| RGM2-006 | med | Multipart upload inside the insert transaction would hold the `project_counters` lock across multi-MB object PUTs, serialising all testers |
| RGM2-009 | med | Endpoints missing for actions the verification steps require: comments, member removal, translation retry, auth |
| RGM2-010 | med | The allowed transition set is never enumerated; `*→retest` silently includes `closed→retest` and `new→retest` |
| RGM2-012 | low | "Numbers survive deletion" references deletion, which doesn't exist |
| RGM2-013 | low | The "stale session is visible in the timeline" claim overstates what an `actor_id` gives you on a shared device |
| RGM2-014 | low | `§9.1`/`§9.2` references point at the wrong section; editing a tracked `.gitignore` is wrong |
| RGM2-015 | low | **Real mock bug**: `aiPrompt` handled `filed/translated/statusNew/statusTo/comment` and fell through to raw `e.what`, so `BUG-116`'s `retestPass` rendered literally as "retestPass" in the copied prompt |
| RGM2-016 | low | Cloud MT provider unnamed while Decision 1 stresses on-prem; invite token placed in the URL path |

### Claude's answers to the round-1 open questions

- **Q1 Keep Postgres.** The plan's concurrency guarantees depend on `FOR UPDATE
  SKIP LOCKED` and multi-writer transactions — SQLite cannot provide them.
- **Q2 Per-project sessions are the wrong granularity.** §1 already checks
  membership on every request, so one user-level session with `last_seen_at` and a
  short absolute lifetime is simpler and equally immediate on revocation.
- **Q3 MT + glossary is sufficient for v1**, since the original is always shown.
- **Q4 Yes, CLI tokens need expiry and revocation.** Blast radius: every bug and
  screenshot in every project that developer belongs to, plus status writes.
- **Q5 Outbox is the right boundary**; keep it in-process until a second channel exists.

### Dispositions

| Item | Disposition |
|---|---|
| RGM2-015 | **Fixed and verified.** Added `retestPass`/`retestFail` labels plus a catch-all so a future kind can never render bare. Proven by executing the shipped `aiPrompt()` under Node against all 6 mock bugs — `PASS, all 6 emitted human labels`. |
| RGM2-014 | **Fixed in plan v2.** `§9.1/§9.2` → `Verification 1/2`; packet now carries its own `.rgm/.gitignore`. |
| RGM-010, 011, 012, 015, 017 | **Open** — real defects in v2, must be closed in v3. |
| RGM2-001…010, 012, 013, 016 | **Open** — must be closed in v3. |
| RGM-016 / RGM2-003 | **Open** — schema must be corrected (add `UNIQUE(project_id,id)` to `bugs`; replace polymorphic subject with typed nullable FKs). |

### Reviewer-stated limitations (both rounds)

The repo contains documentation and a static mock only — no backend, migrations,
worker, storage config, or tests. Findings identify **design-contract defects, not
reproduced production failures**. Neither reviewer edited files or ran code.
Both noted they could not evaluate stack suitability (Q1) or provider terms,
because the existing environment is not in the repo.

---

## Round 3 — plan v3, dual review

| | Codex | Claude |
|---|---|---|
| Model | `gpt-6-astra` | `claude-fable-5-1` |
| Effort | `xhigh` | `xhigh` |
| Verdict | **REVISE** | **REVISE** |
| Findings | 15 (5 high, 7 med, 3 low) | 15 (3 high, 8 med, 4 low) |
| Usage | 417,600 in / 12,073 out | 89,988 in / 23,093 out (15,771 thinking) |
| Cost | — | $2.19 |
| Time | 407 s | 314 s |
| Plan SHA256 | `bf7dcb095c1fafc70dafe9ba8669fa1acdcd0aa3a66557b34f1eaa58976f010d` (verified) | not recomputed — Claude had no shell tool; content read matched the plan supplied in its prompt |

Convergence was higher this round, which is the expected shape as the
specification tightens: the same four issues were found independently by both.

### Where both agreed — highest confidence

| Issue | Codex | Claude |
|---|---|---|
| **The lease-reclaim SQL cannot reclaim a dead worker.** The claim filters `status='pending'`, but a worker that commits `running` and dies leaves the row in `running` — so it never matches. This was the *exact* fix for RGM-018/RGM2-004, and it did not work | RGM3-006 | RGM3-001 |
| **The `events` CHECK makes the redemption audit event uninsertable.** `num_nonnulls(bug_id, milestone_id) = 1` rejects project/membership/invitation-scoped events, so §5's "atomic" redemption transaction always fails | RGM3-001 | RGM3-002 |
| **The login gate locks out the bootstrap admin.** `request-link` requires an active membership, but §3 makes site admin independent of projects — so a fresh install cannot authenticate | RGM3-007 | RGM3-003 |
| **Upload completion does not bind the storage key to the bug.** A retained key from project A can be completed against a bug in project B | RGM3-004 | RGM3-006 |

### Codex-only

| ID | Sev | Finding |
|---|---|---|
| RGM3-002 | high | Invitation recipient rule requires `activeMembership`, but a new invitee has no membership and may have no user row — the rule rejects exactly the people invitations exist to onboard |
| RGM3-003 | high | Invitation **creation** doesn't take the per-(project,email) lock, so a creation can commit after a removal and restore access |
| RGM3-005 | high | Completion registers the object addressed by the presigned key, but that PUT capability stays valid until expiry — an uploader can validate, then **replace the bytes**, poisoning every later view, download, and packet |
| RGM3-008 | med | §14 says removal revokes sessions; §4 says it revokes nothing globally. With user-level sessions the §14 wording logs a member out of unrelated projects |
| RGM3-009 | med | Only the null-assignee case is defined, so the matrix lets tester B close a bug assigned to tester A |
| RGM3-010 | med | Removing a tester doesn't cancel queued outbox rows, so a removed member can still receive a backlogged "ready" email |
| RGM3-011 | med | EXIF privacy depends entirely on the client — an authenticated client can PUT a GPS-tagged JPEG and `complete` will accept it |
| RGM3-012 | med | A self-consistent stale `.rgm.json` binding passes validation, so repo B can write project A's packet |
| RGM3-013 | low | **Mock bug** — `asDate` parsed sample timestamps in the browser's timezone while `NOW` was pinned to `+07:00` |
| RGM3-014 | low | **Mock bug** — the header read a hardcoded `P.updated`; `lastActivity()` existed but had **no caller** |
| RGM3-015 | low | **Mock bug** — the copy button showed success even when the clipboard write failed |

### Claude-only

| ID | Sev | Finding |
|---|---|---|
| RGM3-004 | med | Site admin is marked ✔ on every project-scoped row, but `activeMembership` is "the only way" to authorize — the two cannot both hold |
| RGM3-007 | med | **Zip-slip**: tester-supplied `filename` flows into a CLI that extracts into the developer's repo |
| RGM3-008 | med | Auditing every inline render appends N events per page view — polluting the timeline **and** breaking the byte-identical `bug.md` guarantee |
| RGM3-009 | med | No endpoints exist to mint/list/revoke API tokens, no logout, no role change — all promised in prose |
| RGM3-010 | low | `POST /api/invites` has no project in the path, contradicting §1's "scope comes from the resource" |
| RGM3-011 | low | `dedupe_key` derived from `(milestone_id, recipient)` suppresses a **legitimate second** ready notification after `ready→planned→…→ready` |
| RGM3-012 | low | §12's "any active tester" doesn't match the §1 matrix, which also allows developers and admins |
| RGM3-013 | low | Wrong cross-reference (`§14` meant Verification 10); §13's EXIF claim rests on client-side stripping |
| RGM3-014 | low | **Prompt injection**: tester-written title/body/notes flow straight into a coding agent via `bug.md`. Any project member can plant instructions in a bug body |
| RGM3-015 | low | Milestone `title_*` needs translation, but only bugs and events have translation tables |

**RGM3-014 is the most consequential finding of the whole review.** The product's
entire purpose is to feed tester-written text into an AI coding agent, and nothing
in the plan treats that text as untrusted input. A tester (or anyone who can reach
the bug form) can place instructions in a bug body that the developer's agent then
executes. This needs a fixed preamble plus delimited data blocks, and it should
shape the build, not be a footnote.

### Dispositions

| Item | Disposition |
|---|---|
| RGM3-013 mock timezone | **Fixed** — timestamps now parse with an explicit `+07:00` offset and format via `Intl` in the project timezone. |
| RGM3-014 mock dead helper | **Fixed** — header renders from `lastActivity(P)`. Verified: packing now shows `10:48`, correctly picking up BUG-141 over the hardcoded `10:40`. |
| RGM3-015 mock copy | **Fixed** — success is shown only after a confirmed clipboard write; on failure the text stays selected and a manual-copy message appears. |
| All 12 Codex + 14 Claude plan findings | **Open** — must be closed in v4. |

---

## Round 4 — pending

Three rounds have produced 9 → 29 → 30 findings, with the *severity* falling and
convergence rising, which is the intended trajectory. The plan still has no
approval: both reviewers returned REVISE in every round.

v4 must close the 26 open items above. Two deserve to drive the revision rather
than be patched around:

1. **RGM3-002/RGM3-001 (events constraint)** — one `CHECK` currently makes the
   entire invitation flow unshippable. The audit model needs a subject type that
   covers project, membership, and invitation, not just bugs and milestones.
2. **RGM3-014 (prompt injection)** — treat every tester-authored field as
   untrusted input at the prompt boundary.

**Approval note:** the reviewed hash was `bf7dcb09…`. Three mock fixes and this log
entry were applied afterwards, so a fresh review is required — the intended
behaviour of hash-bound approval.

### Model allocation used (all rounds)

| Role | Model | Effort | Rationale |
|---|---|---|---|
| Recon | Claude `sonnet` | low | mechanical repo/file reading |
| Plan review (both) | Codex `gpt-6-astra` + Claude `fable` | xhigh | adversarial critique; errors cheapest to catch here |
| Build | Claude `opus` | high | implementation against a settled plan |
| Final inspection | Codex `gpt-6-astra` | high | independent verification of built code |

**Dual review is earning its cost.** Across rounds the two reviewers have
converged on 15 issues (high confidence they are real) and each found a disjoint
set the other missed. Codex tends to find authorization and transactional edge
cases; Claude finds missing endpoints, threat-model gaps (zip-slip, prompt
injection), and live defects in the mock itself.

**Dual review paid for itself:** the two reviewers converged on 8 issues (giving
high confidence they are real) and each found a disjoint set the other missed —
Codex the authorization/transaction edge cases, Claude the missing sign-in path,
the untranslated retest note, and a live bug in the mock's prompt builder.
