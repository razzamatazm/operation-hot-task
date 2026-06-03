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
 *   node scripts/install-bot-for-user.mjs <email-or-oid> [more...]
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

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("Usage: node scripts/install-bot-for-user.mjs <email-or-oid> [more...]");
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

    const res = await graph(token, `/users/${oid}/teamwork/installedApps`, {
      method: "POST",
      body: JSON.stringify({ "teamsApp@odata.bind": `${GRAPH}/appCatalogs/teamsApps/${catalogId}` })
    });

    if (res.status === 201) {
      console.log(`✓ ${target} — installed (bot DM ref will land on first activity)`);
    } else if (res.status === 409) {
      console.log(`• ${target} — already installed`);
    } else {
      throw new Error(`install failed (${res.status}): ${await res.text()}`);
    }
  } catch (error) {
    failures += 1;
    console.error(`✗ ${target} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

process.exit(failures > 0 ? 1 : 0);
