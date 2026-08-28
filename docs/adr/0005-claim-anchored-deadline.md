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
it**, on claim and on every handoff, including a self-handoff. The window is
measured from that instant and clamped to the end of the business day when it
would otherwise run past close. There is no grace floor: a `RED` task, or one
taken after hours, is simply overdue on arrival, and the next business morning's
reminder says so in those terms rather than pretending the clock just started.

**OOO and `PENDING_APPROVAL` are exempt.** An OOO task's `dueAt` is the person's
return date and the maintenance pass auto-completes the task when it passes, so
moving it would end someone's vacation on the wrong day. `PENDING_APPROVAL`
already recomputes to end of business day on entry and a second recompute would
fight it.

**The missed ask becomes the pool's problem, not a record.** Since the original
deadline is gone once the task is claimed, the fix for an unclaimed task blowing
its window is pressure rather than accounting: an unclaimed task re-posts to the
group channel every 20 minutes during business hours until somebody takes it,
and the creator's own row counts up ("unclaimed for 10 minutes") and turns red
at 20.

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
