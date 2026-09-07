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

/* Has the checker said anything of their own on this task? The second half of
   what satisfies a hand-back, and deliberately scoped to the VIEWER's own
   messages rather than to the thread being non-empty.

   The reason is the requester's replies, not the opening ask. `reviewNotes` is
   empty at creation — the originating ask lives in the task's own field and is
   only *rendered* as the thread's first row — but the requester posts real
   messages all through the exchange, answering items during AWAITING_ITEMS.
   So by the time a check reaches PENDING_APPROVAL its thread is reliably
   non-empty with the requester's words, and a bare "has anyone said anything"
   test would let a checker bounce it back on somebody else's message. It has
   to be the checker's own. A withdrawn message is a tombstone, not a finding,
   so it does not count either.

   Not scoped to the current pass. There is no pass marker on a message the way
   there is on a checklist item (`addedOnPass`), and inventing one to catch a
   checker who wrote something last round and nothing this round would be a lot
   of machinery for a case where they did, in fact, write something. If that
   turns out to matter, stamp messages with the pass rather than approximating
   it with a timestamp comparison here. */
const hasOwnMessage = (task: LoanTask, viewer: Pick<UserIdentity, "id">): boolean =>
  (task.reviewNotes ?? []).some((note) => note.by?.id === viewer.id && !note.deleted);

/* Does this task carry what a hand-back has to carry? The two moves that enter
   AWAITING_ITEMS — the checker's first send and a bounce-back from final
   approval — cannot go out empty, because a hand-back with no content is a
   status change that tells the requester nothing about what to do next.

   Two ways to satisfy it, and they are the two places the card already has for
   words: the outstanding-items checklist, and the conversation beside it. Items
   are the normal answer. The conversation is the answer when the checker has
   nothing outstanding to list and needs to say so — a real outcome of a first
   pass, not an edge case, and one that a checklist-only rule locks out of the
   flow entirely, with no way to hand the check back at all.

   One owner, because the button and the server both ask it. A gate the view
   evaluates separately is a gate the two can disagree about, which is how a row
   comes to offer a move the API refuses. */
export const handBackSatisfied = (task: LoanTask, viewer: Pick<UserIdentity, "id">): boolean =>
  (task.checklist?.length ?? 0) > 0 || hasOwnMessage(task, viewer);

/* Why a hand-back is blocked, or `undefined` when it isn't — the one phrasing,
   shared by the button's disabled hint and the transition's refusal so a checker
   reads the same sentence wherever they meet the gate. It names BOTH exits,
   because a checker with nothing to list has to be told that the conversation is
   the way through; naming only the checklist leaves them at a dead button on a
   check that is going fine. Phrased like `submitBlockReason` next door: a
   checker meets both gates in the same slot. */
export const handBackBlockReason = (
  task: LoanTask,
  viewer: Pick<UserIdentity, "id">
): string | undefined =>
  handBackSatisfied(task, viewer)
    ? undefined
    : "Add an outstanding item, or a note in the conversation saying there is nothing outstanding";

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
  const handBackBlocked = options?.noteCapable === false ? handBackBlockReason(task, viewer) : undefined;
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
