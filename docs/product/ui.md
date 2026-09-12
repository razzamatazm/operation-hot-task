# Current UI Surfaces

- App bar: no brand/title lockup — Teams' own tab chrome already shows the
  app name, so an in-app one would be pure duplication.
  - Local user picker for mock identities (dev only, see
    [auth-identity.md](auth-identity.md))
  - **Tab bar only renders for admins.** Non-admin users see the unified
    task grid directly with no tab bar. Admin tabs, in order:
    - `Tasks` — the unified task grid (see below), with an open/in-flight
      count badge
    - `Metrics` — admin-only, see below
    - `Admin` — user/role management, see
      [roles-permissions.md](roles-permissions.md#admin-panel-users--roles)
- There is no `Leaderboard` tab, no `All Tasks` tab (removed in #391; how far
  back finished tasks go is the app menu's History setting, for everyone) and
  no separate `Active`/`Archived` tabs.
  A ranked claims panel lives *inside* Metrics — see
  [claiming-scoring.md](claiming-scoring.md#claims-leaderboard-metrics-panel).
- **`New Task` and an app menu** sit at the right-hand end of the Tasks board's
  section header — not in the app bar and not a tab. The pair is sized and
  spaced to land on top of the action column in the rows below: the menu over
  every hamburger, `New Task` over every quick action.
- The **app menu** holds the settings that are not decisions about a task, in
  this order: View (Grouped / Flat), Show, History, Appearance, and
  `Collapse all`.
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

- **Flat view.** One list, no sections, sorted into 4 buckets newest-first
  within each: Celebrating (just completed by the viewer) → `OPEN` →
  in-flight (`CLAIMED` / `NEEDS_REVIEW` / `MERGE_DONE` / `MERGE_APPROVED` /
  `AWAITING_ITEMS` / `PENDING_APPROVAL`) → closed (`COMPLETED` / `CANCELLED` /
  `ARCHIVED`).

Neither view shows a Saved for Later task. Those have their own tab.

## Tasks and Task Drafts tabs

The Tasks board's header is a tab row where its heading used to be: **Tasks**
with its count, then **Task Drafts** with its count (#363). The search, the app
menu and `New Task` stay where they were, at the right of the same header.

- **Tasks** is the board described above. Its label is whatever the heading
  said: `Tasks`, `My tasks` with Mine on, or a searched loan's name. Its count
  is the number of tasks shown.
- **Task Drafts** lists the new tasks the viewer put aside with **Save for
  later** on the create form (the button keeps that wording; only the tab says
  Task Drafts). Newest saved first. The tab is always there, and its count is
  how many rows its page shows. With none, its page says `No task drafts. Use
  Save for later on a new task to keep one here.` Only their owner ever sees
  them. The viewer's autosave is listed here too (#371), as one more row placed
  by when it was last written, reading `Autosaved N ago` instead of `saved N
  ago`; tapping it opens New Task on it, and its delete forgets it (see
  [task-fields.md](task-fields.md#create-task-fields)). Each
  row is the loan as it was typed (or `No loan yet`; on an Out of Office task,
  the vacation description or `No description yet`, #362), the task type and
  `saved N ago`, and nothing else: no who-to-whom, due time or poop rating. Tapping a row
  reopens the create form on it, every field restored, to save for later again
  or to create (see [task-fields.md](task-fields.md#create-task-fields)). A
  delete control at the row's right end asks `Delete this saved task?` in the
  row, and a yes removes it for good (#345). See
  [ADR-0011](../adr/0011-saved-for-later-is-private-server-state.md).
- **Mine and the loan search act on the Tasks tab only.** Neither narrows Task
  Drafts, and a search never shows a draft. `Clear search` and `Show everyone`
  sit beside the tabs only while Tasks is open. Picking a loan from the search
  opens the Tasks tab, since that is the list it narrows, and so does a link
  to a task.
- **The open tab is not remembered.** The board opens on Tasks after a reload.
  Opening the create form and leaving it (Save for later, Create, Discard)
  changes no tab, so it closes back onto the tab it was opened from.

Separately, the app menu's **Show** row narrows the Tasks board (#334), and it
combines with either view:

- **Everyone — the default.** The whole list above.
- **Mine.** Only tasks the viewer filed or holds now, plus **every unclaimed
  task, whoever filed it** — unclaimed work is never filtered out. Observer
  tasks go, and so do closed tasks the viewer was not a Party to, so Done under
  Mine is the viewer's own finished work. While it is on, the Tasks tab reads
  `My tasks`, its count is the number shown, and a `Show everyone` link beside
  it switches back; an empty result reads `Nothing of yours right now` with the
  same link. Collapse all acts on the filtered list. A link that opens a task
  Mine hides (a Share DM, say) switches the board back to Everyone, so the link
  never lands on a card that is not there. Persisted per browser. It
  is a view over the list the app already has, not a server filter, and the
  admin Tasks tab count ignores it.

The app menu's **History** row sets how far back finished tasks go (#391):
`Last 7 days`, `Last 14 days` (the default), `Last 30 days` or `All`. Every user
has it, and it combines with either view and with Show:

- A closed task stays on the board while it closed inside the window; `All`
  keeps every closed task the app holds. Open and in-flight tasks are never cut,
  however old. Done, its count, the Tasks tab's count, the empty states and
  Collapse all all follow it.
- **A loan search ignores it.** With a loan picked the board shows every task on
  that loan, closed ones of any age included. Clearing the search puts the
  window back.
- **A link to a closed task outside the window still lands.** The task opens
  and stays on the board until the page reloads; the History setting itself is
  not changed.
- Persisted per browser. Nothing is stored for anything unrecognised, so a
  fresh browser is on `Last 14 days`, which is the fixed window the board had
  before the setting existed. The admin Tasks tab count is open work only, so
  History does not change it. It is a view over what the server sends, and the
  server's own auto-archive and purge are unchanged (see
  [status-model.md](status-model.md#done-view-retention-ui)).

Both views share one card component:
- Closed tasks render as half-height "mini rows" at the bottom of the grid
  (no poop/action columns) rather than living in a separate archived view.
  How long they stay is the History setting above — see
  [reminders-retention.md](reminders-retention.md) for what the server keeps.
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
