# Plan

The full milestone plan for the loancom app. M1 is shipped; M2-M4 are ahead. See `status.md` for the live punch list.

## Context

Two octogenarian owners act as the loan committee for a small US lender. Eight loan officers and the servicing team push approval requests at them constantly — LOIs, terms, valuations, fundings, document redlines, generic committee questions. The current channel is email; items get buried, users keep resending, things never get checked.

We replace that with a web app. Owners get a clean in-app feed of pending items. The detail view is split-pane: document/email on the left, decision panel + running loan-committee discussion on the right. Officers submit via web form, by forwarding email to a shared mailbox, or via an inbound API from the existing loan-origination backend. Owners stay out of email entirely.

Eventual deployment is Azure, integrated with the company's existing Microsoft 365 / Entra footprint.

## Locked decisions

- **Repo**: standalone, at `~/repos/loancom`. The new GitHub repo is `razzamatazm/loancom`.
- **Intake paths**: web form (fully implemented), email-in (Microsoft Graph shared mailbox, **stubbed for demo** via `POST /api/dev/simulate-email` against fixtures), inbound API (real endpoint with API-key auth, **stubbed for demo** with curl examples). Live wiring is M4.
- **Owner UX**: web-only feed, no email notifications to owners. Submitters get notifications on every state-affecting change (in-app SSE + Microsoft Teams DM at M4; logs only for the demo).
- **Auth**: Microsoft Entra (Azure AD) SSO via MSAL React + `@azure/msal-node` at M4. Demo uses a header-based mock-user selector; the swap is one middleware change.
- **Storage**: Azure Database for PostgreSQL (Drizzle ORM) + Azure Blob Storage for attachments at M4. Demo uses SQLite (`better-sqlite3`) and a local `apps/server/storage/` directory behind the same `blob-storage.ts` interface.
- **Quorum & negotiation**: both owners must approve to close as APPROVED. **A denial does not end a request** — there is always room to negotiate. Each owner's current vote (APPROVE / DENY / NEEDS_CLARIFICATION / NONE) is tracked independently and any owner can change theirs at any time. Mixed votes put the request in `NEGOTIATING`. Per-request override flag (`required_approvals: 1`) for scenarios that don't need both.
- **Loan linking**: the existing backend exposes a stable `loanId`; we store it as `loans.external_id`. Web form has a typeahead picker. Email-in officers will include `[loan:<external_id>]` in subjects (documented for M4).

## Domain model (Drizzle, `apps/server/src/db/schema.ts`)

Enums: `request_type` (LOI | TERMS | VALUE | FUNDING | DOC_REDLINE | GENERIC_QUESTION), `request_status` (IN_REVIEW | PARTIALLY_APPROVED | NEGOTIATING | NEEDS_CLARIFICATION | APPROVED | WITHDRAWN | CLOSED), `vote_kind` (APPROVE | DENY | NEEDS_CLARIFICATION), `intake_source` (WEB | EMAIL | INTEGRATION_API), `user_role` (OWNER | OFFICER | SERVICING | ADMIN), `attachment_kind` (PDF | IMAGE | DOCX | EMAIL_BODY | OTHER), `urgency` (GREEN | YELLOW | ORANGE | RED).

Tables (key fields):

- **users** — id, entra_oid (unique), email, display_name, role, created_at, last_login_at.
- **loans** — id, external_id (unique, from the existing backend), borrower_name, address, status, created_at.
- **approval_requests** — id, loan_id, request_type, title, summary, intake_source, submitted_by_user_id, submitted_at, due_at, urgency, required_approvals (default 2), closed_at, withdrawn_at, version. *Status is computed, not stored.*
- **owner_votes** — id, request_id, owner_user_id, vote, reason (required for DENY/NEEDS_CLARIFICATION), voted_at, superseded_at (nullable). The "current" vote is `WHERE superseded_at IS NULL`. Vote changes insert a new row and stamp the prior. Full history preserved.
- **comments** — id, request_id, loan_id (denormalized), author_user_id, body, created_at.
- **attachments** — id, request_id (nullable), comment_id (nullable), file_name, kind, mime_type, size_bytes, storage_path, uploaded_by_user_id, created_at.
- **audit_events** — id, request_id (nullable), loan_id (nullable), actor_user_id (nullable for system), action, detail (jsonb), at.
- **integration_api_keys** — id, key_hash, label, created_at, revoked_at.
- **graph_subscriptions** — (M4 only) id, subscription_id, resource, expires_at, client_state.

## Workflow engine (`packages/shared/src/workflow.ts`)

Status is **derived** from the set of current owner votes — never stored. The derivation is `computeStatus(votes, requiredApprovals)`:

```
no votes yet                                    → IN_REVIEW
some APPROVE, others not yet voted              → PARTIALLY_APPROVED
all owners APPROVE, count ≥ required_approvals  → APPROVED
mix of APPROVE and DENY                         → NEGOTIATING
all current votes are DENY                      → NEGOTIATING (still open — denial is not terminal)
any current NEEDS_CLARIFICATION                 → NEEDS_CLARIFICATION
APPROVED → CLOSED                               (auto 24h after final approval, or manual close)
any → WITHDRAWN                                 (submitter or ADMIN explicit close)
```

Owners can change their vote at any time before WITHDRAWN/CLOSED. Changing a vote inserts a new `owner_votes` row, supersedes the old one, recomputes status, emits SSE/notification events. There is no "first approval locks the result" rule and no separate denial terminal — the only terminal states are CLOSED and WITHDRAWN.

Permission predicates: `canVote` (OWNER, status not in {CLOSED, WITHDRAWN}), `canReplyForClarification` (officer on the loan, status NEEDS_CLARIFICATION), `canComment` (any authenticated user with read access to the loan), `canSubmit` (OFFICER for web, valid API key for integration, system actor for email-in), `canWithdraw` (submitter or ADMIN), `canOverrideQuorum` (OWNER or ADMIN, sets `required_approvals = 1`).

## API surface (`apps/server/src/routes.ts`, mounted at `/api`)

Owner/officer (mock auth via `x-user-id` for demo; Entra OIDC bearer at M4):

- `GET /feed` — owner-prioritized list with derived status and vote summary per item.
- `GET /requests/:id` — request + current votes + allowed transitions.
- `GET /requests/:id/discussion` — chronological comments + decisions for the request's loan (right-pane source of truth).
- `GET /loans/:id`, `GET /loans/:id/discussion`, `GET /loans?q=` (typeahead).
- `POST /requests` — multipart for attachments (M2).
- `POST /requests/:id/comments` (M2).
- `POST /requests/:id/votes` — owner casts or changes a vote; idempotent on `(requestId, ownerId, voteVersion)`. Inserts new row, supersedes prior. (M2)
- `POST /requests/:id/withdraw`, `POST /requests/:id/quorum-override` (M2).
- `POST /attachments` (multipart) → `{ id, blobPath }`. `GET /attachments/:id/content` → streamed via the storage adapter (local file in dev, short-lived SAS URL in prod). (M2)
- `GET /stream` — SSE. Events: `request.created`, `request.updated`, `comment.added`, `vote.recorded`, `vote.changed`, `notification`.

Stubbed-for-demo intake (real routes, fake adapters):

- Inbound integration (`x-api-key`): `POST /integrations/requests` is fully implemented (M3). Demo is a curl script.
- Email-in: `POST /graph/notifications` is **not** wired live for the demo. Instead, `POST /api/dev/simulate-email` (auth-gated to ADMIN, only mounted when `NODE_ENV !== 'production'`) accepts the same parsed-message shape the Graph fetcher would produce and feeds it through the same `EmailIntakeService.ingest()` the live path will call (M3). Fixtures in `apps/server/dev-fixtures/inbound-email/`.

## Submitter notifications

Owners get nothing. Submitters get notified on every status-affecting change — first APPROVE, first DENY, NEEDS_CLARIFICATION, vote changes, final APPROVED/CLOSED.

For the demo: `apps/server/src/teams-notify.ts` exposes `notifySubmitter({ requestId, kind, message })` that logs to console and emits an SSE `notification` event for the active officer's session. The real Teams DM (via the `TeamsBotClient` pattern in operation-hot-task's `apps/server/src/bot.ts`) is documented in the file as the M4 swap-in.

## File rendering (left pane)

- **PDF**: `pdfjs-dist` rendered to `<canvas>`, page nav + zoom + fit-to-width default. The dominant path. (M2)
- **Images**: `<img>` with pinch/scroll zoom (`react-medium-image-zoom`). (M2)
- **Email body**: sanitized HTML via `DOMPurify` inside a sandboxed iframe. (M3)
- **Word/.docx**: convert to PDF on upload via headless LibreOffice (`soffice --headless --convert-to pdf`). Mammoth.js loses redline fidelity; redlines are an explicit request type so we cannot lose track-changes. Original `.docx` is preserved in storage for download. Conversion is async; `attachment.processing = true` until done; SSE-broadcast on completion. (M3)

## Frontend (`apps/web`)

Vite + React 18 + TS + Tailwind + (eventually shadcn/ui) + TanStack Query + React Router + (eventually MSAL React).

Pages: `/login` (M4), `/feed` (owner default; click → split-pane detail), `/submit` (officer form: loan picker, type, title, rich-text summary via TipTap, attachments dropzone), `/loan/:id` (full discussion).

Octogenarian-friendly defaults baked into Tailwind config + base layer:
- 18px base / 20px body / 28px+ headings; `font-feature-settings: "tnum"`.
- ~13:1 contrast palette, no gray-on-gray.
- Buttons min 56px tall, 24px horizontal padding; primary actions filled solid; Deny is a distinct color and requires a 2-step confirm.
- 3px high-contrast focus ring on every interactive element. No hover-only affordances.
- Unread badge in page title (`(3) Loancom`) + red dot per row.
- Keyboard: `J/K` move, `A`/`D`/`Q` for Approve/Deny/Question on the focused request — every shortcut also has a visible button.

## Auth

For the demo: a mock-user selector in the SPA header. Server middleware `requireUser(req)` reads `x-user-id` and looks the user up in the seeded set.

For production (M4): swap `requireUser` for `requireEntraUser` — Entra OIDC, auth-code-with-PKCE in the SPA via MSAL React; bearer token to the API. Server validates JWT signatures against the tenant JWKS using `jose`. App registration exposes scope `api://loancom/.default`. Roles come from the `groups` claim. The integration endpoint uses an `x-api-key` bearer hashed in `integration_api_keys`. The Graph webhook uses HMAC `clientState`.

## Deployment (Azure, M4)

- **API**: Azure App Service (Linux, Node 22), Always On, `WEBSITE_RUN_FROM_PACKAGE=1`. LibreOffice via startup script.
- **SPA**: served by the same App Service via `express.static` (matches the operation-hot-task pattern).
- **DB**: Azure Database for PostgreSQL — Flexible Server. Private endpoint into the App Service VNet.
- **Blob**: container `loancom-attachments`, lifecycle rule cool-tier after 90 days, private with server-minted SAS (10-minute TTL).
- **Entra**: API app registration (exposes scope) + SPA registration (redirect URIs prod + `localhost:5173`) + security groups for Owners/Officers.
- **Graph subscription**: created once via `scripts/azure/register-graph-subscription.sh`, renewed by the in-app scheduler.
- Manual one-time: app registrations, group creation, secrets, custom domain DNS, shared mailbox provisioning. Everything else scriptable.

## Sequenced milestones

**M1 — Scaffold + mock auth + DB + minimal feed.** ✅ Done. See `status.md`.

**M2 — Web submit + PDF preview + voting + negotiation flow.**
Files to create:
- `apps/server/src/{requests-service,votes-service,comments-service,attachments-service,blob-storage,teams-notify}.ts`
- routes for `POST /requests`, `POST /requests/:id/votes`, `POST /requests/:id/comments`, `POST /requests/:id/withdraw`, `POST /requests/:id/quorum-override`, `POST /attachments`, `GET /attachments/:id/content`, `GET /requests/:id/discussion`, `GET /loans?q=`
- `apps/web/src/components/{SplitPane,RequestList,DecisionPanel,DiscussionThread,VoteIndicator}.tsx`
- `apps/web/src/components/Preview/{PdfPreview,ImagePreview,EmailPreview}.tsx`
- `apps/web/src/routes/{Submit,RequestDetail,LoanDetail}.tsx`
- `scripts/workflow-sim-test.mjs`

Demo target: officer submits with a PDF attached; owner A approves → status `PARTIALLY_APPROVED`, submitter sees a console-logged "first approval" notification; owner B denies → status `NEGOTIATING` with both votes visible; comments fly back and forth; owner B changes vote to APPROVE → `APPROVED`; auto-close after timer (or manual close button for the demo).

**M3 — Stubbed inbound API + stubbed email-in + Word conversion.**
Files to create:
- routes for `/integrations/requests` (real, API-key auth) and `/api/dev/simulate-email` (dev-only)
- `apps/server/src/{email-intake-service,graph-mailbox-subscription,graph-mail-fetcher,scheduler}.ts` — last two are stubs that throw "not wired"
- LibreOffice convert-on-upload worker (real, runs locally)
- `apps/web/src/components/Preview/DocxPreview.tsx`
- `apps/server/dev-fixtures/inbound-email/{loi-redline.json,valuation-question.json,...}`
- `scripts/demo/{post-integration-request.sh,replay-emails.mjs}`
- `docs/email-in.md`

Demo target: replay a fixture email with a `.docx` attachment, watch it appear in the feed within a second with a converted PDF preview; curl the integration endpoint and see the request show up.

**M4 — Live integrations + Azure deploy + polish.**
- Replace mock-user middleware with `requireEntraUser`
- Implement `graph-mailbox-subscription.ts` and `graph-mail-fetcher.ts` against live Graph
- Wire `teams-notify.ts` to the real `TeamsBotClient`
- `scripts/azure/{provision-webapp,provision-postgres,provision-blob,register-graph-subscription}.sh`
- SAS minting in `blob-storage.ts`
- `apps/web/tests/` Playwright suite for the owner critical flow
- `docs/{architecture,auth,deployment}.md`
- `.github/workflows/{ci,deploy}.yml`

Ship to staging slot, then prod.

## Verification

Per-milestone checks:

- **Local boot**: `npm install && npm run dev`. SPA at `localhost:5173`, proxy `/api` → `localhost:4000`. Mock-user selector toggles identities.
- **Workflow sim** (`npm run test:workflow`, M2): pure-function tests over `computeStatus`. Asserts: only OWNER can vote; no votes → IN_REVIEW; one APPROVE (of 2 required) → PARTIALLY_APPROVED; APPROVE + DENY → NEGOTIATING (not terminal); both APPROVE → APPROVED; vote change supersedes prior; NEEDS_CLARIFICATION dominates; reason required for DENY/NEEDS_CLARIFICATION; submitter or ADMIN can WITHDRAW from any non-CLOSED state.
- **Smoke** (`npm run test:smoke`): boots the server with seeded data, posts a request via web (mock auth) and via the integration API-key endpoint, replays a fixture email through `POST /api/dev/simulate-email` (M3+), asserts the new request appears in `GET /feed`, posts a vote from each seeded owner, asserts SSE `vote.recorded` and `request.updated` events arrive on `/api/stream`, asserts an APPROVE+DENY mix yields NEGOTIATING and a vote-change yields APPROVED.
- **Drizzle integration** (CI, M2+): Postgres service container; migrations applied; service-layer tests for `RequestService.create` from each intake source.
- **Demo script** (M3): `scripts/demo/run-demo.mjs` walks through seed → submit web → email replay → integration POST → owner votes → negotiation → resolution and prints a transcript.
- **Playwright** (M4): owner logs in via Entra, opens a feed item, sees the PDF render, casts a vote, watches status change live without reload; second owner repeats and the request closes as APPROVED.
- **Manual UX pass** (M2 onward): hit the feed at 200% browser zoom; tab through every interactive element verifying focus rings; AA contrast checked with axe-core in Playwright.
- **Azure smoke** (M4): provisioned staging slot serves the SPA, Entra login works, a real `.docx` upload converts to PDF and renders, an email forwarded to the shared mailbox materializes a request within 30s, an inbound API POST from the loan-origination app creates a linked request.
