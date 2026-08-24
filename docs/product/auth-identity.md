# Current Auth And Identity Model

- **Production: Microsoft Entra SSO.** The Teams tab acquires a token
  (`authentication.getAuthToken()`); the server verifies it against the tenant
  JWKS in `auth.ts` (validates `iss` / `aud` / `tid`) and resolves the stable
  `oid`. Roles come from the file-based `users` table (`user-store.ts`), seeded
  via the onboarding flow and managed in the admin panel.
- **The tab refreshes its own token.** An Entra access token is good for about
  an hour and a Teams tab stays open all day, so the web app holds a token only
  until its own `exp` (minus a 5-minute skew) and then re-acquires — see
  `apps/web/src/auth-token.ts`. A 401 on the SSO path also forces one
  re-acquire and retry, for a token that dies mid-request. Refreshing reads the
  Teams host's cache, so it prompts nothing while the user's Teams session is
  alive. Server-side, an expired token returns a readable "session expired"
  message; other verification failures are logged, not returned, so library
  internals never reach the UI.
- **Local dev fallback only:** when SSO env is unset (plain browser, no Teams
  host), the server trusts `x-user-id` / `x-user-name` / `x-user-roles`
  headers. The web app sends these from a dev-only `DEV_USERS` list (in
  `apps/web/src/App.tsx`, tree-shaken from the prod bundle):
  - `Suzie`: loan officer
  - `Alexa`: loan officer + file checker
  - `Johanna`: loan officer + file checker + admin
- The `x-user-*` path is disabled whenever SSO is configured, so it can never
  be used on the internet-facing deploy.

Always distinguish this local mock-auth behavior from the production identity
direction in user-facing explanations.
