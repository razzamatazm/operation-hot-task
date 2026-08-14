/* Canonical action labels — ONE string per action, for every surface (#116).

   The web collapsed row, the web expanded body, and the Teams bot's Adaptive
   Card buttons all render these exact strings. Nothing may hardcode a label
   literal or wrap one in a view-layer synonym: the web ladder rendering
   "Approve" while the bot rendered "Approve Merge" for the same transition is
   the drift this module exists to prevent.

   Length matters: every label here can land in the collapsed row's
   fixed-width quick-action slot (116px, see .task-card-quick-action in
   apps/web/styles.css), so `Approve Merge` — the longest — sets the ceiling.
   SEND_OUTSTANDING_ITEMS used to be exempt: it is note-required, so it lived
   only in the expanded body and on bot cards. It now rides the slot too (the
   checker's one next step on a CLAIMED fraud check, so it belongs where every
   other next step is), which is why it reads `Send Items` rather than the
   full phrase — the slot never resizes to its label. */
export const ACTION_LABELS = {
  CLAIM: "Claim",
  COMPLETE: "Complete",
  ARCHIVE: "Archive",
  MERGE_DONE: "Merge Done",
  APPROVE_MERGE: "Approve Merge",
  SEND_OUTSTANDING_ITEMS: "Send Items",
  SUBMIT: "Submit",
  APPROVE: "Approve",
  SEND_BACK: "Send Back",
  /* Reverse move out of NEEDS_REVIEW back to CLAIMED (#125) — the way back
     when the work isn't done, open to creator, assignee and admin alike
     (canMoveNeedsReview). Named after the status it undoes, the same way the
     hamburger's `Undo Merge Done` is; "Review" rather than "Needs Review"
     because the status reads `IN REVIEW` everywhere it's shown to a user.
     Both are steps backwards that live in the menu, never the collapsed row. */
  UNDO_REVIEW: "Undo Review",
  RELEASE: "Release for any fraud checker",
  /* Row-level Cancel (#117): the creator's terminal fallback in the collapsed
     row's action slot. Same wording as the hamburger's Cancel entry — it drives
     the same two-step confirm. */
  CANCEL: "Cancel",
  /* Handoff (ADR-0002). Two labels for one action, picked on whether the task
     already has an assignee: handing off an unclaimed task and taking one off
     somebody are the same operation, but a menu reading "Assign" over a task
     that already has an owner hides that someone is about to be displaced.
     CONTEXT.md's glossary deliberately keeps "reassignment" out of the domain
     language — this is a point-of-use label, not a second concept. Menu-only,
     never the collapsed row, so neither is bound by the 116px slot. */
  ASSIGN: "Assign",
  REASSIGN: "Reassign"
} as const;

export type ActionLabelKey = keyof typeof ACTION_LABELS;
