import { ACTION_LABELS } from "./labels.js";
import { LoanTask, TaskStatus } from "./types.js";
import { botPrimaryAdvance } from "./workflow.js";

/* A single role-aware fraud button (#39). `transition` is a plain one-tap move
   (Submit / Approve); `transitionWithNote` reveals an inline note
   the server requires as reviewNotes (Send Outstanding Items / Send Back);
   `release` hands a PENDING_APPROVAL task back to the checker pool. Consumed by
   the bot DM cards (apps/server) and the web courts view (apps/web) so both
   render the same button set. */
export interface FraudCardAction {
  kind: "transition" | "transitionWithNote" | "release";
  label: string;
  targetStatus?: TaskStatus;
}

export type FraudRole = "CHECKER" | "CREATOR" | "OTHER";

/* A viewer's role relative to a FRAUD task, decided by id. The participants are
   the assignee (fraud checker) and the creator (requester); anyone else is
   OTHER. The server re-checks the real permission on every action, so this only
   decides which buttons to *show*. */
export const fraudRoleFor = (task: LoanTask, viewerId?: string): FraudRole => {
  if (viewerId && task.assignee?.id === viewerId) {
    return "CHECKER";
  }
  if (viewerId && task.createdBy.id === viewerId) {
    return "CREATOR";
  }
  return "OTHER";
};

/* Role-aware fraud buttons by (status, role) (#39). Empty for non-FRAUD tasks
   and for any (state, role) with no action:
     - CLAIMED           → checker: Send Outstanding Items (note)
     - AWAITING_ITEMS    → creator: Submit
     - PENDING_APPROVAL  → checker: Approve + Send Back (note)
                           creator: Release for any fraud checker (while assigned)
   `botPrimaryAdvance` gives the single forward step; this adds the extra
   role-specific buttons (Send Back, Release) the primary advance can't express. */
export const fraudCardActions = (task: LoanTask, viewerId?: string): FraudCardAction[] => {
  if (task.taskType !== "FRAUD") {
    return [];
  }
  const role = fraudRoleFor(task, viewerId);
  if (task.status === "CLAIMED") {
    return role === "CHECKER"
      ? [{ kind: "transitionWithNote", label: ACTION_LABELS.SEND_OUTSTANDING_ITEMS, targetStatus: "AWAITING_ITEMS" }]
      : [];
  }
  if (task.status === "AWAITING_ITEMS") {
    return role === "CREATOR" ? [{ kind: "transition", label: ACTION_LABELS.SUBMIT, targetStatus: "PENDING_APPROVAL" }] : [];
  }
  if (task.status === "PENDING_APPROVAL") {
    if (role === "CHECKER") {
      return [
        { kind: "transition", label: ACTION_LABELS.APPROVE, targetStatus: "COMPLETED" },
        { kind: "transitionWithNote", label: ACTION_LABELS.SEND_BACK, targetStatus: "AWAITING_ITEMS" }
      ];
    }
    if (role === "CREATOR") {
      // Only meaningful while the original checker still holds it; once released
      // (unassigned) there's nothing more for the creator to do here.
      return task.assignee ? [{ kind: "release", label: ACTION_LABELS.RELEASE }] : [];
    }
  }
  return [];
};

/* Who gets a DM card for a task, and which buttons they should see on it.

   One rule, three consumers on the server: the note card sent when a note is
   posted, the chat card seeded on claim, and the silent re-sync that keeps both
   in step with the task's status. They used to spell it out separately and were
   held in agreement only by convention — a viewer could be offered a button on
   one path that the next path took away.

   `showAdvance` gates the single forward step: Complete is the assignee's
   action, so nobody else is offered it, while earlier steps stay status-driven
   (the real permission is re-checked on every tap). A FRAUD task carries its
   role-aware two-phase set instead, which is why `fraudActions` is
   present-but-possibly-empty for fraud and absent otherwise — that presence is
   what tells the card which button set to render. */
export interface TaskCardRecipient {
  userId: string;
  showAdvance: boolean;
  fraudActions?: FraudCardAction[];
}

export const taskCardRecipients = (task: LoanTask, userIds: string[]): TaskCardRecipient[] => {
  const advance = botPrimaryAdvance(task);
  const completeIsAssigneeOnly = advance?.status === "COMPLETED";
  const isFraud = task.taskType === "FRAUD";
  return Array.from(new Set(userIds.filter((id) => id.trim().length > 0))).map((userId) => ({
    userId,
    showAdvance: Boolean(advance) && (!completeIsAssigneeOnly || userId === task.assignee?.id),
    ...(isFraud ? { fraudActions: fraudCardActions(task, userId) } : {})
  }));
};
