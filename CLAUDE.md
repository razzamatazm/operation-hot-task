# CLAUDE.md

Design / UI reference for `apps/web`. Product rules, workflow, and backend
contracts live in [AGENTS.md](AGENTS.md) — read that first for non-visual
decisions.

## Git Workflow (solo dev)

- **Trivial changes** (typo, copy tweak, single-line fix, config nudge, doc
  edit): commit straight to `main` and push. No branch, no PR.
- **Major changes** (new feature, refactor touching multiple files,
  schema/contract change, anything risky or worth a code review): work on a
  dedicated branch, open a PR, let Codex review run, then
  `gh pr merge --auto --squash --delete-branch` so cleanup is automatic.
- When in doubt, lean toward a branch — easier to revert one PR than to
  unwind a bad commit on `main`.

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
[apps/web/src/styles.css](apps/web/src/styles.css). Three themes: `light`
(default), `dark`, `contrast`. The active theme is set by Teams via
`data-theme` on `<html>` (see `applyTheme` in
[apps/web/src/App.tsx](apps/web/src/App.tsx)).

Never hard-code colors. Use the variables:

| Token                       | Role                                     |
|-----------------------------|------------------------------------------|
| `--bg`, `--bg-soft`, `--panel` | Background layers, low → high           |
| `--ink`, `--ink-secondary`, `--muted` | Text strength, high → low        |
| `--line`, `--line-soft`     | Borders, strong → faint                  |
| `--brand`, `--brand-hover`, `--brand-soft` | Primary action / link        |
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
- Top bar: title + `New Task` toggle + user picker. 2px ink underline.
- Tabs: `.tab-bar` + `.tab-btn`, underline-active, no fill.
- Sections: `.section-head` (h2 + monospace `.section-count` chip) on a
  1px line. Use this for every list grouping.
- Cards: rounded 8px, 1px `--line-soft`, `--shadow-sm` resting,
  `--shadow-md` on hover. Background `--panel`.

## Task Card Anatomy

Defined in `TaskCard` in [apps/web/src/App.tsx](apps/web/src/App.tsx).
The collapsed row is the densest surface in the app — every change should
preserve scannability.

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
  `Approve` / `Cancel` / `Re-open` / `Archive`). Picked by the
  `primaryAction` ladder in `TaskCard`. When no action applies, an empty
  spacer keeps the column reserved so rows still align. Hidden on mini.

The **whole row** is the expand toggle (`role="button"`, Enter/Space).
Don't add a chevron; it's redundant.

### Mini rows (closed tasks)

Closed statuses (`COMPLETED` / `CANCELLED` / `ARCHIVED`) drop into the
bottom of the grid as `.task-card-collapsed-mini` rows: half height
(~28px min), no poop, no action column, no "Assigner/Assignee" labels
above the values. Title font shrinks. Clicking still expands to reveal
full actions (Re-open / Archive).

### Auto-expand and bucket sort

`unifiedTasks` sorts into 4 buckets, newest-first within each:

1. **Celebrating** — the creator's task just hit `COMPLETED` (or
   `LOAN_DOCS` + `MERGE_DONE`). Pinned to the very top with a green
   pulse for ~3s after the transition (`task-card-celebrating` class,
   driven by `pulsingIds` state in `App.tsx`). Stays in this bucket
   until the creator archives it.
2. `OPEN` — always undimmed (anyone may claim).
3. In-flight (`CLAIMED` / `NEEDS_REVIEW` / `MERGE_DONE` / `MERGE_APPROVED`).
4. Closed (`COMPLETED` / `ARCHIVED`) — render as mini rows. `CANCELLED`
   is filtered out of the grid entirely (still counted in the admin
   Metrics panel).

Rows never auto-expand — every card renders collapsed, including on a
new unread note (that only pulses the red dot). The
`useEffect([task.status, user.id])` collapses `expanded` back to `false`
on status transitions and on mock-user switch. The user clicks a row to
open it.

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

Defined under `/* Tags */` in [apps/web/src/styles.css](apps/web/src/styles.css).
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

Quick-action class composition lives in `quickActionClass` in `TaskCard`.

## Motion

Restrained. Used only at:
- Form panel slide-in (`@keyframes slideDown`, 150ms)
- Notification chip fade (`@keyframes fadeIn`)
- Overdue tag pulse (`@keyframes pulse-overdue`, 2s)
- Unread-note dot pulse (`@keyframes pulse-unread`, 1.6s halo)
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
6. Update [AGENTS.md](AGENTS.md) when the change reflects a confirmed
   product decision (not just visual polish).
