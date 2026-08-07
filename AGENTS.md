# AGENTS.md

`Operation Hot Task` is an internal Microsoft Teams task app for loan
operations. Monorepo: `apps/web` (React + Vite Teams tab), `apps/server`
(Express API/scheduler/bot), `packages/shared` (shared workflow logic),
`teams-app` (Teams manifest/icons). Package manager is npm.

## Agent Charter

- Treat this file and its linked docs as the working source of truth for
  agent behavior, confirmed product decisions, and current implementation
  state.
- Ask discovery questions one at a time when a change depends on business
  intent that is not already confirmed in these docs.
- Do not make implementation-critical product assumptions when the answer
  isn't already captured here.
- When the user confirms a new product or workflow decision, record it in
  the relevant doc below (or here, for something that touches every task).
- Separate `current implementation` from `target direction`
  ([target-direction.md](docs/product/target-direction.md)). Do not present
  planned architecture as if it already exists.

## Repo Runbook

- Install: `npm install`
- Local env setup:
  - `cp apps/server/.env.example apps/server/.env`
  - `cp apps/web/.env.example apps/web/.env`
- Start local dev: `npm run dev`
- Production-style build: `npm run build`
- Main validation commands:
  - `npm run test:scheduler`
  - `npm run test:smoke`
  - `npm run test:all`

## Product Scope

Core task types: LOI checks, Buddy Chat, Value checks, Fraud checks, Loan
docs, OOO (out of office coverage).

Primary goals: create, claim, complete, and archive tasks; track in-progress
and completed work; show urgency with stoplight-style visuals; send
real-time updates and overdue reminders.

## Where To Look

Current implementation, by area:

- [Implementation snapshot + backend API surface + architecture notes](docs/product/implementation-snapshot.md)
- [UI surfaces (tabs, header, recent activity)](docs/product/ui.md)
- [Auth and identity model](docs/product/auth-identity.md)
- [Roles, permissions, and the admin panel](docs/product/roles-permissions.md)
- [Create-task fields](docs/product/task-fields.md)
- [Status model, reopen/restore](docs/product/status-model.md)
- [Fraud two-phase workflow](docs/product/fraud-workflow.md)
- [Claiming, poop points, leaderboard](docs/product/claiming-scoring.md)
- [Due date and urgency](docs/product/due-date-urgency.md)
- [OOO rules](docs/product/ooo.md)
- [Notifications, bot, activity feed](docs/product/notifications-bot.md)
- [Overdue reminders and retention](docs/product/reminders-retention.md)
- [Integrations and hosting](docs/product/integrations-hosting.md)
- [Target direction (not yet built)](docs/product/target-direction.md)

Design/UI reference: [apps/web/CLAUDE.md](apps/web/CLAUDE.md).
Domain glossary and ADRs: [CONTEXT.md](CONTEXT.md), [docs/adr/](docs/adr/).

## Implementation Guardrails For Agents

- Prefer changing shared workflow and type logic in `packages/shared` before
  duplicating rules in `apps/web` or `apps/server`.
- When changing product rules, update: shared types/workflow, server
  validation and service logic, web UI labels and affordances, and the
  relevant doc under `docs/product/` if the decision is confirmed.
- Do not assume Teams credentials, Graph credentials, bot credentials, or
  inbound integration auth are configured locally.
- Preserve compatibility aliases only when necessary: `loanName`,
  `serverLocation`.

## Open Questions Queue

- None currently.
