---
name: Operation Hot Task
description: A warm bookkeeping ledger for short-lived loan operations work, living inside Microsoft Teams.
colors:
  bg: "#f4f2ee"
  bg-soft: "#eae7e0"
  panel: "#fefdfb"
  ink: "#14120f"
  ink-secondary: "#55504a"
  muted: "#6f6a63"
  line: "#d5d0c7"
  line-soft: "#e8e4dd"
  brand: "#1f1c17"
  brand-hover: "#000000"
  brand-soft: "#e9e6df"
  on-accent: "#ffffff"
  good: "#2e7d4f"
  good-bg: "#e8f5ec"
  warn: "#a16b07"
  warn-bg: "#fef6e0"
  hot: "#c25e00"
  hot-bg: "#fef0e0"
  bad: "#b82d35"
  bad-bg: "#fce8e9"
typography:
  display:
    fontFamily: "Bricolage Grotesque, DM Sans, sans-serif"
    fontSize: "1.6rem"
    fontWeight: 700
    lineHeight: 1
  headline:
    fontFamily: "Bricolage Grotesque, DM Sans, sans-serif"
    fontSize: "1rem"
    fontWeight: 700
    lineHeight: 1.25
  subhead:
    fontFamily: "Bricolage Grotesque, DM Sans, sans-serif"
    fontSize: "0.95rem"
    fontWeight: 700
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Bricolage Grotesque, DM Sans, sans-serif"
    fontSize: "0.82rem"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "DM Sans, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: "DM Sans, Segoe UI, system-ui, sans-serif"
    fontSize: "0.85rem"
    fontWeight: 400
    lineHeight: 1.45
  control:
    fontFamily: "DM Sans, Segoe UI, system-ui, sans-serif"
    fontSize: "0.78rem"
    fontWeight: 600
  label:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "0.68rem"
    fontWeight: 500
    letterSpacing: "0.06em"
  micro-label:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "0.6rem"
    fontWeight: 600
    letterSpacing: "0.06em"
rounded:
  xs: "3px"
  sm: "4px"
  control: "5px"
  md: "6px"
  lg: "8px"
  xl: "10px"
  bubble: "14px"
  pill: "999px"
spacing:
  xxs: "4px"
  xs: "6px"
  sm: "8px"
  md: "10px"
  lg: "12px"
  xl: "16px"
  xxl: "20px"
components:
  button-primary:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.control}"
    padding: "7px 14px"
    typography: "{typography.title}"
  button-primary-hover:
    backgroundColor: "{colors.brand-hover}"
    textColor: "{colors.on-accent}"
  button-small:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.control}"
    padding: "6px 10px"
    typography: "{typography.control}"
  button-good:
    backgroundColor: "{colors.good}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.control}"
    padding: "7px 14px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.brand}"
    rounded: "{rounded.control}"
    padding: "7px 14px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.bad}"
    rounded: "{rounded.control}"
    padding: "7px 14px"
  quick-action:
    backgroundColor: "{colors.good}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.control}"
    padding: "6px 10px"
    typography: "{typography.control}"
    width: "116px"
  quick-action-terminal:
    backgroundColor: "transparent"
    textColor: "{colors.brand}"
    rounded: "{rounded.control}"
    padding: "6px 10px"
    typography: "{typography.control}"
    width: "116px"
  quick-action-terminal-hover:
    backgroundColor: "{colors.brand-soft}"
    textColor: "{colors.brand}"
  card:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "12px"
  modal:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "18px 20px"
  tag:
    backgroundColor: "{colors.bg-soft}"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.sm}"
    padding: "3px 9px"
    typography: "{typography.label}"
  input:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "7px 10px"
---

# Design System: Operation Hot Task

## Overview

**Creative North Star: "The Warm Ledger"**

This is a bookkeeping pad, not a SaaS dashboard. Off-white paper, ink-black
text, sharp typography, and narrow bands of color used strictly as signal. The
reference object is a ruled accounting page that someone competent has been
annotating all morning: dense, ordered, legible at a glance, with nothing
decorative competing for the eye. Every color that is not paper or ink is
carrying information.

The system's real subject is a single component — the collapsed task row — and
almost every rule here exists to keep that row scannable. It is deliberately
saturated: the working assumption is that the row is full, so a new field
replaces an existing one rather than joining it. Density is a feature, and the
discipline that makes density survivable is that the same fact is always
encoded in the same place, and that a fact which already has a column, a label
or a section does not also get a margin. Lateness is the number it is about. A
person is a colored chip. None of these channels borrow each other's
vocabulary, and there are fewer of them than there were: the edge markers were
deleted in one pass on 2026-09-05, each of them repeating in the margin what the
row already said in words.

**No card edge is painted, and no rule remains that would paint one.** A whole
status-stripe vocabulary sat in the stylesheet unemitted for a long time — the
row is deliberately mono, because the court section it sits in already says
whose court it is — and on 2026-09-06 it was deleted rather than wired up.
Giving status an edge would have contradicted the pass above, which removed
every other edge marker in the app the day before. So "one edge, one meaning" is
a rule about what an edge may say if one is drawn again, not a description of
the current screen.

**The dark theme is a different room, on purpose.** It is not the warm ledger
with the lights off; it is an indigo ledger — indigo paper, near-white ink, a
lavender accent — settled after five whole palettes were driven live, including
a faithful dark rendering of the light theme, which lost. A third theme,
`contrast`, is pure black and white with no shadows at all and a deliberately
monochrome person-chip set, because decorative hue variety works against a
maximum-legibility promise.

**Rendered size is the only size on a phone.** Zoom is disabled in the Teams
mobile webview, in three layers and on purpose, so there is no pinch to recover
a label that came out too small and no address bar to escape to. On 2026-09-06
the stylesheet gained a type floor for the text people read, matching the floor
it already applied to the text they type into. That premise, not a viewport
width, is why the floors are scoped to `pointer: coarse`.

**Key Characteristics:**

- Paper-and-ink ground; color appears only where it means something.
- Three fully independent themes, not one theme with a filter over it.
- A saturated primary row, defended against accretion.
- Typography carries the hierarchy that color is not allowed to carry.
- Restrained motion — a short list of named animations and nothing else.
- Contrast ratios are measured and recorded, not eyeballed.

## Colors

Paper and ink first; four signal hues, each with a full-strength value for text
or stroke and a tinted backing for fills.

### Primary

- **Ledger Ink** (`#1f1c17`): the single interactive voice — and it is not a
  hue. Links, filled primary buttons, ghost outlines, focus rings, and the
  warm-grey `brand-soft` backing behind selected or attributed state. It was a
  blue until 2026-09-05, chosen off a three-way bake-off driven on the live
  board against a plum and a dark ink-teal; the blue was the one place the
  system contradicted its own north star, and it was the color a person saw
  most.

### Secondary

The four signals. Each names a **role**, never a hue — the dark theme answers
the same four roles in cool hues, so "the red one" means the `bad` role, not a
red.

- **Ledger Green** (`#2e7d4f`): the positive move. Claim, Complete, Approve,
  and the "active" figure in metrics.
- **Ledger Gold** (`#a16b07`): caution and review. The middle urgency band, and
  the accent on a review thread.
- **Ledger Ember** (`#c25e00`): heat. Highest live urgency, and the hover fill
  under the warn button. It no longer paints a category: on 2026-09-06 the
  metrics type bars stopped being one hue per task type and the ratio bar's
  brand-to-hot gradient was deleted with them.
- **Ledger Red** (`#b82d35`): failure and demand. Overdue dates, cancellation,
  errors, and the unread-note dot.

### Tertiary

- **The Person Chips** (eight hues, `--avatar-1` through `--avatar-8`): a
  rotating avatar palette hashed off a user id, so a person keeps one color
  everywhere. Two of the eight are **known collisions**, recorded here because
  the tokens contradict the intent the comment above them states: `--avatar-1`
  is byte-identical to `--warn` (`#a16b07`), and `--avatar-2` is `#2c5ea0`, the
  exact SaaS blue removed as `--brand` on 2026-09-05. Neither is fixed yet. The
  collision is survivable because a chip is a 20px circle carrying two initials
  in a fixed column and a signal is a pill, a stroke or a date, so the shapes
  never trade places — but "held clear of the four signal hues" is an intention
  here, not a fact, and rotating those two hues is the outstanding work.

### Neutral

- **Ledger Paper** (`#f4f2ee`) and **Fold** (`#eae7e0`): the page and its
  recessed areas.
- **Card Stock** (`#fefdfb`): the surface every card and panel sits on, a
  half-step lighter than the page. That tone step is the depth; there is no
  resting shadow under it.
- **Ink** (`#14120f`), **Second Ink** (`#55504a`), **Pencil** (`#6f6a63`):
  three text strengths, high to low. Pencil clears 5:1 against Card Stock; it
  used to sit near 3.6:1, under the floor for the small label text it exists
  for. That figure is measured **against `--panel`**, and it is not the whole
  story: the section-count chip puts Pencil on `--bg-soft`, where the same pair
  measures **4.3:1**, under the 4.5:1 small-text floor. Recorded rather than
  claimed away. A muted value on Fold is the one placement of this token that is
  short of the floor.
- **Rule** (`#d5d0c7`) and **Faint Rule** (`#e8e4dd`): borders, strong to
  faint. A card takes the faint one; a control takes the strong one.

### Named Rules

**The Role-Not-Hue Rule.** Signal tokens are named for what they mean, never
for what color they are. A theme may answer `bad` with a rose and `good` with a
mint; code that assumes red and green is wrong, not the theme. The corollary,
learned on the metrics panel: a chart that only counts how many of a thing were
filed may not borrow a signal token to tell its categories apart, because
painting "Fraud Check" in `--bad` claims fraud checks are failing. Categories get
length, weight or an annotation. One bar, one color.

**The One Warm Note Rule** (dark theme). The indigo frame carries one warm
accent and no more. Every signal but `warn` is rotated to the cool side of its
own hue — overdue is a rose, hot a coral, good a mint, and all eight person
chips come from the cool half of the wheel. `warn` stays gold and is the single
exception. A new signal color added to the dark theme gets cooled before it
lands; the warm slot is taken.

**The Three-Theme Rule.** A new themeable color is not done until it exists in
all three `:root` blocks. There is no fallback and no derivation; `contrast` in
particular is authored, not computed.

**The Measured Floor Rule.** Body text clears 4.5:1 against its own panel and
hairlines clear the 3:1 UI-component minimum, per theme, verified against that
theme's panel rather than assumed from the light one. Verify against the tone
the text actually sits on, not the panel behind it: the section-count chip is
the standing counterexample, passing on `--panel` and failing on `--bg-soft`.

**The On-Accent Rule.** Text and icons on a filled accent read `on-accent`,
never `#fff`. The light theme's accents are dark enough for white ink; the dark
and contrast themes use bright pastel fills where white collapses to roughly
2.8:1.

**The One Hardcode Rule.** There is exactly one literal color left in the
stylesheet: `#256942`, the hover fill on the filled green button, with no
`--good-hover` token behind it. It is a known exception, scoped out rather than
fixed, and it means the green button's hover is the same in all three themes
whether or not that reads. Nothing new joins it. Every other color in the app
goes through a custom property.

## Typography

**Display Font:** Bricolage Grotesque (600 / 700, with DM Sans fallback)
**Body Font:** DM Sans (400 / 500 / 600, with Segoe UI and system-ui behind it)
**Label/Mono Font:** JetBrains Mono (400 / 500 / 600)

**Character:** A tall, slightly eccentric grotesque for headings against a
plain humanist sans for prose, with a true monospace doing all the counting.
The pairing reads as a printed form filled in by hand — the headings have
personality, the body has none on purpose, and the numbers line up.

### Hierarchy

The ramp is wider than a five-step scale, and the honest reason is that a
saturated row needs a lot of steps in a short range. Nine steps are the system.
Everything below the list is drift.

- **Display** (Bricolage 700, 1.6rem, line-height 1): the two big figures on the
  metrics panel and nothing else. There is no page-title face; the app bar
  carries no title.
- **Headline** (Bricolage 700, 1rem): modal and confirmation titles.
- **Subhead** (Bricolage 700, 0.95rem, -0.01em): list section headings, and the
  loan name on a collapsed row, which is the thing people scan for. The two
  agree by design.
- **Title** (Bricolage 600, 0.82rem): the base button and dense header chrome.
  The one place the display face runs at body scale.
- **Body** (DM Sans 400, 14px): the document base, and the size on unstyled
  prose and full-width form fields.
- **Body Small** (DM Sans 400, 0.85rem / 0.86rem): prose inside a card — notes,
  message bubbles, instructions, leaderboard names, type labels. This, not the
  14px base, is the size most sentences in the app are actually read at. The two
  values are one step wearing two decimals; prefer 0.85rem for new work.
- **Control** (DM Sans 600, 0.78rem): the small button, form field labels, menu
  items, popover rows. Fifteen occurrences, the busiest step in the file.
- **Label** (JetBrains Mono 500/600, 0.68rem, 0.06em, usually uppercase): the
  general mono label — status pills, ratio captions, the type-count figures.
- **Micro Label** (JetBrains Mono 600, ~0.6rem, uppercase): the collapsed row's
  own mono chrome — due labels, the waiting label, chip initials, the app-menu
  group label. It runs down to 0.55rem at the smallest, and it is the tier the
  touch floor exists to raise.

**Not the system, recorded as drift.** `0.72rem` (timeline body, metrics section
titles, the section count) and `0.73rem` (the tag) sit between Control and Label
without a job of their own; fold them into one of those two when they are next
touched. `0.8rem`, `0.9rem`, `0.92rem` and `0.66rem` are one-offs on the form,
the terms block and the checklist title. `1.2rem` and `1.4rem` appear once each
on the metrics ratio and belong with Display. The whole admin surface is written
in px (9 / 10 / 11 / 12 / 13 / 14px) rather than in this ramp; it is an
admin-only page and is treated as its own sub-scale rather than pretended into
the ramp above.

### Named Rules

**The Mono-Is-Not-Prose Rule.** The monospace face is reserved for non-prose:
dates, counts, type labels, section counts, status pills. Prose stays in DM
Sans. The two never mix inside a sentence.

**The One Exception That Proves It.** An LOI's request field is drawn in the
fixed-width face, because it holds a pasted term sheet and a term sheet only
lines up in one. That is the single prose-shaped box allowed a mono face, and
it earns it by being tabular data wearing a paragraph's clothes.

**The Touch Floor Rule** (2026-09-06). On a coarse pointer, mono chrome floors
at **11px** and anything read rather than glanced at floors at **12px** — the
type label and its stage suffix, the checklist and thread headings. Measured on
the live board at a 390px viewport before the floor landed: due labels rendered
at 8.8px, the waiting label at 9.6px, the type label at 10.88px, none of them a
pixel different from their 1440px size. `OVERDUE BY` is the case that decided
it: color is never the only signal here, and the words beside the red date are
the second channel, so setting that channel at 8.8px on the one surface where it
cannot be enlarged is a promise the screen does not keep. The floor block is the
**last block in `styles.css`**, and has to be, per the Breakpoint-Order Rule
below.

## Layout

A single centered column, 1320px at its widest, with 16px of side padding and a
12px vertical rhythm between stacked blocks. The app is one long list under a
light bar, and the shell does nothing more elaborate than that.

The bar itself carries no brand lockup — Teams already shows the app name above
the tab, so an in-app title would be duplication. It holds navigation (admins
only) and, in development, the identity switcher. The controls that act on a
list — New Task, the grouped/flat toggle, collapse-all — live on that list's own
section header rather than in the bar, so they sit next to what they affect.

Sections are introduced by a heading and a monospace count chip sitting on a
1px rule. This is the only grouping device in the app; every list uses it.

Spacing runs on a 4 / 6 / 8 / 10 / 12 / 16 / 20 step. Card interiors take 12,
the shell takes 16, the card list gaps at 6, and 8 is the default gap between
two things that belong together.

The row's action column is one declared number, `--quick-action-w` (116px),
read by the row and by the list header above it so the right edge of the list
reads as a single column.

Responsive behavior is driven by the real deployment: a Teams tab on a laptop,
and a Teams mobile webview where **zoom is disabled** and cannot be recovered
by the user. Type and hit targets must be correct at their rendered size, since
pinch-to-fix is not available.

### Named Rules

**The Saturated Row Rule.** The collapsed task row is intentionally full. A new
field replaces an existing one; it does not join the queue. If nothing can be
given up, the field does not belong on the row.

**The Nothing-Behind-The-Fold Rule.** The collapsed row carries the primary
action and the menu, so no actionable control is hidden by collapse.

**The Grow-The-Target-Not-The-Box Rule.** A press target that is too small on a
phone gets a transparent `::after` overlay, not a bigger box. The two menu
triggers are 32px because the action column is that hamburger plus a 6px gap
plus `--quick-action-w`, and growing them would walk that alignment on exactly
the screen with the least room to absorb it. The overlay is 40px rather than
44px: at 44px it would meet the quick action 6px away, and a press in the
overlap goes to whichever the browser hit-tests first, which on this row means
Archive catching a press meant for the menu.

**The List Does Not Move Itself Rule.** The list never re-sorts under a viewer.
This is the same rule as "a card never opens or closes itself", from the other
side: opening a task carrying an unread reply marks it seen, which drops the
message pull, which would recompute the row's court and relocate it mid-read. A
pulled task is **held in the section it was opened in** until it is collapsed
again (`court-latch.ts`), and the hold is deliberately not persisted, because a
hold means "somebody is reading this right now" and a reload legitimately
re-sorts.

## Elevation & Depth

Flat at rest. Depth comes from tone and from hairlines: the page is `bg`,
recesses go to `bg-soft`, every card or panel sits on the lighter `panel`, and
two border strengths keep a card reading one step below a modal. There is
exactly one shadow, and it means "this has left the page".

### Shadow Vocabulary

- **Resting** (`0 0 0 0 transparent`): a deliberate no-op. It used to be 3px of
  blur at 6% opacity, which on paper this warm is below the threshold of
  visible — it cost paint work and a whole vocabulary and showed nothing.
- **Lifted** (`0 6px 18px -6px rgba(26, 24, 20, 0.22)`): hover, an expanded
  row, and anything that floats — menus, modals, toasts. Strong enough to
  actually read as a lift.
- **Modal, composed**: a floating panel adds `0 16px 40px -16px rgba(0,0,0,0.35)`
  on top of the lifted token, and takes a 2px border rather than a hairline. A
  hairline the same weight as an input border let the modal blend into the page
  behind it.

### Named Rules

**The Flat-At-Rest Rule.** A surface that has not been interacted with and is
not floating gets no shadow. If a component needs to look separated while
sitting still, it gets a hairline and a tone step, not elevation.

**The Never-`none` Rule.** Both shadow tokens are transparent no-ops, never the
keyword `none` — including in the `contrast` theme, which still has no shadows.
The celebrating card composes these tokens with a halo shadow, and `none`
inside a `box-shadow` list voids the entire declaration. That keyword was
silently deleting the status stripes from the one theme that exists for maximum
legibility, and it would take the halo the same way.

## Shapes

Softly squared, never round. Eight steps ship, and they are tiered by how much
the thing floats:

- **3px** — the smallest marks: section counts, metric bars, the poop track.
- **4px** — tags and the ratio track.
- **5px** — every button. The base `button` rule and `.btn-sm` both, plus the
  small selects and menu choices that sit beside them.
- **6px** — inputs, textareas, inline confirm panels, popover rows.
- **8px** — cards, floating menu panels, toasts, checklists, stat cards. The
  card radius.
- **10px** — things that leave the page entirely: the create-task modal, the two
  confirmation dialogs, the empty-state card, the metrics section.
- **14px** — the message bubble, squared off at the corner nearest the avatar to
  make a tail without drawing one. The single conversational shape in the app.
- **999px / 50%** — fully round, and only where the shape is the meaning: the
  person chip, the small dot inside a status pill, the timeline dot.

Three values are drift, not steps: **7px** on the admin add-row inputs (should
be 6px, the input radius), **20px** on the admin role pill (should be the pill
token), and **2px** on one focus outline.

Everything is bordered. A 1px rule at one of two strengths defines nearly every
edge in the app, and that rule is the only thing drawing an edge: a task card
takes a hairline all the way round and no coloured stroke on any side.

## Components

### Buttons

- **Shape:** softly squared (5px), compact padding (7px 14px), display face at
  0.82rem, 600. The small size, which is most places in the app, is 6px 10px at
  0.78rem.
- **Primary:** filled Ledger Ink with `on-accent` ink. One per context.
- **Good:** filled Ledger Green. The positive move — Claim, Complete, Approve.
  This, not the brand fill, is the primary action on most task cards.
- **Ghost:** transparent with a hairline outline and brand text. Secondary and
  cancel.
- **Danger:** transparent with a hairline outline and red text. Destructive
  only; never filled, so the eye is not drawn to it.
- **Warn:** filled gold, rare, reminder-related. Hovers to ember.
- **Hover / disabled:** driven by two custom properties on the button rather
  than by a `:hover` rule. A variant sets its own fill and hover tokens and
  nothing else; declaring `background` on `:hover` in a variant class loses on
  specificity and lets the brand fill come back under the cursor. The one
  exception is the green button's hover, which is a literal hex and is the
  system's single hardcoded color.
- **Inert:** faded with `opacity`, and marked `aria-disabled` rather than
  `disabled`, so the control stays in the tab order and a screen reader user can
  reach it and hear why it is inert.

### Chips

- **Style:** monospace, small, tracked, on a soft tinted ground with a 4px
  radius. A 6px dot precedes the label when the chip reports a status.
- **Variants:** the four signals, plus neutral type and status forms.
- **State:** the overdue variant pulses. Use it sparingly — the row already
  encodes overdue by turning its date text red.

### Cards

- **Corner style:** 8px.
- **Background:** the raised `panel` tone against the page.
- **Border:** 1px faint rule.
- **Shadow:** none at rest, lifted on hover.
- **Internal padding:** 12px.
- **One edge, one meaning.** No card edge is drawn, and no rule defines one. The
  status stripes were deleted on 2026-09-06 after a long career of being defined
  and never emitted; the ownership border on the left and the creator stripe
  mirrored on the right went the day before, having also stopped rendering some
  time earlier. The rule governs what happens if an edge ever returns — it would
  be status and nothing else — and a new row-level state still does not get one:
  those facts already have a column on the row.
- **Dimming is a channel too.** Work that is not yours and not actionable drops
  to 0.55 opacity, brightening on hover. Anything unclaimed stays bright,
  because anyone may take it.

### Inputs

- **Style:** panel ground, 1px strong rule, 6px radius, body face.
- **Focus:** a 2px brand-tinted ring via the shared focus token. Never strip an
  outline without replacing the ring.
- **Error:** red rule with a red tinted ground and red text.
- **Coarse pointer:** every `input`, `select` and `textarea` floors at 16px, so
  iOS does not zoom on focus and strand somebody magnified on a surface where
  zoom cannot be undone.

### Navigation

- **Style:** a thin tab strip with an underline on the active tab and no fill.
  Rendered only for admins; everyone else meets the list directly.
- **List header:** heading and count on the left, then an app menu, then the
  primary action hard right. The pair is sized to land on the action column of
  the rows below it, so the right edge of the list reads as one column rather
  than two that nearly agree.
- **App menu:** the preferences that are not decisions about a task — list
  grouping, appearance, collapse all. Anchored to its trigger, closes on
  outside press and Escape.

### Named Rules

**The One Definition Rule.** A measurement two components must agree on is
declared once, as a token, and read from there. Every alignment defect in this
system has been the same shape: the same number written down twice, and one
copy moving.

**The Breakpoint-Order Rule.** A media query adds no specificity, so a
responsive override placed above the rule it overrides simply loses, silently,
forever — it still parses, so nothing reports it. Every phone override goes
*after* its base rule. Three of this app's did not, and the narrowest screen it
ships on rendered its closed tasks as two characters of a loan name. The
corollary, added with the touch floors: a block that raises values across many
class-scoped rules must sit below **all** of them, which is why `## Touch
floors` is the last block in the file and must stay there.

**The Empty-Bar Rule.** Nothing goes in the app bar. In production it holds
admin-only tabs and nothing else, so a control placed there is a control most
people never see.

### Signature Component: the collapsed task row

The densest surface in the app and the reason most of these rules exist. One
row renders in both the grouped and flat views. It carries, in fixed positions:
the loan name, the task type beside it, the two parties as person chips, a due
stamp, the single primary action, and a menu. An unread note from the other
party pulses a small red dot at the end of the type label. Status is carried by
the section the row sits in and by its action, not by a stripe — nothing paints
a card edge.

Lateness is said once, on the number: the due value goes red, bold and up a
size, with its label red behind it a notch quieter. There is no overdue rail —
the row carried a 4px left column that was transparent on every row in the app
and went red on this one condition, repeating in the margin what the stamp two
columns over already said in words.

It never opens or closes itself. No status change, incoming message, or refresh
moves a row either way; only the viewer does. Since 2026-09-06 the same holds of
the row's position: a task pulled into "Needs you" by an unread reply keeps its
section for as long as it is open.

**The action slot has two tiers, and exactly two** (2026-09-06). A **filled**
button moves the work forward: Claim, Merge Done, Send Items, Submit, Approve
Merge. An **outlined** button ends the record: Complete, Confirm, the fraud
Approve, Archive. Same 116px track, same metrics, only the paint changes, so the
column cannot go ragged between two rows. This **narrows** the earlier
single-style rule rather than reverting it. The good/ghost/danger split that
rule replaced really did read as three inconsistent buttons doing one job, and
the answer is not three styles again: it is one rule with two answers, readable
straight down the action column. A third tier is not available.

**A terminal action asks before it fires.** The outlined tier is the tier that
cannot be undone from the row, so pressing it raises an inline confirm rather
than firing. That confirm reuses the two-step Cancel confirm's shape and
**drops its red ground**: the red belongs to cancelling, which is the
destructive move, and dressing Complete in the failure color would tell somebody
their finished task went wrong at the moment they finished it. Neutral panel,
ordinary hairline.

**The slot never contradicts the heading above it.** When the row is in "Needs
you" because of an unread reply, the passive label reads `Unread reply`, then
`Read reply` once opened, instead of the chain's `Waiting on <name>` — which put
the section and the slot in disagreement in the one place both are scanned. Both
forms stay passive spans, because the ball is genuinely in the other party's
court; they report why the row is in front of you and offer no move.

## Do's and Don'ts

### Do:

- **Do** reach for an existing token before defining a color. Every color in
  the app goes through a custom property on `:root`, with one recorded
  exception.
- **Do** add any new themeable value to all three themes — light, dark, and
  contrast — before considering it done.
- **Do** keep the monospace face for things that are counted or labeled, the
  body face for anything that reads as a sentence, and the display face for
  headings and controls.
- **Do** pick a step off the recorded ramp. Nine steps is already more than a
  dense app needs; a tenth has to displace one.
- **Do** replace a field on the collapsed row rather than appending one.
- **Do** encode every state in at least two channels. Color is never the only
  signal: status has the section heading and the row's own button, lateness has
  the words `OVERDUE BY` and a tooltip alongside the red, a count has a number.
- **Do** make a filled control take its label color from the on-accent token.
- **Do** check a new tint against the panel of the theme it lives in, and
  against the tone the text actually sits on rather than the one behind it.
- **Do** give a link a standing underline. The light theme's interactive color
  is ink, so a link that is only ink is indistinguishable from the sentence
  around it.
- **Do** separate a block with a hairline, a margin rule, or a tone step. One
  device, never a container.
- **Do** declare a shared measurement once and read it everywhere. Two copies
  of a number are two components waiting to disagree.
- **Do** let the label shrink before the box does. Fixed tracks that cannot
  give are what push a layout past a viewport, and on a surface with zoom
  disabled an overflow is unreachable rather than merely awkward.
- **Do** put a coarse-pointer floor at the bottom of the stylesheet, below every
  rule it raises, and grow a press target with an overlay rather than a size.
- **Do** ask before a press that cannot be undone from the row, in the neutral
  confirm shape.

### Don't:

- **Don't** hardcode a hex value anywhere, including white. The green button's
  hover is the one that got away and is not a precedent.
- **Don't** name anything for its color. The signal tokens are roles; a theme
  is free to answer `bad` with a rose.
- **Don't** borrow a signal token to tell categories apart. A chart that counts
  things has no failing state to report; give a category length, weight or an
  annotation, and no gradient, because a color ramp implies a scale the number
  does not have.
- **Don't** add a warm accent to the dark theme. Cool it first — the one warm
  slot is spoken for.
- **Don't** add a resting shadow to anything, or write the keyword `none` into
  a shadow token.
- **Don't** put a card inside a card. A bordered, filled, shadowed box inside
  another one is two containers for one thing; the inner one becomes a titled
  passage of the outer one.
- **Don't** answer a new state with an edge marker. A colored border or stripe
  on the side of a card or list item is the most recognizable tell of generated
  UI, the left edge is spoken for by status, and a fact with a column or a
  label does not also need a margin.
- **Don't** add a third tier to the row's action slot. Filled moves work
  forward, outlined ends the record; a new action picks one.
- **Don't** dress a successful ending in the failure color. Red is for
  cancelling and for failing.
- **Don't** introduce a new animation without checking the existing set first.
  There are no scroll effects, no parallax, and no transitions on color or
  text; the motion vocabulary is a short, closed list.
- **Don't** let a card move itself, and don't let the list move under a reader.
  Nothing in the system expands, collapses, scrolls or re-sorts a row on the
  user's behalf.
- **Don't** let the section a row sits in disagree with the button it offers.
  That agreement is the promise the product is organised around.
- **Don't** treat the dark theme as the light theme dimmed. It is a separate
  room with its own palette, and it was chosen over a faithful dark rendering
  of the warm ledger.
- **Don't** put an actionable control behind the collapse.
