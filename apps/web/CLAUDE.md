# CLAUDE.md (apps/web)

Design / UI reference for `apps/web`. Everything non-visual (product rules,
workflow, backend contracts, git workflow, agent conventions) starts at
[../../AGENTS.md](../../AGENTS.md).

This file holds the rules that apply to any UI change. The long write-ups, with
the history and the measurements behind each rule, live beside it and load only
when read:

| Before changing | Read first |
|---|---|
| The task card: the collapsed row's grid and measurements, the action slot, portaled panels, the expanded body (timeline, checklist, instructions box, conversation), the hamburger's timestamps, card variants, the unread dot | [docs/task-card.md](docs/task-card.md) |
| The task form: filing and editing, the discard prompt, autosave and Task Drafts, Save for later, the Humperdink import and arrival, the loan fields and the merge dialog | [docs/task-form.md](docs/task-form.md) |
| The Tasks board header: the All / Mine / Drafts tabs, the loan search, the app menu | [docs/board-header.md](docs/board-header.md) |
| Zoom, `touch-action`, the touch font floors, or the size of a press target | [docs/mobile-zoom.md](docs/mobile-zoom.md) |

Every standing prohibition in those docs is repeated below, so a session that
has not opened one still cannot break it. When a doc and this file disagree,
fix whichever is wrong in the same change.

## Aesthetic Direction

"Warm ledger." Off-white paper background, ink-black text, narrow accent
colors used as signal (good / warn / hot / bad). Not a SaaS-blue dashboard;
think bookkeeping pad with sharp typography.

**In the light theme the interactive voice is ink, not a colour** (2026-09-05,
chosen off a three-way bake-off on the live board). `--brand` used to be the
SaaS blue the paragraph above disavows, carrying every link, primary button and
focus ring. It is near-black now, which leaves the four signals as the only hues
on the page. The dark theme still answers the same role with its lavender; the
two disagree on purpose.

Its one standing cost: **a link cannot announce itself by colour, so links carry
a standing underline**, faint, offset below the baseline, firming up under the
cursor. Paying that in the type is the point; paying it with a second accent
colour would undo the change.

**Ornament that encodes nothing is not decoration, it is noise** (2026-09-05).
Every edge marker went in one pass: the red rail on an overdue row, the coloured
bars on the metrics tiles, and the "assigned to you" and "you created this"
edges. Each said a second time what the row already said in words, and a tinted
tab on the edge of a list item is the single most recognisable tell of generated
UI.

The rule that replaced them: **one edge, one meaning.** If a card edge is ever
drawn again it belongs to status and to nothing else, and a fact that already
has a column, a label or a section does not also get a margin.

**No card edge is painted, and no rule exists that would paint one**
(2026-09-06). Status is carried by the section the row sits in and by the button
the row offers, and by nothing else. The old status stripe rules outlived
anything that emitted them, a session reasoned from them as if they described
the screen, and they were deleted rather than wired up. So "one edge, one
meaning" is a rule about what an edge may say if one ever returns, not a
description of anything on screen. A new row-level state does not get an edge:
replace a field, don't add a margin.

**The dark theme is a different room, on purpose** (2026-09-05). It is an indigo
ledger (indigo paper, near-white ink, a lavender accent), not the warm ledger
with the lights off. Five whole palettes were driven on the live board before
this one won, and the warm grounds lost.

Its one standing rule: **the indigo frame carries one warm note and no more.**
Every signal but `--warn` is rotated to the cool side of its own hue (overdue is
a rose, `--hot` a coral, "good" a mint, and the eight person chips all come from
the cool half of the wheel). `--warn` stays a gold. One warm accent is a note;
two are a second scheme arguing with the first. So a new signal colour added to
the dark theme gets cooled before it lands.

- Display / headings: **Bricolage Grotesque** (700)
- Body: **DM Sans** (400 / 500 / 600)
- Mono / metadata / badges: **JetBrains Mono** (uppercase, tracked, small)

Mono is reserved for non-prose: dates, counts, type labels, section
counts. Prose stays in DM Sans. Don't mix.

One exception, and it proves the rule: the edit form's request field on an
**LOI** (`.task-form-terms-mono`). That box holds a pasted term sheet (tabular
matter, not sentences) whose columns only line up in a fixed-width font. Every
other type's field is prose and stays in the body face, the instructions box on
the card included.

## Theme Tokens

All color goes through CSS custom properties on `:root` in
[src/styles.css](src/styles.css), which is the list of tokens. Three themes:
`light` (default), `dark`, `contrast`. Teams reports its theme via `data-theme`
on `<html>` (`applyTheme` in [src/App.tsx](src/App.tsx)); the person can pin one
instead (`themeChoice`, persisted), and `Match Teams` is the default because a
Teams tab that disagrees with Teams should be something you asked for.

**Never hard-code colors.** When adding a new themeable color, add it to
**all three** `:root` blocks.

**A signal token is never spent as a category colour** (2026-09-06). `--bad`
means failure everywhere in the app, so a Fraud bar painted `--bad` on a chart
that only counts filings told an admin fraud checks were going wrong. Every
metrics bar is `--ink`, differentiated by length, which is what a bar chart is
for.

A signal token names a **role**, not a hex. The dark theme answers the signals
in cool hues (mint / gold / coral / rose), so "the red one" means `--bad`, not a
red. A pulse or halo mixes its colour from the token (`color-mix`), never from a
literal.

## Layout Primitives

- **Nothing else goes in the app bar.** In a production build the dev user
  picker is stripped and the nav tabs are admin-only, so for most people the row
  is empty. A control placed there is a control they never see.
- **The list header is pinned** (`position: sticky`, z-index 30). It works
  because the page scrolls on the document and nothing above the header clips;
  an `overflow` on `.app-shell` or `body` would silently unpin it. The layers
  above it: form overlay 50, row menu 55, popovers and toasts 60, confirm
  dialogs 70.
- **The header lands on the rows' action column.** Read down the right edge and
  the app menu sits over every hamburger, `New Task` over every quick action.
  The 8px between the loan search and app menu triggers keeps their 40px touch
  overlays from meeting; don't tighten it. Tabs, search and menu in full:
  [docs/board-header.md](docs/board-header.md).
- **`--quick-action-w` has one definition, on `:root`.** The row's action
  column, the row's action button, the empty spacer on rows with no action, and
  the header's `New Task` all read it. Three of those were literal `116px`
  until the phone breakpoint moved the value and they silently stopped
  agreeing. Never write the number again.
- **A breakpoint override goes after the rule it overrides.** A media query adds
  no specificity, so a phone rule written above its base rule loses on source
  order and never applies, silently, since it parses fine. Three of the
  collapsed row's phone rules were dead this way (see *Mini rows* in
  [docs/task-card.md](docs/task-card.md) for what it cost). The task-card ones
  live at the bottom of `styles.css` under their own heading. Put new ones
  there.
- Tabs: `.tab-bar` + `.tab-btn`, underline-active, no fill. The Tasks board's
  tab row is the same `.tab-btn` with a `.board-tab` modifier that only sets the
  heading's type and spacing; don't give it its own colour, underline or hover
  rules.
- Controls on a list header share one voice: the display face at 0.82rem/600.
  Monospace is for things that are counted or labelled, and these are controls.
- Sections: `.section-head` (h2 + monospace `.section-count` chip) on a
  1px line. Use this for every list grouping.
- Cards: rounded 8px, 1px `--line-soft`, background `--panel`. **Flat at
  rest**: `--shadow-sm` is a transparent no-op, and depth comes from the
  hairline plus the tone step between `--bg` and `--panel`. `--shadow-md` is
  the real lift and is reserved for things that leave the page: hover, an
  expanded row, menus, modals, toasts.
  **Both shadow tokens stay transparent no-ops, never the keyword `none`**,
  including in the contrast theme. Any rule that composes them with a second
  shadow (the celebrating card's halo) has its whole declaration voided by that
  keyword.

## Task Card

Defined in `TaskCard` in [src/App.tsx](src/App.tsx). The collapsed row is the
densest surface in the app, and every change should preserve scannability. The
full anatomy, with the measurements and history, is
[docs/task-card.md](docs/task-card.md).

**Never add an inline arrow or fresh object literal to `cardProps`** (e.g.
`onFoo: (x) => setBar(x)`). `TaskCard` is `React.memo`'d (#73), and the memo
only bites while every prop is referentially stable. There is no
`exhaustive-deps` lint here (lint = `tsc --noEmit`), so hoist it to a stable
`useCallback`/`useMemo` first, or the whole list silently re-renders on every
30s tick.

**The row is saturated: each slot has one job.** The slots are the Assigner →
Assignee pair, the title (loan name, then the task type carrying the step the
task is on), the due stamp, and the action. When adding info, replace something
rather than appending. The `How Bad?` rating on every task that is not closed is
the row's one sanctioned append (2026-09-14, the user's call); a new field still
replaces something instead.

The whole row is the expand toggle (`role="button"`, Enter/Space). Don't add a
chevron; it's redundant.

**Rows are collapsed, full stop.** A card opens because the viewer clicked it or
a deep link asked for it, and closes because the viewer closed it. Nothing
auto-opens it, and there is no Expand all: the list must never rearrange itself
under the viewer (#161). For the same reason, opening a card that an unread
reply pulled into "Needs you" must not move it (`src/court-latch.ts`).

**Wording and rules come from `packages/shared`, never from a local table or
test.** A surface that writes its own wording is a surface that will disagree
with the others.
- Type names from `TASK_TYPE_LABELS`, action labels from `ACTION_LABELS`, step
  names from `currentStepName` / `statusDisplayName` (never a literal step name;
  `scripts/status-display-surface-sim-test.mjs` fails if one appears).
- Whose move it is from `pendingPartyFor`, never re-derived in the view.
- The due stamp asks shared `isOverdue`. Don't reintroduce a local
  `dueAt < now` test.
- "Unclaimed" is shared `isUnclaimed` (no assignee and not closed), not
  `status === "OPEN"`.
- Which controls a viewer gets comes from the same predicates the server throws
  from (`canTransitionStatus`, `canEditMessage`, `canAmendTask` and friends).
  The app must never draw a control the server would refuse.

**The rating** (`How Bad?`): changed in the task form and nowhere else; every
rating the card draws is read-only. An open card draws it in exactly one place,
never in the body (`ratingSurface`), and never on a mini row. The track keeps
all five slots on every surface. On the collapsed row it is drawn smaller than
in the menu and the form (2026-09-14, the user's call), so the type and its
rating share one line on a phone; don't grow it back without re-measuring
`Out of Office` beside it at 390px. The unread dot sits beside the loan name,
not at the end of the type.

**`Confirm` does two things in one write.** Never fire `ARCHIVED` after it from
the row; a second call is what could leave a task completed and not archived.

**Row layout rules:**
- An active row is two grid lines at every width. No responsive reflow.
- Every quick action is `--quick-action-w` wide regardless of label. Never
  reintroduce a `width: auto` override on `.task-card-quick-action`; per-row
  sizing is what made the hamburgers drift.
- The title is the only elastic track. First names are never ellipsized; the
  pair wraps.
- Don't put a label back in front of an urgency time-frame in the due cell
  without measuring it.
- Mini (closed) rows stay on one line. Never `display: none` a mini's action
  cell: its hamburger is how a closed task reaches Re-open / Archive.
- If you reserve space on the row, decide which edge the content holds to in the
  same change. Equal heights with zigzagging names is worse than neither.
- Measure with the `pointer: coarse` floor forced on. Playwright reports a fine
  pointer at every viewport, so its numbers come out ~15% narrower than a phone.
- An active row's title is one arrangement at every width (2026-09-14, the
  user's call): loan name, then the type with its rating beside it, then the
  step. No breakpoint rearranges it, and nothing on it is cut. Don't bring back
  a wide-screen one-line title or move the rating off the type's line.

**Action slot and panels:**
- A panel that escapes the card is portaled through `useAnchoredPanel`. The
  two-exit panel must not reuse `.share-pop-panel` (that class carries the
  menu's outside-click exemption). A portaled panel hosting a text field stops
  every key at its wrapper, or Space toggles the card.
- The `Checked` / `LOI Fixed` panel design is settled; don't revisit it.
- Don't fold the hand-back gate into `fraudCardActions`'s default; that would
  take away the bot's only route.
- A disabled action keeps its reason on the wrapper's `title` and the button's
  `aria-label`. Taking an explanation off the screen must not take it off the
  assistive path.

**Expanded body:**
- The checklist item text is the only elastic thing on its row; anything new
  added to that row is fixed width.
- Message bubbles: no percentage `width` or `max-width`, keep them shrinkable
  (`min-width: 0`), and a held bubble never takes `transform: scale`.
- No UI copy that points a person at the task's history log. No screen renders
  it.
- A new section in the hamburger panel goes into `menuHasContent`.

There is no tag chip. A label that needs to stand out takes a signal colour in
its own words, the way the timeline's `Needs corrections` and the red due stamp
do.

## The Task Form

One form files and edits, in [src/task-form.tsx](src/task-form.tsx). The full
account is [docs/task-form.md](docs/task-form.md). The rules that hold
everywhere in it:

- **There is no second form.** Two surfaces that write the same fields drift.
- **A Save sends only what moved**, one call per field on the existing focused
  routes. This form must never grow a task-shaped endpoint.
- **The Humperdink arrival's read is the app's only clipboard read.** No other
  opening of the form is handed a reader, and nothing in `apps/web` calls the
  browser's clipboard read.
- **A refusal must never be reachable only after a dialog.** The confirmed merge
  re-send takes the same check as the save that asked.
- **The app's dialogs are one shape**: `alertdialog`, inert backdrop, Escape
  declines, focus on the safe answer, and buttons that are answers rather than
  OK and Cancel. A third dialog joins that list rather than forking it.
- The locked type's popover is hidden by `visibility`, never `display: none`, so
  its `aria-describedby` always resolves.

## Buttons

Single base `<button>`, modified by class:
- default = filled brand
- `.btn-good` = filled `--good` (primary positive action: Claim, Complete,
  Approve)
- `.btn-ghost` = transparent, brand text, `--line` hairline border (secondary /
  cancel-edit)
- `.btn-danger` = transparent, `--bad` text, `--line` hairline border (Cancel
  Task, destructive)
- `.btn-warn` = filled warn (rare; reminder-related)
- `.btn-sm` = compact size; use inside cards and tables

The fill runs through `--btn-bg` / `--btn-bg-hover`: `button` declares both
and paints `background: var(--btn-bg)`, `button:hover` reads the hover token.
A ghost button is made by setting `--btn-bg: transparent` and
`--btn-bg-hover: <tint>` on its class and **nothing else**, never by
declaring `background` on `:hover`. A bare class loses to `button:hover` on
specificity, so a `background` opt-out lands on the resting state only and the
brand fill comes straight back under the cursor (#171). `:disabled` works the
same way: override the token (`--btn-bg-hover: var(--btn-bg)` for no affordance
at all), don't add a `:hover` rule.

Known drift, not a pattern to copy: the four variant classes above predate that
rule and still declare `background` on the class and on `:hover`, and
`.btn-good:hover` hard-codes `#256942`. Move a variant onto the tokens when you
next touch it.

Filled variants take their label color from `--on-accent`, never `#fff`.
Light theme's accents are dark enough for white ink; dark and contrast use
bright pastel fills where white collapses to ~2.8:1 or worse.

Quick-action class composition lives in `quickActionClass` in `TaskCard`.

**The collapsed row's action slot has two tiers, and exactly two** (2026-09-06).
A filled button **moves the work forward**; an outlined one
(`.task-card-quick-action-terminal`) **ends the record**. Claim, Merge Done,
Send Items, Submit and Approve Merge are filled; Complete, Confirm, the fraud
Approve and Archive are outlined. The flag is `terminal` on the `QuickAction`
the ladder builds, never `kind` (every branch already sets `kind: "good"`).
**Don't add a third tier.** If a new action needs to stand apart, it is either
moving work forward or ending a record; decide which.

**A terminal press asks before it fires.** `Complete` / `Confirm` / `Approve` /
`Archive` set `pendingTerminal` and open the menu panel, where
`.task-card-terminal-confirm` reuses the Cancel confirm's shape without its red
ground: these four are the work going right. The answers are answers
(`Yes, archive` / `Keep open`), never OK and Cancel, and closing the menu
withdraws the question. Everything else fires on one press.

## Motion

Restrained. The existing animations (form slide-in, fades, the unread dot and
celebrating card pulses, thread entry, upward-opening panels and toasts, card
hover shadow, metric bar fills) are all in `styles.css`. No scroll animations,
no parallax, no transitions on color/text. If you reach for a new animation, ask
whether the existing patterns cover it first.

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
- `contrast` intentionally has no shadows, expressed as a transparent no-op,
  never the keyword `none` (see *Cards* above).

## Zoom Is Off on Mobile

The Teams mobile webview has no zoom-reset control, so page zoom is suppressed
outright, in three layers that `scripts/zoom-guard-sim-test.mjs` holds together.
The full account is [docs/mobile-zoom.md](docs/mobile-zoom.md).

- **Never cancel a `touchend`** in `src/zoom-guard.ts`. It cancels the whole
  synthesized mouse sequence after it, so a quick second tap loses its click.
- **Don't narrow `touch-action: pan-x pan-y` on `html, body`.** `touch-action`
  intersects down the tree, and hold-to-edit and the message bubbles only work
  because their `pan-y` is a subset of it.
- **The 16px field floor under `pointer: coarse` keeps its `!important`**, and
  fields are never sized one at a time. The text floors are the last block in
  `styles.css`, for the breakpoint-order reason above.
- **A press target grows by an overlay, never by a size**: a 40px `::after`, not
  a 40px box, because the 32px triggers are what the header and the action
  column line up on.

## When Adding UI

1. Reuse a token before defining a color.
2. Reuse a section header or card before inventing a layout.
3. If the collapsed task row needs a new field, replace something
   rather than appending. The row is intentionally saturated.
4. Add the variant to all three themes.
5. Keep mono for non-prose, DM Sans for prose, Bricolage for headings.
6. Read the matching doc in the table at the top before changing that area, and
   keep it true in the same change.
7. Update [AGENTS.md](../../AGENTS.md) when the change reflects a confirmed
   product decision (not just visual polish).
