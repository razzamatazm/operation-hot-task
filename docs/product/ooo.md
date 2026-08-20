# OOO Rules

- OOO is a first-class task type
- OOO uses return date instead of urgency input
- Return date is date-only and interpreted in `America/Los_Angeles`
- OOO `dueAt` is computed as `8:30 AM PT` on the return date
- OOO return date must resolve to a future due time
- OOO auto-completes from active statuses when the return due time is reached
- OOO uses existing people model:
  - Creator = out-of-office person
  - Assignee = covering person when claimed — never the creator; you cannot be
    your own OOO coverage
    ([ADR-0003](../adr/0003-creator-is-never-assignee.md))
- OOO keeps standard claim/unclaim flow using `Open` and `Claimed`
