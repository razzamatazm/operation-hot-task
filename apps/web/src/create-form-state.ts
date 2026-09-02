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

/* Fold an imported Humperdink loan into a form that is already open.

   Only the two fields the payload speaks for are touched — whatever the filer
   has already typed elsewhere survives the import. `loanId` is cleared because
   the link is the canonical key for a Loan (ADR-0001): a leftover id from an
   earlier typeahead pick would win over resolving the imported URL and file the
   task against the wrong loan. */
export const applyImportedLoan = (
  current: CreateFormValues,
  payload: HumperdinkPayload
): CreateFormValues => ({
  ...current,
  folderName: payload.loanName,
  humperdinkLink: payload.loanUrl,
  loanId: ""
});
