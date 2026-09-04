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
import { ACTION_LABELS, CreateTaskInput, Loan, LoanTask, TaskType, URGENCY_LEVELS, URGENCY_TIMEFRAMES, UrgencyLevel, UserIdentity, UserRole, deriveMyLoanIds, eligibleAssignees, getNotesFieldLabel, humperdinkNoteText, loanTypeaheadSuggestions, nextHighlightIndex, parseHumperdinkPayload } from "@loan-tasks/shared";
import { FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { CreateFormInitialValues, CreateFormValues, EditableTask, TaskEdit, applyImportedLoan, editFormValues, editRefusal, initialCreateForm, taskEdit, touchesSharedLoan } from "./create-form-state";
import { TrashIcon } from "./icons";
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
     them in edit mode with #262; in create mode it is the typeahead's input and
     the ref simply goes unused, because nothing refuses a create here. */
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const folderNameRef = useRef<HTMLInputElement>(null);
  /* Lazy initializer, so re-renders don't rebuild the state and a changing
     `initialValues` identity can't reset a half-typed draft: the values seed
     the form once, at open. Reopening the form remounts this component, which
     is when new initial values take effect. */
  const [form, setForm] = useState<CreateFormValues>(() =>
    edit ? editFormValues(edit.task) : initialCreateForm(initialValues)
  );
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
  /* Ties the disabled type select to the sentence explaining why it's disabled.
     Described-by rather than inside the <label>, so the reason is announced
     after the field's name instead of becoming part of it. */
  const typeLockedId = useId();
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
     would reject at submit. */
  useEffect(() => {
    if (form.recipientUserId && !recipientCandidates.some((c) => c.id === form.recipientUserId)) {
      setForm((c) => ({ ...c, recipientUserId: "" }));
    }
  }, [recipientCandidates, form.recipientUserId]);

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
    // Only pass loanId when the typed name still matches the selected loan —
    // editing the text after selecting means the user intends a new loan.
    const selectedLoan = form.loanId ? loans.find((l) => l.id === form.loanId) : undefined;
    const keepLoanId = form.taskType !== "OOO" && selectedLoan && selectedLoan.name === form.folderName.trim();
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
      ...(keepLoanId ? { loanId: form.loanId } : {}),
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
            value={form.folderName}
            autoComplete="off"
            placeholder="Search existing loans or type a new name"
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

  /* The Humperdink Link. Full width while filing, where it sits alone below the
     request field; half of the loan pair in edit mode, beside the folder name
     the warning below them both is about. */
  const humperdinkLinkField = (
    <label className={editing ? undefined : "span-full"}>
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

  return (
    /* The backdrop is deliberately inert (#114): a stray click here used to
       call onClose, which unmounts this component and silently destroys the
       whole draft. Cancel and Escape are the only exits, and both are
       deliberate acts taken at the user's word — no confirmation prompt, no
       dirty tracking. The panel's old stopPropagation went with it; with
       nothing listening on the overlay it was dead weight. */
    <div
      className="form-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={editing ? "Edit task" : "New task"}
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
    >
      <div className="form-panel">
      <form className="task-form" onSubmit={handleSubmit}>
        {/* Humperdink import (#194). Above Folder Name because it fills Folder
            Name — the shortcut sits where the typing it saves would start.
            Hidden for OOO: a vacation has no loan and no Humperdink link. And
            hidden in edit mode, where it would rewrite fields this ticket
            deliberately doesn't offer. */}
        {!editing && form.taskType !== "OOO" && (
          <div className="span-full task-form-import">
            <label className="task-form-import-field">
              Paste from Humperdink
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
        {/* The two loan fields (#262). Filing keeps them where they were — the
            folder name here, the link down below the request field. Editing
            pulls them together into one block, because the sentence underneath
            covers both of them and a warning half a form away from one of the
            fields it is about is a warning about nothing.

            An OOO task has neither: its folder name is a vacation description
            that lives on the task, and it has no Humperdink link at all, so it
            renders the bare field and no warning. */}
        {editing && form.taskType !== "OOO" ? (
          <div className="span-full task-form-loan">
            {folderNameField}
            {humperdinkLinkField}
            {/* Two nodes for one sentence, the same way the sole-checker warning
                below does it and for the same reason: a live region only
                announces changes made INSIDE it, so the region is always mounted
                and only its text changes, while the visible copy is hidden from
                the reader so it isn't said twice. */}
            <p className="sr-only" role="status">{sharedLoanWarning ? sharedLoanCopy : ""}</p>
            {sharedLoanWarning && (
              <p className="task-form-shared-loan" aria-hidden="true">{sharedLoanCopy}</p>
            )}
            {/* The refusal takes that line's place rather than sitting beside it
                (#266). They are mutually exclusive by construction: read-only
                boxes cannot move, so `touchesSharedLoan` is false here anyway,
                and the sentence a locked-out viewer needs is why the boxes are
                shut — not a warning about a save they cannot make. Muted prose
                in the same register as `.task-form-locked`, because nothing has
                gone wrong; they are simply not one of the two people this is
                for. */}
            {loanLocked && (
              <p id={loanLockedId} className="task-form-locked task-form-loan-locked">
                {edit?.loanRefusal}
              </p>
            )}
          </div>
        ) : (
          folderNameField
        )}
        {/* Type is shown in edit mode and locked (ADR-0008 rule 4): nobody may
            change it, but a form that hid it would read as one that lost track
            of what it is editing. Disabled rather than absent, with the reason
            and the way out beside it — a control that simply refuses clicks is
            the version people file bugs about. */}
        <label>
          Type
          <select
            value={form.taskType}
            disabled={editing}
            {...(editing ? { "aria-describedby": typeLockedId } : {})}
            onChange={(e) => setForm((c) => ({ ...c, taskType: e.target.value as TaskType }))}
          >
            <option value="LOI">LOI Check</option>
            <option value="BUDDY_CHAT">Buddy Chat</option>
            <option value="VALUE">Value Check</option>
            <option value="FRAUD">Fraud Check</option>
            <option value="LOAN_DOCS">Loan Docs</option>
            <option value="OOO">OOO - Out of Office</option>
          </select>
        </label>
        {editing && (
          <p id={typeLockedId} className="span-full task-form-locked">
            A task&rsquo;s type can&rsquo;t be changed. If this one is wrong, cancel and refile it.
          </p>
        )}
        {/* The OOO dates are filing-time only, until #264. Which is why the two
            timing controls are split rather than one either/or: urgency is
            editable now (#261) and the dates are not, so an OOO task in edit
            mode shows neither — its timing is its dates, and the server refuses
            an urgency on it outright (ADR-0008 rule 5). No date input is drawn
            in edit mode at all, which is also the rule for the due date
            permanently: it is derived from the band, never typed. */}
        {!editing && form.taskType === "OOO" && (
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
            than one with a typo in them. */}
        <label className="span-full">
          {/* FRAUD's free-text field is now a general discussion seed, so it
              gets a purpose-built "Notes" label (#69); the shared
              NOTES_FIELD_LABELS.FRAUD ("Discussion") heads the card thread. */}
          {form.taskType === "FRAUD" ? "Notes" : getNotesFieldLabel(form.taskType)}
          <textarea
            ref={notesRef}
            rows={editing ? 8 : 2}
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
        {/* Filing only, at its long-standing spot. In edit mode this field has
            already been drawn beside the folder name, above. */}
        {!editing && form.taskType !== "OOO" && humperdinkLinkField}
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
        <div className="form-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={submitting}>
            {editing ? (submitting ? "Saving…" : "Save") : (submitting ? "Creating…" : "Create Task")}
          </button>
        </div>
      </form>
      </div>
    </div>
  );
};
