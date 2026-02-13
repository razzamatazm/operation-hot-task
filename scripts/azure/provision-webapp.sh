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
need git

SUBSCRIPTION_ID="${AZ_SUBSCRIPTION_ID:-$(az account show --query id -o tsv)}"
LOCATION="${AZ_LOCATION:-westus2}"
RESOURCE_GROUP="${AZ_RESOURCE_GROUP:-rg-operation-hot-task-prod}"
PLAN_NAME="${AZ_APP_SERVICE_PLAN:-asp-operation-hot-task-prod}"
WEBAPP_NAME="${AZ_WEBAPP_NAME:-operation-hot-task-app}"
RUNTIME="${AZ_RUNTIME:-NODE:20-lts}"
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

echo "==> applying app settings"
az webapp config appsettings set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$WEBAPP_NAME" \
  --settings \
    SCM_DO_BUILD_DURING_DEPLOYMENT=true \
    HOST=0.0.0.0 \
    FRONTEND_DIST=apps/web/dist \
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

echo "==> setting startup command"
az webapp config set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$WEBAPP_NAME" \
  --startup-file "npm run start:prod" \
  --output table

echo "==> creating deployment package from current HEAD"
TMP_BASE="$(mktemp /tmp/operation-hot-task-XXXXXX)"
DEPLOY_ZIP="${TMP_BASE}.zip"
git archive --format=zip --output "$DEPLOY_ZIP" HEAD

echo "==> deploying package"
az webapp deploy \
  --resource-group "$RESOURCE_GROUP" \
  --name "$WEBAPP_NAME" \
  --src-path "$DEPLOY_ZIP" \
  --type zip \
  --clean true \
  --output table

rm -f "$DEPLOY_ZIP" "$TMP_BASE"

APP_URL="https://${WEBAPP_NAME}.azurewebsites.net"
echo
echo "deployment complete"
echo "app_url=$APP_URL"
echo "health_url=$APP_URL/api/health"
