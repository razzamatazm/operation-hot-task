# Team Rollout Plan — Real Teams Identity

Goal: remove the mock user selector. Each Teams user becomes a real,
persistent user. Channel + DM + activity-feed notifications keep working,
targeting real Azure AD (Entra) identities.

Status: **Phases 1 & 2 done** (2026-05-29). Phases 3–4 not started.

> **Phase 2 notes / deviations**
> - **No drizzle.** The app is file-JSON storage (see CLAUDE.md), so the
>   "users table" is a file-based `UserStore` (`apps/server/src/user-store.ts`,
>   `data/users.json`) mirroring `TaskStore`'s contract — same swap-to-Azure-SQL
>   story. `PersistedUser`: `id` (=oid), `email?`, `displayName`, `roles`,
>   `teamsUserId?` (Phase 3), `createdAt`, `lastSeenAt`.
> - **Real token verification** (`auth.ts`): `jose` `createRemoteJWKSet` +
>   `jwtVerify` against `login.microsoftonline.com/<tenant>/discovery/v2.0/keys`,
>   validating `iss`, `aud` (App ID URI and/or client id), and `tid`. The
>   Phase-1 unverified decode is **gone**. `AuthError` → HTTP 401.
> - **Config** (`config.ts` + `.env.example`): `AAD_TENANT_ID`,
>   `SSO_AUDIENCE`, `SSO_CLIENT_ID`, `DEV_BYPASS_AUTH`, `USERS_FILE`. SSO is
>   "configured" once tenant + an audience are set; until then (or with
>   `DEV_BYPASS_AUTH=true`) the server accepts `x-user-*` dev headers.
> - **Role resolution** (DB-only): dev/header path → header roles are
>   authoritative (mock-user switching still works); token path → existing
>   user keeps stored roles, new user defaults `LOAN_OFFICER`.
> - **Admin endpoints**: `GET /api/users`, `PUT /api/users/:id/roles`
>   (ADMIN-gated) for onboarding + the future admin UI.
> - **Onboarding seed**: `scripts/seed-users.mjs <roster.json>` upserts the
>   roster into `users.json` (produce roster from Graph
>   `GET /teams/{id}/members`).
> - `getActor` now: `authenticate(req)` → `userStore.upsertOnLogin` →
>   `service.registerUser`. Mutation routes map `AuthError` → 401 via
>   `sendError`.
> - **Watch-out items resolved**: unverified decode replaced by JWKS verify;
>   placeholders surfaced as env vars (`.env.example`) + manifest `YOUR-…`
>   tokens (still must be filled from the Entra app registration before a
>   real Teams test). `/stream` remains unauthenticated (EventSource can't
>   send a Bearer header) — acceptable while it only broadcasts task changes;
>   revisit if it ever needs per-user gating.

> **Phase 1 notes / deviations**
> - `webApplicationInfo` added to `teams-app/manifest.json`; the
>   `operation-hot-task-teams/manifest.json` copy already had it — its
>   `resource` was fixed to the `api://<host>/<appId>` form. Both bumped to
>   `1.1.0`. App-id / Entra-id values are still `YOUR-…` placeholders.
> - `apps/web/src/App.tsx`: SSO bootstrap (`authentication.getAuthToken()`
>   → `GET /api/me` → `setUser`), `Authorization: Bearer` in `apiRequest`,
>   mock `<select>` now gated behind `import.meta.env.DEV` (kept, not
>   deleted — Phase 4 removes it). Module-level `authToken` feeds the
>   standalone `apiRequest` helper.
> - `GET /api/me` added in `routes.ts` (listed under Phase 1 but server-side).
> - `auth.ts` now reads the Bearer token but **decodes it WITHOUT verifying
>   the signature** — a deliberate Phase-1 stopgap so the flow works
>   end-to-end. **Not internet-safe until Phase 2** adds `jose` JWKS
>   verification (aud/iss/tid) + DB role lookup. Header/dev fallback retained.
> - `UserIdentity` gained an optional `email` field (shared types).
> - EventSource `/stream` can't send a Bearer header; it's currently
>   unauthenticated, so no change needed — revisit if `/stream` ever gates
>   on identity.

---

## Onboarding flow (do this with Tyler before Phase 4)

1. Enumerate the team's members via Microsoft Graph
   (`GET /teams/{teamId}/members` or `/groups/{id}/members`). Needs Graph
   app permission `TeamMember.Read.All` or `GroupMember.Read.All` on the
   server's app registration.
2. Present the roster to Tyler — display name + email per member.
3. Ask Tyler the role for each user: `LOAN_OFFICER`, `FILE_CHECKER`, or
   `ADMIN` (a user may hold multiple).
4. Seed the `users` table from Tyler's answers (id = AAD `oid`).
5. New members who join later auto-create on first authenticated request
   with a default role (`LOAN_OFFICER`); Tyler promotes via admin UI.

---

## Phase 1 — Teams SSO in the web app

1. Provision / confirm Entra app registration (see `docs/AZURE_DEPLOYMENT.md`):
   - Application ID URI `api://<host>/<appId>`.
   - Expose `access_as_user` scope.
   - Pre-authorize Teams client IDs (`1fec8e78-bce4-4aaf-ab1b-5451cc387264`,
     `5e3ce6c0-2b1f-4285-8d4b-75ee78787346`, desktop/web/mobile variants).
2. Update `teams-app/manifest.json` and
   `teams-app/operation-hot-task-teams/manifest.json`:
   - Add `webApplicationInfo` block (`id` = Entra app id,
     `resource` = App ID URI).
   - Bump manifest `version`.
3. Web app auth bootstrap (`apps/web/src/App.tsx`):
   - After `teamsApp.initialize()` (~line 863), call
     `authentication.getAuthToken()` to get the SSO JWT.
   - Resolve identity via a new `GET /api/me` endpoint (server decodes
     token) → `{ id, displayName, email, roles }`.
   - Delete `mockUsers` import, `INITIAL_USER`, and the user `<select>`
     in the header (~lines 1075–1084).
   - Replace `x-user-id` / `x-user-name` / `x-user-roles` headers with
     `Authorization: Bearer <token>` in `apiRequest` (~lines 36–45).
4. Local dev fallback: if `teamsApp.initialize()` fails (plain browser),
   keep a dev-only mock path behind `import.meta.env.DEV`.

## Phase 2 — Server token validation + user persistence

1. Rewrite `apps/server/src/auth.ts`:
   - Verify `Authorization: Bearer` JWT with `jose` against the Entra
     JWKS endpoint.
   - Validate `aud` = App ID URI, `iss` =
     `https://login.microsoftonline.com/<tenant>/v2.0`, `tid` = tenant.
   - Extract `oid` (stable id), `name`, `preferred_username` (email).
2. Add a `users` table (drizzle migration):
   `id` (= AAD `oid`), `email`, `displayName`, `roles` (JSON array),
   `teamsUserId` (nullable — see Phase 3), `createdAt`, `lastSeenAt`.
   Upsert on every authenticated request.
3. Role source — chosen approach: **DB-only**. Token gives identity;
   the `users` table gives roles. Seeded via the onboarding flow above.
   (Alternative considered: Entra app roles — rejected to keep role
   management in-app, no Azure portal round-trips.)
4. Add `GET /api/me` returning the resolved + persisted identity.

## Phase 3 — Notifications

Routing already exists in `apps/server/src/notifications.ts`. Changes:

1. Channel posts — unchanged. `TEAMS_CHANNEL_WEBHOOK_URL` keeps firing on
   `createTask` / `claimTask` / `transitionStatus` in
   `apps/server/src/task-service.ts`.
2. DMs — `botClient.sendToDmUsers()` needs **Teams** user IDs, not AAD
   `oid`s. Capture each user's Teams `userId` from the bot conversation
   reference on first bot interaction and store it as `users.teamsUserId`.
   Update DM call sites to pass `teamsUserId`.
3. Activity feed — `ActivityFeedClient.sendToUsers()` already wants AAD
   `oid`; correct once Phase 2 lands.
4. Audit `task-service.ts` for missing notification hooks. Today covered:
   `createTask`, `claimTask`, `unclaimTask`, `transitionStatus`. Verify
   `MERGE_DONE` and `COMPLETED` both fire a CHANNEL event.

## Phase 4 — Cleanup

1. Delete `apps/web/src/mockUsers.ts`.
2. Remove `x-user-*` header docs from `README.md` (~lines 99–105).
3. Update `AGENTS.md` auth section → "Entra SSO, no headers."
4. Migration: backfill `users` from existing task `creator` / `assignee`
   JSON snapshots so historical data resolves names.

---

## Consents & permissions (one admin request covers all phases)

All Graph permissions are **Application** type and granted to a dedicated
service-principal app registration (`oht-teams-publisher`). Every one
needs **Grant admin consent** for the tenant.

| Permission | Phase | Why |
|---|---|---|
| `AppCatalog.ReadWrite.All` | publish | Push new app version to the org catalog (auto-update all users) |
| `User.Read.All` | 2 | Read user `oid` / email / name to seed the `users` table |
| `TeamMember.Read.All` | 2 onboarding | Enumerate the team roster to assign roles |
| `TeamsActivity.Send` | 3 | Send activity-feed notifications |
| `TeamsAppInstallation.ReadWriteForUser.All` | 3–4 | Programmatically install the app for users |

Two non-Graph admin actions:

- **Tenant-wide admin consent for the Tab app's `access_as_user` scope**
  (Phase 1 SSO) — so users get no consent prompt on first open. Done on
  the SSO/tab Entra app registration.
- **Teams app setup policy** (optional, Phase 4) — alternative to
  `TeamsAppInstallation.ReadWriteForUser.All`; pins the app for all users
  via Teams Admin Center, no Graph call.

No consent needed for: channel webhook posts, bot DM / channel posts —
Bot Framework handles those with the existing bot credentials.

## Risks / order-of-operations

- Ship Phase 1 + Phase 2 **together** — a Bearer token is useless while
  the server still trusts headers.
- Bot DMs require each user to have the app installed **personally**
  (channel install ≠ personal install). May need a Teams admin app
  install policy to push it to everyone.
- Key all identity on AAD `oid`, never email — email can change.
- Keep a `DEV_BYPASS_AUTH=true` server flag recreating today's header
  behavior so local dev still works without a Teams tab.

## Effort estimate

- Phase 1: ~half day.
- Phase 2: 1–2 days.
- Phase 3: ~half day.
- Phase 4: a few hours.
