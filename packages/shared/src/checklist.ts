import { fraudSeat } from "./fraud.js";
import { LoanTask, UserIdentity } from "./types.js";
import { CLOSED_STATUSES } from "./workflow.js";

/* Structured outstanding-items checklist for FRAUD checks (#44). Replaces the
   old free-text "outstanding items" handoff with a list the two participants
   pass back and forth: the checker builds it, the creator resolves it, the
   checker approves. Each item is added by one of the two roles on a specific
   pass, carries the creator's per-item exception note and the checker's
   per-item rework note.

   Deletion is GATED, not forbidden (#66): you may delete an item you added
   while it is still a fresh draft — before it's handed off to the other party.
   There is no turn clause; either seat may add at any live status, so gating
   clean-up on whose turn it is would trap the off-turn adder with an item they
   could never remove. Once a hand-off happens (send / submit / bounce /
   reopen) the item is `committed` and permanently undeletable, preserving the
   round-trip fraud record. The OTHER seat's items are never deletable — they
   leave consideration only by being checked off with a note explaining why.

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
     added it may still delete or retext it (#66). Set on add; cleared for ALL
     items on every hand-off transition (send / submit / bounce / the checker's
     reopen — not the claim). Once cleared the item is committed to the
     round-trip record and can never be deleted. */
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
   can be deleted anymore. Called on every hand-off transition (send / submit /
   bounce / the checker's reopen) so a round-trip permanently locks the list
   against deletion. The commit boundary is the hand-off, NOT the turn change,
   and deliberately not the claim: nobody has looked at the requester's seeded
   list yet when a checker claims, so those seeds stay theirs to manage until
   the first send. Pure: returns a new array; items already committed are
   returned untouched. */
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

/* Toggle an item's resolved state, optionally recording a per-item note in the
   same gesture — "not needed, because…" is one thought, not two.

   Which note field that lands in comes from the acting `seat`, never from the
   caller: the requester's `note` is their exception, the checker's
   `checkerNote` is their rework note, and neither writes the other's. Since
   both seats may now tick at any live status, a seat-blind version of this
   would let a checker file a note under the requester's name just by ticking.

   Re-checking a stale item clears the stale flag (it has been re-verified).
   Pure: returns a new array. */
export const setChecklistItemChecked = (
  items: ChecklistItem[],
  id: string,
  checked: boolean,
  note?: string,
  seat: "checker" | "creator" = "creator"
): ChecklistItem[] =>
  items.map((item) => {
    if (item.id !== id) {
      return item;
    }
    const next: ChecklistItem = { ...item, checked };
    if (note !== undefined) {
      if (seat === "checker") {
        next.checkerNote = note;
      } else {
        next.note = note;
      }
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

/* The seat vocabulary stored on an item. `fraudSeat` calls the non-checker
   seat the *requester* — the clearer name, since the seat is about which side
   of the exchange you're on — but `addedBy` has said "creator" since #44 and
   there is live fraud-check data using it, so the boundary translates rather
   than migrating. */
export const checklistSeat = (task: LoanTask, user: UserIdentity): "checker" | "creator" | null => {
  const seat = fraudSeat(task, user);
  if (seat === "checker") {
    return "checker";
  }
  return seat === "requester" ? "creator" : null;
};

/* The checklist operations that are open to a whole seat rather than scoped to
   one item. Text-editing and deletion are missing on purpose — both depend on
   WHICH item, so they have their own item-aware predicates below. */
export type ChecklistOp =
  | "add"
  | "toggle"
  | "creatorNote"
  | "checkerNote";

/* Rule one of two: recording reality is always open.

   At any LIVE status, both seats may toggle any item, add an item, and write
   their OWN note field. A tick means "collected or not needed" — a fact about
   the world, true the moment it happens, so holding it until the ball comes
   back just loses information. It never passes the ball, and it fires no
   notification.

   This replaces a per-status table that assumed nothing is collected during the
   checker's initial pass, so in `Claimed` NOBODY could tick — not even the
   checker. A requester who received a document while the check sat there had
   nowhere to record it.

   The only asymmetry left is whose note is whose: `note` belongs to the
   requester and `checkerNote` to the checker, and neither seat writes the
   other's. At `Open` there is no checker seat at all (nobody is assigned), so
   the requester acts alone — that falls out of `checklistSeat` rather than
   being a status rule.

   Closed statuses (Completed / Cancelled / Archived) freeze the list entirely:
   an approve-with-exceptions leaves its unresolved items unresolved forever,
   which is the accurate record of what was true at approval. */
export const canEditChecklist = (task: LoanTask, user: UserIdentity, op: ChecklistOp): boolean => {
  if (task.taskType !== "FRAUD") {
    return false;
  }
  if (CLOSED_STATUSES.includes(task.status)) {
    return false;
  }
  const seat = checklistSeat(task, user);
  if (!seat) {
    return false;
  }
  if (op === "creatorNote") {
    return seat === "creator";
  }
  if (op === "checkerNote") {
    return seat === "checker";
  }
  return true;
};

/* Is this item still the acting seat's to clean up — did they add it, and has
   it not been handed over since? The shared half of rule two, used by both
   deletion and text-editing below. Says nothing about status; each caller
   applies the closed-means-frozen rule itself, where it is visible. */
const isOwnUncommittedItem = (seat: "checker" | "creator", item: ChecklistItem): boolean =>
  Boolean(item.draft) && item.addedBy === seat;

/* Rule two of two: changing what's being asked stays owned.

   Deleting is limited to an item YOU added that hasn't been handed off yet.
   The other seat's items are never deletable — dropping someone's requirement
   is always a visible tick-and-note, never a silent removal — and a committed
   item is permanently undeletable by anyone, which is what makes the
   round-trip record trustworthy.

   There is no "on your active turn" clause (it was removed with the per-status
   table): either seat may now add off-turn, and a turn clause would leave that
   item undeletable by the only person entitled to remove it.

   Server-authoritative — the client's affordance gating is only a hint. */
export const canDeleteChecklistItem = (task: LoanTask, user: UserIdentity, item: ChecklistItem): boolean => {
  if (task.taskType !== "FRAUD") {
    return false;
  }
  if (CLOSED_STATUSES.includes(task.status)) {
    return false;
  }
  const seat = checklistSeat(task, user);
  if (!seat) {
    return false;
  }
  return isOwnUncommittedItem(seat, item);
};

/* Rule two, for text. Your own not-yet-handed-off item is yours to retype —
   that is a clean-up, the same grant deletion gets.

   The checker keeps exactly one power beyond it: retexting a COMMITTED item,
   which uncheck+stales it (see `editChecklistItemText`). That is a deliberate
   re-ask rather than a clean-up, and it stays checker-only so the requester can
   never silently rewrite a requirement they were asked to satisfy. It does not
   extend to the requester's still-uncommitted drafts: those are a list nobody
   has been handed yet, and they stay their author's until a send. */
export const canEditChecklistItemText = (task: LoanTask, user: UserIdentity, item: ChecklistItem): boolean => {
  if (task.taskType !== "FRAUD") {
    return false;
  }
  if (CLOSED_STATUSES.includes(task.status)) {
    return false;
  }
  const seat = checklistSeat(task, user);
  if (!seat) {
    return false;
  }
  if (isOwnUncommittedItem(seat, item)) {
    return true;
  }
  return seat === "checker" && !item.draft;
};
