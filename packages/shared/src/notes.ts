import { LoanTask, UserIdentity } from "./types.js";

/* ADR-0008 rules 1–3 — an LOI's terms are a standing description of the loan,
   not message number one.

   Nothing about the data moves. On an LOI the `notes` field has always held
   the terms — labelled "Loan Terms and Contacts", required since day one, and
   always written by the creator at creation, which is exactly why every
   existing LOI's first thread row is already its terms. No column is added and
   nothing migrates. What changes is where that one field is drawn: its own
   bordered section above the conversation, and *out* of the conversation,
   because a copy of the terms living inside the thread has no answer to what
   happens to it when the terms are corrected.

   LOI only. The other five types' fields are the creator's own words about
   their own situation — a Buddy Chat's concerns, an OOO's description — with
   no second party verifying the contents, so they keep one blended field
   rendered as the thread's first message.

   This is one function rather than a `taskType === "LOI"` at each surface
   because the two halves of the rule have to agree: the section shows the
   field exactly when the thread stops showing it. The caller that draws the
   section and the caller that builds the message list read the same answer off
   the same call. Asked separately, a task ends up showing its terms twice, or
   not at all.

   It hands back the text rather than a boolean so a renderer has no reason to
   reach past it for `task.notes`. `undefined` means the field is still a
   member of the thread. */
export const standingTermsFor = (task: Pick<LoanTask, "taskType" | "notes">): string | undefined =>
  task.taskType === "LOI" ? task.notes : undefined;

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
   so this answers only "is there something here for you to read".

   Also deliberately says nothing about `task.notes`. ADR-0008 took an LOI's
   terms out of the thread and flagged this calculation as something that might
   have leant on the thread's first row being the originating note. It never
   did: the walk is over `reviewNotes` alone, so the originating field has never
   been able to read as an unread message at anybody, and taking it out of the
   thread changes nothing here. That is asserted, not assumed — see
   `scripts/loi-terms-section-sim-test.mjs`. */
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
