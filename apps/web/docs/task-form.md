# The task form (file and edit)

The long form of the task form rules in [../CLAUDE.md](../CLAUDE.md), moved out
of that file on 2026-09-14 so it loads only when it is needed. Read it before
changing filing or editing, the discard prompt, autosave and Task Drafts, Save
for later, the Humperdink import and arrival, or the loan fields and the merge
dialog.

One form does both jobs, in [src/task-form.tsx](../src/task-form.tsx). Filing a
new task is the default; passing an `edit` prop turns it into the edit mode
`Edit Task` opens (#260, ADR-0008 rule 4). Two surfaces that write the same
fields are two surfaces that drift, so there is deliberately no second form.

**Who is offered the door** is shared `canAmendTask`, never a local check —
the creator of an active task on any type, plus the assignee of an LOI, whose
request field holds the loan's terms (ADR-0008 rule 5, #263).

**What is behind the door is a second question.** Urgency and poop points stay
the creator's on every type, so `creatorOnlyFields` in
[src/task-form.tsx](../src/task-form.tsx) draws that pair only when the viewer
filed the task (#261 answering #263). Filing is always your own task, so the
create form always shows both. The door predicate is deliberately not widened
to cover them: the app must never draw a control the server would refuse, and
"may this person edit anything here" and "may they move this field" are two
rules that happen to coincide for one viewer.

**The two modes are one shape** (2026-09-04 redesign). Four controls across the
top — folder name, type, timing, poop rating — in `.task-form-quad`, its own
grid rather than the form's four equal columns, because those four don't want
equal shares. Under them the request field, which is the only thing on the form
that wants vertical room, then the Humperdink link. Across the bottom,
`.task-form-foot`: a tinted strip bled out through the panel's padding to its
own edge, holding the two exits on the right and the one thing each mode has to
say beside them on the left. Two columns from 980px, one from 480px.

**Closing it asks first** (#283). The backdrop has been inert since #114, which
fixed the accidental exit; Cancel and Escape were still instant and silent, and
took the whole draft with them. Both now go through one `requestClose` in
[src/task-form.tsx](../src/task-form.tsx) — one door, so the two exits can never
answer differently — which raises
[src/discard-confirm.tsx](../src/discard-confirm.tsx) when there is anything to
lose. In edit mode "anything to lose" is `formHasChanges` in
[src/create-form-state.ts](../src/create-form-state.ts): the form differing from
the values it OPENED with, because an edit form is full of values nobody typed,
and measuring those against a blank form would prompt every time. A create form
uses the same predicate against a blank form instead (#365, below).
Deliberately over-eager: any field, nothing
trimmed, a changed task type on its own included, plus the FRAUD seeder's
half-typed item — the one thing it *does* trim, because the seeder itself
refuses to commit a whitespace-only one. It is not `taskEdit`, which
answers the much more forgiving "is this worth sending to the server". An
untouched edit form still closes on the first press, because a prompt that
appears every time is one people stop reading. The backdrop stays inert and
raises no prompt either. Confirming is a bare `onClose`, which is the single
line the draft-saving work hangs "and clear the draft" onto.

**A create form asks whenever there is anything in it** (#365, the
maintainer's rule). The decision is `cancelAsks` in
[src/create-form-state.ts](../src/create-form-state.ts), and it splits by mode.
Edit mode keeps the rule above, measured against the values it opened with. A
create form is measured against a blank form (`opening.fresh`), the Save for
later button's own yardstick, so a form restored from the autosave and left
alone still asks, and only a completely empty new task closes without a prompt.
A reopened Saved for Later task always asks, changed or not, so it never
closes silently.

**And it remembers what you typed** (#284). The prompt above only covers the
exits the app can see. The one it exists for — the Teams tab that reloads, the
session that drops — runs nothing on the way out, so the new task form keeps a
copy of itself as it is typed into and opens on that copy next time. It was a
`localStorage` copy until #371 moved it to the server, with `localStorage` kept
only as the offline fallback (below). What that looks like on screen is #285,
below.

The rules are [src/create-form-draft.ts](../src/create-form-draft.ts) —
framework-free, storage handed in as three methods, so seven-day expiry and
"anything malformed is no draft" are testable without rendering a form
(`scripts/create-form-draft-sim-test.mjs`); the wiring is asserted in
`scripts/task-draft-form-sim-test.mjs`. What that buys:

- **Per person, not per machine** — `loan-tasks:create-draft:<userId>`, the same
  convention as `loan-tasks:expand:<id>`. The seat (storage object + user id) is
  pinned when the form opens, because the mock user picker can change who is
  signed in mid-form and the live id would file the first person's typing under
  the second person's name.
- **Written as they type**, on a trailing debounce keyed on the values: a
  second since #371 (`UNSAVED_SAVE_DEBOUNCE_MS`, the reopened form's), because
  each write is now a request. Never on unmount or `beforeunload`: a save that
  needs an exit path to run is not there for the failure this exists to survive.
- **Worth saving is `formHasChanges` again**, measured against a blank-slate
  open — so a changed task type on its own is enough, and the prompt and the
  draft can never disagree about what "untouched" means. Measured against
  `openedWith` instead it would call a restored draft unchanged and stop saving
  it.
- **Forgotten in one place** (`forgetDraft`), reached by a successful create,
  confirming the discard prompt, Start fresh (#285), Save for later (#343), and
  a form emptied back out. Declining the prompt changes nothing. A restored draft is not rewritten just for being opened, so its seven
  days mean untouched rather than unopened.
- **Edit mode has null storage** rather than a rule not to save — there is
  nowhere to write, so nothing further down can slip.
- **Storage that refuses or is full is silent.** Every read and write is
  wrapped, failure is `null`, and the form behaves exactly as it did before this
  existed. A restored `loanId` is kept but never trusted: `createLoanId` in
  [src/create-form-state.ts](../src/create-form-state.ts) only sends one whose loan
  still exists and still carries the name in the box, so a loan renamed, merged
  or removed during the week the draft sat there behaves like any typed no-match
  (ADR-0001) rather than erroring.

**It lives on the server since #371** (ADR-0011 rule 5), and `localStorage` is
only its offline fallback. What changed underneath the bullets above:

- **Opening reads two copies and takes the newer.** App passes `autosave`, the
  server's copy, which `openNewTask` fetches again on the way in
  (`loadAutosaveRequest`, giving up after two seconds so a hanging server never
  holds the form shut). The form weighs it against the browser's copy with
  `newerAutosave`, so typing the server never got still comes back.
- **A write goes to the server first** (`keepAutosave`, through
  `onKeepAutosave`). A write that lands removes the browser's copy; one that
  fails writes it. Neither is ever toasted.
- **`forgetDraft` forgets both**, the browser's at once and the server's after
  any write still out, and only on a form with an `autosaveSeat`: a reopened or
  edit form has none, as it has no storage.
- **Autosave writes join `unsavedWrites`**, the queue every ending already waits
  on, and the timer does nothing once `ending` is set, so no keystroke's write
  can land after Create, Save for later or Discard and put the typing back.
- **Save for later from a new form sends `clearAutosave`**, which the server
  applies in the same write, so the Task Drafts tab never lists one form twice.

Two rules moved out of the component to be tested rather than described:
`draftAction` (write / keep / clear, as a truth table) and `createLoanId` above.
The submit path's "only pass a `loanId` that still matches" check was inline in
`handleSubmit` before #284 needed it to survive a week-old pick. And the effect
that drops an ineligible recipient now waits for a non-empty `directory`: a
restored draft is the first thing that can open the form with somebody already
picked, and an unloaded list is not an answer about who is eligible.

**And it says so, once, at the top** (#285). A restored draft with no
explanation is a small mystery — someone opens New Task expecting an empty form
and finds Tuesday's abandoned attempt. `.task-form-restored` is one row across
the top of the form's grid holding the info icon, the sentence
(`restoredDraftCopy` in [src/create-form-draft.ts](../src/create-form-draft.ts),
a pure function for the reason `discardConfirmCopy` is one) and `Start fresh`
beside it. What keeps it honest:

- **Quiet, in `.task-form-locked`'s muted register.** No tint, no border, no
  banner and no toast: the app did what it promised, so this is prose, not an
  alert. The button is `.btn-sm .btn-ghost` — the primary action on this form is
  still Create Task.
- **No live region**, unlike the footer's two lines. Those appear while somebody
  is working and have a change to announce; this is on screen from the first
  paint inside a dialog whose contents are read on entry, and a region mounted
  with its text already in it announces nothing.
- **Keyed to how the form opened**, never to what is in it now, so editing the
  restored values does not take it away. It is where `Start fresh` lives and the
  person who wants that button is a few seconds in, having just realised this is
  not the task they meant to file.
- **`Start fresh` asks nothing.** One press empties every field and deletes the
  saved draft. A confirmation would be a prompt over a form nobody asked for,
  and a misfire costs one keystroke to start saving again.
- **It re-points `openedWith` at the blank form**, which is the subtle half.
  That ref is what the save timer measures "has anything happened here"
  against; left on the restored values, an emptied form would read as heavily
  changed, and the timer would immediately write the blank over the draft just
  deleted. (Cancel on a create form measures against the blank form since #365,
  so an emptied one closes without asking regardless.) It
  also clears everything that is a field without being in the values object —
  the typeahead's three pieces of state, the FRAUD seeder's box, and what a
  Humperdink import left behind — and takes the line down: after `Start
  fresh` nothing was restored, so there is nothing to say.
- **Focus moves to the folder name box**, first thing and before those clears.
  The button unmounts itself, so focus would fall to the document body, outside
  the dialog — and the overlay's Escape handler only sees keys bubbling from
  inside it, leaving a keyboard user in a form with no way out. Before the
  clears because that box's `onFocus` seeds the typeahead from the value it can
  still see. `folderNameRef` is on the typeahead input for this reason; it used
  to be an edit-mode-only refusal target.

**Save for later puts a new task aside** (#343,
[ADR-0011](../../../docs/adr/0011-saved-for-later-is-private-server-state.md)). A
ghost button between `Cancel` and `Create Task`, create mode only, so Create Task
stays the one filled button. What keeps it honest:

- **Pressable once the form is touched, and nothing else is asked.** "Touched"
  is `formHasChanges` against `opening.fresh`, the autosave's own yardstick, so
  the button and the autosave never disagree, and a form restored from the
  autosave can be put aside without typing into it again.
- **The whole form is kept**, including a Fraud seeder item still in its box,
  folded in the way Create folds it. The server's shape for it is held to the
  autosave's field list by `scripts/saved-for-later-sim-test.mjs`.
- **Save, then forget the autosave, then close**, and only once the save
  landed. A failed save is toasted by App and leaves the form open.
- **The Task Drafts page is its own component**, `TaskDraftsPage` in
  [src/saved-for-later.tsx](../src/saved-for-later.tsx), lifted out for the reason
  `thread.tsx` was. It is the whole body of the board's Task Drafts tab (#363),
  mounted once, in the Tasks board block, with `savedForLater` as App loaded it:
  never a list the search or Mine has been at. It used to be a section inside
  `renderTaskList`, after the `you` court in Grouped view and above Flat view's
  list (#343, #346); `renderTaskList` now takes tasks and nothing else, and a
  test fails if a draft finds its way back into it. The page draws no heading
  or count, because the tab above it is both, and with nothing saved it is an
  `.empty-card` naming the Save for later button that fills it. A row is
  `.saved-row`: loan name (or `No loan yet`; on an Out of Office task the
  vacation description or `No description yet`, #362), type, `saved N ago`,
  and no more, because a saved
  task has no pair, due stamp or action to draw. Since #371 the page also takes
  `autosave` and draws it as one more `.saved-row` in the same shape, sorted in
  by `savedAt` and reading `Autosaved N ago`; its tap is `onOpenAutosave` (App's
  `openNewTask`, the New Task button's own way in) and its delete
  `onDeleteAutosave`, through the same in-row question. `taskDraftsCount` is the
  tab's count, so the tab never counts a row the page does not draw, an aged-out
  autosave included. It is not a `TaskCard` and not
  a court; `tasks` never holds one.
- **The list is emptied on every identity change** before the new one loads,
  and a load or save that comes back for the previous person is dropped, so a
  shared machine never shows one person's saved tasks under another's name.
- **A row is one button, `.saved-row-open`, inside the `<li>`** (#344). The
  whole row is the press target, dressed as the row rather than as a control:
  no fill at rest, `--row-hover` through the button tokens, and the row lifts
  to `--shadow-md` under the cursor like a task row. A child of the `<li>` and
  not the `<li>` itself so a second control (delete, #345) can sit beside it
  without nesting buttons.
- **Delete is `.saved-row-delete`, beside the reopen button** (#345): the
  checklist's `TrashIcon`, muted at rest and `--bad` only under the cursor, a
  40px square at the row's right end behind a hairline. Pressing it swaps the
  row's contents for `SavedForLaterDeleteConfirm`, an in-place question in the
  shape of the Instructions box's discard: `Delete this saved task?`, then
  `Keep` (ghost, focused on open, so a stray Return keeps it), then `Delete`
  (`btn-danger`). Escape and Keep both decline and hand focus back to the trash
  control. Not a dialog: the row is wide enough for three words and two
  buttons, and a modal over the board for that costs more than it prevents.
  Yes goes through `removeSavedForLaterRequest`, the same helper Create clears
  a filed one with; App drops the row only once the server let it go, and
  toasts and leaves it otherwise. No undo, by ADR-0011. Once a delete lands,
  the page moves focus to the row that took its place (or the new last
  row), so a keyboard user is not dropped onto the page body.
- **Reopening opens the create form, never edit mode** (#344). App fetches the
  latest save of that record (`reopenSavedForLaterRequest`) and mounts the
  create form with `reopened`, keyed on the record's id. The form opens on
  every field of it, with `opening.fresh` still the blank form so Save for
  later is pressable at once. Both endings name the record: Save for later
  passes it to `onSaveForLater`, which PUTs onto it, and Create passes it to
  `onCreate`, which removes it only after `POST /tasks` succeeded. The three
  requests live in
  [src/saved-for-later-requests.ts](../src/saved-for-later-requests.ts),
  framework-free, so what a 404 means for each is driven against a fake server
  in the board sim test.
- **A reopened form has no autosave seat**, the same null storage edit mode
  has. Writing there would make a second copy of a record the server already
  keeps; clearing there would throw away an unrelated new-task form.
- **Its typing goes to the record instead** (#348, ADR-0011 rule 5): a second
  effect beside the autosave's, same trailing debounce idea
  (`UNSAVED_SAVE_DEBOUNCE_MS`, a second, because each one is a request). Its
  decision is `unsavedAction`, not the autosave's `draftAction`: it is taken
  against what the form last sent (`unsavedSent`) rather than what it opened
  on, because a form that sends as it goes can be typed back to where it
  opened with a different copy already on the server. Cancel on a reopened
  form always asks (#365), so every way out goes through Save for later, Create
  or Discard, each of which settles the writes; a failed Save for later or
  Create sends what its stop held back. It writes to the record's `unsaved` slot through `onKeepUnsaved`, never
  over `form`, so `savedAt` and the row's place stay put; a form opens on
  `unsaved` when there is one. The writes
  chain on one promise (`unsavedWrites`), and every ending (Save for later,
  Create, Discard) runs `settleUnsaved` first: it stops further writes and waits
  for the one in flight, so a keystroke's write cannot land after the ending
  and put typing back on a record just saved or cleared. A failed ending lifts
  the stop. App's two callbacks are silent and leave the board's list alone,
  since they fire on every pause in typing.
- **Cancel's prompt has a third answer on a create form** (#348):
  `DiscardConfirmDialog` takes `onSaveForLater`, and draws `Keep editing`
  (focused, as before), `Save for later` (ghost, disabled exactly when the
  footer's is) and `Discard` (danger) in that order, under `Leave this task?`.
  `saveFromPrompt` lowers the prompt and runs the footer's own `saveForLater`,
  so a failed save leaves the form in view. Edit mode passes no
  `onSaveForLater` and gets the two-way `Discard this task?` word for word.
- **Discard on a reopened Task Draft deletes it** (#388, amending #348 and
  ADR-0011). The prompt's body says so, and since #399 that prompt is the
  confirmation: there is no second question. Discard shuts the prompt's
  answers (`busy`), runs `settleUnsaved`, then App's `onDeleteReopened`, which
  is `removeSavedForLaterRequest` (the row's and Create's removal, a 404
  counting as gone) and drops the row from `savedForLater` under the row's
  owner check. While it is out the prompt stays up and Discard reads
  `Deleting…` (`discardConfirmCopy`'s `busy`), so a slow delete is not a dead
  button. A delete that did not land toasts a warning and the form closes
  anyway. A new task's Discard is unchanged. `onDiscardUnsaved` stays for the
  one thing still using it, a form typed back to exactly its save. There is no
  longer a way back to a draft's last save.

**Share / Assign is one connected control with its own class names** (#364).
`.form-direct-mode` is a hollow track holding two `.form-direct-mode-choice`
halves, and the chosen one takes `.form-direct-mode-on`: the app menu's choice
fill (`--brand` under `--on-accent`), so it is a solid half against an empty
one in every theme and never a hue alone. Under forced colours, which repaints
every fill, the chosen half takes the system's `Highlight` pair instead, and a
`:focus-visible` rule puts a `--panel` line between its fill and the ring,
which was the fill's own colour in contrast. It used to borrow the board's
generic `.seg` classes, and #326 deleted those rules with the Grouped/Flat
segment, which left two plain filled buttons and no selected state.
`scripts/share-assign-selector-sim-test.mjs` renders both modes and fails if
the selector emits a class with no rule in `styles.css`, if the pressed half
stops being the one `pickerMode` names, or if a rule on it covers the focus
ring.

**The Humperdink import is LOI-only** (2026-09-04). `Send to Hot Task` over in
Humperdink copies a term sheet, and an LOI Check is the only type whose request
field is one.

**There is no paste box** (2026-09-14, the user's call). It sat in the footer
beside Create Task and read as one more field to fill, and the arrival's
clipboard fill below is meant to make it unnecessary. The paste is still the
import (#409), just without a box: `onPaste` on the `<form>` itself, on an LOI
Check being filed, takes the text off the event's `clipboardData` (the human's
paste, not a clipboard read) and hands it to `importFromHumperdink`. It answers
true, and the browser's own insert is cancelled, for anything carrying the
export's own marker (the parser's `ours`): a payload the parser accepted
imports, and one it refused (a newer script, a missing name or link) toasts the
parser's reason instead of dropping raw JSON into Notes. Text without the marker
pastes where it was pasted, with no toast, because every paste on the form
passes through here and a stray paste into Notes is not an error. A paste only
reaches the form from a field inside it, so ⌘V with no field selected takes
nothing; on an arrival, focus already sits in the request field. A good import says `Imported from Humperdink.` through an sr-only
`role="status"` line in the footer, mounted while an LOI Check is being filed.

**A Humperdink arrival link opens it** (#412). A Teams deep link whose
`subEntityId` is the shared sentinel `new:humperdink` opens the create form as
a new LOI Check with focus in the request field (`humperdinkArrival` on
`TaskForm`), so ⌘V lands inside the form and imports straight away. App reads the link through shared `readTeamsArrival`,
so the sentinel never becomes a task to focus or claim. It never opens on the
autosave, and never overwrites it (#413, ADR-0011 rule 5). Before the form
opens, App moves an autosave worth keeping to Task Drafts through Save for
later's own write (`moveAutosaveAside` in
[src/humperdink-arrival.ts](../src/humperdink-arrival.ts)), and loads the drafts
only after the move, so no earlier load can land on top of it. If the move
doesn't land, the form opens with `leaveAutosaveAlone`: no seat on either copy
of the autosave, the way a reopened form has none, and its Save for later
doesn't clear the slot. Silent both ways. The userscript's Export to HT sends
the link after its copy lands (#414), so this is the form a Humperdink press
lands on.

**And it fills itself where Teams can read the clipboard** (#415,
[ADR-0012](../../../docs/adr/0012-a-humperdink-arrival-may-read-the-clipboard.md)).
App hands the arrival's form, and only that form, `readClipboard`
(`readArrivalClipboard` in [src/humperdink-arrival.ts](../src/humperdink-arrival.ts)
over teams-js `clipboard`): `isSupported()`, then `read()`, then the
`text/plain` blob, handed back only if it parses as a payload. The form calls it
once at open and runs `importFromHumperdink` on the result, once App's
`loansLoaded` is true and only while the form is untouched
(`arrivalPasteStep`). So a good read looks exactly like a good paste: fields
filled. Anything else (no support, a refused read, not a payload) draws nothing
and toasts nothing, and focus waits in the request field for ⌘V. This is the app's only clipboard read. No other
opening of the form is handed a reader, and nothing in `apps/web` calls the
browser's clipboard read.

**The locked type's popover** (`.task-form-type-note`) is revealed by hover,
`:focus-visible` and a click, and three things keep it honest:

- **Always in the DOM.** The chip's `aria-describedby` has to resolve at all
  times; an explanation only a pointer can reach is not one.
- **Hidden by `visibility`, never `display: none`**, which would take it out of
  the accessibility tree along with the layout — the same reasoning as
  `.sr-only`.
- **Out of flow** (`position: absolute`), so revealing it moves nothing.

The chip is a real `<button>`: hover is no affordance on a touch screen, and it
sits where a control sits, so people press it and the press has to land
somewhere. Being a button, it takes its fill through `--btn-bg` like every other
button here, with the same value on both tokens — pressing it changes nothing
about the task, so it gets no pressed-looking affordance. It swallows Escape
while the popover is open; unstopped, Escape reaches the overlay's handler and
closes the whole form, taking the draft with it.

**Every control in the top row is told to fill its column**, and to be allowed
to shrink below its natural width. Both halves matter and neither is the
default: a `<select>`'s natural width is its *longest option* (which is what put
the type box under the Urgency label), and a field that under-fills leaves the
shortfall against one gap, so four equal 14px gaps read as four different ones.
The poop tray is the deliberate exception — content-sized, with its column
sized to it.

The footer's negative margins are tied to `.form-panel`'s padding and are
restated in the 480px block where that padding tightens. That is the price of a
full-bleed footer inside a padded panel; change one and change the other.

Edit mode differs in eight ways and no others:

- it opens preloaded from the task (`editFormValues` in
  [src/create-form-state.ts](../src/create-form-state.ts)),
- the person picker, the Humperdink import and the outstanding-items seeder
  are gone — all three only mean something at filing time,
- the two timing controls stay exclusive: an `OOO` task draws its start and
  return dates and **no** urgency (the server refuses an urgency on it
  outright), every other type draws its urgency and no dates. The due date is
  the input that never appears anywhere — it is derived, from the band or from
  the return date,
- urgency and the poop picker are drawn **only for the person who filed the
  task** (`creatorOnlyFields`) — see above; everyone else who may edit is a
  checker correcting terms, and neither control is theirs to move,
- the task type is a **padlocked chip** (`.task-form-type-locked`) where the
  select sits while filing, and the reason it can't change is a **popover on the
  chip** (`.task-form-type-note`), not a line under the row. Shown rather than
  hidden: a form that dropped the type would read as one that lost track of what
  it is editing. A chip rather than a disabled `<select>`: a select that won't
  open still invites the click and still wears the clothes of the three live
  controls beside it in that row. The popover rather than a permanent line: it
  answers a question nobody has until they reach for the control, and a line
  spends a row of the form telling everybody who never did. Three things make
  that a reveal and not a hiding place — see below,
- the folder name loses its typeahead — see below,
- the request field goes tall (`.task-form-terms`), and on an **LOI** also
  takes the mono face (`.task-form-terms-mono`). That is the one place the
  "mono is for non-prose" rule bends, and it bends for the reason the rule
  exists: the box is holding a pasted term sheet, and its columns only line up
  in a fixed-width font. Every other type's field is prose and keeps the body
  face; filing keeps its two-row box either way,
- the submit button reads `Save` / `Saving…`.

**The folder name and the link write the shared loan record** (#262, ADR-0008
rule 7), not the task, so correcting either fixes it on every task for that
loan, finished ones included. Three consequences the markup carries:

- **No typeahead in edit mode.** The create form's combobox picks an *existing*
  loan to file a new task against; on a filed task, typing renames the loan it
  is already on, and a suggestion list offering a different one is repointing
  the task wearing a rename's clothes. Edit mode gets a plain text box.
- **One muted line in the footer** (`.task-form-shared-loan`), not one per
  field, appearing only once a value has actually moved — `touchesSharedLoan` in
  `create-form-state.ts` is the only thing that reveals it. It sits in
  `.task-form-foot` rather than under either box: the folder name heads the form
  and the link sits below the request field, so the only place genuinely under
  both of them is the bottom of the panel. (Before the redesign the two fields
  were pulled together into a `.task-form-loan` pair so the line could sit under
  them; that block is gone.) Never on focus: clicking a field to read it warns
  about nothing. Never a dialog, banner or toast; it is prose in the same muted
  register as `.task-form-locked`, because nothing has gone wrong. Two nodes for
  one sentence, the sr-only live region idiom used by the sole-checker warning.
- **Never on an out-of-office task.** It has no loan: its folder name is a
  vacation description that saves on the task, it has no link field, and there
  is no shared record to warn about.

### Only the two parties get the loan pair (#266)

ADR-0008 rule 5 narrows a loan edit to the task's creator or current assignee,
at a non-closed status. The form is handed the server's own refusal sentence as
`edit.loanRefusal` — resolved in `App.tsx` from shared `loanEditRefusal`, the
same function the route runs — and when it is present both boxes render
`readOnly` with the sentence in the footer (`.task-form-loan-locked`,
`.task-form-locked`'s muted register without its tuck-up margin). It takes the
shared-record line's slot, because both are one sentence about both boxes and
they are mutually exclusive by construction; a slot that could hold both would
be a design that let them collide.

- **Read-only, not hidden and not merely un-submittable.** They are the loan's
  name and link on the task being edited, so a form that dropped them would read
  as one that lost them; a box that takes typing and then refuses it is the
  version people file bugs about. `.task-form input[readonly]` takes the same
  recessed fill as the locked type chip, so the state reads off the control and
  not only off the sentence in the footer.
- **One `aria-describedby` id for both**, exactly like the muted line it stands
  in for: it is one sentence about both boxes.
- **The shared-record line is unreachable while locked** — `sharedLoanWarning`
  is `&& !loanLocked`. Read-only boxes cannot move, so it would be false anyway;
  the explicit term is there so the two can never both appear.
- **Never on OOO.** Its "folder name" is a vacation description on the task,
  governed by the creator-only amend rule, not this one.
- **`Edit Task` itself is not gated by this.** The entry belongs to another
  ticket's rule; what this shuts is the two loan fields inside the form.

`LoanFilterHeader` used to be the app's other loan-editing surface. It was first
made read-only — it sits outside any task, so it has no two parties to check,
and the ability went rather than the rule being softened for it — and has since
been **removed entirely**, along with the per-row loan filter that was its only
entry point. `onSaveLoan` went with the first step, leaving `patchLoan` with a
single caller (`saveLoanFields`). Every body through `patchLoan` carries its `taskId`,
which is what makes the confirmed merge re-send take the same check as the save
that asked — a refusal must never be reachable only after a dialog.

### The merge confirmation (#265)

A link edit that lands on another loan's link would fold the two records
together, and that question gets a real dialog —
[src/loan-merge-confirm.tsx](../src/loan-merge-confirm.tsx),
`.merge-confirm-overlay` at z-index 70, above the form modal's 50 and a toast's
60. It was the app's only dialog until #283 added the discard prompt, which is
built to match it — same overlay and panel rules (one CSS block under both
names), same `alertdialog`, same inert backdrop, same Escape-declines, same
focus on the safe answer. Two dialogs that behave differently are two dialogs
people have to read twice; a third joins that list rather than forking it.

Neither contradicts the muted shared-record line above the loan fields: that
line reports a consequence of something that is going fine, these ask a
question, and a toast cannot ask a question (ADR-0008 rule 7).

- **It names the other loan**, in the title and in the body, so the person is
  making a decision rather than clearing a dialog. `mergeConfirmCopy` is a pure
  function so the wording is asserted directly.
- **It says which of the two survives**, and does not assume. The merge keeps the
  OLDER record, which on the commonest version of this — correcting a URL on a
  record filed last week so it points at a long-running loan — is the *other*
  loan, and the one being edited is the one that disappears. The 409 carries
  `survivingName` / `absorbedName` from the code that decides it, because a
  dialog guessing here tells half the people who read it the exact opposite of
  what will happen.
- **`role="alertdialog"`, inert backdrop, Escape declines**, and focus lands on
  `Keep them separate` — the destructive answer is never one stray Return away.
  The buttons are answers (`Merge the loans` / `Keep them separate`), not OK and
  Cancel.
- **Two-step round trip, not an optimistic merge.** The first save posts as it
  always did and the server refuses with a 409 naming the collision, having
  written nothing; only a yes re-sends the identical body with `confirmMerge`.
  `patchLoan` in `App.tsx` is that whole dance, and it is the single path every
  loan save goes through, so there is one confirmation rather than one per
  surface. It served two surfaces when it was built; #266 took the loan-filter
  header's edit away and left it with one, and the door stays a door.
- **A decline is not an error.** It rejects with `MergeDeclined`, which nobody
  toasts: nothing was sent, and the rejection exists only to leave the form open
  with the typing in it. What *did* happen still gets said — a merge that ran
  shows the existing transient "Merged with …" notice (ADR-0001 addendum
  2026-07-31), fired inside `patchLoan` rather than by each caller, so the notice
  belongs to the step that merged and a third editing surface inherits it.
- **A link another record already holds is asked about on any save** (#383).
  When shared `sharedLinkOf` says the task's loan shares its link with another
  loan record, `saveTaskEdit` sends that link with whatever else moved, so the
  same dialog comes up with its `linkUntouched` wording: the link is also on the
  other loan, rather than "saving it here combines". Here a No is not a No to the
  save. `saveTaskEdit` catches that decline, re-sends a rename without the link
  if there is one, saves the task's fields and resolves, so the form closes with
  no toast. A link the person changed keeps the rule above. Nothing is sent when
  the loan fields are locked (`loanRefusal`), on OOO, or on an empty edit.

**A Save sends only what moved.** `taskEdit` diffs the task against the form
and returns the changed fields; App turns that into one call per field, on the
existing focused route for each. There is no endpoint that takes a
task-shaped body and this form must never grow one. A save that changed
nothing makes no request at all, so it writes no history and DMs nobody.

The module lives outside `App.tsx` for the same reason `thread.tsx` does: the
ticket's promises are about rendered output, `App.tsx` can't be imported into
a node script, and `scripts/edit-task-form-sim-test.mjs` renders the form and
reads the markup back. `CheckIcon` / `TrashIcon` moved to
[src/icons.tsx](../src/icons.tsx) so the card and the form can both draw them.

**Urgency and poop points are on the form** (#261), preloaded from the task —
a select sitting on GREEN while the task is RED is a control that lies. No
due-date input appears: changing the urgency re-derives `dueAt` server-side from
the moment of the edit, the same computation filing uses. Since #335 the
form is the only place the poops change — every rating the card draws is
read-only (see *Poop* in [task-card.md](task-card.md)). Both are
drawn for the filer alone (`creatorOnlyFields`) — urgency stays the creator's,
because an assignee who can extend their own deadline is not accepting a deal
(ADR-0008 rule 5), and the poops say what the creator thinks the ask is worth.

**An `OOO` task's start and return dates are on the form too** (#264, ADR-0008
rule 8), preloaded, and this is the one control that renders in *both* modes.
**Neither input floors itself at today** — any date is accepted, including one
already gone, because somebody back early correcting the record is the case this
exists for. The only `min` on the form is the return date's, set to the start
date, which is the range rule and not a calendar floor. `taskEdit` sends both
dates as one `dates` member on one route: they are a range, and the rule about
them can't be asked of half of it.
