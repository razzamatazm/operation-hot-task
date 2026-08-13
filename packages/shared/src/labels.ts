/* Canonical action labels — ONE string per action, for every surface (#116).

   The web collapsed row, the web expanded body, and the Teams bot's Adaptive
   Card buttons all render these exact strings. Nothing may hardcode a label
   literal or wrap one in a view-layer synonym: the web ladder rendering
   "Approve" while the bot rendered "Approve Merge" for the same transition is
   the drift this module exists to prevent.

   Length matters: every label except SEND_OUTSTANDING_ITEMS can land in the
   collapsed row's fixed-width quick-action slot (116px, see
   .task-card-quick-action in apps/web/styles.css). `Approve Merge` is the
   longest of those and sets the ceiling. SEND_OUTSTANDING_ITEMS is
   note-required — it renders only in the expanded body and on bot cards, never
   in the fixed slot, so its length constrains nothing. */
export const ACTION_LABELS = {
  CLAIM: "Claim",
  COMPLETE: "Complete",
  ARCHIVE: "Archive",
  MERGE_DONE: "Merge Done",
  APPROVE_MERGE: "Approve Merge",
  SEND_OUTSTANDING_ITEMS: "Send Outstanding Items",
  SUBMIT: "Submit",
  APPROVE: "Approve",
  SEND_BACK: "Send Back",
  RELEASE: "Release for any fraud checker"
} as const;

export type ActionLabelKey = keyof typeof ACTION_LABELS;
