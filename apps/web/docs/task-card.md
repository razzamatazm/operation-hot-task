# Task Card Anatomy

The long form of the card rules in [../CLAUDE.md](../CLAUDE.md), moved out of
that file on 2026-09-14 so it loads only when it is needed. Read it before
changing the collapsed row's grid, the action slot, a portaled panel, the
expanded body, the hamburger's timestamps, a card variant or the unread dot.

Defined in `TaskCard` in [src/App.tsx](../src/App.tsx).
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
**flat**, chosen under View in the app menu. The bucket sort described
under *Bucket sort* below is the **flat** ordering. Grouped
sections come from `buildCourtSections` and follow
[CONTEXT.md](../../../CONTEXT.md#the-four-courts).

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
  rides on the **title**, beside the type. The `How Bad?` score rides the
  title too — see *Poop* below.
- **Title** — on an active row, three lines at every width (2026-09-14, the
  user's call): the loan name, then the task type with its `How Bad?` rating
  right beside it, then the step the task is on (`Claimed`, `In review`,
  `Merge done`) in lighter weight via `task-card-collapsed-stage`. Nothing on
  it is cut. See *Grouped collapsed row* for the rules.
- **Poop** — the `How Bad?` score, and it is on the row **of every task that
  is not closed** (2026-09-14, the user's call). From 2026-09-07 it showed only
  while a task was unclaimed, narrowed on 2026-09-10 to unclaimed and out for
  the first time, on the reasoning that it answers one question: can I take a
  five-poop set of loan docs right now. That missed the second question it
  answers. A teammate reads the ratings on in-flight work to judge who is
  already buried before asking them for anything, and with no rating on a
  claimed row every in-flight task looks the same size (#431). It renders in
  the **title block, right beside the type, at every width** (2026-09-14, the
  user's call): the rating describes the work the type names, so it sits
  against it, above the step and the names. From 2026-09-10 it shared the
  step's line instead, which put it beside the type on a wide screen, beside
  the step below 900px and under the step on a phone; three places on one
  board. It briefly lived in the pair beside the word `Unclaimed` before that.
  Read-only, for everyone.

  **The rating is changed in the task form and nowhere else** (#335, the
  user's call). Filing sets it and `Edit Task` changes it; every rating the card
  draws is read-only for every viewer, the creator included. The click-to-rate
  track that used to live on the card is gone, along with its handler. The
  server's points route and its permission are untouched — the form uses them.

  **An open card draws the rating in exactly one place, and never in the
  body.** The row does not unmount when a card expands, so #332's track and the
  body's old `How Bad?` line drew the same number twice on every open pool
  task. One rule, `ratingSurface` in [src/poop-rating.tsx](../src/poop-rating.tsx),
  picks the surface, and the two ask `ratingBlock` with their own name:
  - **row** — every task that is not closed (this track);
  - **menu** — a closed task. A labelled `role="group"` block
    (`.task-card-menu-rating`) directly above the timestamps, folded into
    `menuHasContent`. A creator's just-completed card is closed but still
    full-size until archived, and it takes the menu copy like any closed task.

  An unrated task draws nothing on either, for anyone.
  `scripts/rating-placement-sim-test.mjs` sweeps every state for more than one
  copy, for a control, and for rules left addressing a block nothing emits.

  Fixed 5-slot track everywhere it appears — slots 1..N in full colour, the
  rest ghosted, so a 3 reads as three *out of five* rather than as three
  glyphs. A pass on 2026-09-10 cut the ghosts on the row, reasoning that one
  brown glyph trailed by four grey ones reads as debris; that was a change
  nobody asked for, made while fixing something else, and it was reverted the
  same day. **The track keeps its five slots on every surface, and the
  collapsed row draws it smaller** (2026-09-14, the user's call): 9px glyphs
  with no gap between them, against 13px in the menu and the form, at every
  width, so the type and its rating share one line on a phone. The ghosts
  stay. The measurement is under *Where uniformity holds*.
  An unrated task renders no track at all. See
  `PoopDisplay` / `.poop-track`. Never on a mini row: every mini is closed, and
  a closed task's rating is in the menu.

  **A task that has been dropped and re-offered keeps it** (2026-09-14). From
  2026-09-10 it did not, on the reasoning that a check somebody has already
  been half-way through is not the job its filer sized. With the rating on
  claimed rows, hiding it only while the task sat back in the pool would make
  it blink off and on across one task's life. Shared `isFirstTimeInPool` is no
  longer read by the card.

  **An OOO gets one.** A review pass cut
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
  surface in the app. This is not all of that coming back: closed rows, most
  of any list, still carry none. What returns is the rating on active work,
  where the user has now said it is worth reading twice over, once to decide
  whether to take a task and once to see who is already carrying what.

  **This is an append, and it is the row's one sanctioned one.** Rule 3 under
  *When Adding UI* in [../CLAUDE.md](../CLAUDE.md) says a new field on the collapsed row replaces something
  rather than being added beside it. The rating was first allowed in because it
  sat only in the empty half of an unclaimed pair; on every active row it no
  longer can say that. It stays because the user ruled it part of what the row
  is for (2026-09-14), and it shares the type's line rather than taking one of
  its own. A new field still replaces something instead.
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
reflow, deliberately. (Two grid lines, not two lines of text: the title cell
holds three, the loan name, the type with its rating beside it, and the step.
See *One arrangement at every width* below.) The pair used to share one line with the title and
needed a fixed 196px reservation sized to the widest pair in the app; on a
typical row that left ~38px of dead space between the names and the due
stamp. Moving the pair onto its own line removed both the gap and the
reservation:

```
minmax(0,1fr) | 154px
title         | action
pair          | due
```

**One arrangement at every width** (2026-09-14, the user's call). An active
row's title reads the same on a desktop and on a phone: the loan name, then the
type with its rating right beside it, then the step. The rating describes the
work the type names, so it sits against the type. The rules carry no width
query; they are under *The active row's title, at every width* in `styles.css`.

It replaced three arrangements. Above 900px the name, type and step shared one
line, and the step was cut behind an ellipsis whenever the name ran long. Below
900px the title stacked and the rating shared the step's line. Under 560px the
rating dropped to a line of its own under the step. So the poops sat somewhere
different at each width, and a board seen on a laptop and on a phone looked
like two different apps. The cost is height on a wide screen, where an active
row's title is three lines where it was one.

**Every active row names its step** (2026-09-13, the user's call). The step is
the status tracker's own word for where the task is, `currentStepName` in
[src/timeline.tsx](../src/timeline.tsx), so the row and the card it opens can
never disagree. It used to exist only on a LOAN_DOCS mid-merge or a FRAUD
mid-exchange, through a row-only table (`stageSuffix`, deleted), and every other
row left the line blank, which read as the step having gone missing. Mini
(one-line closed) rows draw none; a creator's just-completed card stays
full-size until it is archived (*Bucket sort*), so it reads `Completed`. The
step takes a whole line (`flex: 0 0 100%`) under the type and its rating. It is
`nowrap`, so it never breaks mid-phrase. The unread dot is not on the type's
line at all; it rides the loan name's (see *Unread-note signal*). `scripts/status-display-surface-sim-test.mjs` fails if
the row's step and the tracker's current step differ in any state, or if the
row stops asking `currentStepName`; `scripts/rating-placement-sim-test.mjs`
fails if the rating leaves the type's line or a width query rearranges the
title.

**Nothing on the type's line gives.** On an active row the type's words do not
shrink, the rating is fixed (a squeezed rating is a different number), and the
dot never shrinks. That holds because the longest label, `Out of Office`, fits
beside five slots in the narrowest title cell the board renders; the
measurement is under *Where uniformity holds*. An unrated task draws no track,
so its type's line is the type alone.

**Every active row is one height.** The type cell reserves its two lines with a
`min-height`, and every active row fills both, so rows match whatever their
words say.

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
- **Mini rows are excluded** (`:not(.task-card-grouped-mini)`). A closed row
  draws no step and never carries a rating, so reserving the line there
  would add height to every row in Done and buy nothing. Minis are half-height
  on purpose.
- **A reservation belongs to the thing it reserves for.** If both occupants ever
  leave, the `min-height` goes with them. A blank line held for nothing is
  ornament, which is the one thing this row's rules refuse.

Since every active row names its step, no row pays for the line in white space
any more. Since the active row's type went a step larger (2026-09-13) its content
draws about 2px over the reservation, so the reservation is a floor rather than
the height, and rows match because every active row carries both lines. The
reservation stays because uniform rows are what lets an eye keep one rhythm down a list, and
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
is 1px taller than the rows around it, because `.task-card-grouped-due-overdue` takes the
due value up to 0.95rem — the overdue emphasis, which predates all of this.
Normalising it would mean adding a pixel to every other row to match a stamp
that is supposed to stand out.

**Measure this with the `pointer: coarse` floor forced on.** Automation reports
a fine pointer at every viewport, so the 12px floor never applies under
Playwright and every label comes out ~15% narrower than it does on a real
phone. The stage's tracking was set from numbers taken that way once and was
two pixels wrong because of it. Apply the floor's declarations unconditionally
in a scratch `<style>`, take the numbers, then remove it.

**Where uniformity holds, and where it stops.** Measured 2026-09-14 across the
seeded cast with the touch floor forced on. One height across every active row
at **390px and up**: 106px on a phone, 104px from about 800px. That is the
iPhone width the board is used on, and nothing on any row is cut at any of
those widths. A rated and an unrated row match, since the rating sits on a line
the type already fills. The one row that differs is a fraud check awaiting
items, whose `WITH REQUESTER` due stamp wraps to two lines and makes it 11px
taller at every width; that predates this layout.

The fit that holds it: five slots at the row's 9px are 62px, and `Out of
Office`, the longest type, is 124px, so the type's line wants about 192px
against a 194px title cell at 390px. At the menu's 13px the track is 95px and
most rows pushed their poops down a line there; 10px still did it on
`Out of Office`.

At **360px** it does not hold, for two reasons. The title cell is 164px, so a
long type (`Fraud Check`, `Value Check`, `Out of Office`) pushes its poops onto
the line under it: 5 of the 10 seeded rows. No legible poop size closes that.
And the pair wraps: `Suzie → Unclaimed` wants ~172px against the same 164px, so
those rows run ~21px taller. That is the standing "first names are never
ellipsized, the pair wraps" rule doing exactly what it says. Closing either
would mean shrinking the type or the placeholder word `Unclaimed` at narrow
widths; **open, and nobody has asked for it.**

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
assignee without moving the status. The row-only table named that case
`Final Approval Needed`; since 2026-09-13 it reads the tracker's `Final approval`
like a held check, and the pair's `Unclaimed` says the rest. Such a row draws its
step and, since 2026-09-14, its rating like any other active row.

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
    [fraud-workflow.md](../../../docs/product/fraud-workflow.md#reminder-rules).
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

  **The title block stacks on every active row: loan name, then the type with
  its rating, then the step.** The loan name leads because it is what a person
  scans for: heading face, full ink. The type sits under it in ink and tracked,
  its rating beside it, and the step under that. There is no hairline between
  name and type any more; it belonged to a side-by-side arrangement that no
  active row uses.

  Until 2026-09-14 the active row stacked only below 900px (a 560px rule until
  2026-09-13, widened after a sweep found text cut at every width from 561 to
  850). Above it the title was one line with the type capped at 45% of the cell,
  and the step behind a long loan name gave way to an ellipsis. Stacking at
  every width took both the breakpoint and the cut away.

  **Mini (closed) rows are not part of that.** Their title stays on one line
  down to 560px and only stacks on a phone: they are most of the Done list, and
  stacking them wider would add a line to every closed row. The active-row rules
  are scoped to `.task-card-grouped:not(.task-card-grouped-mini)`, and a 560px
  block carries the mini half. The type's 45% cap and its ellipsis still apply
  there, because a mini's type shares its line with the loan name.

  **The stage is its own box** (2026-09-07). It used to be words inside the
  type's own span, so the two truncated together and a person read `FRAUD CHECK
  - FINAL APP…`, with the half that got cut being where the task actually *is*.
  Split out, the type names what the task is and the step names where it is.
  `currentStepName` returns **bare words**; the hyphen that used to join them
  on one line is gone with that line.

  The rating is on the row of every task that is not closed — see *Poop* under
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
  edge — see **one edge, one meaning** in [../CLAUDE.md](../CLAUDE.md).

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

The arithmetic lives in [src/panel-placement.ts](../src/panel-placement.ts), not
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
(34px min), no poop, no quick action (the hamburger stays). Title font
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
`isTaskExpanded` in [src/expand-state.ts](../src/expand-state.ts), which is the
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

### Expanded body

One stacked column (#106), sections separated by a hairline rather than
nested card chrome, in this order:

1. **Status timeline** (`.timeline`): where the task is in its flow. Under
   860px it is one line over a segmented bar (2026-09-13, the user's pick). The
   step it is on sits at the left, `Next` and the step after it at the right,
   and under them one segment per step, filled up to the one it is on. Two
   short lines on every task type, running the width of the body (it was
   capped at 440px, which left it stranded partway across a mid-size card;
   uncapped 2026-09-13, the user's call). The next step's name is
   what ellipsizes, never the current one.
   **From 860px up every step is named under its own segment** (2026-09-13,
   the user's pick over an inline strip and a filled track, driven on the real
   card, branch `prototype/status-tracker-desktop`). The one-liner read as
   stranded on a desktop card, a 440px strip in a body three times as wide. So
   every step gets its name. The step the task
   is on is named in ink at 600, the steps behind it in secondary ink, the steps
   ahead muted, and the line steps out of view. It stays in the accessibility
   tree: the names sit inside the bar's `role="img"` and are never read, so the
   line is what a screen reader hears at every width. A cancelled task keeps
   its line and draws no names, since it stands on no step and walked none of
   them. Each name ellipsizes in its own column, so nothing wraps at any width.
   **The names are hidden below 860px**, and that is the whole of what keeps a
   phone on two short lines; the surface test fails if a rule outside a
   `min-width` query ever shows them. 860 and not lower because the columns are
   equal fifths, and a Fraud Check's `Outstanding items`, the widest step a
   task can stand on, ellipsized in its fifth of a 720px card.
   It replaced a rail that drew every step with a dot, a name and a `NOW` chip
   on the current one. A five-step flow could not fit that on a phone, so a
   Fraud Check or Loan Docs card opened on a rail two or three lines deep, and
   an LOI in corrections wrapped behind its chip. Three variants were driven on
   the real card at 360px and 390px, branch `prototype/status-tracker`; this is
   variant A, and the other two (dots plus names on one line, and a
   previous/current/next window) are kept there.
   It was the first card component lifted out of `App.tsx`, into
   [src/timeline.tsx](../src/timeline.tsx), because it is the web surface that
   puts a status into words: #247 renders it and reads the words back, and
   `App.tsx` cannot be imported into a node script to allow that.
   (`src/thread.tsx` was lifted out for the same reason in #258, see below.)
   Flow comes from the task type: LOAN_DOCS gets the merge steps, FRAUD gets
   the two-phase checklist steps, everything else is Opened → Claimed →
   Completed. `NEEDS_REVIEW` renders on the `CLAIMED` step. `ARCHIVED` reads as
   `COMPLETED` and goes green with it (the old rail only greened `COMPLETED`).
   `CANCELLED` is in no flow, so it names itself in muted ink over an empty bar.
   Step names are the rail's own except the two the shared `statusDisplayName`
   fixes (#237): an LOI's claimed step reads `In review`, and the corrections
   state reads `Needs corrections`. Never a literal here, so the bot's wording
   cannot drift from the web's, and `scripts/status-display-surface-sim-test.mjs`
   fails if one appears.
   **In corrections the line names the state, not the step.** `Needs
   corrections` takes the step name's place in `--warn`, on the line and under
   the segment on a wide card, and the segment the task is standing on goes
   `--warn` with it. Naming the step there would read
   `In review`, the pairing ADR-0007 rule 4 exists to stop.
   The bar is `role="img"` labelled `Step N of M`, because the segments are the
   only place the count lives. It's the first child so the sibling-hairline
   rule skips it.
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
   Instructions box's ruled page** (#367): the `Outstanding items` label sits
   above the rows and the `Add an item` composer in `.checklist-body`, and the
   closing hairline separates it from the conversation. (Until 2026-09-13 the
   label sat in a 116px left margin above 560px; see *Instructions* below.)
   Before #367 it was a heading bar over a full-width list, so one card body had
   two section styles depending on the type. The block, head and title have no rules of their own —
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
   [ADR-0008](../../../docs/adr/0008-loi-terms-are-a-field-not-a-message.md) and
   [ADR-0010](../../../docs/adr/0010-every-task-has-an-instructions-box.md)).
   **Not a panel** (2026-09-05): no border, no fill, no shadow, no radius. It
   was a bordered, shadowed box with a 3px brand left edge sitting inside the
   bordered, shadowed task card — two containers deep for one passage of text,
   with the most borrowed shape in the app stuck on its margin. It is now a
   ruled page: the field's name sits above its text as a small mono label,
   left-aligned, and one horizontal hairline closes the block off from the
   conversation below. One rule, no container.
   **The label is above its text at every width** (2026-09-13, the user's
   call). Above 560px it used to sit in a 116px left margin column behind a
   vertical hairline, and only a phone stacked it; the phone arrangement is the
   only one now, for all three sections on the page, so none of them has a
   breakpoint. `instructions-box-sim-test.mjs` fails if a fixed-width column,
   a vertical rule, a right alignment or a row span comes back on any of them. Free text
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
   test that names it for no visual change. The block's own closing hairline
   is the separator, so `.task-card-expanded > .task-card-terms + *` drops the sibling
   hairline.
5. **Conversation** — reply thread + add-note input, all in one avatar + text style: a
   note is a single row, glyph then what they said, with no name/timestamp line
   above it (#165) — the author and the time ride the row's `title` and a
   visually-hidden span instead. Thread caps at 178px (`.msgs` `max-height`)
   with internal scroll and auto-scroll-to-newest on new entries / re-open.
   **Drawn on the same ruled page as the two sections above** (#387, chosen
   over three variants on the real card, branch
   `prototype/conversation-styling`): the `Conversation` label sits above the
   bubbles and the composer, and there is no closing hairline, since nothing
   follows. It rides the `.loi-terms` selector lists like `.checklist` does,
   and `.thread-head` has no face of its own. It used to sit in the 116px left
   margin above 560px and span the list and the composer, so the margin's
   hairline ran the whole section; that went with the margin on 2026-09-13. The head reads `Conversation` on
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
   out of `App.tsx`, into [src/thread.tsx](../src/thread.tsx), for the reason
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
   `useHoldMenu` in [src/thread.tsx](../src/thread.tsx) owns the threshold, the
   pointer events that cancel a press, the right-click and the swallowed click,
   and both the box and the bubbles spread its props. Written out twice, "the
   same threshold" is a thing a test has to check; written once it is true.
   Everything downstream of the gesture stays with each component and
   deliberately disagrees — a bubble opens its menu, the box opens its editor. `InstructionsEditor` in
   [src/thread.tsx](../src/thread.tsx) is its own component, never a mode of the
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
   **The initials wear the author's color** (2026-09-13, the user's call), from
   the same `avatarStyle` as the header pair and the checklist's adder chip, so
   a person is one color from the top of the card to the bottom. The circle was
   neutral grey from before people had colors, and on a card whose header shows
   Johanna in purple a grey `J` below read as somebody else. The rule lives in
   [src/avatar.ts](../src/avatar.ts) rather than `App.tsx` so `thread.tsx` can
   use it and a node script can still render the thread; the contrast theme
   still maps every slot to one neutral.

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
   [ADR-0009](../../../docs/adr/0009-messages-are-editable-by-their-author.md) rule
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

- `task-card-mini` is emitted on every closed row, but no rule in `styles.css`
  styles it. The half-height look comes from `.task-card-grouped-mini` (see
  *Mini rows*).
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

These three are the whole set. There is no card edge and no status stripe
underneath them; see **one edge, one meaning** in [../CLAUDE.md](../CLAUDE.md).

### Unread-note signal

Per-user "I've seen the latest note from someone else" map persists in
`localStorage` keyed by user id (see `seenNotesAt` in `App.tsx`). When a
note arrives from the other party, the recipient's card:

- Drops dim (`hasUnreadNote` short-circuits `dimmed`).
- Pulses a small `.task-card-unread-dot` (7px, `--bad`) beside the loan name
  on the collapsed row, animated via `pulse-unread`.

**The dot rides the loan name's line, beside the name and never inside it**
(2026-09-14, the user's call). The name and the dot share
`.task-card-collapsed-name-line`, a flex row in which the name is the box that
ellipsizes and the dot sits next to it at `flex: 0 0 auto`, so a long name gives
and the dot never does. It used to sit at the end of the type label, which on an
active row put it on the line the rating needs: on a phone, one of the two got
pushed down a line. Before that it was a plain child alongside the type's text,
and the ellipsis capping the type ate it, which on a phone took off the only
thing on the row saying a note is waiting. If you ever put `text-overflow` on
the name's line itself, the dot goes with it.

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
[src/court-latch.ts](../src/court-latch.ts)). Acknowledging is what clears the
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

