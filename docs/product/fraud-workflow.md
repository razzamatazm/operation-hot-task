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

- `Claimed -> Awaiting Items` — **checker only** (the assignee); the
  "Send Items" action.
- `Awaiting Items -> Pending Approval` — **requester only** (the creator);
  the "Submit" action.
- `Pending Approval -> Completed` — **checker only** (the assignee, who must
  still hold FILE_CHECKER); the "Approve" action, gated by the normal
  completion rule.

## Backward / Recovery Moves

- `Pending Approval -> Awaiting Items` — checker "Send Back" (wants more).
- `Awaiting Items -> Claimed` — checker reopens the initial pass.
- Either non-closed status can be `Cancelled` by the creator.

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
- **Gated deletion (#66).** You may delete or retext an item **you added**,
  **until it is handed to the other person** — i.e. while it is still a fresh
  **draft**. An item is deletable iff `addedBy === fraudSeat(actor)` **and** it
  hasn't been handed off since it was added (`draft` still set). There is no
  *turn* clause: either seat may add at any live status (see turn permissions
  below), so gating clean-up on whose turn it is would trap the off-turn adder
  with an item they could never remove. New items start as drafts
  (`draft: true`); every hand-off **commits** all existing items (clears
  `draft`), locking them permanently against deletion so the round-trip fraud
  record is preserved. The **other seat's** items are never deletable — to drop
  one from consideration, check it off and note why. Enforced server-side via
  `canDeleteChecklistItem`; the UI affordance only mirrors it.
- **What counts as a hand-off, for committing.** Entering `Awaiting Items`
  (Send / Send Back), entering `Pending Approval` (Submit), **and** the
  checker's `Awaiting Items -> Claimed` reopen. Deliberately **not** the claim
  (`Open -> Claimed`): the checker hasn't engaged with the requester's seeded
  list yet, they're building their own, so the requester keeps managing their
  seeds until the first "Send Items" (#69). Editability ends at the hand-off,
  not at the turn change — those coincide everywhere except the claim.
- **Both roles add items** (enter-to-add), at any live status. `addedBy` is
  derived server-side from `fraudSeat(actor)` — **which seat you hold**, not
  whose turn it is — so creator-added items are reliably flagged even when the
  creator adds one mid-`Claimed`.
- **Who added what is visible.** Each row carries the adder's colored initials
  chip (the same per-person color as the card header's assigner→assignee pair)
  between the checkbox and the text. Only ever two people on a task, so it's two
  colors. The chip records *who asked for this*, not who ticked it — who-ticked
  is not stored.
- **Checker text-edit → uncheck + stale.** Editing a checked item's text
  auto-clears the check and sets `stale` ("re-verify"), so a check never
  vouches for a changed requirement; it can then be re-checked (which clears
  `stale`).
- **Per-item notes — one seat, one note.** `note` is the creator's exception;
  `checkerNote` is the checker's rework note (set on review / bounce-back).
  A viewer holds exactly one seat, so a row offers **at most one** `+ note`
  button; which field it writes is derived server-side from the actor's seat,
  never chosen by the client. (Before ADR-0003 an admin satisfied both seat
  predicates and got two identical `+ note` buttons, and the two note endpoints
  let the caller pick the field — so an admin acting as the checker could write
  a note in the requester's name.)
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
- **Turn permissions** (server-enforced via `canEditChecklist`) reduce to two
  rules, replacing the old per-status table:
  1. **Recording reality is always open.** At any *live* status (`Open`,
     `Claimed`, `Awaiting Items`, `Pending Approval`) **both seats** may
     **toggle** any item, **add** an item, and write **their own** note
     (at `Open` that is the requester alone — there is no checker seat until
     someone is assigned)
     (`note` for the requester, `checkerNote` for the checker). A tick means
     "collected / not needed" — a fact about the world that is true the moment
     it happens, so holding it until the ball comes back just loses
     information. The requester collecting a document during the checker's
     initial pass was the case that broke the old table: nobody could tick in
     `Claimed`, not even the checker.
  2. **Changing what's being asked stays owned.** Editing an item's text and
     deleting it are limited to items **you added** and **not yet handed off**
     (see gated deletion). The one exception is the checker's power to retext a
     *committed* item, which uncheck+stales it — that is a deliberate re-ask,
     not a clean-up, and it stays checker-only so the requester can't silently
     rewrite a requirement.
- **Closed means frozen.** `Completed`, `Cancelled` and `Archived` lock the
  checklist entirely. An approve-with-exceptions leaves unresolved items
  unresolved forever, which is the accurate record of what was true at
  approval; a document that turns up afterwards belongs in a note or a new
  task, not a retroactive tick on a closed review.
- **Both sides update live.** Every checklist write broadcasts `task.changed`
  over SSE and the web client swaps the task into state, so a tick by one seat
  appears on the other's screen without a refresh. Writes are deltas applied to
  a fresh read server-side, so simultaneous edits by both seats don't clobber
  each other. No notification fires — a DM per checkbox is how a bot gets
  muted.
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

## Seats

The **checker** seat is held by the assignee **and** requires a live
`FILE_CHECKER` role — only a file checker can check a file, though anybody can
create a file to be checked. The **requester** seat is held by the creator. A
person holds one seat or neither, never both (the creator can never be the
assignee — see [ADR-0003](../adr/0003-creator-is-never-assignee.md)), and admin
grants no seat at all.

Because the role is a live requirement, **removing someone's `FILE_CHECKER` role
— or deactivating them — auto-releases their live Fraud Checks**: the assignee
is cleared in place and the task returns to the pool for any checker, exactly as
a manual release would. Demotion warns the admin which tasks it is about to
release. Without this, a demoted checker's task would strand in whatever status
it sat in, with nobody able to act and nothing to announce it.

## Release For Any Fraud Checker

If the assigned checker is unavailable, the requester can
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
