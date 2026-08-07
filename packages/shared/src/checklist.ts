import { LoanTask, UserIdentity } from "./types.js";

/* Structured outstanding-items checklist for FRAUD checks (#44). Replaces the
   old free-text "outstanding items" handoff with a list the two participants
   pass back and forth: the checker builds it, the creator resolves it, the
   checker approves. Each item is added by one of the two roles on a specific
   pass, carries the creator's per-item exception note and the checker's
   per-item rework note.

   Deletion is GATED, not forbidden (#66): you may delete an item you added
   while it is still a fresh draft on your own turn — before it's handed off to
   the other party. Once a hand-off happens (submit / send / bounce) the item is
   `committed` and permanently undeletable, preserving the round-trip fraud
   record. The OTHER seat's items are never deletable — they leave consideration
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
  /* True while the item is a fresh, not-yet-handed-off draft — the seat that
     added it may still delete it (#66). Set on add; cleared for ALL items on
     every hand-off transition (submit / send / bounce). Once cleared the item
     is committed to the round-trip record and can never be deleted. */
  draft?: boolean;
}

/* Ordering rule (#96, reverses the #44 float-to-top rule): stable add-order,
   regardless of checked state. Checking an item off never moves its position —
   the stored order already is add-order, so this is an identity pass over a
   fresh array. Pure: returns a new array and never mutates the input. */
export const sortChecklist = (items: ChecklistItem[]): ChecklistItem[] => [...items];

/* Append a new (unchecked) item. No id/uniqueness logic here — the caller mints
   the id — so this stays a pure list op. The item starts as a `draft` so its
   adder can still delete it before the next hand-off (#66). Pure: returns a new
   array. */
export const addChecklistItem = (
  items: ChecklistItem[],
  item: { id: string; text: string; addedBy: "checker" | "creator"; addedOnPass: number }
): ChecklistItem[] => [
  ...items,
  { id: item.id, text: item.text, checked: false, addedBy: item.addedBy, addedOnPass: item.addedOnPass, draft: true }
];

/* Remove an item by id. Only ever reached after the gated-deletion invariant
   (canDeleteChecklistItem) has cleared the actor — this stays a pure list op.
   Pure: returns a new array and never mutates the input. */
export const removeChecklistItem = (items: ChecklistItem[], id: string): ChecklistItem[] =>
  items.filter((item) => item.id !== id);

/* Commit every item — clear the `draft` flag so nothing added before this point
   can be deleted anymore. Called on every hand-off transition (submit / send /
   bounce) so a round-trip permanently locks the list against deletion. Pure:
   returns a new array; items already committed are returned untouched. */
export const commitChecklistItems = (items: ChecklistItem[]): ChecklistItem[] =>
  items.map((item) => {
    if (!item.draft) {
      return item;
    }
    const { draft, ...committed } = item;
    void draft;
    return committed;
  });

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

/* Which seat an actor occupies when adding an item — decides `addedBy`, so a
   creator-added item is reliably flagged for the checker. The assignee is the
   checker; otherwise the task creator is the creator; an admin holding neither
   seat is acting for the checker. Derived server-side, never trusted from the
   client. */
export const checklistSeat = (task: LoanTask, user: UserIdentity): "checker" | "creator" =>
  task.assignee?.id === user.id ? "checker" : task.createdBy.id === user.id ? "creator" : "checker";

/* The distinct checklist operations, gated by turn (#44 permissions-by-turn):
     - OPEN (pre-claim, creator's turn #69): the creator seeds/manages their own
       outstanding-items list before any checker claims it.
     - CLAIMED (checker's initial pass): checker builds the list.
     - AWAITING_ITEMS (creator's turn): creator ticks / notes / adds / submits;
       the checker may ALSO add items and add per-item checker notes.
     - PENDING_APPROVAL (checker's turn): checker edits text (→ uncheck+stale),
       adds items, re-checks, sets checker notes.
   Deletion is gated separately (canDeleteChecklistItem) since it depends on the
   specific item, not just the op. Non-FRAUD tasks and closed tasks allow
   nothing. */
export type ChecklistOp =
  | "add"
  | "editText"
  | "toggle"
  | "creatorNote"
  | "checkerNote";

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
    case "OPEN":
      // Pre-claim (#69): the creator seeds and manages their OWN outstanding-
      // items list before a checker picks it up. They own the whole list here,
      // so they may add, fix their own text, tick, and annotate. No checker
      // seat exists yet, so only the creator acts.
      return creator && (op === "add" || op === "editText" || op === "toggle" || op === "creatorNote");
    case "CLAIMED":
      // Checker's initial pass — building the outstanding-items list (add,
      // fix a typo, annotate). Not toggling: nothing's been collected yet.
      return checker && (op === "add" || op === "editText" || op === "checkerNote");
    case "AWAITING_ITEMS":
      // Creator's turn: resolve, annotate, extend.
      // Text-editing is deliberately NOT the creator's op — it's the checker's
      // (and it clears+stales a check), so the requester can't silently rewrite
      // a requirement.
      if (creator && (op === "toggle" || op === "creatorNote" || op === "add")) {
        return true;
      }
      // Checker may still pile on items, add per-item checker notes, and
      // (#95) toggle any item — including ones the creator added — so they
      // can mark something done/not-needed without waiting for a round trip.
      return checker && (op === "add" || op === "checkerNote" || op === "toggle");
    case "PENDING_APPROVAL":
      // Checker's review turn: edit (→ stale), add, re-check, annotate.
      return checker && (op === "add" || op === "editText" || op === "toggle" || op === "checkerNote");
    default:
      return false;
  }
};

/* Which seat is actively editing the list in a given status — the seat whose
   turn it is to add/build. Deletion is only allowed on your own turn, so this
   pins down "your active editing turn." Returns null when it's nobody's build
   turn (any closed/other status). */
const activeTurnSeat = (status: LoanTask["status"]): "checker" | "creator" | null => {
  switch (status) {
    case "OPEN":
      // Pre-claim: the creator is the only active seat (#69).
      return "creator";
    case "CLAIMED":
      return "checker";
    case "AWAITING_ITEMS":
      return "creator";
    case "PENDING_APPROVAL":
      return "checker";
    default:
      return null;
  }
};

/* Gated deletion (#66). An item is deletable iff ALL of:
     1. it was added by the acting seat (item.addedBy === checklistSeat(actor)),
     2. it's currently that seat's active editing turn (checker in CLAIMED +
        PENDING_APPROVAL; creator in AWAITING_ITEMS), AND
     3. it has NOT been handed off since it was added — i.e. it's still a draft
        (no submit / send / bounce has committed it).
   The other seat's items are NEVER deletable (deleting the other party's
   request would erase it from the fraud record — check it off with a note
   instead), and once committed an item is permanently undeletable by anyone.
   Non-FRAUD / closed tasks and non-participants allow nothing. Server-
   authoritative — the client's affordance gating is only a hint. */
export const canDeleteChecklistItem = (task: LoanTask, user: UserIdentity, item: ChecklistItem): boolean => {
  if (task.taskType !== "FRAUD") {
    return false;
  }
  const checker = isChecker(task, user);
  const creator = isCreator(task, user);
  if (!checker && !creator) {
    return false;
  }
  // (3) Committed (handed-off) items lock permanently.
  if (!item.draft) {
    return false;
  }
  const seat = checklistSeat(task, user);
  // (1) Only the seat that added it may delete it.
  if (item.addedBy !== seat) {
    return false;
  }
  // (2) Only on that seat's own active editing turn.
  return activeTurnSeat(task.status) === seat;
};
