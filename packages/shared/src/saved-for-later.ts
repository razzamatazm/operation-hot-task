import type { TaskType, UrgencyLevel } from "./types.js";

/* A Saved for Later task (#337, ADR-0011): a new task someone put aside on
   purpose before filing it. Not a task. It belongs to one person, nobody else
   can see it, and it notifies, counts and scores nothing.

   The form as it stood when they pressed Save for later, every field, untouched
   and unvalidated beyond its shape. Nothing on it is required: the button asks
   only that the form was touched, and a half-typed task is exactly what this is
   for. The loan is kept as typed and resolved only when the task is finally
   created, the way the autosave's is, so a rename or merge in between is handled
   like any other new task.

   Mirrors the web form's `CreateFormValues` field for field. The server's
   schema for it is held to the autosave's field list by
   `scripts/saved-for-later-sim-test.mjs`, so a field added to the form and not
   here fails the suite rather than being dropped on save. */
export interface SavedForLaterForm {
  folderName: string;
  loanId: string;
  taskType: TaskType;
  urgency: UrgencyLevel;
  startDate: string;
  returnDate: string;
  notes: string;
  humperdinkLink: string;
  points: number;
  initialItems: string[];
  pickerMode: "share" | "assign";
  recipientUserId: string;
  recipientNote: string;
}

export interface SavedForLaterTask {
  id: string;
  /* The one person who may ever list, fetch or change it. */
  ownerId: string;
  /* ISO timestamp of the latest save. What the board orders by and what
     "saved N ago" reads. */
  savedAt: string;
  form: SavedForLaterForm;
  /* Typing on a reopened one that nobody saved (#348, ADR-0011 rule 5): the
     form as it stood when its owner last paused, kept on this record so a tab
     that closed or a Teams switch that reloaded it loses nothing, and so the
     browser autosave never holds a second copy of it.

     Beside `form`, never over it. `form` and `savedAt` are what the person
     deliberately saved, and Discard has to be able to leave exactly that. So
     writing this moves neither, the row's "saved N ago" and its place in the
     list stay put, and Discard simply takes this away. Saving for later again
     folds it into `form` and clears it. Reopening opens on this when it is
     there. Absent when there is nothing unsaved. */
  unsaved?: SavedForLaterForm;
}

/* Newest saved first: the order the board's section lists them in, and the
   order the server hands them back. One comparator so the two cannot disagree
   about which comes first. */
export const newestSavedFirst = (
  a: Pick<SavedForLaterTask, "savedAt">,
  b: Pick<SavedForLaterTask, "savedAt">
): number => Date.parse(b.savedAt) - Date.parse(a.savedAt);
