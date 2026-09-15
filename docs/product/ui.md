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
  this order: View (Grouped / Flat), History, Appearance, and `Collapse all`.
  It used to hold Show (Everyone / Mine) as well; since #390 that is the board's
  All Tasks and My Tasks tabs.
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
  live in [CONTEXT.md](../../CONTEXT.md#the-four-courts). The active courts run
  soonest deadline first; `In flight` first puts the viewer's own tasks above
  Observer tasks (2026-09-12).

- **Flat view.** One list, no sections, sorted into 4 buckets newest-first
  within each: Celebrating (just completed by the viewer) → `OPEN` →
  in-flight (`CLAIMED` / `NEEDS_REVIEW` / `MERGE_DONE` / `MERGE_APPROVED` /
  `AWAITING_ITEMS` / `PENDING_APPROVAL`) → closed (`COMPLETED` / `CANCELLED` /
  `ARCHIVED`).

Neither view shows a Saved for Later task. Those have their own tab.

## All Tasks, My Tasks and Task Drafts tabs

The Tasks board's header is a tab row where its heading used to be: **All
Tasks**, **My Tasks** and **Task Drafts** (#363, three tabs since #390). The
search, the app menu and `New Task` stay where they were, at the right of the
same header.

**Only Task Drafts shows a count, and only when there are drafts** (confirmed
2026-09-14). All Tasks and My Tasks show none; the sections on the board count
their own rows. Task Drafts shows how many drafts there are beside its name when
there is at least one, and nothing when there are none.

**The header is pinned** (#390). It stays at the top of the screen while the
list scrolls under it, on a phone as on a desktop, so the tabs, the search and
`New Task` are always in reach. On a phone it keeps its two lines, tabs on the
first and the search, menu and `New Task` on the second, and both stay pinned.
Menus and dialogs still draw over it. A link to a task scrolls the card into the
space below the header, so the header never covers it.

**On a phone the tabs read `All`, `Mine` and `Drafts`** (under 480px wide). The
full names and their counts do not fit on one line of a 360px phone. Screen
readers still announce the full names. Confirmed 2026-09-12 for every phone
width, including 390px where the full names would just fit, so all phones read
the same.

- **All Tasks** is the board described above, everybody's work. While a loan is
  searched its label is the loan's name (cut short if long, the full name on
  hover).
- **My Tasks** is the same board narrowed to the viewer's own work (see *My
  Tasks* below).
- **Task Drafts** lists the new tasks the viewer put aside with **Save for
  later** on the create form (the button keeps that wording; only the tab says
  Task Drafts). Newest saved first. The tab is always there; its count, shown
  only when there is at least one, is how many rows its page shows. With none, its page says `No task drafts. Use
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
- **The loan search narrows All Tasks only.** Picking a loan opens All Tasks and
  remembers the tab that was open; `Clear search` sits beside the tabs while All
  Tasks is open, and clearing goes back to the remembered tab. My Tasks and Task
  Drafts are never narrowed by it, and a search never shows a draft. Opening a
  card while a search is on ends the search, whichever tab it was opened from,
  as before the tabs existed (confirmed 2026-09-12).
- **All Tasks or My Tasks is remembered; Task Drafts is not.** A reload opens on
  whichever of All Tasks and My Tasks was last open, including after Task Drafts
  was the tab left open. A loan pick does not change what is remembered.
  Opening the create form and leaving it (Save for later, Create, Discard)
  changes no tab, so it closes back onto the tab it was opened from.
- **A link to a task opens a task tab.** It stays on the tab that is open (or,
  during a search, the tab clearing the search would go back to; from Task
  Drafts, whichever of All Tasks and My Tasks was last open), except that a task
  My Tasks hides opens All Tasks, so the link never lands on a card that is not
  there.
- **Collapse all** acts on the list the open tab shows.

**My Tasks** (#334, a tab since #390; it was the app menu's Show row, Everyone
or Mine) combines with either view:

- Only tasks the viewer filed or holds now, plus **every unclaimed task,
  whoever filed it** — unclaimed work is never filtered out. Observer tasks go,
  and so do closed tasks the viewer was not a Party to, so Done on My Tasks is
  the viewer's own finished work.
- An empty My Tasks reads `Nothing of yours right now` with a `Show all tasks`
  link that opens All Tasks. There is no Show link in the header on any tab.
- Someone who had Mine on before the tabs existed opens on My Tasks: the stored
  choice kept its key and its values.
- It is a view over the list the app already has, not a server filter, and the
  admin Tasks tab count ignores it.

The app menu's **History** row sets how far back finished tasks go (#391):
`Last 7 days`, `Last 14 days` (the default), `Last 30 days` or `All`. Every user
has it, and it combines with either view and with both task tabs:

- A closed task stays on the board while it closed inside the window; `All`
  keeps every closed task the app holds. Open and in-flight tasks are never cut,
  however old. Done, its count, the empty states and Collapse all all follow
  it.
- **A loan search ignores it.** With a loan picked the board shows every task on
  that loan, closed ones of any age included. Clearing the search puts the
  window back.
- **A link to a closed task outside the window still lands.** The task opens
  and stays on the board until the page reloads; the History setting itself is
  not changed.
- Persisted per browser. A fresh browser, or a stored value the app does not
  recognise, reads as `Last 14 days`, which is the fixed window the board had
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
- **Every active row names the step it is on, under its type** (PR #427,
  confirmed 2026-09-13), in the same words as the open card's tracker below:
  `Opened`, `Claimed`, `In review`, `Needs corrections`, `Merge done`,
  `Outstanding items`, `Final approval`. It used to show only on a Loan Docs
  mid-merge or a Fraud Check mid-exchange, so most rows had a blank line there.
  A rated task shows its poop rating on every row that is not closed
  (confirmed 2026-09-14): a teammate reads the ratings on claimed work to judge
  who is already buried. It showed only on a task up for grabs from 2026-09-07
  to 2026-09-14.
- **An active row reads the same at every width** (confirmed 2026-09-14): loan
  name, then the task type with its poop rating right beside it (the rating
  describes that work), then the step, then the names. It used to rearrange
  itself by screen width, the rating sharing the step's line and landing beside
  the type, beside the step or under it depending on the screen, and the
  one-line desktop title cut the step short. Rows are a line taller on a wide
  screen as a result. To fit the type and its rating on one line on a phone,
  the row draws the poops smaller than the task menu and the form do, and the
  red new-note dot sits beside the loan name instead of after the type. On the
  narrowest phones (360px) a long type can still push the poops down a line.
  One-line
  closed rows show no step; a creator's just-completed card, which stays
  full-size until it is archived, reads `Completed`. A released Fraud Check at
  final approval reads `Final approval` like a held one (it used to say `Final
  Approval Needed`); `Unclaimed` beside it says nobody holds it.
- **An open card leads with where the task is in its flow** (PR #421,
  confirmed 2026-09-13): the step it is on, `Next` and the step after it, and
  a bar with one segment per step filled up to the current one. On a phone it
  is one line over the bar on every task type; it replaced a rail naming every
  step, which ran to two or three lines there. **On a wider screen every step
  is named under its own segment** (confirmed 2026-09-13), with the bar across
  the whole card and the current step in bold, because the one line looked
  lost on a desktop card. Neither layout ever wraps. An LOI sent back reads
  `Needs corrections` in place of the step name. Finished tasks, archived ones
  included, show green; a cancelled task says `Cancelled` over an empty bar.
- **Each section of an open card has its heading above it, at every width**
  (PR #421, confirmed 2026-09-13): `Outstanding items` on a Fraud Check, the
  Instructions heading on every other type (see
  [task-fields.md](task-fields.md#create-task-fields)), and `Conversation`.
  Wider screens used to put these headings in a column to the left of the
  section; a phone always stacked them, and that is now the only layout.
- **Collapse all**, in the app menu, shuts every card you have open in the list
  you're looking at, in one press, and carries a count of how many are open so
  you can see whether it is worth pressing. Cards behind another tab are
  untouched, and a collapse sticks until you open the card again. There is no
  Expand all — opening cards you never asked for is the behaviour above that
  got removed.

The row's layout and styling live in the code (`TaskCard` in
`apps/web/src/App.tsx` and `apps/web/src/styles.css`). The traps in changing it
are in [apps/web/CLAUDE.md](../../apps/web/CLAUDE.md).

## Metrics Tab

- Admin-only
- Includes: claims leaderboard (see
  [claiming-scoring.md](claiming-scoring.md#claims-leaderboard-metrics-panel)),
  status totals (Total/Active/Completed/Archived/Cancelled — computed over
  every task regardless of the grid's retention-window filter), LOI-to-Loan-
  Docs conversion ratio, and task-type breakdown
