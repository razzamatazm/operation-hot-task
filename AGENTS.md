# AGENTS.md

`Operation Hot Task` is an internal Microsoft Teams app where loan operations
staff create, claim, and complete short-lived tasks.

npm monorepo: `apps/web` (React + Vite Teams tab), `apps/server` (Express
API/scheduler/bot), `packages/shared` (workflow logic + types), `teams-app`
(Teams manifest/icons), `tools` (things that run outside the app — today the
Humperdink userscript).

## Commands

- `npm run dev` — all three workspaces
- `npm run dev:reset` — replace the local task store with ~a dozen seeded tasks,
  one per shape worth looking at (overdue, nagged, both merge rungs, the three
  live fraud phases, OOO, review, closed). Backs the old store up under
  `apps/server/data/backups/` first; leaves users, admin settings and bot
  references alone. `-- --keep` re-seeds without clearing what's there.
- `npm run build` — production-style build
- `npm run lint` — typecheck (`tsc --noEmit`); there is no ESLint
- `npm run check:import-cycles` — fail if `packages/shared` has a value-level
  import cycle. Type-only imports are ignored, since they erase at compile
  time. Runs in CI and inside `test:all`. Point it at another directory
  (`node scripts/assert-no-import-cycles.mjs apps/web/src`) to audit one; the
  guard itself only covers `shared`.
- `npm run test:all` — full sim/smoke suite (individual `test:*` scripts in
  the root `package.json`). The sim tests import compiled `dist`, so this
  rebuilds `shared` and `server` first (`npm run build:sim`). An individual
  `test:*` doesn't rebuild — it refuses to run against a stale build instead,
  and tells you to build.

First run needs `cp apps/server/.env.example apps/server/.env` and the same
for `apps/web`.

## Rules that apply to every task

- Change shared workflow and type logic in `packages/shared` before
  duplicating a rule in `apps/web` or `apps/server`.
- Teams, Graph, bot, and inbound-integration credentials are not configured
  locally. Never assume they are.
- These docs describe **current implementation**. Planned work lives only in
  [docs/product/target-direction.md](docs/product/target-direction.md) — don't
  present it as built.
- When the user confirms a product or workflow decision, record it in the
  relevant doc under `docs/product/` before moving on.
- Worktrees belong in `.claude/worktrees/`, named for the ticket where there is
  one. The reflex to avoid is `git worktree add ../oht-169`, which drops them
  beside the repo in `~/repos`, where they read as new projects.

## Where to look

| Topic | Doc |
|---|---|
| Product scope, rules, workflow, API surface | [docs/product/README.md](docs/product/README.md) |
| Design / UI reference for `apps/web` | [apps/web/CLAUDE.md](apps/web/CLAUDE.md) |
| Domain glossary | [CONTEXT.md](CONTEXT.md), [docs/adr/](docs/adr/) |
| Git workflow, branches, PRs | [docs/agents/git-workflow.md](docs/agents/git-workflow.md) |
| Code guardrails, cross-cutting change checklist | [docs/agents/code-guardrails.md](docs/agents/code-guardrails.md) |
| How to work in this repo (questions, decisions, doc upkeep) | [docs/agents/charter.md](docs/agents/charter.md) |
| Issues / PRDs, triage labels, domain-doc upkeep | [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md), [docs/agents/triage-labels.md](docs/agents/triage-labels.md), [docs/agents/domain.md](docs/agents/domain.md) |
| Azure deployment | [docs/AZURE_DEPLOYMENT.md](docs/AZURE_DEPLOYMENT.md) |
| Humperdink → create form userscript | [tools/humperdink/README.md](tools/humperdink/README.md) |
