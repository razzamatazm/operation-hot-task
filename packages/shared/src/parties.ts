import { LoanTask, UserIdentity } from "./types.js";

/* Who has a stake in a task.

   This lived in `notes.ts` for historical reasons — the unread-message
   calculation was the first thing that needed it — and it is about parties,
   not notes. ADR-0008 rule 5 makes it a rule about *permission* as well:
   "only the two parties" is now the answer for correcting an LOI's terms
   (`amendRefusal`), and #266 narrows Loan editing to the same predicate. Three
   unrelated surfaces asking one question is the point; a file called `notes`
   is the wrong place to go looking for it. */

/* A Party (CONTEXT.md) — the task's creator or its current assignee, the two
   people with a stake in it. Anyone else is an Observer: they can see the task
   but have no move to make on it.

   Takes the two fields it reads rather than a whole `LoanTask`, so a caller
   holding a narrower shape — a permission rule written against the handful of
   fields it judges — can ask it without widening itself. */
export const isTaskParty = (
  task: Pick<LoanTask, "createdBy" | "assignee">,
  user: Pick<UserIdentity, "id">
): boolean => task.createdBy.id === user.id || task.assignee?.id === user.id;
