import type { TaskStatus, TaskType } from "./types.js";

/* The words a person sees for an action or a status, held once for every
   surface. Action labels first (#116); the status names that are fixed across
   surfaces follow at the bottom (`statusDisplayName`, #237).

   Canonical action labels — ONE string per action, for every surface (#116).
   The web collapsed row, the web expanded body, and the Teams bot's Adaptive
   Card buttons all render these exact strings. Nothing may hardcode a label
   literal or wrap one in a view-layer synonym: the web ladder rendering
   "Approve" while the bot rendered "Approve Merge" for the same transition is
   the drift this module exists to prevent.

   Length matters for the labels that ride the collapsed row's fixed-width
   quick-action slot (116px, see .task-card-quick-action in apps/web/styles.css),
   where `Approve Merge` — the longest of them — sets the ceiling. Menu-only
   labels are exempt and deliberately longer: `Release for any fraud checker` and
   `Back to the pool` never enter the slot, and a menu row sizes to its text.
   SEND_OUTSTANDING_ITEMS used to be exempt: it is note-required, so it lived
   only in the expanded body and on bot cards. It now rides the slot too (the
   checker's one next step on a CLAIMED fraud check, so it belongs where every
   other next step is), which is why it reads `Send Items` rather than the
   full phrase — the slot never resizes to its label. */
export const ACTION_LABELS = {
  CLAIM: "Claim",
  /* Claim and land on the task in one tap (#180) — the channel card's claim
     affordance, which replaced the bare Claim there. Card-only: it is a deep
     link, and the web app is already the place it would take you, so it never
     enters the collapsed row's slot. The plain CLAIM above is still what the
     row renders, and what the card falls back to when there is no link to hang
     this on. */
  CLAIM_AND_OPEN: "Claim & Open",
  COMPLETE: "Complete",
  ARCHIVE: "Archive",
  MERGE_DONE: "Merge Done",
  APPROVE_MERGE: "Approve Merge",
  SEND_OUTSTANDING_ITEMS: "Send Items",
  SUBMIT: "Submit",
  APPROVE: "Approve",
  SEND_BACK: "Send Back",
  /* The move out of NEEDS_REVIEW back to CLAIMED (#125, renamed in #237 per
     ADR-0007) — the creator sending the task back to the assignee for a
     confirming look rather than closing it themselves (canMoveNeedsReview,
     ADR-0007). It used to read `Undo Review`, as though it corrected a
     mistake; it is the creator deliberately sending the work back to the
     checker for a confirming second look, so it says that. A step backwards
     that lives in the menu, never the collapsed row, so the 116px ceiling
     does not bind it. */
  SEND_BACK_TO_CHECKER: "Send back to checker",
  RELEASE: "Release for any fraud checker",
  /* The creator's move to take their own request off a holder who has stalled
     on it and put it back where anyone can claim it (#208). Menu-only, and the
     replacement for the self-handoff that used to do this from the other side.
     Reads as where the task ends up, not as something done to the person. */
  RETURN_TO_POOL: "Back to the pool",
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

/* The two statuses whose stored identifier and displayed name deliberately
   differ (#237, ADR-0007 rule 4). Every surface that turns a status into words
   for a person — the web's timeline rail and chip, the bot's DM confirm — asks
   here first and falls back to its own wording only when this returns nothing.

   - `NEEDS_REVIEW` is stored under that name and displays as "Needs
     corrections". The identifier was kept because persisted tasks carry it;
     do not "fix" the mismatch in either direction.
   - A claimed LOI displays as "In review", because a claimed LOI genuinely is
     a task under review — the checker is reading it. That name used to sit
     on NEEDS_REVIEW, where it was wrong: by then the review has happened and
     the checker has found something. LOI only: someone claiming an Out of
     Office cover is not reviewing anything, so the other five types keep
     whatever the surface already called a claimed task. Per-type wording is
     the pattern NOTES_FIELD_LABELS already set.

   Every other status is the surface's own business, and `undefined` says so:
   the rail names steps ("Opened") and the bot finishes a sentence ("is now
   open"), and this module has no opinion between them. */
export function statusDisplayName(status: TaskStatus, taskType: TaskType): string | undefined {
  if (status === "NEEDS_REVIEW") return "Needs corrections";
  if (status === "CLAIMED" && taskType === "LOI") return "In review";
  return undefined;
}
