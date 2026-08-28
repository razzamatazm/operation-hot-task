# Implementation plan: claim-anchored deadlines and the pool nag

Implements [#181](https://github.com/razzamatazm/operation-hot-task/issues/181).
The decision and its rejected alternatives are recorded in
[ADR-0005](../adr/0005-claim-anchored-deadline.md); vocabulary is in
[CONTEXT.md](../../CONTEXT.md#deadlines). This file is the build order and
nothing else.

Two design points were derived during planning rather than settled in the
design session. Both are called out inline as **Derived** and are the first
things to challenge if the build feels wrong.

## Phase 1 — the clamp, in `packages/shared`

`workflow.ts`. Add `computeClaimAnchoredDueAt(urgency, claimedAt, config)`
alongside `computeDueAtFromUrgency` (`:167-210`), delegating to it and then
applying the clamp.

**Derived: the clamp is same-business-day only.** "Clamp to end of business day"
cannot apply unconditionally — `GREEN` is `now + 24h`, which is always past
today's close, so a blanket clamp would collapse every `GREEN` task to this
afternoon. The rule that produces the behaviour asked for is: *if the computed
due time falls on the same local business date as the claim and lands after
close, clamp it to close.* That gives the 4:45pm `ORANGE` claim a 5:30pm
deadline, leaves `GREEN` and `YELLOW` untouched, and makes an after-hours claim
land on a close that has already passed, which is the intended
overdue-on-arrival.

`RED` needs no special case: its window is zero, so it clamps to the claim
instant and is overdue immediately, as decided.

Export it from the package index. No changes to `computeDueAtFromUrgency`
itself, so creation-time behaviour is untouched.

## Phase 2 — recompute at the assignee doors

`apps/server/src/task-service.ts`. Apply at two of the five assignee-write
sites:

- **claim** `:290-298`
- **handoff and self-handoff** `:1224-1232`

Not at born-assigned (`:191`) — creation time and claim time are the same
instant, so `computeDefaultDueAt` already produces the right answer. Not at
unclaim (`:362`) or release (`:430`) — the next claimer recomputes anyway.

Guard both sites with the exemptions: skip when `taskType === "OOO"` and skip
when the task's status is `PENDING_APPROVAL`. Put the exemption in one predicate
in `workflow.ts` rather than duplicating the condition, because the next person
to add an assignee door will copy whichever site they find first.

Clear `lastReminderAt` on recompute, matching what the `PENDING_APPROVAL`
transition already does at `:597-607`.

**Derived: a flag for the inherited-overdue message.** The next-morning DM
("you picked up `<folder>` after hours and it was already past due") has to
distinguish a task that was born overdue at claim from one that simply ran out
of time an hour ago. The claim instant is not persisted, by design. Rather than
scan history on every maintenance tick, set an optional `claimedOverdue?: true`
on the task at claim when the recomputed `dueAt` is already in the past, and
clear it when the first reminder fires. Optional field, absent on every existing
task, so `normalizeTask` (`store.ts:167-177`) needs no change — the same
no-migration pattern `awaitingItemsSince` uses.

## Phase 3 — reminder copy

`task-service.ts:1341-1348`. Three messages, replacing the single
`"Heads up — this one's overdue"`:

- assignee, normal: `your hour's up on <folder>`
- assignee, inherited (`claimedOverdue`): `you picked up <folder> after hours and it was already past due, it's first up today`
- pool nag (Phase 4): `<folder> is still unclaimed after <n> minutes, who's taking it?`

The renderer at `notifications.ts:426-441` appends the folder name because the
existing message doesn't carry one. The new copy names the folder itself, so
either drop the append for these types or drop it from the copy. Don't ship
both.

## Phase 4 — the pool nag

The largest phase and the only one adding a new notification path.

1. **New target** `CHANNEL_NAG` in the `target` union, `packages/shared/src/types.ts:297`.
2. **New optional field** `lastPoolNagAt?: string` on `LoanTask` (`types.ts:182-236`).
3. **Driver** in `runMaintenance` (`task-service.ts:1331-1350`): for every `OPEN`
   task with no assignee, when `isWithinBusinessHours` and `lastPoolNagAt` is
   more than 20 minutes old (or absent and `createdAt` is), emit `CHANNEL_NAG`
   and stamp `lastPoolNagAt`. Flat 20 minutes for every urgency, as decided.
4. **Handler** in `notifications.ts`, before the fallback at `:455`. Posts a new
   channel message via `createChannelThread` (`bot.ts:2296-2320`) — an in-place
   edit notifies nobody (`notifications.ts:200-203`), which is the entire point
   of the feature. Card is `adaptiveTaskCard` with the nag title and the same
   `Claim` action, so it behaves identically to the creation card on tap.
5. **Delete the previous nag, never the creation post.** `StoredThread.posts`
   (`bot.ts:22-30`) records every post but doesn't distinguish them; add a
   `kind: "create" | "nag"` to the post record and delete the prior `nag` via
   `deleteActivity` (`bot.ts:1747`) after the new one lands. Order matters: post
   first, then delete, so a failed post never leaves the channel with nothing.
6. **Claim reconciliation.** `markTaskClaimed` (`notifications.ts:239-244` →
   `bot.ts:2134-2155`) already updates every recorded post, so the surviving nag
   and the creation card both resolve correctly with no change. The "newest live
   card becomes the in-process card" rule falls out of this for free.
7. **Unclaim restarts the cadence**: clear `lastPoolNagAt` at `:362-365` so the
   `CHANNEL_REOPENED` post acts as nag zero.

Channel sends are best-effort and never retried (`bot.ts:1688-1731`), and there
is no rate limiting anywhere in `apps/server/src`. This is the first repeating
channel post in the app; a task unclaimed for a full business day produces 27
posts. That is the accepted bet that tasks are normally claimed immediately.

## Phase 5 — retire the in-app overdue signal for unclaimed work

`collectActiveSignals` (`task-service.ts:1496-1551`). The `OVERDUE` branch at
`:1523-1524` targets `assignee?.id ?? createdBy.id`. Drop the `?? createdBy.id`
fallback so the signal only fires for claimed tasks and only at the assignee.
The creator's unclaimed case is covered by Phase 6 and the channel nag.

## Phase 6 — the web row

`apps/web/src/App.tsx:187-254`, in the `due` display helper.

- **Unclaimed, any viewer who isn't the creator**: show the urgency timeframe
  (`URGENCY_TIMEFRAMES`, `types.ts:98-103`) in place of the countdown. No
  `DUE IN`, no `OVERDUE BY`.
- **Unclaimed, creator**: count up from `createdAt` — `UNCLAIMED FOR 10m` —
  reddening at 20 minutes. Mirrors the existing paused-hold count-up rather than
  inventing a second pattern.
- **Claimed**: unchanged. The existing countdown is now anchored to the claim by
  virtue of `dueAt` having moved, so no display change is needed at all.

## Phase 7 — docs and tests

`docs/product/due-date-urgency.md` states "`Green`: due in 24 real hours **from
creation**", which is the line the issue was filed against. It becomes "from
claim, or from creation while unclaimed". `docs/product/reminders-retention.md`
and `docs/product/notifications-bot.md` both need the nag added;
`notifications-bot.md:50-53` is already stale about `CHANNEL_THREAD` and can be
corrected in passing.

Tests are hand-rolled sim scripts in `scripts/*.mjs`, wired as `npm run test:*`
and aggregated by `test:all` (`package.json:19-53`). `packages/shared/dist` is a
checked-in build artefact and `scripts/assert-dist-fresh.mjs` runs as a pretest,
so `npm run build:sim` before running anything.

New coverage, following the existing fake-notifier style:

- clamp behaviour per urgency, including the `GREEN`-must-not-clamp case and the
  after-hours claim
- exemptions: an OOO task and a `PENDING_APPROVAL` task keep their `dueAt`
  across a claim
- handoff recomputes; unclaim and release do not
- nag cadence: fires at 20 minutes, not at 19, silent outside business hours,
  stops on claim, restarts on unclaim
- nag deletes the prior nag and never the creation post

The existing `scripts/notify-background-sim-test.mjs` asserts exact event
ordering on create and claim (`:121`, `:144`), so adding `CHANNEL_NAG` to the
fan-out will break those assertions by design — update them rather than
loosening them.

## Not in scope

`runMaintenance` persists with a whole-file `replaceTasks` built from a read
taken earlier in the pass (`:1271`, `:1359`), so a concurrent user edit during
maintenance can be clobbered. Phases 2 and 4 both add per-tick writes and widen
that window without creating it. It deserves its own issue against the
`updateTask` queue-slot pattern rather than a fix smuggled in here.
