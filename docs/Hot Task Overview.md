# Operation Hot Task — Audit Overview

This document is a self-contained briefing for an external audit. It is designed to be read cold: no other files in the repository need to be opened to understand what the application does, who uses it, how it runs, where data lives, or what audit trails exist. Every claim was checked against the code at commit `4711dd6`; section 12 maps each topic to its source file.

---

## 1. Purpose & Users

Operation Hot Task is an internal Microsoft Teams application used to coordinate loan-operations work. It replaces ad-hoc chat threads and spreadsheets with a structured task system that captures who asked for what, who picked it up, how long it took, and what was said along the way. It runs as a Teams tab plus a bot that posts cards to a channel and to people's DMs.

**Users (three roles):**

- **Loan Officer** — files and works every task type except Fraud Checks, which they can file but not work.
- **File Checker** — superset of Loan Officer; also claims, works and approves Fraud Checks.
- **Admin** — manages users, roles and the notification channel, and sees the Metrics tab. Admin adds no power over anyone else's work, with one exception: an admin can **Change Task Owner** on any live, non-OOO task. An admin who also files or works tasks does so under the same rules as everyone else (ADR-0003).

Roles are stored in the app's own user list (`users.json`), not in the Teams sign-in token. Deactivating a user, or removing their File Checker role, releases any live Fraud Checks they hold back to the pool.

Permission rules are centralized in `packages/shared/src/workflow.ts` and used by both the client (to show or hide buttons) and the server (to accept or refuse requests). The few rules enforced only in the client are listed in §4.

---

## 2. Core Workflows

### Standard task lifecycle

`OPEN` → `CLAIMED` → `COMPLETED` → `ARCHIVED`

- A task starts `OPEN` when filed, or `CLAIMED` if the filer hands it straight to someone.
- A qualified user **claims** it, transitioning to `CLAIMED` and recording themselves as assignee. The person who filed a task can never be its assignee (ADR-0003).
- The assignee marks it **complete**, transitioning to `COMPLETED`.
- The creator archives it, or the system archives it automatically 14 days after it completed or was cancelled.

### Deadlines

Each task has a `dueAt` derived from its urgency (§3). The clock starts when the task is **claimed**, not when it is filed, so time spent waiting in the pool is never charged to whoever picks it up (ADR-0005). A claim outside business hours is anchored to the next business open. Business hours are 8:30 AM – 5:30 PM Pacific, Monday to Thursday, and 8:30 AM – 3:30 PM on Friday.

### LOI corrections loop

On an LOI Check the assignee presses **Checked**, then either **Good to go** (completes the task) or **Needs fixes**, which requires a note and moves the task to `NEEDS_REVIEW` (displayed as "Needs corrections"). The creator then presses **LOI Fixed**, then either **No Review Needed** (completes it) or **Send Back For Review** (returns it to `CLAIMED`). When the checker confirms after corrections, one press completes *and* archives the task (ADR-0007). No other task type has the `NEEDS_REVIEW` state.

### Loan Docs extended path

`OPEN` → `CLAIMED` → `MERGE_DONE` → `MERGE_APPROVED` → `COMPLETED` → `ARCHIVED`

The assignee marks **Merge Done** (and can undo it back to `CLAIMED`). The creator **approves the merge**. The assignee then **completes** the task.

### Fraud Check two-phase path

`OPEN` → `CLAIMED` → `AWAITING_ITEMS` → `PENDING_APPROVAL` → `COMPLETED` → `ARCHIVED`

- The checker (a File Checker) builds an **Outstanding items** checklist and presses **Send Items** (`AWAITING_ITEMS`). The deadline clock pauses while the task waits on the requester.
- The requester ticks each item or adds a note explaining it, then presses **Submit** (`PENDING_APPROVAL`). Submit is refused until every item is ticked or has a note.
- The checker **Approves** (`COMPLETED`) or **Sends Back** (`AWAITING_ITEMS` again; a pass counter records each round).
- While the task awaits approval, the requester can **Release for any fraud checker**, which clears the assignee so any File Checker can pick it up.

### Out-of-Office (OOO)

OOO tasks carry a **start date** and a **return date** instead of a visible urgency (they store `GREEN` internally). A five-minute maintenance sweep completes any live OOO task once its return date reaches 8:30 AM Pacific, writing a `TASK_COMPLETED` history row with the detail `AUTO_COMPLETED_RETURN_DATE` by the system actor. The creator or the person covering can **End task** early. OOO tasks have no Complete button, are never overdue, are never re-posted to the channel, and cannot have their owner changed.

### Reminders and the pool nag

Two separate system signals run during business hours:

- **Overdue reminder:** a Teams DM to the assignee (or to the creator when a Loan Docs task sits at `MERGE_DONE`) when a task passes its `dueAt`, at most once an hour. It stamps `lastReminderAt` on the task.
- **Pool nag:** a task that stays unclaimed for 20 business minutes is re-posted to the team **channel**, every 20 business minutes, up to six times or until someone claims it. It stamps `lastPoolNagAt` and increments `poolNagCount`.

Neither signal writes a history row. When activity-feed notifications are enabled, the app also sends Teams activity-feed notices for tasks that become claimable, go overdue, or need corrections.

### Handoffs and cancellation

- **Assign / Reassign:** any signed-in user can hand a live task to someone eligible to work it, other than themselves and other than its creator.
- **Unclaim:** the assignee releases their own claim.
- **Back to the pool:** the creator takes a `CLAIMED` task off its assignee so anyone can claim it.
- **Change Task Owner:** the creator, the assignee, or an admin moves the requester side to someone else (not on OOO tasks).
- **Cancel:** only the creator can cancel, at any non-terminal stage, moving the task to `CANCELLED`. A cancelled task cannot be reopened.
- **Re-open / Restore:** a `COMPLETED` or `ARCHIVED` task can be reopened (to `CLAIMED` if it still has an assignee, otherwise `OPEN`); **Restore** sends a reopened task straight back to its previous closed state.

---

## 3. Domain Model

### Loans

Tasks point at a shared **Loan** record (ADR-0001) holding the loan's name and optional Humperdink link. The canonical Humperdink link is unique per loan, so links to different tabs of the same loan resolve to one record. Renaming a loan or changing its link updates every task on it. Each task keeps a cached copy of the loan name in `folderName`.

### Task types

Every task except a Fraud Check carries one required free-text **Instructions** field where the person filing it says what the task is for. Its heading is per type and comes from one table (`NOTES_FIELD_LABELS`), read by the card, both forms and the bot — see [task-fields.md](product/task-fields.md). A Fraud Check needs either a note or at least one outstanding item.

| Type          | Display name   | Instructions heading      | Notes                                       |
|---------------|----------------|---------------------------|---------------------------------------------|
| `LOI`         | LOI Check      | `Loan Terms and Contacts` | Letter of Intent check; corrections loop    |
| `BUDDY_CHAT`  | Buddy Chat     | `Concerns`                | Second pair of eyes on a file               |
| `VALUE`       | Value Check    | `Things to Look Out For`  | Property/loan value check                   |
| `FRAUD`       | Fraud Check    | `Notes`                   | Two-phase checklist; worked by File Checkers |
| `LOAN_DOCS`   | Loan Docs      | `Extras and Edits`        | Document merge and generation (extended flow) |
| `OOO`         | Out of Office  | `Coverage Notes`          | Out-of-office coverage entry                |

### Statuses

`OPEN`, `CLAIMED`, `NEEDS_REVIEW`, `MERGE_DONE`, `MERGE_APPROVED`, `AWAITING_ITEMS`, `PENDING_APPROVAL`, `COMPLETED`, `CANCELLED`, `ARCHIVED`.

### Urgency

Non-OOO tasks carry one of four urgency levels. The deadline is computed from the moment the task is claimed (§2).

| Level    | Display name     | Deadline once claimed                                        |
|----------|------------------|--------------------------------------------------------------|
| `GREEN`  | Within 24 Hours  | 24 hours later, moved to Monday if it lands on a weekend     |
| `YELLOW` | End of Day       | Close of that business day                                   |
| `ORANGE` | Within 1 Hour    | One hour later, capped at that day's close                   |
| `RED`    | Urgent Now       | 15 minutes later                                             |

`GREEN` is the default.

### Poops (difficulty rating)

A whole number from 0 to 5 (default 0) set by the person filing the task, shown as poop icons so teammates can judge how heavy a task is before claiming it. The creator can change it until the task closes. It is a rating only: nothing awards it to the assignee, and the Metrics leaderboard counts claims, not poops.

### Fields on a task

Core: `id`, `taskType`, `status`, `urgency`, `dueAt`, `loanId`, `folderName` (cached loan name), `notes` (the Instructions), `points`, `createdBy`, `assignee`, `reviewNotes[]` (the conversation; see §9.2).

Type-specific: `startDate` and `returnDate` (OOO); `checklist`, `checklistPass` and `awaitingItemsSince` (Fraud); `awaitingConfirmationFrom` (marks an LOI sent back for a confirming look).

Bookkeeping: `createdAt`, `updatedAt`, `completedAt`, `archivedAt`, `cancelledAt`, `lastReminderAt`, `pooledSince`, `lastPoolNagAt`, `poolNagCount`, `reopenedFrom`, `requesterChange`, `raisedBy`, `createKey` (makes a retried create idempotent).

History events are stored separately from the task (§9.1). Type definitions live in `packages/shared/src/types.ts`.

---

## 4. Roles & Permissions

"Creator" and "assignee" are relationships to one task, not roles. A task's creator is never its assignee (ADR-0003).

| Capability                                      | Who                                                         |
|-------------------------------------------------|-------------------------------------------------------------|
| File a task (any type)                          | Any user                                                    |
| Claim, or be assigned, a non-Fraud task         | Any user except the task's creator                          |
| Claim, or be assigned, a Fraud Check            | File Checkers only, except the task's creator               |
| Assign / Reassign                               | Any user                                                    |
| Share (DM someone about a task)                 | Any user                                                    |
| Complete                                        | Assignee (creator from `NEEDS_REVIEW`; File Checker for Fraud; no Complete on OOO) |
| Checked / Needs fixes (LOI)                     | Assignee                                                    |
| LOI Fixed / Send Back For Review (LOI)          | Creator                                                     |
| Merge Done / Undo Merge Done (Loan Docs)        | Assignee                                                    |
| Approve Merge (Loan Docs)                       | Creator                                                     |
| Send Items / Approve / Send Back (Fraud)        | Assignee (File Checker)                                     |
| Submit / Release for any fraud checker (Fraud)  | Creator                                                     |
| End OOO early                                   | Creator or the person covering                              |
| Unclaim                                         | Assignee, while `CLAIMED`                                   |
| Back to the pool                                | Creator, while `CLAIMED`                                    |
| Change Task Owner                               | Creator, assignee or admin; not OOO; not once closed        |
| Edit Instructions, urgency, dates, poops        | Creator, until the task closes; LOI terms by creator or assignee |
| Add a note to the conversation                  | Creator or assignee                                         |
| Edit or delete a message                        | Its author                                                  |
| Cancel                                          | Creator                                                     |
| Restore a reopened task                         | Creator or assignee                                         |
| Archive                                         | Creator in the UI; **not checked by the server** (see below) |
| Re-open                                         | Creator or assignee in the UI; **not checked by the server** |
| Manage users, roles and notification channel    | Admin                                                       |
| See the Metrics tab                             | Admin (UI only; see below)                                  |

**Gates enforced only in the client.** The server checks every row above except three:

- **Archive:** the server accepts a move to `ARCHIVED` from any signed-in user.
- **Re-open:** the server accepts a move back to `OPEN` from any signed-in user.
- **Metrics:** the tab is hidden from non-admins, but the data behind it (`GET /api/tasks`) is returned to every user, since the task board is team-wide by design.

The system actor (the scheduler) bypasses actor checks. Source: `packages/shared/src/workflow.ts`.

---

## 5. Technical Stack & Runtime

| Layer       | Choice                                           |
|-------------|--------------------------------------------------|
| Runtime     | Node.js 24 (`engines: ">=24.0.0"`)               |
| Backend     | Express 4 + TypeScript 5.9 on port 4100 (host 127.0.0.1) |
| Frontend    | React 18 + Vite 6 + TypeScript (SPA), `@microsoft/teams-js` 2 |
| Real-time   | Server-Sent Events (SSE) on the same Express app; the client first obtains a one-time, 60-second stream ticket, because `EventSource` cannot send a bearer token |
| Teams       | `botbuilder` 4.23 (Bot Framework) for channel cards, DM cards, card actions and replies |
| Repo layout | npm workspaces: `apps/web`, `apps/server`, `packages/shared` |
| Build       | `tsc` + Vite; one Node process serves both the API/bot and the built SPA static files |

`packages/shared` contains the types and workflow rules compiled and consumed by both web and server, so the client and server agree on the data model and permission rules.

---

## 6. Data Storage & Retention

The application persists state to **flat JSON files** on the Web App's local disk, under `apps/server/data/` by default:

| File                         | Contents                                                        |
|------------------------------|-----------------------------------------------------------------|
| `tasks.json`                 | All tasks, plus a separate top-level array of history events    |
| `loans.json`                 | Loan records (name, canonical Humperdink link)                  |
| `users.json`                 | Users, roles and active/deactivated state                       |
| `admin-settings.json`        | Which Teams channel notifications go to                         |
| `saved-for-later.json`       | Each user's private saved drafts and New Task autosave (ADR-0011) |
| `bot-references.json`        | Teams conversation references for proactive messaging           |
| `bot-task-threads.json`      | Which posted Teams cards belong to which task                   |
| `activity-feed-state.json`   | State for Microsoft Graph activity-feed notifications           |
| `backups/<timestamp>/`       | Copies of the data files taken before a startup migration or dev reset |

There is **no relational database and no ORM**. Every file is accessed through one per-file queue (`JsonFile`) that serializes reads and writes and applies updates atomically. Reads normalize legacy shapes (e.g. older `folderName`/`loanName`/`serverLocation` variants). A small set of idempotent migrations runs at every startup (link canonicalization, which backs up the data first; the loan backfill; the pool-nag backfill).

**Retention.** Completed and cancelled tasks are archived automatically after **14 days**. Archived tasks are purged when their `archivedAt` is older than `ARCHIVE_RETENTION_DAYS` (default **90 days**). The purge removes the task record only: its history events remain in `tasks.json`.

The stores (`TaskStore`, `LoanStore`, `UserStore` and others) are concrete classes over the JSON files; replacing them with a managed database would mean reimplementing those classes behind the same methods.

---

## 7. Authentication

### In production (Microsoft Teams)

The tab signs the user in with **Teams single sign-on**: `@microsoft/teams-js` obtains a Microsoft Entra ID token, and the client sends it as `Authorization: Bearer` on every API request. The server verifies the token with `jose` against the tenant's published signing keys, checking the issuer (`login.microsoftonline.com/<AAD_TENANT_ID>/v2.0`), the audience (`SSO_AUDIENCE` / `SSO_CLIENT_ID`) and the tenant. The token supplies identity (object id, name, email); roles come from `users.json`. Deactivated users are refused.

Bot Framework authentication (`BOT_APP_ID`, `BOT_APP_PASSWORD`, `BOT_TENANT_ID`) applies only to the bot endpoint, `/api/bot/messages`.

**Microsoft Graph** uses an application token (client-credentials flow with `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`), never a user-impersonation token, for two things: sending activity-feed notifications (gated by `ENABLE_ACTIVITY_FEED_NOTIFICATIONS`, off by default) and looking up a user by email when an admin adds them (requires `User.Read.All`).

### In local development

When SSO is not configured (or `DEV_BYPASS_AUTH=true`), the server instead reads three mock headers (`x-user-id`, `x-user-name`, `x-user-roles`), defaulting to the `LOAN_OFFICER` role; roles in `users.json` take precedence over the header. Once SSO is configured, a request without a bearer token is refused with 401, and the dev-only routes are not registered. Implemented in `apps/server/src/auth.ts`.

### Integration key

There is no password store and no shared API key for human users. When `INBOUND_API_KEY` is set, `POST /api/integrations/tasks` accepts a task from another system that presents the key in an `x-api-key` header; such tasks are filed as "In-house Integration". Without the key the endpoint returns 503.

---

## 8. External Integrations

| System                          | Direction     | Purpose                                                       |
|---------------------------------|---------------|---------------------------------------------------------------|
| Microsoft Teams (tab + SSO)     | Inbound       | Hosts the tab; Teams SSO provides the signed-in identity      |
| Microsoft Teams (Bot Framework) | Bidirectional | Posts channel and DM cards, receives card actions and replies. The bot does not file tasks; it points people to the tab |
| Microsoft Entra ID              | Outbound      | Signing keys used to verify SSO tokens                        |
| Microsoft Graph API             | Outbound      | Activity-feed notifications; user lookup by email             |
| Teams channel webhook (legacy)  | Outbound      | Optional channel post via `TEAMS_CHANNEL_WEBHOOK_URL`         |
| Inbound integration API         | Inbound       | Optional, key-protected task filing (§7)                      |
| Humperdink (external loan system) | Link + clipboard | Loans store a Humperdink link, scheme-allowlisted to `http`/`https` and canonicalized to the loan's Details page (`apps/server/src/validation.ts`, `packages/shared/src/loan.ts`). The app never calls Humperdink. An optional userscript (`tools/humperdink/send-to-hot-task.user.js`) adds an **Export to HT** button that copies the loan's details to the clipboard and opens a new LOI Check, which imports them on paste or on arrival (ADR-0012). |

---

## 9. Audit Trails

The audit story rests on three structures.

### 9.1 Task history events

Every task has history events stored in a separate top-level array in `tasks.json`. The store only appends to it; no API edits or deletes an event. Every user action that changes a task writes an event, and so do the scheduler's auto-complete and auto-archive. Reminders and pool nags do not.

| Event action                 | When written                                                      |
|------------------------------|-------------------------------------------------------------------|
| `TASK_CREATED`               | Task filed                                                        |
| `TASK_ASSIGNED`              | Task handed to someone (at filing or later)                       |
| `TASK_CLAIMED`               | A user claims an open task                                        |
| `TASK_UNCLAIMED`             | The assignee releases their claim, or the creator sends the task back to the pool |
| `TASK_RELEASED`              | A Fraud Check is released for any checker, by its creator or because its checker lost the File Checker role |
| `TASK_STATUS_CHANGED`        | Any other status move (review, merge, fraud steps, cancel, re-open) |
| `TASK_COMPLETED`             | Task completed, by a user or by the OOO auto-complete             |
| `TASK_ARCHIVED`              | Task archived, by a user or by the 14-day sweep (detail notes "retention") |
| `TASK_SHARED`                | Someone shares the task with a person                             |
| `TASK_POINTS_UPDATED`        | The poops rating changes                                          |
| `TASK_NOTES_AMENDED`         | The Instructions change                                           |
| `TASK_URGENCY_AMENDED`       | The urgency changes                                               |
| `TASK_DATES_AMENDED`         | OOO dates change                                                  |
| `TASK_FOLDER_NAME_AMENDED`   | The task's loan name changes                                      |
| `TASK_LOAN_NAME_AMENDED`, `TASK_LOAN_LINK_AMENDED` | A loan record is renamed or relinked (written on every task on that loan) |
| `REQUESTER_HANDED_OVER`      | Change Task Owner                                                 |
| `REVIEW_NOTE_ADDED`          | A message is added to the conversation                            |
| `REVIEW_NOTE_EDITED`         | A message is edited (keeps the previous text)                     |
| `REVIEW_NOTE_DELETED`        | A message is deleted (keeps the deleted text)                     |
| `CHECKLIST_UPDATED`          | A Fraud checklist item is added, changed, ticked or annotated     |

Every event includes an id, the task id, the action, the actor's user id and display name, the UTC timestamp, and an optional free-form `detail` describing the change (e.g. previous and new status). Scheduler actions are attributed to a system actor.

Endpoint: `GET /api/tasks/:taskId/history` (oldest first).

### 9.2 Conversation messages (`reviewNotes[]`)

The task's conversation: timestamped, attributed messages from the creator and assignee, including the note attached to a **Needs fixes** and notes added after completion. Each entry has a stable id, author id and name, UTC timestamp, `text`, an optional app-authored `label`, and `edited` / `deleted` flags.

**Messages are editable by their author** (ADR-0009). An edit replaces the text and marks the message "(edited)"; a delete empties it and leaves a "Message deleted" marker. The original words survive in the `REVIEW_NOTE_EDITED` / `REVIEW_NOTE_DELETED` history events, so the history, not the conversation, is the audit copy.

The id is the message's own handle and is never its timestamp; the timestamp is what the unread calculation compares and is frozen across an edit (ADR-0009 rule 6). The `label` holds the app's own words apart from the author's (ADR-0009 rule 5): a `Needs fixes` send-back stores `Needs fixes` as the label and only the checker's finding as the text, and every surface renders them together as `Needs fixes: <finding>`.

### 9.3 Lifecycle timestamps on the task

`createdAt`, `updatedAt`, `completedAt`, `archivedAt`, `cancelledAt` are set at the corresponding action. `dueAt`, `pooledSince`, `lastReminderAt` and `lastPoolNagAt` are working values that change as the task moves (for example, `lastReminderAt` is cleared on claim and on status changes), so they are not a record.

Together these let an auditor reconstruct, for any task still in storage, the sequence of who did what and when, including the scheduler's auto-complete and auto-archive. Reminders and pool nags are not recorded.

---

## 10. Hosting & Deployment

### Topology

A single **Azure Web App** (Linux, Node 24) hosts the entire application:

- `/api/*` — REST endpoints: tasks and their actions, loans, users and roles, admin settings, saved drafts and autosave, the integration endpoint, `/api/me`, `/api/config`, `/api/status`
- `/api/stream` and `/api/stream-ticket` — the SSE live stream
- `/api/bot/messages` — Bot Framework inbound webhook
- `/api/health` — health check
- `/` — the built React SPA, served statically by the same Express process

There is no separate front-end CDN, no separate API host, and no Docker container.

### Provisioning scripts

| Script                                     | Effect |
|--------------------------------------------|--------|
| `scripts/azure/provision-webapp.sh`        | Creates the resource group, Linux App Service plan and Web App if missing; sets app settings and the `npm run start` startup command; turns off the platform build; then builds the **local working tree** (`npm ci && npm run build`), zips the built output with production `node_modules`, and deploys it with `az webapp deploy --type zip`. Uncommitted local changes are included. |
| `scripts/azure/create-identity-and-bot.sh` | Creates (or reuses) the Entra ID app registrations for the tab and the bot. Configures Teams SSO on the tab registration (Application ID URI, `access_as_user` scope, pre-authorized Teams clients) and writes `AAD_TENANT_ID`, `SSO_AUDIENCE`, `SSO_CLIENT_ID`. Provisions an Azure Bot resource (F0 tier). Generates a bot client secret and writes `BOT_APP_ID`, `BOT_APP_PASSWORD`, `BOT_TENANT_ID` **only** when it created or updated the bot in that run. |
| `scripts/azure/build-teams-package.sh`     | Writes `teams-app/manifest.generated.json` from the template and produces `teams-app/operation-hot-task-teams.zip` (manifest + icons) for upload through the Teams admin center. |

### Configuration (environment variables)

Read in `apps/server/src/config.ts`, which is the environment contract:

| Variable                           | Purpose                                                          |
|------------------------------------|------------------------------------------------------------------|
| `PORT`, `HOST`                     | Listener (Azure overrides `PORT`)                                |
| `APP_BASE_URL`                     | Public URL, used in Teams deep links and activity-feed notices   |
| `DATA_FILE`, `LOANS_FILE`, `USERS_FILE`, `ADMIN_SETTINGS_FILE`, `SAVED_FOR_LATER_FILE`, `BOT_REFERENCES_FILE` | Data file paths |
| `FRONTEND_DIST`                    | Built SPA directory served by Express                            |
| `SERVER_DEV_MODE`, `WEB_PORT`      | Dev only: redirect page requests to the Vite dev server          |
| `BUSINESS_TIMEZONE`                | Default `America/Los_Angeles`                                    |
| `BUSINESS_START_HOUR`, `BUSINESS_START_MINUTE`, `BUSINESS_END_HOUR`, `BUSINESS_END_MINUTE` | Business hours |
| `ARCHIVE_RETENTION_DAYS`           | Archive purge horizon (default 90)                               |
| `TASKS_CHANNEL_NAME`, `TEAMS_CHANNEL_WEBHOOK_URL` | Teams channel routing                             |
| `ENABLE_DM_NOTIFICATIONS`          | Master toggle for bot DMs                                        |
| `ENABLE_ACTIVITY_FEED_NOTIFICATIONS`, `ACTIVITY_FEED_STATE_FILE` | Graph activity-feed toggle and state |
| `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `GRAPH_BASE_URL`, `TEAMS_APP_ID` | Microsoft Graph credentials |
| `AAD_TENANT_ID`, `SSO_AUDIENCE`, `SSO_CLIENT_ID` | Teams SSO token validation (written by the identity script) |
| `DEV_BYPASS_AUTH`                  | Forces the dev mock-header sign-in; must be unset in production  |
| `BOT_APP_ID`, `BOT_APP_PASSWORD`, `BOT_TENANT_ID` | Bot Framework credentials (written by the identity script) |
| `INBOUND_API_KEY`                  | Enables the inbound integration endpoint                         |

### Operational procedures

- **Redeploy code:** re-run `scripts/azure/provision-webapp.sh` from a clean checkout of the commit to ship.
- **Rotate bot secret:** re-running `create-identity-and-bot.sh` only rotates the secret when it also creates or updates the bot resource; otherwise it leaves the existing credentials alone and warns.
- **Promote staging → prod:** vary `AZ_RESOURCE_GROUP`, `AZ_WEBAPP_NAME`, and `AZ_APP_PREFIX` per environment.
- **Health verification:** `curl https://<webapp>.azurewebsites.net/api/health` (expects HTTP 200).
- **Bot endpoint verification:** `curl -i https://<webapp>.azurewebsites.net/api/bot/messages` (expects 401/405 without a signed payload).

---

## 11. Continuous Integration & Testing

GitHub Actions (`.github/workflows/ci.yml`) runs on every push and pull request against Node 24 and gates merges on:

1. `lint` — a TypeScript type-check (`tsc --noEmit`) in each workspace; there is no ESLint
2. `check:import-cycles` — guards `packages/shared` against import cycles
3. `build` — full compile of `apps/web`, `apps/server`, and `packages/shared`
4. `test:all` — the full regression suite

`test:all` runs about 93 scripts: `scripts/smoke-test.mjs` (an end-to-end create / claim / transition / complete / archive flow against a server it starts itself), `scripts/scheduler-sim-test.mjs` (OOO auto-completion, auto-archive and purge), and about 90 focused `scripts/*-sim-test.mjs` files covering permissions, the LOI, Loan Docs and Fraud flows, deadlines, reminders and the pool nag, loans, drafts, message editing, Teams cards and authentication. Tests use Node's built-in `node:test` runner and `node:assert`; there is no Jest or Vitest.

---

## 12. Source-of-Truth File Map

For an auditor wishing to verify any claim in this document against the code:

| Concern                                       | File                                            |
|-----------------------------------------------|-------------------------------------------------|
| Product rules (index)                         | `AGENTS.md`, `docs/product/README.md`           |
| Permission rules (prose)                      | `docs/product/roles-permissions.md`             |
| Notification routing                          | `docs/product/notifications-bot.md`             |
| Design decisions                              | `docs/adr/`                                     |
| Type definitions (task, history event, message, role, enums) | `packages/shared/src/types.ts`   |
| Permission / transition rules, deadlines, retention | `packages/shared/src/workflow.ts`         |
| History action names                          | `packages/shared/src/history.ts`                |
| Display names and button labels               | `packages/shared/src/labels.ts`                 |
| Business hours                                | `packages/shared/src/office-hours.ts`           |
| Fraud checklist rules                         | `packages/shared/src/fraud.ts`, `packages/shared/src/checklist.ts` |
| Loan and Humperdink link rules                | `packages/shared/src/loan.ts`, `packages/shared/src/humperdink.ts` |
| Task persistence (tasks + history)            | `apps/server/src/store.ts`, `apps/server/src/json-file.ts` |
| State transitions and history-event emission  | `apps/server/src/task-service.ts`               |
| Loans                                         | `apps/server/src/loan-service.ts`               |
| Users and roles                               | `apps/server/src/user-store.ts`                 |
| Admin settings                                | `apps/server/src/settings-store.ts`             |
| Saved drafts and autosave                     | `apps/server/src/saved-for-later-store.ts`, `apps/server/src/saved-for-later-routes.ts` |
| Startup backups                               | `apps/server/src/data-backup.ts`                |
| Scheduler (OOO auto-complete, auto-archive, purge, reminders, pool nag) | `apps/server/src/scheduler.ts`, `apps/server/src/task-service.ts` |
| Notification dispatch (DM / channel / activity feed) | `apps/server/src/notifications.ts`        |
| Teams Bot Framework adapter and cards         | `apps/server/src/bot.ts`                        |
| Microsoft Graph activity feed                 | `apps/server/src/activity-feed.ts`              |
| Microsoft Graph user lookup                   | `apps/server/src/graph-users.ts`                |
| Sign-in (SSO and dev headers)                 | `apps/server/src/auth.ts`                       |
| Live stream tickets                           | `apps/server/src/stream-tickets.ts`, `apps/server/src/sse.ts` |
| Humperdink URL validation                     | `apps/server/src/validation.ts`                 |
| HTTP routes                                   | `apps/server/src/routes.ts`                     |
| Application bootstrap and startup migrations  | `apps/server/src/index.ts`                      |
| Environment contract                          | `apps/server/src/config.ts`                     |
| CI pipeline                                   | `.github/workflows/ci.yml`                      |
| Teams app manifest                            | `teams-app/manifest.json`                       |
| Azure provisioning scripts                    | `scripts/azure/*.sh`                            |
| Humperdink Export to HT userscript            | `tools/humperdink/send-to-hot-task.user.js`     |
| Tests                                         | `scripts/smoke-test.mjs`, `scripts/scheduler-sim-test.mjs`, `scripts/*-sim-test.mjs` |
