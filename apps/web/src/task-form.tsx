/* ── The task form ────────────────────────────────────────────
   One form, two modes. Filing a new task, and — since #260, ADR-0008 rule 4 —
   correcting one that already exists.

   Extracted from App (issue #72) so that typing in any field only re-renders
   this subtree; App (and the whole task list it renders) no longer re-renders
   on every keystroke. Lifted out of App.tsx into its own module by #260, for
   the reason `thread.tsx` and `timeline.tsx` were: the ticket's promises are
   about what a person sees in this form, and a component inside a 5,000-line
   file that imports the Teams SDK cannot be rendered in a test.

   All form-input state lives here; App keeps only "is it open" and "which task
   is being edited", and mounts this child while one of those is true. The side
   effects stay on App behind the single stable `onCreate` / `edit.onSave`
   callbacks, so this component stays presentational — it builds the payload
   and closes on success.

   Edit mode is deliberately the same form rather than a second one. Two
   surfaces that file and correct the same fields are two surfaces that drift.
   What it changes: it opens preloaded, it hides the two controls that only
   mean something at filing time (the person picker and the outstanding-items
   seeder), it shows the task type disabled with the reason, and it saves.

   Since #262 it also carries the folder name and the Humperdink link, drawn as
   a pair under one muted line, because those two write the shared Loan record
   rather than this task (ADR-0008 rule 7). The folder name loses its typeahead
   in edit mode — picking a different existing loan is repointing the task, not
   correcting it. */
import { ACTION_LABELS, CreateTaskInput, Loan, LoanTask, TASK_TYPE_LABELS, TaskType, URGENCY_LEVELS, URGENCY_TIMEFRAMES, UrgencyLevel, UserIdentity, UserRole, deriveMyLoanIds, eligibleAssignees, getNotesFieldLabel, humperdinkNoteText, loanTypeaheadSuggestions, nextHighlightIndex, parseHumperdinkPayload } from "@loan-tasks/shared";
import { FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { DRAFT_SAVE_DEBOUNCE_MS, browserDraftStorage, clearDraft, draftAction, readDraft, restoredDraftCopy, writeDraft } from "./create-form-draft";
import { CreateFormInitialValues, CreateFormValues, EditableTask, TaskEdit, applyImportedLoan, createLoanId, editFormValues, editRefusal, formHasChanges, initialCreateForm, taskEdit, touchesSharedLoan } from "./create-form-state";
import { DiscardConfirmDialog } from "./discard-confirm";
import { InfoIcon, LockIcon, TrashIcon } from "./icons";
import { useToast } from "./toast";

/* Someone the app could point a task at. Roles ride along because the handoff
   picker narrows to who could actually work the task. Lives here because the
   form is the surface that reads the whole directory; App imports it back for
   its own share/assign popovers. */
export type DirectoryUser = { id: string; displayName: string; roles: UserRole[] };

/* The one urgency control in the app. A second way to express timing is how
   two surfaces drift apart, and this one offers no date at all: `dueAt` is
   derived from the band server-side (docs/product/due-date-urgency.md). The
   order is the shared `URGENCY_LEVELS`, least-to-most urgent, and the copy is
   the shared `URGENCY_TIMEFRAMES` — a local copy of those four strings is
   exactly the duplication the guardrails are about. */
const UrgencySelect = ({
  value,
  onChange
}: {
  value: UrgencyLevel;
  onChange: (urgency: UrgencyLevel) => void;
}) => (
  <select value={value} onChange={(e) => onChange(e.target.value as UrgencyLevel)}>
    {URGENCY_LEVELS.map((level) => (
      <option key={level} value={level}>{URGENCY_TIMEFRAMES[level]}</option>
    ))}
  </select>
);

/* Edit mode's two halves: the task the form opens on, and where a Save goes.

   `onSave` is only ever called with fields that actually moved, and is never
   called at all when nothing did — the no-op is decided here rather than left
   to the server, so an unchanged save is not even a request. Which route each
   field goes to is App's business; there is deliberately no catch-all update
   endpoint for this to post a whole task at (ADR-0008 rule 4). */
export interface TaskFormEdit {
  task: EditableTask;
  onSave: (edit: TaskEdit) => Promise<void>;
  /* Why this viewer may not touch the folder name or the Humperdink link, or
     absent when they may (#266, ADR-0008 rule 5). The sentence is the server's
     own — `loanEditRefusal` in `@loan-tasks/shared` — resolved by App, which is
     the half of the app holding the whole task and the signed-in user. Passed in
     rather than asked here so `EditableTask` stays the four fields this form
     actually draws.

     Present means the two boxes render read-only with the reason beneath them.
     Not hidden: they are the loan's name and link on the task being edited, and
     a form that dropped them would read as one that had lost them. Not merely
     un-submittable either — a control that takes typing and then refuses it is
     the version people file bugs about. */
  loanRefusal?: string;
}

interface TaskFormProps {
  loans: Loan[];
  directory: DirectoryUser[];
  user: UserIdentity;
  tasks: LoanTask[];
  onClose: () => void;
  /* Persist the task, then fire the optional post-create share (#46) with its
     delivered/couldn't-reach toast, and refresh. Resolves once the task is
     created; rejects only when the create itself fails (App has already shown
     the error toast) so the form stays open for a retry. */
  onCreate: (payload: CreateTaskInput, shareWithUserId: string, note?: string) => Promise<void>;
  /* Values the form opens with (#194). Omitted — the everyday case — opens it
     blank, exactly as before. The defaults and the FRAUD seeder / recipient
     picker / OOO date fields all live in `create-form-state.ts`; see there for
     why only this subset is openable. Ignored in edit mode, which takes its
     values from the task. */
  initialValues?: CreateFormInitialValues;
  /* Present → edit mode (#260). Absent → the create form, unchanged. */
  edit?: TaskFormEdit;
}

export const TaskForm = ({ loans, directory, user, tasks, onClose, onCreate, initialValues, edit }: TaskFormProps) => {
  const { showToast } = useToast();
  const editing = edit !== undefined;
  /* The two required boxes, so a save can hang its refusal on the field the
     browser would hang "please fill out this field" on. The folder name joined
     them in edit mode with #262; in create mode nothing refuses a create, so the
     ref carries no refusal — it is on the typeahead's input as well since #285,
     which needs somewhere inside the form to put focus after Start fresh takes
     away the button that was clicked. */
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const folderNameRef = useRef<HTMLInputElement>(null);
  /* Where this form's saved draft lives (#284), decided once at open and never
     re-read. Two things are pinned here rather than looked up as needed:

     The storage object, because a locked-down Teams profile can throw on the
     `window.localStorage` property itself; `browserDraftStorage` turns that into
     `null`, which every draft function takes as "do nothing, quietly".

     The person, because the mock user picker can switch who is signed in while
     this form is open. Keying off the live `user.id` would then save what is on
     screen — which is the first person's typing — under the second person's
     name, the one thing the per-user key exists to prevent. The draft belongs to
     whoever opened the form; the other person's own draft is read when they open
     it themselves, on the next mount.

     Null storage in edit mode is the whole of "edit mode saves no draft": there
     is nothing to switch off further down, because there is nowhere to write. */
  const [draftSeat] = useState<{ storage: ReturnType<typeof browserDraftStorage>; userId: string }>(() => ({
    storage: edit ? null : browserDraftStorage(),
    userId: user.id
  }));
  /* What the form opens with, worked out once. Lazy, so re-renders don't rebuild
     it and a changing `initialValues` identity can't reset a half-typed form:
     the values seed the form once, at open. Reopening remounts this component,
     which is when new initial values — or a newly saved draft — take effect.

     Three ways in. Edit mode takes the task's own values. A create form with a
     saved draft takes the draft (#284). Anything else opens as it always has.

     `fresh` is what a blank-slate open would have produced, kept because it is
     the yardstick for "is there a draft worth keeping" — measuring against
     `openedWith` instead would call a restored draft unchanged and quietly stop
     saving it. Note it is NOT the yardstick for the discard prompt, which asks
     whether anything moved since the form opened (#283).

     A form opened with `initialValues` deliberately ignores any draft: those
     values come from someone asking for a task about a specific loan, and
     answering that with last Tuesday's half-written task about a different one
     would be the wrong form entirely. Their draft is left where it is. */
  const [opening] = useState<{ values: CreateFormValues; fresh: CreateFormValues; fromDraft: boolean }>(() => {
    if (edit) {
      const values = editFormValues(edit.task);
      return { values, fresh: values, fromDraft: false };
    }
    const fresh = initialCreateForm(initialValues);
    const restored = initialValues ? null : readDraft(draftSeat.storage, draftSeat.userId);
    return { values: restored ?? fresh, fresh, fromDraft: restored !== null };
  });
  const [form, setForm] = useState<CreateFormValues>(opening.values);
  /* The form exactly as it opened, kept so closing it can ask whether anything
     has been done to it since (#283). A ref rather than state because it never
     changes while the form is up: the same object the lazy initializer above
     produced, captured on the first render and read on the way out. */
  const openedWith = useRef(form);
  /* Does this person have a saved draft on disk, as far as this form knows
     (#284)? True at open when the form was restored from one, and kept honest by
     the effect below. It is what stops an untouched form clearing a draft it
     never wrote — and what makes emptying a restored form back out clear the
     copy behind it rather than leave the old values waiting to reappear. */
  const draftStored = useRef(opening.fromDraft);
  /* Is the "we brought this back" line up (#285)? True for a form that opened on
     a restored draft, and false again once Start fresh has emptied it — the line
     describes where the values on screen came from, and after Start fresh they
     came from nowhere.

     Keyed to how the form OPENED, never to what is in it now: the line stays put
     while somebody edits the restored values, because it is where Start fresh
     lives and the person most likely to want that button is a few seconds in,
     having just realised this is not the task they meant to file. */
  const [restoredNote, setRestoredNote] = useState(opening.fromDraft);
  /* Is the "discard this task?" prompt up (#283)? Set by an exit taken on a
     form that has something in it; see `requestClose` below. */
  const [discardAsk, setDiscardAsk] = useState(false);
  /* Draft text for the FRAUD outstanding-items seeder input (#69), separate
     from the committed `form.initialItems` list. */
  const [seedDraft, setSeedDraft] = useState("");
  /* Create-form loan typeahead: which suggestion list is open + which loan
     (if any) the typed Folder Name resolved to. */
  const [loanSuggestOpen, setLoanSuggestOpen] = useState(false);
  /* The text the user actually typed into Folder Name (issue #55). Kept
     separate from `form.folderName` so keyboard arrow-autofill can preview a
     highlighted loan's name in the field without reshuffling the match list. */
  const [loanQuery, setLoanQuery] = useState("");
  /* Highlighted suggestion index for keyboard nav, or -1 for none (#55). */
  const [loanHighlight, setLoanHighlight] = useState(-1);
  const [namvarHover, setNamvarHover] = useState<number | null>(null);
  /* In-flight guard for Create (#115). Not a debounce — the reported double
     submit came from a deliberate second click after a pause, so the flag is
     held for the WHOLE operation (create + the post-create share `onCreate`
     also awaits) and released only when it settles. It doubles as the button's
     pending state, which is half the fix: the reporter's read was "the button
     didn't register my click," and a disabled `Creating…` corrects that. Edit
     mode's Save rides the same flag for the same reason. */
  const [submitting, setSubmitting] = useState(false);
  /* Humperdink import (#194). `importText` is the paste target — the human
     presses paste, the app never reads the clipboard itself. `imported` is the
     button's own confirmation, cleared the moment the text changes so the label
     can't claim a paste it hasn't taken. */
  const [importText, setImportText] = useState("");
  const [imported, setImported] = useState(false);
  /* The note text the last import wrote (#196), so a second import replaces its
     own block rather than stacking a second copy of the terms under the first.
     Whatever the filer typed around it is theirs and survives either way. */
  const [importedNote, setImportedNote] = useState("");
  /* Ties the locked type chip to the sentence explaining why it's locked.
     Described-by rather than inside the <label>, so the reason is announced
     after the field's name instead of becoming part of it. */
  const typeLockedId = useId();
  /* Whether that sentence is showing. It is a popover on the chip rather than a
     line under the row: it answers a question nobody has until they reach for
     the control, and a permanent line spends a row of the form saying so to
     everybody who never did. Hover reveals it too, in CSS — this flag is the
     click and keyboard path, which is the one a touch screen has. */
  const [typeNoteOpen, setTypeNoteOpen] = useState(false);
  /* The same trick for the loan pair's refusal (#266). One id for both boxes:
     it is one sentence about both of them, exactly like the muted shared-record
     line it stands in for. */
  const loanLockedId = useId();

  /* The loan's two fields are locked shut for anyone who isn't a party to this
     task (#266, ADR-0008 rule 5). Never on OOO: its "folder name" is a vacation
     description that lives on the task itself and is governed by the
     creator-only amend rule, not by this one, so a loan refusal must not reach
     it.

     Declared up here rather than beside the fields it locks, because the SAVE
     reads it too — the boxes shutting and the pair being dropped from what a
     Save sends are two halves of one rule, and a lock the submit path could not
     see would be a lock with a way round it. */
  const loanLocked = editing && form.taskType !== "OOO" && edit?.loanRefusal !== undefined;
  /* Urgency and poop points are permanently the creator's (ADR-0008 rule 5), so
     edit mode draws them only for the creator: a checker correcting an LOI's
     terms is never shown a control the server would refuse them (#261, #263).
     Filing is always your own task, so the create form always shows both. */
  const creatorOnlyFields = !editing || edit?.task.createdBy?.id === user.id;

  /* What a locked box shows. The lock is recomputed live from the task, so it
     can close over a half-typed draft — a handoff mid-edit is the case — and a
     read-only box displaying somebody's abandoned typing states it as if it
     were the loan's name. Falling back to the task's own values means the pair
     always reads as what the loan currently says, which is the only thing a
     locked-out viewer should be able to learn from them. */
  const lockedFolderName = edit?.task.folderName ?? "";
  const lockedLink = edit?.task.humperdinkLink ?? "";

  /* Take a pasted Humperdink payload into the form, or say why it can't.
     A failure leaves every field exactly as it was: the parser returns a reason
     rather than a null so the filer, who has no console open, gets told. */
  const importFromHumperdink = (): void => {
    const result = parseHumperdinkPayload(importText);
    if (!result.ok) {
      setImported(false);
      showToast(result.error, { variant: "error" });
      return;
    }
    const noteText = humperdinkNoteText(result.payload);
    setForm((c) => applyImportedLoan(c, result.payload, { noteText, previousNoteText: importedNote }));
    setImportedNote(noteText);
    // Keep the typeahead in step with the name the import just wrote, and shut
    // it — the loan is settled, so a suggestion list over it is only noise.
    setLoanQuery(result.payload.loanName);
    setLoanSuggestOpen(false);
    setLoanHighlight(-1);
    setImported(true);
  };

  /* Loans that are "mine" for the create-form shortlist (#55): any loan linked
     by a task the current user created (merged loans share one id, so they
     count automatically). Drives the empty-query, open-on-focus view. Kept
     local so it only recomputes on this form's renders, not App's. */
  const myLoanIds = useMemo(() => deriveMyLoanIds(tasks, user.id), [tasks, user.id]);

  /* Current typeahead suggestions: empty query → my most-recently-used loans;
     typing → all users' loans ranked by match (#55). Excludes an option that
     exactly equals what's already typed. */
  const loanMatches = useMemo(
    () =>
      loanTypeaheadSuggestions(loanQuery, loans, myLoanIds, 6).filter(
        (m) => m.loan.name.trim().toLowerCase() !== loanQuery.trim().toLowerCase()
      ),
    [loanQuery, loans, myLoanIds]
  );

  /* Commit a loan pick from the typeahead (mouse click or keyboard Enter):
     link the task to the existing loan and confirm with a transient toast
     (#56) instead of an inline hint that reflowed the form. */
  const selectLoan = (loan: Loan): void => {
    setForm((c) => ({
      ...c,
      folderName: loan.name,
      loanId: loan.id,
      humperdinkLink: loan.humperdinkLink ?? c.humperdinkLink
    }));
    setLoanQuery(loan.name);
    setLoanSuggestOpen(false);
    setLoanHighlight(-1);
    showToast("Linked to an existing loan", { variant: "success" });
  };

  /* Everyone who could work this task if it existed — the shared predicate, so
     the form, the row and the server all agree on who that is. Excludes the
     filer themselves: a task born assigned to its own creator is the fourth
     door ADR-0003 shuts. */
  const eligible = useMemo(
    () => eligibleAssignees({ taskType: form.taskType, createdBy: { id: user.id, displayName: user.displayName } }, directory),
    [directory, form.taskType, user.id, user.displayName]
  );

  /* Who the one at-creation picker offers, per mode. Assign offers only people
     who could actually take it; Share excludes just you, since you already know
     about your own task. */
  const recipientCandidates = useMemo(
    () => (form.pickerMode === "assign" ? eligible : directory.filter((u) => u.id !== user.id)),
    [directory, eligible, form.pickerMode, user.id]
  );

  /* The sole-checker dead end (#142). If the only file checker available is the
     person filing, nobody can claim this Fraud Check — the creator is barred
     from their own task at every door, with no admin override and no escape
     hatch, because an escape hatch is indistinguishable from letting one person
     file and check their own review. So the form says so up front and the filer
     redirects it, instead of the task sitting unclaimable with no error that
     helps. It informs; it never blocks submit. `directory.length > 0` keeps a
     not-yet-loaded directory from crying wolf. Filing-time only: on a task that
     already exists the dead end has either happened or it hasn't, and the
     warning would be advice about a decision nobody is making. */
  const noEligibleChecker = !editing && form.taskType === "FRAUD" && directory.length > 0 && eligible.length === 0;
  /* Two ways to reach that dead end, and they aren't the same sentence. If the
     filer holds FILE_CHECKER, the only checker around is them and the rule
     that bites is second-pair-of-hands. If they don't, there simply is no
     checker to hand it to. */
  const noCheckerWarning = user.roles.includes("FILE_CHECKER")
    ? "You're the only file checker available, and nobody can work a Fraud Check they filed themselves — so no one will be able to claim this one. Someone else needs to file it."
    : "No file checker is available to work this Fraud Check, so nobody will be able to claim it. Worth checking who's on shift before you file.";

  /* Switching to Assign, or to a Fraud Check, can make the current pick
     ineligible. Drop it rather than leave a selection showing that the server
     would reject at submit.

     A directory that hasn't arrived yet is not an answer about eligibility, and
     since #284 the form can open with somebody already picked — a restored draft
     carries the person it was going to. Without this guard, a form opened in the
     moment before the directory lands would quietly drop that person and the
     note written to them, which is the opposite of what a restored draft
     promises. Same `directory.length` reasoning as the no-checker warning
     below, for the same reason: don't decide anything on a list that isn't
     loaded. */
  useEffect(() => {
    if (directory.length === 0) return;
    if (form.recipientUserId && !recipientCandidates.some((c) => c.id === form.recipientUserId)) {
      setForm((c) => ({ ...c, recipientUserId: "" }));
    }
  }, [directory.length, recipientCandidates, form.recipientUserId]);

  /* ── Keeping the draft (#284) ───────────────────────────────
     The form saves itself as it is typed into, settling shortly after the
     typing stops. Not on unmount and not on `beforeunload`: the case this
     exists for is the tab that goes away without running anything, so a save
     that depends on an exit path is a save that isn't there when it matters.

     One timer per change, cancelled by the next one, which makes this a plain
     trailing debounce — a sentence costs one write rather than forty. The
     cleanup also runs on unmount, so a create or a discard that clears the
     draft can never be overwritten a moment later by a keystroke's leftover
     timer.

     Write, keep or clear is `draftAction`, decided over there rather than in
     here so the rule — including "opening a draft does not restart its seven
     days" and "an untouched form never clears one" — can be asked as a truth
     table instead of by rendering a form and waiting. The two questions it
     takes are both `formHasChanges` (#283), from two yardsticks: against a
     blank-slate open, which is what makes a changed task type on its own worth
     saving, and against the values this form opened with.

     Storage that is missing, locked down or full is handled inside the write
     and clear themselves, silently — nothing here can throw at a person
     mid-sentence, and the write reports back whether it actually landed. */
  useEffect(() => {
    if (editing) return;
    const timer = window.setTimeout(() => {
      const action = draftAction({
        changedFromBlank: formHasChanges(opening.fresh, form),
        movedSinceOpen: formHasChanges(openedWith.current, form),
        onDisk: draftStored.current
      });
      if (action === "write") {
        draftStored.current = writeDraft(draftSeat.storage, draftSeat.userId, form);
      } else if (action === "clear") {
        clearDraft(draftSeat.storage, draftSeat.userId);
        draftStored.current = false;
      }
    }, DRAFT_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [form, editing, opening.fresh, draftSeat]);

  /* The draft is done with. Both endings a person can mean by it — the task got
     filed, or they confirmed the discard prompt — go through here, so neither
     can grow its own idea of what forgetting a draft involves. */
  const forgetDraft = (): void => {
    clearDraft(draftSeat.storage, draftSeat.userId);
    draftStored.current = false;
  };

  /* "Start fresh" (#285): the restored draft was not what they wanted, so the
     form becomes the one they expected to open — empty, with nothing saved
     behind it.

     No confirmation, deliberately. The button only exists on a form somebody did
     not ask for, pressing it is the whole of the intent, and a misfire costs
     nothing that is not one keystroke from being saved again.

     `opening.fresh` rather than `BLANK_CREATE_FORM` because it is already the
     form's own idea of a blank-slate open, and it is the yardstick the draft
     effect measures against. Copied rather than aliased so the state object and
     the yardstick can never become the same object.

     `openedWith` moves with it, and that is the subtle half. It is what Cancel
     and the save timer measure "has anything happened here" against; left
     pointing at the restored values, an emptied form would read as heavily
     changed — Cancel would ask to discard a form with nothing in it, and the
     timer would immediately save the blank over the draft that was just deleted.
     Re-pointed at the blank, both questions answer "nothing to lose", and the
     next keystroke starts a new draft exactly as it would on any other new form.

     The typeahead's own three pieces of state go too: they are the folder name
     box's uncommitted half, and a suggestion list left open over an emptied
     field is the old loan still on screen. */
  /* Read once, so the line and the button on it can never come from two
     different readings of the same wording. */
  const restoredCopy = restoredDraftCopy();

  const startFresh = (): void => {
    /* Focus lands on the first field, and it is moved FIRST for a reason worth
       stating. The button unmounts itself — the line it sits on has nothing left
       to say once the form is empty — and focus would otherwise fall to the
       document body, outside the dialog: Escape is handled on the overlay and
       only sees keys bubbling from inside it, so a keyboard user would be left
       in an open form with no way out and nothing said about what happened. The
       folder name box is where a new task starts anyway.

       Before the clears below, not after, because the box's own `onFocus` seeds
       the typeahead query from the value it can see — which at this instant is
       still the restored loan. Focusing first lets that write be overtaken by
       the clears rather than land after them. */
    folderNameRef.current?.focus();
    const blank = { ...opening.fresh, initialItems: [...opening.fresh.initialItems] };
    setForm(blank);
    openedWith.current = blank;
    setSeedDraft("");
    setLoanQuery("");
    setLoanSuggestOpen(false);
    setLoanHighlight(-1);
    /* The Humperdink paste box is a field like any other, and it sits on the
       form for every LOI — which a blank one is. Left alone it would still be
       holding the pasted term sheet, with its button still reading "Imported",
       over a form with nothing in it. */
    setImportText("");
    setImported(false);
    setImportedNote("");
    forgetDraft();
    setRestoredNote(false);
  };

  /* Save an edit (#260, #261). Only what moved, and nothing at all when nothing did:
     `taskEdit` answers that, and an empty answer closes the form without a
     request — so the server records no history and DMs nobody about a save
     that changed the task not at all.

     A refusal rejects (the api layer toasts and rethrows) and the form stays
     open with the draft intact, the same way a failed create does. */
  const handleSave = async (): Promise<void> => {
    if (!edit) return;
    /* A box wiped to whitespace passes `required` but means the same thing as
       an empty one, and `taskEdit` would read it as "nothing moved" — closing
       the form silently on someone who thinks they just cleared the terms, or
       (since #262) the loan's name. Refuse it where the browser refuses an empty
       box, on the field the refusal is about. Terms are required on edit
       (ADR-0008 rule 1), and so is the folder name. */
    const refusal = editRefusal(form);
    if (refusal) {
      const field = refusal.field === "notes" ? notesRef.current : folderNameRef.current;
      field?.setCustomValidity(refusal.message);
      field?.reportValidity();
      return;
    }
    /* The loan pair never leaves a locked form (#266). The boxes are read-only,
       so ordinarily nothing in them can have moved — but the lock is recomputed
       live from the task, so a handoff landing while the form is open takes the
       assignee seat away with typing already in the boxes. Dropping the pair
       here is what stops that draft being posted at a save the server would
       refuse: "no control is offered to someone the server will refuse" has to
       hold for the Save button too, not only for the two fields. Everything
       else on the form is judged by its own rule and is unaffected. */
    const changed = taskEdit(edit.task, form);
    if (loanLocked) {
      delete changed.folderName;
      delete changed.humperdinkLink;
    }
    if (Object.keys(changed).length === 0) {
      onClose();
      return;
    }
    setSubmitting(true);
    try {
      await edit.onSave(changed);
      onClose();
    } catch {
      /* save failed — App surfaced the error; leave the form open to retry */
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    // Re-entry guard (#115). Covers every submit path, not just the button:
    // Enter in a text field and held/repeated Enter both land here.
    if (submitting) return;
    if (editing) {
      await handleSave();
      return;
    }
    const rawLink = form.humperdinkLink.trim();
    const normalizedLink = rawLink && !/^https?:\/\//i.test(rawLink) ? `https://${rawLink}` : rawLink;
    // Which loan this is filed against, or nothing — in which case the server
    // resolves the typed name and link (ADR-0001). One rule, in
    // `create-form-state.ts`, because a restored draft (#284) can carry a pick
    // whose loan has since been renamed or removed.
    const keepLoanId = createLoanId(form, loans);
    // FRAUD only (#69): fold any not-yet-added seeder draft into the list, then
    // ship the outstanding items the creator already knows about.
    const assignAtCreate = Boolean(form.recipientUserId) && form.pickerMode === "assign";
    const seededItems =
      form.taskType === "FRAUD"
        ? [...form.initialItems, seedDraft.trim()].map((t) => t.trim()).filter((t) => t.length > 0)
        : [];
    const payload: CreateTaskInput = {
      folderName: form.folderName,
      taskType: form.taskType,
      notes: form.notes,
      ...(keepLoanId ? { loanId: keepLoanId } : {}),
      ...(form.taskType === "OOO" ? { startDate: form.startDate, returnDate: form.returnDate } : { urgency: form.urgency }),
      ...(form.taskType !== "OOO" && normalizedLink ? { humperdinkLink: normalizedLink } : {}),
      ...(form.points > 0 ? { points: form.points } : {}),
      ...(seededItems.length > 0 ? { initialItems: seededItems.map((text) => ({ text })) } : {}),
      // The two branches are deliberately asymmetric. A handoff rides the create
      // payload so the task is born assigned in ONE call — creating it first and
      // assigning after would post a claimable channel card and then edit the
      // Claim button away, and would race the backgrounded fan-out. A share
      // stays a follow-up call (below) because its response carries the
      // `delivered` reachability flag, which the create response has no place
      // to hold.
      ...(assignAtCreate ? { assigneeUserId: form.recipientUserId } : {}),
      ...(assignAtCreate && form.recipientNote.trim() ? { assigneeNote: form.recipientNote.trim() } : {})
    };

    setSubmitting(true);
    try {
      // App owns persist + post-create share + refresh; on success we close,
      // which unmounts this child and discards the draft. A create
      // failure rejects here (App already toasted) — keep the form open.
      // onCreate deliberately resolves only after the share follow-up too, so
      // the pending state spans the whole wait rather than going idle-looking
      // mid-flight.
      await onCreate(
        payload,
        assignAtCreate ? "" : form.recipientUserId,
        form.recipientNote.trim() || undefined
      );
      /* The task exists now, so the copy of it kept against losing it is over
         (#284) — the next New Task opens blank. Only on success: a create that
         failed leaves the form open to retry, and its draft with it. */
      forgetDraft();
      onClose();
    } catch {
      /* create failed — App surfaced the error; leave the form open to retry */
    } finally {
      // In `finally`, not the catch: an exception must never strand the form
      // permanently disabled. Harmless after onClose — React no-ops a setState
      // on an unmounted component.
      setSubmitting(false);
    }
  };

  /* Folder Name, in whichever of its two jobs this task gives it (#262).
     Extracted rather than written inline because edit mode puts it and the
     Humperdink Link side by side under one shared warning, and filing leaves
     them where they have always been, at opposite ends of the form.

     Edit mode gets a plain text box, never the typeahead. The typeahead is a
     filing-time affordance for picking an EXISTING loan to file against; on a
     task that is already filed, typing here renames the loan it is already on,
     and a suggestion list offering to repoint it at a different one is a
     different move wearing this one's clothes. */
  const folderNameField = (
    <label>
      {form.taskType === "OOO" ? "Vacation Description" : "Folder Name"}
      {form.taskType === "OOO" || editing ? (
        <input
          ref={folderNameRef}
          value={loanLocked ? lockedFolderName : form.folderName}
          readOnly={loanLocked}
          {...(loanLocked ? { "aria-describedby": loanLockedId } : {})}
          onChange={(e) => {
            /* Clear a refusal the moment they start fixing it, so the box isn't
               stuck invalid on the next submit — same as the request field. */
            e.target.setCustomValidity("");
            setForm((c) => ({ ...c, folderName: e.target.value }));
          }}
          required
        />
      ) : (
        <span className="loan-typeahead">
          <input
            ref={folderNameRef}
            value={form.folderName}
            autoComplete="off"
            /* Short enough to survive the column it lives in. The long version
               ("Search existing loans or type a new name") truncated mid-word
               once the field joined the four-across top row, and a placeholder
               that has to be scrolled to read is worse than a terser one. */
            placeholder="Search or type a loan"
            role="combobox"
            aria-expanded={loanSuggestOpen && loanMatches.length > 0}
            aria-autocomplete="list"
            aria-activedescendant={loanHighlight >= 0 ? `loan-opt-${loanHighlight}` : undefined}
            onChange={(e) => {
              const v = e.target.value;
              // Typing diverges from any prior selection → treat as a new
              // loan, and re-scope the match list to the typed query.
              setForm((c) => ({ ...c, folderName: v, loanId: "" }));
              setLoanQuery(v);
              setLoanSuggestOpen(true);
              setLoanHighlight(-1);
            }}
            onFocus={() => { setLoanQuery(form.folderName); setLoanSuggestOpen(true); setLoanHighlight(-1); }}
            onBlur={() => { window.setTimeout(() => setLoanSuggestOpen(false), 120); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                if (loanMatches.length === 0) return;
                e.preventDefault();
                if (!loanSuggestOpen) setLoanSuggestOpen(true);
                const next = nextHighlightIndex(loanHighlight, e.key === "ArrowDown" ? 1 : -1, loanMatches.length);
                setLoanHighlight(next);
                // Autofill the field with the highlighted loan's name;
                // selection (link + toast) waits for Enter.
                const preview = loanMatches[next];
                if (preview) setForm((c) => ({ ...c, folderName: preview.loan.name, loanId: "" }));
              } else if (e.key === "Enter" && loanSuggestOpen && loanHighlight >= 0 && loanMatches[loanHighlight]) {
                e.preventDefault();
                selectLoan(loanMatches[loanHighlight]!.loan);
              } else if (e.key === "Escape" && loanSuggestOpen) {
                e.preventDefault();
                e.stopPropagation();
                setLoanSuggestOpen(false);
                setLoanHighlight(-1);
              }
            }}
            required
          />
          {loanSuggestOpen && loanMatches.length > 0 && (
            <ul className="loan-typeahead-list" role="listbox">
              {loanMatches.map((m, i) => (
                <li key={m.loan.id}>
                  <button
                    type="button"
                    id={`loan-opt-${i}`}
                    role="option"
                    aria-selected={i === loanHighlight}
                    className={`loan-typeahead-option${i === loanHighlight ? " loan-typeahead-option-active" : ""}`}
                    onMouseEnter={() => setLoanHighlight(i)}
                    // onMouseDown fires before the input's onBlur so the pick registers.
                    onMouseDown={(e) => { e.preventDefault(); selectLoan(m.loan); }}
                  >
                    <span className="loan-typeahead-name">{m.loan.name}</span>
                    {m.loan.humperdinkLink && <span className="loan-typeahead-link" aria-hidden="true">↗</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </span>
      )}
    </label>
  );

  /* The Humperdink Link, in the same place in both modes: full width, alone,
     directly under the request field. It used to move up beside the folder name
     in edit mode so the one muted line could sit under both; the line now lives
     in the form's footer, which is under both of them wherever they are, so the
     field stays put and the two modes read as one form. */
  const humperdinkLinkField = (
    <label className="span-full">
      Humperdink Link
      <input
        type="text"
        inputMode="url"
        placeholder="Optional"
        value={loanLocked ? lockedLink : form.humperdinkLink}
        readOnly={loanLocked}
        {...(loanLocked ? { "aria-describedby": loanLockedId } : {})}
        onChange={(e) => setForm((c) => ({ ...c, humperdinkLink: e.target.value }))}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v && !/^https?:\/\//i.test(v)) {
            setForm((c) => ({ ...c, humperdinkLink: `https://${v}` }));
          }
        }}
      />
    </label>
  );

  /* ADR-0008 rule 7, the quiet half. Both fields write the shared Loan record,
     so correcting either one corrects it on every task pointing at that loan —
     which is the case that motivates the edit, and also a bigger consequence
     than "I am fixing a typo in a box" looks like.

     One line for the pair, not one each, and only once a value has actually
     moved: `touchesSharedLoan` asks the same trimmed question the save asks, so
     the line cannot appear over an edit that would send nothing. Nothing here
     keys off focus — clicking a field to read it warns about nothing — and it
     is a line of text under the fields rather than a dialog, a banner or a
     toast. Never on OOO, which has no loan to share. */
  const sharedLoanWarning = editing && edit && !loanLocked ? touchesSharedLoan(edit.task, form) : false;
  const sharedLoanCopy =
    "Heads up: this loan's name and link are shared. Saving updates them on every task for this loan, including finished ones.";

  /* ── Leaving without saving (#283) ──────────────────────────
     Both exits go through one door. Cancel and Escape are the same act — "get
     me out of here" — so they must ask the same question, and routing them
     through one function is what stops the two answers drifting apart.

     Untouched forms still close on the first press, in both modes. The check is
     `formHasChanges` against the values this form opened with, so edit mode
     measures against the task rather than against a blank form; the FRAUD
     seeder's half-typed item counts too, being typing that would be lost. */
  const requestClose = (): void => {
    if (formHasChanges(openedWith.current, form, seedDraft)) setDiscardAsk(true);
    else onClose();
  };

  /* "Yes, discard it." The deliberate forget, and the reason the prompt shipped
     before the draft did (#283, #284): Cancel and Escape are the only way to
     tell the app you are done with this task, so they are the only close that
     takes the saved copy with it. Declining changes nothing at all — the prompt
     comes down and the draft stays exactly where it was. */
  const confirmDiscard = (): void => {
    forgetDraft();
    onClose();
  };

  return (
    <>
      {/* Mounted alongside the overlay rather than inside it, so the dialog's
          z-index is measured against the app and not against the inside of a
          modal — it has to clear the form (50) and a toast (60).

          The yes is `confirmDiscard`: it forgets the saved draft (#284) and then
          closes, which is what closing has always done. The no is only the
          prompt coming down — it closes nothing and forgets nothing. */}
      {discardAsk && <DiscardConfirmDialog onConfirm={confirmDiscard} onCancel={() => setDiscardAsk(false)} />}
      {/* The backdrop is deliberately inert (#114): a stray click here used to
          call onClose, which unmounts this component and silently destroys the
          whole draft. It stays inert — clicking it is still not an exit and does
          not raise the prompt either, because a question nobody asked for is no
          better than an answer nobody gave. The panel's old stopPropagation went
          with it; with nothing listening on the overlay it was dead weight.

          Cancel and Escape are the two exits, and since #283 both go through
          `requestClose`, which asks before it throws a filled-in form away. */}
      <div
        className="form-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? "Edit task" : "New task"}
        onKeyDown={(e) => { if (e.key === "Escape") requestClose(); }}
      >
        <div className="form-panel">
        <form className="task-form" onSubmit={handleSubmit}>
          {/* Where these values came from, on a form that opened on a saved
              draft (#285). At the top because it explains the whole form under
              it, and a person who opens New Task expecting an empty one reads
              this before they read the loan name that isn't theirs.

              Muted prose in `.task-form-locked`'s register with the same info
              icon the footer's notes use: nothing has gone wrong, and the app
              doing what it promised is not a warning. No live region and no
              `role="status"` here, unlike the footer's two lines — those appear
              while somebody is working and have a change to announce, whereas
              this is on screen from the first paint, inside a dialog whose
              contents get read on entry. A region mounted with its text already
              in it announces nothing anyway.

              It stays up while the form is edited; only Start fresh takes it
              down, because only Start fresh makes it untrue. */}
          {restoredNote && (
            <div className="task-form-restored">
              <InfoIcon />
              <p className="task-form-locked task-form-restored-note">{restoredCopy.note}</p>
              {/* Ghost, not filled: the primary action on this form is Create
                  Task, and this is the quiet way out for somebody who did not
                  want the draft back. It runs on the press — see `startFresh`
                  for why it asks nothing first. */}
              <button type="button" className="btn-sm btn-ghost" onClick={startFresh}>
                {restoredCopy.action}
              </button>
            </div>
          )}
          {/* The top row, in both modes: what the task is about, what kind it is,
              when it's wanted, and how bad it is. Four controls on one line
              rather than four rows, because together they are the one-glance
              answer to "what am I filing" — and because the request field below
              them is the only thing on the form that wants vertical room.

              Its own grid rather than the form's four equal columns: the folder
              name needs roughly twice the width of the type, and the poop tray is
              content-sized. An OOO task puts its two dates in the timing slot,
              which makes five children and wraps the tray onto a second line —
              fine, and the only shape this row takes that isn't one line. */}
          <div className="task-form-quad">
            {folderNameField}
            {/* Type is shown in edit mode and locked (ADR-0008 rule 4): nobody may
                change it, but a form that hid it would read as one that lost track
                of what it is editing. It is drawn as a padlocked chip rather than
                a disabled select — a select that cannot be opened still invites
                the click, and the row beside it is three live controls, so the one
                dead one should not be wearing their clothes. The reason and the
                way out are a popover on the chip, not a line under the row — see
                below. */}
            {editing ? (
              <div className="task-form-field task-form-type-field">
                <span className="task-form-field-head">Type</span>
                {/* A button, though it changes nothing: the chip sits where a
                    control sits and people reach for it, so the reach has to land
                    somewhere. It lands on the explanation. Keyboard-reachable for
                    the same reason a hover-only affordance is no affordance. */}
                <button
                  type="button"
                  className="task-form-type-locked"
                  aria-describedby={typeLockedId}
                  aria-expanded={typeNoteOpen}
                  onClick={() => setTypeNoteOpen((open) => !open)}
                  onBlur={() => setTypeNoteOpen(false)}
                  onKeyDown={(e) => {
                    /* Escape shuts the popover and nothing else. Without the stop
                       it reaches the overlay's handler, which closes the whole
                       form and takes the draft with it. */
                    if (e.key === "Escape" && typeNoteOpen) {
                      e.preventDefault();
                      e.stopPropagation();
                      setTypeNoteOpen(false);
                    }
                  }}
                >
                  <LockIcon />
                  {TASK_TYPE_LABELS[form.taskType]}
                </button>
                {/* Always mounted, shown by hover, focus or a click. Mounted
                    rather than conditional because `aria-describedby` above has to
                    resolve to something at all times — an explanation that exists
                    only while a pointer is over it is an explanation a screen
                    reader never gets. Absolutely positioned, so revealing it moves
                    nothing on the form. */}
                <p id={typeLockedId} className={`task-form-type-note${typeNoteOpen ? " task-form-type-note-open" : ""}`}>
                  A task&rsquo;s type can&rsquo;t be changed. If this one is wrong, cancel and refile it.
                </p>
              </div>
            ) : (
              <label>
                Type
                <select
                  value={form.taskType}
                  onChange={(e) => setForm((c) => ({ ...c, taskType: e.target.value as TaskType }))}
                >
                  {/* Labels from the shared map, not literals. Two reasons: the
                      locked chip in edit mode reads the same map, so the two can
                      never name the same type differently — and the local copy
                      said `OOO - Out of Office`, which is the widest string any
                      option holds and therefore the thing that set this select's
                      minimum width. It was overflowing its column and running
                      under the Urgency label beside it. */}
                  {(["LOI", "BUDDY_CHAT", "VALUE", "FRAUD", "LOAN_DOCS", "OOO"] as const).map((type) => (
                    <option key={type} value={type}>{TASK_TYPE_LABELS[type]}</option>
                  ))}
                </select>
              </label>
            )}
            {/* An OOO task's two dates are editable (#264, ADR-0008 rule 8), so
                this pair is the one part of the form that is NOT `!editing`. The
                two timing controls stay split rather than becoming one either/or:
                an OOO task shows its dates and no urgency, every other type shows
                its urgency and no dates, and the server refuses each the other's
                (ADR-0008 rule 5).

                No `min` of today on either input. Any date is accepted, including
                one already gone — somebody back early correcting the record is the
                case this exists for, and a return date in the past auto-completes
                the task on the next maintenance pass. The due date remains the
                thing nobody ever types: it is derived, here from the return date
                and everywhere else from the urgency band.

                Gated on `creatorOnlyFields` like the other two creator-only
                controls. An OOO task has no assignee, so today the door already
                answers this — but a control that leans on who was let in rather
                than on its own rule is the one that goes wrong when the door
                widens. */}
            {form.taskType === "OOO" && creatorOnlyFields && (
              <>
                <label>
                  Start Date
                  <input
                    type="date"
                    value={form.startDate}
                    onChange={(e) => setForm((c) => ({ ...c, startDate: e.target.value }))}
                    required
                  />
                </label>
                <label>
                  Return Date
                  <input
                    type="date"
                    value={form.returnDate}
                    min={form.startDate || undefined}
                    onChange={(e) => setForm((c) => ({ ...c, returnDate: e.target.value }))}
                    required
                  />
                </label>
              </>
            )}
            {form.taskType !== "OOO" && creatorOnlyFields && (
              <label>
                Urgency
                <UrgencySelect value={form.urgency} onChange={(urgency) => setForm((c) => ({ ...c, urgency }))} />
              </label>
            )}
            {/* Poop points, on both forms (#261). The collapsed row keeps its own
                click-to-rate track — two paths to one number, deliberately
                (ADR-0008 rule 4). */}
            {creatorOnlyFields && (
              <label>
                How Bad?
                <span
                  className="poop-picker poop-picker-form"
                  onMouseLeave={() => setNamvarHover(null)}
                >
                  {[1, 2, 3, 4, 5].map((n) => {
                    const active = n <= (namvarHover ?? form.points);
                    return (
                      <button
                        key={n}
                        type="button"
                        className={`poop-pick${active ? " poop-pick-on" : ""}`}
                        onMouseEnter={() => setNamvarHover(n)}
                        onClick={() => setForm((c) => ({ ...c, points: c.points === n ? 0 : n }))}
                        aria-label={`${n} poop${n === 1 ? "" : "s"}`}
                        aria-pressed={n <= form.points}
                      >
                        💩
                      </button>
                    );
                  })}
                </span>
              </label>
            )}
          </div>
          {/* Two nodes for one sentence, on purpose. A live region only announces
              changes made INSIDE it, so one that appears with its text already in
              place is usually read out by nobody — and this warning is the whole
              signal a screen-reader user gets before the dead end. The region is
              always mounted (visually hidden, costing no layout) and only its
              text changes; the visible box is the sighted half, hidden from the
              reader so it isn't said twice. */}
          {!editing && <p className="sr-only" role="status">{noEligibleChecker ? noCheckerWarning : ""}</p>}
          {noEligibleChecker && (
            <p className="span-full task-form-warning" aria-hidden="true">{noCheckerWarning}</p>
          )}
          {/* FRAUD only (#69): seed the outstanding-items checklist with items
              the creator already knows about. Enter-to-add, mirrors the card's
              FraudChecklist add idiom. Optional — the checker seeds later.
              Rendered above Notes (#78) so the checklist leads the form. Filing
              only: on a live Fraud Check the checklist is edited in place on the
              card, and a second adder here would be a second surface writing the
              same list. */}
          {!editing && form.taskType === "FRAUD" && (
            <div className="span-full task-form-seed">
              <span className="task-form-seed-head">Outstanding Items <span className="form-label-optional">- Optional</span></span>
              {form.initialItems.length > 0 && (
                <ul className="task-form-seed-list">
                  {form.initialItems.map((text, idx) => (
                    <li key={idx} className="task-form-seed-item">
                      <span className="task-form-seed-text">{text}</span>
                      <button
                        type="button"
                        className="checklist-delete"
                        aria-label={`Remove "${text}"`}
                        onClick={() => setForm((c) => ({ ...c, initialItems: c.initialItems.filter((_, i) => i !== idx) }))}
                      >
                        <TrashIcon />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {/* (#79) .checklist-add's dashed top divider exists to separate an
                  already-seeded item list above it; with nothing seeded yet on
                  the create form it reads as a stray gap, so drop it via
                  .checklist-add-flush until the first item lands. */}
              <div className={`checklist-add${form.initialItems.length > 0 ? "" : " checklist-add-flush"}`}>
                <input
                  className="checklist-item-input"
                  placeholder="Add an item, press Enter…"
                  value={seedDraft}
                  onChange={(e) => setSeedDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const v = seedDraft.trim();
                      if (!v) return;
                      setForm((c) => ({ ...c, initialItems: [...c.initialItems, v] }));
                      setSeedDraft("");
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn-sm"
                  disabled={!seedDraft.trim()}
                  onClick={() => {
                    const v = seedDraft.trim();
                    if (!v) return;
                    setForm((c) => ({ ...c, initialItems: [...c.initialItems, v] }));
                    setSeedDraft("");
                  }}
                >
                  Add
                </button>
              </div>
            </div>
          )}
          {/* The request itself. `required` in
              both modes: terms are required at filing and stay required on edit
              (ADR-0008 rule 1), because an LOI whose terms say nothing is worse
              than one with a typo in them.

              Edit mode gives it far more room than filing does, and on an LOI
              draws it in the mono face: the box is holding a term sheet somebody
              pasted, and the columns in it only line up in a fixed-width font.
              That is the one place the "mono is for non-prose" rule bends, and it
              bends for the reason the rule exists — this is tabular matter, not
              sentences. Every other type's field is prose and stays in the body
              face. */}
          <label className="span-full">
            {/* FRAUD's free-text field is now a general discussion seed, so it
                gets a purpose-built "Notes" label (#69); the shared
                NOTES_FIELD_LABELS.FRAUD ("Discussion") heads the card thread. */}
            {form.taskType === "FRAUD" ? "Notes" : getNotesFieldLabel(form.taskType)}
            <textarea
              ref={notesRef}
              className={editing ? (form.taskType === "LOI" ? "task-form-terms task-form-terms-mono" : "task-form-terms") : undefined}
              /* Three rows while filing, which is the height the New Task mockup
                 gives this box; eight while editing, where reading what is
                 already there is the job. Rows rather than a min-height, so the
                 edit mode class below doesn't have to out-specify a rule aimed at
                 every textarea on the form. */
              rows={editing ? 8 : 3}
              value={form.notes}
              onChange={(e) => {
                /* Clear a refusal the moment they start fixing it, so the box
                   isn't stuck invalid on the next submit. */
                e.target.setCustomValidity("");
                setForm((c) => ({ ...c, notes: e.target.value }));
              }}
              required
            />
          </label>
          {/* An OOO task has no loan and so no link: its folder name is a vacation
              description that lives on the task itself. */}
          {form.taskType !== "OOO" && humperdinkLinkField}
          {/* One person, one of two things to do with them (issue #46 +
              ADR-0002). Share = "make sure they see this", task stays in the
              pool. Assign = hand it to them, task is born CLAIMED. The picker
              narrows to eligible recipients in Assign mode — a Fraud Check can
              only go to a file checker, same rule the server enforces — and a
              selection that stops being eligible is dropped rather than left to
              fail at submit. Hidden when there's nobody to point at, and hidden
              in edit mode: the task already exists, so sharing and handing it
              over are moves on the row, not part of correcting what it says. */}
          {!editing && recipientCandidates.length > 0 && (
            <div className="span-full form-direct">
              <div className="form-direct-head">
                <span>
                  {form.pickerMode === "assign" ? "Assign Directly" : "Share Directly"}
                  <span className="form-label-optional"> - Optional</span>
                </span>
                <div className="seg" role="group" aria-label="Share or assign">
                  <button
                    type="button"
                    className={form.pickerMode === "share" ? "seg-on" : ""}
                    aria-pressed={form.pickerMode === "share"}
                    onClick={() => setForm((c) => ({ ...c, pickerMode: "share" }))}
                  >
                    Share
                  </button>
                  <button
                    type="button"
                    className={form.pickerMode === "assign" ? "seg-on" : ""}
                    aria-pressed={form.pickerMode === "assign"}
                    onClick={() => setForm((c) => ({ ...c, pickerMode: "assign" }))}
                  >
                    {ACTION_LABELS.ASSIGN}
                  </button>
                </div>
              </div>
              <select
                aria-label={form.pickerMode === "assign" ? "Assign to" : "Share with"}
                value={form.recipientUserId}
                onChange={(e) => setForm((c) => ({ ...c, recipientUserId: e.target.value }))}
              >
                <option value="">No one — just create it</option>
                {recipientCandidates.map((u) => (
                  <option key={u.id} value={u.id}>{u.displayName}</option>
                ))}
              </select>
              {form.recipientUserId && (
                <input
                  type="text"
                  value={form.recipientNote}
                  placeholder="Add a note (optional)"
                  maxLength={280}
                  onChange={(e) => setForm((c) => ({ ...c, recipientNote: e.target.value }))}
                />
              )}
            </div>
          )}
          {/* The footer: a tinted strip across the bottom of the panel holding the
              two exits and, to their left, the one thing each mode has to say
              beside them. Filing puts the Humperdink import here — it is a
              shortcut past the whole form rather than a field in it, and sitting
              above Folder Name it read as the first thing to fill in. Editing puts
              the shared-record line here, where it is genuinely under both of the
              fields it is about rather than under one of them. */}
          <div className="task-form-foot">
            {/* Humperdink import (#194). The paste target and the button that
                takes it; the human presses paste, the app never reads the
                clipboard itself.

                LOI Check only. `Send to Hot Task` over in Humperdink is a
                term-sheet handoff — it is how an LOI's terms get filed without
                being retyped — and on any other type it was a control that took a
                paste nobody has. Narrower than the old rule, which only kept it
                off an out-of-office task on the grounds that a vacation has no
                loan; that was true and not the point. Hidden in edit mode too,
                where it would rewrite fields this ticket deliberately doesn't
                offer. */}
            {!editing && form.taskType === "LOI" && (
              <div className="task-form-import">
                <label className="task-form-import-field">
                  <span className="sr-only">Paste from Humperdink</span>
                  <input
                    type="text"
                    autoComplete="off"
                    placeholder="Paste what Send to Hot Task copied"
                    value={importText}
                    onChange={(e) => {
                      setImportText(e.target.value);
                      setImported(false);
                    }}
                    onKeyDown={(e) => {
                      // Enter in this field means "import", not "create the task" —
                      // the form's implicit submit would file a half-filled task
                      // out from under a paste.
                      if (e.key === "Enter") {
                        e.preventDefault();
                        importFromHumperdink();
                      }
                    }}
                  />
                </label>
                <button type="button" className="btn-ghost btn-sm" onClick={importFromHumperdink}>
                  {imported ? "Imported" : "Import from Humperdink"}
                </button>
              </div>
            )}
            {/* ADR-0008 rule 7, the quiet half — and #266's lock, which takes its
                place. Both are one sentence about both loan fields, so both live
                in the one slot: they are mutually exclusive by construction and a
                slot that could hold both would be a design that let them collide.

                The shared-record line appears only once a value has actually
                moved: `touchesSharedLoan` asks the same trimmed question the save
                asks, so it cannot appear over an edit that would send nothing.
                Nothing here keys off focus — clicking a field to read it warns
                about nothing — and it is a line of text, never a dialog, a banner
                or a toast. Never on OOO, which has no loan to share. */}
            {editing && form.taskType !== "OOO" && (
              <div className="task-form-foot-note">
                {/* Two nodes for one sentence, the same way the sole-checker
                    warning above does it and for the same reason: a live region
                    only announces changes made INSIDE it, so the region is always
                    mounted and only its text changes, while the visible copy is
                    hidden from the reader so it isn't said twice. */}
                <p className="sr-only" role="status">{sharedLoanWarning ? sharedLoanCopy : ""}</p>
                {sharedLoanWarning && (
                  <>
                    <InfoIcon />
                    <p className="task-form-shared-loan" aria-hidden="true">{sharedLoanCopy}</p>
                  </>
                )}
                {/* Muted prose in the same register as `.task-form-locked`,
                    because nothing has gone wrong; they are simply not one of the
                    two people this is for. */}
                {loanLocked && (
                  <>
                    <InfoIcon />
                    <p id={loanLockedId} className="task-form-locked task-form-loan-locked">
                      {edit?.loanRefusal}
                    </p>
                  </>
                )}
              </div>
            )}
            <div className="task-form-foot-actions">
              {/* Cancel asks first on a form with anything in it (#283). Same
                  door as Escape, so the two can never answer differently. */}
              <button type="button" className="btn-ghost" onClick={requestClose}>Cancel</button>
              <button type="submit" disabled={submitting}>
                {editing ? (submitting ? "Saving…" : "Save") : (submitting ? "Creating…" : "Create Task")}
              </button>
            </div>
          </div>
        </form>
        </div>
      </div>
    </>
  );
};
