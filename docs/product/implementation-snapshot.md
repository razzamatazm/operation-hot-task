# Current Implementation Snapshot

Verified against the repo and local run on `2026-05-04`.

- Monorepo with:
  - `apps/web`: React + Vite Teams tab UI
  - `apps/server`: Express API, scheduler, SSE stream, Teams bot endpoint, notification plumbing
    - Task-mutating routes respond as soon as the store write and the SSE
      broadcast are done; notification fan-out and activity-signal evaluation
      run after the response, chained per task (#119). See
      [notifications-bot.md](notifications-bot.md#delivery-timing).
  - `packages/shared`: shared task types, workflow rules, due-date logic
  - `teams-app`: Teams manifest template and icon assets
- Local development uses:
  - Header-based mock auth fallback (prod uses Entra SSO)
  - JSON file persistence, not Azure SQL
  - Vite frontend on `http://localhost:5173`
  - Express backend on `http://127.0.0.1:4100`
- The app is functional locally without Teams credentials.
- Current data files:
  - Tasks/history: `apps/server/data/tasks.json`
  - Loans: `apps/server/data/loans.json` (ADR-0001; created on first boot)
  - Bot references: `apps/server/data/bot-references.json`
  - Bot task threads (root message ids for threading): `apps/server/data/bot-task-threads.json`
  - Activity feed state: `apps/server/data/activity-feed-state.json`
  - Admin settings (selected notification channel): `apps/server/data/admin-settings.json`

See [AGENTS.md](../../AGENTS.md) for validation commands.

## Current Backend Surface

- Health:
  - `GET /api/health`
- Client config:
  - `GET /api/config` → `{ teamsAppId: string | null }`. Unauthenticated
    runtime config the web app fetches on boot so it can build the same Teams
    deep link the bot does (`TEAMS_APP_ID` is server-only env). Deliberately
    not part of `/me`, which stays about identity.
- Loans (ADR-0001):
  - `GET /api/loans` (list; `?q=` fuzzy search for the create-form typeahead)
  - `POST /api/loans` (create; dedupes by canonical link / normalized name)
  - `GET /api/loans/:loanId`
  - `PATCH /api/loans/:loanId` (edit name/link; propagates to linked tasks;
    auto-merges on a shared Humperdink link)
- Tasks:
  - `GET /api/tasks`
  - `POST /api/tasks` (non-OOO: links/creates a Loan via `loanId` or
    `folderName`; `folderName`/`humperdinkLink` are a live cache of the Loan)
  - `GET /api/tasks/:taskId`
  - `GET /api/tasks/:taskId/history`
  - `POST /api/tasks/:taskId/claim`
  - `POST /api/tasks/:taskId/unclaim`
  - `POST /api/tasks/:taskId/release` (FRAUD: release a `Pending Approval` task
    back to the checker pool — the creator only; reposts a claimable card to
    the channel)
  - `POST /api/tasks/:taskId/assign` — Handoff (see
    [ADR-0002](../adr/0002-task-handoff.md)): set `assignee` to someone else.
    Body `{ assigneeUserId, note? }` (note ≤ 280). Any authenticated user may
    call it; eligibility is checked on the **recipient** (a Fraud Check only
    goes to a `FILE_CHECKER`). `OPEN` → `CLAIMED`; an in-flight task swaps
    assignee with its status unchanged; closed tasks are rejected; handing a
    task to its current assignee is rejected, and so is handing a task to
    yourself (#208). A task can also be born handed off via `assigneeUserId` /
    `assigneeNote` on `POST /api/tasks`.
  - `POST /api/tasks/:taskId/return-to-pool` — the creator puts a `CLAIMED` task
    back in the pool: `OPEN`, unassigned, re-posted to the channel (#208).
  - `POST /api/tasks/:taskId/transition`
  - `POST /api/tasks/:taskId/points`
  - `POST /api/tasks/:taskId/notes` — amend the task's notes. Body `{ notes }`.
    Creator only, active statuses only (ADR-0006). Silent: no DM, no channel
    post; the existing DM cards are re-rendered in place.
  - `POST /api/tasks/:taskId/urgency` — amend the task's urgency. Body
    `{ urgency }`; `dueAt` is re-derived server-side from the new band and the
    last-reminder stamp is cleared. Creator only, active statuses only, and
    rejected outright on an `OOO` task. DMs the assignee when there is one; no
    channel post. **There is no route that accepts a `dueAt`.**
  - `POST /api/tasks/:taskId/review-note` (active tasks only — blocked once closed)
  - `POST /api/tasks/:taskId/completed-note` (append a note to a COMPLETED task
    without reopening it — creator/assignee; the card's "Add a note"
    affordance)
  - FRAUD structured checklist (#44, gated deletion #66) — focused, atomic
    endpoints, each server-enforcing the two permission rules + gated-deletion /
    checked-stale invariants:
    - `POST /api/tasks/:taskId/checklist/items` (add an item)
    - `DELETE /api/tasks/:taskId/checklist/items/:itemId` (delete your own fresh,
      not-yet-handed-off item — gated by `canDeleteChecklistItem`)
    - `POST /api/tasks/:taskId/checklist/items/:itemId/text` (edit text →
      uncheck + stale; gated by `canEditChecklistItemText`)
    - `POST /api/tasks/:taskId/checklist/items/:itemId/checked` (toggle resolved,
      optional per-item note in the actor's own field)
    - `POST /api/tasks/:taskId/checklist/items/:itemId/note` — the ONE note
      endpoint (#144). The field it writes (`note` / `checkerNote`) is derived
      from the actor's seat, never named in the payload; the separate
      `/checker-note` endpoint is gone, because letting the client pick the URL
      let it pick whose name the note carried.
    Creator-seeded items ride the create payload (`POST /api/tasks`
    `initialItems`, #69); submit / approve / bounce-back ride the existing
    `/transition` endpoint (the pass counter bumps there).
- Integration:
  - `POST /api/integrations/tasks` with `x-api-key` when enabled
- Streaming:
  - `GET /api/stream`
- Bot:
  - `POST /api/bot/messages`

## Current Architecture Notes

- The server currently serves API traffic only in dev; Vite serves the UI separately.
- The server can serve built frontend assets when `apps/web/dist/index.html` exists at the configured path for the running process.
- Real-time UI updates are delivered through SSE.
- Scheduler runs every 5 minutes and handles reminders, the pool nag (#207), OOO auto-complete, auto-archive, and archive purge.
- Persistence is file-backed through `TaskStore`. Any write that CHANGES an
  existing task goes through `TaskStore.updateTask(id, apply)`, which does the
  read and the write in one queue slot and hands `apply` the task as it is at
  write time. Building a replacement from a task read earlier is how two people
  editing the same fraud check silently erased each other (#158); only creation,
  which has no prior read, still calls `upsertTask` directly.
- Shared workflow logic lives in `packages/shared` and should remain the canonical place for status rules, due-date logic, and permission helpers.
