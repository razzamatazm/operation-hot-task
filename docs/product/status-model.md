# Status Model

- General statuses:
  - `Open`
  - `Claimed`
  - `Needs corrections` (LOI only — the corrections state, ADR-0007; stored as
    `NEEDS_REVIEW`, and the identifier was kept because persisted tasks carry
    it, so the two deliberately differ — #237)
  - `Cancelled`
  - `Completed`
  - `Archived`
- FRAUD-only statuses (two-phase completion): see
  [fraud-workflow.md](fraud-workflow.md)
  - `Awaiting Items` (`AWAITING_ITEMS`)
  - `Pending Approval` (`PENDING_APPROVAL`)
- **Notes after completion:** a `Completed` task can still receive a review note
  (the card's "Add a note" affordance) without being reopened. The note is
  appended to `reviewNotes` server-side while the status stays `Completed` — no
  transient reopen, so `reopenedFrom`/`completedAt` are untouched and one
  "note added" history event is recorded. Applies to every task type;
  creator/assignee only. `Cancelled`/`Archived` stay closed to notes.
- Loan Docs lifecycle:
  - `Open -> Claimed -> Merge Done -> Merge Approved -> Completed -> Archived`
  - Each merge rung belongs to one named person, and the move is refused for
    anyone else — including an admin, who holds no seat on either
    (`canMarkMergeDone` / `canApproveMerge`):
    - `Claimed -> Merge Done` — the **assignee**, who did the merge
    - `Merge Done -> Merge Approved` — the **creator**, who requested it and
      signs it off. An assignee approving their own merge would defeat the step.
    - `Merge Approved -> Completed` — the **assignee**, the ordinary
      assignee-only completion gate
  - `Merge Done -> Claimed` is allowed as a backward/undo move (assignee or
    ), and `Merge Done` / `Merge Approved` can both be `Cancelled`
    (creator only)
- Non-Loan-Docs, non-Fraud task types (LOI, Buddy Chat, Value, OOO) use the
  standard flow: `Open -> Claimed -> Completed -> Archived`. `Needs corrections`
  is a side-branch off `Claimed` (not part of the forward flow) that exists on
  **LOI only** ([ADR-0007](../adr/0007-loi-corrections-loop.md)); no other task
  type can reach it by any path, and the server names that rule when refused.
- A claimed LOI displays as `In review`, and only an LOI: the checker holding
  it is reviewing it, whereas someone claiming an Out of Office cover is
  reviewing nothing. Every other type's claimed task reads `Claimed`. The rule
  lives in the shared `statusDisplayName` (#237, ADR-0007 rule 4).
- `Needs corrections` is the LOI corrections state: the checker has looked at
  the work, found something, and handed the ball back to the creator.
  - `Claimed -> Needs corrections` — the **assignee**, and only the assignee
    (`canMoveToNeedsReview`). A creator never sends their own request there:
    handing the task over *is* the request. There is no way in from `Completed`;
    finished work is reopened, not corrected.
  - `Needs corrections -> Completed` and `Needs corrections -> Claimed` — the
    **creator**, and only the creator (`canMoveNeedsReview`). Completing is the
    common case (a typo needs no second opinion) and is the one completion in
    the app that is not the assignee's; sending it back to `Claimed` is for
    anything the creator would rather have re-checked. The assignee cannot
    complete from here and cannot pull the task back to themselves; they keep
    the notes thread. Admin confers nothing (ADR-0003); the system actor keeps
    its route in and out.
  - In the web UI the forward move is the collapsed row's quick action; the
    move back to `Claimed` is the hamburger's `Send back to checker` entry —
    worded as the creator asking for a confirming second look, not as an undo.
    Both, and the bot card's button, read `canTransitionStatus` — the same
    question the server asks — so no surface can offer a move the server
    refuses.
  - Any task of another type found in `Needs corrections` at start-up is moved
    back to `Claimed` (if held) or `Open` (if not), with a system-attributed
    history row.

## Reopen / Restore

- Reopening a closed task (`Completed` or `Archived` -> `Open`, which lands
  on `Claimed` when an assignee is retained) records the prior closed status
  on the task as `reopenedFrom`.
- A reopened task offers a **Restore** action that returns it to exactly that
  prior closed status (`Completed` or `Archived`, never just `Open`). Restore
  is permitted for whoever could reopen it — task creator or assignee — and is intentionally NOT assignee-only the way `Complete` is, so a
  creator who reopened their own task can close it back out without the
  assignee acting.
- `reopenedFrom` is cleared as soon as the task reaches any closed status
  again. Restore returns Loan Docs tasks straight to the single prior closed
  status; intermediate merge-chain state is not restored.

## Done-View Retention (UI)

`Cancelled` tasks stay visible in the web Done view for the same closed-task
retention window as `Completed` / `Archived` (they no longer disappear
immediately on cancel). This is a UI filter only; the backend
auto-archive/purge behavior is unchanged — see
[reminders-retention.md](reminders-retention.md).
