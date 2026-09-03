import type { LoanTask, UserIdentity } from "./types.js";

/* Who holds which seat on a Fraud Check, and nothing else.

   This lives below both `fraud.ts` and `checklist.ts` because both need it and
   neither should need the other. It used to sit in `fraud.ts`, which made
   `checklist.ts` import `fraud.ts` while `fraud.ts` imported `checklist.ts`
   back — a value cycle in both directions, so a module-scope `const` added to
   either that read the other's export would have thrown at import time (#227).
   Moving the derivation down deletes the edge rather than reordering it.

   Nothing but the seat derivation belongs here. It is a pure function of a task
   and an identity, and it stays that way — a dependency added here re-arms the
   thing the move removed. */

/* Which side of a Fraud Check's exchange a person occupies *on this task*.
   `null` is a real answer: most people hold no seat on most tasks. */
export type FraudSeat = "checker" | "requester" | null;

/* The one definition of who holds which seat on a Fraud Check (ADR-0003).

   There used to be two, and they disagreed. The card actions decided purely by
   id — no role requirement, no admin case — while the checklist required
   FILE_CHECKER and counted an ADMIN as *both* seats at once. So an admin was
   both seats in one file and neither in the other, and someone who had lost
   FILE_CHECKER was still "the checker" to the buttons but not to the checklist.

   Three rules, and they are the whole of it:

     - The checker seat needs the assignee AND a live FILE_CHECKER role. A role
       gates entry to a seat; it is not a seat, and it stays a live requirement
       — lose the role and you vacate the seat you were holding.
     - The requester seat is the task's creator. No role gates it: anybody can
       ask for a file to be checked.
     - ADMIN grants no seat. Back-end access is not a second identity.

   Seat is derived from **identity, never from status** — that is what keeps
   `addedBy` honest when a seat acts off-turn. At most one seat per person: the
   creator is never the assignee, so the two can't collide. */
export const fraudSeat = (task: LoanTask, user: Pick<UserIdentity, "id" | "roles">): FraudSeat => {
  if (task.taskType !== "FRAUD") {
    return null;
  }
  if (task.assignee?.id === user.id) {
    return user.roles.includes("FILE_CHECKER") ? "checker" : null;
  }
  if (task.createdBy.id === user.id) {
    return "requester";
  }
  return null;
};
