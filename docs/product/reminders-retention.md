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

Someone who picks up a task that was *already* past due — an `Urgent Now`, or
anything claimed after business close — gets different wording on the next
business morning, explaining that the task arrived late rather than implying
they let it slip. That copy is sent once.

## The pool nag

An `Open`, unassigned task re-posts to the group channel **every 20 minutes**
during business hours until somebody claims it. Flat 20 minutes at every
urgency.

- It is a **new** channel post each time. An in-place card edit notifies nobody,
  which is the entire point.
- Each nag deletes the nag before it, never the original creation card, so the
  channel holds at most two cards per unclaimed task.
- No `@mention` of anyone.
- Claiming stops it. Unclaiming restarts the cadence from the unclaim, since the
  re-posted claimable card is itself the first nag.
- The creator's own row counts up ("unclaimed for 10 minutes") and turns red at
  20, the moment the room starts being asked.
