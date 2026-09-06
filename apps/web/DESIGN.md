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
    fontSize: "1.35rem"
    fontWeight: 700
    lineHeight: 1.2
  headline:
    fontFamily: "Bricolage Grotesque, DM Sans, sans-serif"
    fontSize: "1rem"
    fontWeight: 700
    lineHeight: 1.25
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
  label:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "0.68rem"
    fontWeight: 500
    letterSpacing: "0.06em"
rounded:
  xs: "3px"
  sm: "4px"
  md: "6px"
  lg: "8px"
  pill: "999px"
spacing:
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
components:
  button-primary:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.md}"
    padding: "7px 14px"
    typography: "{typography.title}"
  button-primary-hover:
    backgroundColor: "{colors.brand-hover}"
    textColor: "{colors.on-accent}"
  button-good:
    backgroundColor: "{colors.good}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.md}"
    padding: "7px 14px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.brand}"
    rounded: "{rounded.md}"
    padding: "7px 14px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.bad}"
    rounded: "{rounded.md}"
    padding: "7px 14px"
  card:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "12px"
  tag:
    backgroundColor: "{colors.bg-soft}"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.sm}"
    padding: "2px 6px"
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

**No card edge is painted at all today.** A status stripe exists in CSS and
nothing emits it — the row is deliberately mono, because the court section it
sits in already says whose court it is. So "one edge, one meaning" is a rule
about what an edge may say if one is drawn again, not a description of the
current screen.

**The dark theme is a different room, on purpose.** It is not the warm ledger
with the lights off; it is an indigo ledger — indigo paper, near-white ink, a
lavender accent — settled after five whole palettes were driven live, including
a faithful dark rendering of the light theme, which lost. A third theme,
`contrast`, is pure black and white with no shadows at all and a deliberately
monochrome person-chip set, because decorative hue variety works against a
maximum-legibility promise.

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
- **Ledger Ember** (`#c25e00`): heat. Highest live urgency, in-flight status
  stripe, and the Loan Docs type bar.
- **Ledger Red** (`#b82d35`): failure and demand. Overdue dates, cancellation,
  errors, the unclaimed-task stripe, and the unread-note dot.

### Tertiary

- **The Person Chips** (eight hues, `#a16b07` through `#a8447a`): a rotating
  avatar palette hashed off a user id. Held deliberately clear of the four
  signal hues so a person's chip can never be misread as urgency.

### Neutral

- **Ledger Paper** (`#f4f2ee`) and **Fold** (`#eae7e0`): the page and its
  recessed areas.
- **Card Stock** (`#fefdfb`): the surface every card and panel sits on, a
  half-step lighter than the page. That tone step is the depth; there is no
  resting shadow under it.
- **Ink** (`#14120f`), **Second Ink** (`#55504a`), **Pencil** (`#6f6a63`):
  three text strengths, high to low. Pencil clears 5:1 against Card Stock; it
  used to sit near 3.6:1, under the floor for the small label text it exists
  for.
- **Rule** (`#d5d0c7`) and **Faint Rule** (`#e8e4dd`): borders, strong to
  faint. A card takes the faint one; a control takes the strong one.

### Named Rules

**The Role-Not-Hue Rule.** Signal tokens are named for what they mean, never
for what color they are. A theme may answer `bad` with a rose and `good` with a
mint; code that assumes red and green is wrong, not the theme.

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
theme's panel rather than assumed from the light one.

**The On-Accent Rule.** Text and icons on a filled accent read `on-accent`,
never `#fff`. The light theme's accents are dark enough for white ink; the dark
and contrast themes use bright pastel fills where white collapses to roughly
2.8:1.

## Typography

**Display Font:** Bricolage Grotesque (700, with DM Sans fallback)
**Body Font:** DM Sans (400 / 500 / 600, with Segoe UI and system-ui behind it)
**Label/Mono Font:** JetBrains Mono (400 / 500 / 600)

**Character:** A tall, slightly eccentric grotesque for headings against a
plain humanist sans for prose, with a true monospace doing all the counting.
The pairing reads as a printed form filled in by hand — the headings have
personality, the body has none on purpose, and the numbers line up.

### Hierarchy

- **Display** (Bricolage 700, ~1.35rem): page and panel titles.
- **Headline** (Bricolage 700, ~1rem): section headers on a list, card titles.
- **Title** (Bricolage 600, ~0.82rem): buttons, controls, and dense header
  chrome. The one place the display face runs at body scale.
- **Body** (DM Sans 400, 14px base): all prose — notes, instructions,
  descriptions, field values.
- **Label** (JetBrains Mono 500, ~0.68rem, tracked, small): dates, counts, type
  labels, status pills, section counts.

### Named Rules

**The Mono-Is-Not-Prose Rule.** The monospace face is reserved for non-prose:
dates, counts, type labels, section counts, status pills. Prose stays in DM
Sans. The two never mix inside a sentence.

**The One Exception That Proves It.** An LOI's request field is drawn in the
fixed-width face, because it holds a pasted term sheet and a term sheet only
lines up in one. That is the single prose-shaped box allowed a mono face, and
it earns it by being tabular data wearing a paragraph's clothes.

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

Spacing runs on a 6 / 8 / 12 / 16 / 20 step. Card interiors take 12; the shell
takes 16.

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

### Named Rules

**The Flat-At-Rest Rule.** A surface that has not been interacted with and is
not floating gets no shadow. If a component needs to look separated while
sitting still, it gets a hairline and a tone step, not elevation.

**The Never-`none` Rule.** Both shadow tokens are transparent no-ops, never the
keyword `none` — including in the `contrast` theme, which still has no shadows.
Several rules compose these tokens with an inset status stripe, and `none`
inside a `box-shadow` list voids the entire declaration. That keyword was
silently deleting the status stripe from the one theme that exists for maximum
legibility.

## Shapes

Softly squared, never round. Corners run 3px on the smallest chips, 6px on
controls and inputs, and 8px on cards and panels — the largest radius in the
system, and small enough that the ledger still reads as paper rather than as a
mobile OS. Fully round appears exactly twice and only where the shape is the
meaning: the person chip, and the small status dot inside a pill.

Everything is bordered. A 1px rule at one of two strengths defines nearly every
edge in the app, and the status stripe on a task card is an inset shadow rather
than a border precisely so it can sit on top of an ownership border without the
two fighting.

## Components

### Buttons

- **Shape:** softly squared (6px), compact padding (7px 14px), display face at
  0.82rem, 600.
- **Primary:** filled Ledger Ink with `on-accent` ink. One per context.
- **Good:** filled Ledger Green. The positive move — Claim, Complete, Approve.
  This, not the brand fill, is the primary action on most task cards.
- **Ghost:** transparent with a brand outline. Secondary and cancel.
- **Danger:** transparent with a red outline. Destructive only; never filled,
  so the eye is not drawn to it.
- **Warn:** filled gold, rare, reminder-related.
- **Small:** a compact size used inside cards and tables, which is most places.
- **Hover / disabled:** driven by two custom properties on the button rather
  than by a `:hover` rule. A variant sets its own fill and hover tokens and
  nothing else; declaring `background` on `:hover` in a variant class loses on
  specificity and lets the brand fill come back under the cursor.

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
- **One edge, one meaning.** No card edge is drawn today: a status stripe is
  defined in CSS and nothing emits it. The rule governs what happens if one
  returns — it would be status and nothing else. The left edge used to also
  carry an ownership border, with a creator stripe mirrored on the right; both
  rules are gone, though both had stopped rendering before they were removed.
  Either way a new row-level state does not get an edge: those facts already
  have a column on the row.
- **Dimming is a channel too.** Work that is not yours and not actionable drops
  to 0.55 opacity, brightening on hover. Anything unclaimed stays bright,
  because anyone may take it.

### Inputs

- **Style:** panel ground, 1px strong rule, 6px radius, body face.
- **Focus:** a 2px brand-tinted ring via the shared focus token. Never strip an
  outline without replacing the ring.
- **Error:** red rule with a red tinted ground and red text.

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
moves a row either way; only the viewer does.

## Do's and Don'ts

### Do:

- **Do** reach for an existing token before defining a color. Every color in
  the app goes through a custom property on `:root`.
- **Do** add any new themeable value to all three themes — light, dark, and
  contrast — before considering it done.
- **Do** keep the monospace face for things that are counted or labeled, the
  body face for anything that reads as a sentence, and the display face for
  headings and controls.
- **Do** replace a field on the collapsed row rather than appending one.
- **Do** encode every state in at least two channels. Color is never the only
  signal: status has text, urgency has a stripe and a tooltip and red text, a
  count has a number.
- **Do** make a filled control take its label color from the on-accent token.
- **Do** check a new tint against the panel of the theme it lives in, not
  against the light theme's.
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

### Don't:

- **Don't** hardcode a hex value anywhere, including white.
- **Don't** name anything for its color. The signal tokens are roles; a theme
  is free to answer `bad` with a rose.
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
- **Don't** introduce a new animation without checking the existing set first.
  There are no scroll effects, no parallax, and no transitions on color or
  text; the motion vocabulary is a short, closed list.
- **Don't** let a card move itself. Nothing in the system expands, collapses,
  or scrolls a row on the user's behalf.
- **Don't** treat the dark theme as the light theme dimmed. It is a separate
  room with its own palette, and it was chosen over a faithful dark rendering
  of the warm ledger.
- **Don't** put an actionable control behind the collapse.
