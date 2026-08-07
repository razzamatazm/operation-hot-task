# Current Auth And Identity Model

- **Production: Microsoft Entra SSO.** The Teams tab acquires a token
  (`authentication.getAuthToken()`); the server verifies it against the tenant
  JWKS in `auth.ts` (validates `iss` / `aud` / `tid`) and resolves the stable
  `oid`. Roles come from the file-based `users` table (`user-store.ts`), seeded
  via the onboarding flow and managed in the admin panel.
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
