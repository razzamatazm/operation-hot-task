import { LoanTask, UserIdentity } from "./types.js";

/* Structured outstanding-items checklist for FRAUD checks (#44). Replaces the
   old free-text "outstanding items" handoff with a list the two participants
   pass back and forth: the checker builds it, the creator resolves it, the
   checker approves. Each item is added by one of the two roles on a specific
   pass, carries the creator's per-item exception note and the checker's
   per-item rework note, and is never deleted — an item leaves consideration
   only by being checked off with a note explaining why.

   `checked` is a single "resolved" state: it means the item was collected OR
   deemed not-needed; `note` explains when it wasn't a straight collection.
   `stale` is set when an item's text is edited after it was checked, so a check
   never silently vouches for a changed requirement — the item is un-checked and
   must be re-verified. */
export interface ChecklistItem {
  id: string;
  text: string;
  /* Single "resolved" state: collected OR not-needed (see `note`). */
  checked: boolean;
  /* Creator's per-item exception / "why it's not needed." */
  note?: string;
  /* Checker's per-item "why this isn't sufficient / needs rework." */
  checkerNote?: string;
  addedBy: "checker" | "creator";
  /* The pass counter value when the item was added (>= 1). */
  addedOnPass: number;
  /* Set when the text was edited after the item was checked — the check was
     cleared and the item needs re-verification. */
  stale?: boolean;
}

/* Ordering rule (#44): unresolved (unchecked) items float to the top, resolved
   ones settle below. Stable within each group — items keep their add-order — so
   the list never jumps around beyond the checked/unchecked split. Pure: returns
   a new array and never mutates the input. */
export const sortChecklist = (items: ChecklistItem[]): ChecklistItem[] => {
  const unchecked = items.filter((item) => !item.checked);
  const checked = items.filter((item) => item.checked);
  return [...unchecked, ...checked];
};

/* Append a new (unchecked) item. No id/uniqueness logic here — the caller mints
   the id — so this stays a pure list op. Pure: returns a new array. */
export const addChecklistItem = (
  items: ChecklistItem[],
  item: { id: string; text: string; addedBy: "checker" | "creator"; addedOnPass: number }
): ChecklistItem[] => [
  ...items,
  { id: item.id, text: item.text, checked: false, addedBy: item.addedBy, addedOnPass: item.addedOnPass }
];

/* Edit an item's text. THE checked/stale invariant: if the item was checked,
   editing its text auto-clears the check and marks it stale — a check must
   never keep vouching for a requirement whose wording changed. An edit to an
   unchecked item just updates the text. Pure: returns a new array. */
export const editChecklistItemText = (items: ChecklistItem[], id: string, text: string): ChecklistItem[] =>
  items.map((item) => {
    if (item.id !== id) {
      return item;
    }
    if (item.checked) {
      return { ...item, text, checked: false, stale: true };
    }
    return { ...item, text };
  });

/* Toggle an item's resolved state, optionally recording the creator's per-item
   note in the same gesture. Re-checking a stale item clears the stale flag (it
   has been re-verified). Pure: returns a new array. */
export const setChecklistItemChecked = (
  items: ChecklistItem[],
  id: string,
  checked: boolean,
  note?: string
): ChecklistItem[] =>
  items.map((item) => {
    if (item.id !== id) {
      return item;
    }
    const next: ChecklistItem = { ...item, checked };
    if (note !== undefined) {
      next.note = note;
    }
    if (checked) {
      // Re-verified — the check is fresh again.
      delete next.stale;
    }
    return next;
  });

/* Set the creator's per-item exception note. Pure: returns a new array. */
export const setChecklistItemNote = (items: ChecklistItem[], id: string, note: string): ChecklistItem[] =>
  items.map((item) => (item.id === id ? { ...item, note } : item));

/* Set the checker's per-item rework note (bounce-back context). Pure: returns a
   new array. */
export const setChecklistItemCheckerNote = (items: ChecklistItem[], id: string, checkerNote: string): ChecklistItem[] =>
  items.map((item) => (item.id === id ? { ...item, checkerNote } : item));

/* True when every item is checked (resolved). An empty checklist counts as
   fully resolved. Drives the "N items still open" cue, not a hard gate — the
   checker can approve with exceptions. */
export const allChecklistResolved = (items: ChecklistItem[]): boolean => items.every((item) => item.checked);

/* Count of unresolved (unchecked) items. */
export const unresolvedCount = (items: ChecklistItem[]): number => items.filter((item) => !item.checked).length;

const hasRole = (user: UserIdentity, role: "FILE_CHECKER" | "ADMIN"): boolean => user.roles.includes(role);

/* Is this user acting as the fraud CHECKER for the task? The assignee (or an
   admin), and — because it's a FRAUD task — a FILE_CHECKER. Mirrors
   workflow.ts canFraudCheckerAct so the checklist gate agrees with the
   lifecycle gate. */
const isChecker = (task: LoanTask, user: UserIdentity): boolean =>
  hasRole(user, "FILE_CHECKER") && (task.assignee?.id === user.id || hasRole(user, "ADMIN"));

/* Is this user acting as the CREATOR (requester) for the task? The task creator
   or an admin. */
const isCreator = (task: LoanTask, user: UserIdentity): boolean =>
  task.createdBy.id === user.id || hasRole(user, "ADMIN");

/* The distinct checklist operations, gated by turn (#44 permissions-by-turn):
     - CLAIMED (checker's initial pass): checker builds the list.
     - AWAITING_ITEMS (creator's turn): creator ticks / notes / adds / submits;
       the checker may ALSO add items and add per-item checker notes.
     - PENDING_APPROVAL (checker's turn): checker edits text (→ uncheck+stale),
       adds items, re-checks, sets checker notes.
   Nobody ever deletes (there's no delete op at all). Non-FRAUD tasks and closed
   tasks allow nothing. */
export type ChecklistOp =
  | "add"
  | "editText"
  | "toggle"
  | "creatorNote"
  | "checkerNote"
  | "submissionNotes";

export const canEditChecklist = (task: LoanTask, user: UserIdentity, op: ChecklistOp): boolean => {
  if (task.taskType !== "FRAUD") {
    return false;
  }
  const checker = isChecker(task, user);
  const creator = isCreator(task, user);
  if (!checker && !creator) {
    return false;
  }

  switch (task.status) {
    case "CLAIMED":
      // Checker's initial pass — building the outstanding-items list.
      return checker && (op === "add" || op === "editText" || op === "toggle" || op === "checkerNote");
    case "AWAITING_ITEMS":
      // Creator's turn: resolve, annotate, extend, set submission context.
      if (creator && (op === "toggle" || op === "creatorNote" || op === "add" || op === "submissionNotes" || op === "editText")) {
        return true;
      }
      // Checker may still pile on items and per-item checker notes.
      return checker && (op === "add" || op === "checkerNote");
    case "PENDING_APPROVAL":
      // Checker's review turn: edit (→ stale), add, re-check, annotate.
      return checker && (op === "add" || op === "editText" || op === "toggle" || op === "checkerNote");
    default:
      return false;
  }
};
