# Loancom — Loan Committee Approvals

A web app for two octogenarian company owners to approve, deny, or negotiate loan-related requests submitted by loan officers and the servicing team. Replaces the email firehose currently used for LOI approvals, terms approvals, valuation approvals, funding approvals, redline reviews, and committee questions.

## Quick start (demo)

```bash
nvm use            # Node 20
npm install
cp .env.example .env
npm run dev        # starts API at :4000 and SPA at :5173
```

Open http://localhost:5173. Use the mock-user selector at the top right to switch between seeded owners (Hank, Mort) and officers (Avery, Brooke, Cal, Dee). Owners see the feed; officers see a Submit button.

The first time the server starts, it creates a SQLite database at `apps/server/data/loancom.db` and seeds two owners, four officers, six loans, and a handful of in-flight requests covering every status (IN_REVIEW, PARTIALLY_APPROVED, NEGOTIATING, NEEDS_CLARIFICATION, APPROVED).

## Architecture

```
loancom/
  apps/server/    Express + Drizzle (SQLite for demo, Postgres for prod) + SSE
  apps/web/       Vite + React + Tailwind. Mock-user header for demo.
  packages/shared/  Types + workflow engine (computeStatus, permission predicates)
```

The workflow engine (`packages/shared/src/workflow.ts`) derives request status from the set of current owner votes — a denial does not end a request because there is always room to negotiate. See `docs/architecture.md` for the full state derivation.

## Scripts

- `npm run dev` — both server and web in watch mode
- `npm run build` — full build (shared → server → web)
- `npm run typecheck` — type-check every workspace
- `npm run test:workflow` — pure-function tests for `computeStatus`
- `npm run test:smoke` — boot server, exercise the happy path end to end
- `npm run db:reset` — wipe the SQLite db and re-seed

## What's stubbed for the demo

- **Email-in**: `POST /api/dev/simulate-email` ingests a parsed-message shape directly; the live Microsoft Graph subscription wires in at M4.
- **Inbound integration API**: real endpoint with API-key auth at `POST /api/integrations/requests`; the connection from the loan-origination app is documented but not wired.
- **Auth**: mock-user selector. Microsoft Entra SSO wires in at M4.
- **Storage**: SQLite + local `apps/server/storage/`. Postgres + Azure Blob at M4.
- **Notifications**: console log + in-app SSE toast. Teams DM at M4.

See `/root/.claude/plans/very-similarly-to-this-jiggly-thimble.md` (the source plan) for the full milestone breakdown.
