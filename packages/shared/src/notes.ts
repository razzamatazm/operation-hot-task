import { LoanTask, UserIdentity } from "./types.js";

/* A Party (CONTEXT.md) — the task's creator or its current assignee, the two
   people with a stake in it. Anyone else is an Observer: they can see the task
   but have no move to make on it. */
export const isTaskParty = (task: LoanTask, user: Pick<UserIdentity, "id">): boolean =>
  task.createdBy.id === user.id || task.assignee?.id === user.id;

/* Latest review-note timestamp from someone other than `userId`. Empty string
   when there is no such note.

   Deliberately not exported. It is half of the attention question, and handing
   half out is what #161 was: a caller took the note lookup, paired it with its
   own idea of who counts, and got the second half wrong. Callers ask
   `unreadNoteFor` instead and get the whole answer. */
const latestNoteFromOther = (task: LoanTask, userId: string): string => {
  let latest = "";
  for (const n of task.reviewNotes ?? []) {
    if (n.by.id !== userId && n.at > latest) latest = n.at;
  }
  return latest;
};

/* The note this viewer has yet to read, or undefined when nothing here wants
   their attention. Returns the timestamp rather than a bare yes/no because the
   caller that shows the signal is also the caller that acknowledges it, and
   acknowledging means writing back exactly the note that was counted unread.
   Handing back one value keeps the flag and the acknowledgement in lockstep;
   computing them separately is how they drift.

   Two conditions, and the whole point of this function is that they are asked
   together. A note is unread if it is newer than what the viewer has
   acknowledged (`seenNoteAt`, undefined when they've acknowledged nothing) —
   but it only *means* anything if the viewer is a Party. An Observer has
   acknowledged nothing by definition, so under the note check alone every note
   on every task in the list read as unread at them; that was #161, and it lit
   up all three of the card's attention signals for work that wasn't theirs.

   The party check is folded in here rather than left to each caller because
   the bug was exactly a caller combining the two by hand and forgetting half.
   Callers get the answer, not the ingredients.

   Deliberately says nothing about status. Whether a card is open is no longer
   derived from anything — cards stay collapsed until the viewer opens them —
   so this answers only "is there something here for you to read". */
export const unreadNoteFor = (
  task: LoanTask,
  user: Pick<UserIdentity, "id">,
  seenNoteAt: string | undefined
): string | undefined => {
  if (!isTaskParty(task, user)) return undefined;
  const latestOther = latestNoteFromOther(task, user.id);
  if (!latestOther || latestOther <= (seenNoteAt ?? "")) return undefined;
  return latestOther;
};

/* The same question as a plain predicate, for callers that only need the
   yes/no — the grouped view's message-pull, which moves a task's court but has
   nothing to acknowledge. One walk, one rule, stated once above. */
export const hasUnreadNoteForViewer = (
  task: LoanTask,
  user: Pick<UserIdentity, "id">,
  seenNoteAt: string | undefined
): boolean => unreadNoteFor(task, user, seenNoteAt) !== undefined;
