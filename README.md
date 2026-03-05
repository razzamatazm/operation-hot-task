# Loan Tasks Teams App

Internal Microsoft Teams app for loan officers, file checkers, and admins to coordinate loan check work.

## What is implemented

- Teams **Tab app** (`apps/web`) with task board UI
- Teams **Bot endpoint** (`apps/server`) for notification delivery (DM + channel posts)
- Teams **Activity Feed** notifications via Microsoft Graph (optional, app-only auth)
- Teams **Bot quick add** flow via `/bot new`
- Task lifecycle and rules for:
  - LOI
  - Value
  - Fraud
  - Loan Docs (with merge stages)
  - OOO (Out of Office) with return-date auto-completion
- Claim/unclaim flow
- Role restrictions:
  - Fraud tasks can only be claimed/completed by file checkers
- Status support:
  - `OPEN`, `CLAIMED`, `NEEDS_REVIEW`, `MERGE_DONE`, `MERGE_APPROVED`, `COMPLETED`, `CANCELLED`, `ARCHIVED`
- Real-time in-app updates via SSE
- Hourly overdue reminders during business hours (8:30 AM-5:30 PM America/Los_Angeles)
- Urgency model:
  - `GREEN` due in 24 real hours from creation; if that due time lands on Saturday/Sunday (America/Los_Angeles), it shifts to Monday at the same local time
  - `YELLOW` end of business day
  - `ORANGE` within 1 hour
  - `RED` immediate
- Due timestamps are backend-tracked for standard task types; OOO tasks require user-entered `returnDate` (`YYYY-MM-DD`, PT) and auto-complete at 8:30 AM PT on that date
- Auto-purge archived tasks after 90 days (3 months)

## Repo layout

- `AGENTS.md` requirements + decision log
- `apps/server` Express API, scheduler, bot endpoint, notifications, persistence
- `apps/web` React Teams tab UI
- `packages/shared` shared task types + workflow logic
- `teams-app/manifest.json` Teams app manifest template

## Local quick start

1. Install dependencies

```bash
npm install
```

2. Copy env files

```bash
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env
```

3. Run the app

```bash
npm run dev
```

4. Open UI at [http://localhost:5173](http://localhost:5173)

Backend runs at [http://localhost:4100](http://localhost:4100).

## Test commands

Build first so server/shared compiled modules are up to date:

```bash
npm run build
```

Deterministic scheduler/retention tests:

```bash
npm run test:scheduler
```

Live API smoke tests (starts local servers and exercises workflows/permissions):

```bash
npm run test:smoke
```

Run both:

```bash
npm run test:all
```

## Local user simulation

The tab includes an "Acting user" selector with mock identities:

- Loan officer
- File checker (loan officer + file checker role)
- Admin

These set request headers used by the API for permission checks.

## API overview

Base URL: `/api`

- `GET /health`
- `GET /tasks`
- `POST /tasks`
- `POST /integrations/tasks` (optional API key auth for phase-2 in-house app)
- `GET /tasks/:taskId`
- `GET /tasks/:taskId/history`
- `POST /tasks/:taskId/claim`
- `POST /tasks/:taskId/unclaim`
- `POST /tasks/:taskId/transition`
- `GET /stream` (SSE)

Create-task payload naming:
- Preferred canonical field: `folderName`
- Compatibility accepted for one release window: `loanName` or `serverLocation` (resolved to `folderName`)
- OOO-specific rules:
  - `taskType: "OOO"` requires `returnDate` (`YYYY-MM-DD`)
  - `taskType: "OOO"` rejects `urgency`
  - `taskType: "OOO"` rejects `humperdinkLink`
  - non-OOO task types reject `returnDate`

Bot endpoint:

- `POST /api/bot/messages`
- Bot chat commands:
  - `/bot new` quick add wizard (description -> task type -> [OOO: return date | non-OOO: urgency] -> notes -> [non-OOO: humperdink link] -> review/edit -> confirm -> create)
  - `/bot back` return to the previous step during quick add
  - `/bot cancel`
  - `help`

## Teams setup (Azure-ready)

1. Register an Azure Bot / Entra app.
2. Set `BOT_APP_ID`, `BOT_APP_PASSWORD`, and `BOT_TENANT_ID` in `apps/server/.env`.
3. Update `teams-app/manifest.json` placeholders:
   - `id`
   - `bots[0].botId`
   - `contentUrl`, `websiteUrl`, `configurationUrl`
   - `validDomains`
4. Replace placeholder `teams-app/color.png` and `teams-app/outline.png` with production icon assets.
5. Zip `teams-app/*` and sideload into Teams for testing.

For a full Azure + Teams production runbook with copy/paste commands, use:

- `docs/AZURE_DEPLOYMENT.md`
- `scripts/azure/provision-webapp.sh`
- `scripts/azure/create-identity-and-bot.sh`
- `scripts/azure/build-teams-package.sh`

NPM shortcuts:

- `npm run azure:provision`
- `npm run azure:identity`
- `npm run azure:teams-package`

## Channel posts

Two channel posting mechanisms are supported:

- Incoming webhook (`TEAMS_CHANNEL_WEBHOOK_URL`)
- Bot proactive channel posts (when bot credentials are configured and the bot has channel conversation references)

Current notification routing:
- New task created: channel + in-app
- Task claimed/unclaimed: channel update; claimer gets DM confirmation on claim
- `MERGE_DONE` and `COMPLETED`: DM to task creator
- `MERGE_APPROVED`: DM to task assignee
- Review note added: DM to counterpart user (creator/assignee)
- Overdue reminder: DM to assignee, except `LOAN_DOCS` in `MERGE_DONE` where DM goes to creator
- Activity feed (if enabled): state-change + hourly reminders for claimable/open work, overdue work, and `NEEDS_REVIEW`; note events notify counterpart user

### Activity feed setup (optional)

Server env vars:

- `ENABLE_ACTIVITY_FEED_NOTIFICATIONS=true`
- `GRAPH_TENANT_ID=<tenant-guid>`
- `GRAPH_CLIENT_ID=<app-registration-client-id>`
- `GRAPH_CLIENT_SECRET=<app-registration-secret>`
- `GRAPH_BASE_URL=https://graph.microsoft.com/v1.0` (optional override)
- `TEAMS_APP_ID=<teams-app-id>`
- `ACTIVITY_FEED_STATE_FILE=apps/server/data/activity-feed-state.json` (optional path override)

Manifest requirement:

- Add `webApplicationInfo` with your tab app AAD app ID/resource (already scaffolded in `teams-app/manifest.json`).

## In-house app task creation (phase 2 ready)

Set `INBOUND_API_KEY` in `/apps/server/.env` to enable `POST /api/integrations/tasks`.

- Header: `x-api-key: <INBOUND_API_KEY>`
- Body: same schema as `POST /api/tasks`

## Data persistence

Local JSON persistence:

- Tasks/history: `apps/server/data/tasks.json`
- Bot conversation references: `apps/server/data/bot-references.json`
- Activity feed signal state/users: `apps/server/data/activity-feed-state.json`

For Azure, swap storage behind `TaskStore` with Azure SQL while preserving the `TaskService` contract.

## Next recommended steps

1. Replace mock header-based auth with Entra SSO token validation.
2. Persist to Azure SQL and add migrations.
3. Add admin settings UI for business hours and reminder policy.
4. Add inbound API auth + endpoint for phase-2 task creation from your in-house web app.
