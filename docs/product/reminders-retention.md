# Overdue Reminders And Retention

- Reminder cadence: every 1 hour
- Reminders only during business hours
- Business hours:
  - `8:30 AM` to `5:30 PM`
  - `America/Los_Angeles`
- Stop reminders when status is:
  - `Completed`
  - `Archived`
  - `Cancelled`
- Archived tasks are retained for `3 months`

FRAUD's `Awaiting Items` phase is excluded from this reminder engine — see
[fraud-workflow.md](fraud-workflow.md#reminder-rules).

## Who gets reminded

Overdue reminders are **DMs to the assignee**, and only ever concern claimed
work. An unclaimed task DMs nobody and raises no in-app overdue signal: it is a
staffing problem rather than one person's lateness, so the pressure goes to the
room instead. See [ADR-0005](../adr/0005-claim-anchored-deadline.md).

There is only one overdue message, because there is only one way to be overdue:
the window that started when you took the task ran out. It names the task rather
than the person — "your time's up on <folder>" — since the recipient is by
definition the one holding it. A task picked up outside
business hours starts its clock at the next business open, so nobody is ever
handed something that is already late.

## The pool nag

An `Open`, unassigned task re-posts to the group channel **every 20 minutes**
during business hours until somebody claims it. Flat 20 minutes at every
urgency. In practice the gap is 20-25 minutes and the six asks span a little
over two hours: the scheduler wakes every 5 minutes, so a nag lands on the first
tick past the threshold rather than on the threshold itself. **OOO tasks are excluded** — a vacation notice is born unassigned and
stays that way until it auto-completes on the return date, so it is never
waiting on hands.

- It is a **new** channel post each time. An in-place card edit notifies nobody,
  which is the entire point.
- Each nag deletes the nag before it, never the original creation card, so the
  channel holds at most two cards per unclaimed task.
- No `@mention` of anyone.
- **It stops after six asks.** Two hours of business time is the point at which
  the room has been told and repeating it is noise rather than pressure. What
  remains is the original claimable card and the creator's own count-up row,
  both aimed at somebody who can still act.
- Claiming stops it, and resets the count: a task that comes back to the pool
  later is a fresh ask of the room, not a continuation of the old one. A reopen
  does not reset it — nobody took the task, so nothing has been earned.
- Unclaiming restarts the cadence from the unclaim, since the re-posted
  claimable card is itself the first nag. The same is true of a reopen back to
  `Open` from a closed status — both doors post a card, so both count as nag
  zero.
- The creator's own row counts up ("unclaimed for 10 minutes") and turns red at
  20. Both surfaces read the same 20-minute constant **and the same anchor** —
  the moment the task entered the pool, not the moment it was filed (#210) — so
  neither the threshold nor the number can drift between them.
- The anchor is only recorded from #210 onwards. A task handed back **before**
  that shipped has no stamp and falls back to its filing date, so it will
  overstate itself once more until somebody takes it or hands it back again.
  Deliberate: there is no way to recover when a past hand-back happened, and
  inventing one would be worse than a stale figure on a handful of rows.
- They can still fall out of step in one direction, on purpose: once the six asks
  are spent, or outside business hours, the channel goes quiet while the row
  stays red. The row answers "how long has my request been sitting", which does
  not stop being true when the room stops being asked.
- Tasks that were already open when this shipped have their clock started at
  first boot rather than at their creation date, so the feature arriving does
  not nag the channel once per task in the backlog.
