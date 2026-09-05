/* What one Save from the edit form writes, and in what order (#281).

   The order is the whole point. A save dispatches a focused write per field
   that moved — there is deliberately no route that takes a task-shaped body
   (ADR-0008 rule 4, inherited from ADR-0006) — and exactly one of those writes
   can stop and ask a question: a Humperdink link that lands on another loan is
   refused, and the refusal becomes the "fold these two loans together?" dialog
   (#262, #265). So the loan goes first, and everything on the task follows it.
   Declining then means the save did not happen, which is what a person means
   when they back out of it.

   Lifted out of <App> so it can be RUN. What this module promises is an
   absence — after a decline, nothing was written — and an absence is not
   provable by looking at a field afterwards, only by driving a save and
   watching what gets called. <App> boots Teams on import and cannot be driven
   in a test, so logic left inside it can only be asserted as a regex over its
   own source. Framework-free and pure over an injected writer, the same way
   `create-form-state.ts` is pure over the form's values. */
import type { LoanTask } from "@loan-tasks/shared";

import type { AmendApi } from "./App";
import type { TaskEdit } from "./create-form-state";

/* Everything a save can write: the per-field task routes, plus the single call
   that carries the shared Loan record's name and link together. Injected rather
   than imported so a test can record calls instead of making them; <App> passes
   its real `amendApi` and its real `saveLoanFields`.

   Type-only imports throughout, so this module type-strips straight into a node
   test with no build — including `AmendApi`, which erases and so does not drag
   <App> in behind it. */
export interface TaskEditWrites extends AmendApi {
  saveLoanFields: (
    loanId: string,
    taskId: string,
    fields: { name?: string; humperdinkLink?: string }
  ) => Promise<void>;
}

/* The task's name is the loan's name, and this task has no loan behind it yet.
   Its own type rather than a message, so the shell can say so out loud without
   anyone matching on the words — the same reason a declined merge has one. */
export class NoLoanToCorrect extends Error {
  constructor() {
    super("This task isn't linked to a loan yet, so its name can't be corrected here.");
    this.name = "NoLoanToCorrect";
  }
}

/* Everything the ordering needs to know about the task. Deliberately narrow:
   which record each field lands on depends only on the type and the loan behind
   it, so a caller cannot accidentally make this depend on anything else. */
export type SaveTarget = Pick<LoanTask, "id" | "taskType" | "loanId">;

/* Apply one edit. Sequential, not `Promise.all`: a rejection has to stop the
   writes behind it rather than leave the form guessing which of them landed.

   Rejects on the first refusal, having written only what it wrote before it —
   which for the refusal that asks a question is nothing at all. The refetch
   afterwards belongs to the caller: a save runs however many of these it needs
   and the list is the same list at the end either way. */
export const saveTaskEdit = async (task: SaveTarget, edit: TaskEdit, write: TaskEditWrites): Promise<void> => {
  /* The loan record first, because it is the only write that can ask.

     Under the old order the request field went ahead of it, so someone who
     corrected the terms and repointed the link had the terms committed — in the
     task's history, and DMed to whoever was holding the task — before the merge
     dialog appeared. Declining is silent by design, so nothing ever told them.
     The server refuses a colliding link without writing on either loan record,
     so asking first costs nothing and makes the decline mean what it says.

     The name and the link still travel as ONE call: they land on one record,
     and a rename that stuck beside a link that was refused is a half-applied
     edit nobody asked for.

     An OOO task is excluded outright — it has no loan, and its folder name is a
     vacation description of its own, handled at the bottom. */
  if (task.taskType !== "OOO" && (edit.folderName !== undefined || edit.humperdinkLink !== undefined)) {
    if (!task.loanId) throw new NoLoanToCorrect();
    await write.saveLoanFields(task.loanId, task.id, {
      ...(edit.folderName !== undefined ? { name: edit.folderName } : {}),
      ...(edit.humperdinkLink !== undefined ? { humperdinkLink: edit.humperdinkLink } : {})
    });
  }

  /* Then the task's own fields, one focused route each, in the order the form
     reads top to bottom. Nothing here can express a due date: changing the
     urgency re-derives it server-side from the moment of the edit, exactly as
     filing does, and changing an OOO task's return date re-derives it from
     that. */
  if (edit.dates !== undefined) await write.setDates(task.id, edit.dates);
  if (edit.urgency !== undefined) await write.setUrgency(task.id, edit.urgency);
  if (edit.points !== undefined) await write.setPoints(task.id, edit.points);
  if (edit.notes !== undefined) await write.setNotes(task.id, edit.notes);

  /* An OOO task's description is its own words on its own task, so it goes to
     its own focused route (#262). Only OOO reaches this — every other type's
     folder name is its loan's name and went up top. */
  if (task.taskType === "OOO" && edit.folderName !== undefined) {
    await write.setFolderName(task.id, edit.folderName);
  }
};
