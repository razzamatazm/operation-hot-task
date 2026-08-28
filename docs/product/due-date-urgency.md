# Due Date And Urgency

- Due date is tracked backend-only and is not shown as a dedicated field in
  the main tab UI. Exception: the claimer's DM_CLAIM card does surface a
  `due` field — see
  [notifications-bot.md](notifications-bot.md#routing).
- Default urgency for all non-OOO task types is `Green`
- Urgency meanings:
  - `Green`: due in 24 real hours; if the due time lands on a weekend, roll to Monday
  - `Yellow`: needed by end of business day
  - `Orange`: needed within 1 hour
  - `Red`: urgent now
- User-facing urgency labels use timeframe wording:
  - `Within 24 Hours`
  - `End of Day`
  - `Within 1 Hour`
  - `Urgent Now`
- Color is visual styling only
- The window is measured from **whoever currently holds the task**, not from
  creation: claiming or being handed a task recomputes the due time from its
  urgency at that instant, so time spent sitting in the pool is never charged
  to the person who eventually picks it up. See
  [ADR-0005](../adr/0005-claim-anchored-deadline.md).
  - A window that would run past business close on the day it was claimed
    clamps to close. Same-day only — a 24-hour window always lands past today's
    close and is left alone.
  - `Urgent Now`, or any claim made after hours, therefore lands in the past and
    the task is overdue on arrival. There is no grace period; the next business
    morning's reminder says the task was already past due when it was picked up.
  - **OOO tasks and a Fraud Check in `Pending Approval` never recompute.** An
    OOO task's due time is the person's return date and it auto-completes on it;
    `Pending Approval` already sets its own end-of-day clock on entry.
- An **unclaimed** task shows its urgency time-frame rather than a countdown, to
  everyone except its creator, who sees how long it has gone unclaimed (OOO
  excepted — it shows its return date, and is never treated as waiting on
  anyone). Nobody
  should read a red row about work they have not agreed to take.
