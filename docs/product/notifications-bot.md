# Notifications And Bot

- Notification channels:
  - In-app notifications
  - Teams bot direct messages
  - Teams bot channel posts
  - Teams activity feed notifications
- Channel-post target is **admin-selectable** in the Admin tab ("Notification
  Channel"): the bot lists every channel it's been added to (labelled
  "Team / Channel" from `channelData`, captured on @mention; falls back to the
  channel name, then the raw conversation id), and the admin picks which one
  group notifications go to. The choice persists in
  `apps/server/data/admin-settings.json` (`notificationChannelId`) via
  `GET/PUT /api/admin/channels`. When unset (default), notifications broadcast
  to **every** channel the bot is in; if the saved channel no longer matches a
  captured one, it falls back to broadcasting so nothing is dropped.

## Routing

- New task created: channel post as an Adaptive Card with a one-tap **Claim**
  button and an **Open in Hot Task** deep link, plus in-app event. The card's
  root message id is recorded per channel (`apps/server/data/bot-task-threads.json`)
  so follow-ups can thread.
  - Title is `[<TASK_TYPE>] <creator> <type phrase>: <file name>`,
    e.g. `[LOAN_DOCS] Tyler needs a set of loan docs done: Smith-1042`.
    Per-type phrase comes from `TASK_NEEDS_PHRASE` (LOI "needs an LOI checked",
    VALUE "needs a Value Check", OOO "is out of office", etc.). The file name
    links to the task's Humperdink link when one exists. Urgency is NOT in the
    title (it moved to the detail block).
  - Detail block is `How Bad` (poop emojis, `—` when 0) / `Urgency` shown as
    its time-frame label ("Within 1 Hour"), not the raw colour code. Folder is
    omitted — the file name is already in the title.
  - **OOO** is special-cased: no type tag/file name. Title reads
    "Out Of Office - <creator> will be out of the office from <start> to
    <return> and needs coverage. Can you help?" (dates via `formatWallDate`),
    and the detail shows the vacation description instead of How Bad/Urgency.
  - **Open in Hot Task** is a Teams deep link to the `loan-tasks-home` tab
    carrying the task id as `subEntityId`. The web app reads it (teams-js
    `page.subPageId`) and expands + scrolls to that task. Requires
    `TEAMS_APP_ID`; the button is omitted when it's unset.
- Task claimed/unclaimed: posted as a **reply in the task's existing thread**
  (not a new full-channel broadcast). Falls back to a fresh channel post if
  the root message id is unknown (e.g. the bot restarted, or the task predates
  threading).
- On claim, the claimer also gets a **full-details DM card** (`DM_CLAIM`):
  type, How Bad, urgency time-frame, **due date**, notes, Humperdink link, an
  **Open in Hot Task** deep link, and a contextual **advance/complete**
  button. This is the one surface where due date is shown in user-facing UI —
  see [due-date-urgency.md](due-date-urgency.md). Where it lands is recorded so
  it stays editable — see [DM Card Sync](#dm-card-sync).
- `Merge Done` and `Completed`: DM task creator
- `Merge Approved`: DM task assignee
- Notes: DM counterpart user as an **interactive note card** — shows the
  recent conversation (last ~5 notes, oldest → newest) with an inline reply
  box and a contextual advance/complete button. The reply box **persists**
  after sending (card refreshes to the updated thread), so a user can send
  several messages in a row. Tapping **Reply** posts the text straight back
  as another review note (which in turn DMs the original author, closing the
  loop). Routed via the `DM_NOTE` target; falls back to a plain DM when there's
  no targeted recipient. Reply resolves the Teams user (`from.aadObjectId`) to
  a stored identity and calls `addReviewNote`; the card refreshes to confirm.
- Reminders: DM assignee, except `Loan Docs` in `Merge Done` where reminder DM
  goes to creator

## DM Card Sync

Channel cards have always tracked a task's status. **DM cards now do too.** Every
status change — from the tab, from a card tap, or from the scheduler — ends with
a silent `DM_CARD_SYNC` that re-renders each participant's existing DM cards in
place, so a card's buttons always show the step that is actually next.

- Covers both DM card kinds: the interactive note/chat card
  (`apps/server/data/bot-note-cards.json`) and the claim-detail card
  (`apps/server/data/bot-detail-cards.json`). The claim card used to be
  fire-and-forget — its activity id was discarded, so its **Complete** button
  could never be taken away once the task moved on. It is now recorded at send
  time, along with the rendered title/detail so a re-render replays the body
  (due date, notes, Humperdink) verbatim.
- **Creates nothing, pings nobody.** Strictly an in-place edit: a participant
  with no card stays without one, nothing is repositioned, and no `summary` is
  set — the status change already had its own notification, and a second ping for
  the same event is spam. This extends to failure: where a note-driven send
  reposts a card whose stored activity id has gone stale, a sync does not — it
  would surface as an unannounced DM. The dead id is left for the next
  note-driven send to repair.
- **Covers the paths that drop the assignee.** Unclaim and the fraud
  `Release for any fraud checker` strip the assignee, so the person whose card is
  now wrong is no longer a participant. Those callers name the ex-assignee
  explicitly (`emitCardSync(task, [exAssigneeId])`) so their card is re-rendered
  too. Claim syncs as well, so a card left over from an earlier claim is retired.
- Who sees which button is one shared rule — `taskCardRecipients`
  (`packages/shared/src/fraud.ts`) — used by the sync, the note card, and the
  chat-seed card alike, so the three can't drift apart.
- **Not terminal-only.** A *wrong* button is worse than a dead one: advancing a
  Loan Docs task in the tab re-arms the DM cards to `Approve Merge` rather than
  leaving `Merge Done` sitting there. Terminal cleanup is just the last step of
  the same rule, which is also why a **re-open re-arms the cards for free**.
- At a terminal status the card becomes a record: a banner (`✅ Completed —
  <folder>` / `🚫 Cancelled` / `📦 Archived`) replaces the headline and every
  action button is dropped. `Open in Hot Task` survives on the detail card.
  **COMPLETED keeps the note card's reply box** — `addCompletedNote` (issue #45)
  still accepts notes on a completed task — while CANCELLED/ARCHIVED lose it.
  The card's Reply therefore routes through `TaskService.addNoteFromCard`, which
  picks `addCompletedNote` for a COMPLETED task and `addReviewNote` otherwise;
  wiring Reply straight to `addReviewNote` would make the surviving reply box a
  button that always errors ("Notes cannot be added to closed tasks").
- Per-viewer button rules match `DM_NOTE` exactly: `Complete` is the assignee's
  action, and a FRAUD task carries its role-aware two-phase set instead of the
  generic advance. The claim-detail card never carries a fraud button (that move
  is note-required and lives on the chat card).
- Runs **above** the `enableDmNotifications` gate, since it sends nothing —
  turning DMs off is no reason to strand a live button on a finished task.
- **Self-heal.** Sync is best-effort and never retried (see Delivery Timing), so
  an update can be dropped. A rejected card tap therefore triggers a re-sync for
  that task (`TaskService.resyncTaskCards`) alongside its toast, so a stale card
  repairs itself the first time anyone touches it instead of staying dead.
- **Known gap:** `bot-note-cards.json`, `bot-detail-cards.json`, and
  `bot-task-threads.json` are never pruned — one entry per task, forever. Left
  deliberately: deleting an entry at terminal would break both the self-heal and
  re-open (`repostReopenedTask` needs the thread record). If growth matters it's
  a retention-sweep concern, not a completion one.

## Card Interactions

- Tapping **Claim** on a card resolves the Teams user (`from.aadObjectId`) to a
  stored identity, claims the task, then refreshes the card (button removed) and
  threads the "grabbed this one" reply. Unknown/inactive users get a toast and
  no claim.
- **Advance/Complete** buttons (note + claim cards) call `botPrimaryAdvance` for
  the next forward step (Merge Done → Approve Merge → Complete for Loan
  Docs; Complete otherwise), then transition via the task service and refresh to
  a confirmation card that offers the *next* step — so a user can step a task all
  the way through from one card. Permission is enforced at transition time
  (toast on failure); the button is status-driven, not role-filtered. A failed
  tap also kicks off a card re-sync — see [DM Card Sync](#dm-card-sync).
- **Fraud two-phase buttons** are the exception — see
  [fraud-workflow.md](fraud-workflow.md#fraud-card-buttons).
- Copy is intentionally personable/casual (e.g. "tossed a new file check on the
  pile", "grabbed this one — on it now"), low on emoji.

## Delivery Timing

Notification fan-out runs **after** the HTTP response, not before it (#119). A
task-mutating request is only obliged to wait for two things: the store write,
and the in-memory SSE broadcast that drives live updates for connected web
clients. Everything else — every notification above, plus the activity-signal
evaluation pass — is dispatched by `TaskService`'s private `background` helper
once the response is already on its way.

What this means in practice:

- **A slow or hanging Teams post no longer stretches the API response.** It used
  to: the notifier swallows its own errors, so a degraded notifier surfaced only
  as a slow request, which is what let a user click Create twice (#115).
- **Delivery is best-effort, and always was.** A failure is caught and logged
  (`background_work_failed`, alongside the existing `notification_send_failed`)
  and never fails the request. There is no retry and no dead-letter queue.
- **Order is preserved per task.** Background work is chained by task id, so a
  task's notifications go out in the same relative order as before — a
  `CHANNEL_COMPLETED` card edit can't overtake the `CHANNEL_CLAIMED` one that
  should precede it. Unrelated tasks fan out concurrently, as they already did
  for concurrent requests.
- **`runMaintenance` is the exception.** The scheduler's pass still awaits its
  own notifications, because nothing is waiting on it and its counts are its
  return value.
- `shareTask`'s reachability probe (`canReachDm`) stays on the request path,
  because `delivered` is part of the response body.

## Bot v1 Scope

- Notifications/reminders
- One-tap claim from channel cards
- Quick add via `/bot new`

## Bot Quick Add Flow

- Ask Folder Name
- Ask task type
- Ask urgency for non-OOO
- Ask return date for OOO
- Ask Poops
- Ask notes
- Ask Humperdink Link for non-OOO
- Show final review with field-level edits
- Show explicit final create confirmation
- Support `/bot back`

## Activity Feed

- Left-rail icon dot is not used
- Teams activity feed is used instead
- Activity type is `systemDefault` for v1
- Activity feed alerts trigger on:
  - State change
  - Hourly reminder cadence during business hours
- Bounce-back condition is `Needs Review`
- Pickup scope is tasks claimable by the user
- Due condition is overdue-only
