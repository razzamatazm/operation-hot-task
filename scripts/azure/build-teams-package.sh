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

need jq
need zip

TEAMS_APP_ID="${TEAMS_APP_ID:-}"
BOT_APP_ID="${BOT_APP_ID:-}"
WEBAPP_NAME="${AZ_WEBAPP_NAME:-operation-hot-task-app}"
DOMAIN="${TEAMS_DOMAIN:-${WEBAPP_NAME}.azurewebsites.net}"
MANIFEST_TEMPLATE="teams-app/manifest.json"
MANIFEST_OUT="teams-app/manifest.generated.json"
PACKAGE_OUT="teams-app/operation-hot-task-teams.zip"
TMP_DIR="$(mktemp -d /tmp/operation-hot-task-teams-XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

if [[ -z "$TEAMS_APP_ID" || -z "$BOT_APP_ID" ]]; then
  echo "TEAMS_APP_ID and BOT_APP_ID must be set" >&2
  exit 1
fi

jq \
  --arg appId "$TEAMS_APP_ID" \
  --arg botId "$BOT_APP_ID" \
  --arg domain "$DOMAIN" \
  '
    .id = $appId
    | .bots[0].botId = $botId
    | .staticTabs[0].contentUrl = ("https://" + $domain + "/")
    | .staticTabs[0].websiteUrl = ("https://" + $domain + "/")
    | .configurableTabs[0].configurationUrl = ("https://" + $domain + "/")
    | .validDomains = [$domain]
  ' \
  "$MANIFEST_TEMPLATE" > "$MANIFEST_OUT"

rm -f "$PACKAGE_OUT"
cp "$MANIFEST_OUT" "$TMP_DIR/manifest.json"
cp teams-app/color.png "$TMP_DIR/color.png"
cp teams-app/outline.png "$TMP_DIR/outline.png"
(cd "$TMP_DIR" && zip -r "$ROOT_DIR/$PACKAGE_OUT" manifest.json color.png outline.png >/dev/null)

cat <<OUT
teams_package_ready
manifest=$MANIFEST_OUT
zip=$PACKAGE_OUT
OUT
