/* The create form's value state, lifted out of <CreateTaskForm> (issue #194).

   The form used to open exactly one way — blank, from a state literal inside
   the component — so there was no way to open it with anything in it. An
   imported Humperdink loan needs both halves of that: a form that can be *born*
   with values (`initialCreateForm`) and one that can take them *while open*
   (`applyImportedLoan`).

   Framework-free and pure so both are testable without React; the component
   keeps only the useState around them. Types are imported type-only, so this
   module type-strips straight into a node test with no build. */
import type { TaskType, UrgencyLevel } from "@loan-tasks/shared";
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
