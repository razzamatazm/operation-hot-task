# Azure + Teams Deployment Runbook

This runbook deploys the app as a single Azure Web App that serves both:
- API + Bot endpoint (`/api/*`, `/api/bot/messages`)
- Teams Tab frontend (`/`)

## Prerequisites

- Azure CLI logged in (`az login`)
- Permissions to create resources in your subscription/tenant
- `jq` and `zip` installed locally

## 0) Set deployment variables

Run these in your shell first:

```bash
export AZ_SUBSCRIPTION_ID="$(az account show --query id -o tsv)"
export AZ_LOCATION="westus2"
export AZ_RESOURCE_GROUP="rg-operation-hot-task-prod"
export AZ_APP_SERVICE_PLAN="asp-operation-hot-task-prod"
export AZ_WEBAPP_NAME="operation-hot-task-app"
export AZ_APP_PREFIX="operation-hot-task"
```

## 1) Provision Azure Web App and deploy code

```bash
./scripts/azure/provision-webapp.sh
```

What this does:
- Creates resource group and Linux App Service plan
- Creates web app (Node 24)
- Sets required app settings for your business-hour/reminder policy
- Sets startup command to `npm run start:prod`
- Deploys current git `HEAD` via zip deploy

After deployment, health endpoint should be:

```bash
curl -s "https://${AZ_WEBAPP_NAME}.azurewebsites.net/api/health"
```

## 2) Create Entra app registrations + Azure Bot

```bash
./scripts/azure/create-identity-and-bot.sh
```

What this does:
- Creates/reuses Entra app registration for Teams Tab app ID
- Creates/reuses Entra app registration for Bot ID
- Creates a bot secret and writes bot creds into web app app settings (`BOT_APP_ID`, `BOT_APP_PASSWORD`, `BOT_TENANT_ID`)
- Creates/updates Azure Bot resource (F0) with endpoint:
  - `https://${AZ_WEBAPP_NAME}.azurewebsites.net/api/bot/messages`
- **SSO (team rollout):** on the tab app registration, sets the Application
  ID URI (`api://<domain>/<tabAppId>`), exposes the `access_as_user` scope,
  pre-authorizes the Teams web + desktop/mobile clients, forces v2 tokens,
  and writes SSO app settings (`AAD_TENANT_ID`, `SSO_AUDIENCE`,
  `SSO_CLIENT_ID`). This flips the server from dev header-trust to real
  JWKS token verification.

Save the printed `BOT_APP_PASSWORD` securely. Note the printed `APP_ID_URI`.

If your tenant requires it, grant admin consent for the `access_as_user`
scope (App registrations > tab app > API permissions > Grant admin consent).
Pre-authorized Teams clients skip the per-user consent prompt regardless.

## 3) Build Teams app package (manifest zip)

Use IDs from step 2:

```bash
export TEAMS_APP_ID="<TAB_APP_ID_FROM_STEP_2>"
export BOT_APP_ID="<BOT_APP_ID_FROM_STEP_2>"
export TEAMS_DOMAIN="${AZ_WEBAPP_NAME}.azurewebsites.net"

./scripts/azure/build-teams-package.sh
```

`webApplicationInfo` (the SSO block) is filled automatically from
`TEAMS_APP_ID` + `TEAMS_DOMAIN` — no manual manifest edits needed.

Output zip:
- `teams-app/operation-hot-task-teams.zip`

## 4) Install in Teams

- Open Teams Admin Center or Teams client (Apps > Manage your apps)
- Upload `operation-hot-task-teams.zip`
- Add app to your team

## 5) Post-deploy verification

### API health

```bash
curl -s "https://${AZ_WEBAPP_NAME}.azurewebsites.net/api/health"
```

### Bot endpoint reachable (expect 401/405 if no bot activity body)

```bash
curl -i "https://${AZ_WEBAPP_NAME}.azurewebsites.net/api/bot/messages"
```

### CI still green

GitHub Actions runs automatically on push/PR:
- lint
- build
- scheduler tests
- smoke tests

## Operational notes

- Re-deploy code after changes by re-running:
  - `scripts/azure/provision-webapp.sh`
- Rotate bot secret by re-running:
  - `scripts/azure/create-identity-and-bot.sh`
- If you want separate staging/prod, change `AZ_RESOURCE_GROUP`, `AZ_WEBAPP_NAME`, and `AZ_APP_PREFIX` per environment.

## Deploy model — build locally, ship artifacts (do not build on the server)

`provision-webapp.sh` builds the app **locally** (`npm ci && npm run build`),
then ships a self-contained package: compiled `dist/` output for every
workspace plus a production-only `node_modules` (`npm ci --omit=dev`). The
server only runs (`npm run start`); it never builds.

`SCM_DO_BUILD_DURING_DEPLOYMENT` and `ENABLE_ORYX_BUILD` are set to `false`
on purpose. **Do not turn them on.**

## Deploy troubleshooting playbook

These are every failure hit while getting this app deployed. Read this
section before changing anything in `scripts/azure/`. The deploy script
already encodes all of these fixes — the notes explain *why* so nobody
re-breaks them.

### Pre-flight checklist

- `az login` done, correct subscription (LoneOakFund,
  `e37ad9ed-a389-4426-8fc5-e826719d3b00`).
- Deploy a **prod** webapp explicitly with the right env vars (the script
  defaults are the non-`-lof` names — wrong for this account):
  ```
  AZ_SUBSCRIPTION_ID=e37ad9ed-a389-4426-8fc5-e826719d3b00 \
  AZ_RESOURCE_GROUP=rg-operation-hot-task-prod-lof \
  AZ_APP_SERVICE_PLAN=asp-operation-hot-task-prod-lof \
  AZ_WEBAPP_NAME=operation-hot-task-app-lof \
  bash scripts/azure/provision-webapp.sh
  ```
- After deploy, **verify with curl** — do not trust the `az` exit status
  alone (see "deploy reports failure" below):
  ```
  curl -s https://operation-hot-task-app-lof.azurewebsites.net/api/health
  curl -s -o /dev/null -w '%{http_code}\n' \
    https://operation-hot-task-app-lof.azurewebsites.net/
  ```
  Expect `{"ok":true,...}` and `200`.

### 1. `tsc: not found` / `vite: not found` — building on the server

TypeScript and Vite are `devDependencies`. A production install prunes
them, so a server-side build has no compiler. **Fix:** build locally, ship
compiled `dist/` + a production `node_modules`. Server never builds. Keep
`SCM_DO_BUILD_DURING_DEPLOYMENT=false` and `ENABLE_ORYX_BUILD=false`.

### 2. "Deployment has been stopped due to SCM container restart"

`az webapp config` changes (app settings, startup command) restart the SCM
container. A deploy fired immediately after is killed mid-flight. **Fix:**
the script waits 60s after config changes before `az webapp deploy`. Never
run a config change and a deploy back-to-back.

### 3. `/` returns 404 / `serving_frontend=false`

The server (`apps/server/src/config.ts`) resolves a relative `FRONTEND_DIST`
against the **server package root** (`apps/server/`), not the process cwd.
`apps/web/dist` resolves to the wrong `apps/server/apps/web/dist`. **Fix:**
`FRONTEND_DIST=../web/dist` (the code's own default). The app log line
`serving_frontend=false missing=<path>` tells you exactly where it looked.

### 4. Deploy reports failure but the app is actually running

`az webapp deploy` polls site health for ~10 min and can time out
("Site failed to start within 10 mins") even after the container has
started — slow cold start (node_modules extraction) plus a stale
`ContainerTimeout` from a prior attempt confuse the orchestrator. **Always
confirm real state with the curl checks above** before assuming the deploy
failed. If health is `200`, it shipped.

### 5. Teams manifest changes don't show up

Teams caches the app by `version`. Re-uploading a package with the same
`version` serves the stale manifest (old tabs, old layout). **Fix:** bump
`version` in `teams-app/manifest.json` *and*
`teams-app/operation-hot-task-teams/manifest.json` on every manifest
change, rebuild the package, then **uninstall + reinstall** in Teams (not
"Update") to clear the tab cache.

### 6. Bot "Chat" tab pinned first in the personal app

A personal-scoped bot adds a "Chat" tab that **defaults to the first
position** — it does not come from `staticTabs`. Removing other static
tabs does not remove it. To move it out of first slot, declare a reserved
`conversations` static tab *after* the app tab in `staticTabs`:

```json
"staticTabs": [
  { "entityId": "loan-tasks-home", "name": "Operation Hot Task", ... },
  { "entityId": "conversations", "scopes": ["personal"] }
]
```

Do **not** delete the `conversations` entry — without it the bot chat
reverts to the default first position. The bot keeps `personal` scope so
1:1 DM notifications keep working (personal install is required for
proactive DMs; without it Teams returns `403 ForbiddenOperationException`).

### Reading the logs when a deploy misbehaves

```
az webapp log download -g rg-operation-hot-task-prod-lof \
  -n operation-hot-task-app-lof --log-file /tmp/oht-logs.zip
# default_docker.log      → the Node app's stdout (startup, errors)
# default_scm_docker.log  → deploy / rsync / oryx
```
Deployment status JSON:
`az rest --method get --url
"https://operation-hot-task-app-lof.scm.azurewebsites.net/api/deployments/latest"
--resource "https://management.azure.com"` — `status: 3` = failed,
`status: 4` = success.
