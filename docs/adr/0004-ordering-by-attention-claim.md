# 0004. A live deadline outranks a paused hold

Status: Accepted. Refines the ordering of the active courts described in
[CONTEXT.md](../../CONTEXT.md).

## Context

The grouped view's three active courts (`Needs you`, `Up for grabs`,
`In flight`) sorted every row by raw `dueAt`, soonest first. That works while
every task's deadline means something, and one status broke the assumption.

A Fraud Check in `Awaiting Items` is a hold on the requester. Its `dueAt`
belongs to the requester's original ask, and the product already treats that
clock as dead: `isOverdue` excludes the status, the reminder engine stays silent
on it, and #132 replaced the row's red `OVERDUE BY` badge with a neutral
count-up from `awaitingItemsSince`. The date itself keeps sliding into the past
regardless, so the paused task drifted ever closer to the top of the list — the
one row claiming to be the most urgent thing present was the one row with no
live obligation on anybody's clock. #132 fixed the display half and filed #133
for the ranking half, because the obvious repairs were both wrong: sorting the
status by `awaitingItemsSince` mixes a past anchor with future deadlines and
puts every held task deterministically at the top, and sorting it to the bottom
of the bucket is wrong for the requester, the one person for whom those rows are
actionable.

## Decision

**Ordering is two-tier, and the tier always wins.** Tier one is every task
carrying a live deadline, ordered by `dueAt` ascending as before. Tier two is
the paused hold — a FRAUD task in `Awaiting Items` — which sorts below all of
tier one whatever the dates say, longest-held first among themselves by the
`awaitingItemsSince` anchor. Ties inside a tier resolve by `createdAt` then
`id`, so the order is total and renders identically whatever order the list
arrives in.

**The comparator lives in `packages/shared`.** `byAttentionClaim`
(`packages/shared/src/ordering.ts`) replaces the web's local `byDue`, and the
hand-off anchor helper moves alongside it so the ranking rule and the web's
count-up copy read one definition. An ordering rule that exists only in a React
component has no test seam, which is how the web and the server drifted apart on
who may claim a task (#137).

## Considered and rejected

**Staleness: let a long-held task climb until it demands attention.** A held
task would earn its way back up the list as the wait grew, so nothing could be
forgotten by sinking. Rejected as the product call: it re-creates the original
complaint in slower motion, and "how long has this been sitting" is a different
question from "what is due", answerable by the count-up already on the row.

**Sorting the paused tier by `awaitingItemsSince` on one scale with `dueAt`.**
The anchor is a past timestamp and `dueAt` a future one, so a single numeric
comparison sorts every handed-off task above every live deadline —
deterministically top instead of accidentally top.

**Tiering only the courts where it hurts.** `byDue` is shared by all three
active courts, and a paused task appears in `Needs you` for the requester and
`In flight` for the checker. One rule for both keeps the two seats looking at
the same list in the same order.

## Consequences

For the requester, a Fraud Check they are holding sinks below anything with a
live deadline in their own `Needs you`. That is the accepted reading of "no
deadline loses to a deadline" — the hold is theirs to clear, but it is not
competing with work that has a clock. The count-up on the row remains the signal
for how long they have had it.

Lists with no paused task sort exactly as before. The flat view (its own
status-bucket sort), the `Done` and `Finished` sections (newest-first by
completion), `isOverdue`, the reminder engine and `courtOf` are all unchanged.
