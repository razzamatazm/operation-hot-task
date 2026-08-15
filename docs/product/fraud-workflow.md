# Fraud Lifecycle (Two-Phase Completion)

Fraud checks run a two-phase back-and-forth between the requester (creator)
and the fraud checker (assignee), driven by `FRAUD_FLOW`:
`Open -> Claimed -> Awaiting Items -> Pending Approval -> Completed -> Archived`.

Two new **non-closed** statuses sit between claim and completion:

- `Awaiting Items`: the checker's initial pass is done and the ball is in the
  **requester's** court to gather the outstanding items. This is the phase
  users see as **Outstanding Items**.
- `Pending Approval`: the requester has submitted the items back and the ball
  is in the **checker's** court for final approval. Users see this as
  **Final Approval**.

Both are non-closed, so review notes keep flowing throughout the exchange.
Only `Pending Approval -> Completed` (the checker's **Approve**) closes the
task. Non-FRAUD task types never enter these statuses.

## Forward Moves And Who Can Make Them

- `Claimed -> Awaiting Items` — **checker only** (assignee or admin); the
  "Send Items" action.
- `Awaiting Items -> Pending Approval` — **requester only** (creator or
  admin); the "Submit" action.
- `Pending Approval -> Completed` — **checker only** (assignee/admin,
  FILE_CHECKER); the "Approve" action, gated by the normal completion rule.

## Backward / Recovery Moves

- `Pending Approval -> Awaiting Items` — checker "Send Back" (wants more).
- `Awaiting Items -> Claimed` — checker reopens the initial pass.
- Either non-closed status can be `Cancelled` by the creator or an admin.

## Structured Outstanding-Items Checklist (#44)

The outstanding-items handoff is a structured `checklist: ChecklistItem[]` on
the fraud check, not free text. Each `ChecklistItem` has `{ id, text, checked,
note?, checkerNote?, addedBy: "checker" | "creator", addedOnPass, stale?,
draft? }`. (`draft` marks a fresh, not-yet-handed-off item its adder can still
delete — see gated deletion below.)

Rules:

- **One checked state = resolved.** A check means *collected* OR
  *not-needed*; the per-item `note` explains a non-collection. No separate
  waived/N-A state.
- **Gated deletion (#66).** You may delete an item **you added**, on **your
  active editing turn**, while it is still a fresh **draft** — i.e. before
  the next hand-off. An item is deletable iff `addedBy ===
  checklistSeat(actor)` **and** it's that seat's turn (checker in `Claimed` /
  `Pending Approval`; creator in `Awaiting Items`) **and** it hasn't been
  handed off since it was added (`draft` still set). New items start as
  drafts (`draft: true`); every hand-off transition (Send / Submit / Send
  Back) **commits** all existing items (clears `draft`), locking them
  permanently against deletion so the round-trip fraud record is preserved.
  The **other seat's** items are never deletable — to drop one from
  consideration, check it off and note why. Enforced server-side via
  `canDeleteChecklistItem`; the UI affordance only mirrors it.
- **Both roles add items** (enter-to-add). `addedBy` is derived server-side
  from the actor's real seat, so creator-added items are reliably flagged.
- **Checker text-edit → uncheck + stale.** Editing a checked item's text
  auto-clears the check and sets `stale` ("re-verify"), so a check never
  vouches for a changed requirement; it can then be re-checked (which clears
  `stale`).
- **Per-item notes.** `note` is the creator's exception; `checkerNote` is the
  checker's rework note (set on review / bounce-back).
- **Ordering.** Stable add-order (#96, reverses the earlier float-to-top
  rule) — checking or unchecking an item never changes its position. No
  manual reorder in v1.
- **Pass counter.** `checklistPass` starts at 1 on the first "Send Items"
  and increments on each bounce-back; new items stamp the current pass in
  `addedOnPass`.
- **Creator seeds at creation (#69).** On a FRAUD create the requester may
  seed the checklist with outstanding items they already know about
  (`CreateTaskInput.initialItems: { text }[]`). They persist as creator-added
  draft items on pass 0. While the task is `Open` (pre-claim) the creator is
  the active editing seat, so gated deletion lets them manage their own
  seeds until a checker claims and the first "Send Items" commits them.
- **Turn permissions** (server-enforced via `canEditChecklist`): `Open`
  (pre-claim) = the creator seeds / manages their own draft list (add / edit
  own text / toggle / note); `Claimed` = the checker builds the list;
  `Awaiting Items` = the requester ticks / notes / adds, and the checker may
  also add items, toggle any item (#95), and set checker notes; `Pending
  Approval` = the checker edits
  (→ stale), adds, re-checks, and sets checker notes.
- **Approval gate = the checker.** In `Pending Approval` the checker can
  Approve (allowed even with unresolved items — approve-with-exceptions) or
  Send Back → `Awaiting Items` (pass++). Same `Pending Approval → Completed`
  gate as before.
- **Free-text is the discussion thread, not a dedicated field (#68).** The
  FRAUD card's free-text surface is the shared discussion thread (headed by
  `NOTES_FIELD_LABELS.FRAUD` = "Notes") plus the per-item notes — there
  is **no separate submission-notes field**. The create form's `Notes` (#69)
  seeds that thread.

## Note-Required Hand-Back

Any move *into* `Awaiting Items` (the initial "Send Items" or a
"Send Back") must carry **either** a non-empty checklist **or** a non-empty
note describing what's outstanding — an empty hand-back (no items, no note)
is rejected. When present, the note rides in on the transition as
`reviewNotes` (note + transition in one gesture), is recorded on the task,
and seeds the DM conversation thread. (The checklist is the primary surface;
the note path stays for surfaces that can't build a checklist, e.g. bot
cards.)

## Reminder Rules

- `Awaiting Items` is a wait on the requester and is **fully silent** — it is
  never overdue and is excluded from the reminder engine. The checker is not
  pinged while the requester holds the ball.
- The web row honours this too: instead of a red `OVERDUE BY` badge it shows a
  neutral count-up in the same slot — `WITH REQUESTER` to the checker and
  anyone observing, `WITH YOU` to the requester. It counts from
  `awaitingItemsSince`, stamped on every entry into the status, so a **Send
  Back** restarts it rather than accumulating across passes. (`updatedAt`
  can't serve as the anchor — the requester's own checklist edits rewrite it.)
  Bot cards are static snapshots and carry no counter.
- Entering `Pending Approval` sets a **fresh end-of-day (`Yellow`) clock**
  (recomputed `dueAt`, cleared reminder stamp), then hands off to the normal
  reminder engine (quiet the rest of today, hourly the next business
  morning) so final approval doesn't inherit the task's original urgency.

## Release For Any Fraud Checker

If the assigned checker is unavailable, the requester (or an admin) can
release a `Pending Approval` task back to the pool via
`POST /api/tasks/:taskId/release`. This unassigns **in place** — status stays
`Pending Approval`, only the assignee is cleared — so any FILE_CHECKER can
then claim it and Approve directly (the claim keeps the `Pending Approval`
status rather than snapping back to `Claimed`). A double-release is a
harmless no-op.

## Privacy

The entire two-phase exchange is private — no channel posts. Entering
`Awaiting Items` sends exactly one lifecycle DM to the creator plus the
outstanding-items note as a DM note card; entering `Pending Approval` sends
exactly one DM to the checker. Release notifies in-app only.

## Scoring

Poop points are awarded only when the task reaches the final `Completed`
(the checker's Approve). The intermediate non-closed phases never score. See
[claiming-scoring.md](claiming-scoring.md#poop-points-rules).

## Fraud Card Buttons

FRAUD tasks render a shared, **role-aware** button set (`fraudCardActions` in
`packages/shared/src/fraud.ts`) on both the bot DM cards and the web courts
view, so both surfaces show the same actions to the same viewer — checker:
"Send Items" (note) then "Approve" / "Send Back" (note);
requester: "Submit" and "Release for any fraud checker".
Note-required moves open an inline note box whose text posts as the
transition's `reviewNotes`. The user-facing phase names are **Outstanding
Items** and **Final Approval** across both surfaces.
