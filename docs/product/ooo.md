# OOO Rules

- OOO is a first-class task type
- OOO uses return date instead of urgency input
- Return date is date-only and interpreted in `America/Los_Angeles`
- OOO `dueAt` is computed as `8:30 AM PT` on the return date
- OOO return date must resolve to a future due time **at filing**
- OOO auto-completes from active statuses when the return due time is reached
- **The creator may correct both dates after filing, to any date including one
  already past** (ADR-0008 rule 8, which reverses ADR-0006's exclusion of them).
  Somebody back early fixing the record is the case this exists for; a return
  date that has gone means the next maintenance pass auto-completes the task,
  which is the honest outcome rather than a state to refuse. Start on or before
  return still holds, checked by the same shared rule filing uses. Both dates
  move together on one route, `dueAt` is re-derived from the new return date,
  and the assignee is DM'd when there is one — see
  [task-fields.md](task-fields.md#amending-a-task-after-it-is-filed)
- OOO uses existing people model:
  - Creator = out-of-office person
  - Assignee = covering person when claimed — never the creator; you cannot be
    your own OOO coverage
    ([ADR-0003](../adr/0003-creator-is-never-assignee.md))
- OOO keeps standard claim/unclaim flow using `Open` and `Claimed`
