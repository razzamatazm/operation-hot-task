# CLAUDE.md (apps/web)

Design / UI reference for `apps/web`. Everything non-visual — product rules,
workflow, backend contracts, git workflow, agent conventions — starts at
[../../AGENTS.md](../../AGENTS.md).

## Aesthetic Direction

"Warm ledger." Off-white paper background, ink-black text, narrow accent
colors used as signal (good / warn / hot / bad). Not a SaaS-blue dashboard;
think bookkeeping pad with sharp typography.

**In the light theme the interactive voice is ink, not a colour** (2026-09-05,
chosen off a three-way bake-off driven on the live board against a plum and a
dark ink-teal). `--brand` was `#2c5ea0` — the exact SaaS blue the paragraph
above disavows — and it was the colour a person saw most, carrying every link,
every primary button and every focus ring. It is now near-black, which leaves
the four signals as the only hues on the page. The dark theme is untouched and
still answers the same role with its lavender; the two disagree on purpose,
like everything else in the pair.

Its one standing cost, paid in the base rules: **a link cannot announce itself
by colour any more, so links carry a standing underline** — faint, offset below
the baseline, firming up under the cursor. Paying that in the type is the point;
paying it by adding a second accent colour would undo the change.

**Ornament that encodes nothing is not decoration, it is noise** (2026-09-05).
Edge markers were removed in one pass — the red rail on an overdue row and the
five coloured bars on the metrics tiles, both of which were live on screen, plus
the rules for the blue "assigned to you" edge and the right-edge "you created
this" stripe, which turned out to have been unrendered for some time and so were
dead-code cleanup rather than a visible change. Each said a second time what the
row already said in words, and the shape they share — a tinted tab on the edge
of a list item — is the single most recognisable tell of generated UI.

The rule that replaced them: **one edge, one meaning.** If a card edge is ever
drawn again it belongs to status and to nothing else, and a fact that already
has a column, a label or a section does not also get a margin.

**No card edge is painted, and no rule exists that would paint one** (2026-09-06).
The status stripes had outlived the classes that were supposed to emit them by
long enough that a session reasoned from them as if they described the screen
and asserted a rule about an edge nothing drew. They were deleted rather than
wired up: the grouped row is deliberately mono, and giving status an edge would
have contradicted the pass above on the same day it landed. So "one edge, one
meaning" is a rule about what an edge may say if one ever returns, not a
description of anything on screen.

**The dark theme is a different room, on purpose** (2026-09-05, settled on
`prototype/dark-palette-v2`). It is an indigo ledger — indigo paper, near-white
ink, a lavender accent — not the warm ledger with the lights off. Five whole
palettes were driven on the live board before this one won, and warm grounds
(including a faithful dark version of the light theme) were among the ones that
lost.

Its one standing rule: **the indigo frame carries one warm note and no more.**
Every signal but `--warn` is rotated to the cool side of its own hue — overdue
is a rose, `--hot` a coral, "good" a mint, and the eight person chips all come
from the cool half of the wheel. `--warn` stays a gold, and is the exception
that fixes the rule's size: one warm accent is a note, two are a second scheme
arguing with the first.

A second accent round is what settled this. The generic tomato / orange /
grass-green accents that were here read as borrowed from another app the moment
the ground went indigo. So a new signal color added to the dark theme gets
cooled before it lands — the warm slot is taken.

- Display / headings: **Bricolage Grotesque** (700)
- Body: **DM Sans** (400 / 500 / 600)
- Mono / metadata / badges: **JetBrains Mono** (uppercase, tracked, small)

Mono is reserved for non-prose: dates, counts, type labels, section
counts. Prose stays in DM Sans. Don't mix.

One exception, and it proves the rule: the edit form's request field on an
**LOI** (`.task-form-terms-mono`). That box holds a pasted term sheet — tabular
matter, not sentences — whose columns only line up in a fixed-width font. Every
other type's field is prose and stays in the body face.

## Theme Tokens

All color goes through CSS custom properties on `:root` in
[apps/web/src/styles.css](src/styles.css). Three themes: `light`
(default), `dark`, `contrast`. The active theme is set by Teams via
`data-theme` on `<html>` (see `applyTheme` in
[apps/web/src/App.tsx](src/App.tsx)).

Never hard-code colors. Use the variables:

| Token                       | Role                                     |
|-----------------------------|------------------------------------------|
| `--bg`, `--bg-soft`, `--panel` | Background layers, low → high           |
| `--ink`, `--ink-secondary`, `--muted` | Text strength, high → low        |
| `--line`, `--line-soft`     | Borders, strong → faint                  |
| `--brand`, `--brand-hover`, `--brand-soft` | Primary action / link        |
| `--on-accent`               | Ink for text/icons on a filled accent    |
| `--good` / `--good-bg`      | Green urgency, success, "active" stat    |
| `--warn` / `--warn-bg`      | Yellow urgency, review thread accent     |
| `--hot`  / `--hot-bg`       | Orange urgency                           |
| `--bad`  / `--bad-bg`       | Red urgency, overdue, cancelled, errors  |
| `--row-alt`, `--row-hover`  | Striping and hover overlays              |
| `--control-hover`           | Hover tint for a non-filled inline control|
| `--shadow-sm`, `--shadow-md`| Flat no-op at rest / real lift when raised |
| `--focus-ring`              | `:focus-visible` ring                    |

**A signal token is never spent as a category colour** (2026-09-06). The metrics
type breakdown painted Fraud on `--bad`, Value on `--good` and Loan Docs on
`--hot`, leaving the other three uncoloured — a legend with three blanks in it,
and worse, a claim: `--bad` means failure everywhere else in the app, so a red
Fraud Check row told an admin fraud checks were going wrong on a chart that only
counts how many got filed. Every bar is `--ink` now and differentiated by
**length**, which is what a bar chart is for. The `.type-bar-*` variants are
deleted rather than left unemitted, for the reason the status stripes were. The
ratio bar's brand-to-hot gradient went with them: the number it draws is already
printed twice beside it, and a colour ramp implies a scale it does not have.

The four signal rows name each token's **role**, not its hex. The dark theme
answers them in cool hues (mint / gold / coral / rose) per the aesthetic
direction above, so "the red one" means `--bad`, not a red.

When adding a new themeable color, add it to **all three** `:root` blocks.

## Layout Primitives

- App shell: `.app-shell`, max-width 1320px, 12px gap stack.
- App bar: nav tabs (admin only) + the dev user picker, no brand lockup
  (Teams' own tab chrome already shows the app name). **Nothing else goes in
  here**: in a production build the picker is stripped and the tabs are
  admin-only, so for most people this row is empty. A control placed here is a
  control they never see.
- List header (`.task-grid-head`): heading and count left, then the app menu,
  then `New Task` hard right. On the Tasks board the heading is a tab row
  (`BoardTabs`, [src/board-tabs.tsx](src/board-tabs.tsx), #363, three tabs
  since #390): `All Tasks`, `My Tasks` and `Task Drafts`, each the heading's own
  type with its `.section-count` chip, the open one in ink over a `--brand`
  underline and the others muted, no fill or box. All Tasks is the board under
  Everyone and My Tasks the board under Mine; they replaced the app menu's Show
  row and the header's `Show everyone` link, and there is no Show link in the
  header on any tab. While a loan is searched All Tasks carries the loan's name,
  the one label that ellipsizes; the other two never shrink. **Under 480px the
  tabs read `All`, `Mine` and `Drafts`**: the full names and counts need 341px
  against the header's 329 at 360px (measured with the touch floor forced on),
  so each tab carries a `.board-tab-short` name the phone rule shows while the
  full `.board-tab-name` is visually hidden, never removed, so a screen reader
  still hears `All Tasks`. A searched loan's name has no short form. The header
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
  ([src/panel-placement.ts](src/panel-placement.ts)), not by
  `scrollIntoView({ block: "center" })`: centring in the whole viewport put the
  top of a tall expanded card, which is what a link opens, under the header on a
  phone, so it centres in the room below the header and top-aligns a card
  taller than that room. The open tab is `boardTab` in App, opened on the stored
  Show value's tab (`tabForShow`) and chosen through `selectBoardTab`, which
  writes All / My back to `BOARD_SHOW_KEY` (`showForTab`) and never stores Task
  Drafts. A loan pick sets the tab without storing it and remembers the tab it
  came from for `Clear search` to return to. Leaving the create form changes no
  tab. What sits under the row is `boardBody` in
  [src/board-filter.ts](src/board-filter.ts): an empty search on All Tasks, an
  empty Mine on My Tasks (with `Show all tasks`, which opens All Tasks). The
  pair is built to land on the action column of
  the rows below — same 32px trigger, same 6px gap, same `--quick-action-w`
  button, and the header carries the row's own right inset (its padding plus
  the card's 1px border). Read down the right edge and the menu sits over every
  hamburger, `New Task` over every quick action.
- Loan search (`.loan-search`, [src/loan-search.tsx](src/loan-search.tsx),
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
  `visibleBoardTasks`, so that tab's label and count, sections, empty state and
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
- **`--quick-action-w` has one definition, on `:root`.** The row's action
  column, the row's action button, the empty spacer on rows with no action, and
  the header's `New Task` all read it. Three of those were literal `116px`
  until the phone breakpoint moved the value and they silently stopped
  agreeing. Never write the number again.
- **A breakpoint override goes after the rule it overrides.** A media query adds
  no specificity, so a phone rule written above its base rule loses on source
  order and never applies — silently, since it parses fine and typechecks
  nothing. Three of the collapsed row's phone rules were dead this way; see
  *Mini rows* for what it cost. The task-card ones now live at the bottom of
  `styles.css` under their own heading. Put new ones there.
- Tabs: `.tab-bar` + `.tab-btn`, underline-active, no fill. The Tasks board's
  tab row (#363, #390) is the same `.tab-btn` with a `.board-tab` modifier that
  only sets the heading's type and spacing; don't give it its own colour,
  underline or hover rules. Its three tabs are one tablist with a roving
  tabindex, arrows and Home/End moving across all three.
- App menu (`.app-menu`): the preferences that are not decisions about a task,
  in this order (the user's, 2026-09-12) — Collapse all, View (Grouped/Flat),
  Appearance (`Teams` / `Light` / `Dark` / `Contrast`), and History
  (`7 days` / `14 days` / `30 days` / `All`, #391). Show
  (Everyone/Mine) left it in #390 to become the All Tasks and My Tasks tabs.
  The Tasks board is the only list with a header, so it is the only menu.
  History is a row of its own rather than more View choices because it combines
  with both, and the list it narrows comes from `visibleBoardTasks` in
  [src/board-filter.ts](src/board-filter.ts), which every consumer of the board
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
- **Theme is a choice now, not just a report.** Teams tells the tab which of
  its themes it is running (`hostTheme`); the person can pin one instead
  (`themeChoice`, persisted). One effect decides which wins, which is what lets
  `Match Teams` keep following live theme changes while a pinned choice ignores
  them. `Match Teams` is the default because a Teams tab that disagrees with
  Teams should be something you asked for.
- Controls on a list header share one voice: the display face at 0.82rem/600.
  They were in three different typefaces — display, monospace and body — on one
  line. Monospace was wrong on its own terms too: it is reserved for things
  that are counted or labelled, and these are controls.
- Sections: `.section-head` (h2 + monospace `.section-count` chip) on a
  1px line. Use this for every list grouping.
- Cards: rounded 8px, 1px `--line-soft`, background `--panel`. **Flat at
  rest** — `--shadow-sm` is a transparent no-op, and depth comes from the
  hairline plus the tone step between `--bg` and `--panel`. The old resting
  shadow was 3px of blur at 6%, under the threshold of visible on paper this
  warm. `--shadow-md` is the real lift and is reserved for things that leave
  the page: hover, an expanded row, menus, modals, toasts.
  Both tokens are transparent no-ops rather than the keyword `none`, including
  in the contrast theme. Any rule that composes them with a second shadow — the
  celebrating card's halo today, the deleted status stripes before it — has its
  whole declaration voided by that keyword, which is what was quietly deleting
  the stripe from the contrast theme. Keep them no-ops.

## Task Card Anatomy

Defined in `TaskCard` in [apps/web/src/App.tsx](src/App.tsx).
The collapsed row is the densest surface in the app — every change should
preserve scannability.

`TaskCard` is wrapped in `React.memo` (#73) so a 30s `now` tick or an
unrelated `App` state change doesn't re-render every card. The memo only
bites while **every** prop it receives is referentially stable: the handlers
in `cardProps` are `useCallback`-wrapped and `checklistApi` is `useMemo`'d in
`App`. There is no `exhaustive-deps` lint here (lint = `tsc --noEmit`), so
this is manual discipline — **never add an inline arrow or fresh object
literal to `cardProps`** (e.g. `onFoo: (x) => setBar(x)`); hoist it to a
stable `useCallback`/`useMemo` first, or the whole list silently re-renders
again.

### Unified grid

Every task the viewer is allowed to see lives in one list (`unifiedTasks`
in `App.tsx`). No more separate My / Available / Recent sections —
Assigner and Assignee columns carry "whose court" on every row, so the
viewer can scan involvement at a glance.

That one list renders either **grouped** (court sections, the default) or
**flat**; the toggle lives on the section header. The bucket sort described
under *Bucket sort* below is the **flat** ordering. Grouped
sections come from `buildCourtSections` and follow
[CONTEXT.md](../../CONTEXT.md#the-four-courts).

### Collapsed row (the main list view)

Both views — flat and grouped — render the same row, and it is the grouped
one: `.task-card-grouped`, built by `TaskCard`. There is no
`.task-card-collapsed` container any more; the last of its CSS went in #169.
For the grid itself see *Grouped collapsed row* below — this section covers
what each slot **carries**, that one covers how it is laid out.

Each slot has one job. When adding info, replace something — don't append:

- **Assigner → Assignee** — one line: avatar pill + first name on each side,
  arrow between (`.task-card-pair`). The viewer's own name, in whichever slot
  it lands, steps up to weight 600; an unclaimed task renders a dashed empty
  avatar and an italic `Unclaimed`. First names never truncate — the title
  column is the one that gives. Perspective rides here, not on a status
  banner: #36 removed the banner row along with `resolveBanner` /
  `STATUS_BANNER`. Stage detail (Merge Done, Merge Approved) for LOAN_DOCS
  rides on the **title**, beside the type. An unclaimed task also carries the
  `How Bad?` score here — see *Poop* below.
- **Title** — the loan name, then the task type beside it behind a hairline,
  and the type carries an optional stage (`Merge Done`, `Final Approval
  Needed`) in lighter weight via `task-card-collapsed-stage`. One line on a
  wide screen; the name is the elastic part and the stage is what gives. See
  *Grouped collapsed row* for how it stacks under 560px.
- **Poop** — the `How Bad?` score, and it is on the row **only while the task
  is unclaimed and out for the first time** (2026-09-07, narrowed 2026-09-10).
  It answers one question — can I take a
  five-poop set of loan docs right now — and that question is only live for
  somebody looking at work nobody holds, so it appears exactly while the row
  says `Unclaimed` and leaves the moment somebody takes the task. It renders in
  the **title block, sharing the stage's line** — beside the type on a wide
  screen, and under 560px on the reserved line under it, which puts it above
  the names (2026-09-10, the user's call). It briefly lived in the pair beside
  the word `Unclaimed`, which cost the row a second reserved line; sharing the
  stage's line is what took that back. Read-only, for everyone.

  **The rating is changed in the task form and nowhere else** (#335, the
  user's call). Filing sets it and `Edit Task` changes it; every rating the card
  draws is read-only for every viewer, the creator included. The click-to-rate
  track that used to live on the card is gone, along with its handler. The
  server's points route and its permission are untouched — the form uses them.

  **An open card draws the rating in exactly one place, and never in the
  body.** The row does not unmount when a card expands, so #332's track and the
  body's old `How Bad?` line drew the same number twice on every open pool
  task. One rule, `ratingSurface` in [src/poop-rating.tsx](src/poop-rating.tsx),
  picks the surface, and the two ask `ratingBlock` with their own name:
  - **row** — unclaimed and out for the first time (this track);
  - **menu** — every other state: dropped and re-offered, claimed, in flight,
    closed. A labelled `role="group"` block (`.task-card-menu-rating`) directly
    above the timestamps, folded into `menuHasContent`.

  An unrated task draws nothing on either, for anyone.
  `scripts/rating-placement-sim-test.mjs` sweeps every state for more than one
  copy, for a control, and for rules left addressing a block nothing emits.

  Fixed 5-slot track everywhere it appears — slots 1..N in full colour, the
  rest ghosted, so a 3 reads as three *out of five* rather than as three
  glyphs. A pass on 2026-09-10 cut the ghosts on the row, reasoning that one
  brown glyph trailed by four grey ones reads as debris; that was a change
  nobody asked for, made while fixing something else, and it was reverted the
  same day. **The track looks the same on every surface.** If it should ever
  stop looking the same, that is its own decision.
  An unrated task renders no track at all. See
  `PoopDisplay` / `.poop-track`. Never on a mini row: `isUnclaimed` is false on
  every closed task, so nothing extra is needed to keep it off them.

  **A task that has been dropped and re-offered does not get one**
  (2026-09-10). The score is the ask as its filer sized it and it describes a
  whole job; a check somebody has already been half-way through is not that job
  any more, so quoting the original number on the way back out is a number
  attached to the wrong piece of work. The first time out is when it means what
  it says.

  The test is shared `isFirstTimeInPool`, which compares when the task arrived
  in the pool against when it was filed. **Not** a bare `!task.pooledSince`:
  that field is absent on a never-held task in production, but the dev seed
  writes it equal to `createdAt`, and any fixture or import is entitled to do
  the same. Reading the field directly took the rating off every seeded open
  task on the board, which is how the first attempt at this rule announced
  itself. The comparison is true under both spellings.

  **An OOO gets one, and it is the case this is most for.** A review pass cut
  it out on the reasoning that a vacation notice is never picked up. That is
  wrong: `canClaimTask` opens for it like any other `OPEN` task, the board
  files it under *Up for grabs* with a `Claim` button, its channel card asks
  "will be out of the office … and needs coverage. Can you help?", and
  `TASK_NEEDS_PHRASE` calls it "needs OOO Coverage". Somebody deciding whether
  to cover an absence is asking precisely what the score answers — a quiet week
  and a heavy pipeline are not the same ask.

  The two shared rules that *do* exclude an OOO, `isPoolNagEligible` and
  `isUnclaimedTooLong`, are about **nagging cadence** and not about pickup:
  don't re-post "cover this holiday" to the channel every twenty minutes, and
  don't tell somebody their own vacation notice has gone unclaimed too long.
  Neither says nobody takes it. Don't borrow either for a question about who
  is looking at the pool.

  It rode every row until #329 took it off entirely — five emoji on all ~130
  rows including the closed ones, which was the loudest thing on the densest
  surface in the app. This is not that coming back; it is the same fact
  drawn only where it is worth reading, on the three or four rows in a list
  where somebody is deciding whether to take the work.

  **This is an append, and it is the row's one sanctioned one.** Rule 3 under
  *When Adding UI* says a new field on the collapsed row replaces something
  rather than being added beside it, and this adds a track next to `Unclaimed`
  without taking anything away. It is allowed here because the slot it lands in
  is the one part of the row that is *empty on exactly these rows* — the
  assignee half of the pair is a dashed placeholder and an italic `Unclaimed`,
  which is the row saying it has nothing to put there — and because it leaves
  when that emptiness does. A new field that cannot say both of those things
  replaces something instead.
- **Due** — label and value side by side, right-aligned, built by
  `groupedDue`. Full
  absolute timestamp shows as `title` tooltip. Red + bold
  (`.task-card-grouped-due-overdue`) when overdue. The rest — including why
  it must ask the shared `isOverdue` — is under *Grouped collapsed row*.
- **Action** — single contextual button (`Claim` / `Complete` / `Confirm` /
  `Merge Done` / `Approve Merge` / `Send Items` / `Submit` / `Approve` /
  `Archive`). Picked by the `primaryAction` ladder in `TaskCard`.
  `Confirm` is `Complete` on the one task where completing also archives —
  an LOI the creator sent back for a confirming look (#238, ADR-0007 rule 5).
  Same transition, same single request; the word changes because the press
  does more, and it comes from the shared `isConfirmingLook` so the bot card
  cannot word it differently. Never fire `ARCHIVED` after it from here: the
  server does both in one write, and a second call is what could leave a task
  completed and not archived.
  `Send Items` fires from the row like every other entry, and is disabled with
  a reason while the checklist is empty (2026-09-07) — it used to open a note
  composer in the body instead. It is worded short (not
  "Send Outstanding Items") because the slot never resizes to its label. When no action
  applies the slot resolves three ways (see *Empty action slot* below).
  Hidden on mini.

The **whole row** is the expand toggle (`role="button"`, Enter/Space).
Don't add a chevron; it's redundant.

**Type names come from shared `TASK_TYPE_LABELS`, never from a local table**
(2026-09-07). `App.tsx` kept its own copy, and the copy had drifted: out of
office read `OOO - Out of Office` on the board and in the bot's filing card —
the abbreviation and its expansion in one label, which is one of them too many
— while every DM and channel card the same task produced said `Out of Office`.
The web row, the create form, the bot's type picker and the notification copy
all read the one table now. The same rule the action labels are already under:
a surface that writes its own wording is a surface that will disagree with the
others.

### Grouped collapsed row (`.task-card-grouped`)

The grouped list renders each row as its own CSS grid. Because sibling
grids can't share tracks, a content-sized column resolves differently per
row and the list goes ragged (#116, which measured 86px of hamburger drift
across one screen).

An active row is **two grid lines at every width** — there is no responsive
reflow, deliberately. (Two grid lines, not two lines of text: under 560px the
title cell holds the name, the type, and one reserved line carrying either the
stage or the rating. See *one height* below.) The pair used to share one line with the title and
needed a fixed 196px reservation sized to the widest pair in the app; on a
typical row that left ~38px of dead space between the names and the due
stamp. Moving the pair onto its own line removed both the gap and the
reservation:

```
minmax(0,1fr) | 154px
title         | action
pair          | due
```

**Under 560px every active row is one height, and it costs exactly one reserved
line** (2026-09-10). Two things grow a row by a line — the type cell when a task
has a stage, and the rating when a task is up for grabs — so a list came out as
a mixture of shorter and taller cards depending on facts that have nothing to do
with each other.

**The two share one line, because they can never both appear.** A stage only
exists on a LOAN_DOCS mid-merge or a FRAUD mid-exchange, both of which have been
claimed; the rating only appears on a task that is unclaimed *and* has never
been dropped (`isFirstTimeInPool`). A released check has a stage and no rating; a
task fresh in the pool has a rating and no stage. So the rating renders inside
`.task-card-collapsed-type` alongside the stage, takes the same wrapped line
under the type, and one `min-height` on that cell reserves the line for whichever
occupant turns up.

That is the difference between a 102px card and a 121px one. Reserving a second
line in the pair as well — which is what this did first — made every card 19px
taller for a slot only three rows in a typical list ever fill, and pushed the
names out of line with the due stamp beside them. If both ever do land on a row,
they share the line side by side and it wraps: the card grows, nothing breaks.

Four things about that rule:

- **It is written in `em` plus the gap it reserves for**, not in measured
  pixels — `calc(2.8em + 1px)`, two lines of the type's own 1.4 line-height plus
  the `row-gap` a really-wrapped stage puts between them. A pixel short and the
  list renders 120px and 121px rows, which is the same bug at a size nobody can
  name but everybody can feel. The `em` is why the `pointer: coarse` floor names
  `.task-card-collapsed-type` itself and not only the boxes inside it: the
  reservation has to follow the floored size rather than assume today's value.
- **The rating is sized to the line it shares**, `height: 1.4em` with no
  padding, not its natural 17px (a 13px glyph plus 2px of padding). Left
  natural it made a rated row ~2px taller than a staged one — the same bug,
  smaller, and small enough to look like nothing and read like mess.
- **Mini rows are excluded** (`:not(.task-card-grouped-mini)`). A closed task
  never has a stage and never carries a rating, so reserving the line there
  would add height to every row in Done and buy nothing. Minis are half-height
  on purpose.
- **A reservation belongs to the thing it reserves for.** If both occupants ever
  leave, the `min-height` goes with them. A blank line held for nothing is
  ornament, which is the one thing this row's rules refuse.

The cost is a line of white space on the rows that have neither, and it is
deliberate: uniform rows are what lets an eye keep one rhythm down a list, and
this is the surface where a thumb is doing the scrolling.

**Equal heights are not the same thing as a list that lines up**, and getting
the first without the second is worse than neither. An earlier version of this
reserved a line inside the pair and packed its lines to the top, which put a
rated row's names 10px below an unrated row's: every card measured 121px and the
names still zigzagged down the list. The pair carries no reservation now and is
a single line again, so the names and the due stamp beside them share a baseline
by construction. If you ever reserve space on this row again, decide which edge
the content holds to as part of the same change.

**One 1px difference is left, and it is deliberate elsewhere.** An overdue row
is 101.7px against 100.7px, because `.task-card-grouped-due-overdue` takes the
due value up to 0.95rem — the overdue emphasis, which predates all of this.
Normalising it would mean adding a pixel to every other row to match a stamp
that is supposed to stand out.

**Measure this with the `pointer: coarse` floor forced on.** Automation reports
a fine pointer at every viewport, so the 12px floor never applies under
Playwright and every label comes out ~15% narrower than it does on a real
phone. The stage's tracking was set from numbers taken that way once and was
two pixels wrong because of it. Apply the floor's declarations unconditionally
in a scratch `<style>`, take the numbers, then remove it.

**Where uniformity holds, and where it stops.** One height across every active
row at **390px and up**, which is the iPhone width the board is used on. At
**360px** it does not, and the cause is the pair rather than the reserved line:
`Suzie → Unclaimed` wants ~172px against a cell that resolves to 164px, so the
names wrap and those rows run ~21px taller. That is the standing "first names
are never ellipsized, the pair wraps" rule doing exactly what it says, and it
is not introduced here — the row that proves it is a released check, which
carries no rating at all and wraps anyway. Closing it would mean either
shortening the placeholder word `Unclaimed` at narrow widths or breaking that
rule; **open, and nobody has asked for it.**

**Open: the due stamp's ragged left edge on a phone** (raised 2026-09-10, not
acted on). `RETURNS Sep 12, 2026`, `Within 1 Hour`, `Urgent Now` and
`OVERDUE BY 3d` are right-aligned to the action column above them — verified,
every one lands on the same right edge — but they differ so much in length that
their left edges land nowhere near each other, and on a phone that reads as the
most restless thing on the row. Three ways out, none chosen: drop the `RETURNS`
label so it matches the unlabelled time-frames, shorten the date, or move the
stamp under the names and left-align it. Raised by the user and deferred with
their knowledge; recorded here so the next pass does not have to rediscover it.

For the record, the collision that once existed: a released Fraud Check is
unclaimed *and* carries a stage, because the two `unassignInPlace` paths (the
creator's "release for any fraud checker" at `PENDING_APPROVAL`, and the sweep
when a checker loses the FILE_CHECKER role, at any live status) clear the
assignee without moving the status. `Final Approval Needed` is in fact *only*
reachable there — `stageSuffix` returns it precisely when a `PENDING_APPROVAL`
check has no assignee. Such a row draws its status line and no rating, since
being released is what makes `isFirstTimeInPool` false.

The LOAN_DOCS stages never collide this way either: `canUnclaimTask` and
`canReturnToPool` are both `CLAIMED`-only, and both release paths are FRAUD-only,
so a `MERGE_DONE` or `MERGE_APPROVED` task always has a holder.

- **pair** — assigner → assignee on one line, now sharing a row only with
  the due stamp. No fixed width; overflow **wraps** (`flex-wrap: wrap`),
  and first names are never ellipsized, which is a standing rule. The
  widest pair the app renders is 190px (`Johanna → Unclaimed`), which no
  longer competes with anything.
- **due** — label and value side by side (not stacked), right-aligned so
  its right edge lines up with the action column above it. Built by
  `groupedDue`, which asks the **shared** `isOverdue` rather than re-deriving
  `dueAt < now` — the row having its own copy of that rule is what let a
  handed-off FRAUD check read `OVERDUE BY` while the server, the reminder
  engine, and every other consumer agreed it wasn't overdue. Don't reintroduce
  a local overdue test here; a status added to the shared exclusion list has to
  reach both the badge and the red due stamp on its own.
  Two statuses swap the deadline out entirely. Both are display choices made in
  `groupedDue`; whether the task is *overdue* still isn't.
  - `AWAITING_ITEMS` shows a neutral `WITH REQUESTER` / `WITH YOU` count-up. See
    [fraud-workflow.md](../../docs/product/fraud-workflow.md#reminder-rules).
  - An **unclaimed** task shows no countdown at all (ADR-0005) — its `dueAt`
    restarts from whenever somebody takes it, so the number would be wrong the
    moment it stopped being unclaimed. Its creator gets an `UNCLAIMED FOR`
    count-up that reddens via the shared `isUnclaimedTooLong`; everyone else
    gets the bare urgency time-frame. "Unclaimed" is the shared `isUnclaimed` —
    **no assignee and not closed**, not `status === "OPEN"` — and since #213
    both the calm count-up and the reddening one ask that same question, so they
    cover the same rows. A FRAUD task released for any checker is unassigned at
    `PENDING_APPROVAL`: testing the status instead of the holder is what let
    that row render a red `OVERDUE BY` while the server agreed it was nobody's
    lateness, and what left the released check with no count-up at all.

  **The title block is one line: loan name, then the task type.** The loan name
  leads because it is what a person scans for — heading face, full ink, and the
  elastic part of the row. The type sits directly beside it behind a hairline,
  in ink and tracked, and it is capped at 45% of the cell so the name keeps the
  space it earned. The type truncates before the row does: left unshrinkable it
  is wider than a phone on a fraud check at final approval, and because it sits
  in a fixed grid row it pushed the whole board sideways with no zoom to escape
  it. **Under 560px the pair stacks** — name, then type underneath — and the
  hairline goes with the side-by-side arrangement it belonged to.

  **The stage is its own box, and on a phone it takes a third line**
  (2026-09-07). It used to be words inside the type's own span, so the two
  truncated together and the ellipsis landed wherever it landed: stacking the
  title bought the type a full-width line, and `Fraud Check - Final Approval
  Needed` still wants ~290px of a title cell that resolves to about 200px at
  390px, so what a person read was `FRAUD CHECK - FINAL APP…`. The half that
  got cut is the status — where the task actually *is* — on the surface with no
  zoom to go and look with. Split out, the type names what the task is and
  stays whole, the stage is the part that gives on a wide screen, and under
  560px it wraps in full onto a line of its own. Two things ride with that:
  `stageSuffix` returns **bare words**, because the hyphen belongs to the
  one-line arrangement and `.task-card-collapsed-stage-join` is dropped when
  the line breaks; and the stage takes `order: 2` so the unread dot stays at
  the end of the type rather than being pushed onto a line by itself.

  The rating is back on the row for unclaimed tasks only — see *Poop* under
  *Collapsed row* — and the ↗ that used
  to follow the loan name is gone: a unicode arrow standing in for an icon,
  which renders as a colour emoji on mobile. The name is still the link and
  says so with the standing underline every link carries.

  **Overdue is said once, on the number.** The row used to carry a 4px left
  rail that was transparent on every row in the app and went red on this one
  condition — a coloured tab on the edge of a list item, repeating in the
  margin what the due stamp already said in words and in red two columns over.
  The rail and its grid column are gone (2026-09-05); the row is a two-column
  grid now and takes even 14px padding on both sides instead of the lopsided
  inset the rail needed. The signal lives on
  `.task-card-grouped-due-overdue`: the value goes `--bad`, 700, and up to
  0.95rem, with the label red behind it at 0.8 opacity so the pair reads as one
  signal. If a new row-level state ever needs a channel, it does not get an
  edge — see **one edge, one meaning** in Aesthetic Direction.

  Watch the width here. The `due` track is 154px and
  `.task-card-grouped-due-value` is `nowrap`, so an over-long pair overruns the
  cell and rides back over the pair beside it rather than wrapping. The widest
  label the cell renders is `WITH REQUESTER` (~125px with its value). The
  urgency time-frames are the longest *values* — `Within 24 Hours` is ~122px on
  its own — which is why that branch returns an **empty label**, the same way
  closed rows do. Don't put a label back in front of a time-frame without
  measuring it.
- **action** (`--action-col-w`) — hamburger (32px) + 6px gap +
  `--quick-action-w` (116px). The cell is a two-track grid with the
  hamburger and the button placed by `grid-column`, not by source order,
  so a row missing either one doesn't slide the other. **Every quick
  action is 116px wide regardless of label**; `Approve Merge` is the
  longest label that lands here (~112px) and sets the ceiling. Don't
  reintroduce a `width: auto` override on `.task-card-quick-action` —
  that per-row sizing is what caused the drift. The old sub-780px rule
  did exactly that; it is gone, because the hamburger sits *left* of the
  button and right-aligning alone still lets a `Claim` row and an
  `Approve Merge` row put their hamburgers in different places.
- **title** — the only elastic track, and therefore the only thing that
  gives, via ellipsis.

**Mini (closed) rows stay on one line.** They carry no quick action, so a
second row would buy nothing and cost height — stacking took a mini from
48px to 74px, taller than an active row used to be, across the ~117 closed
rows in a typical list. They keep a single-line template, with all three
right-hand tracks fixed (same reasoning as #116: on one line a
content-sized column resolves per row and walks its neighbours sideways),
sized to what a mini actually renders rather than to the active row's
reservations:

```
minmax(0,1fr) | 168px | 72px | 32px
title         | pair  | due  | action
```

**Under 480px those three tracks shrink to `96px | 56px | 32px`**, and that
override is at the very bottom of `styles.css`, on purpose. It used to sit in
the `@media (max-width: 480px)` block a thousand lines earlier — *ahead* of
`.task-card-grouped-mini` itself — and a media query adds no specificity, so it
lost to the base rule and had never once applied on a phone. What that cost was
the whole Done section: at 360px the desktop tracks ate 272px, the elastic title
was the only one allowed to give, and it resolved to **14px** — closed tasks
rendered as two characters of a loan name over a bare ellipsis, on the surface
where zoom is off and there is no way to go and look. Three of the app's phone
rules were dead this way and no test could see it, because a rule that loses
still parses. **A breakpoint override goes after the rule it overrides.**

`168px` and `72px` clear the widest pair and done-time measured across the
closed rows (164px / 65px); `32px` is the hamburger alone. A mini never
renders a quick action, so reserving the full `--action-col-w` stranded its
hamburger 136px short of the row's right edge. The cluster's right edge
therefore lines up with the **quick action button's** right edge on the
active rows — not with their hamburger, which sits a track further left.
Minis do still host a hamburger — it is how a closed task reaches
Re-open / Archive — so never `display: none` the action cell on a mini.

### Panels that escape the card (#113, #122)

`.task-card` keeps `overflow: hidden` — the rounded corners depend on it — so
any panel taller than a collapsed row has to leave the card instead. Both the share popover
(`.share-pop-panel`, #113) and the hamburger's actions menu
(`.task-card-menu-panel`, #122) are `createPortal`'d to `document.body` and
`position: fixed`. So is the handoff popover (ADR-0002), which reuses
`.share-pop-panel` wholesale — that class is what the menu's outside-click
(`keepOpenWithin`) and Escape exemptions key off, so a fresh class would close
the menu out from under it. All three go through the `useAnchoredPanel` hook in `App.tsx`,
which owns the trigger/panel ref pair, the placement (`placePanel`: prefer
downward, flip up only when below can't fit and above can, clamp both axes
to the viewport), re-placement on capture-phase `scroll` and on `resize`,
and outside-click dismissal. The menu right-aligns to its trigger (the
hamburger sits left of the quick action); the share popover left-aligns.
z-index: menu 55, share popover 60 — the popover opens out of the menu and
layers over it.

The two-exit panel (`.two-exit-panel-panel`, `TwoExitPanel`, #231) is the
fourth, and the one that deliberately does **not** reuse `.share-pop-panel`. It
is the menu's sibling in the action cell rather than something opening out of
it, so wearing that class would buy it the menu's outside-click exemption and
leave the menu standing when you clicked in here. Right-aligned like the menu
(it lives in the quick-action slot, at the row's right edge), z-index 60, and it
swallows Escape on the panel the way the share popover does — a note stage owns
a textarea, and one keypress should close this panel and nothing else.

Two things it does that the older three don't, both from #231's visual pass:

- **It stops every key at its wrapper**, not just Escape. The panel is portaled
  out of the row in the DOM but React events still travel the *React* tree, so a
  keypress inside it reaches `handleHeaderKey`, which reads Space and Enter as
  "toggle this card" and calls `preventDefault`. A space typed into the note
  composer collapsed the row instead of landing in the box. Any portaled panel
  hosting a text field has this problem; stop keys at the wrapper.
- **Placement follows the panel's own box**, via a `ResizeObserver` in
  `useAnchoredPanel`, not only a `remeasureKey` a caller remembered to bump. A
  panel that grows after placement grows *downward* from a top chosen for the
  old height, which is how it ends up over the bottom edge.

### Placement is a tested pure function

The arithmetic lives in [src/panel-placement.ts](src/panel-placement.ts), not
in `App.tsx`, so `scripts/panel-placement-sim-test.mjs` can drive it under
node — same arrangement as `expand-state.ts` and `toast-store.ts`. The property
it holds is not "does it flip up" but "is the returned box inside the viewport",
asserted over a sweep of anchor positions, heights and both alignments.

The bug that put it there: an **unmeasured panel reports a height of 0**, and a
zero-height panel "fits" below any anchor with room below it. So placement
committed to opening downward, then clamped against a height of nothing — which
is to say not at all — and the panel drew off the bottom of the screen. With
nothing measured the honest answer is whichever side has more room; the
re-place that follows the measurement corrects it. A panel taller than the
viewport is capped (`maxPanelHeight` plus the inline `max-height` the hook sets)
and scrolls internally rather than overflowing.

Things portaling makes easy to get wrong:

- The panel isn't a DOM descendant of the row, so **outside-click dismissal
  hit-tests each region separately** — trigger, panel, and any panel *this*
  panel hosts (`keepOpenWithin`, which the menu points at
  `.share-pop-panel`). Testing only one closes the panel the instant it
  opens, or tears the share popover down mid-share.
- **Escape stays with each caller**, deliberately. The share popover
  swallows it (`stopPropagation` on the panel) because the picker can be
  embedded in the create-task form, whose own Esc handler would bin the
  draft. The menu listens on the `document` (focus is usually still on the
  row) and exempts two targets whose own Esc handlers live inside it: the
  share popover, and any text field in the panel — the "Add a note" composer
  clears its draft on Esc, and one keypress shouldn't take the draft and the
  menu.
- React events propagate through the **React** tree, not the DOM one, so the
  wrapping `stopPropagation` span still shields the portaled panel from
  toggling the row. The panel repeats `stopBubble` anyway — depending on a
  DOM-detached ancestor for that is what a later refactor breaks silently.

### Empty action slot — three-way resolution (#117)

The `primaryAction` ladder covers one status-and-role case per branch
(including `NEEDS_REVIEW` → `Complete`, #118 — the creator's button since
ADR-0007, gated like the `CLAIMED` Complete and the hamburger's `Send Back For Review`
by `canTransitionStatus`, the exact question the server asks on the click, so
the row can't offer a move the server refuses; #236 is what happens when it
reads a neighbouring predicate instead).

**Two cells sit ahead of the whole ladder**, both rendering `TwoExitPanel`
instead of a button, and on both the `CLAIMED`/`NEEDS_REVIEW` Complete branch
stands down so a panel and a button can never both appear:

- A **claimed LOI held by its checker** gets `Checked` (#231): `Good to go`
  completes it, `Needs fixes` reveals a required note and then sends it to
  corrections.
- A **task in corrections, seen by its creator**, gets `LOI Fixed`:
  `No Review Needed`
  closes it, `Send Back For Review` returns it for a confirming look. That
  second move used to be a hamburger entry while `Complete` sat on the row,
  which made one of the creator's two moves easy and the other a hunt.

The conditions are `canUseCheckedPanel` and `canUseFixedPanel` from
`packages/shared` — each asks `canTransitionStatus` for both of its exits and
answers once, so a panel is never drawn with a dead half and the view never
re-derives who may do what. Neither trigger is called `Complete`, because
pressing it completes nothing. Every other task type's claimed row is
byte-for-byte what it was.

Why a panel and not two buttons: the slot is a fixed 116px, four variants were
built and driven live on #172, and splitting the slot or swapping the outcomes
into it in place both read worse. Settled; don't revisit.

Neither trigger draws a disclosure caret. There was a `▾`; at the slot's size
and weight it rendered as a small dot rather than a triangle, and it is gone by
the user's ruling. The affordance is `aria-haspopup` and `aria-expanded`, which
is what was carrying it for anyone who couldn't see the glyph anyway.

**A note composer sends on Enter and takes a newline on Shift+Enter**, the same
handler idiom as every other note composer in this file. It briefly did the
reverse, on the argument that a finding can run to a paragraph; the ruling was
consistency with the rest of the app, and Shift+Enter still gets the second
line. The empty check is the same one the button has, so the keyboard path
cannot send what the pointer path refuses — and `preventDefault` runs either
way, so Enter on an empty box does not leave a stray newline behind.

Worth knowing if this ever looks broken again: a portaled panel's wrapper
`stopPropagation` does **not** stop the textarea's own handler. It is a
bubble-phase handler on an ancestor, so the field's handler has already run;
all it stops is the row underneath reading the same key. When plain Enter did
nothing here, the cause was simply that the textarea had no keydown handler at
all and Enter fell through to the browser default.

**A note-required exit puts the requirement in the composer's placeholder**, not
in a sentence beside the button. A separate explanatory line was tried and read
as noise next to a button that still looked pressable; the placeholder is where
the person is already looking, and the button carries the state instead
(`.two-exit-panel-send:disabled`). The reason still reaches a screen reader via
the button's `aria-label` and the field's `aria-describedby` — taking a
disabled control's explanation off the screen must not take it off the
assistive path.

When the ladder produces nothing, the slot is **not**
blank by default — a bare hamburger with dead space beside it read as a
rendering failure on your own tasks. In order:

1. **`Waiting on <first name>`** — the flow is waiting on somebody who isn't
   the viewer. Shown to **observers too**, not only the creator and assignee:
   it is passive information, it says the same thing the Assigner/Assignee
   columns already say, and these are precisely the statuses where the row
   would otherwise render dead space. Whose move it is
   comes from `pendingPartyFor` in `packages/shared/src/workflow.ts` —
   `MERGE_DONE`→creator, `MERGE_APPROVED`→assignee, `AWAITING_ITEMS`→creator,
   `PENDING_APPROVAL`→assignee, `NEEDS_REVIEW`→creator (ADR-0007) — never
   re-derived in the view. Rendered as a
   passive muted-mono `<span>` (`.task-card-quick-action-waiting`), no
   handler, at the same `--quick-action-w`. The ball is legitimately in
   someone else's court, so the row says so instead of offering a
   destructive action.
   **Under 480px it wraps rather than ellipsizing.** The whole of its
   information is the name on the end, and `WAITING ON HEATH…` is a label
   spending its width on the part everybody already knows. It wants 114px
   against the phone column's 108px, and it is a passive span with no touch
   target, so a second line costs the row nothing anyone can feel.

   **The message pull owns this slot when the pull is what put the row here**
   (2026-09-06). `pendingPartyFor` knows the chain and nothing about the pull,
   so a task lifted into "Needs you" by an unread reply used to sit under that
   heading reading `Waiting on Johanna` — the section and the slot contradicting
   each other in the one place both get scanned, which is the promise the whole
   product is organised around. It now reads `Unread reply` while the dot is
   lit and `Read reply` once the viewer has opened it and the court hold
   (below) is the only thing keeping the row in place. Still a passive span
   either way: the ball is genuinely in the other party's court, and this says
   why the row is in front of you, not what to do about it.
2. **`Cancel`** — you created the task, it isn't closed, and `CANCELLED` is
   still an allowed transition. The **creator** condition and the shared
   `canCancelTask` agree since ADR-0003 stripped the admin branch: cancelling
   is the creator's move, on the row and in the hamburger alike. Clicking it
   drives the hamburger's
   `cancelStage` to `confirming` and opens the menu panel, so the existing
   two-step "Cancel this task?" confirm and its "Cancelled ✓" flash are
   reused verbatim — there is no second confirm component and no undo flow.
3. **The reserved spacer** (`.task-card-quick-action-empty`) — anyone the two
   rules above didn't catch: statuses with no pending party (`OPEN`,
   `CLAIMED`, the closed ones) where the viewer has no action. Observers no
   longer land here on the five `pendingPartyFor` statuses (`NEEDS_REVIEW`
   joined them with ADR-0007: it waits on the creator) — they get rule 1. **This reverses #117**, whose acceptance
   criteria listed "Observer — neither creator nor assignee → reserved
   spacer, unchanged"; the slot reading as a missing control was judged
   worse than telling an observer whose move it is.

### A hand-back needs items (2026-09-07)

The two moves that enter `AWAITING_ITEMS` — the checker's first send
(`Send Items`) and a bounce-back from final approval (`Send Back`) — cannot go
out empty. The server has always enforced "a note **or** at least one checklist
item", and this app used to satisfy it either way, revealing a textarea when the
list was empty.

**That box is gone.** The outstanding items are the checklist, and anything else
the checker wants to say is a message in the conversation directly below it. A
free-text box between the two asked the checker to sort every sentence into one
of three places, and put the same content in a different shape depending on
which they picked.

**Two ways through, and they are the card's two existing places for words.**
Shared `handBackSatisfied` owns the rule:

1. **At least one checklist item** — the normal answer.
2. **A message the checker has posted themselves** — the answer when there is
   *nothing* outstanding. That is a real result of a first pass, not an edge
   case: the checker still has to hand the check back, and a checklist-only
   rule would lock them out of the flow with no way to move at all.

Scoped to the viewer's **own** messages on purpose, and the reason is the
requester's replies rather than the opening ask. `reviewNotes` is empty at
creation — the originating ask lives in the task's own field and is only
*rendered* as the thread's first row — but the requester posts real messages
through the exchange, answering items during `AWAITING_ITEMS`. By the time a
check reaches `PENDING_APPROVAL` its thread reliably holds the requester's
words, so a bare "has anyone said anything" test would let a checker bounce it
back on somebody else's message. A withdrawn message is a tombstone and does not
count either.

**It is not scoped to the current pass.** A checker who wrote something in an
earlier round and nothing in this one still passes the gate. There is no pass
marker on a message the way there is on a checklist item (`addedOnPass`), and
approximating one from timestamps would be guessing. If this matters, stamp
messages with the pass rather than comparing dates here.

Until one of the two holds, the move is **offered and disabled** carrying
`Add an outstanding item, or a note in the conversation saying there is nothing
outstanding` — the same `blockedReason` treatment `Submit` gets, on the
wrapper's `title` and the button's `aria-label`. The sentence names both exits
deliberately: naming only the checklist leaves a checker with nothing to list
staring at a dead button on a check that is going fine.

**The server asks the same function**, and its refusal reads the same sentence
back, so the button and the API cannot drift. **The bot is untouched:**
`fraudCardActions` takes `{ noteCapable: false }` from this app and nothing from
the bot, whose Adaptive Card has a text input and no way to build a checklist, so
its note-on-the-transition path still works. Don't fold the gate into
`fraudCardActions`'s default — that would take the bot's only route away.

A checker may add checklist items at any live status (`canEditChecklist`),
including `PENDING_APPROVAL`, which is what keeps `Send Back` reachable rather
than a dead end once the requester has resolved everything.

### A blocked primary action (#184)

The ladder can also produce an action the task's **state** won't take yet —
today only FRAUD's `Submit`, held until every checklist item is checked or
noted. That is not the same thing as having no action: the requester needs to
see that Submit *is* the next step and why it won't go. The slot renders the
button `disabled` inside `.task-card-quick-action-slot`, with the sentence on
the wrapper's `title` and the button's `aria-label`. Clicking anywhere in the
slot expands the card, where the list itself is the answer.

**The button is the whole of the signal** (#317, #321, #323). Three other
things used to say the same fact: a sentence over the checklist, a `N to
resolve` count under the button, and a warn tint with a left rule on every row
the gate was waiting for. All three were introductions to a list that
introduces itself, on the one card whose ask already *is* a list. The disabled
button is the signal; the sentence is a hover and an `aria-label` away, which
keeps a disabled control's explanation on the assistive path where taking it off
the screen must not take it off.

`blockedReason` comes from `packages/shared` — `fraudCardActions(...)` — so the
view never decides who may submit or when. It also returns `blockedCount`
beside it, which nothing in the web app reads any more.
The button's placement is the slot's business too: the action cell's
`grid-column` rules apply to its own children, never through the slot to the
button (that is what pushed the slot's second child into an implicit column and
blew the 116px track). With the sub-label gone a blocked row is exactly two
lines like every other one, which is what it should have been.

All three are suppressed on mini (closed) rows — see `{!mini && ...}` in
`TaskCard`. Minis have no quick *action*, but they do have an action
**column**: a 32px track holding the hamburger.

Action labels come from `ACTION_LABELS` in `packages/shared`, never from
literals in `App.tsx`. The web row, the expanded body, and the Teams bot's
Adaptive Card buttons all read the same constant, so no surface can invent
its own wording (`Approve` vs `Approve Merge` was exactly that drift).

The two-line arrangement (title + action on top, pair + due below) is the
row's only layout, at every width — the old `max-width: 780px` reflow is
gone. The action cell keeps its fixed tracks all the way down; don't
reintroduce the auto-width override that breakpoint used to apply.

### Mini rows (closed tasks)

Closed statuses (`COMPLETED` / `CANCELLED` / `ARCHIVED`) drop into the
bottom of the grid as `.task-card-grouped-mini` rows: half height
(~28px min), no poop, no quick action (the hamburger stays). Title font
shrinks. Clicking still expands to reveal
full actions (Re-open / Archive). A task that was reopened back into an
active status shows a **Restore** button in the expanded body (via
`restoreTargetStatus`) that returns it to the exact closed status it came
from — COMPLETED or ARCHIVED — for whoever reopened it (creator or
assignee), not assignee-gated like Complete.

### Bucket sort

`unifiedTasks` sorts into 4 buckets, newest-first within each:

1. **Celebrating** — the creator's task just hit `COMPLETED` (or
   `LOAN_DOCS` + `MERGE_DONE`). Pinned to the very top with a green
   pulse for ~3s after the transition (`task-card-celebrating` class,
   driven by `pulsingIds` state in `App.tsx`). Stays in this bucket
   until the creator archives it. A confirm at the tail of the corrections
   loop skips this bucket entirely — it lands the task on `ARCHIVED` in one
   action, so it goes straight to Done (#238). That is the point of rule 5:
   the creator hears about it in a DM and finds it in Done, rather than
   getting a finished task to dismiss.
2. `OPEN` — always undimmed (anyone may claim).
3. In-flight (`CLAIMED` / `NEEDS_REVIEW` / `MERGE_DONE` / `MERGE_APPROVED`).
4. Closed (`COMPLETED` / `CANCELLED` / `ARCHIVED`) — render as mini rows.
   All three share one window, the app menu's History setting (#391), applied
   by `visibleBoardTasks` rather than by the sort: a just-closed task stays
   visible in Done, then drops off the bottom once it ages past the cutoff.
   `unifiedTasks` is the sorted list with nothing cut, so a loan search can see
   past the window, and a deep link to an older closed task keeps just that
   task for the session (`keptTaskIds`, never stored). (Admin Metrics counts
   every status from the raw task list, independent of this view filter.)

Rows are collapsed, full stop. There are no exceptions and no `defaultOpen`:
`expanded` is the persisted per-user override (`expandOverride`) or `false` —
`isTaskExpanded` in [src/expand-state.ts](src/expand-state.ts), which is the
whole rule. A card opens because the viewer clicked it, or because a deep
link asked for it, and closes because the viewer closed it. Nothing else
moves it either way.

`OPEN` tasks, unread notes, and your own in-flight work used to force a card
open, and a companion effect cleared the manual override on a status change
or a new note so that rule could re-decide. Together they made the list
rearrange itself under the viewer — cards they had opened snapped shut,
cards they had never touched sprang open. Both are gone (#161). Nothing that
matters is behind the fold: the collapsed row already carries the quick
action and the hamburger, and the red dot marks what needs reading without
taking the decision off the viewer.

**Collapse all** (#177) closes every card open *in the list you're looking
at*. It lives in the app menu (`AppMenu`) on the Tasks board's header, the one
list header left since #391 removed admin All Tasks; the loan-filtered list and
its header are gone too, along with the `CollapseAllButton` and `GroupSeg`
components that used to sit out on the header. The menu is handed the ids
`renderTaskList` renders from `boardTasks`, the open tab's list, so the History,
All / My and search scoping is already done and cards off the board keep
whatever state they had. On Task Drafts it is handed no ids.
`expandedTaskIds` reads the override map for that list and `collapseTasks`
writes the whole set back in one merged update, returning the previous map
untouched when nothing would change. Both live in `expand-state.ts` alongside
`isTaskExpanded` — the header and the card ask one owner the same question, so
the button can't offer to collapse a list that is already shut. That module is
framework-free and type-only in its imports, so
`scripts/expand-state-sim-test.mjs` runs it directly under node's TS type
stripping, same arrangement as `toast-store.ts` and `auth-token.ts`.

It is one-way: no Expand all. Writing an open entry for every untouched card
is the list rearranging itself under the viewer, which is the thing #161
removed. The button is `aria-disabled` rather than `disabled` when nothing
below it is open, so it holds its place in the tab order and a screen reader
user can hear that there is nothing to collapse; its accessible name says
which list it acts on.

### There is no status stripe (deleted 2026-09-06)

**Status is carried by the section the row sits in and by the button the row
offers, and by nothing else.** There is no card edge, no closed-status
backdrop, and no rule in `styles.css` that would draw either.

For a long time there was a whole vocabulary for one in the stylesheet — a 3px
inset stripe for open and in-flight, plus tinted gradient backdrops and their
own stripes for completed, cancelled and archived — and `cardClass` never
emitted a single one of those classes. Not once, and not recently: the grouped
row has always been deliberately mono. The 2026-09-05 pass did not create that
gap, but it did trip over it, asserting a design rule about an edge nothing
drew and getting caught by a review agent.

The decision owed by that pass was taken on 2026-09-06: **deleted, not wired
up.** An edge encoding status would have contradicted, on the same day, the pass
that removed every other edge marker in the app for being ornament that repeats
what the row already says in words. The court section is the status channel and
it is a better one — it is what the whole product is organised around.

`cardClass` builds exactly `task-card`, `task-card-grouped-wrap`, and the
expanded / dimmed / mini / celebrating flags. If you are reading this because
you want a new row-level state to have a channel: it does not get an edge. See
**one edge, one meaning** in Aesthetic Direction, and the *Saturated row* rule —
replace a field, don't add a margin.

Urgency lives on the create form and influences sort and due labels. It never
drove the stripe either.

### Expanded body

One stacked column (#106), sections separated by a hairline rather than
nested card chrome, in this order:

1. **Status timeline** (`.timeline`) — horizontal rail of the task's
   lifecycle, one dot + label per step, with a `NOW` (or `NEEDS CORRECTIONS`)
   tag on the current in-flight step. It was the first card component lifted
   out of `App.tsx`, into [src/timeline.tsx](src/timeline.tsx), because it is
   the web surface that puts a status into words: #247 renders it and reads the
   words back, and `App.tsx` cannot be imported into a node script to allow
   that. (`src/thread.tsx` was lifted out for the same reason in #258 — see
   below.) Flow comes from the task type:
   LOAN_DOCS gets the merge steps, FRAUD gets the two-phase checklist
   steps, everything else is Opened → Claimed → Completed. `NEEDS_REVIEW`
   renders on the `CLAIMED` step; `ARCHIVED` reads as `COMPLETED`. Step
   names are the rail's own except the two the shared `statusDisplayName`
   fixes (#237): an LOI's claimed step reads `In review`, and the
   corrections chip reads `Needs corrections` — never a literal here, so the
   bot's wording cannot drift from the web's, and
   `scripts/status-display-surface-sim-test.mjs` fails if one appears.
   Horizontal at every width — the old vertical dot-list pushed the notes
   thread far down the card (#92) — and wraps to a second line rather than
   scrolling. It's the first child so the sibling-hairline rule skips it.
2. **Nothing.** The body carries no fraud buttons and no fraud composer. The
   phase's forward move rides the collapsed row (`fraudQuick`) and the
   alternatives (`Send Back`, `Release`) sit in the hamburger with the rest of
   the secondary ladder. A lone `Send Back` used to float here directly above
   the checklist, where it read as part of the outstanding-items list rather
   than as the card's action.

   **The outstanding-items composer is gone** (2026-09-07). A hand-back used to
   reveal a textarea, placeholdered `Describe what's outstanding…` on an empty
   checklist and `Optional note for the thread…` on a full one. Both were a
   third place to type on a card that already has two: the checklist below,
   which is what the outstanding items ARE, and the conversation below that,
   which is where anything else a checker wants to say belongs. It also asked
   the checker to decide which of the two a given sentence was, every time.
   Now the items go in the list and the words go in the thread, and there is no
   third answer. See *A hand-back needs items* under Empty action slot.
3. **Checklist** (FRAUD outstanding items), when there is one. **Drawn on the
   Instructions box's ruled page** (#367): `Outstanding items` sits in the
   116px left margin column, the rows and the `Add an item` composer sit right
   of the vertical hairline in `.checklist-body`, the closing hairline separates
   it from the conversation, and under 560px it stacks the same way. It used to
   be a heading over a full-width list, so one card body had two section styles
   depending on the type. The block, head and title have no rules of their own —
   they ride the `.loi-terms` rules as selector lists, so a change to one is a
   change to both. On an empty list the composer takes `.checklist-add-flush`,
   the seeder's modifier, so no dashed rule floats at the top of the cell. Each row is
   checkbox → adder's colored initials chip (same per-person color as the
   header's assigner→assignee pair, `avatarStyle`) → text → the note
   affordance. **One** `+ note` per row, never two: the button writes the
   viewer's own seat's note field, and a viewer holds one seat or none. An
   existing note drops below the row with the author's full name, not a chip —
   it's a sentence attributed to a person.
   **The item text is the only elastic thing on that row.** `+ note` is
   `flex: 0 0 auto` and `nowrap`, the way the delete button and the stale badge
   beside it already were. Left on the default `flex: 0 1 auto` a long item
   squeezed the two-word label until it broke across two lines and the plus sat
   directly on top of the word — seeded data hit it at phone width, so it was
   never an edge case. Anything new added to this row is fixed too; the text is
   what gives.
4. **Instructions** (`.loi-terms`, every type but FRAUD) — the standing ask,
   out of the conversation and into its own box (#258 for the LOI, widened to
   five types by #300,
   [ADR-0008](../../docs/adr/0008-loi-terms-are-a-field-not-a-message.md) and
   [ADR-0010](../../docs/adr/0010-every-task-has-an-instructions-box.md)).
   **Not a panel** (2026-09-05): no border, no fill, no shadow, no radius. It
   was a bordered, shadowed box with a 3px brand left edge sitting inside the
   bordered, shadowed task card — two containers deep for one passage of text,
   with the most borrowed shape in the app stuck on its margin. It is now a
   ruled page: the field's name sits in a 116px left margin column, one
   vertical hairline divides the margin from the text, and one horizontal
   hairline closes the block off from the conversation below. Two rules, no
   container. Under 560px the columns collapse to one, the label sits back
   above its text left-aligned, and the closing hairline still carries the
   separation. The split from the thread is still carried by shape rather than
   by shouting in the headings — the shape is just a margin now instead of a
   box. Free text
   rendered as typed (`white-space: pre-wrap`, body font, 1.4 leading — tighter than the thread’s 1.45) so a
   list of figures reads as a list; no parsing, no label columns, no structured
   fields until the direct import exists. Capped at 260px with internal scroll,
   so a twenty-line term sheet cannot push the conversation off the card. It is
   the *same* `notes` field the task has always carried, just drawn here instead
   of in the thread — nothing was added and nothing migrated.
   **Body face on all five.** The mono exception is the edit form's LOI field
   and nothing else; widening the box must not drag it along.
   **A FRAUD task renders no section at all**: its standing ask is the
   outstanding-items list two blocks up, and a prose box above that list would
   ask a filer to say the same thing twice in two shapes (ADR-0010 rule 1).
   The class name is still `.loi-terms` — the box is the one ADR-0008 built,
   unchanged in shape and placement, and renaming it would churn every rule and
   test that names it for no visual change. The panel's own border is the
   separator, so `.task-card-expanded > .task-card-terms + *` drops the sibling
   hairline.
5. **Conversation** — reply thread + add-note input, all in one avatar + text style: a
   note is a single row, glyph then what they said, with no name/timestamp line
   above it (#165) — the author and the time ride the row's `title` and a
   visually-hidden span instead. Thread caps at 178px (`.msgs` `max-height`)
   with internal scroll and auto-scroll-to-newest on new entries / re-open.
   **Drawn on the same ruled page as the two sections above** (#387, chosen
   over three variants on the real card, branch
   `prototype/conversation-styling`): `Conversation` sits in the 116px left
   margin and spans the list and the composer, so the margin's hairline runs
   the whole section; the bubbles and composer sit right of it; there is no
   closing hairline, since nothing follows. It rides the `.loi-terms` selector
   lists like `.checklist` does, and `.thread-head` has no face of its own.
   Under 560px it stacks like the other two. The head reads `Conversation` on
   **every** type (`THREAD_HEAD_LABEL`), a FRAUD task included: it used to take
   the field's label there, `Notes`, and one section with two names depending
   on the type read as two things. On a FRAUD task, which still carries its
   field here, the originating note is the first row, in the same style as the
   replies. On the other five the field has left, and a task with
   no replies renders `.msgs-empty` rather than an unexplained gap. Since #300
   that empty conversation is the normal case rather than the LOI's oddity. It
   invites a reply only when the viewer has a composer; an Observer, or anyone
   on a task with no reply box, is told the conversation is empty and not
   pointed at something that isn't there.

   The instructions box and the message list are the one part of the card lifted
   out of `App.tsx`, into [src/thread.tsx](src/thread.tsx), for the reason
   `timeline.tsx` was: the promise is about rendered output, App.tsx
   can't be imported into a node script, and
   `scripts/instructions-box-sim-test.mjs` renders both and reads the markup
   back. Only the read-only halves moved; the composer and all card state
   stayed. Which of the two draws the field is never decided locally — both ask
   shared `standingInstructionsFor`, so the section cannot show it while the
   thread also does, and no renderer carries a `taskType` test of its own.

   That test file is also where the blast radius is checked. ADR-0008 flagged
   "anything assuming the thread's first row is the originating note" on one
   type and ADR-0010 widened it to five, so the unread signal, the rendered
   reply count and the bot's quoted reply cards are each asserted across every
   type rather than reasoned about.

   **Neither box carries an edit button, and the instructions box is held
   instead** (#260, then #303, then #318). Both surfaces used to host `Edit request`;
   ADR-0008 rule 4 made the hamburger's `Edit Task` the one door, and ADR-0010
   rule 4 opens a second one — not another button, the same press-and-hold the
   messages below already answer to. There is deliberately no visible trigger,
   for the reason #297 took the bubbles' `⋯` away.

   It borrows the gesture and nothing else. **There is no menu** (#318): the
   hold opens the editor, with the caret at the end of the words. #303 shipped a
   one-entry menu behind the gesture to match the bubbles, but a bubble's menu
   earns its place by carrying `Edit` and `Delete` and this one could never hold
   a second entry — instructions cannot be emptied — so it was a step that
   existed to be dismissed. Settled against three variants on the real card,
   branch `prototype/instructions-edit-gesture`.

   Two rules that came out of driving it, both load-bearing:

   - **The gesture is on the `<section>`, not on the text.** The heading strip
     and the panel's own padding are inside the bordered box; a target the size
     of the sentence is a target people miss. `data-holdable` marks the panel
     for the same reason, and it is still what the sim tests count.
   - **The panel grows; the words do not shrink.** The read view's height is
     measured at the moment of the hold and handed to the editor as its opening
     height. Opened at a fixed row count instead, a full box's text collapses to
     make room for `Save` and `Cancel`, which reads as the panel caving in under
     the press. The press itself is visible while it lasts (`.loi-terms-held`),
     because half a second with no menu at the end of it is otherwise half a
     second of nothing — which is why `useHoldMenu` reports the press through an
     optional `onPressChange`, taken by the box and not by the bubbles, which
     have a menu to arrive instead.

   The gesture is literally shared:
   `useHoldMenu` in [src/thread.tsx](src/thread.tsx) owns the threshold, the
   pointer events that cancel a press, the right-click and the swallowed click,
   and both the box and the bubbles spread its props. Written out twice, "the
   same threshold" is a thing a test has to check; written once it is true.
   Everything downstream of the gesture stays with each component and
   deliberately disagrees — a bubble opens its menu, the box opens its editor. `InstructionsEditor` in
   [src/thread.tsx](src/thread.tsx) is its own component, never a mode of the
   message editor, because the two disagree about exactly the things a shared
   component would have to branch on:

   - **Enter is a newline.** The editor has no Enter handler at all — the box
     may hold a pasted term sheet, and committing one halfway through a paste
     is a real loss where committing a sentence is not.
   - **Cancelling a changed draft asks.** Cancel and Escape both go through one
     `requestClose`, which swaps the action row for `Discard your changes?` /
     `Keep editing` once there is anything to lose, focused on the answer that
     keeps it. An untouched draft still closes on the first press. An outside
     press does not close the editor at all — the two dismissal listeners are
     armed on the menu being open, never on the editor. This is the one place
     the box is deliberately stickier than a message, which discards silently.
     "Anything to lose" is measured against an `openedWith` ref pinned when the
     editor opened, never against the live prop: the card refetches after every
     save, and on an LOI the other party can correct the box mid-rewrite. The
     same ref, for the same reason, as the task form's discard guard.
   - **There is no Delete on the menu.** Instructions cannot be emptied, so the
     control would always be refused. An emptied box is refused in the editor
     with the route's own sentence, from shared `emptyRequestFieldRefusal`.

   Whether the box answers a hold at all is shared `canAmendTask` and nothing
   else — both parties on an LOI, the creator alone on the other four, nobody on
   a closed task, restored by reopening. No permission logic is written here;
   somebody the rule refuses gets no gesture rather than an error — the panel
   simply does not answer the hold.

   **One menu is open at a time across the whole card.** That is one `useState`
   in `CardMenuScopeProvider`, wrapped around the expanded body in `App.tsx`,
   read through `useCardMenuScope` by both surfaces. Since #318 only the bubbles
   put anything in it; the box's only interest is **clearing** it when its
   editor opens, because a message menu standing open while the box becomes an
   editor is two things claiming the card at once. Ids stay namespaced
   (`msg:<id>`) so the thread's outside-press handler acts only on its own. A
   component with no provider over it keeps a private copy and behaves as it did
   before, which is what keeps `thread.tsx` renderable on its own by a node
   script.

   **Messages are bubbles** (#297). Each one wraps to its own text rather than
   filling the row — `.msg-bubble`, paper with a hairline for other people's,
   `--brand-soft` for your own — with both parties on the same side and the
   author's initials to the left. Close to the chat apps everybody uses, not a
   copy of one: a thread here has exactly two people in it, so who said what is
   carried by the initials rather than by which wall the message is against.

   Three sizing rules on that bubble are bugs, not taste, and each was hit in
   the prototype (`prototype/thread-bubbles-297`):

   - **No percentage width or max-width.** Its containing block is
     shrink-to-fit, and a percentage against an indefinite width cannot be
     resolved — it falls back to min-content, which renders one word per line.
   - **It must stay shrinkable.** Pinning it with `flex: 0 0 auto` cures that
     squeeze and hands the overflow outward: the row inherits the longest
     unwrapped line as its own minimum, outgrows the thread and is clipped by
     `.msgs`. Hence `min-width: 0` on `.msg`, `.msg-body` and `.msg-line`.
   - **The gutter that keeps a bubble off the right edge is in pixels**
     (`.msg-line { padding-right: 26px }`), for the same reason.

   **A message carries its own menu** (#287,
   [ADR-0009](../../docs/adr/0009-messages-are-editable-by-their-author.md) rule
   9) — the one sanctioned exception to that single door, because the hamburger
   belongs to the task and cannot know which of a dozen messages is meant.
   **Press and hold the bubble** to open it, on every kind of machine, plus
   right-click on a desktop. The `⋯` trigger that used to reveal it on hover is
   gone: a control that only exists under a cursor is one half the people using
   the app never find, and holding a message is what they already do elsewhere.
   `.msg-bubble-holdable` marks a bubble that takes the gesture and carries the
   `touch-action` / `user-select` / `-webkit-touch-callout` opt-outs that stop a
   phone answering the press with the magnifier, a text selection and the OS
   menu. Held, it takes a ring and a shadow (`.msg-bubble-held`) — never a
   `transform: scale`, which grows a bubble by a share of its own width and so
   expands a long message over the menu beside it.

   Whether a row offers the menu at all is the shared `canEditMessage` /
   `canDeleteMessage` — the same functions the server throws from — so it can
   never appear on a message the API would refuse, and never on the originating
   field, which is the task's ask and not a message. The sim tests count
   `data-holdable="true"` to ask that question, since there is no trigger
   element to find.

   The panel (`.msg-menu-panel`) stays **in the row's flow** — the one panel in
   the app that does. Every other one escapes its container through
   `useAnchoredPanel`; this one can't, because `thread.tsx` is deliberately
   importable by a node script and `App.tsx` is not. It sits **beside** the
   bubble rather than under it, so the row cannot grow taller when a menu opens,
   and it is **one width in both of its states** (`--msg-menu-w`): a confirm
   step wider than the menu it replaces pushes past the thread's edge, and
   `.msgs` clips horizontally because it scrolls vertically. That is why the
   confirm is a red `Sure?` beside `Cancel` rather than a question and two
   answers. `Edit` and, since #288, `Delete` beside it.

   **One at a time, and pressing away cancels.** `ThreadMessages` owns which row
   has a menu or a box open; a row holding its own copy of that cannot close its
   neighbour, which is how two edit boxes stood open at once. A press anywhere
   that is not the open menu or the open box closes both — elsewhere in the
   thread, on another bubble, or outside the card — and so does Escape. An
   unsaved edit is discarded without a prompt: it was never promised back, and a
   confirmation here would be a second dialog on the smallest surface in the
   app.

   `Edit` swaps the row's text for a textarea in place (`.msg-edit`) with
   `Save` / `Cancel`, Enter to save and Shift+Enter for a newline, the same
   idiom as every other composer here. The box holds the author's own words and
   nothing else: an app-written prefix renders beside it as static
   `.msg-edit-label` text, drawn from shared `noteLabelPrefix`, because the
   label is the app's and survives the edit. A saved message renders a muted
   `(edited)` (`.msg-edited`, body face — it is a word, not a badge) running on
   from its last line, with no edit time and no route back to the previous
   wording. The previous wording is kept in the task's history log, which no
   screen renders and #289 declined to build one for: it is a stored record
   read back through the API when someone needs it, not a surface this app
   offers. Do not write UI copy that points a person at it.

   `Delete` (#288, rule 4) sits under `Edit` in the bad accent
   (`.msg-menu-danger`) and asks once before it fires: the panel swaps to
   `Delete this message?` (`.msg-menu-confirm`) with `Delete` / `Cancel`, since
   the act has no undo and the entry beside it is harmless. What it leaves is a
   **tombstone** — the same row, muted and italic (`.msg-deleted`), still
   wearing its author's initials and byline and still in its original position,
   reading `Message deleted` or `Needs fixes: message deleted` on a withdrawn
   send-back. The words come from shared `noteBodyText`, so the Teams card's
   quoted thread says the same thing. A tombstone carries **no menu at all**:
   both halves come off the shared `canEditMessage` / `canDeleteMessage`, which
   refuse one, so there is no undelete and no editing it back into a message.
   It still counts as a message — it is a member of `reviewNotes`, so the
   collapsed row's count includes it and a thread holding only a tombstone
   renders the tombstone rather than `.msgs-empty`.

The body **ends on the notes thread**. It used to close with a compact
Created / Due meta row; that moved into the hamburger in #166 — reference
detail nobody reads on the way through a task, costing a full row plus its
rule on every open card.

Everything else (Edit Task, Re-open, Add a note, Unclaim, Cancel, Archive,
Restore, Share, Assign/Reassign, Undo Merge Done, and FRAUD's Send Back /
Release) lives in the collapsed row's hamburger, not here — there is no actions card in the body
anymore. `Send Back` is one press now: it used to open a note composer inside
the menu panel, and since 2026-09-07 it fires straight, or sits disabled with a
reason while the checklist is empty.

### Timestamps in the hamburger (#166)

The panel ends with a non-interactive block (`.task-card-menu-times`):
`Created`, the task's one other timestamp, — when someone is holding the
task — `Claimed`, and on a closed task `Completed by` (plus `Archived by` once
it is archived). Plain text below a hairline,
the way a context menu carries "Last modified" — no hover, no tab stop, and
`role="group" aria-label="Timestamps"` rather than `menuitem`: `group` is an
owned role of `menu`, so the block is announced as a labelled part of the panel
without becoming focusable or an arrow-key stop. (`role="none"` would hide it
from a screen reader in menu mode entirely.) Each date is a `<time dateTime>`,
which is why `taskTimeMeta` returns the raw `iso` next to its formatted
`value`.

Two consequences worth keeping straight:

- **The hamburger now renders on every row.** `menuHasContent` asks "is any
  block non-empty", timestamps included, rather than listing action checks.
  It has to: closed tasks and tasks you have no seat on carry no actions, and
  they are exactly the rows someone opens a menu on to check a date. If you add
  a new panel section, add it to that list, don't reason about actions.
- **The second line comes from `taskTimeMeta`**, shared with the collapsed
  row's due-cell tooltip so the two can't drift — they had, before #166. It
  covers Completed/Archived (completion time, and **no** fall back to the due
  date when there's no stamp), OOO (`Returns`), `AWAITING_ITEMS` (the hand-off
  stamp, no deadline quoted — the clock is the requester's), **unclaimed**
  (nothing at all — it returns `undefined`, because an unclaimed task has no
  deadline to quote and the row beside it already suppresses one, ADR-0005), and
  `Due` otherwise. Its `inTooltip` flag carries the one deliberate divergence: OOO
  shows in the block but not the tooltip, where the row's own cell already
  spells out the return date. Change the labels there, not at either call site.
- **The lines after the second are fetched, not stored.** ADR-0005 refused to
  persist a claim timestamp on `LoanTask`, so `Claimed` is read out of
  `GET /tasks/:id/history` — the web app's only caller of it — and reduced by
  `currentAssigneeSince` in `packages/shared`. `Completed by` / `Archived by`
  ride the same request, reduced by `completedBy` / `archivedBy` (#239): since
  ADR-0007 a creator may close a task assigned to somebody else, so the closer
  cannot be read off the assignee field. The request fires when the menu opens,
  never with the task list, and is held per card per mount against a key naming
  the assignee and the closed status it answered for: a handoff or a close while
  the card is mounted must not leave the previous answer under the new name. A
  failed or empty response shows no line and no error, and so does a task closed
  before #239 — those history rows never named an actor, and a blank is the
  honest answer where the assignee would be a plausible guess. The `Claimed`
  line is absent for an unassigned task, so an `OPEN` row's block still has two
  lines.

### Card variants (subtle, not loud)

- `task-card-own` and `task-card-watching` — **gone entirely.** One was a 2px
  left border for tasks assigned to you, stacked under the status stripe on the
  same edge, so that edge was answering two questions at once. The other
  mirrored it on the right for tasks you created. Between them the card carried
  two coloured margins meaning two unrelated things, which reads as ornament
  long before anyone decodes it — and both facts are already on the row, in the
  ASSIGNER and ASSIGNEE columns, and in the grouped view in the section the row
  is sitting in. Their rules went on 2026-09-05, having been unrendered for some
  time before that; the class names themselves are in no file in `apps/web`.
  If either fact ever needs a channel again, give it one that is not an edge.
  See **one edge, one meaning** in Aesthetic Direction.
- `task-card-mini` — half-height closed-row variant (see *Mini rows*).
- `task-card-celebrating` — a pulse halo applied for ~3s after a creator's task
  hits a completion milestone. Its colour is `--good` mixed down to 28%, never a
  literal green, so it follows each theme's answer to that role. It is a halo
  and nothing more: it used to compose an inset left edge too, which made it the
  last surviving painter of a card edge in the app, and that went with the
  stripes on 2026-09-06. Only the spread animates.
- `task-card-dimmed` — 0.55 opacity (0.85 on hover). Rules:
  - `OPEN` → always bright (anyone may claim).
  - Attached (creator or assignee) + in-flight → bright (it's your work).
  - Closed (`COMPLETED` / `CANCELLED` / `ARCHIVED`) → dim, even if you're
    attached.
  - Observer (neither creator nor assignee) + in-flight → dim.
  The celebrating card and unread notes suppress the dim — and an unread
  note only counts for a Party, so an Observer's card stays dim however
  much note activity the task has (#161).

These four are the whole set. There is nothing underneath them — see *There is
no status stripe* above.

### Unread-note signal

Per-user "I've seen the latest note from someone else" map persists in
`localStorage` keyed by user id (see `seenNotesAt` in `App.tsx`). When a
note arrives from the other party, the recipient's card:

- Drops dim (`hasUnreadNote` short-circuits `dimmed`).
- Pulses a small `.task-card-unread-dot` (7px, `--bad`) at the end of the
  collapsed row's type label (`.task-card-collapsed-type`), animated via
  `pulse-unread`.

**The dot is the type cell's second child, beside the words, not inside them.**
The cell is a flex row; `.task-card-collapsed-type-text` is the box that
truncates and the dot sits next to it at `flex: 0 0 auto`. It was a plain child
alongside the text, which meant the ellipsis capping the type at 45% of the
title cell ate the dot too — on a phone a fraud check at final approval lost it
altogether, and it is the only thing on the row saying a note is waiting. If you
ever put `text-overflow` back on the cell itself, the dot goes with it.

Its pulse halo reads `--bad` through `color-mix`, not a literal red. It was a
hardcoded `rgba(220, 38, 38, …)` haloing a dot that is a rose in dark and a pale
red in contrast, because `--bad` names a role and each theme answers it in its
own hue.

**Only for a Party.** `hasUnreadNote` comes from `hasUnreadNoteForViewer`
(`packages/shared/src/notes.ts`), which gates the note check on the viewer
being the creator or the assignee. An Observer has acknowledged nothing, so
under a bare "is there a note I haven't seen" check every note on every task
in the list read as unread at them, and someone else's work sat bright with
a red dot on it (#161). The grouped view's message-pull asks the same
predicate, so a Party's court and their red dot cannot drift apart.

The card does **not** auto-open on a new note — the red dot is the only
signal; the user opens the row to read. The lock clears only on an
explicit user gesture (`acknowledgeUnread`): header click/key, replying
via Add Note, or any state-changing button
(Claim/Complete/Approve/Cancel/Unclaim). Resetting state on user-switch
(mock picker) goes through the `trackedUserId` setState-during-render
guard so user A's seen state can't be written under user B's storage key.

**Opening a pulled task must not move it** (2026-09-06,
[src/court-latch.ts](src/court-latch.ts)). Acknowledging is what clears the
pull, the pull is what put the row in "Needs you", and recomputing the court
therefore relocated the row the moment the viewer opened it — still open,
several hundred pixels further down a thirteen-row list, and off-screen
entirely on a phone. #161 removed auto-open because the list must not rearrange
itself under the viewer; this was the same rule broken from the other side, with
the viewer's own click as the trigger.

The hold is taken on expand and released on collapse (and by Collapse all,
which must drop every hold it closes or it strands a row in a section with no
open card to justify it). `buildCourtSections` reads it **inside** the same
`them`/`pool` branch the pull reads, which is what keeps "only ever ADDS a
court, never removes one" true of the hold as well — a task that closes while
open still falls to Done. Deliberately **not persisted**: a hold means "being
read right now", so a reload ends it and the list re-sorts, which is why it does
not live in `expandOverrides` next door even though the two are taken and
released by the same gesture. Framework-free and plain-values-in, so
`scripts/court-latch-sim-test.mjs` runs it under node.

## Tags / Pills

Defined under `/* Tags */` in [apps/web/src/styles.css](src/styles.css).
Mono, ALL CAPS-ish letterspacing, with a 6px `.tag-dot` when status-like.
Variants: `.tag-green/yellow/orange/hot/red/type/status/overdue`.
`.tag-overdue` pulses (`pulse-overdue` keyframes); use sparingly — the
collapsed row already encodes overdue via red date text.

## Buttons

Single base `<button>`, modified by class:
- default = filled brand
- `.btn-good` = filled green (primary positive action: Claim, Complete,
  Approve)
- `.btn-ghost` = transparent + brand outline (secondary / cancel-edit)
- `.btn-danger` = transparent + bad outline (Cancel Task, destructive)
- `.btn-warn` = filled warn (rare; reminder-related)
- `.btn-sm` = compact size; use inside cards and tables

The fill runs through `--btn-bg` / `--btn-bg-hover`: `button` declares both
and paints `background: var(--btn-bg)`, `button:hover` reads the hover token.
A ghost button is made by setting `--btn-bg: transparent` and
`--btn-bg-hover: <tint>` on its class and **nothing else** — never by
declaring `background` on `:hover`. A bare class loses to `button:hover` on
specificity, so a `background` opt-out lands on the resting state only and the
brand fill comes straight back under the cursor (#171); custom properties
cascade on their own, so a token set on the class carries the hover state with
it. `:disabled` works
the same way — override the token (`--btn-bg-hover: var(--btn-bg)` for no
affordance at all), don't add a `:hover` rule.

Filled variants take their label color from `--on-accent`, never `#fff`.
Light theme's accents are dark enough for white ink; dark and contrast use
bright pastel fills where white collapses to ~2.8:1 or worse.

Quick-action class composition lives in `quickActionClass` in `TaskCard`.

**The collapsed row's action slot has two tiers, and exactly two** (2026-09-06).
A filled button **moves the work forward**; an outlined one
(`.task-card-quick-action-terminal`) **ends the record**. Claim, Merge Done,
Send Items, Submit and Approve Merge are filled; Complete, Confirm, the fraud
Approve and Archive are outlined. The flag is `terminal` on the `QuickAction`
the ladder builds, never `kind` — every branch already sets `kind: "good"`,
including the ones that close a task, so that field cannot answer this question.

This reverses a narrower rule, and the reason it does is worth keeping. The slot
used to carry **one** style for every action regardless of kind, replacing a
good/ghost/danger split that read as three inconsistent buttons for what is
always the row's one next-step action. That diagnosis was right and this does
not undo it: the fix is not three styles again, it is one rule with two answers.
What the single style missed is that the actions are not all one job — `Claim`
takes work on, `Archive` closes a record, and down a thirteen-row list the
button is the strongest thing on screen while saying nothing about which it is.
**Don't add a third tier.** If a new action needs to stand apart, it is either
moving work forward or ending a record; decide which.

**A terminal press asks before it fires.** `Complete` / `Confirm` / `Approve` /
`Archive` set `pendingTerminal` and open the menu panel, where
`.task-card-terminal-confirm` reuses the two-step Cancel confirm's shape — one
confirm component for the row, not a second one — and drops its red ground.
That colour belongs to cancelling; these four are the work going right and
should not be dressed as failure at the moment somebody finishes something. The
answers are answers (`Yes, archive` / `Keep open`), never OK and Cancel, and
closing the menu withdraws the question rather than leaving it armed.

Everything else still fires on one press. The point is not a confirm on every
action, it is a confirm on the ones with no way back from the row.

## Motion

Restrained. Used only at:
- Form panel slide-in (`@keyframes slideDown`, 150ms)
- Form-overlay backdrop + in-card cancel flash fade (`@keyframes fadeIn`)
- Overdue tag pulse (`@keyframes pulse-overdue`, 2s)
- Unread-note dot pulse (`@keyframes pulse-unread`, 1.6s halo, colour mixed
  from `--bad`)
- Celebrating-card halo pulse (`@keyframes pulse-celebrate`, 1.4s, runs twice
  then settles; colour mixed from `--good`, spread only)
- Notes-thread entry fade/drop-in (`@keyframes drop`)
- Upward-opening panels and rising toasts — share popover, toast host
  (`@keyframes slideUp`)
- Card hover (shadow swap)
- Bar fills on metrics (`transition: width 0.3s`)

No scroll animations, no parallax, no transitions on color/text. If
you reach for a new animation, ask whether the existing patterns cover
it first.

## Accessibility Notes

- Every card row is keyboard-focusable (`tabIndex={0}`, Enter/Space).
- Color is never the only signal: status has the section heading and the row's
  own button, lateness has the words `OVERDUE BY` and a tooltip alongside the
  red, poop has a count.
- **Links carry a standing underline**, because the light theme's interactive
  colour is ink and a link that is only ink is indistinguishable from the
  sentence around it. Don't remove it to tidy a dense row.
- `--muted` is ~5:1 against `--panel`. It was ~3.6:1, under the floor for the
  small label text it exists for. Don't lighten it back.
- `:focus-visible` uses `--focus-ring`. Don't strip outlines without
  replacing the ring.
- Theme respects Teams (`light` / `dark` / `contrast`); `contrast`
  intentionally has no shadows — expressed as a transparent no-op, never the
  keyword `none`, which voids any `box-shadow` list it appears in. That is what
  used to delete that theme's status stripes, and it would take the celebrating
  halo the same way.

## The task form (file and edit)

One form does both jobs, in [src/task-form.tsx](src/task-form.tsx). Filing a
new task is the default; passing an `edit` prop turns it into the edit mode
`Edit Task` opens (#260, ADR-0008 rule 4). Two surfaces that write the same
fields are two surfaces that drift, so there is deliberately no second form.

**Who is offered the door** is shared `canAmendTask`, never a local check —
the creator of an active task on any type, plus the assignee of an LOI, whose
request field holds the loan's terms (ADR-0008 rule 5, #263).

**What is behind the door is a second question.** Urgency and poop points stay
the creator's on every type, so `creatorOnlyFields` in
[src/task-form.tsx](src/task-form.tsx) draws that pair only when the viewer
filed the task (#261 answering #263). Filing is always your own task, so the
create form always shows both. The door predicate is deliberately not widened
to cover them: the app must never draw a control the server would refuse, and
"may this person edit anything here" and "may they move this field" are two
rules that happen to coincide for one viewer.

**The two modes are one shape** (2026-09-04 redesign). Four controls across the
top — folder name, type, timing, poop rating — in `.task-form-quad`, its own
grid rather than the form's four equal columns, because those four don't want
equal shares. Under them the request field, which is the only thing on the form
that wants vertical room, then the Humperdink link. Across the bottom,
`.task-form-foot`: a tinted strip bled out through the panel's padding to its
own edge, holding the two exits on the right and the one thing each mode has to
say beside them on the left. Two columns from 980px, one from 480px.

**Closing it asks first** (#283). The backdrop has been inert since #114, which
fixed the accidental exit; Cancel and Escape were still instant and silent, and
took the whole draft with them. Both now go through one `requestClose` in
[src/task-form.tsx](src/task-form.tsx) — one door, so the two exits can never
answer differently — which raises
[src/discard-confirm.tsx](src/discard-confirm.tsx) when there is anything to
lose. In edit mode "anything to lose" is `formHasChanges` in
[src/create-form-state.ts](src/create-form-state.ts): the form differing from
the values it OPENED with, because an edit form is full of values nobody typed,
and measuring those against a blank form would prompt every time. A create form
uses the same predicate against a blank form instead (#365, below).
Deliberately over-eager: any field, nothing
trimmed, a changed task type on its own included, plus the FRAUD seeder's
half-typed item — the one thing it *does* trim, because the seeder itself
refuses to commit a whitespace-only one. It is not `taskEdit`, which
answers the much more forgiving "is this worth sending to the server". An
untouched edit form still closes on the first press, because a prompt that
appears every time is one people stop reading. The backdrop stays inert and
raises no prompt either. Confirming is a bare `onClose`, which is the single
line the draft-saving work hangs "and clear the draft" onto.

**A create form asks whenever there is anything in it** (#365, the
maintainer's rule). The decision is `cancelAsks` in
[src/create-form-state.ts](src/create-form-state.ts), and it splits by mode.
Edit mode keeps the rule above, measured against the values it opened with. A
create form is measured against a blank form (`opening.fresh`), the Save for
later button's own yardstick, so a form restored from the autosave and left
alone still asks, and only a completely empty new task closes without a prompt.
A reopened Saved for Later task always asks, changed or not, so it never
closes silently.

**And it remembers what you typed** (#284). The prompt above only covers the
exits the app can see. The one it exists for — the Teams tab that reloads, the
session that drops — runs nothing on the way out, so the new task form keeps a
copy of itself as it is typed into and opens on that copy next time. It was a
`localStorage` copy until #371 moved it to the server, with `localStorage` kept
only as the offline fallback (below). What that looks like on screen is #285,
below.

The rules are [src/create-form-draft.ts](src/create-form-draft.ts) —
framework-free, storage handed in as three methods, so seven-day expiry and
"anything malformed is no draft" are testable without rendering a form
(`scripts/create-form-draft-sim-test.mjs`); the wiring is asserted in
`scripts/task-draft-form-sim-test.mjs`. What that buys:

- **Per person, not per machine** — `loan-tasks:create-draft:<userId>`, the same
  convention as `loan-tasks:expand:<id>`. The seat (storage object + user id) is
  pinned when the form opens, because the mock user picker can change who is
  signed in mid-form and the live id would file the first person's typing under
  the second person's name.
- **Written as they type**, on a trailing debounce keyed on the values: a
  second since #371 (`UNSAVED_SAVE_DEBOUNCE_MS`, the reopened form's), because
  each write is now a request. Never on unmount or `beforeunload`: a save that
  needs an exit path to run is not there for the failure this exists to survive.
- **Worth saving is `formHasChanges` again**, measured against a blank-slate
  open — so a changed task type on its own is enough, and the prompt and the
  draft can never disagree about what "untouched" means. Measured against
  `openedWith` instead it would call a restored draft unchanged and stop saving
  it.
- **Forgotten in one place** (`forgetDraft`), reached by a successful create,
  confirming the discard prompt, Start fresh (#285), Save for later (#343), and
  a form emptied back out. Declining the prompt changes nothing. A restored draft is not rewritten just for being opened, so its seven
  days mean untouched rather than unopened.
- **Edit mode has null storage** rather than a rule not to save — there is
  nowhere to write, so nothing further down can slip.
- **Storage that refuses or is full is silent.** Every read and write is
  wrapped, failure is `null`, and the form behaves exactly as it did before this
  existed. A restored `loanId` is kept but never trusted: `createLoanId` in
  [src/create-form-state.ts](src/create-form-state.ts) only sends one whose loan
  still exists and still carries the name in the box, so a loan renamed, merged
  or removed during the week the draft sat there behaves like any typed no-match
  (ADR-0001) rather than erroring.

**It lives on the server since #371** (ADR-0011 rule 5), and `localStorage` is
only its offline fallback. What changed underneath the bullets above:

- **Opening reads two copies and takes the newer.** App passes `autosave`, the
  server's copy, which `openNewTask` fetches again on the way in
  (`loadAutosaveRequest`, giving up after two seconds so a hanging server never
  holds the form shut). The form weighs it against the browser's copy with
  `newerAutosave`, so typing the server never got still comes back.
- **A write goes to the server first** (`keepAutosave`, through
  `onKeepAutosave`). A write that lands removes the browser's copy; one that
  fails writes it. Neither is ever toasted.
- **`forgetDraft` forgets both**, the browser's at once and the server's after
  any write still out, and only on a form with an `autosaveSeat`: a reopened or
  edit form has none, as it has no storage.
- **Autosave writes join `unsavedWrites`**, the queue every ending already waits
  on, and the timer does nothing once `ending` is set, so no keystroke's write
  can land after Create, Save for later or Discard and put the typing back.
- **Save for later from a new form sends `clearAutosave`**, which the server
  applies in the same write, so the Task Drafts tab never lists one form twice.

Two rules moved out of the component to be tested rather than described:
`draftAction` (write / keep / clear, as a truth table) and `createLoanId` above.
The submit path's "only pass a `loanId` that still matches" check was inline in
`handleSubmit` before #284 needed it to survive a week-old pick. And the effect
that drops an ineligible recipient now waits for a non-empty `directory`: a
restored draft is the first thing that can open the form with somebody already
picked, and an unloaded list is not an answer about who is eligible.

**And it says so, once, at the top** (#285). A restored draft with no
explanation is a small mystery — someone opens New Task expecting an empty form
and finds Tuesday's abandoned attempt. `.task-form-restored` is one row across
the top of the form's grid holding the info icon, the sentence
(`restoredDraftCopy` in [src/create-form-draft.ts](src/create-form-draft.ts),
a pure function for the reason `discardConfirmCopy` is one) and `Start fresh`
beside it. What keeps it honest:

- **Quiet, in `.task-form-locked`'s muted register.** No tint, no border, no
  banner and no toast: the app did what it promised, so this is prose, not an
  alert. The button is `.btn-sm .btn-ghost` — the primary action on this form is
  still Create Task.
- **No live region**, unlike the footer's two lines. Those appear while somebody
  is working and have a change to announce; this is on screen from the first
  paint inside a dialog whose contents are read on entry, and a region mounted
  with its text already in it announces nothing.
- **Keyed to how the form opened**, never to what is in it now, so editing the
  restored values does not take it away. It is where `Start fresh` lives and the
  person who wants that button is a few seconds in, having just realised this is
  not the task they meant to file.
- **`Start fresh` asks nothing.** One press empties every field and deletes the
  saved draft. A confirmation would be a prompt over a form nobody asked for,
  and a misfire costs one keystroke to start saving again.
- **It re-points `openedWith` at the blank form**, which is the subtle half.
  That ref is what the save timer measures "has anything happened here"
  against; left on the restored values, an emptied form would read as heavily
  changed, and the timer would immediately write the blank over the draft just
  deleted. (Cancel on a create form measures against the blank form since #365,
  so an emptied one closes without asking regardless.) It
  also clears everything that is a field without being in the values object —
  the typeahead's three pieces of state, the FRAUD seeder's box, the Humperdink
  paste box and its "Imported" button — and takes the line down: after `Start
  fresh` nothing was restored, so there is nothing to say.
- **Focus moves to the folder name box**, first thing and before those clears.
  The button unmounts itself, so focus would fall to the document body, outside
  the dialog — and the overlay's Escape handler only sees keys bubbling from
  inside it, leaving a keyboard user in a form with no way out. Before the
  clears because that box's `onFocus` seeds the typeahead from the value it can
  still see. `folderNameRef` is on the typeahead input for this reason; it used
  to be an edit-mode-only refusal target.

**Save for later puts a new task aside** (#343,
[ADR-0011](../../docs/adr/0011-saved-for-later-is-private-server-state.md)). A
ghost button between `Cancel` and `Create Task`, create mode only, so Create Task
stays the one filled button. What keeps it honest:

- **Pressable once the form is touched, and nothing else is asked.** "Touched"
  is `formHasChanges` against `opening.fresh`, the autosave's own yardstick, so
  the button and the autosave never disagree, and a form restored from the
  autosave can be put aside without typing into it again.
- **The whole form is kept**, including a Fraud seeder item still in its box,
  folded in the way Create folds it. The server's shape for it is held to the
  autosave's field list by `scripts/saved-for-later-sim-test.mjs`.
- **Save, then forget the autosave, then close**, and only once the save
  landed. A failed save is toasted by App and leaves the form open.
- **The Task Drafts page is its own component**, `TaskDraftsPage` in
  [src/saved-for-later.tsx](src/saved-for-later.tsx), lifted out for the reason
  `thread.tsx` was. It is the whole body of the board's Task Drafts tab (#363),
  mounted once, in the Tasks board block, with `savedForLater` as App loaded it:
  never a list the search or Mine has been at. It used to be a section inside
  `renderTaskList`, after the `you` court in Grouped view and above Flat view's
  list (#343, #346); `renderTaskList` now takes tasks and nothing else, and a
  test fails if a draft finds its way back into it. The page draws no heading
  or count, because the tab above it is both, and with nothing saved it is an
  `.empty-card` naming the Save for later button that fills it. A row is
  `.saved-row`: loan name (or `No loan yet`; on an Out of Office task the
  vacation description or `No description yet`, #362), type, `saved N ago`,
  and no more, because a saved
  task has no pair, due stamp or action to draw. Since #371 the page also takes
  `autosave` and draws it as one more `.saved-row` in the same shape, sorted in
  by `savedAt` and reading `Autosaved N ago`; its tap is `onOpenAutosave` (App's
  `openNewTask`, the New Task button's own way in) and its delete
  `onDeleteAutosave`, through the same in-row question. `taskDraftsCount` is the
  tab's count, so the tab never counts a row the page does not draw, an aged-out
  autosave included. It is not a `TaskCard` and not
  a court; `tasks` never holds one.
- **The list is emptied on every identity change** before the new one loads,
  and a load or save that comes back for the previous person is dropped, so a
  shared machine never shows one person's saved tasks under another's name.
- **A row is one button, `.saved-row-open`, inside the `<li>`** (#344). The
  whole row is the press target, dressed as the row rather than as a control:
  no fill at rest, `--row-hover` through the button tokens, and the row lifts
  to `--shadow-md` under the cursor like a task row. A child of the `<li>` and
  not the `<li>` itself so a second control (delete, #345) can sit beside it
  without nesting buttons.
- **Delete is `.saved-row-delete`, beside the reopen button** (#345): the
  checklist's `TrashIcon`, muted at rest and `--bad` only under the cursor, a
  40px square at the row's right end behind a hairline. Pressing it swaps the
  row's contents for `SavedForLaterDeleteConfirm`, an in-place question in the
  shape of the Instructions box's discard: `Delete this saved task?`, then
  `Keep` (ghost, focused on open, so a stray Return keeps it), then `Delete`
  (`btn-danger`). Escape and Keep both decline and hand focus back to the trash
  control. Not a dialog: the row is wide enough for three words and two
  buttons, and a modal over the board for that costs more than it prevents.
  Yes goes through `removeSavedForLaterRequest`, the same helper Create clears
  a filed one with; App drops the row only once the server let it go, and
  toasts and leaves it otherwise. No undo, by ADR-0011. Once a delete lands,
  the page moves focus to the row that took its place (or the new last
  row), so a keyboard user is not dropped onto the page body.
- **Reopening opens the create form, never edit mode** (#344). App fetches the
  latest save of that record (`reopenSavedForLaterRequest`) and mounts the
  create form with `reopened`, keyed on the record's id. The form opens on
  every field of it, with `opening.fresh` still the blank form so Save for
  later is pressable at once. Both endings name the record: Save for later
  passes it to `onSaveForLater`, which PUTs onto it, and Create passes it to
  `onCreate`, which removes it only after `POST /tasks` succeeded. The three
  requests live in
  [src/saved-for-later-requests.ts](src/saved-for-later-requests.ts),
  framework-free, so what a 404 means for each is driven against a fake server
  in the board sim test.
- **A reopened form has no autosave seat**, the same null storage edit mode
  has. Writing there would make a second copy of a record the server already
  keeps; clearing there would throw away an unrelated new-task form.
- **Its typing goes to the record instead** (#348, ADR-0011 rule 5): a second
  effect beside the autosave's, same trailing debounce idea
  (`UNSAVED_SAVE_DEBOUNCE_MS`, a second, because each one is a request). Its
  decision is `unsavedAction`, not the autosave's `draftAction`: it is taken
  against what the form last sent (`unsavedSent`) rather than what it opened
  on, because a form that sends as it goes can be typed back to where it
  opened with a different copy already on the server. Cancel on a reopened
  form always asks (#365), so every way out goes through Save for later, Create
  or Discard, each of which settles the writes; a failed Save for later or
  Create sends what its stop held back. It writes to the record's `unsaved` slot through `onKeepUnsaved`, never
  over `form`, so `savedAt` and the row's place stay put; a form opens on
  `unsaved` when there is one. The writes
  chain on one promise (`unsavedWrites`), and every ending (Save for later,
  Create, Discard) runs `settleUnsaved` first: it stops further writes and waits
  for the one in flight, so a keystroke's write cannot land after the ending
  and put typing back on a record just saved or cleared. A failed ending lifts
  the stop. App's two callbacks are silent and leave the board's list alone,
  since they fire on every pause in typing.
- **Cancel's prompt has a third answer on a create form** (#348):
  `DiscardConfirmDialog` takes `onSaveForLater`, and draws `Keep editing`
  (focused, as before), `Save for later` (ghost, disabled exactly when the
  footer's is) and `Discard` (danger) in that order, under `Leave this task?`.
  `saveFromPrompt` lowers the prompt and runs the footer's own `saveForLater`,
  so a failed save leaves the form in view. Edit mode passes no
  `onSaveForLater` and gets the two-way `Discard this task?` word for word.
- **Discard on a reopened Task Draft deletes it** (#388, amending #348 and
  ADR-0011). The prompt's body says so, and Discard does not close: it swaps
  the prompt for `DeleteTaskDraftDialog` in
  [src/discard-confirm.tsx](src/discard-confirm.tsx), `Delete this Task
  Draft?` with `Keep` (ghost, focused, Escape's answer) and `Delete` (danger),
  built exactly as the prompt is. Keep lowers it and nothing is written or
  cleared. Delete runs `settleUnsaved`, then App's `onDeleteReopened`, which is
  `removeSavedForLaterRequest` (the row's and Create's removal, a 404 counting
  as gone) and drops the row from `savedForLater` under the row's owner check.
  A delete that did not land toasts a warning and the form closes anyway; the
  answers are shut (`busy`) while it is out. A new task's Discard asks nothing
  more. `onDiscardUnsaved` stays for the one thing still using it, a form typed
  back to exactly its save. There is no longer a way back to a draft's last
  save.

**Share / Assign is one connected control with its own class names** (#364).
`.form-direct-mode` is a hollow track holding two `.form-direct-mode-choice`
halves, and the chosen one takes `.form-direct-mode-on`: the app menu's choice
fill (`--brand` under `--on-accent`), so it is a solid half against an empty
one in every theme and never a hue alone. Under forced colours, which repaints
every fill, the chosen half takes the system's `Highlight` pair instead, and a
`:focus-visible` rule puts a `--panel` line between its fill and the ring,
which was the fill's own colour in contrast. It used to borrow the board's
generic `.seg` classes, and #326 deleted those rules with the Grouped/Flat
segment, which left two plain filled buttons and no selected state.
`scripts/share-assign-selector-sim-test.mjs` renders both modes and fails if
the selector emits a class with no rule in `styles.css`, if the pressed half
stops being the one `pickerMode` names, or if a rule on it covers the focus
ring.

**The Humperdink import is LOI-only** (2026-09-04). `Send to Hot Task` over in
Humperdink copies a term sheet, and an LOI Check is the only type whose request
field is one — on the other five the paste box and its button took a paste
nobody has. Not disabled and not left to fail on the parse: not drawn.

**The locked type's popover** (`.task-form-type-note`) is revealed by hover,
`:focus-visible` and a click, and three things keep it honest:

- **Always in the DOM.** The chip's `aria-describedby` has to resolve at all
  times; an explanation only a pointer can reach is not one.
- **Hidden by `visibility`, never `display: none`**, which would take it out of
  the accessibility tree along with the layout — the same reasoning as
  `.sr-only` above.
- **Out of flow** (`position: absolute`), so revealing it moves nothing.

The chip is a real `<button>`: hover is no affordance on a touch screen, and it
sits where a control sits, so people press it and the press has to land
somewhere. Being a button, it takes its fill through `--btn-bg` like every other
button here, with the same value on both tokens — pressing it changes nothing
about the task, so it gets no pressed-looking affordance. It swallows Escape
while the popover is open; unstopped, Escape reaches the overlay's handler and
closes the whole form, taking the draft with it.

**Every control in the top row is told to fill its column**, and to be allowed
to shrink below its natural width. Both halves matter and neither is the
default: a `<select>`'s natural width is its *longest option* (which is what put
the type box under the Urgency label), and a field that under-fills leaves the
shortfall against one gap, so four equal 14px gaps read as four different ones.
The poop tray is the deliberate exception — content-sized, with its column
sized to it.

The footer's negative margins are tied to `.form-panel`'s padding and are
restated in the 480px block where that padding tightens. That is the price of a
full-bleed footer inside a padded panel; change one and change the other.

Edit mode differs in eight ways and no others:

- it opens preloaded from the task (`editFormValues` in
  [src/create-form-state.ts](src/create-form-state.ts)),
- the person picker, the Humperdink import and the outstanding-items seeder
  are gone — all three only mean something at filing time,
- the two timing controls stay exclusive: an `OOO` task draws its start and
  return dates and **no** urgency (the server refuses an urgency on it
  outright), every other type draws its urgency and no dates. The due date is
  the input that never appears anywhere — it is derived, from the band or from
  the return date,
- urgency and the poop picker are drawn **only for the person who filed the
  task** (`creatorOnlyFields`) — see above; everyone else who may edit is a
  checker correcting terms, and neither control is theirs to move,
- the task type is a **padlocked chip** (`.task-form-type-locked`) where the
  select sits while filing, and the reason it can't change is a **popover on the
  chip** (`.task-form-type-note`), not a line under the row. Shown rather than
  hidden: a form that dropped the type would read as one that lost track of what
  it is editing. A chip rather than a disabled `<select>`: a select that won't
  open still invites the click and still wears the clothes of the three live
  controls beside it in that row. The popover rather than a permanent line: it
  answers a question nobody has until they reach for the control, and a line
  spends a row of the form telling everybody who never did. Three things make
  that a reveal and not a hiding place — see below,
- the folder name loses its typeahead — see below,
- the request field goes tall (`.task-form-terms`), and on an **LOI** also
  takes the mono face (`.task-form-terms-mono`). That is the one place the
  "mono is for non-prose" rule bends, and it bends for the reason the rule
  exists: the box is holding a pasted term sheet, and its columns only line up
  in a fixed-width font. Every other type's field is prose and keeps the body
  face; filing keeps its two-row box either way,
- the submit button reads `Save` / `Saving…`.

**The folder name and the link write the shared loan record** (#262, ADR-0008
rule 7), not the task, so correcting either fixes it on every task for that
loan, finished ones included. Three consequences the markup carries:

- **No typeahead in edit mode.** The create form's combobox picks an *existing*
  loan to file a new task against; on a filed task, typing renames the loan it
  is already on, and a suggestion list offering a different one is repointing
  the task wearing a rename's clothes. Edit mode gets a plain text box.
- **One muted line in the footer** (`.task-form-shared-loan`), not one per
  field, appearing only once a value has actually moved — `touchesSharedLoan` in
  `create-form-state.ts` is the only thing that reveals it. It sits in
  `.task-form-foot` rather than under either box: the folder name heads the form
  and the link sits below the request field, so the only place genuinely under
  both of them is the bottom of the panel. (Before the redesign the two fields
  were pulled together into a `.task-form-loan` pair so the line could sit under
  them; that block is gone.) Never on focus: clicking a field to read it warns
  about nothing. Never a dialog, banner or toast; it is prose in the same muted
  register as `.task-form-locked`, because nothing has gone wrong. Two nodes for
  one sentence, the sr-only live region idiom used by the sole-checker warning.
- **Never on an out-of-office task.** It has no loan: its folder name is a
  vacation description that saves on the task, it has no link field, and there
  is no shared record to warn about.

### Only the two parties get the loan pair (#266)

ADR-0008 rule 5 narrows a loan edit to the task's creator or current assignee,
at a non-closed status. The form is handed the server's own refusal sentence as
`edit.loanRefusal` — resolved in `App.tsx` from shared `loanEditRefusal`, the
same function the route runs — and when it is present both boxes render
`readOnly` with the sentence in the footer (`.task-form-loan-locked`,
`.task-form-locked`'s muted register without its tuck-up margin). It takes the
shared-record line's slot, because both are one sentence about both boxes and
they are mutually exclusive by construction; a slot that could hold both would
be a design that let them collide.

- **Read-only, not hidden and not merely un-submittable.** They are the loan's
  name and link on the task being edited, so a form that dropped them would read
  as one that lost them; a box that takes typing and then refuses it is the
  version people file bugs about. `.task-form input[readonly]` takes the same
  recessed fill as the locked type chip, so the state reads off the control and
  not only off the sentence in the footer.
- **One `aria-describedby` id for both**, exactly like the muted line it stands
  in for: it is one sentence about both boxes.
- **The shared-record line is unreachable while locked** — `sharedLoanWarning`
  is `&& !loanLocked`. Read-only boxes cannot move, so it would be false anyway;
  the explicit term is there so the two can never both appear.
- **Never on OOO.** Its "folder name" is a vacation description on the task,
  governed by the creator-only amend rule, not this one.
- **`Edit Task` itself is not gated by this.** The entry belongs to another
  ticket's rule; what this shuts is the two loan fields inside the form.

`LoanFilterHeader` used to be the app's other loan-editing surface. It was first
made read-only — it sits outside any task, so it has no two parties to check,
and the ability went rather than the rule being softened for it — and has since
been **removed entirely**, along with the per-row loan filter that was its only
entry point. `onSaveLoan` went with the first step, leaving `patchLoan` with a
single caller (`saveLoanFields`). Every body through `patchLoan` carries its `taskId`,
which is what makes the confirmed merge re-send take the same check as the save
that asked — a refusal must never be reachable only after a dialog.

### The merge confirmation (#265)

A link edit that lands on another loan's link would fold the two records
together, and that question gets a real dialog —
[src/loan-merge-confirm.tsx](src/loan-merge-confirm.tsx),
`.merge-confirm-overlay` at z-index 70, above the form modal's 50 and a toast's
60. It was the app's only dialog until #283 added the discard prompt, which is
built to match it — same overlay and panel rules (one CSS block under both
names), same `alertdialog`, same inert backdrop, same Escape-declines, same
focus on the safe answer. Two dialogs that behave differently are two dialogs
people have to read twice; a third joins that list rather than forking it.

Neither contradicts the muted shared-record line above the loan fields: that
line reports a consequence of something that is going fine, these ask a
question, and a toast cannot ask a question (ADR-0008 rule 7).

- **It names the other loan**, in the title and in the body, so the person is
  making a decision rather than clearing a dialog. `mergeConfirmCopy` is a pure
  function so the wording is asserted directly.
- **It says which of the two survives**, and does not assume. The merge keeps the
  OLDER record, which on the commonest version of this — correcting a URL on a
  record filed last week so it points at a long-running loan — is the *other*
  loan, and the one being edited is the one that disappears. The 409 carries
  `survivingName` / `absorbedName` from the code that decides it, because a
  dialog guessing here tells half the people who read it the exact opposite of
  what will happen.
- **`role="alertdialog"`, inert backdrop, Escape declines**, and focus lands on
  `Keep them separate` — the destructive answer is never one stray Return away.
  The buttons are answers (`Merge the loans` / `Keep them separate`), not OK and
  Cancel.
- **Two-step round trip, not an optimistic merge.** The first save posts as it
  always did and the server refuses with a 409 naming the collision, having
  written nothing; only a yes re-sends the identical body with `confirmMerge`.
  `patchLoan` in `App.tsx` is that whole dance, and it is the single path every
  loan save goes through, so there is one confirmation rather than one per
  surface. It served two surfaces when it was built; #266 took the loan-filter
  header's edit away and left it with one, and the door stays a door.
- **A decline is not an error.** It rejects with `MergeDeclined`, which nobody
  toasts: nothing was sent, and the rejection exists only to leave the form open
  with the typing in it. What *did* happen still gets said — a merge that ran
  shows the existing transient "Merged with …" notice (ADR-0001 addendum
  2026-07-31), fired inside `patchLoan` rather than by each caller, so the notice
  belongs to the step that merged and a third editing surface inherits it.
- **A link another record already holds is asked about on any save** (#383).
  When shared `sharedLinkOf` says the task's loan shares its link with another
  loan record, `saveTaskEdit` sends that link with whatever else moved, so the
  same dialog comes up with its `linkUntouched` wording: the link is also on the
  other loan, rather than "saving it here combines". Here a No is not a No to the
  save. `saveTaskEdit` catches that decline, re-sends a rename without the link
  if there is one, saves the task's fields and resolves, so the form closes with
  no toast. A link the person changed keeps the rule above. Nothing is sent when
  the loan fields are locked (`loanRefusal`), on OOO, or on an empty edit.

**A Save sends only what moved.** `taskEdit` diffs the task against the form
and returns the changed fields; App turns that into one call per field, on the
existing focused route for each. There is no endpoint that takes a
task-shaped body and this form must never grow one. A save that changed
nothing makes no request at all, so it writes no history and DMs nobody.

The module lives outside `App.tsx` for the same reason `thread.tsx` does: the
ticket's promises are about rendered output, `App.tsx` can't be imported into
a node script, and `scripts/edit-task-form-sim-test.mjs` renders the form and
reads the markup back. `CheckIcon` / `TrashIcon` moved to
[src/icons.tsx](src/icons.tsx) so the card and the form can both draw them.

**Urgency and poop points are on the form** (#261), preloaded from the task —
a select sitting on GREEN while the task is RED is a control that lies. No
due-date input appears: changing the urgency re-derives `dueAt` server-side from
the moment of the edit, the same computation filing uses. Since #335 the
form is the only place the poops change — every rating the card draws is
read-only (see *Poop*). Both are
drawn for the filer alone (`creatorOnlyFields`) — urgency stays the creator's,
because an assignee who can extend their own deadline is not accepting a deal
(ADR-0008 rule 5), and the poops say what the creator thinks the ask is worth.

**An `OOO` task's start and return dates are on the form too** (#264, ADR-0008
rule 8), preloaded, and this is the one control that renders in *both* modes.
**Neither input floors itself at today** — any date is accepted, including one
already gone, because somebody back early correcting the record is the case this
exists for. The only `min` on the form is the return date's, set to the start
date, which is the range rule and not a calendar floor. `taskEdit` sends both
dates as one `dates` member on one route: they are a range, and the rule about
them can't be asked of half of it.

## Zoom is off on mobile

The app is hosted in the Teams mobile webview, which has no address bar and no
zoom-reset control, so a stray pinch or double-tap leaves someone magnified into
a corner of a task list with no obvious way back. Zoom is suppressed outright.

It takes three layers, because no single one covers every gesture, and
`scripts/zoom-guard-sim-test.mjs` holds all three — dropping any one of them
turns that test red:

1. **The viewport meta** in [index.html](index.html) —
   `maximum-scale=1.0, user-scalable=no`. Android/Chromium honours it; iOS does
   not.
2. **`touch-action: pan-x pan-y` on `html, body`** in
   [src/styles.css](src/styles.css) — scrolling both ways stays, pinch and
   double-tap-zoom go. `manipulation` is not enough; it only takes the
   double-tap. This rule is what takes **double-tap on every engine**, iOS
   included, which is why the JS layer below deliberately doesn't.
   `touch-action` intersects down the ancestor chain rather than being
   overridden by a descendant, so the hold-to-edit box and the message bubbles
   keep working only because their `pan-y` is a subset of this. Narrow the base
   rule and you break both; there is a test for that pair.
3. **[src/zoom-guard.ts](src/zoom-guard.ts)**, installed on `document` from
   `main.tsx` — the **iOS pinch**, and nothing else. It cancels the `gesture*`
   events, which WKWebView fires regardless of the viewport meta, and cancels a
   two-finger `touchmove`.

**Never cancel a `touchend` here.** A JS double-tap blocker lived in layer 3
briefly and broke the app: cancelling a `touchend` cancels the whole synthesized
mouse sequence after it, `click` and focus included, so suppressing the second
tap of a pair also swallowed that tap's press — two quick checks down a
checklist lost the second one, as did a tap into a field beside the control just
pressed. Layer 2 takes double-tap without touching the click, which is the whole
reason to prefer the declarative rule. The test asserts the guard registers no
`touchend` handler.

A fourth thing is the same bug wearing different clothes: **iOS zooms the page
in when a field under 16px takes focus**, and with zoom pinned off it never
zooms back out. The `@media (pointer: coarse)` block takes `input, select,
textarea` to 16px on touch devices; desktop, where the behaviour doesn't exist,
keeps the tighter type.

That rule carries `!important`, and it is load-bearing. A bare element selector
is specificity 0,0,1 and a media query adds none, so without it the floor loses
to every class-scoped field in the app — `.composer textarea`, `.msg-edit
textarea`, `.checklist-item-input` and the rest all sit at 0.85rem and kept
zooming the page on focus, the message composer being the field people touch
most. Sizing them one at a time is the trap: the next field added under 16px
inherits the bug silently. It is a blanket platform rule, so it is written as
one, and a test fails if any control rule ever outranks it.

**The same argument floors the text people read, not just the fields they type
into** (2026-09-06). The 16px input rule exists because rendered size is the
only size there is here; that was true of the labels too, and they were not
covered. Measured on the live board at 390px, the due labels rendered at
**8.8px**, the waiting label at 9.6px, the person chips at 8.96px and the type
label at 10.88px — none of them a pixel different from their 1440px size, on the
one surface with no way to go and look. `OVERDUE BY` is the case that decides
it: colour is never the only signal here, and the words beside the red date are
the second channel the accessibility notes claim.

The floor is the **last block in `styles.css`**, under `## Touch floors`, for
the reason every phone override is at the bottom: a media query adds no
specificity, so a rule written above the ones it raises loses silently. 11px for
the mono labels, 12px for the type label and the two list headings. It is scoped
to `pointer: coarse` rather than to a width, matching the input rule — the
constraint is the device and the missing zoom, not the viewport, and a narrow
desktop window can still be dragged wider.

**A press target grows by an overlay, never by a size.** The two menu triggers
take a 40px `::after` rather than a 40px box, because 32px is not a loose
number: the row's action column is that hamburger plus 6px plus
`--quick-action-w`, and the list header is built to land its own trigger on top
of it. 40 and not 44 — the halo clears each edge by 4px and the quick action
sits 6px away, so at 44 the two targets would meet and a press in the overlap
would go to whichever the browser hit-tests first.

Still unfixed and deliberately so: the checklist checkbox (18x18), its `+ note`
button (37x13) and the loan-name link (114x18). All three sit inside dense rows
with other controls within a few pixels, so a halo would overlap a neighbouring
target and steal presses. They need a layout decision, not a floor.

This is a deliberate accessibility trade: someone who needs magnification has
to use the OS-level zoom rather than the page's. It is the right call inside a
chrome-less webview where page zoom is a trap, and it should not be copied to a
surface that has a way back out.

## When Adding UI

1. Reuse a token before defining a color.
2. Reuse a section header / card / tag before inventing a layout.
3. If the collapsed task row needs a new field, replace something
   rather than appending — the row is intentionally saturated.
4. Add the variant to all three themes.
5. Keep mono for non-prose, DM Sans for prose, Bricolage for headings.
6. Update [AGENTS.md](../../AGENTS.md) when the change reflects a confirmed
   product decision (not just visual polish).
