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

# --- Teams SSO config on the tab app (rollout phase 1) ---
# The tab app registration doubles as the SSO API: expose an Application ID
# URI + an `access_as_user` scope, and pre-authorize the Teams first-party
# clients so users get no consent prompt on first open.
WEBAPP_DOMAIN="${TEAMS_DOMAIN:-${WEBAPP_NAME}.azurewebsites.net}"
APP_ID_URI="api://${WEBAPP_DOMAIN}/${TAB_APP_ID}"
TAB_OBJECT_ID="$(az ad app show --id "$TAB_APP_ID" --query id -o tsv)"

echo "==> setting Application ID URI: $APP_ID_URI"
az ad app update --id "$TAB_APP_ID" --identifier-uris "$APP_ID_URI"

# Reuse the existing access_as_user scope id if present (idempotent re-runs),
# else mint a new one.
SCOPE_ID="$(az ad app show --id "$TAB_APP_ID" \
  --query "api.oauth2PermissionScopes[?value=='access_as_user'].id | [0]" -o tsv)"
if [[ -z "$SCOPE_ID" ]]; then
  SCOPE_ID="$( (uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid) | tr 'A-Z' 'a-z')"
fi

# Teams first-party client app IDs (web, desktop/mobile).
TEAMS_WEB_CLIENT="5e3ce6c0-2b1f-4285-8d4b-75ee78787346"
TEAMS_DESKTOP_CLIENT="1fec8e78-bce4-4aaf-ab1b-5451cc387264"

API_PATCH="$(cat <<JSON
{
  "api": {
    "requestedAccessTokenVersion": 2,
    "oauth2PermissionScopes": [
      {
        "id": "${SCOPE_ID}",
        "type": "User",
        "value": "access_as_user",
        "isEnabled": true,
        "adminConsentDisplayName": "Access Operation Hot Task as the user",
        "adminConsentDescription": "Allows Teams to call the Operation Hot Task API as the signed-in user.",
        "userConsentDisplayName": "Access Operation Hot Task as you",
        "userConsentDescription": "Allows Teams to call the Operation Hot Task API as you."
      }
    ],
    "preAuthorizedApplications": [
      { "appId": "${TEAMS_WEB_CLIENT}", "delegatedPermissionIds": ["${SCOPE_ID}"] },
      { "appId": "${TEAMS_DESKTOP_CLIENT}", "delegatedPermissionIds": ["${SCOPE_ID}"] }
    ]
  }
}
JSON
)"

echo "==> configuring access_as_user scope + Teams pre-authorization (v2 tokens)"
az rest --method PATCH \
  --url "https://graph.microsoft.com/v1.0/applications/${TAB_OBJECT_ID}" \
  --headers "Content-Type=application/json" \
  --body "$API_PATCH" >/dev/null

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

echo "==> writing bot credentials + SSO settings to app settings"
az webapp config appsettings set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$WEBAPP_NAME" \
  --settings \
    BOT_APP_ID="$BOT_APP_ID" \
    BOT_APP_PASSWORD="$BOT_APP_SECRET" \
    BOT_TENANT_ID="$TENANT_ID" \
    AAD_TENANT_ID="$TENANT_ID" \
    SSO_AUDIENCE="$APP_ID_URI" \
    SSO_CLIENT_ID="$TAB_APP_ID" \
  --output table >/dev/null

cat <<OUT

identity_and_bot_complete
TAB_APP_ID=$TAB_APP_ID
BOT_APP_ID=$BOT_APP_ID
APP_ID_URI=$APP_ID_URI
BOT_RESOURCE_NAME=$BOT_RESOURCE_NAME
BOT_ENDPOINT=$BOT_ENDPOINT

SSO app settings written: AAD_TENANT_ID, SSO_AUDIENCE, SSO_CLIENT_ID.
The tab app now exposes $APP_ID_URI with the access_as_user scope,
pre-authorized for the Teams web + desktop/mobile clients.

Next:
  - Build the Teams package (webApplicationInfo auto-fills from these IDs):
      export TEAMS_APP_ID=$TAB_APP_ID BOT_APP_ID=$BOT_APP_ID TEAMS_DOMAIN=$WEBAPP_DOMAIN
      ./scripts/azure/build-teams-package.sh
  - If your tenant requires it, grant admin consent for the access_as_user
    scope in Entra (App registrations > $TAB_APP_NAME > API permissions).

IMPORTANT: save BOT_APP_PASSWORD securely now (it will not be shown again):
BOT_APP_PASSWORD=$BOT_APP_SECRET
OUT
