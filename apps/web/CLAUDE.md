# CLAUDE.md (apps/web)

UI rules for `apps/web`. Product rules, workflow and everything non-visual
start at [../../AGENTS.md](../../AGENTS.md).

This file holds only the traps: changes that look fine on screen and break
something anyway. Look and feel lives in the code. Read `src/styles.css` and
the component you are changing, and match what is there.

## Styles

- Colour goes through the custom properties on `:root` in `src/styles.css`. A
  new themeable colour gets a value in all three theme blocks (`light`, `dark`,
  `contrast`); the theme you are not looking at is the one that breaks.
- Filled buttons take their label colour from `--on-accent`. White ink fails
  contrast on the dark and contrast themes' pastel fills.
- A button's fill runs through `--btn-bg` / `--btn-bg-hover`. A variant sets
  those tokens on its class, and `:disabled` overrides them the same way. A
  `background` declared on the class loses to `button:hover` on specificity, so
  the brand fill comes back under the cursor (#171).
- Both shadow tokens hold transparent values, the contrast theme included. The
  keyword `none` voids any declaration that composes them with a second shadow.
- A breakpoint override sits after the rule it overrides. A media query adds no
  specificity, so a phone rule written above its base rule parses fine and never
  applies. Task-card phone rules live at the bottom of `styles.css` under their
  own heading; the touch text floors are the last block.
- `--quick-action-w` is the one width for the row's action column, its button,
  the empty spacer on rows with no action, and the header's `New Task`. Read the
  token everywhere; a literal copy silently stops agreeing when the phone
  breakpoint changes the value.
- The list header is `position: sticky` against the document's scroll. An
  `overflow` on `.app-shell` or `body` silently unpins it.
- Keyboard focus is drawn by `--focus-ring` on `:focus-visible`. A rule that
  removes an outline puts the ring back.
- The app bar is empty for most people in production: the dev user picker is
  stripped and the nav tabs are admin-only. New controls go somewhere else.
- Measure widths with the `pointer: coarse` floor forced on. Playwright reports
  a fine pointer at every viewport, so its numbers come out about 15% narrower
  than a phone.

## Task card (`TaskCard` in `src/App.tsx`)

- `TaskCard` is `React.memo`'d (#73), so every value in `cardProps` is
  referentially stable: hoist a callback or object into `useCallback` /
  `useMemo` first. An inline arrow re-renders the whole list on every 30s tick,
  and lint (`tsc --noEmit`) will not catch it.
- Wording and rules come from `packages/shared`: type names from
  `TASK_TYPE_LABELS`, action labels from `ACTION_LABELS`, step names from
  `currentStepName` / `statusDisplayName`, whose move it is from
  `pendingPartyFor`, lateness from `isOverdue`, unclaimed from `isUnclaimed`.
  The controls a viewer gets come from the predicates the server throws from
  (`canTransitionStatus`, `canEditMessage`, `canAmendTask` and friends), so the
  app draws only controls the server accepts.
- `Confirm` completes and archives in one write. The row sends that one call; a
  follow-up `ARCHIVED` can leave a task completed and not archived.
- A closed (mini) row always renders its action cell: its hamburger is the only
  route to Re-open and Archive.
- An opened card stays where it is. Opening a card that an unread reply pulled
  into "Needs you" must not move it (`src/court-latch.ts`).
- A panel that escapes the card is portaled through `useAnchoredPanel`, with its
  own class rather than `.share-pop-panel` (that class carries the menu's
  outside-click exemption). A portaled panel hosting a text field stops every
  key at its wrapper, or Space toggles the card.
- The fraud hand-back gate stays out of `fraudCardActions`'s default; folding it
  in removes the bot's only route.
- A disabled action keeps its reason on the wrapper's `title` and the button's
  `aria-label`, so a screen reader still gets it.
- A new section in the hamburger panel joins `menuHasContent`.
- UI copy points only at things a screen renders. The task's history log has no
  screen.

## Task form (`src/task-form.tsx`)

- One form files and edits. A new field joins it.
- A Save sends only the fields that moved, one call per field on the existing
  focused routes. The form has no task-shaped endpoint.
- The Humperdink arrival is the app's only clipboard read. No other opening of
  the form is handed a reader, and nothing else in `apps/web` reads the
  clipboard.
- Every refusal a save can hit is reachable without a dialog: the confirmed
  merge re-send runs the same check as the save that asked.
- Dialogs share one shape: `alertdialog`, inert backdrop, Escape declines, focus
  on the safe answer, buttons worded as answers.
- The locked type's popover hides with `visibility`, which keeps its
  `aria-describedby` target resolvable.

## Mobile zoom

The Teams mobile webview has no zoom reset, so page zoom is suppressed in three
layers that `scripts/zoom-guard-sim-test.mjs` holds together.

- `src/zoom-guard.ts` leaves `touchend` uncancelled. Cancelling it drops the
  synthesized mouse sequence, so a quick second tap loses its click.
- `html, body` keep `touch-action: pan-x pan-y`. `touch-action` intersects down
  the tree, and hold-to-edit and the message bubbles depend on their `pan-y`
  being a subset of it.
- The 16px field floor under `pointer: coarse` keeps its `!important` and covers
  every field at once. A focused field under 16px makes iOS zoom.
