# Claiming, Poop Points, And Leaderboard

## Claiming Rules

- Claiming is first-come-first-serve
- Unclaim is allowed
- Claim tasks section is hidden when there are no claimable tasks

## Poop Points Rules

- Stored field remains numeric `points`
- User-facing points name is `Poops`
- All task types, including OOO, use poop points
- Poop points are awarded on completion (FRAUD: only at final `Completed`,
  see [fraud-workflow.md](fraud-workflow.md#scoring))
- Task cards show per-task points as `1`-`5` repeated poop emojis
- The create-task form uses a 5-emoji left-to-right picker:
  - Inactive slots are monochrome poop emoji styling
  - Active slots are full-color poop emojis
- Poop points are only set at task creation time
- Poop points cannot be edited after a task is created
- Legacy tasks missing points are backfilled to `1`

## Claims Leaderboard (Metrics Panel)

There is no standalone `Leaderboard` tab. "Who Is Claiming Tasks" is a
section inside the admin-only Metrics tab (`MetricsPanel` in
`apps/web/src/App.tsx`) — see [ui.md](ui.md#metrics-tab).

- Admin-only, not visible to regular users
- Counts **claims**, not poop points: one point per task where the user is
  `assignee`, across every status (not just closed) and all time (no
  week/month window)
- Ranked descending by claim count; ties keep insertion order (no explicit
  tie-breaker)
- Recomputed live from the current task list — no separate score ledger,
  so unclaiming/reassignment changes the count immediately
