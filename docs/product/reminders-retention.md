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
staffing problem rather than one person's lateness, and telling the creator their
own request is late is not something they can act on. See
[ADR-0005](../adr/0005-claim-anchored-deadline.md).

There is only one overdue message, because there is only one way to be overdue:
the window that started when you took the task ran out. A task picked up outside
business hours starts its clock at the next business open, so nobody is ever
handed something that is already late.

## The unclaimed task

Nothing chases an `Open`, unassigned task on a schedule. Its creator's own row
counts up ("unclaimed for 10 minutes") and turns red at **20 minutes** — the
creator is the one person who can act on the answer, by chasing a human. **OOO
tasks are excluded**: a vacation notice is born unassigned and stays that way
until it auto-completes on the return date, so it is never waiting on hands.

Asking the group channel to pick the task up, on the same cadence, is a separate
change — see
[#207](https://github.com/razzamatazm/operation-hot-task/issues/207).
