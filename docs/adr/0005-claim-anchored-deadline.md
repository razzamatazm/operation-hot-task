# 0005. The deadline restarts when someone takes the task

Status: Accepted. Narrows the reading of `dueAt` established in
[ADR-0004](0004-ordering-by-attention-claim.md).

## Context

`dueAt` was stamped once at creation from urgency plus creation time, and
nothing recomputed it. A task asked for "within 1 hour" that sat unclaimed for
45 minutes was overdue 15 minutes after somebody picked it up, so the assignee
was told they were late for time they never had the task. The row went red, the
countdown was already negative before they touched it, and the reminder engine
started nagging them almost immediately. Reported and confirmed in
[#181](https://github.com/razzamatazm/operation-hot-task/issues/181).

The pool time was real, but attaching it to the assignee was not. Nobody
disputed the deadline; they disputed who was on the hook for the part of it that
elapsed while the task was sitting in a queue.

## Decision

**`dueAt` is recomputed from the task's urgency at the moment an assignee takes
it**, on claim, on every handoff to a different person, and at creation when the
task is filed with an assignee already on it.

A handoff to whoever already holds the task is **not** a recompute, and no longer
raises the question: since
[#208](https://github.com/razzamatazm/operation-hot-task/issues/208) the move is
refused outright rather than silently accepted, so there is no event to re-anchor
on.

#181 had asked for a self-handoff to re-anchor. That was the one line of it this
decision did not implement, because a no-op that silently moved a deadline is a
way to extend your own window with no record of it beyond `updatedAt`. It was
flagged rather than quietly dropped, and the answer came back that self-handoffs
are not a workflow anybody uses.

Nobody may point a task at themselves at all now, so the question this paragraph
used to leave open is closed rather than answered: there is no self-handoff left
to re-anchor on. Taking over a task somebody else is sitting on goes through the
creator instead — they put it back in the pool, and the next holder claims it,
which re-anchors the deadline the way every other claim does. See
[#208](https://github.com/razzamatazm/operation-hot-task/issues/208).

You cannot pick up a task that is already late, because the clock does not start
until somebody takes it. Inside business hours the window runs from the claim
instant, clamped to the end of the business day when it would otherwise overshoot
close. Outside them — evening, before open, or a weekend — it runs from the next
business open instead. Grabbing something at 9pm buys you the morning; it does
not burn your window overnight.

`RED` is the one urgency with no natural window: its creation-time deadline is
the present instant. That stays, because it is what sorts an unclaimed urgent
task to the top of the queue, but a claimed `RED` task gets 15 minutes from its
anchor — long enough to read the task, not long enough to stop being the most
urgent thing in the list. It is exempt from the end-of-day clamp, since clamping
it near close would hand somebody a five-minute deadline.

**OOO is the only exemption.** An OOO task's `dueAt` is the person's return date
and the maintenance pass auto-completes the task when it passes, so moving it
would end someone's vacation on the wrong day.

`PENDING_APPROVAL` is deliberately not exempt, though an earlier draft of this
decision made it one. It does set its own end-of-business-day clock, but only on
*entry*, and entering a status is not the same event as changing hands. A FRAUD
task released for any checker stays at `PENDING_APPROVAL` with no assignee; the
person who picks it up the next morning would otherwise inherit the previous
holder's expired deadline, which is #181 again one status further along.

**A born-assigned task is anchored at creation.** Creation and claim are the same
instant when a task is filed with an assignee, so it gets the same anchored
window a claim would give it. Without this the one door that never passes through
the claim path hands its assignee a task that is already late — most visibly a
born-assigned `RED` task, due the moment it exists.

**The missed ask becomes the pool's problem, not a record.** Since the original
deadline is gone once the task is claimed, the fix for an unclaimed task blowing
its window is pressure rather than accounting. What ships here is the half of
that which costs nothing to get wrong: an unclaimed task raises no in-app overdue
signal and DMs nobody, and its creator's own row counts up ("unclaimed for 10
minutes") and turns red at 20. Asking the room — a recurring group-channel post
on the same cadence — is deliberately held back to its own decision and its own
change, because a repeating channel post that misfires is loud, public, and
addressed to everybody at once. Tracked in
[#207](https://github.com/razzamatazm/operation-hot-task/issues/207).

## Considered and rejected

**Two clocks: keep `dueAt` as the ask, add an assignee-anchored timestamp.** The
original recommendation, and it follows the `AWAITING_ITEMS` precedent of
separating "whose clock is running" from "when it was due". Rejected because it
makes the creator and the assignee see different overdue states on the same row
at the same moment, which is a support call waiting to happen. It also cost a
persisted field written at five separate assignee-write sites.

**A grace period rather than the full window.** An assignee taking an `ORANGE`
task at T+45 would get some shorter cushion before the original deadline
reasserted. Rejected as the product call: the assignee needs the hour the work
actually takes, not a fraction of it chosen to preserve an ask that has already
been missed.

**Persisting when the assignee took the task**, wanted independently by
[#166](https://github.com/razzamatazm/operation-hot-task/issues/166) for
display. Rejected because history already records `TASK_CLAIMED` and
`TASK_ASSIGNED` with timestamps, and a reference detail behind a hamburger menu
can afford to read it from there.

## Consequences

The queue now orders by remaining time rather than by which ask is oldest. A
task asked for at 2:00 and claimed at 2:55 sorts below one asked for at 2:30,
because its due time moved to 3:55. Accepted deliberately: what is about to blow
up belongs at the top of the list, and the original ask time survives in
`createdAt` and in history for anyone auditing.

A task handed back and forth between two people can have its deadline pushed
indefinitely with nothing recording the original ask. This is the real cost of
recomputing over the two-clock model and it is accepted.

Unclaimed rows no longer show a countdown to anyone but the creator; they show
the urgency timeframe instead. Nobody should be reading a red row about work
they have not agreed to take.
