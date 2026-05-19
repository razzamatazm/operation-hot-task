#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

need az
need npm
need zip

SUBSCRIPTION_ID="${AZ_SUBSCRIPTION_ID:-$(az account show --query id -o tsv)}"
LOCATION="${AZ_LOCATION:-westus2}"
RESOURCE_GROUP="${AZ_RESOURCE_GROUP:-rg-operation-hot-task-prod}"
PLAN_NAME="${AZ_APP_SERVICE_PLAN:-asp-operation-hot-task-prod}"
WEBAPP_NAME="${AZ_WEBAPP_NAME:-operation-hot-task-app}"
RUNTIME="${AZ_RUNTIME:-NODE:24-lts}"
SKU="${AZ_APP_SERVICE_SKU:-B1}"

if [[ -z "$SUBSCRIPTION_ID" || -z "$WEBAPP_NAME" ]]; then
  echo "AZ_SUBSCRIPTION_ID and AZ_WEBAPP_NAME must be set" >&2
  exit 1
fi

echo "==> using subscription: $SUBSCRIPTION_ID"
az account set --subscription "$SUBSCRIPTION_ID"

echo "==> creating resource group: $RESOURCE_GROUP"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output table

echo "==> creating app service plan: $PLAN_NAME"
az appservice plan create \
  --name "$PLAN_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --is-linux \
  --sku "$SKU" \
  --output table

echo "==> creating web app: $WEBAPP_NAME"
if ! az webapp show --resource-group "$RESOURCE_GROUP" --name "$WEBAPP_NAME" >/dev/null 2>&1; then
  az webapp create \
    --resource-group "$RESOURCE_GROUP" \
    --plan "$PLAN_NAME" \
    --name "$WEBAPP_NAME" \
    --runtime "$RUNTIME" \
    --output table
else
  echo "web app already exists; skipping create"
fi

# We build locally and ship the compiled output + production node_modules,
# so the server must NOT run an oryx build. Building on the server fails:
# TypeScript/Vite are devDependencies and the server's production install
# prunes them ("tsc: not found"). Keep SCM build OFF.
echo "==> applying app settings"
az webapp config appsettings set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$WEBAPP_NAME" \
  --settings \
    SCM_DO_BUILD_DURING_DEPLOYMENT=false \
    ENABLE_ORYX_BUILD=false \
    HOST=0.0.0.0 \
    FRONTEND_DIST=../web/dist \
    DATA_FILE=/home/site/data/tasks.json \
    BOT_REFERENCES_FILE=/home/site/data/bot-references.json \
    BUSINESS_TIMEZONE=America/Los_Angeles \
    BUSINESS_START_HOUR=8 \
    BUSINESS_START_MINUTE=30 \
    BUSINESS_END_HOUR=17 \
    BUSINESS_END_MINUTE=30 \
    ARCHIVE_RETENTION_DAYS=90 \
    ENABLE_DM_NOTIFICATIONS=true \
  --output table

# Artifacts are prebuilt and node_modules ships in the package, so startup
# only runs the server. No build, no workspace symlink hack.
echo "==> setting startup command"
STARTUP_CMD="npm run start"
az webapp config set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$WEBAPP_NAME" \
  --startup-file "$STARTUP_CMD" \
  --output table

# Build the app locally where devDependencies are available.
echo "==> installing dependencies and building locally"
npm ci
npm run build

# Stage a self-contained deployment package: compiled output + every
# workspace package.json + a production-only node_modules.
echo "==> staging deployment package"
STAGE_DIR="$(mktemp -d /tmp/operation-hot-task-stage-XXXXXX)"
TMP_BASE="$(mktemp /tmp/operation-hot-task-XXXXXX)"
DEPLOY_ZIP="${TMP_BASE}.zip"
trap 'rm -rf "$STAGE_DIR" "$DEPLOY_ZIP" "$TMP_BASE"' EXIT

mkdir -p "$STAGE_DIR/apps/server" "$STAGE_DIR/apps/web" "$STAGE_DIR/packages/shared"
cp package.json package-lock.json "$STAGE_DIR/"
cp apps/server/package.json "$STAGE_DIR/apps/server/"
cp -R apps/server/dist "$STAGE_DIR/apps/server/dist"
cp apps/web/package.json "$STAGE_DIR/apps/web/"
cp -R apps/web/dist "$STAGE_DIR/apps/web/dist"
cp packages/shared/package.json "$STAGE_DIR/packages/shared/"
cp -R packages/shared/dist "$STAGE_DIR/packages/shared/dist"

echo "==> installing production dependencies into the package"
(cd "$STAGE_DIR" && npm ci --omit=dev)

echo "==> zipping deployment package"
(cd "$STAGE_DIR" && zip -r -q "$DEPLOY_ZIP" .)

# Azure restarts the SCM container on app-settings / startup changes. A
# deploy started in that window is killed ("Deployment has been stopped
# due to SCM container restart"). Let the config changes settle first.
echo "==> waiting for config changes to settle (60s)"
sleep 60

echo "==> deploying package"
az webapp deploy \
  --resource-group "$RESOURCE_GROUP" \
  --name "$WEBAPP_NAME" \
  --src-path "$DEPLOY_ZIP" \
  --type zip \
  --clean true \
  --output table

APP_URL="https://${WEBAPP_NAME}.azurewebsites.net"
echo
echo "deployment complete"
echo "app_url=$APP_URL"
echo "health_url=$APP_URL/api/health"
