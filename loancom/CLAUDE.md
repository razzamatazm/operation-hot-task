# Loancom — Context for Claude

This file is the entry point for any Claude session working in this repo. Read it first; it links to the rest.

## What this is

A web app for two octogenarian company owners to approve, deny, or negotiate loan-related requests submitted by ~8 loan officers and the servicing team. Today they handle every LOI approval, terms negotiation, valuation sign-off, funding approval, document redline, and committee question by email — items get buried, users keep resending to bubble things back to the top, and approvals frequently slip through the cracks.

The app gives owners a clean in-app feed. Clicking a request opens a split-pane: the document/email on the left, an Approve / Deny / Reply panel + the loan's running committee discussion on the right. Officers submit via web form, by forwarding email to a shared mailbox, or via an inbound API from the company's existing loan-origination backend.

## Locked product decisions

- **Quorum**: both owners must approve to close a request. Per-request override flag (`required_approvals: 1`) for scenarios that don't need both. Submitter is notified after the first approval.
- **Denial is not terminal.** A DENY does not end a request — there's always room to negotiate. APPROVE+DENY puts the request in `NEGOTIATING`. Owners can change their vote at any time before WITHDRAWN/CLOSED. The only terminal states are WITHDRAWN (submitter or admin closes) and CLOSED (auto/manual close after APPROVED).
- **Owners stay out of email.** No email notifications to owners — the whole point is to escape the inbox. Submitters get notifications (in-app SSE today; Microsoft Teams DM at deploy).
- **Mock auth for the demo, Microsoft Entra SSO at deploy.** A header-based mock-user selector toggles between seeded owners/officers locally; the production swap is one middleware change.
- **SQLite locally, Postgres on Azure at deploy.** Drizzle ORM is portable; the schema lives in `apps/server/src/db/schema.ts`. Local attachments → `apps/server/storage/`; production → Azure Blob behind the same `blob-storage.ts` interface.
- **Three intake paths, two stubbed for the demo.** Web form is fully implemented. The inbound integration API endpoint is real with API-key auth (no live caller yet). Email-in is exercised via `POST /api/dev/simulate-email` against fixtures; live Microsoft Graph subscription wires in at M4.

## Where we are

**M1 shipped** — scaffold, mock auth, DB + seed, minimal feed.
**M2 is next** — web submit form, PDF preview, vote casting with the negotiation flow, split-pane detail view.

See `docs/status.md` for the precise punch list and any open decisions blocking work.

## How to run

```bash
nvm use            # Node 22
npm install
cp .env.example .env
npm run dev        # API on :4000, SPA on :5173
```

Open http://localhost:5173. Default mock user is Hank Halloran (OWNER); flip the dropdown top-right to switch between Hank, Mort, and four officers (Avery, Brooke, Cal, Dee).

Other scripts:
- `npm run build` — full pipeline (shared → server → web).
- `npm run typecheck` — `tsc -b` across all workspaces. Cold-clean.
- `npm run test:smoke` — boots the server, hits `/health`/`/users`/`/feed`, asserts every expected status is derived from seeded votes.
- `npm run db:reset` — wipe `apps/server/data/loancom.db` and restart the server (re-seeds).

## Repo layout

```
loancom/
  CLAUDE.md                 you are here
  README.md                 user-facing readme
  docs/
    plan.md                 full milestone plan (M1-M4)
    status.md               current state + next steps + open decisions
    architecture.md         what's built and why
  apps/
    server/                 Express + Drizzle (SQLite) + SSE
    web/                    Vite + React + Tailwind
  packages/
    shared/                 types + workflow engine (computeStatus, etc.)
  scripts/                  smoke test + future demo scripts
```

## Conventions

- **TypeScript everywhere.** Strict mode on. ESM (`"type": "module"`). Node 22 LTS minimum.
- **Project references via `tsc -b`.** `packages/shared` has `composite: true`; `apps/server` references it. Typecheck and build both run `tsc -b` (incremental, dependency-aware). Don't switch back to `tsc -p` without thinking — cold typecheck breaks.
- **Drizzle, not Prisma.** Schema in `apps/server/src/db/schema.ts`. SQLite for the demo via `better-sqlite3`. The schema is deliberately portable to Postgres; treat enum constraints as text+CHECK so the migration is mechanical.
- **Tailwind + base layer for octogenarian-friendly UX.** 18px base font, ~13:1 contrast, 56px button minimum, 3px focus rings, no hover-only affordances. Defaults are in `apps/web/tailwind.config.ts` and `apps/web/src/styles.css`.
- **Workflow rules are a single source of truth.** `packages/shared/src/workflow.ts` owns `computeStatus(votes, requiredApprovals)`. The DB never stores a derived status; status is always recomputed from current `owner_votes` rows. Don't add a status column write path.
- **Vote supersession, not vote overwrite.** When an owner changes their vote, insert a new `owner_votes` row and stamp the prior row's `superseded_at`. The "current" vote is `WHERE superseded_at IS NULL`. Full history is preserved for the audit log.
- **Audit log everything user-visible.** Every state-affecting action writes to `audit_events`. The detail column is JSON.
- **Default to no comments.** Add a comment only when the *why* is non-obvious — a hidden constraint, a workaround for a specific bug, a surprising behavior. Don't restate what the code does.
- **No premature abstractions.** Three similar lines is better than a generic helper. Don't design for hypothetical future requirements.

## Two gotchas worth knowing

1. **Branch policy.** The harness running these Claude sessions historically had to push through `razzamatazm/operation-hot-task` (it staged `loancom/` as a subdirectory there) because the sandbox wasn't authorized to push to `razzamatazm/loancom`. If you're running in a session that has direct access to this repo, ignore that — push normally. If you hit "repository not authorized" on push, fall back to staging changes in operation-hot-task and copying back, but flag this to the user as something to address.
2. **Commit signing.** The same harness blocks signing commits for any repo besides operation-hot-task. If you hit `signing failed: missing source`, ask the user whether to bypass for that one commit (`-c commit.gpgsign=false`) or have them commit on their Mac. Never bypass without asking.

## When you're ready to write code

Read `docs/plan.md` and `docs/status.md` first. The plan is durable; status changes per milestone. Architecture is a tour of M1 — useful when extending it.

Then ask the user what they want to tackle. The default next move is M2; they may want to detour into UX polish, seed data tweaks, or a specific feature.
