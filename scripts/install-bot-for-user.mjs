#!/usr/bin/env node
/*
 * Seed a user's bot install (Phase 3 team rollout).
 *
 * A proactive bot DM only works once a conversation reference exists, and a
 * reference is only created when the app is installed for the user and the
 * bot receives its first activity. Most users self-install; this script
 * covers the stragglers by installing the app *for* them via Graph, which
 * triggers the bot's installationUpdate and seeds the DM reference.
 *
 * Usage:
 *   node scripts/install-bot-for-user.mjs [--no-reinstall] <email-or-oid> [more...]
 *
 * Already-installed users are reinstalled (remove + re-add) by default so a
 * fresh installationUpdate fires and the bot captures their DM reference —
 * the straggler this script exists to repair. --no-reinstall reverts to a
 * report-and-skip on 409.
 *
 * Required env (the publisher app registration — `oht-teams-publisher`):
 *   GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET
 *   TEAMS_APP_ID   = the Teams manifest app id (externalId in the catalog)
 *
 * Graph application permission required (admin-consented):
 *   TeamsAppInstallation.ReadWriteForUser.All
 * (User.Read.All is also used to resolve an email argument to an oid.)
 *
 * Idempotent: a 409 "already installed" is reported, not fatal.
 */
const GRAPH = process.env.GRAPH_BASE_URL ?? "https://graph.microsoft.com/v1.0";
const { GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, TEAMS_APP_ID } = process.env;

const argv = process.argv.slice(2);
/* By default an already-installed user is reinstalled (remove + re-add) so a
   fresh installationUpdate fires and the bot captures a DM reference — the
   straggler case this script exists to repair. --no-reinstall keeps the old
   "report and skip" behaviour. */
const reinstall = !argv.includes("--no-reinstall");
const targets = argv.filter((arg) => !arg.startsWith("--"));
if (targets.length === 0) {
  console.error("Usage: node scripts/install-bot-for-user.mjs [--no-reinstall] <email-or-oid> [more...]");
  process.exit(1);
}
for (const [k, v] of Object.entries({ GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, TEAMS_APP_ID })) {
  if (!v) {
    console.error(`Missing required env: ${k}`);
    process.exit(1);
  }
}

const getToken = async () => {
  const body = new URLSearchParams({
    client_id: GRAPH_CLIENT_ID,
    client_secret: GRAPH_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials"
  });
  const res = await fetch(`https://login.microsoftonline.com/${GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!res.ok) {
    throw new Error(`Token request failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()).access_token;
};

const graph = async (token, path, init = {}) => {
  const res = await fetch(`${GRAPH}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) }
  });
  return res;
};

const isOid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const token = await getToken();

// Resolve the catalog teamsApp id (the org-catalog id, distinct from the
// manifest/externalId id used in TEAMS_APP_ID).
const catalogRes = await graph(token, `/appCatalogs/teamsApps?$filter=externalId eq '${TEAMS_APP_ID}'&$select=id,displayName`);
if (!catalogRes.ok) {
  console.error(`Catalog lookup failed (${catalogRes.status}): ${await catalogRes.text()}`);
  process.exit(1);
}
const catalogApps = (await catalogRes.json()).value ?? [];
if (catalogApps.length === 0) {
  console.error(`No catalog app found with externalId ${TEAMS_APP_ID}. Is the app published to the org catalog?`);
  process.exit(1);
}
const catalogId = catalogApps[0].id;
console.log(`Catalog app: ${catalogApps[0].displayName} (${catalogId})`);

let failures = 0;
for (const target of targets) {
  try {
    let oid = target;
    if (!isOid(target)) {
      const ures = await graph(token, `/users/${encodeURIComponent(target)}?$select=id,displayName`);
      if (!ures.ok) {
        throw new Error(`user lookup failed (${ures.status})`);
      }
      oid = (await ures.json()).id;
    }

    const install = () =>
      graph(token, `/users/${oid}/teamwork/installedApps`, {
        method: "POST",
        body: JSON.stringify({ "teamsApp@odata.bind": `${GRAPH}/appCatalogs/teamsApps/${catalogId}` })
      });

    let res = await install();

    if (res.status === 409) {
      // Already installed. A bare 409 fires no bot activity, so a user whose
      // DM ref was never captured (server missed the install event, or
      // bot-references.json was reset) stays unreachable. Reinstall to force
      // a fresh installationUpdate.
      if (!reinstall) {
        console.log(`• ${target} — already installed (skipped; pass without --no-reinstall to refresh the DM ref)`);
        continue;
      }
      const listRes = await graph(
        token,
        `/users/${oid}/teamwork/installedApps?$expand=teamsApp&$filter=teamsApp/externalId eq '${TEAMS_APP_ID}'&$select=id`
      );
      if (!listRes.ok) {
        throw new Error(`already installed; lookup for reinstall failed (${listRes.status})`);
      }
      const installId = ((await listRes.json()).value ?? [])[0]?.id;
      if (!installId) {
        throw new Error("already installed but installation id not found; ask the user to message the bot once");
      }
      const delRes = await graph(token, `/users/${oid}/teamwork/installedApps/${installId}`, { method: "DELETE" });
      if (delRes.status === 403) {
        // App is pinned by an app setup policy — per-user uninstall is blocked,
        // so we can't force a fresh installationUpdate. Such installs also
        // don't deliver an installationUpdate to the bot until the user opens
        // the chat, which is the only remaining way to seed their DM ref.
        console.log(`• ${target} — already installed but pinned by an app setup policy (can't reinstall). Ask them to open the bot chat once to seed the DM ref.`);
        continue;
      }
      if (!delRes.ok && delRes.status !== 404) {
        throw new Error(`reinstall: remove failed (${delRes.status})`);
      }
      res = await install();
    }

    if (res.status === 201) {
      console.log(`✓ ${target} — installed (bot DM ref lands on the next bot activity)`);
    } else {
      throw new Error(`install failed (${res.status}): ${await res.text()}`);
    }
  } catch (error) {
    failures += 1;
    console.error(`✗ ${target} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

process.exit(failures > 0 ? 1 : 0);
