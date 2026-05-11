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

### Collapsed row (the main list view)

CSS grid with **fixed columns** so rows align top-to-bottom:

```
108px  | minmax(0,1fr) | 84px | 110px | 132px
status | title         | poop | due   | action
```

Each slot has one job. When adding info, replace something — don't append:

- **Status banner (mono, small)** — perspective-aware via `resolveBanner` in
  `App.tsx`, not a flat status-name map. Multi-line stack inside the 108px
  column: primary label + optional `subs[]` (mono, weight 500, `--muted`).
  Cases:
  - `PENDING CLAIM` — your task, nobody picked it up
  - `CLAIMED` / `<other-first-name>` — assignee view of an in-flight task
  - `IN PROGRESS` / `<other-first-name>` — task is in the other party's court
  - `MERGE DONE`, `COMPLETED`, `CANCELLED`, `ARCHIVED` — terminal/leaf states
    fall through to the static `STATUS_BANNER` map.
  Stage detail (Merge Done, Merge Approved) for LOAN_DOCS rides on the
  **title** as a hyphen suffix, not the banner — keeps the banner about
  whose court the task sits in.
- **Title** — type label (e.g. `Loan Docs`), optional ` - <stage>` suffix
  in lighter weight via `task-card-collapsed-stage`, then folder name with
  optional `↗` external Humperdink link. Single line, ellipsized.
- **Poop** — fixed 5-slot inline track. Slots 1..N rendered in full
  color, remaining slots ghosted (grayscale + low opacity) so the row
  width never changes. Creator can click any slot to set the score
  (clicking the current count clears to 0). See `PoopDisplay` /
  `.poop-track`.
- **Due** — relative short form via `formatRelativeDue`: `due in 4h`,
  `2d overdue`. Full absolute timestamp shows as `title` tooltip. Red +
  bold (`.task-card-collapsed-due-overdue`) when overdue.
- **Action** — single contextual button (`Claim` / `Complete` /
  `Approve` / `Cancel` / `Re-open` / `Archive`). Picked by the
  `primaryAction` ladder in `TaskCard`. When no action applies, an empty
  spacer keeps the column reserved so rows still align.

The **whole row** is the expand toggle (`role="button"`, Enter/Space).
Don't add a chevron; it's redundant.

### Auto-expand and bucket sort

The collapsed/expanded default is derived from "is this in the viewer's
court?", not just status:

- Auto-pops on mount when `actionableByMe` (assignee on
  CLAIMED/NEEDS_REVIEW/MERGE_APPROVED, creator on MERGE_DONE) or when an
  Available Tasks variant card is OPEN.
- A `useEffect([task.status])` re-derives `expanded` on transitions so a
  task collapses the moment it leaves your court (e.g. assignee marks merge
  done → card collapses, drops into the other-court bucket).

`My Tasks` is sorted into 4 buckets via `sortedMyTasks`:
1. `COMPLETED` (creator's archive queue)
2. Actionable by you
3. In the other party's court
4. Pending claim

Sub-labels were tried and dropped — banner text + dim + sort encode the
bucket without an extra header row.

### Urgency = left stripe, not a pill

Urgency renders as a 3px colored inset stripe on the card via
`URGENCY_STRIPE_CLASS` → `.task-card-urg-{green|yellow|orange|red}`.
The full label (`Within 24 Hours`, `Urgent Now`, ...) is in the row's
`title` tooltip and on the create form. Do not bring back an inline
urgency pill — it duplicates the stripe and crowds the row.

OOO tasks have no urgency stripe.

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
  urgency stripe (left edge), so left=urgency, right=ownership without
  competing.
- `task-card-shrunk` — pending-claim row variant. Reduced padding
  (4px vs 10px) and smaller title weight; rides with `task-card-dimmed`.
- `task-card-dimmed` — 0.55 opacity. Applied when the task is in the
  **other party's court** (you're waiting) **or** is your own pending
  claim. Suppressed when an unread note is present (see below).
- `task-card-closed` — 0.7 opacity for closed-status tasks the user
  didn't create.

These layer on top of the urgency stripe; the stripe wins visually
because it's an inset shadow, not a border.

### Unread-note signal

Per-user "I've seen the latest note from someone else" map persists in
`localStorage` keyed by user id (see `seenNotesAt` in `App.tsx`). When a
note arrives from the other party, the recipient's card:

- Force-opens (overrides the auto-expand rule).
- Drops dim (`hasUnreadNote` short-circuits `dimmed`).
- Pulses a small red `.task-card-unread-dot` (8px, `--bad`) next to the
  status-banner label, animated via `pulse-unread`.

The lock clears only on an explicit user gesture (`acknowledgeUnread`):
header click/key, replying via Add Note, or any state-changing button
(Claim/Complete/Approve/Cancel/Unclaim). Auto-popping does **not** mark
seen — otherwise the undim/dot would never visibly land. Resetting state
on user-switch (mock picker) goes through the `trackedUserId` setState-
during-render guard so user A's seen state can't be written under user B's
storage key.

## Recent Activity Table

`RecentActivityTable` in [apps/web/src/App.tsx](apps/web/src/App.tsx).
Distinct from the card list: dense tabular view of the last 30 tasks,
expandable inline (renders the same `TaskCard` body with
`hideCollapsedHeader`). Faded mask (`-webkit-mask-image`) on the tbody
softens the bottom edge — keep it, it signals "tail of history" without
a hard cut.

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
