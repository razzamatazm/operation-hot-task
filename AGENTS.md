# AGENTS.md

## Agent Charter
- This repo is for `Operation Hot Task`, an internal Microsoft Teams task app for loan operations.
- Treat this file as the working source of truth for agent behavior, confirmed product decisions, and current implementation state.
- Ask discovery questions one at a time when a change depends on business intent that is not already confirmed here.
- Do not make implementation-critical product assumptions when the answer is not already captured here.
- When the user confirms a new product or workflow decision, record it in this file in the appropriate section.
- Separate `current implementation` from `target direction`. Do not present planned architecture as if it already exists.

## Current Implementation Snapshot
Verified against the repo and local run on `2026-05-04`.

- Monorepo with:
  - `apps/web`: React + Vite Teams tab UI
  - `apps/server`: Express API, scheduler, SSE stream, Teams bot endpoint, notification plumbing
  - `packages/shared`: shared task types, workflow rules, due-date logic
  - `teams-app`: Teams manifest template and icon assets
- Local development uses:
  - Header-based mock auth fallback (prod uses Entra SSO)
  - JSON file persistence, not Azure SQL
  - Vite frontend on `http://localhost:5173`
  - Express backend on `http://127.0.0.1:4100`
- The app is functional locally without Teams credentials.
- Verified commands:
  - `npm run build`
  - `npm run test:scheduler`
  - `npm run test:smoke`
- Current data files:
  - Tasks/history: `apps/server/data/tasks.json`
  - Bot references: `apps/server/data/bot-references.json`
  - Activity feed state: `apps/server/data/activity-feed-state.json`

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

## Current UI Surfaces
- Header:
  - App title: `Operation Hot Task`
  - `New Task` toggle
  - Local user picker for mock identities
- Tabs:
  - `Active`
  - `Archived`
  - `Leaderboard`
  - `Metrics` for admin users only
- Active tab behavior:
  - Shows the current user’s active work
  - Shows claimable/open work when available
  - Shows recent activity as a compact expandable table
- Leaderboard tab:
  - Displays poop leaderboard
  - Supports `This Week` and `This Month`
- Metrics tab:
  - Admin-only
  - Includes claim volume, status totals, LOI-to-Loan-Docs conversion, and task-type breakdown
- Create-task form:
  - OOO relabels `Folder Name` to `Vacation Description`
  - Non-OOO tasks show urgency selector
  - OOO tasks show return-date selector
  - Poop points selector is always present as a 5-emoji picker
  - Humperdink Link is non-OOO only

## Current Auth And Identity Model
- **Production: Microsoft Entra SSO.** The Teams tab acquires a token
  (`authentication.getAuthToken()`); the server verifies it against the tenant
  JWKS in `auth.ts` (validates `iss` / `aud` / `tid`) and resolves the stable
  `oid`. Roles come from the file-based `users` table (`user-store.ts`), seeded
  via the onboarding flow and managed in the admin panel.
- **Local dev fallback only:** when SSO env is unset (plain browser, no Teams
  host), the server trusts `x-user-id` / `x-user-name` / `x-user-roles`
  headers. The web app sends these from a dev-only `DEV_USERS` list (in
  `apps/web/src/App.tsx`, tree-shaken from the prod bundle):
  - `Suzie`: loan officer
  - `Alexa`: loan officer + file checker
  - `Johanna`: loan officer + file checker + admin
- The `x-user-*` path is disabled whenever SSO is configured, so it can never
  be used on the internet-facing deploy.

## Product Scope
Core task types:
- LOI checks
- Buddy Chat
- Value checks
- Fraud checks
- Loan docs
- OOO (out of office coverage)

Primary goals:
- Create, claim, complete, and archive tasks
- Track in-progress and completed work
- Show urgency with stoplight-style visuals
- Send real-time updates and overdue reminders

## Confirmed Product Decisions

### Teams Surface
- Teams surface: Tab + Bot
- Teams app display name: `Operation Hot Task`
- App icons use paper-on-fire concept with color and outline variants

### Roles And Permissions
- Roles:
  - Loan officers
  - File checkers
  - Admins
- File checkers are a subset of loan officers
- Only file checkers can claim and complete Fraud Check tasks
- `Cancelled` can be set by task creator or admin
- `Claimed -> Needs Review` can be done by assignee or creator
- `Needs Review -> Claimed` and `Needs Review -> Completed` do not require admin

### Admin Panel (Users & Roles)
- Admin-only `Admin` tab (next to Metrics) manages the `users` table
- Per-user role toggles (`LOAN_OFFICER` / `FILE_CHECKER` / `ADMIN`) via
  `PUT /api/users/:id/roles`
- Lifecycle: add a user by email (resolved through Microsoft Graph) via
  `POST /api/users`; deactivate / reactivate via `PATCH /api/users/:id`;
  permanently remove via `DELETE /api/users/:id`
- Deactivated users keep their record + roles but are blocked at auth (403)
- Guards: cannot deactivate/remove yourself; cannot remove or demote the
  last active admin
- Newly auto-created users (default `LOAN_OFFICER`, never edited) are
  flagged in the panel so admins can promote them

### Create Task Fields
- Required fields:
  - Folder Name
  - Task Type: `LOI`, `Buddy Chat`, `Value`, `Fraud`, `Loan Docs`, `OOO`
  - Poop points: `1`-`5`, default `1`
  - Timing:
    - Non-OOO: urgency
    - OOO: return date in `YYYY-MM-DD`, PT
  - Notes
- Optional fields:
  - Non-OOO only: Humperdink Link
- Folder Name is the canonical task name
- There is no separate file name field
- OOO UI wording:
  - Folder Name label becomes `Vacation Description`
- Notes label by task type:
  - LOI: `Loan Terms and Contacts`
  - Buddy Chat: `Concerns`
  - Fraud: `Outstanding Items and Notes`
  - Value / Loan Docs / OOO: `Notes`

### Status Model
- General statuses:
  - `Open`
  - `Claimed`
  - `Needs Review`
  - `Cancelled`
  - `Completed`
  - `Archived`
- Loan Docs lifecycle:
  - `Open -> Claimed -> Merge Done -> Merge Approved -> Completed -> Archived`

### Claiming Rules
- Claiming is first-come-first-serve
- Unclaim is allowed
- Claim tasks section is hidden when there are no claimable tasks

### Poop Points Rules
- Stored field remains numeric `points`
- User-facing points name is `Poops`
- All task types, including OOO, use poop points
- Poop points are awarded on completion
- Task cards show per-task points as `1`-`5` repeated poop emojis
- The create-task form uses a 5-emoji left-to-right picker:
  - Inactive slots are monochrome poop emoji styling
  - Active slots are full-color poop emojis
- Poop points are only set at task creation time
- Poop points cannot be edited after a task is created
- Legacy tasks missing points are backfilled to `1`

### Due Date And Urgency
- Due date is tracked backend-only
- Due date is not shown in user-facing UI as a dedicated field
- Default urgency for all non-OOO task types is `Green`
- Urgency meanings:
  - `Green`: due in 24 real hours from creation; if the due time lands on a weekend, roll to Monday
  - `Yellow`: needed by end of business day
  - `Orange`: needed within 1 hour
  - `Red`: urgent now
- User-facing urgency labels use timeframe wording:
  - `Within 24 Hours`
  - `End of Day`
  - `Within 1 Hour`
  - `Urgent Now`
- Color is visual styling only

### OOO Rules
- OOO is a first-class task type
- OOO uses return date instead of urgency input
- Return date is date-only and interpreted in `America/Los_Angeles`
- OOO `dueAt` is computed as `8:30 AM PT` on the return date
- OOO return date must resolve to a future due time
- OOO auto-completes from active statuses when the return due time is reached
- OOO uses existing people model:
  - Creator = out-of-office person
  - Assignee = covering person when claimed
- OOO keeps standard claim/unclaim flow using `Open` and `Claimed`

### Leaderboard
- `Leaderboard` tab is visible to all users
- Time windows:
  - `This Week`
  - `This Month`
- Week starts Monday at `12:00 AM` PT
- Scoring uses `completedAt` in PT
- Tasks counted are in current status `Completed` or `Archived`
- Tie-breakers:
  - Higher points
  - Higher completed task count
  - Display name ascending
- Show all users with non-zero points in selected period
- Reopened tasks are recalculated from current state; there is no immutable score ledger in v1

### Front Page Recent Activity
- Active tab includes bottom-section recent activity
- Show the most recent `30` tasks
- Ordering:
  - Active statuses first: `Open`, `Claimed`, `Needs Review`, `Merge Done`, `Merge Approved`
  - Closed statuses second: `Completed`, `Cancelled`, `Archived`
  - Within each group: newest `createdAt` first
- Table columns:
  - Task Name
  - Status
  - Type
  - Creator
  - Assignee
  - Date Created
  - Date Completed
- Clicking a row expands an inline detailed task view beneath that row
- `Date Completed` shows `—` when `completedAt` is missing

### Notifications
- Notification channels:
  - In-app notifications
  - Teams bot direct messages
  - Teams bot channel posts
  - Teams activity feed notifications
- Dedicated Tasks channel is the channel-post target
- Routing:
  - New task created: channel broadcast plus in-app event
  - Task claimed/unclaimed: channel update; claimer gets DM on claim
  - `Merge Done` and `Completed`: DM task creator
  - `Merge Approved`: DM task assignee
  - Notes: DM counterpart user
  - Reminders: DM assignee, except `Loan Docs` in `Merge Done` where reminder DM goes to creator
- Bot v1 scope:
  - Notifications/reminders
  - Quick add via `/bot new`
- Bot quick add flow:
  - Ask Folder Name
  - Ask task type
  - Ask urgency for non-OOO
  - Ask return date for OOO
  - Ask Poops
  - Ask notes
  - Ask Humperdink Link for non-OOO
  - Show final review with field-level edits
  - Show explicit final create confirmation
  - Support `/bot back`

### Activity Feed
- Left-rail icon dot is not used
- Teams activity feed is used instead
- Activity type is `systemDefault` for v1
- Activity feed alerts trigger on:
  - State change
  - Hourly reminder cadence during business hours
- Bounce-back condition is `Needs Review`
- Pickup scope is tasks claimable by the user
- Due condition is overdue-only

### Overdue Reminders And Retention
- Reminder cadence: every 1 hour
- Reminders only during business hours
- Business hours:
  - `8:30 AM` to `5:30 PM`
  - `America/Los_Angeles`
- Stop reminders when status is:
  - `Completed`
  - `Archived`
  - `Cancelled`
- Archived tasks are retained for `3 months`

### Integrations And Hosting
- v1 is standalone with no LOS/CRM integration
- Planned phase 2:
  - In-house web app can create tasks through API/button click
- Hosting direction:
  - Local-first implementation
  - Azure-ready deployment target

## Current Backend Surface
- Health:
  - `GET /api/health`
- Tasks:
  - `GET /api/tasks`
  - `POST /api/tasks`
  - `GET /api/tasks/:taskId`
  - `GET /api/tasks/:taskId/history`
  - `POST /api/tasks/:taskId/claim`
  - `POST /api/tasks/:taskId/unclaim`
  - `POST /api/tasks/:taskId/transition`
  - `POST /api/tasks/:taskId/points`
  - `POST /api/tasks/:taskId/review-note`
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
- Scheduler runs every 5 minutes and handles reminders, OOO auto-complete, auto-archive, and archive purge.
- Persistence is file-backed through `TaskStore`.
- Shared workflow logic lives in `packages/shared` and should remain the canonical place for status rules, due-date logic, and permission helpers.

## Target Direction
- Microsoft Teams app with:
  - Tab for task management UI
  - Bot for notifications/reminders
- Microsoft Entra ID SSO for identity
- Backend API + scheduler on Azure
- Relational DB, expected Azure SQL, for task state and audit history

## Implementation Guardrails For Agents
- Prefer changing shared workflow and type logic in `packages/shared` before duplicating rules in `apps/web` or `apps/server`.
- When changing product rules, update:
  - shared types/workflow
  - server validation and service logic
  - web UI labels and affordances
  - this file if the decision is confirmed
- Do not assume Teams credentials, Graph credentials, bot credentials, or inbound integration auth are configured locally.
- Preserve compatibility aliases only when necessary:
  - `loanName`
  - `serverLocation`
- Distinguish local mock-auth behavior from production identity direction in user-facing explanations.

## Open Questions Queue
- None currently.
