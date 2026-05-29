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

# Graph rejects pre-authorizing a scope id in the same request that defines
# the scope, so do it in two PATCHes: (1) define the scope + force v2 tokens,
# (2) pre-authorize the Teams clients against the now-existing scope.
SCOPE_PATCH="$(cat <<JSON
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
    ]
  }
}
JSON
)"

PREAUTH_PATCH="$(cat <<JSON
{
  "api": {
    "preAuthorizedApplications": [
      { "appId": "${TEAMS_WEB_CLIENT}", "delegatedPermissionIds": ["${SCOPE_ID}"] },
      { "appId": "${TEAMS_DESKTOP_CLIENT}", "delegatedPermissionIds": ["${SCOPE_ID}"] }
    ]
  }
}
JSON
)"

echo "==> defining access_as_user scope (v2 tokens)"
az rest --method PATCH \
  --url "https://graph.microsoft.com/v1.0/applications/${TAB_OBJECT_ID}" \
  --headers "Content-Type=application/json" \
  --body "$SCOPE_PATCH" >/dev/null

echo "==> pre-authorizing Teams clients for access_as_user"
az rest --method PATCH \
  --url "https://graph.microsoft.com/v1.0/applications/${TAB_OBJECT_ID}" \
  --headers "Content-Type=application/json" \
  --body "$PREAUTH_PATCH" >/dev/null

# Write SSO settings now — before the bot section — so a bot-step hiccup
# can't leave the server without its token-validation config.
echo "==> writing SSO app settings"
az webapp config appsettings set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$WEBAPP_NAME" \
  --settings \
    AAD_TENANT_ID="$TENANT_ID" \
    SSO_AUDIENCE="$APP_ID_URI" \
    SSO_CLIENT_ID="$TAB_APP_ID" \
  --output table >/dev/null

BOT_APP_ID="$(find_app_id "$BOT_APP_NAME")"
if [[ -z "$BOT_APP_ID" ]]; then
  echo "==> creating bot app registration: $BOT_APP_NAME"
  BOT_APP_ID="$(az ad app create --display-name "$BOT_APP_NAME" --sign-in-audience AzureADMyOrg --query appId -o tsv)"
else
  echo "==> reusing existing bot app registration: $BOT_APP_NAME"
fi
az ad sp create --id "$BOT_APP_ID" >/dev/null 2>&1 || true

BOT_ENDPOINT="https://${WEBAPP_NAME}.azurewebsites.net/api/bot/messages"

# Azure Bot resource names are GLOBALLY unique. If a name clash happens (e.g.
# the bot already exists under a different name like `<prefix>-bot-lof`), don't
# abort the whole run — SSO is already configured above. Pass the existing
# bot's name via AZ_BOT_RESOURCE_NAME for an in-place endpoint update.
BOT_WIRED=0
echo "==> creating/updating Azure Bot resource: $BOT_RESOURCE_NAME"
if az bot show --resource-group "$RESOURCE_GROUP" --name "$BOT_RESOURCE_NAME" >/dev/null 2>&1; then
  if az bot update \
    --resource-group "$RESOURCE_GROUP" \
    --name "$BOT_RESOURCE_NAME" \
    --endpoint "$BOT_ENDPOINT" \
    --output table; then
    BOT_WIRED=1
  fi
elif az bot create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$BOT_RESOURCE_NAME" \
    --app-type SingleTenant \
    --sku F0 \
    --appid "$BOT_APP_ID" \
    --tenant-id "$TENANT_ID" \
    --endpoint "$BOT_ENDPOINT" \
    --output table; then
  BOT_WIRED=1
else
  echo "WARN: bot resource '$BOT_RESOURCE_NAME' could not be created (name may be taken globally)." >&2
  echo "WARN: SSO settings are already applied. If the bot exists under another name," >&2
  echo "WARN: re-run with AZ_BOT_RESOURCE_NAME=<existing-bot-name> to update its endpoint." >&2
fi

# Only mint a new secret + write bot creds when a bot resource was actually
# wired this run. Otherwise we'd point BOT_APP_ID/BOT_APP_PASSWORD at an app
# registration with no Teams-connected bot — breaking the existing install.
BOT_APP_SECRET=""
if [[ "$BOT_WIRED" == "1" ]]; then
  echo "==> creating bot client secret (store this securely)"
  BOT_APP_SECRET="$(az ad app credential reset --id "$BOT_APP_ID" --append --display-name "$BOT_SECRET_DISPLAY_NAME" --years 2 --query password -o tsv)"
  echo "==> writing bot credentials to app settings"
  az webapp config appsettings set \
    --resource-group "$RESOURCE_GROUP" \
    --name "$WEBAPP_NAME" \
    --settings \
      BOT_APP_ID="$BOT_APP_ID" \
      BOT_APP_PASSWORD="$BOT_APP_SECRET" \
      BOT_TENANT_ID="$TENANT_ID" \
    --output table >/dev/null
else
  echo "==> skipping bot credential write (no bot resource wired this run; existing bot creds left intact)"
fi

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
  - Build the Teams package. TEAMS_APP_ID is the Teams *app/package* id (keep
    your existing one to update in place); SSO_APP_ID is this tab app
    registration ($TAB_APP_ID), which fills webApplicationInfo:
      export TEAMS_APP_ID=<existing-teams-app-id> \
             SSO_APP_ID=$TAB_APP_ID \
             BOT_APP_ID=$BOT_APP_ID \
             TEAMS_DOMAIN=$WEBAPP_DOMAIN
      ./scripts/azure/build-teams-package.sh
    (If you have no existing Teams app id, set TEAMS_APP_ID=$TAB_APP_ID too.)
  - If your tenant requires it, grant admin consent for the access_as_user
    scope in Entra (App registrations > $TAB_APP_NAME > API permissions).
OUT

if [[ "$BOT_WIRED" == "1" ]]; then
  cat <<OUT

IMPORTANT: save BOT_APP_PASSWORD securely now (it will not be shown again):
BOT_APP_PASSWORD=$BOT_APP_SECRET
OUT
else
  cat <<OUT

NOTE: no Azure Bot resource was wired this run, so bot credentials were
left untouched. The existing bot install keeps working. Re-run with
AZ_BOT_RESOURCE_NAME set to the existing bot if you need to rotate creds.
OUT
fi
