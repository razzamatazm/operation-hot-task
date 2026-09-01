# Current UI Surfaces

- App bar: no brand/title lockup — Teams' own tab chrome already shows the
  app name, so an in-app one would be pure duplication.
  - Local user picker for mock identities (dev only, see
    [auth-identity.md](auth-identity.md))
  - **Tab bar only renders for admins.** Non-admin users see the unified
    task grid directly with no tab bar. Admin tabs, in order:
    - `Tasks` — the unified task grid (see below), with an open/in-flight
      count badge
    - `All Tasks` — every task regardless of status, with a count badge
    - `Metrics` — admin-only, see below
    - `Admin` — user/role management, see
      [roles-permissions.md](roles-permissions.md#admin-panel-users--roles)
- There is no `Leaderboard` tab and no separate `Active`/`Archived` tabs.
  A ranked claims panel lives *inside* Metrics — see
  [claiming-scoring.md](claiming-scoring.md#claims-leaderboard-metrics-panel).
- `New Task` and a **Grouped / flat-list segment** sit on each list's own
  section header (above the `Tasks`, `All Tasks`, and per-loan grids) —
  not in the app bar and not a tab.
- Create-task form: see [task-fields.md](task-fields.md)

## Unified Task Grid

Every task the viewer is allowed to see lives in one list (`unifiedTasks` in
`apps/web/src/App.tsx`) — no separate My / Available / Recent sections.
Assigner and Assignee columns carry "whose court" on every row.

The same list renders two ways, user-selectable from the section header and
persisted per browser:

- **Grouped ("courts") view — the default.** Sectioned into the four courts
  (`Finished` when applicable → `Needs you` → `Up for grabs` → `In flight` →
  `Done`) by `buildCourtSections`. Court definitions and the message-pull rule
  live in [CONTEXT.md](../../CONTEXT.md#the-four-courts).
- **Flat view.** One list, no sections, sorted into 4 buckets newest-first
  within each: Celebrating (just completed by the viewer) → `OPEN` →
  in-flight (`CLAIMED` / `NEEDS_REVIEW` / `MERGE_DONE` / `MERGE_APPROVED` /
  `AWAITING_ITEMS` / `PENDING_APPROVAL`) → closed (`COMPLETED` / `CANCELLED` /
  `ARCHIVED`).

Both views share one retention filter and one card component:
- Closed tasks render as half-height "mini rows" at the bottom of the grid
  (no poop/action columns) rather than living in a separate archived view.
  They're retained for `CLOSED_TTL_DAYS` before dropping off — see
  [reminders-retention.md](reminders-retention.md).
- Every row starts collapsed and stays collapsed until the viewer clicks it
  open; clicking expands it inline to the full detail/action view. Cards never
  open or close themselves — no status change, new note, or refresh moves a
  row either way (#161). The collapsed row carries the primary action and the
  menu, so nothing actionable is behind the fold.

Full row layout, column semantics, and styling conventions are documented in
[apps/web/CLAUDE.md](../../apps/web/CLAUDE.md) — that's the canonical
reference for this component; don't duplicate it here.

## Metrics Tab

- Admin-only
- Includes: claims leaderboard (see
  [claiming-scoring.md](claiming-scoring.md#claims-leaderboard-metrics-panel)),
  status totals (Total/Active/Completed/Archived/Cancelled — computed over
  every task regardless of the grid's retention-window filter), LOI-to-Loan-
  Docs conversion ratio, and task-type breakdown
