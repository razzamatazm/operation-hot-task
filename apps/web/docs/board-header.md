# The Tasks board header

The long form of the header rules in [../CLAUDE.md](../CLAUDE.md), moved out of
that file on 2026-09-14 so it loads only when it is needed. Read it before
changing the All / Mine / Drafts tabs, the loan search or the app menu.

- List header (`.task-grid-head`): heading and count left, then the app menu,
  then `New Task` hard right. On the Tasks board the heading is a tab row
  (`BoardTabs`, [src/board-tabs.tsx](../src/board-tabs.tsx), #363, three tabs
  since #390): `All`, `Mine` and `Drafts`, each the heading's own
  type, the open one in ink over a `--brand`
  underline and the others muted, no fill or box. **Only Drafts carries a
  count, and only while there is a draft** (the user's call, 2026-09-14): a
  `.section-count` chip beside it when there is at least one, nothing at zero.
  All and Mine carry none; the sections under them count their own rows. All Tasks is the board under
  Everyone and My Tasks the board under Mine; they replaced the app menu's Show
  row and the header's `Show everyone` link, and there is no Show link in the
  header on any tab. While a loan is searched All Tasks carries the loan's name,
  the one label that ellipsizes; the other two never shrink. **The tabs read
  `All`, `Mine` and `Drafts` at every width** (the user's call, 2026-09-12).
  The full names were swapped for these under 480px only, and phones and
  narrow windows above that still cut them off, so there is one set of names
  on screen now and no breakpoint. A screen reader still hears `All Tasks`,
  `My Tasks` and `Task Drafts` from an `sr-only` span, with the short name
  `aria-hidden`. A searched loan's name has no second form. The header
  also takes `min-width: 0`, since a grid item's content minimum let an
  over-wide tab row push the whole page sideways. The actions group
  is untouched, still pushed right by `margin-left: auto`, so the tabs never
  move the search, the menu or `New Task`. Under 480px the header wraps as
  before: tabs on the first line, the actions right-aligned on the next.
  **The header is pinned** (#390): `position: sticky` at `top: 0`, `--bg`
  behind it and a `--line-soft` hairline under it, no shadow, z-index 30, so
  every portaled layer (row menu 55, popovers and toasts 60, form overlay 50,
  confirm dialogs 70) draws over it while its own app menu and search panels
  (40, inside its stacking context) draw over the rows. Both phone lines stay
  pinned. It works because the page scrolls on the document and nothing above
  the header clips; an `overflow` on `.app-shell` or `body` would silently
  unpin it. A linked card is scrolled by `pinnedScrollTop`
  ([src/panel-placement.ts](../src/panel-placement.ts)), not by
  `scrollIntoView({ block: "center" })`: centring in the whole viewport put the
  top of a tall expanded card, which is what a link opens, under the header on a
  phone, so it centres in the room below the header and top-aligns a card
  taller than that room. The open tab is `boardTab` in App, opened on the stored
  Show value's tab (`tabForShow`) and chosen through `selectBoardTab`, which
  writes All / My back to `BOARD_SHOW_KEY` (`showForTab`) and never stores Task
  Drafts. A loan pick sets the tab without storing it and remembers the tab it
  came from for `Clear search` to return to. Leaving the create form changes no
  tab. What sits under the row is `boardBody` in
  [src/board-filter.ts](../src/board-filter.ts): an empty search on All Tasks, an
  empty Mine on My Tasks (with `Show all tasks`, which opens All Tasks). The
  pair is built to land on the action column of
  the rows below — same 32px trigger, same 6px gap, same `--quick-action-w`
  button, and the header carries the row's own right inset (its padding plus
  the card's 1px border). Read down the right edge and the menu sits over every
  hamburger, `New Task` over every quick action.
- Loan search (`.loan-search`, [src/loan-search.tsx](../src/loan-search.tsx),
  #333): a magnifier left of the app menu, on the Tasks header. It wears `.app-menu-trigger`, so it is the same 32px box with
  the same touch overlay, and because the actions group is pushed right by
  `margin-left: auto` it grows the group leftwards. The menu and `New Task` do
  not move. The 8px between the two triggers is what keeps their 40px overlays
  from meeting; don't tighten it. The box is a panel anchored to the actions
  group's right edge, `min(360px, 100vw - 32px)` wide, so it fits a 360px phone,
  and its input takes the touch 16px floor like every other field.
  Suggestions are the create form's ranking at the create form's limit
  (`loanSearchResults`, and a test fails if the two limits drift). A pasted
  Humperdink link is looked up by shared `findLoanForCreate` instead, because that
  ranking only reads names. Picking narrows All Tasks through
  `visibleBoardTasks`, so that tab's label, sections, empty state and
  Collapse all follow it. While narrowed All Tasks reads the loan's name, with
  `Clear search` beside the tabs while All Tasks is open. It never narrows My
  Tasks or Task Drafts (#390): `visibleBoardTasks` applies a loan only on
  Everyone, because it answers "where are we on this file", which is the whole
  file, not the viewer's slice of it. Picking a loan opens All Tasks without
  storing it and remembers the open tab; clearing returns there. Opening a card
  while a search is on ends the search through the deep-link focus path, from
  any tab (the user's call on #390, keeping the behaviour from before the tabs),
  which is also why a link arriving mid-search clears it. The focus path starts from the tab
  `Clear search` would return to (the open tab when nothing is searched, the
  stored one from Task Drafts), so both ways out of a search land in the same
  place, and opens All Tasks when that tab is My Tasks and would hide the
  opened task (`tabForLink`), since the board it returns to has to hold that
  card. The
  scroll is its own step (`scrollTaskId`), taken on the commit after
  the board changes: scrolled in the same pass, it aimed at where the card sat
  on the narrowed board. The suggestion list itself is `LoanSuggestionList`,
  shared with the create form's typeahead; each keeps its own box and keys.
  Escape closes the box and is stopped at its wrapper.
  Never stored: a reload is the full board.
- App menu (`.app-menu`): the preferences that are not decisions about a task,
  in this order (the user's, 2026-09-12) — Collapse all, View (Grouped/Flat),
  Appearance (`Teams` / `Light` / `Dark` / `Contrast`), and History
  (`7 days` / `14 days` / `30 days` / `All`, #391). Show
  (Everyone/Mine) left it in #390 to become the All Tasks and My Tasks tabs.
  The Tasks board is the only list with a header, so it is the only menu.
  History is a row of its own rather than more View choices because it combines
  with both, and the list it narrows comes from `visibleBoardTasks` in
  [src/board-filter.ts](../src/board-filter.ts), which every consumer of the board
  list reads. It is stored per browser beside Grouped (`BOARD_HISTORY_KEY`, and
  the tabs' `BOARD_SHOW_KEY`), parsed so anything unrecognised is the default.
  Collapse all acts on the list the open tab renders, and on Task Drafts has
  nothing to close.
  **Each setting is one connected track on one line** (2026-09-12, the user
  found the old menu busy): `.app-menu-choices` is a hollow track and the chosen
  `.app-menu-choice` takes the fill, the same shape as the task form's Share /
  Assign control. It used to be a bordered pill per choice, ten boxes that
  wrapped History and Appearance onto ragged second lines. One line is what the
  shorter labels buy: `Last` went because the heading already says History, and
  Appearance shows `Teams` and `Contrast` while each button's accessible name
  stays `Match Teams` and `High contrast`. Collapse all, labelled
  `Collapse All Tasks` (the user's wording, 2026-09-12), leads the panel as a
  full-width outlined button in the tracks' border and corner, label centred,
  with no count of open cards beside it (removed at the user's call, the same
  day): it is the one action among settings, so it looks like one. It still
  goes faded and `aria-disabled` when nothing is open. The panel is `min(288px, 100vw - 32px)` wide and anchors to the actions
  group's right edge, as the loan search's does, because its own trigger left it
  too little room on a phone for tracks that do not wrap; `.app-menu` takes no
  `position` for that reason. Not portalled; the header is not clipped, so there
  is nothing to escape and no placement to compute. Closes on outside press and
  Escape, the same two exits every transient surface here answers to.
