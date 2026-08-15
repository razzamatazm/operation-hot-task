# 0002. Tasks can be handed off to another user

Status: Accepted.

## Context

Until now, a task's `assignee` could only ever be set by the assignee
themselves. `TaskService.claimTask` hardcodes `assignee = actor`; `unclaim` and
`release` only ever clear it. There was no endpoint, no bot verb, and no UI
anywhere that pointed a task at a third party. The closest thing,
`POST /tasks/:id/share`, DMs someone about a task but deliberately does not
touch `assignee`.

That pull-only model matches the "Up for grabs" culture — work sits in a pool
and people take what they can do. It breaks down in two real cases: a requester
who knows exactly who should do the work and has to nag them into claiming it,
and a task the wrong person picked up, which today can only be fixed by asking
them to unclaim.

## Decision

Add a **Handoff**: `POST /tasks/:taskId/assign`, which sets `assignee` to
someone other than the actor.

- **Anyone authenticated may hand off a task.** No creator/assignee/admin gate.
- **Eligibility is checked on the recipient, not the actor.** A FRAUD task can
  only go to a `FILE_CHECKER`, mirroring `canClaimTask`. The picker filters to
  eligible people and the server rejects ineligible ones.
- An `OPEN` task becomes `CLAIMED`. A task already in flight — `CLAIMED`,
  `NEEDS_REVIEW`, FRAUD's `AWAITING_ITEMS` / `PENDING_APPROVAL` — swaps
  assignee in place with its status untouched. Closed tasks cannot be handed
  off.
- **DMs only.** The recipient gets a full detail card; a displaced assignee gets
  a one-line DM. No channel post, no activity-feed alert.
- Creating a task with an assignee is a single atomic operation
  (`assigneeUserId` on the create payload), not create-then-assign.

## Considered and rejected

**Restricting handoff to the task's parties plus admins**, matching
`canCancelTask` and `canUnclaimTask`. Rejected because the most common trigger
is a bystander who knows who should do the work and is neither creator nor
assignee — exactly the person the rule would have blocked. Share already has no
permission rule at all, so the looser choice is also the consistent one. The
cost is real: anyone can pull a task out from under anyone. The displaced-
assignee DM exists specifically so that is never silent.

**Announcing handoffs to the channel**, the way claims are. Rejected as noise —
a handoff is a conversation between two people, and the channel already saw the
task when it was created.

**A structured `target` / `previousAssignee` on `TaskHistoryEvent`.** Rejected
for now. `TASK_ASSIGNED` records the same free-text `detail` string every other
history event uses. Nothing reads the history API today, so there is no consumer
to justify the schema change; revisit if one appears.

## Consequences

The invariant "`assignee` is only ever the person who claimed it" no longer
holds, and anything reasoning about how a task got its assignee must account for
handoff. The claims leaderboard needs no change — it recomputes live from the
current `assignee`, so a handoff moves the count immediately, which is the
intended behaviour.
