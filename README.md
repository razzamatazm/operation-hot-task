# Loan Tasks Teams App

Internal Microsoft Teams app for loan officers, file checkers, and admins to coordinate loan check work.

## What is implemented

- Teams **Tab app** (`apps/web`) with task board UI
- Teams **Bot endpoint** (`apps/server`) for notification delivery (DM + channel posts)
- Teams **Bot quick add** flow via `/bot new`
- Task lifecycle and rules for:
  - LOI
  - Value
  - Fraud
  - Loan Docs (with merge stages)
- Claim/unclaim flow
- Role restrictions:
  - Fraud tasks can only be claimed/completed by file checkers
- Status support:
  - `OPEN`, `CLAIMED`, `NEEDS_REVIEW`, `MERGE_DONE`, `MERGE_APPROVED`, `COMPLETED`, `CANCELLED`, `ARCHIVED`
- Real-time in-app updates via SSE
- Hourly overdue reminders during business hours (8:30 AM-5:30 PM America/Los_Angeles)
- Urgency model:
  - `GREEN` anytime (reminders begin after next business day)
  - `YELLOW` end of business day
  - `ORANGE` within 1 hour
  - `RED` immediate
- Due timestamps are backend-tracked; due date/time is not user-entered in UI
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

Bot endpoint:

- `POST /api/bot/messages`
- Bot chat commands:
  - `/bot new` quick add wizard (task type -> urgency -> notes -> humperdink link -> server file/path -> loan name confirm/override)
  - `/bot cancel`
  - `help`

## Teams setup (Azure-ready)

1. Register an Azure Bot / Entra app.
2. Set `BOT_APP_ID` and `BOT_APP_PASSWORD` in `apps/server/.env`.
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

## In-house app task creation (phase 2 ready)

Set `INBOUND_API_KEY` in `/apps/server/.env` to enable `POST /api/integrations/tasks`.

- Header: `x-api-key: <INBOUND_API_KEY>`
- Body: same schema as `POST /api/tasks`

## Data persistence

Local JSON persistence:

- Tasks/history: `apps/server/data/tasks.json`
- Bot conversation references: `apps/server/data/bot-references.json`

For Azure, swap storage behind `TaskStore` with Azure SQL while preserving the `TaskService` contract.

## Next recommended steps

1. Replace mock header-based auth with Entra SSO token validation.
2. Persist to Azure SQL and add migrations.
3. Add admin settings UI for business hours and reminder policy.
4. Add inbound API auth + endpoint for phase-2 task creation from your in-house web app.
