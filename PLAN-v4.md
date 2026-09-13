# PLAN v4 — disposition of the review findings

v3 was a 466-line design document written before anything ran. It is superseded.
`PLAN.md` still describes intent; the product now exists, so the design lives in
the code and in the tests that hold it in place. This document is the closure
record: every round-3 finding, where it stands, and the evidence.

Where a finding was resolved by a decision rather than a code change, it says so.
Where it is genuinely still open, it says that too.

---

## Converged findings (both reviewers — treated as certain)

| Finding | Disposition | Evidence |
|---|---|---|
| **The lease-reclaim SQL cannot reclaim a dead worker.** Filtering `status='pending'` never matches a row a worker committed as `running` and then died. | **Closed** | `src/claim.js` selects `(status = 'pending' OR (status = 'running' AND lease_until < now()))`. `test/schema.test.js`: "a lease that has expired is reclaimable". |
| **The `events` CHECK makes the redemption audit event uninsertable.** `num_nonnulls(bug_id, milestone_id) = 1` rejects project-, membership- and invitation-scoped events. | **Closed** | `db/migrations/001_init.sql:232` — four typed nullable subject columns with `num_nonnulls(...) <= 1`. `test/e2e.flow.test.js` redeems an invitation and asserts the audit row. |
| **The login gate locks out the bootstrap admin.** `request-link` required an active membership, but a fresh install has no project. | **Closed** | `src/auth.js:92` — `if (!user.is_site_admin && !hasMembership) return { sent: false }`. `test/api.auth.test.js`: "a site admin with no membership can sign in". |
| **Upload completion does not bind the storage key to the bug.** A retained key from project A could be completed against a bug in project B. | **Closed** | `src/api.js` `attachments/complete` — the key must carry the `projectId/bugId/` prefix, and the object must exist. `test/api.attachments.test.js` upload-binding case. |

## Codex-only findings

| ID | Sev | Disposition | Evidence |
|---|---|---|---|
| RGM3-002 | high | **Closed.** Redemption creates the user and the membership in one transaction; the route authorizes the *inviter*, who is an admin — never the invitee. | `src/auth.js` `redeemInvite`; `test/api.auth.test.js` redeem flow. |
| RGM3-003 | high | **Closed.** Both creation and removal take `pg_advisory_xact_lock(project, email)`, so a creation cannot commit after a removal and restore access. | `src/auth.js`; `test/api.auth.test.js`: "removing a member invalidates their outstanding invitation". |
| RGM3-005 | high | **Closed (this session).** Completion now *promotes* the object — `rename` on disk, server-side `CopyObject` on S3 — to a key no capability was issued for, so the client's still-valid PUT cannot replace the validated bytes. | `src/storage.js` / `src/storage-s3.js` `promote`; `test/api.attachments.test.js`: "completing promotes the object, so the capability cannot replace it later"; `test/storage.test.js` exercises CopyObject against the S3 stub. |
| RGM3-008 | med | **Resolved as a decision.** Removal does not revoke sessions; every request re-checks membership, so a removed member loses access on the next call and keeps working in unrelated projects. The §14 wording was wrong, not the behaviour. | `src/auth.js` `authorize` consults `active_memberships` per request. |
| RGM3-009 | med | **Closed.** A retest is bound to `retest_assignee_id`; another tester cannot record it. | `src/api.js` retest handler; `test/api.bugs.test.js`: "an assigned retest can only be recorded by the assignee". |
| RGM3-010 | med | **Closed, twice over.** Removal cancels queued outbox rows in the same transaction, and the sender re-checks membership at send time anyway. | `src/auth.js` `removeMember`; `src/notify.js` `runOutbox`; two tests in `test/api.auth.test.js`. |
| RGM3-011 | med | **OPEN — known.** EXIF (including GPS) is not stripped server-side. A client can PUT a geotagged JPEG and `complete` accepts it. Mitigation today is the client-side strip in `public/app.js`; a server-side re-encode is the real fix. | Not implemented. |
| RGM3-012 | med | **Not applicable.** The CLI has no `.rgm.json` binding file, so the attack surface does not exist. Packets are written only under the `--out` directory (`--out`, default `.rgm/<CODE>/`). | `src/cli.js`. |
| RGM3-013/014/015 | low | **Closed.** Mock bugs — timezone parsing, a dead `lastActivity()`, a copy button reporting false success. Fixed in the mock, and the real UI inherits the corrected behaviour. | `public/app.js`; the mock's fixes are recorded in `PLAN-REVIEW-LOG.md`. |

## Claude-only findings

| ID | Sev | Disposition | Evidence |
|---|---|---|---|
| RGM3-004 | med | **Resolved as a decision.** Site admin marks every project row ✔ because it grants admin *authority* project-wide — but project-scoped requests still require membership, which is what `authorize` checks. The two sentences contradicted each other; the behaviour is coherent. | `src/auth.js:54` — `const effective = actor.isSiteAdmin ? 'admin' : role`. |
| RGM3-007 | med | **Closed.** Packet entry names are assigned by the server (`screenshot_NN.ext` from the validated content type), never taken from the tester's filename, and `assertSafeRelativePath` rejects traversal before any write. The CLI validates before writing. | `src/packet.js`; `test/packet.test.js`; `test/cli.packet.test.js`. |
| RGM3-008 | med | **Closed (this session).** Auditing reads appended events, and events feed the prompt — so pulling a packet changed the next one. Audit-only kinds are still recorded but excluded from the prompt timeline, keeping `bug.md` byte-identical between two pulls. | `src/api.js` `AUDIT_ONLY_KINDS`; `test/api.attachments.test.js`: "downloading a packet does not change the next packet". |
| RGM3-009 | med | **Closed (this session).** Token mint/list/revoke and logout already existed; the missing piece was role change. Added `PATCH /api/projects/:id/members/:userId` with a last-admin guard. | `src/api.js`; four tests in `test/api.auth.test.js`. |
| RGM3-010 | low | **Closed.** The route is `POST /api/projects/:id/invites`, so scope comes from the path. | `src/api.js`. |
| RGM3-011 | low | **Closed.** The notification key is `milestone.ready:<milestone>:gen<ready_count>:<recipient>`, so a second readiness cycle is a distinct key and notifies again. | `src/notify.js:45`; `test/e2e.flow.test.js`: "a second readiness cycle notifies again". |
| RGM3-012 | low | **Closed as a documentation fix.** Retest requires `ANY_MEMBER` in the transition table plus the assignee check — developers and admins included, which is the matrix's actual position. | `src/transitions.js`. |
| RGM3-013 | low | **Partially open.** The cross-reference is fixed; the EXIF claim is the same issue as RGM3-011 above. | See RGM3-011. |
| RGM3-014 | low | **Closed.** The prompt has a fixed preamble and every tester-written value sits inside a delimited `<<<RGM-UNTRUSTED:NAME>>>` block, with a standing instruction that fenced content is data. `test/ui.test.js` asserts the fence token never appears in client code, so the UI cannot drift from the server's prompt. | `src/prompt.js`; `test/prompt.test.js`. |
| RGM3-015 | low | **OPEN — known, low.** Milestone titles have `title_vi/zh/en` columns but no translation queue; a developer supplies all three by hand. Bugs and events are translated. | Not implemented. |

---

## Still open, and honestly so

1. **EXIF is not stripped server-side** (RGM3-011 / Claude RGM3-013). The privacy
   guarantee rests on the client re-encoding the image. A hostile or just
   non-conforming client defeats it. The fix is a server-side re-encode on
   `complete`.
2. **Milestone titles are not translated** (Claude RGM3-015). Low impact — the
   developer types all three — but the model is inconsistent with bugs.
3. **`002_privileges.sql` needs superuser for the role creation.** The migration
   applies everywhere and the grants are asserted by test, but on a managed
   Postgres that forbids `CREATE ROLE` the roles must be created by an operator
   first; the migration logs a notice and succeeds either way.

## Verification

```
npm test              # embedded Postgres (PGlite) — the default
npm run test:pg       # the same suite through the node-postgres driver
npm run smoke         # a real server, a file-backed database, the real CLI
```

`npm run test:all` runs both drivers. The driver matrix is the point: `src/db.js`
claims the two are interchangeable, so the same tests run through both, or the
claim is untested.
