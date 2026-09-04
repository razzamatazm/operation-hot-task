/* The create form's value state, lifted out of <CreateTaskForm> (issue #194).

   The form used to open exactly one way — blank, from a state literal inside
   the component — so there was no way to open it with anything in it. An
   imported Humperdink loan needs both halves of that: a form that can be *born*
   with values (`initialCreateForm`) and one that can take them *while open*
   (`applyImportedLoan`).

   Framework-free and pure so both are testable without React; the component
   keeps only the useState around them. Types are imported type-only, so this
   module type-strips straight into a node test with no build. */
import type { LoanTask, TaskType, UrgencyLevel } from "@loan-tasks/shared";
import type { HumperdinkPayload } from "@loan-tasks/shared";

export interface CreateFormValues {
  folderName: string;
  /* Set only by an explicit typeahead pick. Empty means "resolve the loan from
     the name and link at submit" (ADR-0001). */
  loanId: string;
  taskType: TaskType;
  urgency: UrgencyLevel;
  startDate: string;
  returnDate: string;
  notes: string;
  humperdinkLink: string;
  points: number;
  /* FRAUD only (#69): outstanding items the creator seeds at creation. */
  initialItems: string[];
  /* One optional person at creation, and one of two things to do with them
     (#46 + ADR-0002). */
  pickerMode: "share" | "assign";
  recipientUserId: string;
  recipientNote: string;
}

/* What a caller may open the form with. Deliberately a subset: the recipient
   picker, the FRAUD seeder and the OOO dates are things a human chooses in
   front of the form, not things an import or a deep link carries. */
export type CreateFormInitialValues = Partial<
  Pick<
    CreateFormValues,
    "folderName" | "loanId" | "taskType" | "urgency" | "notes" | "humperdinkLink" | "points"
  >
>;

/* The form as it has always opened. Exported for tests and as the one place
   the defaults are written down; callers go through `initialCreateForm`, which
   copies it. */
export const BLANK_CREATE_FORM: CreateFormValues = {
  folderName: "",
  loanId: "",
  taskType: "LOI",
  urgency: "GREEN",
  startDate: "",
  returnDate: "",
  notes: "",
  humperdinkLink: "",
  points: 0,
  initialItems: [],
  pickerMode: "share",
  recipientUserId: "",
  recipientNote: ""
};

/* Build the form's opening state. No initial values (the everyday case) gives
   exactly the blank form; supplied ones override field by field.

   An explicitly-`undefined` entry counts as "not supplied", not as "blank this
   out" — callers spread optional values in, so `{ folderName: undefined }` is a
   normal thing to receive. */
export const initialCreateForm = (initial?: CreateFormInitialValues): CreateFormValues => {
  const supplied = Object.fromEntries(
    Object.entries(initial ?? {}).filter(([, value]) => value !== undefined)
  ) as CreateFormInitialValues;
  return { ...BLANK_CREATE_FORM, initialItems: [...BLANK_CREATE_FORM.initialItems], ...supplied };
};

/* ── Is there anything to lose? (#283) ────────────────────────
   Closing the form used to throw the whole draft away instantly and silently.
   Cancel and Escape now ask first — but only once there is something to ask
   about, because a prompt over an untouched form is a prompt people learn to
   click through.

   "Something to lose" is the form differing from the one that was opened,
   whichever way it was opened: blank or seeded in create mode
   (`initialCreateForm`), preloaded from the task in edit mode
   (`editFormValues`). Comparing against the OPENING values rather than against
   the blank form is what makes the same question work in both modes — an edit
   form is full of values nobody typed, and measuring those as "changed" would
   prompt every single time.

   Deliberately over-eager: every field counts, including the task type on its
   own, and nothing is trimmed or normalised first. A decision someone made is
   worth one extra click to undo, and a threshold clever enough to ignore the
   type picker will eventually eat real work. This is not `taskEdit` — that one
   answers "what is worth sending to the server", which is a narrower and much
   more forgiving question than "did this person do anything here".

   `pendingItemText` is the FRAUD seeder's input (#69), which holds typing that
   has not been committed to `initialItems` yet. It lives outside the values
   object in the component, so it is passed in rather than read here; a half-
   typed outstanding item is still typing, and losing it silently is the exact
   thing this ticket is about.

   `initialItems` is an array, so it is compared item by item — the seeder
   rebuilds it on every add, so reference equality would call every list
   changed and value equality on the reference would call none of them.

   Kept here, framework-free and pure, because the draft-saving work that
   follows reuses it to decide whether there is a draft worth keeping. */
export const formHasChanges = (
  opened: CreateFormValues,
  current: CreateFormValues,
  pendingItemText = ""
): boolean => {
  if (pendingItemText.trim() !== "") return true;
  return (Object.keys(opened) as (keyof CreateFormValues)[]).some((key) => {
    const before = opened[key];
    const after = current[key];
    if (Array.isArray(before) && Array.isArray(after)) {
      return before.length !== after.length || before.some((item, i) => item !== after[i]);
    }
    return before !== after;
  });
};

/* ── Edit mode (#260, ADR-0008 rule 4) ────────────────────────
   The same form, opened on a task that already exists. Two pure functions
   either side of the component: one says what the form opens with, the other
   says what a Save is actually allowed to send.

   The task the form edits, as far as this module is concerned. A `LoanTask`
   satisfies it; the narrow shape is what keeps the tests from having to build
   a whole task to ask a question about the handful of fields a Save can move.

   `createdBy` earns its place here without being editable: urgency and poop
   points are permanently the creator's, so the form has to know whose task this
   is before it can decide whether to draw them (#261, #263). */
export type EditableTask = Pick<
  LoanTask,
  | "taskType"
  | "notes"
  | "folderName"
  | "humperdinkLink"
  | "urgency"
  | "points"
  | "createdBy"
  | "startDate"
  | "returnDate"
>;

/* What edit mode opens with. The task's type, its request field, the two loan
   fields the row displays (#262), its urgency and poop points (#261) and — on an
   OOO task — its two dates (#264), plus the blank form's values for everything
   else.

   The folder name and the link are loaded from the task rather than from the
   Loan record because the task already carries the loan's current values — the
   server pushes them onto every linked task on every loan edit (ADR-0001's live
   reference), so the task IS the loan's copy and reading it needs no lookup.

   Urgency and points are preloaded rather than defaulted (#261). A select
   sitting on GREEN while the task is RED is a control that lies about the task,
   and saving the form would silently push the deadline out. The dates (#264)
   are preloaded for the same reason and more sharply: they are a correction
   surface, and a person fixing "back on the 9th, not the 12th" needs the 12th
   in front of them to change.

   The five types that have no dates get the blank form's empty strings, which
   is what they had before — nothing draws them, and `taskEdit` refuses to send
   them.

   The type is loaded even though nobody may change it: the form shows it,
   disabled, because "what kind of task am I editing" is the first thing a
   person checks and a blank type would read as a form that lost it. */
export const editFormValues = (task: EditableTask): CreateFormValues => ({
  ...BLANK_CREATE_FORM,
  initialItems: [],
  taskType: task.taskType,
  notes: task.notes ?? "",
  folderName: task.folderName ?? "",
  humperdinkLink: task.taskType === "OOO" ? "" : task.humperdinkLink ?? "",
  urgency: task.urgency,
  points: task.points,
  startDate: task.startDate ?? BLANK_CREATE_FORM.startDate,
  returnDate: task.returnDate ?? BLANK_CREATE_FORM.returnDate
});

/* Everything a Save may change, and nothing else. Optional throughout: an
   absent key means "this did not move", which is what the caller turns into
   "make no request at all".

   Each key still goes to its own focused route — the shape that must never
   appear is a single object posted at a catch-all `PATCH /tasks/:id` (ADR-0008
   rule 4, inherited from ADR-0006). The two loan fields are not an exception:
   they travel together because they land on one record, but that record is the
   Loan's own `PATCH /loans/:loanId`, not the task's. There is deliberately no
   `dueAt` and never will be: the due date is derived from the urgency band, and
   no route accepts one — including on an OOO task, whose `dueAt` the server
   re-derives from the new return date.

   `humperdinkLink` is the one key whose empty string means something. A link is
   optional, so clearing it is a real edit; the folder name and the request
   field are both required, and an emptied one is never sent.

   `dates` is one key holding both, not two keys (#264). The two dates are a
   range and the rule about them — start on or before return — cannot be asked
   of half of it, so they move together, go to one route together, and land in
   history together. */
export interface TaskEdit {
  notes?: string;
  folderName?: string;
  humperdinkLink?: string;
  urgency?: UrgencyLevel;
  points?: number;
  dates?: { startDate: string; returnDate: string };
}

/* What actually moved. Compared trimmed on both sides, so re-saving a field
   whose only difference is a trailing newline is the same nothing as re-saving
   it untouched: the server would otherwise record that as a real amendment,
   write it into the task's history with both values, and tell the assignee
   their terms changed.

   An emptied *required* field is a no-change rather than an empty write. Terms
   are required on edit (ADR-0008 rule 1) — a checked LOI whose terms say
   nothing is worse than an uncorrected one — and so is the folder name, which
   is the loan's name on every task that points at it. The form blocks both
   submits, so this is the second lock on the same door rather than the message
   a person sees. A cleared Humperdink link is a genuine edit and does go.

   Urgency and points (#261) are plain equality — a select and a five-way picker
   can only hold values that came out of them, so there is no whitespace or
   emptiness to normalise. Zero poops is a real rating ("not rated"), so clearing
   the track is a change to send rather than a falsy nothing. Neither needs a
   creator check here: the form draws both only for the creator, and everyone
   else's form opens on the task's own values, so there is nothing for a
   non-creator's Save to move.

   The dates are the mirror of the urgency exclusion below (#264): only an OOO task has them, so only
   an OOO task can send them, and the other five can't leak a stray value into a
   route that would refuse it. They move as a pair — one of them changing sends
   both, because the server takes the range rather than an endpoint of it — and
   an empty one is never sent: a cleared date input is a half-finished edit, not
   an instruction to unset a vacation's start. The ordering rule stays with the
   server and the shared predicate it asks; the form's `min` attribute is a
   convenience, not the check. */
export const taskEdit = (task: EditableTask, values: CreateFormValues): TaskEdit => {
  const edit: TaskEdit = {};

  const notes = values.notes.trim();
  if (notes && notes !== (task.notes ?? "").trim()) edit.notes = notes;

  const folderName = values.folderName.trim();
  if (folderName && folderName !== (task.folderName ?? "").trim()) edit.folderName = folderName;

  /* An OOO task has no loan and no link field on the form, so nothing here may
     ever produce one for it — a stray value in the state would otherwise be
     posted at a Loan record that doesn't exist. */
  if (task.taskType !== "OOO") {
    const humperdinkLink = values.humperdinkLink.trim();
    if (humperdinkLink !== (task.humperdinkLink ?? "").trim()) edit.humperdinkLink = humperdinkLink;
  }

  /* An OOO task has no urgency to change: its timing is its start and return
     dates, the server refuses the urgency route outright, and the form draws no
     control. Excluded here as well, so a value that somehow moved can never
     become a request the server will reject. */
  if (task.taskType !== "OOO" && values.urgency !== task.urgency) edit.urgency = values.urgency;
  if (values.points !== task.points) edit.points = values.points;

  if (task.taskType === "OOO") {
    const startDate = values.startDate.trim();
    const returnDate = values.returnDate.trim();
    const moved = startDate !== (task.startDate ?? "") || returnDate !== (task.returnDate ?? "");
    if (startDate && returnDate && moved) edit.dates = { startDate, returnDate };
  }

  return edit;
};

/* Is the form about to rewrite the loan record everyone else is reading?

   The one thing the muted warning line is allowed to key off (#262, ADR-0008
   rule 7). It asks the same trimmed question `taskEdit` asks, so the line
   cannot appear over an edit that would send nothing, and it says nothing about
   focus: clicking a field to read it warns about nothing.

   False on OOO throughout — a vacation description is the creator's own words
   on their own task, and there is no shared record to warn about. */
export const touchesSharedLoan = (task: EditableTask, values: CreateFormValues): boolean => {
  if (task.taskType === "OOO") return false;
  const { folderName, humperdinkLink } = taskEdit(task, values);
  return folderName !== undefined || humperdinkLink !== undefined;
};

/* Why a Save can't go through and which box is at fault, or `null` when it can.

   The browser's own `required` catches a box a person emptied completely, but
   a single space satisfies it. Without this, `taskEdit` reads a wiped field as
   "nothing moved", the form closes, and the person walks away believing they
   cleared the terms when nothing was saved and nothing said so. Worded like the
   browser's own message, because the form shows it in the same place.

   Two required boxes since #262: the request field, and the folder name — which
   is the loan's name on every task pointing at it, so a blank one is a mistake
   rather than an instruction. The field is named because the message is shown on
   the box it is about, and a refusal about the folder name hung on the terms is
   worse than no refusal at all. The Humperdink link is optional and is never
   refused; clearing it is a real edit. */
export interface EditRefusal {
  field: "notes" | "folderName";
  message: string;
}

const WIPED = "Please fill this in — spaces alone don't count.";

export const editRefusal = (values: CreateFormValues): EditRefusal | null => {
  if (!values.notes.trim()) return { field: "notes", message: WIPED };
  if (!values.folderName.trim()) return { field: "folderName", message: WIPED };
  return null;
};

/* The note text an import writes, and the one the last import wrote.

   Passed in rather than computed here: rendering the note is
   `humperdinkNoteText` over in `@loan-tasks/shared`, and importing that as a
   *value* would tie this module to shared's compiled `dist`. Everything here is
   type-only precisely so its test runs with no build. */
export interface ImportedNotes {
  /** What this import wants in the notes field. "" means it carries none. */
  noteText?: string;
  /** What the previous import of this form put there, so a re-import replaces
      it instead of stacking a second copy under the first. */
  previousNoteText?: string;
}

/* Remove one block of imported note text from what the filer currently has,
   leaving their own typing behind. Matched literally: the block is a string
   this module wrote, not something a human retyped, so an edited block is left
   alone on purpose — a filer who reworded the terms means it.

   Only the seam the block left behind is tidied. Running a blank-line collapse
   over the whole field would quietly reformat the filer's own paragraphs. */
const withoutBlock = (notes: string, block: string): string => {
  if (!block) return notes;
  const at = notes.indexOf(block);
  if (at < 0) return notes;
  const before = notes.slice(0, at).replace(/\n+$/, "");
  const after = notes.slice(at + block.length).replace(/^\n+/, "");
  if (!before) return after;
  if (!after) return before;
  return `${before}\n\n${after}`;
};

/* Fold an imported Humperdink loan into a form that is already open.

   Fills the loan's name and link (#194) and its terms (#196). Whatever the
   filer has already typed elsewhere survives the import: the terms are appended
   below their notes rather than replacing them, and every other field is left
   as it was.

   The task type becomes LOI because the terms note is an LOI's note — the LOI
   field is literally labelled "Loan Terms and Contacts", and this import is
   LOI-only for now (#196).

   `loanId` is cleared because the link is the canonical key for a Loan
   (ADR-0001): a leftover id from an earlier typeahead pick would win over
   resolving the imported URL and file the task against the wrong loan. */
export const applyImportedLoan = (
  current: CreateFormValues,
  payload: HumperdinkPayload,
  notes: ImportedNotes = {}
): CreateFormValues => {
  const noteText = notes.noteText ?? "";
  const kept = withoutBlock(current.notes, notes.previousNoteText ?? "");
  return {
    ...current,
    folderName: payload.loanName,
    humperdinkLink: payload.loanUrl,
    loanId: "",
    taskType: "LOI",
    notes: noteText && kept ? `${kept.trimEnd()}\n\n${noteText}` : noteText || kept
  };
};
