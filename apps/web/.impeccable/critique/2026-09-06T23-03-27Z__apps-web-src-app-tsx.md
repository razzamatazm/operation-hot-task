---
target: apps/web task board
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 4
target_identity: "file:/Users/tylerhereford/repos/operation-hot-task/apps/web/src/App.tsx"
timestamp: 2026-09-06T23-03-27Z
slug: apps-web-src-app-tsx
assessed_at_commit: 86e1be6
status_updated: 2026-09-07
status_updated_at_commit: fbff5ae
---

> ## STATUS — read this before acting on anything below
>
> **The report below is the original assessment, taken at `86e1be6`. It has not
> been re-run.** The scores in the frontmatter and in the heuristic table are
> that assessment's and are deliberately left alone: changing them without
> re-running both assessments would put a fabricated number into the trend.
> Assume the table is stale where it overlaps the resolved items.
>
> This block is the layer on top. It is maintained by hand so the next agent
> does not have to re-run a critique (two isolated sub-agents plus a browser
> pass) just to find out what is still true.
>
> ### Resolved — PR #329, merged as `fbff5ae`
>
> | Issue | Status | Where |
> |---|---|---|
> | P1 Opening a task relocates it | **Resolved** | `apps/web/src/court-latch.ts`, a court hold taken on expand and released on collapse |
> | P1 Section and button disagree | **Resolved** | slot reads `Unread reply` / `Read reply` when the pull is what placed the row |
> | P1 One button style for eight actions | **Resolved, narrowed** | two tiers (filled moves work forward, outlined ends the record) plus a confirm on terminal presses. NOT the three-way split this report proposed — see the issue below |
> | P1 Phone type below readable | **Partly resolved** | type floor landed in full; only 2 of 5 hit targets addressed |
> | P2 Metrics signal roles as palette | **Partly resolved** | bars and gradient done; the tile row was not |
>
> Design rules created by that work live in `apps/web/CLAUDE.md` (two-tier
> action slot, terminal confirm, court hold, touch floors, the hand-back gate)
> and in `docs/product/fraud-workflow.md`. Read those, not this file, for what
> the rules currently are.
>
> ### Still open
>
> 1. **Metrics totals are still tiles.** The report asked for "a mono row on a
>    hairline"; the tile borders were already gone before #329, so only the mono
>    row was outstanding and it was never built. `.stat-number` is still the
>    display face. Smallest remaining item, contained to one panel.
> 2. **Three hit targets still under 40px:** the checklist checkbox (18x18), its
>    `+ note` button (37x13), and the loan-name link (114x18). Deliberately not
>    floored — all three sit within a few pixels of another control, so a press
>    overlay would steal presses from a neighbour. Needs a layout decision.
> 3. **`btn-good`'s hover green** (`#256942`, styles.css) is the one hardcoded
>    colour in the stylesheet. Wants a `--good-hover` in all three themes.
> 4. **`.tag` ships at 0.73rem** while the `label` role it belongs to is
>    0.68rem. One of the two should move. **The user has been asked twice and
>    has not chosen — ask, do not pick.**
> 5. **The admin pages run a parallel px type scale** (9/10/11/12/13px) with no
>    rule behind it. Recorded in DESIGN.md as drift rather than blessed. Same
>    shape of problem as Metrics: a surface the design passes never reached.
> 6. **Everything in "Minor Observations" and "Persona Red Flags" below is
>    untouched** unless it appears in the resolved table. Those sections are the
>    reason to keep this file: they are findings nobody has acted on, not a
>    record of work.
>
> ### Corrections to the report below
>
> - **The Metrics tile borders were already gone at assessment time.** The
>   report says "five bordered filled tiles inside the bordered `.metrics-panel`"
>   — the tiles are borderless wells and were before this. The card-in-card
>   reading was wrong; the mono-row half of the recommendation still stands.
> - **`--avatar-1` / `--avatar-2` colliding with `--warn` and the retired brand
>   blue is confirmed** and is now recorded in `apps/web/DESIGN.md` as a known
>   exception rather than as intent. Still unfixed.
> - **The `.section-count` contrast figure is confirmed:** 4.34:1 against
>   `--bg-soft`, under the 4.5:1 floor. Recorded in DESIGN.md. Still unfixed.

Method: dual-agent (A: design review, isolated; B: detector + browser evidence, isolated). Both ran as separate sub-agents with no visibility into each other. B returned first, but A's judgment was formed blind (it was barred from running the detector), so the anchoring rule holds.

# Critique: the task board (`apps/web`)

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | An admin sees "Tasks 10" in the tab strip and "Tasks 13" in the list header 50px below it, same mono count chip, nothing says which is true |
| 2 | Match System / Real World | 3 | Domain language is excellent, but the row's action slot renders the word "Cancel" in the same place other rows render "Claim" |
| 3 | User Control and Freedom | 2 | No undo on any quick action. Claim, Merge Done, Send Items and Archive all fire on one press with no confirm |
| 4 | Consistency and Standards | 2 | One button style for eight actions of wildly different consequence; grouped view draws cards, flat view draws a table; Metrics invents a grouping device the layout rules say doesn't exist |
| 5 | Error Prevention | 2 | The Humperdink import control and its paste box sit in the form's footer next to Cancel and Create Task, an input action parked in the commit zone |
| 6 | Recognition Rather Than Recall | 3 | Flat view drops every court label and has no column headings, so reading a row means recalling which name is yours |
| 7 | Flexibility and Efficiency | 3 | No search, no filter, no narrowing by type or urgency anywhere. Someone with 40 live tasks has grouping and scroll |
| 8 | Aesthetic and Minimalist Design | 3 | The list earns this. Metrics does not: a gradient bar, a "100%" badge and a "3 -> 3" diagram all saying one number |
| 9 | Error Recovery | 2 | A blocked Submit is a dead grey button whose explanation lives only in a hover tooltip, on a product that ships to a touch webview |
| 10 | Help and Documentation | 1 | Six task types, a two-phase fraud check, a merge chain and a corrections loop, with zero in-product explanation of any of it |
| **Total** | | **24/40** | **Competent, with one outstanding component and several unauthored surfaces** |

> **Scores are as at `86e1be6` and have not been re-assessed.** Rows 3 (User
> Control), 4 (Consistency) and 9 (Error Recovery) all improved with #329 —
> terminal presses now confirm, the action slot has a readable two-tier rule,
> and the phone type floor landed — but putting a new number here without
> re-running both assessments would feed a made-up score into the trend. Re-run
> `/impeccable critique` when a fresh number is actually wanted; until then read
> the table as history and the STATUS block at the top as current.

## Design Specificity Verdict

**The design review's read:** this is authored for this product, and unusually so, but the authorship is concentrated in one component and evaporates the further you get from it.

The collapsed task row is genuinely this app's own object. Two lines, one elastic track (the loan name), no painted card edge anywhere, lateness said once on the number, and an action slot that resolves three ways so no row ever reads as a rendering failure. Jira or Linear could not wear that row. The vocabulary is on the screen and not just in the glossary: "Up for grabs", "Waiting on Suzie", "WITH REQUESTER", "UNCLAIMED FOR", "Needs corrections". The dark theme is a real second room rather than a filter, and the high-contrast theme is authored down to monochrome person chips.

Where it goes category-interchangeable is everywhere the row isn't. Metrics is a stock KPI dashboard: five equal stat tiles inside a bordered panel (a card inside a card, which the design doc forbids by name), a full-bleed navy-to-orange gradient bar restating a number already printed twice beside it, and a type breakdown that spends the four signal roles as a categorical palette. Fraud Check is painted red, Value Check green, Loan Docs orange, and three types get no colour at all. That is the app's central discipline inverted: the colour that means "failure" is being used to mean "fraud check".

The biggest structural sameness is that every primary action in the list renders as the identical filled black button, because the class never varies by action (App.tsx:2019).

**Deterministic scan:** the detector exited clean with 66 advisory findings, all in `src/styles.css`. 48 off-ramp font sizes (roughly 18 distinct values against the 5 recorded in DESIGN.md), 17 off-scale corner radii, and exactly one hardcoded colour in 4,102 lines: `#256942` at styles.css:1183, a hand-darkened Claim-button hover green with no `--good-hover` token behind it. The other 65 findings say the DESIGN.md type and radius scales are stale relative to what ships, not that the stylesheet is random.

Neither the CLI nor the in-page scan reported a single card-edge or status-stripe finding. The deletion passes of 2026-09-05 and 2026-09-06 are clean.

**Visual overlays:** injection succeeded and the in-page detector ran across five views (grouped board, flat board, expanded rows, create form, dark theme) on a live-server that has since been stopped, so nothing is live in the browser now. It reported 34-36 undersized-text instances per view, five low-contrast instances (all `span.section-count`, 4.3:1 against `--bg-soft` where 4.5:1 is needed), and a thin-border-plus-wide-shadow pattern on `div.app-menu-panel` and the open card. Dismissed as deliberate and documented: the cream palette (the north star), the all-caps type label (documented non-prose), the type-label truncation (the documented 45% cap working), the pulsing unread dot, and the `transition: width` on the metrics bar.

## Overall Impression

One genuinely excellent component, and an app that doesn't yet live up to it. The row is defended, measured, and specific. Then the single control on that row carries no information about what pressing it does, the phone rendering leaves the labels a person actually reads at 8.8px on a surface where zoom is off by design, and the one tab an admin screenshots into a management deck is the one surface the anti-generated-UI passes never reached.

Single biggest opportunity: the button. Eight actions of wildly different consequence, one black fill, no confirm on any of them.

## What's Working

**The row holds up under real measurement.** Driven at 1440, 1280 and 390 widths, the action column never drifts: fixed 32px menu button, 6px gap, 116px action, title as the only elastic track. Most dense list rows in this category go ragged at the second breakpoint. This one doesn't, and the reason is `--quick-action-w` declared once and read everywhere.

**"Waiting on <name>" earns its slot** (App.tsx:2041-2046). It fills what would be dead space with the one thing an observer or a stalled party wants, sourced from the shared `pendingPartyFor` rather than re-derived. Passive span with no handler, so it can't be mistaken for a control, and it means no row in the list reads as broken.

**Three themes that are actually three themes.** The indigo dark theme is a different room, not a dimmed light theme, and `contrast` is authored down to monochrome chips and no shadows, including the no-op-rather-than-`none` shadow tokens. All three verified rendering correctly.

## Priority Issues

### [P1] ✅ RESOLVED (#329) — Opening a task relocates it out from under you
**Why it matters:** Expanding a row that carried an unread note fires `acknowledgeUnread` (App.tsx:1743-1748), which clears the message pull; `buildCourtSections` (App.tsx:4471-4477) then recomputes the court and the row moves section. Verified live: before the click, "Needs you 3" with a loan third; after, "Needs you 2", "In flight 5", and that loan sitting tenth of thirteen, still open, roughly 600px down the page. The product rule is that the view never moves itself, and #161 removed auto-open for exactly this reason. Same defect, different clothes: the row didn't move, the list did, and the user's own click was the trigger. On a 390px phone with zoom off, the card they just opened is off-screen.
**Fix:** Freeze court membership for any currently-expanded task. Hold it in the bucket it was in when it opened; let it re-sort when the viewer collapses it. `expand-state.ts` already owns per-task expansion, so the predicate is available where sections are built.
**Suggested command:** /impeccable harden

### [P1] ✅ RESOLVED (#329) — The section and the button disagree, which is the one thing the product promises never happens
**Why it matters:** A message-pulled task is placed in "Needs you" (App.tsx:4473-4477) while the action slot is computed from `pendingPartyFor` alone (App.tsx:2041-2046), which knows nothing about the pull. On screen: a loan under the heading **Needs you**, with **"Waiting on Suzie"** in its action slot. "The group a task sits in never disagrees with the button it offers" is the organising promise, breaking in the most-scanned place on the screen.
**Fix:** When the pull is what put a task in your court, the slot should say what the pull means, "Unread reply" or "Read reply", not the chain's pending party. The slot already resolves three ways; this is a fourth branch ahead of `waitingLabel`.
**Suggested command:** /impeccable clarify

### [P1] ✅ RESOLVED, but not as prescribed (#329) — One button style for eight actions of very different consequence

> **The fix below was deliberately not taken as written.** It proposes three
> tiers (`btn-good` for Claim, brand fill for advancing, ghost for terminal).
> What shipped is **two**: filled moves the work forward, outlined ends the
> record, and Claim keeps the brand fill. The reason is that the repo had
> already collapsed a good/ghost/danger split for reading as three inconsistent
> buttons, and reinstating three would have walked back into it. The rule is in
> `apps/web/CLAUDE.md` under Buttons, with a standing "don't add a third tier".
> Terminal presses also gained a confirm, which this report did not ask for.
**Why it matters:** `quickActionClass` never varies (App.tsx:2019). Claim (reversible), Merge Done (moves the ball), Send Items (hands the task on), Approve Merge, Confirm (completes and archives in one write) and Archive all render as the identical black filled button at 116px, and all fire immediately with no confirm (App.tsx:2702). In a thirteen-row list the button is the strongest thing on screen and carries no information about what pressing it does. Confirm, at the tail of a corrections loop, archives a task in one press and looks exactly like Claim. DESIGN.md prescribes `btn-good` for Claim/Complete/Approve and calls it "the primary action on most task cards". That is not what ships.
**Fix:** Two tiers, not eight. Taking work on gets `btn-good`. Advancing the chain keeps the brand fill. Anything terminal (Confirm, Archive) takes the ghost treatment so the eye isn't pulled to it. Existing button vocabulary, applied.
**Suggested command:** /impeccable clarify

### [P1] ⚠️ PARTLY RESOLVED (#329) — Functional type on the phone is below readable at rendered size, where zoom is off

> **The type floor landed in full** and covers more selectors than the three
> named here, in a `Touch floors` block at the very bottom of `styles.css`.
> **The hit targets did not.** Only the two 32x32 menu triggers were addressed,
> and by a 40px `::after` overlay rather than a bigger box, because the row's
> action column is measured off that 32px. The checklist checkbox, its `+ note`
> button and the loan-name link are still under 40px and still open.
**Why it matters:** Both assessments measured this independently and agree. At 390x844: due labels ("OVERDUE BY", "WITH REQUESTER", "RETURNS") at 8.8px, "Waiting on <name>" at 9.6px, `span.checklist-adder` at 8px, `span.app-menu-label` at 9.6px, the type label at 10.88px. Font sizes at 390px are byte-identical to 1440px; nothing scales up. Zoom is disabled in three layers on purpose, which makes rendered size the only size there is. The `(pointer: coarse)` block already lifts inputs to 16px to defeat iOS focus-zoom, then leaves the labels a person reads at 8.8px. "OVERDUE BY" is half of a two-channel signal the accessibility notes explicitly claim. Targets that never change at the phone breakpoint: `button.task-card-menu-trigger` 32x32 (x13), `button.checklist-check` 18x18, `button.checklist-note-add` 37x13, the loan-name link 114x18.
**Fix:** Add a `(pointer: coarse)` floor for text the way there is one for inputs: 11px minimum on `.task-card-grouped-due-label` and `.task-card-quick-action-waiting`, 12px on `.task-card-collapsed-type-text`, and lift those four targets to 40px. Per the breakpoint-order rule, at the bottom of styles.css.
**Suggested command:** /impeccable adapt

### [P2] ⚠️ PARTLY RESOLVED (#329) — Metrics spends the signal roles as a decorative palette

> **Bars and gradient done:** every type bar is `--ink` and differentiated by
> length, the `.type-bar-*` variants are deleted, and the ratio bar's gradient
> is gone. **The tile row was not.** Note also that the "five bordered filled
> tiles inside the bordered panel" reading below is **wrong** — the tile borders
> were already gone before this branch, so there was no card-in-card. What was
> never built is the other half: the five totals as a mono row on a hairline.
> That is the smallest open item on this whole report.
**Why it matters:** `TYPE_BAR_CLASS` (App.tsx:2986-2993) maps Fraud to `--bad`, Value to `--good`, Loan Docs to `--hot`, leaving three types uncoloured; `.type-bar-good/bad/hot` paint the raw signal tokens (styles.css:3382-3384). Signal tokens name roles, so painting "Fraud Check" red says a fraud check is a failure. Beside it, `.ratio-bar-fill` is a brand-to-hot gradient (styles.css:3489) restating a percentage already printed as "3 -> 3" and as "100%", and `.stat-card` (styles.css:3329) puts five bordered filled tiles inside the bordered `.metrics-panel` (styles.css:3241). This is the one tab the anti-generated-UI passes never reached, and the tile row, the gradient and the card-in-card are the three most recognisable stock-dashboard shapes there are. It is also the surface most likely to end up in a management deck.
**Fix:** Type bars all take `--ink`, differentiated by length, which is what a bar chart is for. Delete the gradient; the ratio is already a number. Drop the tile borders and let the five totals be a mono row on a hairline, the way every other grouping in the app works.
**Suggested command:** /impeccable distill

**Below the cut:** the light-theme person chips are not held clear of the signal hues as DESIGN.md claims. `--avatar-1: #a16b07` is byte-identical to `--warn: #a16b07`, and `--avatar-2: #2c5ea0` is the SaaS blue deliberately removed as `--brand` on 2026-09-05 (styles.css:74-75 vs 42). A green chip sits two centimetres from a green button and a gold chip from a gold urgency stamp.

## Cognitive Load

Five of eight checklist items fail. High load, driven mostly by two surfaces rather than by the list.

- **Single focus:** passes on the task list. Fails on Metrics, where four unrelated panels compete with no lead and no priority.
- **Chunking (max 4):** passes for a normal viewer at four courts. Fails for an admin: five sections, two of which ("Finished", "Done") both mean over.
- **Grouping:** fails in flat view. Thirteen rows, no sections, no headers, no separator stronger than a hairline.
- **Visual hierarchy:** fails in the expanded body. On an LOI the order under the timeline is "HOW BAD?" (poop emoji) then "Loan Terms and Contacts". The joke-priority score outranks the loan on the surface a checker opens to decide whether to claim.
- **One thing at a time:** fails on the create form, which has no visible title in either mode (only `aria-label="New task"`). Create and edit are distinguishable only by the submit button's word at the far bottom.
- **Minimal choices (max 4):** three failures. App menu holds 7 controls mixing two unrelated preferences and an action. The task hamburger reaches 8 entries plus a timestamp block. The create form's top row puts four controls, including a 6-option type select and a 5-slot poop tray, ahead of the field the form is about.
- **Working memory:** fails. Flat view requires holding "I am Alexa" to parse every row; the admin's 10-vs-13 forces two contradictory counts.
- **Progressive disclosure:** well done on the row/hamburger split; over-applied exactly once, in that a blocked Submit's reason is disclosed only on hover.

**Decision points with >4 visible options:** app menu (7), task hamburger (up to 8), type select (6), the flat list itself (13 rows x 2 controls, ungrouped), Metrics type breakdown (6 bars).

## Emotional Journey

**The peak is real and well-placed.** A creator's completed task pins to "Finished" at the top with a green halo pulse, then offers Archive. The person who asked for the thing gets told in the one place they'll look, and gets to file it away themselves.

**The end is weak.** The session closes on "Done": three grey mini rows reading "check 2d ago", "cross 4d ago", "check 9d ago". The check covers both completed and archived, the cross covers cancelled, so the last impression is a glyph that means two things and a glyph that means failure, at 0.55 opacity.

**The dominant valley is the red wall.** In a fresh seed, five of eight active rows read "OVERDUE BY" in bold red. Nothing degrades: 3h overdue and 21h overdue are the same red, weight and size. No triage device, no filter, no way to ask for the ones still savable. Overdue is the state the app most needs to help with and the one it does the least about.

**Reassurance is uneven.** Cancel is handled well: a two-step inline confirm, "Cancel this task?" / "Yes, cancel" / "Keep" (App.tsx:2089-2098), answers worded as answers rather than OK/Cancel. The loan-merge dialog is the best-considered moment in the product: it names the other loan, says which record survives, and focuses the safe answer. Completing a Fraud Check is reassured structurally, by the checklist gating Submit. Archive fires with no confirm at all, and it is the action offered at the emotional peak, one press from the celebrating row. Handoff was not exercised.

## Persona Red Flags

**A file checker on a phone, in the Teams mobile webview.** She opens the tab between calls. The due labels she needs are 8.8px with no pinch to fix it. On one loan she sees a grey Submit she cannot press, and the sentence explaining why is bound to `title` and `aria-label` (App.tsx:2700-2701), so on her device the button is simply dead. Hit targets are 32x32. She taps a row with a red dot to read the note; the row jumps section and she loses her place. The type label she needs, "Fraud Check - Outstanding Items", truncates by 49px even at 1440px, so the phase she is in is what gets cut.

**A loan officer who filed nine asks this morning.** Her own open tasks live in "In flight" mixed with other people's work she has no stake in, and the only per-row control on them reads "Cancel" in red, the word that everywhere else means "dismiss", offered in the same slot where the row above says "Claim". No filter, no search, no "things I asked for" view. The one number she wants, "UNCLAIMED FOR 23h 58m", sits in the same cell, face and red as "OVERDUE BY", so at a glance she cannot tell "nobody took it" from "somebody is late".

**An admin.** She sees "Tasks 10" in the tab strip and "Tasks 13" in the list header immediately below (App.tsx:4622 vs 4732), both in the same mono count chip, and nothing says which is true. Five sections instead of four, two meaning over. The Metrics tab she owns is the least-authored surface in the product, and its type bars actively mislead her about which work is going badly.

**An idle teammate scanning for something to pick up.** In grouped view this works exactly as designed: "Up for grabs" is bright, everything else dimmed, and the pull is real. In flat view the mechanism disappears entirely: thirteen rows, no headings, claimable ones first only because the sort happens to put them there. The two unclaimed rows were ordered "Within 1 Hour" above "Urgent Now", so the flat list presented the less urgent claim first.

## Minor Observations

- The unread-note dot has no fixed column. It sits after the type label, so its x-position tracks the loan name's length; measured at three different positions in one screenful. The app's only attention signal is the one thing you cannot scan a vertical edge for.
- The "Up for grabs" due column mixes three kinds of thing in one styled slot: an urgency band name ("Urgent Now"), a duration ("Within 1 Hour"), and an absolute date ("RETURNS Sep 11, 2026").
- "Urgent Now" reads as an instruction, not a timeframe.
- The read view of an LOI's terms is DM Sans while the edit textarea for the same terms is mono. The argument for the mono exception applies harder to reading than to typing, and the columns visibly don't line up in the expanded card.
- "HOW BAD?" is the only interrogative label in the app and it is set in the face reserved for non-prose.
- Poop emoji render in full colour in the `contrast` theme, which is otherwise pure black/white/cyan by design. The unfilled slots are greyscale, so the row reads as smudges.
- Task menu entries are full-width, centre-aligned filled buttons, so Unclaim, Share and Reassign all look like equal primary actions. Native menus are left-aligned lists with a hierarchy.
- The check glyph covers both completed and archived on mini rows. Two states, one symbol.
- The create form has no visible heading in either mode.
- "SHARE DIRECTLY - Optional" marks optionality in the label; the Humperdink field marks it in the placeholder. Two conventions on one form.
- The Claim button's hover green (styles.css:1183) is the one hardcoded colour in the stylesheet. It wants a token.
- `span.section-count` measures 4.3:1 against `--bg-soft` where 4.5:1 is needed. The notes record `--muted` at ~5:1, which is true against `--panel` and not against the tone it actually sits on.
- At 1440px a row is ~1265px wide with roughly 900px of empty paper between the loan name and the action. The saccade from loan name to "Send Items" is the longest distance in the app.
- The `(pointer: coarse)` 16px input floor could not be verified: the automation browser reports a fine pointer even at 390px, so the touch floor never activated. Needs a real touch-emulation context.

## Questions to Consider

1. If the court section is the status channel and the button is the action channel, why does the row spend its widest dimension putting them at opposite ends of a metre of blank paper? What does this list look like at 900px instead of 1320px?
2. Five of eight rows were overdue in a fresh seed. When overdue is the normal state, is red still a signal, or is it the background?
3. "Cancel" sits in the same slot as "Claim". Complete was already renamed to Confirm because the press does more. Why did Cancel survive that same scrutiny, in the same slot, meaning the opposite of what every other app means by it?
4. The design system forbids a card edge because a fact that already has a column does not also need a margin. Does that same argument condemn the "Waiting on X" label, which the notes say states what the two person chips already tell an observer?
5. Flat view exists as a user-selectable counterpart to the courts. If the courts are the organising idea of the entire product, what is flat view for, and does anyone actually choose it?
