# Status Model

- General statuses:
  - `Open`
  - `Claimed`
  - `Needs Review`
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
  standard flow: `Open -> Claimed -> Completed -> Archived`, with
  `Needs Review` as a side-branch off `Claimed` (not part of the forward
  flow)
- From `Needs Review` the task can go forward to `Completed` or back to
  `Claimed`. Both moves are open to the task's creator, its assignee, or an
  (`canMoveNeedsReview`) — a wider gate than the `Merge Done -> Claimed`
  undo, because review is not a handoff to one named person. In the web UI the
  forward move is the collapsed row's quick action; the move back to `Claimed`
  is the hamburger's `Undo Review` entry.

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
