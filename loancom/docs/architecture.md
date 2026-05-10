# Architecture

A tour of what M1 actually built. Use this with `plan.md` (the durable plan) and `status.md` (the current punch list) to orient before extending the codebase.

## Workspace layout

```
loancom/
  package.json              workspaces: apps/*, packages/*. Scripts orchestrate the workspaces.
  tsconfig.base.json        strict TS, ES2022, ESM, declaration on, isolatedModules.
  .env.example              demo defaults (DATABASE_URL = SQLite path, INBOUND_API_KEY = "demo-inbound-key").

  packages/shared/          @loancom/shared — types + workflow engine
    src/index.ts            re-export
    src/types.ts            UserRole, RequestType, RequestStatus, VoteKind, IntakeSource, AttachmentKind, UrgencyLevel, UserIdentity, Loan, OwnerVote, Comment, Attachment, AuditEvent, ApprovalRequest, ApprovalRequestWithContext.
    src/workflow.ts         computeStatus(votes, requiredApprovals), permission predicates, computeDueAt, summarizeVotes.
    tsconfig.json           composite: true. Built via tsc -b.

  apps/server/              @loancom/server — Express + Drizzle (SQLite) + SSE
    src/index.ts            bootstrap: seed if needed, mount routes, listen.
    src/config.ts           reads .env, resolves SQLite path and attachment dir to absolute paths.
    src/auth.ts             requireUser middleware (mock; reads x-user-id). requireRole(...) helper.
    src/sse.ts              client registry, broadcast(event), 25s heartbeat.
    src/routes.ts           Express Router; mounts /health, /users, /me, /feed, /requests/:id, /loans, /stream.
    src/workflow-service.ts listFeed, loadRequest, listLoans, listUsers, ownerCount.
                            (This is where status derivation is invoked — it reads current votes for each
                            request, calls computeStatus, and stitches into FeedItem / ApprovalRequestWithContext.)
    src/db/schema.ts        drizzle-orm/sqlite-core tables + the SCHEMA_DDL string array used to bootstrap
                            the SQLite db on first run.
    src/db/client.ts        opens better-sqlite3, applies WAL + FK pragmas, runs SCHEMA_DDL, exports drizzle(db).
    src/db/seed.ts          OWNERS, OFFICERS, SEED_LOANS, SEED_REQUESTS arrays. Idempotent: skips if any users exist.

  apps/web/                 @loancom/web — Vite + React + Tailwind
    index.html              loads /src/main.tsx. Imports Inter from Google Fonts.
    vite.config.ts          @vitejs/plugin-react. dev proxy /api → :4000.
    tailwind.config.ts      octogenarian-friendly type scale + accessible palette + 3px focus ring.
    postcss.config.cjs      tailwind + autoprefixer.
    src/main.tsx            createRoot(#root). StrictMode.
    src/App.tsx             header (title + MockUserSelector) + main (Feed when user is set).
    src/styles.css          @tailwind directives, base layer (:focus-visible ring, button min-height).
    src/components/
      MockUserSelector.tsx  fetches /api/users, persists choice in localStorage, calls onChange.
    src/routes/
      Feed.tsx              fetches /api/feed, renders rows with urgency/status badges + per-owner vote labels.
    src/lib/
      auth.ts               getMockUserId/setMockUserId (localStorage), fetchMe, fetchUsers.
      api.ts                authedFetch (adds x-user-id header), getFeed, FeedItem type.

  scripts/
    smoke-test.mjs          spawns `npm run dev:server`, waits for "listening on" log, hits /health,
                            /users, /feed, asserts every expected derived status is present, kills server.
```

## How the pieces connect

### Status is derived, not stored

The `approval_requests` table has columns for `closed_at`, `withdrawn_at`, `required_approvals`, `version`, and the request inputs (title, summary, etc.) — but **no `status` column**. Status is always computed at query time:

```ts
// workflow-service.ts (paraphrased)
for each request:
  votes = SELECT * FROM owner_votes WHERE request_id = ? AND superseded_at IS NULL
  status = computeStatus({ votes, requiredApprovals: req.required_approvals,
                            closedAt: req.closed_at, withdrawnAt: req.withdrawn_at })
```

This is deliberate. Status is derived from a small set of inputs (the closed/withdrawn flags and the current vote set), and computing it on the fly is cheaper than maintaining a denormalized column that could fall out of sync. If status reads ever become hot, cache them at the listFeed level — don't add a column.

### Vote supersession

When an owner changes their vote, we don't UPDATE the existing row. We INSERT a new `owner_votes` row and UPDATE the prior row's `superseded_at` to now. The "current" vote per owner per request is `WHERE superseded_at IS NULL`. The full vote history is preserved for the audit log and the discussion thread.

This pattern is implemented in M2 (votes-service.ts). M1 only seeds initial votes — none of the seeded votes are supersessions.

### SSE broker

Single in-process broker (`apps/server/src/sse.ts`). When the server is replicated for prod, this needs to be replaced with a pub/sub backend (Redis Streams or Azure Service Bus). For the demo, in-process is fine — there's only one server.

Events emitted:
- `request.created` — new request appeared
- `request.updated` — anything that changes the derived status (vote cast/changed, closed, withdrawn)
- `comment.added` — a new comment landed (M2)
- `vote.recorded` / `vote.changed` — granular vote events (M2)
- `notification` — submitter notification (M2)

The SPA opens `/api/stream` on mount (M2 work). TanStack Query invalidates the relevant keys per event.

### Three intake paths, one service

Web form (M2), inbound integration API (M3), email-in (M3) all eventually call the same `RequestService.create({ source, actor, ... })`. The actor identity differs:

- Web: `req.user` from the Entra/mock middleware.
- Integration: synthetic `{ id: 'integration', displayName: 'Servicing Integration' }` after API-key validation.
- Email: synthetic `{ id: 'system:graph', displayName: '<sender email>' }` after Graph webhook validation.

Each path resolves `loan_id` by upserting on `loans.external_id`. Web has a typeahead picker (preselected). Integration includes `externalLoanId` in the payload. Email-in parses `[loan:<external_id>]` from the subject.

### Auth swap point

`apps/server/src/auth.ts` exposes `requireUser` (demo) which reads `x-user-id`. The production swap is a single file: replace the body to validate an Entra OIDC bearer token (verify JWT against tenant JWKS via `jose`), map the `groups` claim to a UserRole, attach `req.user`. Same shape, no callsite changes.

The integration API uses a separate middleware (M3): `requireApiKey` reads `x-api-key`, hashes it, looks up `integration_api_keys` for a non-revoked match, attaches a synthetic `req.user`.

### Storage adapter

`apps/server/src/blob-storage.ts` (M2) is a small interface:

```ts
interface BlobStorage {
  put(path: string, content: Buffer | Readable, mime: string): Promise<void>;
  get(path: string): Promise<Readable>;
  remove(path: string): Promise<void>;
  signedReadUrl?(path: string, ttlSec: number): Promise<string>;  // prod only
}
```

Demo implementation writes/reads under `apps/server/storage/`. Production implementation uses `@azure/storage-blob` against a configured container, with `signedReadUrl` minting short-lived SAS URLs.

### Octogenarian-friendly UX defaults

`apps/web/tailwind.config.ts` overrides the type scale (base 18px, body 20px, headings 28+) and adds an accessible palette. `apps/web/src/styles.css` adds a 3px high-contrast focus ring on all `:focus-visible` and a 56px button minimum height in the base layer. Don't override these per component — extend the palette in tailwind.config if you need a new accent.

## Conventions worth keeping

- **TS strict + ESM.** No `any`. No CommonJS. Imports use `.js` extensions because of NodeNext resolution (e.g. `from './schema.js'`).
- **`tsc -b` for typecheck/build.** Project references with `composite: true` on shared. Don't switch back to `tsc -p`; cold typecheck breaks (TS6305).
- **Drizzle queries are explicit.** `db.select().from(table).where(eq(col, val)).all()`. We don't use Drizzle's relational query builder yet — keep selects flat for predictability.
- **Migrations via SCHEMA_DDL.** For the demo, we bootstrap with `CREATE TABLE IF NOT EXISTS` strings rather than drizzle-kit migrations. When we move to Postgres (M4), generate proper migrations with drizzle-kit and drop the SCHEMA_DDL approach.
- **Workflow rules live in shared, not in services.** If you're tempted to write status logic in `routes.ts` or `requests-service.ts`, stop and put it in `packages/shared/src/workflow.ts`. Tested by `scripts/workflow-sim-test.mjs` (M2).
- **Audit everything.** Every state-changing action writes to `audit_events` with the actor, the action type, and a JSON detail.
