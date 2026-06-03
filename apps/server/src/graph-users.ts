import { config } from "./config.js";

/* Resolve an email address to the stable Entra identity (oid + display name)
   via Microsoft Graph app-only auth. Used by the admin "Add User" flow so an
   admin can add someone by email before that person has ever logged in.
   Requires GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET and the
   `User.Read.All` application permission with admin consent. */

export interface ResolvedGraphUser {
  id: string;
  displayName: string;
  email?: string;
}

export const graphConfigured = (): boolean =>
  Boolean(config.graphTenantId && config.graphClientId && config.graphClientSecret);

interface CachedToken {
  token: string;
  expiresAt: number;
}
let cached: CachedToken | null = null;

const getToken = async (): Promise<string> => {
  const now = Date.now();
  if (cached && cached.expiresAt > now + 60_000) {
    return cached.token;
  }
  const body = new URLSearchParams({
    client_id: config.graphClientId!,
    client_secret: config.graphClientSecret!,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials"
  });
  const res = await fetch(`https://login.microsoftonline.com/${config.graphTenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!res.ok) {
    throw new Error(`Graph token request failed (${res.status})`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: json.access_token, expiresAt: now + json.expires_in * 1000 };
  return json.access_token;
};

export const resolveUserByEmail = async (email: string): Promise<ResolvedGraphUser> => {
  if (!graphConfigured()) {
    throw new Error("Graph is not configured on the server (GRAPH_* settings missing)");
  }
  const token = await getToken();
  const url = `${config.graphBaseUrl}/users/${encodeURIComponent(email)}?$select=id,displayName,mail,userPrincipalName`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 404) {
    throw new Error(`No Entra account found for ${email}`);
  }
  if (!res.ok) {
    throw new Error(`Graph user lookup failed (${res.status})`);
  }
  const json = (await res.json()) as {
    id: string;
    displayName?: string;
    mail?: string;
    userPrincipalName?: string;
  };
  const resolvedEmail = json.mail ?? json.userPrincipalName;
  return {
    id: json.id,
    displayName: json.displayName ?? resolvedEmail ?? email,
    ...(resolvedEmail ? { email: resolvedEmail } : {})
  };
};
