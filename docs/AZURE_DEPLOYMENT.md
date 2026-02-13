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
- Creates web app (Node 20)
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
- Creates a bot secret and writes bot creds into web app app settings
- Creates/updates Azure Bot resource (F0) with endpoint:
  - `https://${AZ_WEBAPP_NAME}.azurewebsites.net/api/bot/messages`

Save the printed `BOT_APP_PASSWORD` securely.

## 3) Build Teams app package (manifest zip)

Use IDs from step 2:

```bash
export TEAMS_APP_ID="<TAB_APP_ID_FROM_STEP_2>"
export BOT_APP_ID="<BOT_APP_ID_FROM_STEP_2>"
export TEAMS_DOMAIN="${AZ_WEBAPP_NAME}.azurewebsites.net"

./scripts/azure/build-teams-package.sh
```

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
