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

/* The new task form's autosave (#284, moved to the server by #371): the one
   unfinished new-task form a person has, kept as they type so a reload, a Teams
   switch or another device loses nothing. Not a Saved for Later task: nobody
   pressed anything, so there is one per person rather than a list, and it ages
   out. Private under ADR-0011's rules like one, and kept in the same store.

   `form` is the same shape a Saved for Later task keeps. `savedAt` is the last
   write, and the only thing expiry reads. */
export interface Autosave {
  ownerId: string;
  savedAt: string;
  form: SavedForLaterForm;
}

/* Seven days from the last write: long enough that a Friday interruption is
   still there on Monday, short enough that nothing genuinely stale comes back.
   One number for the server, which prunes on it, and the web app's offline
   copy, which is held to it by `scripts/saved-for-later-board-sim-test.mjs`. */
export const AUTOSAVE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/* Whether an autosave last written at `savedAt` has aged out by `now`. An
   unreadable time counts as aged out: there is no telling how old it is, and a
   form nobody can date is not one to put back in front of someone. */
export const isAutosaveExpired = (savedAt: string, now: number): boolean => {
  const written = Date.parse(savedAt);
  return !Number.isFinite(written) || now - written >= AUTOSAVE_MAX_AGE_MS;
};

/* Newest saved first: the order the board's section lists them in, and the
   order the server hands them back. One comparator so the two cannot disagree
   about which comes first. */
export const newestSavedFirst = (
  a: Pick<SavedForLaterTask, "savedAt">,
  b: Pick<SavedForLaterTask, "savedAt">
): number => Date.parse(b.savedAt) - Date.parse(a.savedAt);
