import { LoanTask, TaskStatus } from "./types.js";

/* A single role-aware fraud button (#39). `transition` is a plain one-tap move
   (Submit for Approval / Approve); `transitionWithNote` reveals an inline note
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
     - AWAITING_ITEMS    → creator: Submit for Approval
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
      ? [{ kind: "transitionWithNote", label: "Send Outstanding Items", targetStatus: "AWAITING_ITEMS" }]
      : [];
  }
  if (task.status === "AWAITING_ITEMS") {
    return role === "CREATOR" ? [{ kind: "transition", label: "Submit for Approval", targetStatus: "PENDING_APPROVAL" }] : [];
  }
  if (task.status === "PENDING_APPROVAL") {
    if (role === "CHECKER") {
      return [
        { kind: "transition", label: "Approve", targetStatus: "COMPLETED" },
        { kind: "transitionWithNote", label: "Send Back", targetStatus: "AWAITING_ITEMS" }
      ];
    }
    if (role === "CREATOR") {
      // Only meaningful while the original checker still holds it; once released
      // (unassigned) there's nothing more for the creator to do here.
      return task.assignee ? [{ kind: "release", label: "Release for any fraud checker" }] : [];
    }
  }
  return [];
};
