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

SUBSCRIPTION_ID="${AZ_SUBSCRIPTION_ID:-$(az account show --query id -o tsv)}"
TENANT_ID="$(az account show --query tenantId -o tsv)"
RESOURCE_GROUP="${AZ_RESOURCE_GROUP:-rg-operation-hot-task-prod}"
WEBAPP_NAME="${AZ_WEBAPP_NAME:-operation-hot-task-app}"
APP_PREFIX="${AZ_APP_PREFIX:-operation-hot-task}"

TAB_APP_NAME="${AZ_TAB_APP_NAME:-${APP_PREFIX}-tab}"
BOT_APP_NAME="${AZ_BOT_APP_NAME:-${APP_PREFIX}-bot-appreg}"
BOT_RESOURCE_NAME="${AZ_BOT_RESOURCE_NAME:-${APP_PREFIX}-bot}"
BOT_SECRET_DISPLAY_NAME="${AZ_BOT_SECRET_NAME:-bot-secret}"

if [[ -z "$SUBSCRIPTION_ID" || -z "$RESOURCE_GROUP" || -z "$WEBAPP_NAME" ]]; then
  echo "AZ_SUBSCRIPTION_ID, AZ_RESOURCE_GROUP, and AZ_WEBAPP_NAME must be set" >&2
  exit 1
fi

echo "==> using subscription: $SUBSCRIPTION_ID"
az account set --subscription "$SUBSCRIPTION_ID"

find_app_id() {
  local display_name="$1"
  az ad app list --display-name "$display_name" --query '[0].appId' -o tsv
}

TAB_APP_ID="$(find_app_id "$TAB_APP_NAME")"
if [[ -z "$TAB_APP_ID" ]]; then
  echo "==> creating tab app registration: $TAB_APP_NAME"
  TAB_APP_ID="$(az ad app create --display-name "$TAB_APP_NAME" --sign-in-audience AzureADMyOrg --query appId -o tsv)"
else
  echo "==> reusing existing tab app registration: $TAB_APP_NAME"
fi
az ad sp create --id "$TAB_APP_ID" >/dev/null 2>&1 || true

BOT_APP_ID="$(find_app_id "$BOT_APP_NAME")"
if [[ -z "$BOT_APP_ID" ]]; then
  echo "==> creating bot app registration: $BOT_APP_NAME"
  BOT_APP_ID="$(az ad app create --display-name "$BOT_APP_NAME" --sign-in-audience AzureADMyOrg --query appId -o tsv)"
else
  echo "==> reusing existing bot app registration: $BOT_APP_NAME"
fi
az ad sp create --id "$BOT_APP_ID" >/dev/null 2>&1 || true

echo "==> creating bot client secret (store this securely)"
BOT_APP_SECRET="$(az ad app credential reset --id "$BOT_APP_ID" --append --display-name "$BOT_SECRET_DISPLAY_NAME" --years 2 --query password -o tsv)"

BOT_ENDPOINT="https://${WEBAPP_NAME}.azurewebsites.net/api/bot/messages"

echo "==> creating/updating Azure Bot resource: $BOT_RESOURCE_NAME"
if ! az bot show --resource-group "$RESOURCE_GROUP" --name "$BOT_RESOURCE_NAME" >/dev/null 2>&1; then
  az bot create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$BOT_RESOURCE_NAME" \
    --app-type SingleTenant \
    --sku F0 \
    --appid "$BOT_APP_ID" \
    --tenant-id "$TENANT_ID" \
    --endpoint "$BOT_ENDPOINT" \
    --output table
else
  az bot update \
    --resource-group "$RESOURCE_GROUP" \
    --name "$BOT_RESOURCE_NAME" \
    --endpoint "$BOT_ENDPOINT" \
    --output table
fi

echo "==> writing bot credentials to app settings"
az webapp config appsettings set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$WEBAPP_NAME" \
  --settings \
    BOT_APP_ID="$BOT_APP_ID" \
    BOT_APP_PASSWORD="$BOT_APP_SECRET" \
  --output table >/dev/null

cat <<OUT

identity_and_bot_complete
TAB_APP_ID=$TAB_APP_ID
BOT_APP_ID=$BOT_APP_ID
BOT_RESOURCE_NAME=$BOT_RESOURCE_NAME
BOT_ENDPOINT=$BOT_ENDPOINT

IMPORTANT: save BOT_APP_PASSWORD securely now (it will not be shown again):
BOT_APP_PASSWORD=$BOT_APP_SECRET
OUT
