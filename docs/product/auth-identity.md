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
  headers. The web app sends these for whoever is picked in the dev user
  switcher (`apps/web/src/App.tsx` + `apps/web/src/dev-users.ts`, tree-shaken
  from the prod bundle).
- **The switcher's cast is the users table, not a list in the app.** It used to
  carry three names in code, which drifted from the seed data (#309). It now
  reads `GET /api/dev/users` — the same active-people projection the share and
  handoff pickers get from `/api/users/directory`, so a person added to
  `users.json` is switchable without touching the web app, and a deactivated
  one stops being offered.
- **Why a second route.** Every authenticated route provisions its caller
  (`getActor` → `upsertOnLogin`), and the switcher needs the cast *before* it
  is anybody — asking through an authenticated route would invent a placeholder
  person and write them into the list being read. `/api/dev/users` therefore
  takes no identity, and is registered only when SSO is unconfigured. Until it
  answers, the app holds an empty identity and makes no other request.
- The `x-user-*` path — and `/api/dev/users` with it — is disabled whenever SSO
  is configured, so neither can be used on the internet-facing deploy.

Always distinguish this local mock-auth behavior from the production identity
direction in user-facing explanations.
