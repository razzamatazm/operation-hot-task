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
- **`New Task` and an app menu** sit at the right-hand end of each list's own
  section header (above the `Tasks` and `All Tasks` grids) — not in the app bar
  and not a tab. The pair is sized and spaced to land on top of the action
  column in the rows below: the menu over every hamburger, `New Task` over every
  quick action.
- The **app menu** holds the settings that are not decisions about a task:
  the Grouped / flat list toggle, an appearance control, and `Collapse all`.
  They moved off the list header because they are preferences rather than
  actions — set once and then left alone, next to a button pressed all day.
- **Appearance** is `Match Teams` (the default), `Light`, `Dark` or
  `High contrast`. `Match Teams` is the behaviour the app has always had,
  including switching live when Teams switches. Any other choice pins the app
  and stops it following Teams. Persisted per browser.
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

  **Saved for Later** sits right after `Needs you` (and keeps that place when
  `Needs you` is empty). It lists the new tasks the viewer put aside with
  **Save for later** on the create form, newest saved first, with a count in the
  heading. It is not a court and holds no tasks: only its owner ever sees it,
  it is hidden when they have none, and it does not collapse. Each row is the
  loan as it was typed (or `No loan yet`), the task type and `saved N ago`, and
  nothing else: no who-to-whom, due time or poop rating. Tapping a row does
  nothing yet. See
  [ADR-0011](../adr/0011-saved-for-later-is-private-server-state.md). Flat view
  does not show them yet.
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
- **Collapse all**, in the app menu, shuts every card you have open in the list
  you're looking at, in one press, and carries a count of how many are open so
  you can see whether it is worth pressing. Cards behind another tab are
  untouched, and a collapse sticks until you open the card again. There is no
  Expand all — opening cards you never asked for is the behaviour above that
  got removed.

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
