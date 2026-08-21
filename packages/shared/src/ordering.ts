import { LoanTask } from "./types.js";

/* When the checker last handed this task to the requester. `awaitingItemsSince`
   is stamped on every entry into AWAITING_ITEMS; tasks already in that status
   before the field existed have none, and fall back to `updatedAt` until their
   next hand-off stamps one. The fallback is deliberately rough — it drifts
   forward on the requester's own checklist edits, which is exactly why the
   stored anchor exists.

   Lives here rather than in the web because two things read it and they must
   agree: this file's ordering tier, and the web's "with requester for 3d"
   countdown copy. */
export const handedOffAt = (task: LoanTask): string => task.awaitingItemsSince ?? task.updatedAt;

/* A task whose deadline has stopped meaning anything. A FRAUD task in
   AWAITING_ITEMS is waiting on the requester: `dueAt` belongs to the original
   ask, `isOverdue` ignores it and the reminder engine stays silent on it — but
   the date keeps sliding into the past regardless (#133). */
const isPaused = (task: LoanTask): boolean => task.taskType === "FRAUD" && task.status === "AWAITING_ITEMS";

const time = (iso: string): number => new Date(iso).getTime();

/* How strongly a task claims the viewer's attention, as a comparator for
   `Array.prototype.sort`. Two tiers, and the tier always wins:

     1. Live deadline — everything else. Soonest `dueAt` first, as before.
     2. Paused — a FRAUD task in AWAITING_ITEMS. Always below tier one whatever
        the dates say, longest-held first among themselves.

   Deliberately not "staleness" (letting a long-held task climb until it demands
   attention): the accepted consequence is that a fraud check the requester is
   holding sinks below anything with a live deadline in their own "Needs you".
   No deadline loses to a deadline.

   Not named for urgency — `LoanTask.urgency` is a different thing, and deadline
   is now only one of the two tiers.

   Ties resolve by `createdAt` then `id`, so the order is total and renders
   identically whatever order the list arrives in. */
export const byAttentionClaim = (a: LoanTask, b: LoanTask): number => {
  const aPaused = isPaused(a);
  if (aPaused !== isPaused(b)) {
    return aPaused ? 1 : -1;
  }
  const primary = aPaused ? time(handedOffAt(a)) - time(handedOffAt(b)) : time(a.dueAt) - time(b.dueAt);
  if (primary !== 0) {
    return primary;
  }
  const created = time(a.createdAt) - time(b.createdAt);
  if (created !== 0) {
    return created;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};
