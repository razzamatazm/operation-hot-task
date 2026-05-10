# Status

Live punch list. Everything in `plan.md` is the durable plan; this file changes as work lands.

## Done

### M1 — scaffold + mock auth + DB + minimal feed

- **Repo bootstrap**: npm workspaces monorepo (`apps/server`, `apps/web`, `packages/shared`), Node 22 LTS minimum, TypeScript 5.7 strict, ESM throughout, project references via `tsc -b`.
- **Workflow engine** (`packages/shared/src/workflow.ts`): `computeStatus(votes, requiredApprovals)` derives the request status from current owner votes. Denial isn't terminal; APPROVE+DENY → `NEGOTIATING`. Permission predicates for `canVote`, `canComment`, `canWithdraw`, `canOverrideQuorum`. Urgency → due-at math.
- **Schema** (`apps/server/src/db/schema.ts`): all 8 tables — users, loans, approval_requests, owner_votes, comments, attachments, audit_events, integration_api_keys. SQLite-portable to Postgres (text + CHECK in lieu of native enums).
- **Auto-init + seed**: server boots, ensures schema (`CREATE TABLE IF NOT EXISTS`), runs `seed.ts` if the users table is empty. Seeds 2 owners (Hank Halloran, Mort Mendelsohn), 4 officers (Avery, Brooke, Cal, Dee), 6 loans with realistic external IDs (`L-2026-014x`), 6 requests covering every status (IN_REVIEW, PARTIALLY_APPROVED, NEGOTIATING, NEEDS_CLARIFICATION, APPROVED).
- **Mock auth**: `requireUser` middleware reads `x-user-id` and looks the user up. Same `req.user: UserIdentity` shape the production Entra middleware will produce — the swap is one line.
- **API surface** (`apps/server/src/routes.ts`): `GET /health`, `GET /users` (mock-selector helper), `GET /me`, `GET /feed`, `GET /requests/:id`, `GET /loans`, `GET /stream` (SSE).
- **SSE broker** (`apps/server/src/sse.ts`): client registry, broadcast, 25s heartbeat, cleanup on close.
- **Web shell** (`apps/web`): Vite + React + Tailwind. Mock-user dropdown in the header, feed page with urgency/status badges and per-owner vote summary. Octogenarian-friendly base layer (18px font, ~13:1 contrast, 56px button minimum, 3px focus ring).
- **Smoke test** (`scripts/smoke-test.mjs`): boots the server end-to-end, asserts every expected derived status is present.

Verified clean: `npm install`, `npm run typecheck`, `npm run build`, `npm run test:smoke`, `npm audit` (0 vulns).

### Patches landed on top of M1

- **Node 22 LTS bump** (`b0ac292`). `.nvmrc` 20 → 22, `engines.node` `>=20.0.0` → `>=22.0.0`, `@types/node` 20.x → 22.x.
- **Security bumps** (`079c551`). drizzle-orm 0.36 → ^0.45.2 (GHSA-gpj5-g38j-94v9, SQL injection via improperly escaped identifiers, high). vite 5 → ^8.0.11 + @vitejs/plugin-react 4 → ^6.0.1 (transitively past GHSA-67mh-4wv8-2f99 esbuild dev-server CSRF). No code changes needed.
- **Cold typecheck fix** (`8bbdb8c`). Switched shared and server to `tsc -b` so the project-references graph is honored without requiring a prior shared build. Fixed `TS6305: Output file ... has not been built from source file`.

## Next (M2 — web submit + PDF preview + voting + negotiation flow)

Big rocks, in roughly the order you'd build them:

1. **Voting backend** — `apps/server/src/votes-service.ts` + `POST /api/requests/:id/votes`. Insert new `owner_votes` row, stamp prior row's `superseded_at`. Idempotency on `(requestId, ownerId, voteVersion)`. Audit event. Trigger `notifySubmitter` on first APPROVE, first DENY, NEEDS_CLARIFICATION, vote change, and final APPROVED. Broadcast SSE `vote.recorded` / `vote.changed` / `request.updated`.
2. **Comments backend** — `apps/server/src/comments-service.ts` + `POST /api/requests/:id/comments`. SSE `comment.added`. Audit event.
3. **Discussion view** — `GET /api/requests/:id/discussion`. Returns chronological merge of comments + decisions for the request's loan. Right-pane source of truth.
4. **Withdraw + quorum override** — `POST /api/requests/:id/withdraw` (submitter or ADMIN), `POST /api/requests/:id/quorum-override` (OWNER or ADMIN, sets `required_approvals=1`).
5. **Attachments** — `apps/server/src/{attachments-service,blob-storage}.ts`. `POST /api/attachments` (multipart, multer or busboy). Local-disk adapter for demo; Azure Blob adapter for prod (M4). `GET /api/attachments/:id/content` streams. SHA256 hash on upload.
6. **Submit form** — `apps/web/src/routes/Submit.tsx`. Loan typeahead (`GET /api/loans?q=`), request type select, title input, rich-text summary (TipTap), attachment dropzone. Multipart POST to `/api/requests`.
7. **Request detail / split-pane** — `apps/web/src/routes/RequestDetail.tsx` + `components/SplitPane.tsx`. Left: PdfPreview / ImagePreview based on attachment kind. Right: `DecisionPanel` (Approve / Deny / Question buttons, vote indicators per owner, change-vote affordance, 2-step confirm for Deny) + `DiscussionThread` (chronological loan-wide discussion) + `CommentInput`.
8. **Loan detail** — `apps/web/src/routes/LoanDetail.tsx`. Full discussion across all the loan's requests. Deep-linkable from the split-pane.
9. **Submitter notifications stub** — `apps/server/src/teams-notify.ts`. Console log + SSE `notification` event. Document the M4 swap to the real `TeamsBotClient`.
10. **Workflow sim** (`scripts/workflow-sim-test.mjs`). Pure-function asserts over `computeStatus` and the vote-supersession rule. Wire to `npm run test:workflow`.
11. **SSE wiring on the SPA** — `apps/web/src/lib/sse.ts`. Subscribe on mount; invalidate the relevant TanStack Query keys per event type. Auto-update the feed and detail panes without manual refresh.

End-to-end demo target: officer submits with a PDF attached; owner A approves → PARTIALLY_APPROVED, submitter notified; owner B denies → NEGOTIATING with both votes visible; comments fly back and forth; owner B changes vote to APPROVE → APPROVED; auto-close after timer.

## Open decisions (not blocking, but pin down before the relevant milestone)

Before M2:
- **Deny copy.** Working draft: *"Deny this LOI? The submitter will be notified and the request stays open for negotiation."* Sign-off needed from the user.
- **Override scenarios.** Which request types or conditions allow `required_approvals = 1`? (User said "some scenarios" — needs concrete list.)
- **Auto-close window for APPROVED.** Default proposal: 24h after the second approval. Fine?

Before M3:
- **Sample loan IDs and a small set of representative emails/PDFs** to seed `dev-fixtures/` so the demo looks real to the owners.

Before M4 (live wiring):
- **Existing backend's `loanId` format** (the user said "stable ID exists" — confirm format and any auth headers needed).
- **Email subject convention.** `[loan:<external_id>]` is the proposal. Alternative is a fuzzy resolver on borrower name. Confirm officers can be relied on to use the token.
- **Attachment retention.** Proposal: 7 years (typical US lending), Blob lifecycle to cool tier after 90 days.
- **Data residency.** Proposal: pin Azure region to `eastus2` or `westus3`.

## Known sandbox-vs-Mac gotchas

These only matter if you're working through the operation-hot-task → loancom transport. If you're working directly in `~/repos/loancom` on the Mac, ignore them.

- **Push authorization.** The Claude Code on the web sandbox can only push to `razzamatazm/operation-hot-task` (whatever scope the GitHub MCP has). It cannot push directly to `razzamatazm/loancom`. The workaround was staging the entire loancom tree as `loancom/` inside operation-hot-task on the `claude/loan-approval-dashboard-greJZ` branch, then pulling on the Mac and `cp -R loancom/. ~/repos/loancom/`.
- **Commit signing.** The same sandbox blocks commit signing for any repo besides operation-hot-task (returns `signing failed: missing source`). The workaround for in-sandbox commits to `~/repos/loancom` was `-c commit.gpgsign=false` on the one commit. The user's Mac signs normally.

If the next session is genuinely running on the user's Mac (or a sandbox authorized for `razzamatazm/loancom`), neither of these applies — push and sign normally.

## Things to ask the user about, on the next session

1. Do they want to start M2 right away, or polish M1 first (e.g. add the Submit nav button, color-tune the urgency badges, tweak seeds)?
2. Which of the M2 sub-tasks above should land in the first commit? Recommendation: voting backend + DecisionPanel + SplitPane + RequestDetail in one slice, then attachments + Submit form in the next.
3. Are they running this in a sandbox or on their Mac directly? (Affects whether the transport gotchas apply.)
