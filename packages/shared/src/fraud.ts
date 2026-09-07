import { submitBlockReason, unresolvedForSubmit } from "./checklist.js";
import { ACTION_LABELS } from "./labels.js";
import { fraudSeat } from "./fraud-seat.js";
import { LoanTask, TaskStatus, UserIdentity } from "./types.js";
import { botAdvanceFor } from "./workflow.js";

/* A single seat-aware fraud button (#39). `transition` is a plain one-tap move
   (Submit / Approve); `transitionWithNote` reveals an inline note
   the server requires as reviewNotes (Send Outstanding Items / Send Back);
   `release` hands a PENDING_APPROVAL task back to the checker pool. Consumed by
   the bot DM cards (apps/server) and the web courts view (apps/web) so both
   render the same button set. */
export interface FraudCardAction {
  kind: "transition" | "transitionWithNote" | "release";
  label: string;
  targetStatus?: TaskStatus;
  /* Present when the move is offered but not currently allowed by the task's
     state — today only Submit, held back until every checklist item is checked
     or noted (#184). The surface renders the button disabled and shows this as
     the reason; the same sentence is what the server's refusal would say, so
     nobody learns the rule by being bounced. Absent means "go ahead". */
  blockedReason?: string;
  /* How many items are blocking, alongside the sentence rather than recomputed
     by each surface — a narrow slot (the web row's 116px action column) shows
     the count where the full sentence won't fit, and it must never disagree
     with the reason sitting next to it. Set exactly when `blockedReason` is. */
  blockedCount?: number;
}

/* Why a hand-back is blocked on a surface that cannot take a note, or
   `undefined` when it isn't. The two moves that enter AWAITING_ITEMS — the
   checker's first send and a bounce-back from final approval — cannot go out
   empty; the server enforces "a note or at least one checklist item". A surface
   with no note field therefore has exactly one way to satisfy it, and this is
   the sentence it says so with. Phrased like `submitBlockReason` next door,
   because a checker meets both gates in the same slot. */
export const handBackBlockReason = (task: LoanTask): string | undefined =>
  (task.checklist?.length ?? 0) > 0 ? undefined : "Add at least one outstanding item first";

/* What a surface can carry alongside the move. A bot's Adaptive Card has a text
   input and no way to build a checklist, so it keeps the note-only path the
   server still honours. The web app has the checklist itself and a conversation
   thread beside it, so it took its free-text box out (2026-09-07): the
   outstanding items ARE the list, and anything else a checker wants to say is a
   message, not a third place to type. Default is note-capable, so the bot and
   any future caller keep the older, more permissive path unless they opt out. */
export interface FraudActionOptions {
  noteCapable?: boolean;
}

/* Seat-aware fraud buttons by (status, seat) (#39). Empty for non-FRAUD tasks
   and for any (state, seat) with no action:
     - CLAIMED           → checker: Send Outstanding Items (note)
     - AWAITING_ITEMS    → creator: Submit
     - PENDING_APPROVAL  → checker: Approve + Send Back (note)
                           creator: Release for any fraud checker (while assigned)
   `botPrimaryAdvance` gives the single forward step; this adds the extra
   seat-specific buttons (Send Back, Release) the primary advance can't express. */
export const fraudCardActions = (
  task: LoanTask,
  viewer?: Pick<UserIdentity, "id" | "roles">,
  options?: FraudActionOptions
): FraudCardAction[] => {
  if (task.taskType !== "FRAUD" || !viewer) {
    return [];
  }
  const seat = fraudSeat(task, viewer);
  /* On a surface with no note field the checklist is the only payload, so an
     empty one blocks the move here rather than being discovered at the server.
     Note-capable surfaces are unaffected and still get an unblocked button. */
  const handBackBlocked = options?.noteCapable === false ? handBackBlockReason(task) : undefined;
  if (task.status === "CLAIMED") {
    return seat === "checker"
      ? [{
          kind: "transitionWithNote",
          label: ACTION_LABELS.SEND_OUTSTANDING_ITEMS,
          targetStatus: "AWAITING_ITEMS",
          ...(handBackBlocked ? { blockedReason: handBackBlocked, blockedCount: 0 } : {})
        }]
      : [];
  }
  if (task.status === "AWAITING_ITEMS") {
    if (seat !== "requester") {
      return [];
    }
    // Submit hands the ball back, so it waits until the requester has resolved
    // every item — checked, or unchecked with a note saying why (#184).
    const blocking = unresolvedForSubmit(task.checklist ?? []);
    const blockedReason = submitBlockReason(task.checklist ?? []);
    return [
      {
        kind: "transition",
        label: ACTION_LABELS.SUBMIT,
        targetStatus: "PENDING_APPROVAL",
        ...(blockedReason ? { blockedReason, blockedCount: blocking.length } : {})
      }
    ];
  }
  if (task.status === "PENDING_APPROVAL") {
    if (seat === "checker") {
      return [
        { kind: "transition", label: ACTION_LABELS.APPROVE, targetStatus: "COMPLETED" },
        {
          kind: "transitionWithNote",
          label: ACTION_LABELS.SEND_BACK,
          targetStatus: "AWAITING_ITEMS",
          ...(handBackBlocked ? { blockedReason: handBackBlocked, blockedCount: 0 } : {})
        }
      ];
    }
    if (seat === "requester") {
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

   `showAdvance` gates the single forward step on whether the move is this
   viewer's to make, by asking the same predicate the server will ask on the tap
   (#182). It used to ask whether the advance target happened to be COMPLETED and
   restrict only that one to the assignee, leaving every earlier step
   status-driven — so a Loan Docs assignee was offered Approve Merge, which is
   the creator's move, and the creator was offered Merge Done, which is the
   assignee's. Complete staying assignee-only now falls out of the rule instead
   of sitting beside it. A FRAUD task carries its seat-aware two-phase set
   instead, which is why `fraudActions` is present-but-possibly-empty for fraud
   and absent otherwise — that presence is what tells the card which button set
   to render. */
export interface TaskCardRecipient {
  userId: string;
  showAdvance: boolean;
  fraudActions?: FraudCardAction[];
}

/* Takes identities rather than ids because a fraud card's button set turns on
   the viewer's seat, and a seat needs a live role to enter — and because the
   advance gate now runs the same permission predicate the server runs, which
   takes an identity too. */
export const taskCardRecipients = (task: LoanTask, viewers: UserIdentity[]): TaskCardRecipient[] => {
  const isFraud = task.taskType === "FRAUD";
  const seen = new Set<string>();
  const unique = viewers.filter((viewer) => {
    if (viewer.id.trim().length === 0 || seen.has(viewer.id)) {
      return false;
    }
    seen.add(viewer.id);
    return true;
  });
  return unique.map((viewer) => ({
    userId: viewer.id,
    showAdvance: Boolean(botAdvanceFor(task, viewer)),
    ...(isFraud ? { fraudActions: fraudCardActions(task, viewer) } : {})
  }));
};
