# CLAUDE.md (apps/web)

Design / UI reference for `apps/web`. Product rules, workflow, and backend
contracts live in [../../AGENTS.md](../../AGENTS.md) — read that first for
non-visual decisions. Repo-wide git workflow and agent skills live in the
root [CLAUDE.md](../../CLAUDE.md).

## Aesthetic Direction

"Warm ledger." Off-white paper background, ink-black text, narrow accent
colors used as signal (good / warn / hot / bad). Not a SaaS-blue dashboard;
think bookkeeping pad with sharp typography.

- Display / headings: **Bricolage Grotesque** (700)
- Body: **DM Sans** (400 / 500 / 600)
- Mono / metadata / badges: **JetBrains Mono** (uppercase, tracked, small)

Mono is reserved for non-prose: status banners, dates, counts, type labels,
section counts. Prose stays in DM Sans. Don't mix.

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

### Collapsed row (the main list view)

CSS grid with **fixed columns** so rows align top-to-bottom:

```
96px   | 78px     | 84px     | minmax(0,1fr) | 84px | 96px | 116px
status | assigner | assignee | title         | poop | due  | action
```

Each slot has one job. When adding info, replace something — don't append:

- **Status banner (mono, small)** — flat status name from `STATUS_BANNER`
  via `resolveBanner` (`OPEN`, `IN PROGRESS`, `IN REVIEW`, `MERGE DONE`,
  `MERGE APPROVED`, `COMPLETED!`, `CANCELLED`, `ARCHIVED`). Perspective
  *no longer* rides on the banner — the Assigner/Assignee columns do that
  work. Stage detail (Merge Done, Merge Approved) for LOAN_DOCS rides on
  the **title** as a hyphen suffix.
- **Assigner / Assignee** — two stacked-label columns (`.task-card-people`,
  mono, uppercase first-name). `ME` (assigner = current user) and `ME` /
  `PENDING` (assignee = current user, or unassigned on OPEN) render in
  `--bad` red so personal involvement and "still needs a claim" pop
  without parsing the banner.
- **Title** — type label (e.g. `Loan Docs`), optional ` - <stage>` suffix
  in lighter weight via `task-card-collapsed-stage`, then folder name with
  optional `↗` external Humperdink link. Single line, ellipsized.
- **Poop** — fixed 5-slot inline track. Slots 1..N rendered in full
  color, remaining slots ghosted (grayscale + low opacity) so the row
  width never changes. Creator can click any slot to set the score
  (clicking the current count clears to 0). See `PoopDisplay` /
  `.poop-track`. Hidden on mini rows.
- **Due** — relative short form via `formatRelativeDue`: `due in 4h`,
  `2d overdue`. Full absolute timestamp shows as `title` tooltip. Red +
  bold (`.task-card-collapsed-due-overdue`) when overdue.
- **Action** — single contextual button (`Claim` / `Complete` /
  `Merge Done` / `Approve Merge` / `Submit` / `Approve` / `Archive`).
  Picked by the `primaryAction` ladder in `TaskCard`. When no action
  applies the slot resolves three ways (see *Empty action slot* below).
  Hidden on mini.

The **whole row** is the expand toggle (`role="button"`, Enter/Space).
Don't add a chevron; it's redundant.

### Grouped collapsed row (`.task-card-grouped`)

The grouped list renders each row as its own CSS grid. Because sibling
grids can't share tracks, **every column except the title is a fixed
width** — a content-sized column resolves differently per row and the
list goes ragged (#116, which measured 86px of hamburger drift across one
screen). Above the 780px stacked breakpoint:

```
4px    | minmax(0,1fr) | 196px | clamp(60px,8vw,110px) | 154px
stripe | title         | pair  | due                   | action
```

- **pair** (`--pair-col-w`, 196px) — assigner → assignee on one line.
  Sized past the widest pair the app renders — measured 191px for
  `Johanna → Unclaimed` (`Unclaimed` is the longest token and it pairs
  with the longest first name). Overflow **wraps** (`flex-wrap: wrap`);
  first names are never ellipsized, which is a standing rule.
- **action** (`--action-col-w`) — hamburger (32px) + 6px gap +
  `--quick-action-w` (116px). The cell is a two-track grid with the
  hamburger and the button placed by `grid-column`, not by source order,
  so a row missing either one doesn't slide the other. **Every quick
  action is 116px wide regardless of label**; `Approve Merge` is the
  longest label that lands here (~112px) and sets the ceiling. Don't
  reintroduce a `width: auto` override on `.task-card-quick-action` —
  that per-row sizing is what caused the drift.
- **title** — the only elastic track, and therefore the only thing that
  gives, via ellipsis.

### Panels that escape the card (#113, #122)

`.task-card` keeps `overflow: hidden` — rounded corners, the inset status
stripe, and the grouped-row shadow all depend on it — so any panel taller
than a collapsed row has to leave the card instead. Both the share popover
(`.share-pop-panel`, #113) and the hamburger's actions menu
(`.task-card-menu-panel`, #122) are `createPortal`'d to `document.body` and
`position: fixed`, placed from their trigger's `getBoundingClientRect()` by
the shared `placePanel` helper in `App.tsx`: prefer downward, flip up only
when below can't fit and above can, clamp both axes to the viewport, and
re-place on capture-phase `scroll` and on `resize`. The menu right-aligns
to its trigger (the hamburger sits left of the quick action); the share
popover left-aligns. z-index: menu 55, share popover 60 — the popover opens
out of the menu and layers over it.

Two consequences of portaling, both easy to regress:

- The panel is no longer a DOM descendant of the row, so **outside-click
  dismissal has to hit-test each region separately** — trigger, panel, and
  (for the menu) the share popover it hosts. Testing only one closes the
  panel the instant it opens, or tears the popover down mid-share.
- The panel is no longer inside the `stopPropagation` span that shields the
  row's expand/collapse toggle, so it carries **its own `stopBubble`**.
  React portals still bubble through the React tree; without it every button
  in the panel would also toggle the row.

### Empty action slot — three-way resolution (#117)

The `primaryAction` ladder covers one status-and-role case per branch
(including `NEEDS_REVIEW` → `Complete`, gated by the shared
`canMoveNeedsReview`, #118). When it produces nothing, the slot is **not**
blank by default — a bare hamburger with dead space beside it read as a
rendering failure on your own tasks. In order:

1. **`Waiting on <first name>`** — you're a party to the task (creator or
   assignee) and the flow is waiting on the *other* party. Whose move it is
   comes from `pendingPartyFor` in `packages/shared/src/workflow.ts` —
   `MERGE_DONE`→creator, `MERGE_APPROVED`→assignee, `AWAITING_ITEMS`→creator,
   `PENDING_APPROVAL`→assignee — never re-derived in the view. Rendered as a
   passive muted-mono `<span>` (`.task-card-quick-action-waiting`), no
   handler, at the same `--quick-action-w`. The ball is legitimately in
   someone else's court, so the row says so instead of offering a
   destructive action.
2. **`Cancel`** — you created the task, it isn't closed, and `CANCELLED` is
   still an allowed transition. Uses the **creator** condition specifically,
   not the shared `canCancelTask` (creator *or* admin): a destructive action
   must never show up in an admin's row for a task they don't own. Admins
   keep Cancel in the hamburger. Clicking it drives the hamburger's
   `cancelStage` to `confirming` and opens the menu panel, so the existing
   two-step "Cancel this task?" confirm and its "Cancelled ✓" flash are
   reused verbatim — there is no second confirm component and no undo flow.
3. **The reserved spacer** (`.task-card-quick-action-empty`) — observers, and
   anyone else with no standing. Unchanged.

All three are suppressed on mini (closed) rows, which have no action column.

Action labels come from `ACTION_LABELS` in `packages/shared`, never from
literals in `App.tsx`. The web row, the expanded body, and the Teams bot's
Adaptive Card buttons all read the same constant, so no surface can invent
its own wording (`Approve` vs `Approve Merge` was exactly that drift).

At and below 780px the row restacks to two lines (title + action on top,
pair + due below) and the action cell reverts to a content-sized flex row
with an auto-width button. That layout is separately tuned — leave it
alone.

### Mini rows (closed tasks)

Closed statuses (`COMPLETED` / `CANCELLED` / `ARCHIVED`) drop into the
bottom of the grid as `.task-card-collapsed-mini` rows: half height
(~28px min), no poop, no action column, no "Assigner/Assignee" labels
above the values. Title font shrinks. Clicking still expands to reveal
full actions (Re-open / Archive). A task that was reopened back into an
active status shows a **Restore** button in the expanded body (via
`restoreTargetStatus`) that returns it to the exact closed status it came
from — COMPLETED or ARCHIVED — for whoever reopened it (creator or
assignee), not assignee-gated like Complete.

### Auto-expand and bucket sort

`unifiedTasks` sorts into 4 buckets, newest-first within each:

1. **Celebrating** — the creator's task just hit `COMPLETED` (or
   `LOAN_DOCS` + `MERGE_DONE`). Pinned to the very top with a green
   pulse for ~3s after the transition (`task-card-celebrating` class,
   driven by `pulsingIds` state in `App.tsx`). Stays in this bucket
   until the creator archives it.
2. `OPEN` — always undimmed (anyone may claim).
3. In-flight (`CLAIMED` / `NEEDS_REVIEW` / `MERGE_DONE` / `MERGE_APPROVED`).
4. Closed (`COMPLETED` / `CANCELLED` / `ARCHIVED`) — render as mini rows.
   All three share the `CLOSED_TTL_DAYS` retention window in `buildSorted`
   (`App.tsx`): a just-closed task stays visible in Done, then drops off the
   bottom once it ages past the cutoff. (Admin Metrics counts every status
   from the raw task list, independent of this view filter.)

Rows default to collapsed, with three exceptions computed in `TaskCard`
(`defaultOpen`): `OPEN` tasks (open for everyone), a card with an unread
note from the other party, and a card where the viewer is involved
(creator/assignee) and the task is in-flight — `CLAIMED` / `NEEDS_REVIEW` /
`MERGE_DONE` / `MERGE_APPROVED` / `AWAITING_ITEMS` / `PENDING_APPROVAL`
(the last two are the FRAUD checklist phases, #98). A new unread note by
itself does not auto-open a card outside that rule — it only pulses the red
dot. A persisted per-user manual override (`expandOverride`) wins over the
default; the `useEffect([task.status, user.id])` clears it back to the
default on status transitions and on mock-user switch. Otherwise the user
clicks a row to open/close it.

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

Two-column grid (`260px / 1fr`):
- Left: meta block + `task-card-actions` (full button set, including
  Unclaim, secondary Cancel, etc.). The `Creator: <name>` line is hidden
  when the viewer is the creator — the right-edge stripe already says
  "yours."
- Right: notes panel + optional `task-card-review` thread + add-note input.
  Thread caps at 180px (`.task-card-review-list` `max-height`) with internal
  scroll and auto-scroll-to-newest on new entries / re-open.

Quick action in collapsed row is a *subset* of these — the expanded
panel is where the long tail lives. Don't promote rare actions to the
collapsed row.

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
  The celebrating card and unread notes suppress the dim.

These layer on top of the status stripe; the stripe wins visually
because it's an inset shadow, not a border.

### Unread-note signal

Per-user "I've seen the latest note from someone else" map persists in
`localStorage` keyed by user id (see `seenNotesAt` in `App.tsx`). When a
note arrives from the other party, the recipient's card:

- Drops dim (`hasUnreadNote` short-circuits `dimmed`).
- Pulses a small red `.task-card-unread-dot` (8px, `--bad`) next to the
  status-banner label, animated via `pulse-unread`.

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
