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
  see [due-date-urgency.md](due-date-urgency.md).
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

## Card Interactions

- Tapping **Claim** on a card resolves the Teams user (`from.aadObjectId`) to a
  stored identity, claims the task, then refreshes the card (button removed) and
  threads the "grabbed this one" reply. Unknown/inactive users get a toast and
  no claim.
- **Advance/Complete** buttons (note + claim cards) call `botPrimaryAdvance` for
  the next forward step (Mark Merge Done → Approve Merge → Complete for Loan
  Docs; Complete otherwise), then transition via the task service and refresh to
  a confirmation card that offers the *next* step — so a user can step a task all
  the way through from one card. Permission is enforced at transition time
  (toast on failure); the button is status-driven, not role-filtered.
- **Fraud two-phase buttons** are the exception — see
  [fraud-workflow.md](fraud-workflow.md#fraud-card-buttons).
- Copy is intentionally personable/casual (e.g. "tossed a new file check on the
  pile", "grabbed this one — on it now"), low on emoji.

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
