import { Request } from "express";
import { isSystemActor, UserIdentity, UserRole } from "@loan-tasks/shared";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "./config.js";

/* Raised when a request cannot be authenticated (401) or is authenticated
   but not allowed (403 — e.g. a deactivated account or non-admin). */
export class AuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

/* Identity resolved from a request, BEFORE roles are applied. Roles live in
   the users table (DB-only model) and are attached by the UserStore. The
   dev/header path is allowed to suggest roles via `headerRoles` so local
   mock-user role switching keeps working. */
export interface AuthIdentity {
  id: string;
  displayName: string;
  email?: string;
  /* Only set on the dev/header path. */
  headerRoles?: UserRole[];
}

const ALLOWED_ROLES: UserRole[] = ["LOAN_OFFICER", "FILE_CHECKER", "ADMIN"];

const parseRoles = (raw: string | undefined): UserRole[] => {
  if (!raw) {
    return ["LOAN_OFFICER"];
  }
  const parts = raw
    .split(",")
    .map((role) => role.trim().toUpperCase())
    .filter((role): role is UserRole => ALLOWED_ROLES.includes(role as UserRole));
  return parts.length > 0 ? parts : ["LOAN_OFFICER"];
};

/* Is Entra SSO wired up on this instance? When it isn't, the `x-user-*` header
   fallback below is live and this is a local dev server — which is the only
   condition under which the dev-only routes in routes.ts are registered. */
export const ssoConfigured = (): boolean =>
  Boolean(config.ssoTenantId) && Boolean(config.ssoAudience ?? config.ssoClientId);

/* Lazily-built, cached JWKS for the configured tenant. `createRemoteJWKSet`
   handles key caching + rotation internally. */
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
const getJwks = (tenantId: string): ReturnType<typeof createRemoteJWKSet> => {
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`)
    );
  }
  return jwks;
};

interface EntraClaims {
  oid?: string;
  sub?: string;
  tid?: string;
  name?: string;
  preferred_username?: string;
  upn?: string;
  email?: string;
}

/* jose tags an expired token with this code (it throws `JWTExpired`). Match on
   the code rather than the message, which is library-internal wording. */
const isExpiredTokenError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: unknown }).code === "ERR_JWT_EXPIRED";

const verifyToken = async (token: string): Promise<AuthIdentity> => {
  const tenantId = config.ssoTenantId!;
  const audience = [config.ssoAudience, config.ssoClientId].filter(
    (value): value is string => Boolean(value)
  );
  let payload: EntraClaims;
  try {
    const result = await jwtVerify(token, getJwks(tenantId), {
      issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      audience
    });
    payload = result.payload as EntraClaims;
  } catch (error) {
    /* An Entra access token lives about an hour; a Teams tab lives all day, so
       an expired token is the ordinary case here, not a failure. The client
       re-acquires and retries on any 401, so what matters is that the message
       is something a loan officer can read — jose's `"exp" claim timestamp
       check failed` was reaching the toast verbatim (#175). Everything else
       gets a generic message with the real reason logged, not returned. */
    if (isExpiredTokenError(error)) {
      throw new AuthError("Your session expired. Reopening the tab will sign you back in.");
    }
    console.error("auth_token_verify_failed", error);
    throw new AuthError("Could not verify your sign-in. Reopen the tab from Teams.");
  }

  if (payload.tid && payload.tid !== tenantId) {
    throw new AuthError("Token tenant mismatch");
  }

  const id = payload.oid ?? payload.sub;
  if (!id) {
    throw new AuthError("Token missing subject");
  }
  if (isSystemActor({ id })) {
    throw new AuthError("`system` is a reserved identity", 403);
  }
  const displayName = payload.name ?? payload.preferred_username ?? payload.upn ?? "Teams User";
  const email = payload.preferred_username ?? payload.upn ?? payload.email;
  return { id, displayName, ...(email ? { email } : {}) };
};

const headerIdentity = (req: Request): AuthIdentity => {
  const id = String(req.header("x-user-id") ?? "local-user");
  /* `system` is the scheduler's reserved identity and bypasses the actor gates
     (ADR-0003). No request may claim it, not even on the dev header path. */
  if (isSystemActor({ id })) {
    throw new AuthError("`system` is a reserved identity", 403);
  }
  const displayName = String(req.header("x-user-name") ?? "Local User");
  const headerRoles = parseRoles(req.header("x-user-roles") ?? undefined);
  return { id, displayName, headerRoles };
};

/* Resolve the caller's identity. Throws AuthError when SSO is required but
   the request can't be authenticated. */
export const authenticate = async (req: Request): Promise<AuthIdentity> => {
  const authHeader = req.header("authorization") ?? req.header("Authorization");
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : null;

  if (bearer && ssoConfigured() && !config.devBypassAuth) {
    return verifyToken(bearer);
  }

  /* No verifiable token. Allowed only in dev / bypass / SSO-not-configured. */
  if (ssoConfigured() && !config.devBypassAuth) {
    throw new AuthError("Authentication required");
  }

  return headerIdentity(req);
};
