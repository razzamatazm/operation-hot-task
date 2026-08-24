/* Teams SSO token cache (issue #175).

   An Entra access token lives about an hour; a Teams tab lives all day. The
   first version of this acquired a token once at mount and held it in a
   module-level variable, so every request after the first hour came back
   401 — with jose's `"exp" claim timestamp check failed` in the toast — even
   though the user's Teams session was perfectly healthy.

   So the token is held only until its own `exp` and then re-acquired.
   `authentication.getAuthToken()` reads the Teams host's own cache, so a
   refresh is cheap and prompts nothing while Teams is signed in.

   Framework-free and dependency-injected (`acquire`, `now`) so it runs under
   node's type stripping in scripts/auth-token-sim-test.mjs — App.tsx wires the
   real teams-js call in. */

/* Re-acquire this long before the real expiry, to cover clock skew between the
   browser and the token service plus the request's own flight time. */
export const TOKEN_EXPIRY_SKEW_MS = 5 * 60_000;

/* Read `exp` out of a JWT without verifying it — the server does the real
   verification; this only decides when to ask Teams for a fresh one. A token
   we can't read gets a 0 expiry, so it is treated as already stale rather than
   trusted forever. */
export const tokenExpiryMs = (token: string): number => {
  try {
    const payload = token.split(".")[1];
    if (!payload) return 0;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const exp = (JSON.parse(json) as { exp?: number }).exp;
    return typeof exp === "number" ? exp * 1000 : 0;
  } catch {
    return 0;
  }
};

export interface TokenCache {
  /* Seed from the bootstrap SSO call. `null` means no Teams host (dev
     browser), which switches callers to the mock-user header path. */
  seed(token: string | null): void;
  /* True once a real token has been seeded, i.e. we are in a Teams tab. */
  ssoEnabled(): boolean;
  /* The bearer to send, or null on the dev/no-host path. `force` discards a
     token the server has already rejected and asks Teams for a new one. */
  get(force?: boolean): Promise<string | null>;
}

export const createTokenCache = (
  acquire: () => Promise<string>,
  now: () => number = Date.now
): TokenCache => {
  let enabled = false;
  let token: string | null = null;
  /* Epoch ms at which `token` stops being usable. 0 = nothing usable cached. */
  let expiry = 0;
  /* De-dupes concurrent refreshes — the board fires several requests at once,
     and they should share one round trip, not race for their own. */
  let pending: Promise<string> | null = null;

  const fresh = (): boolean => token !== null && now() < expiry - TOKEN_EXPIRY_SKEW_MS;

  return {
    seed(next: string | null): void {
      enabled = next !== null;
      token = next;
      expiry = next ? tokenExpiryMs(next) : 0;
    },
    ssoEnabled: () => enabled,
    async get(force = false): Promise<string | null> {
      if (!enabled) return null;
      if (!force && fresh()) return token;
      if (force) {
        token = null;
        expiry = 0;
      }
      if (!pending) {
        pending = acquire()
          .then((next) => {
            token = next;
            expiry = tokenExpiryMs(next);
            return next;
          })
          .finally(() => {
            pending = null;
          });
      }
      return pending;
    }
  };
};
