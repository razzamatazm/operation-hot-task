# CLAUDE.md (apps/web)

Design / UI reference for `apps/web`. Everything non-visual — product rules,
workflow, backend contracts, git workflow, agent conventions — starts at
[../../AGENTS.md](../../AGENTS.md).

## Aesthetic Direction

"Warm ledger." Off-white paper background, ink-black text, narrow accent
colors used as signal (good / warn / hot / bad). Not a SaaS-blue dashboard;
think bookkeeping pad with sharp typography.

- Display / headings: **Bricolage Grotesque** (700)
- Body: **DM Sans** (400 / 500 / 600)
- Mono / metadata / badges: **JetBrains Mono** (uppercase, tracked, small)

Mono is reserved for non-prose: dates, counts, type labels, section
counts. Prose stays in DM Sans. Don't mix.

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
| `--hot`  / `--hot-bg`       | Orange urgency, Loan Docs type bar       |
| `--bad`  / `--bad-bg`       | Red urgency, overdue, cancelled, errors  |
| `--row-alt`, `--row-hover`  | Striping and hover overlays              |
| `--control-hover`           | Hover tint for a non-filled inline control|
| `--shadow-sm`, `--shadow-md`| Card resting / hover elevation           |
| `--focus-ring`              | `:focus-visible` ring                    |

When adding a new themeable color, add it to **all three** `:root` blocks.

## Layout Primitives

- App shell: `.app-shell`, max-width 1320px, 12px gap stack.
- App bar: nav tabs (admin only) + user picker, no brand lockup (Teams'
  own tab chrome already shows the app name). `New Task` and the
  Grouped/Flat segment live on each list's own `.section-head` instead.
- Tabs: `.tab-bar` + `.tab-btn`, underline-active, no fill.
- Sections: `.section-head` (h2 + monospace `.section-count` chip) on a
  1px line. Use this for every list grouping.
- Cards: rounded 8px, 1px `--line-soft`, `--shadow-sm` resting,
  `--shadow-md` on hover. Background `--panel`.

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
  rides on the **title** as a hyphen suffix.
- **Title** — type label (e.g. `Loan Docs`), optional ` - <stage>` suffix
  in lighter weight via `task-card-collapsed-stage`, then folder name with
  optional `↗` external Humperdink link. Single line, ellipsized.
- **Poop** — fixed 5-slot inline track. Slots 1..N rendered in full
  color, remaining slots ghosted (grayscale + low opacity) so the row
  width never changes. Creator can click any slot to set the score
  (clicking the current count clears to 0). See `PoopDisplay` /
  `.poop-track`. Hidden on mini rows.
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
  `Send Items` is the one entry that can't complete from the row: it is
  note-required, so with an empty checklist it expands the card and opens
  the composer in the body instead of firing. It is worded short (not
  "Send Outstanding Items") because the slot never resizes to its label. When no action
  applies the slot resolves three ways (see *Empty action slot* below).
  Hidden on mini.

The **whole row** is the expand toggle (`role="button"`, Enter/Space).
Don't add a chevron; it's redundant.

### Grouped collapsed row (`.task-card-grouped`)

The grouped list renders each row as its own CSS grid. Because sibling
grids can't share tracks, a content-sized column resolves differently per
row and the list goes ragged (#116, which measured 86px of hamburger drift
across one screen).

An active row is **two lines at every width** — there is no responsive
reflow, deliberately. The pair used to share one line with the title and
needed a fixed 196px reservation sized to the widest pair in the app; on a
typical row that left ~38px of dead space between the names and the due
stamp. Moving the pair onto its own line removed both the gap and the
reservation:

```
4px    | minmax(0,1fr) | 154px
stripe | title         | action
stripe | pair          | due
```

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
  reach both the badge and the red row stripe on its own.
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
4px    | minmax(0,1fr) | 168px | 72px | 32px
stripe | title         | pair  | due  | action
```

`168px` and `72px` clear the widest pair and done-time measured across the
closed rows (164px / 65px); `32px` is the hamburger alone. A mini never
renders a quick action, so reserving the full `--action-col-w` stranded its
hamburger 136px short of the row's right edge. The cluster's right edge
therefore lines up with the **quick action button's** right edge on the
active rows — not with their hamburger, which sits a track further left.
Minis do still host a hamburger — it is how a closed task reaches
Re-open / Archive — so never `display: none` the action cell on a mini.

### Panels that escape the card (#113, #122)

`.task-card` keeps `overflow: hidden` — rounded corners, the inset status
stripe, and the grouped-row shadow all depend on it — so any panel taller
than a collapsed row has to leave the card instead. Both the share popover
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

### A blocked primary action (#184)

The ladder can also produce an action the task's **state** won't take yet —
today only FRAUD's `Submit`, held until every checklist item is checked or
noted. That is not the same thing as having no action: the requester needs to
see that Submit *is* the next step and why it won't go. The slot renders the
button `disabled` inside `.task-card-quick-action-slot`, with the blocking
count stacked beneath it (`.task-card-quick-action-blocked`) and the full
sentence on the wrapper's `title` and the button's `aria-label`. Clicking
anywhere in the slot expands the card, where the checklist head repeats the
sentence and the blocking rows carry `.checklist-item-blocking`.

Both come from `packages/shared` as a pair — `fraudCardActions(...)` returns
`blockedReason` and `blockedCount` together, and the row carries the count
through rather than recomputing it, so the slot can never contradict the
sentence in its own tooltip. The view never decides who may submit or when.
The button's placement is the slot's business too: the action cell's
`grid-column` rules apply to its own children, never through the slot to the
button (that is what pushed the sub-label into an implicit column and blew the
116px track). This is
the one state where an active row runs a hair past two lines; the sub-label is
a state-specific hint, not a layout reflow, and it appears only on the blocked
requester's own row.

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
   All three share the `CLOSED_TTL_DAYS` retention window in `buildSorted`
   (`App.tsx`): a just-closed task stays visible in Done, then drops off the
   bottom once it ages past the cutoff. (Admin Metrics counts every status
   from the raw task list, independent of this view filter.)

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
at*. `CollapseAllButton` renders on all three list headers (standard,
loan-filtered, admin All Tasks) beside `GroupSeg`, and each is handed the ids
its own `renderTaskList` renders, so the tab / loan-filter / grouping scoping
is already done and cards in other lists keep whatever state they had.
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
which list it acts on, because three headers render the same two words.

### Status = left stripe

The 3px colored inset stripe on the card encodes **task status**, not
urgency. `STATUS_STRIPE_CLASS` →
- `.task-card-stripe-open` — red (`--bad`): needs a claim.
- `.task-card-stripe-progress` — orange (`--hot`): in-flight.
- COMPLETED / CANCELLED / ARCHIVED carry their own closed-status
  stripes (green / red / gray) plus the gradient backdrop.

Urgency lives on the create form and influences sort/due labels, but
no longer drives the stripe. OOO tasks have no stripe.

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
2. **FRAUD note composer**, and only when the row's own note-required move
   has opened it. The body carries no fraud *buttons* at all: the phase's
   forward move rides the collapsed row (`fraudQuick`) and the alternatives
   (`Send Back`, `Release`) sit in the hamburger with the rest of the
   secondary ladder. A lone `Send Back` used to float here directly above
   the checklist, where it read as part of the outstanding-items list
   rather than as the card's action. The composer stays because the row
   can't host a textarea — it has nowhere else to go.
3. **Checklist** (FRAUD outstanding items), when there is one. Each row is
   checkbox → adder's colored initials chip (same per-person color as the
   header's assigner→assignee pair, `avatarStyle`) → text → the note
   affordance. **One** `+ note` per row, never two: the button writes the
   viewer's own seat's note field, and a viewer holds one seat or none. An
   existing note drops below the row with the author's full name, not a chip —
   it's a sentence attributed to a person.
4. **Terms** (`.loi-terms`, LOI only) — the standing description of the loan
   being checked, out of the conversation and into its own box (#258,
   [ADR-0008](../../docs/adr/0008-loi-terms-are-a-field-not-a-message.md)). A
   bordered, shadowed panel with a 3px brand left edge, raised off the recessed
   expanded body while the thread below it stays bare rows on the background —
   the split is carried by shape, not by shouting in the headings. Free text
   rendered as typed (`white-space: pre-wrap`, body font, 1.4 leading — tighter than the thread’s 1.45) so a
   list of figures reads as a list; no parsing, no label columns, no structured
   fields until the direct import exists. It is the *same* `notes` field the
   task has always carried, just drawn here instead of in the thread — nothing
   was added and nothing migrated. The other five types render no section at
   all: they have no field a second person verifies, so it would be structure
   without meaning, and an LOI and a Buddy Chat being laid out differently is
   deliberate. The panel's own border is the separator, so
   `.task-card-expanded > .task-card-terms + *` drops the sibling hairline.
5. **Notes** — reply thread + add-note input, all in one avatar + text style: a
   note is a single row, glyph then what they said, with no name/timestamp line
   above it (#165) — the author and the time ride the row's `title` and a
   visually-hidden span instead. Thread caps at 178px (`.msgs` `max-height`)
   with internal scroll and auto-scroll-to-newest on new entries / re-open.
   On the five types that still carry their field here, the originating note is
   the first row, in the same style as the replies, and the head reads with the
   field's label. On an LOI the field has left, so the head reads
   `Conversation` — naming the box next door would be a lie — and an LOI with
   no replies renders `.msgs-empty` rather than an unexplained gap. That state
   invites a reply only when the viewer has a composer; an Observer, or anyone
   on a task with no reply box, is told the conversation is empty and not
   pointed at something that isn't there.

   The terms section and the message list are the one part of the card lifted
   out of `App.tsx`, into [src/thread.tsx](src/thread.tsx), for the reason
   `timeline.tsx` was: ADR-0008's promise is about rendered output, App.tsx
   can't be imported into a node script, and
   `scripts/loi-terms-section-sim-test.mjs` renders both and reads the markup
   back. Only the read-only halves moved; the composer, the amend block and all
   card state stayed. Which of the two draws the field is never decided locally
   — both ask shared `standingTermsFor`, so the section cannot show it while
   the thread also does.

The body **ends on the notes thread**. It used to close with a compact
Created / Due meta row; that moved into the hamburger in #166 — reference
detail nobody reads on the way through a task, costing a full row plus its
rule on every open card.

Everything else (Re-open, Add a note, Unclaim, Cancel, Archive, Restore,
Share, Assign/Reassign, Undo Merge Done, and FRAUD's Send Back / Release) lives in the
collapsed row's hamburger, not here — there is no actions card in the body
anymore. `Send Back` is note-required, so it opens its composer inside the
menu panel; that is fine, the panel already hosts the `Add a note` field and
its Esc handler exempts text fields.

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

- `task-card-own` — 2px brand-soft left border. Tasks assigned to you.
- `task-card-watching` — 3px brand-soft right-edge stripe via `::after`.
  Marks tasks **you created** but didn't assign to yourself. Mirrors the
  status stripe (left edge), so left=status, right=ownership without
  competing.
- `task-card-mini` — half-height closed-row variant (see *Mini rows*).
- `task-card-celebrating` — green pulse halo applied for ~3s after a
  creator's task hits a completion milestone.
- `task-card-dimmed` — 0.55 opacity (0.85 on hover). Rules:
  - `OPEN` → always bright (anyone may claim).
  - Attached (creator or assignee) + in-flight → bright (it's your work).
  - Closed (`COMPLETED` / `CANCELLED` / `ARCHIVED`) → dim, even if you're
    attached.
  - Observer (neither creator nor assignee) + in-flight → dim.
  The celebrating card and unread notes suppress the dim — and an unread
  note only counts for a Party, so an Observer's card stays dim however
  much note activity the task has (#161).

These layer on top of the status stripe; the stripe wins visually
because it's an inset shadow, not a border.

### Unread-note signal

Per-user "I've seen the latest note from someone else" map persists in
`localStorage` keyed by user id (see `seenNotesAt` in `App.tsx`). When a
note arrives from the other party, the recipient's card:

- Drops dim (`hasUnreadNote` short-circuits `dimmed`).
- Pulses a small red `.task-card-unread-dot` (8px, `--bad`) at the end of
  the collapsed row's type label (`.task-card-collapsed-type`), animated via
  `pulse-unread`.

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

## Motion

Restrained. Used only at:
- Form panel slide-in (`@keyframes slideDown`, 150ms)
- Form-overlay backdrop + in-card cancel flash fade (`@keyframes fadeIn`)
- Overdue tag pulse (`@keyframes pulse-overdue`, 2s)
- Unread-note dot pulse (`@keyframes pulse-unread`, 1.6s halo)
- Celebrating-card green halo pulse (`@keyframes pulse-celebrate`, 1.4s, runs
  twice then settles)
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
- Color is never the only signal: status has text, urgency has a
  tooltip + stripe + (red) overdue text, poop has a count.
- `:focus-visible` uses `--focus-ring`. Don't strip outlines without
  replacing the ring.
- Theme respects Teams (`light` / `dark` / `contrast`); `contrast`
  intentionally has no shadows.

## When Adding UI

1. Reuse a token before defining a color.
2. Reuse a section header / card / tag before inventing a layout.
3. If the collapsed task row needs a new field, replace something
   rather than appending — the row is intentionally saturated.
4. Add the variant to all three themes.
5. Keep mono for non-prose, DM Sans for prose, Bricolage for headings.
6. Update [AGENTS.md](../../AGENTS.md) when the change reflects a confirmed
   product decision (not just visual polish).
