# Operation Hot Task — Audit Overview

This document is a self-contained briefing for an external audit. It is designed to be read cold: no other files in the repository need to be opened to understand what the application does, who uses it, how it runs, where data lives, or what audit trails exist.

---

## 1. Purpose & Users

Operation Hot Task is an internal Microsoft Teams application used to coordinate loan-operations work. It replaces ad-hoc chat threads and spreadsheets with a structured task system that captures who asked for what, who picked it up, how long it took, and what was said along the way.

**Users (three roles):**

- **Loan Officer** — creates and claims most task types; cannot claim Fraud tasks.
- **File Checker** — superset of Loan Officer; also claims and completes Fraud tasks.
- **Admin** — may override claim, cancel, and status-transition rules in exceptional cases.

The user's role determines which tasks they may see actions on. Permission decisions are centralized in `packages/shared/src/workflow.ts` and applied identically on the client (button rendering) and server (request authorization).

---

## 2. Core Workflows

### Standard task lifecycle

`OPEN` → `CLAIMED` → `COMPLETED` → `ARCHIVED`

- A task starts `OPEN` when created.
- A qualified user **claims** it, transitioning to `CLAIMED` and recording themselves as assignee.
- The assignee marks it **complete**, transitioning to `COMPLETED`.
- After completion, the creator (or system) **archives** it.

### Review bounce-back

At any point an assignee or creator may move a task to `NEEDS_REVIEW`, attaching a review note. This puts the task back in the other party's court and surfaces it visually. From `NEEDS_REVIEW` the task can return to `CLAIMED` (continue work) or proceed to `COMPLETED`.

### Loan Docs extended path

Tasks of type `LOAN_DOCS` have two extra intermediate stages:

`OPEN` → `CLAIMED` → `MERGE_DONE` → `MERGE_APPROVED` → `COMPLETED` → `ARCHIVED`

`MERGE_DONE` indicates the assignee has completed the merge work and is awaiting creator approval. `MERGE_APPROVED` indicates the creator has approved and the task is ready to close.

### Out-of-Office (OOO) auto-completion

OOO tasks have no urgency level; instead they carry a return date. A scheduled job automatically transitions an active OOO task to `COMPLETED` at 8:30 AM Pacific on the user's return date and records the action in the task's history as `AUTO_COMPLETED_RETURN_DATE`.

### Reminders

A scheduler emits Teams direct-message reminders during business hours (8:30 AM – 5:30 PM Pacific) for overdue tasks and for tasks awaiting action. Each reminder updates `lastReminderAt` on the task to throttle repeats.

### Cancellation

The task creator may cancel a task at any non-terminal stage, moving it to `CANCELLED`. An admin may cancel on behalf of any user.

---

## 3. Domain Model

### Task types

| Type        | Notes field label | Notes                                     |
|-------------|-------------------|-------------------------------------------|
| `LOI`       | LOI Notes         | Letter of Intent review                   |
| `VALUE`     | Value Notes       | Property/loan value check                 |
| `FRAUD`     | Fraud Notes       | Fraud check; restricted to File Checkers  |
| `LOAN_DOCS` | Loan Docs Notes   | Loan documentation review (extended flow) |
| `OOO`       | OOO Notes         | Out-of-office coverage entry              |

### Statuses

`OPEN`, `CLAIMED`, `NEEDS_REVIEW`, `MERGE_DONE`, `MERGE_APPROVED`, `COMPLETED`, `CANCELLED`, `ARCHIVED`.

### Urgency

Non-OOO tasks carry one of four urgency levels:

| Level    | Meaning           |
|----------|-------------------|
| `GREEN`  | Within 24 hours   |
| `YELLOW` | End of day        |
| `ORANGE` | Within 1 hour     |
| `RED`    | Immediate         |

OOO tasks substitute a `returnDate` for urgency.

### Poop points

A numeric difficulty/credit score (1–5, default 1) attached to each task. Awarded to the assignee upon completion. Editable only by the creator while the task is open; immutable once completed.

### Identity fields on a task

`id`, `createdBy`, `assignee`, `taskType`, `status`, `urgency` or `returnDate`, `folderName`, `humperdinkLink` (optional), `notes`, `points`, `reviewNotes[]`, `history[]`, plus timestamps `createdAt`, `updatedAt`, `completedAt`, `archivedAt`, `cancelledAt`, `lastReminderAt`.

Type definitions live in `packages/shared/src/types.ts`.

---

## 4. Roles & Permissions

| Capability                        | Loan Officer        | File Checker | Admin |
|-----------------------------------|---------------------|--------------|-------|
| Create non-Fraud task             | Yes                 | Yes          | Yes   |
| Create Fraud task                 | Yes                 | Yes          | Yes   |
| Claim non-Fraud task              | Yes                 | Yes          | Yes   |
| Claim Fraud task                  | No                  | Yes          | Yes   |
| Complete claimed task             | If assignee         | If assignee  | Yes   |
| Approve Loan Docs merge           | If creator          | If creator   | Yes   |
| Cancel task                       | If creator          | If creator   | Yes   |
| Unclaim                           | If assignee         | If assignee  | Yes   |
| Re-open closed task               | If creator          | If creator   | Yes   |
| Override any of the above         | No                  | No           | Yes   |

All gates are enforced server-side regardless of UI state. The client uses the same predicates to render or hide action buttons. Source: `packages/shared/src/workflow.ts`.

---

## 5. Technical Stack & Runtime

| Layer       | Choice                                           |
|-------------|--------------------------------------------------|
| Runtime     | Node.js 24 (`engines: ">=24.0.0"`)               |
| Backend     | Express 4 + TypeScript 5.7 on port 4100 (host 127.0.0.1) |
| Frontend    | React 18 + Vite 6 + TypeScript (SPA)             |
| Real-time   | Server-Sent Events (SSE) on the same Express app |
| Teams       | `botbuilder` 4.23 (Bot Framework) for proactive DMs and reply handling |
| Repo layout | pnpm/npm workspaces: `apps/web`, `apps/server`, `packages/shared` |
| Build       | `tsc` + Vite; one Node process serves both the API/bot and the built SPA static files |

`packages/shared` contains the types and workflow predicates compiled and consumed by both web and server, guaranteeing the client and server agree on the data model and permission rules.

---

## 6. Data Storage & Retention

The application persists state to **flat JSON files** on the Web App's local disk:

| File                                          | Contents                                  |
|-----------------------------------------------|-------------------------------------------|
| `apps/server/data/tasks.json`                 | All tasks, including embedded history events and review notes |
| `apps/server/data/bot-references.json`        | Teams conversation references for proactive messaging |
| `apps/server/data/activity-feed-state.json`   | Cursor/state for Microsoft Graph activity-feed notifications |

There is **no relational database, no ORM, and no migration tooling**. Reads normalize legacy shapes (e.g. reconciling older `folderName`/`loanName`/`serverLocation` variants). Writes are promise-serialized to avoid interleaved file writes.

**Retention.** Tasks in `ARCHIVED` status older than `ARCHIVE_RETENTION_DAYS` (default **90 days**) are purged by the scheduler. Each task's `history[]` is retained for the life of the task; once the task is purged, the history is purged with it.

A swappable `TaskStore` abstraction in `apps/server/src/store.ts` makes it possible to substitute a managed database (e.g. Azure SQL) in the future without changing the service layer.

---

## 7. Authentication

### In production (Microsoft Teams)

User identity is established by the **Microsoft Bot Framework adapter**. The Teams client posts a signed JWT with every request from the Tab and bot; the server verifies it via the Bot Framework SDK using the configured `BOT_APP_ID`, `BOT_APP_PASSWORD`, and tenant. The validated identity (Azure AD object id, display name, tenant) is mapped to an internal user record and role set.

Optional **Microsoft Graph OAuth** (client-credentials flow with `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`) is used only to send activity-feed notifications on behalf of the app. This is an application-level token, not a user-impersonation token, and is gated by `ENABLE_ACTIVITY_FEED_NOTIFICATIONS`.

### In local development

Outside of Teams the server reads three mock headers (`x-user-id`, `x-user-name`, `x-user-roles`) to simulate a signed-in user. This path defaults to the `LOAN_OFFICER` role and is implemented in `apps/server/src/auth.ts`. It is intended for local development only; in deployed environments the Teams-issued JWT is required.

There is no password store, no local user database, and no shared API key for human users. An optional `INBOUND_API_KEY` exists for a future server-to-server inbound integration.

---

## 8. External Integrations

| System                       | Direction | Purpose                                                       |
|------------------------------|-----------|---------------------------------------------------------------|
| Microsoft Teams (Bot Framework) | Bidirectional | Hosts the Tab UI, signs in users, delivers proactive DMs    |
| Microsoft Graph API          | Outbound  | Sends activity-feed notifications (Bearer token, OAuth client-credentials) |
| Humperdink (external loan system) | Outbound | Optional reference URL on tasks; the app stores the link and renders it as an `↗` icon. URLs are scheme-allowlisted to `http`/`https` and normalized in `apps/server/src/validation.ts`. The app never reads from Humperdink. |

There are no other outbound API calls. There is no current inbound integration; `INBOUND_API_KEY` is reserved for a future phase.

---

## 9. Audit Trails

The audit story rests on three durable structures attached to every task.

### 9.1 Task history events (`history[]`)

Each task carries an append-only array of `TaskHistoryEvent` records. Every state-changing operation writes an event before the response returns to the client. Events cannot be edited or deleted via the API.

| Event type                        | When written                                           |
|-----------------------------------|--------------------------------------------------------|
| `TASK_CREATED`                    | Task creation                                          |
| `TASK_CLAIMED`                    | Assignee claims an open task                           |
| `TASK_UNCLAIMED`                  | Assignee or admin releases a claim                     |
| `TASK_STATUS_CHANGED`             | Any status transition (complete, review, cancel, etc.) |
| `TASK_POINTS_UPDATED`             | Creator changes the poop-points value pre-completion   |
| `REVIEW_NOTE_ADDED`               | A review note is appended (on `NEEDS_REVIEW` and elsewhere) |
| `AUTO_COMPLETED_RETURN_DATE`      | Scheduler auto-completes an OOO task on its return date |

Every event includes the actor's user id and display name, the UTC timestamp, the action type, and a free-form `detail` field describing the change (e.g. previous and new status).

Endpoint: `GET /api/tasks/:taskId/history`.

### 9.2 Review notes (`reviewNotes[]`)

Timestamped, attributed free-text comments that accompany `NEEDS_REVIEW` transitions and add-note actions in the expanded card. Each entry: author id, author name, UTC timestamp, body.

### 9.3 Lifecycle timestamps on the task

`createdAt`, `updatedAt`, `completedAt`, `archivedAt`, `cancelledAt`, `lastReminderAt` — set at the moment of the corresponding action and preserved for the life of the task.

Together these three structures let an auditor reconstruct, for any task that still exists in storage, the complete sequence of who-did-what-when, including system actions (auto-completion, reminders).

---

## 10. Hosting & Deployment

### Topology

A single **Azure Web App** (Linux, Node 24) hosts the entire application:

- `/api/*` — REST endpoints
- `/api/bot/messages` — Bot Framework inbound webhook
- `/api/health` — health check
- `/` — the built React SPA, served statically by the same Express process

There is no separate front-end CDN, no separate API host, and no Docker container; deployment is **zip-deploy of the current git `HEAD`**.

### Provisioning scripts

| Script                                            | Effect                                                                                                              |
|---------------------------------------------------|---------------------------------------------------------------------------------------------------------------------|
| `scripts/azure/provision-webapp.sh`               | Creates the resource group, Linux App Service plan, Web App; sets app settings; zip-deploys the current `HEAD`.     |
| `scripts/azure/create-identity-and-bot.sh`        | Creates (or reuses) Entra ID app registrations for the Teams Tab and the Bot; provisions an Azure Bot resource (F0 tier); generates a bot client secret; writes `BOT_APP_ID`, `BOT_APP_PASSWORD`, `BOT_TENANT_ID` into the Web App's app settings. |
| `scripts/azure/build-teams-package.sh`            | Produces `teams-app/operation-hot-task-teams.zip` (Teams manifest + icons) for upload through the Teams admin center. |

### Configuration (environment variables)

Set on the Web App by the provisioning scripts; documented in `apps/server/.env.example`:

| Variable                           | Purpose                                                          |
|------------------------------------|------------------------------------------------------------------|
| `PORT`, `HOST`                     | Listener (Azure overrides `PORT`)                                |
| `DATA_FILE`                        | Path to `tasks.json`                                             |
| `BOT_REFERENCES_FILE`              | Path to `bot-references.json`                                    |
| `FRONTEND_DIST`                    | Built SPA directory served by Express                            |
| `BUSINESS_TIMEZONE`                | Default `America/Los_Angeles`                                    |
| `BUSINESS_START_HOUR`, `BUSINESS_START_MINUTE`, `BUSINESS_END_HOUR`, `BUSINESS_END_MINUTE` | Reminder window |
| `ARCHIVE_RETENTION_DAYS`           | Archive purge horizon (default 90)                               |
| `TASKS_CHANNEL_NAME`, `TEAMS_CHANNEL_WEBHOOK_URL` | Teams channel routing                              |
| `ENABLE_DM_NOTIFICATIONS`          | Master toggle for Bot DMs                                        |
| `ENABLE_ACTIVITY_FEED_NOTIFICATIONS`, `ACTIVITY_FEED_STATE_FILE` | Graph activity-feed toggle and state |
| `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `GRAPH_BASE_URL`, `TEAMS_APP_ID` | Microsoft Graph credentials |
| `BOT_APP_ID`, `BOT_APP_PASSWORD`, `BOT_TENANT_ID` | Bot Framework credentials (written by the deploy script) |
| `INBOUND_API_KEY`                  | Reserved for a future inbound integration                        |

### Operational procedures

- **Redeploy code:** re-run `scripts/azure/provision-webapp.sh` (zip-deploys current `HEAD`).
- **Rotate bot secret:** re-run `scripts/azure/create-identity-and-bot.sh` (creates a new secret and writes it back to the Web App app settings).
- **Promote staging → prod:** vary `AZ_RESOURCE_GROUP`, `AZ_WEBAPP_NAME`, and `AZ_APP_PREFIX` per environment.
- **Health verification:** `curl https://<webapp>.azurewebsites.net/api/health` (expects HTTP 200).
- **Bot endpoint verification:** `curl -i https://<webapp>.azurewebsites.net/api/bot/messages` (expects 401/405 without a signed payload).

---

## 11. Continuous Integration & Testing

GitHub Actions (`.github/workflows/ci.yml`) runs on every push and pull request against Node 24 and gates merges on:

1. `lint` — TypeScript and ESLint
2. `build` — full TypeScript compile of `apps/web`, `apps/server`, and `packages/shared`
3. `test:all` — both test scripts below

The test suite uses **Node's native `assert`** module; there is no Jest or Vitest.

| Script                              | Coverage                                                                  |
|-------------------------------------|---------------------------------------------------------------------------|
| `scripts/smoke-test.mjs`            | End-to-end create / claim / transition / complete / archive flow against a running server, asserting status codes and persisted state. |
| `scripts/scheduler-sim-test.mjs`    | Simulates the time-driven scheduler: OOO auto-completion on the return date and archived-task purging beyond the retention window. |

There is no unit-level test framework; correctness of pure logic (e.g. permission predicates in `packages/shared/src/workflow.ts`) is exercised transitively through the smoke test.

---

## 12. Source-of-Truth File Map

For an auditor wishing to verify any claim in this document against the code:

| Concern                                       | File                                            |
|-----------------------------------------------|-------------------------------------------------|
| Product rules, permission matrix, notification routing | `AGENTS.md`                              |
| Type definitions (task, history event, review note, role, enums) | `packages/shared/src/types.ts`     |
| Permission / transition predicates            | `packages/shared/src/workflow.ts`               |
| Persistence layer (JSON store, history append) | `apps/server/src/store.ts`                     |
| State transitions and history-event emission  | `apps/server/src/task-service.ts`               |
| Scheduler (OOO auto-complete, archive purge, reminders) | `apps/server/src/scheduler.ts`        |
| Notification dispatch (DM / channel / activity feed) | `apps/server/src/notifications.ts`        |
| Teams Bot Framework adapter and proactive messaging | `apps/server/src/bot.ts`                   |
| Microsoft Graph activity-feed integration     | `apps/server/src/activity-feed.ts`              |
| Mock / dev auth headers                       | `apps/server/src/auth.ts`                       |
| Humperdink URL validation                     | `apps/server/src/validation.ts`                 |
| HTTP routes                                   | `apps/server/src/routes.ts`                     |
| SSE channel                                   | `apps/server/src/sse.ts`                        |
| Application bootstrap                         | `apps/server/src/index.ts`                      |
| CI pipeline                                   | `.github/workflows/ci.yml`                      |
| Environment contract                          | `apps/server/.env.example`                      |
| Teams app manifest                            | `teams-app/manifest.json`                       |
| Azure provisioning scripts                    | `scripts/azure/*.sh`                            |
| End-to-end smoke test                         | `scripts/smoke-test.mjs`                        |
| Scheduler simulation test                     | `scripts/scheduler-sim-test.mjs`                |
