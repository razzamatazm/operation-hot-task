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

- New task created: channel post as an Adaptive Card with two actions —
  **Claim & Open** and **Open in Hot Task** — plus in-app event. The card's
  root message id is recorded per channel (`apps/server/data/bot-task-threads.json`)
  so follow-ups can thread.
  - Title is `<creator's first name> <type phrase>`, e.g. `Tyler needs a set of
    loan docs done`, composed by `formatNewTaskHeadline`. Per-type phrase comes
    from `TASK_NEEDS_PHRASE` (LOI "needs an LOI checked", VALUE "needs a Value
    Check", OOO "needs OOO Coverage", etc.). Urgency is NOT in the title.
  - The first line of the body names the task the way every later card does,
    `Smith-1042 - LOI Check` (decided 2026-09-12). That puts the type label
    beside a title that often says it already ("Tyler needs a Fraud Check",
    then "Smith-1042 - Fraud Check"): the owner chose one name line shared by
    every stage over avoiding the repeat, reversing the earlier no-type-tag
    call for this card. The file name is plain text, since no Teams card links
    to Humperdink.
  - Under it, `How Bad` (poop emojis, `—` when 0) / `Urgency` shown as its
    time-frame label ("Within 1 Hour"), not the raw colour code.
  - **OOO** is special-cased: no type tag/file name. Title reads
    "Out Of Office - <creator> will be out of the office from <start> to
    <return> and needs coverage. Can you help?" (dates via `formatWallDate`),
    and the detail shows the vacation description instead of How Bad/Urgency.
  - **Open in Hot Task** is a Teams deep link to the `loan-tasks-home` tab
    carrying the task id as `subEntityId`. The web app reads it (teams-js
    `page.subPageId`) and expands + scrolls to that task. Requires
    `TEAMS_APP_ID`; the button is omitted when it's unset.
  - The link is built by `teamsTaskDeepLink(appId, taskId, opts?)` in
    `packages/shared/src/deep-link.ts` — one builder for every surface (bot
    cards, activity feed, and the web app's "Copy link", which fetches the app
    id from `GET /api/config`). It takes two optional params beyond the id:
    `label` (the task's folder name, so the link unfurls readably when pasted
    into a chat) and `webUrl` (where to send someone with no Teams client).
    The server's `webUrl` comes from the **optional** `APP_BASE_URL` env var
    and the param is omitted entirely when it's unset; the web app passes its
    own `window.location.origin`.
  - **Claim & Open** claims the task and lands you on it, in one tap. It is an
    `Action.OpenUrl` on the same deep link carrying an opt-in claim intent, and
    the web app performs the claim on arrival through the ordinary
    authenticated endpoint as the signed-in user. An Adaptive Card action can
    only do one of the two — `Action.Execute` runs server-side and can't
    navigate, `Action.OpenUrl` navigates and hits no API — so the combined
    button is a link, and the claim happens where the user's own token already
    is. Claiming without opening is the rarer path and has no button of its
    own.
    - **The claim intent is opt-in and lives in its own field**
      (`claimOnOpen: true`) inside the link's `context` JSON, beside
      `subEntityId` — never a prefix or sentinel on the task id. Every other
      caller of `teamsTaskDeepLink` (the plain Open button, the DM cards, the
      activity feed, the web app's "Copy link") produces the byte-identical
      view-only URL it always did, so a link pasted into a chat can never claim
      a task for whoever opens it. `withClaimIntent` derives the claim twin from
      a link already recorded, so both buttons point where the card has always
      pointed even across a config change.
    - **The claim never blocks the navigation.** The tab opens on the task
      expanded either way, and it goes through the same claim call every other
      claim in the web app does. A refusal is a toast beside it carrying the
      sentence `claimRefusalMessage` gives, which now names *which* no it is:
      somebody else got there first ("Casey already has this task"), the task
      has left play ("This one is cancelled — there's nothing left to claim"),
      or [ADR-0003](../adr/0003-creator-is-never-assignee.md)'s "you created
      this task". One sentence for all of them was survivable while refusals
      only came from a button the UI had already hidden; on this path a lost
      race and a cancelled task are ordinary outcomes. The web app re-decides
      nothing — `canClaimTask` is still the only authority.
    - **The creator never sees a claim affordance.** They get the Cancel view
      through the card's user-specific refresh block, which needs their Teams
      MRI. When they have never messaged the bot, that MRI now comes off the
      **channel roster** instead of only a stored DM reference — otherwise the
      creator fell back to the claim-for-all card and would be offered a claim
      barred by ADR-0003, which with a link fails *after* navigation. A roster
      that can't place them degrades to the old behaviour rather than failing.
    - **With no deep link there is no Claim & Open**, because there is no link
      to hang it on — `teamsTaskDeepLink` returns undefined whenever the app id
      is unset, which is every local and test environment. The card then renders
      the original one-tap `Action.Execute` **Claim**, so it is still claimable.
      The invoke handler stays wired for that path and for every card posted
      before the change.
    - A claim made this way retires the Claim affordance everywhere, like any
      other claim: the in-place card edit fires on *any* claim, web or card tap.
- **Pool nag** (`CHANNEL_NAG`, [ADR-0005](../adr/0005-claim-anchored-deadline.md)):
  an unclaimed task re-posts a fresh claimable card to the channel every 20
  minutes during business hours, up to six times. A new post rather than an
  edit, because an edit pings nobody. Each nag deletes the previous nag and
  leaves the creation card standing; the post is deleted only after the
  replacement has landed, so a failed post never clears the channel of the only
  claimable card.
- Task claimed/unclaimed: posted as a **reply in the task's existing thread**
  (not a new full-channel broadcast). Falls back to a fresh channel post if
  the root message id is unknown (e.g. the bot restarted, or the task predates
  threading).
- The **root channel card is edited in place** through the task's whole life —
  claimable → claimed → terminal — so a claim made from one card, by any route,
  retires the claim affordance everywhere it was posted. Never a new message: the edits are
  silent, so nobody is re-pinged as a task moves.
  - **Every card after creation is one headline plus one name line**, and
    nothing else, no detail block (reworded 2026-09-12). The headline says who
    did what to whose task, by first name; the line under it names the file and
    its type, `Smith-1042 - LOI Check`. Composed in
    `packages/shared/src/types.ts` (`formatClaimedHeadline` and its siblings,
    and `formatTaskNameLine`).
    - Headlines by stage: `Suzie grabbed Tyler's LOI Check` on claim,
      `✅ Suzie completed Tyler's LOI Check` (also used for ARCHIVED),
      `🚫 Tyler cancelled their LOI Check`. Only the creator can cancel, so the
      cancelled headline names them, and it says "their" because the app holds
      nobody's pronouns.
    - A task born assigned reads `Suzie was assigned Tyler's LOI Check`, since
      nobody grabbed it.
    - **OOO** uses its description in place of the file name:
      `Beach week - Out of Office`.
    - A loan rename rewrites only that name line on the posted card (the first
      line of the new-task card's body), never How Bad or Urgency. A card posted
      before the name moved under the headline gains the line on its first
      rename.
    - The facts are threaded in from the task snapshot the notification layer
      already holds (`channelCardContext` in `apps/server/src/bot.ts`). The card
      layer never reads the store. The user-specific refresh path rebuilds from
      the live task and passes the same facts, so a Teams refresh replays the
      card it was edited to. A card-tap claim and a web claim go through the
      same builder and render the same body.
  - At a terminal status the card becomes a record, with every action button
    dropped except **Open in Hot Task**, which survives so the card that
    records the finished work is still a way into it. The URL is the one
    recorded when the card was first posted, so a card keeps pointing where it
    always pointed across a config change. With no link recorded — the case
    whenever `TEAMS_APP_ID` is unset — the card carries no actions at all.
  - Confirmed 2026-09-12: from the claim on, through completion and
    cancellation, the card keeps Open in Hot Task, the task (type and file
    name), and who claimed or finished whose task. **No Teams card links to
    Humperdink**, the claimable card included: the file name is plain text
    everywhere, and the DM cards carry no Humperdink line.
  - The **re-open pointer card** is the exception: it is deliberately linkless,
    because the task it replaced now lives in a new thread.
- **A claim sends each party one DM, and only one** (`DM_CHAT_SEED`, decided
  2026-09-12). The claimer and the creator both get the **conversation card**,
  and it carries everything a claim needs to say:
  - a title naming the task and its type, `Smith-1042 - LOI Check` (decided
    2026-09-12). An OOO task's description stands in for the file name:
    `Beach week - Out of Office`,
  - a people line, `Created by Tyler Hereford · claimed by Suzie Lim`, which
    says "you" to whichever of the two is reading (`Created by you · claimed by
    Suzie Lim` in Tyler's chat). It says "claimed by" after a handoff too:
    nothing on the task records how the holder got it,
  - the facts: How Bad, urgency time-frame, **due date**, notes (an OOO task
    shows its dates instead),
  - the conversation so far, or "No messages yet. Reply here to chat about it."
    when there is none, with the reply box,
  - **Reply**, the step button for whoever's move it is, and **Open in Hot
    Task**.

  The chat preview says who took it and names the task the way the title does:
  `You claimed Smith-1042 - LOI Check` for the claimer, `Suzie Lim claimed
  Smith-1042 - LOI Check` for the creator (decided 2026-09-12). A claim used to send two
  messages to each person — a details card then the conversation card for the
  claimer, a `claimed` one-liner then the conversation card for the creator —
  and the second of each pair said nothing the first hadn't, so both pings
  fired for one event. The details are rebuilt from the live task on every
  render, so a later urgency, instructions or loan-name change shows on the
  card the next time it is touched.

  **An LOI Check card omits the notes line**: on an LOI that field holds the
  loan's terms, and a card of figures is one people scroll past rather than
  read, so it leans on the deep link instead
  ([ADR-0008](../adr/0008-loi-terms-are-a-field-not-a-message.md) rule 9). The
  facts and the omission come from one builder (`taskFactLines`), shared with
  the share and handoff detail cards. DM task cards are the one place a due date
  is shown in user-facing UI — see [due-date-urgency.md](due-date-urgency.md).
- **Handoff** (`POST /tasks/:id/assign`, see
  [ADR-0002](../adr/0002-task-handoff.md)): **DMs only — no channel post and no
  activity-feed alert.** A handoff is a conversation between two people, and the
  channel already saw the task when it was created.
  - The **channel card** already posted is edited in place (`CHANNEL_ASSIGNED`),
    the same silent edit a claim makes: the Claim button comes off and the
    headline reads `Suzie was assigned Tyler's LOI Check`. A reassign of an
    in-flight task gets the same edit, so the card never names the old holder.
    The thread record remembers who was handed it, as it does for a task
    created already assigned, so a later Teams refresh keeps the wording.
    Cards posted before this edit existed are repaired when the server starts:
    a held task whose holder was handed it, and whose card doesn't record
    that, gets the same edit. A repaired card records its holder, so later
    starts leave it alone.
  - The new assignee gets a `DM_ASSIGN` card: a full-details `detailCard` with
    the same facts the conversation card shows, the contextual
    advance/complete button and the **Open in Hot Task** deep link — and it is
    **tracked** so [DM Card Sync](#dm-card-sync) can refresh its button as the
    task moves on. A handoff does not open the conversation card; that arrives
    with the first note, as it always has. Title reads
    "&lt;actor&gt; assigned Smith-1042 - LOI Check to you", which is also the
    chat preview, so the body carries no Type line. When the actor isn't the
    creator, the body opens with `Created by <creator>`. An optional note (≤ 280
    chars) rides quoted above the facts, exactly as `DM_SHARE`'s does. A share
    card is built the same way: `Dana shared Smith-1042 - LOI Check with you`,
    with `Created by <creator>` when the sharer isn't the creator. The note is **never** written as a review note — that would fire the
    separate `DM_NOTE` fan-out and DM everyone twice.
  - A **displaced assignee** gets a one-line DM: "&lt;actor&gt; passed
    &lt;folder&gt; to &lt;new assignee&gt;". Anyone may pull a task out from
    under anyone, so that is never silent.
- **Task created already handed off** (`assigneeUserId` on the create payload):
  the channel post uses the **claimed-card** variant instead of the claimable
  one — announced, with no Claim button to appear and then vanish. Its headline
  reads `Suzie was assigned Tyler's LOI Check`, because nobody claimed it.
  Nothing on the task itself records that — an assignee looks the same however
  it got there — so the thread record remembers who the task was born in the
  hands of, and a later Teams refresh keeps saying "was assigned" until the task
  changes hands, at which point somebody really did grab it and the card says
  so. Deliberately
  quiet: channel messages set no `channelData.notification.alert`, and the
  activity-signal pass only raises pickup alerts for *claimable* (`OPEN`) tasks,
  which this isn't. The recipient still gets the `DM_ASSIGN` card.
- `Merge Done`: DM task creator
- `Completed`: DM **whoever did not close it** — the creator, the assignee, or
  both if neither is the closer, and never the person who pressed the button
  (ADR-0007 rule 6). On the ordinary path that is the creator alone, exactly as
  before: the assignee is the one closing. This is the hand-pressed close; an
  OOO task the scheduler wraps up on its return date keeps its own single DM to
  the creator, unchanged. When a creator closes an LOI out of
  corrections, the assignee is told instead, and the message names the person
  who did it, because they could not otherwise know their task ended. A close
  made **out of** the corrections state also reads `closed <folder> after
  corrections` rather than the per-type completion wording below — the tail of
  that loop is a fix being accepted, not work finishing, and the reader should
  be able to tell which happened without opening the task. Worded off the
  status the close came from, so the creator's other move — sending it back for
  a confirming look — ends in an ordinary close with the ordinary wording.
  Nothing goes to the channel either way — a closure is two-party business
  (ADR-0002), and the `CHANNEL_COMPLETED` card edit below is a silent terminal
  state, not a post.
- **A completed LOI says the check came back clean** (#232). The completion DM
  used to be the bare `Done and dusted 🎉` for every type, which told the
  requester the task closed but nothing about what the check found — the
  message behind the "did you actually check it?" incident (#172). A completed
  LOI now reads `LOI Check - Good to go! (Smith-1042)`. A check that finds
  something doesn't complete — it goes to the corrections loop
  ([ADR-0007](../adr/0007-loi-corrections-loop.md)) — so the completion the
  checker performs is the clean one. The one completion that isn't the
  checker's is a creator closing a task out of corrections
  (`NEEDS_REVIEW → COMPLETED`), which reads its own "closed after corrections"
  line instead (#239), so the two closures are told apart. Every other type
  keeps `Done and dusted 🎉` unchanged, and so does
  `Merge Done`. The wording lives in `completionDmMessage`
  (`packages/shared/src/types.ts`); the folder name is appended by
  `formatLifecycleDmText`, so it carries the deep link like every other
  lifecycle notice. Recipients are the ones named above.
- `Merge Approved`: DM task assignee
- Notes: DM counterpart user as an **interactive note card** — the same
  conversation card a claim sends, so it carries the task's details and the
  **Open in Hot Task** link above the recent conversation (last ~5 notes,
  oldest → newest), with an inline reply box and a contextual advance/complete
  button. The reply box **persists**
  after sending (card refreshes to the updated thread), so a user can send
  several messages in a row. Tapping **Reply** posts the text straight back
  as another review note (which in turn DMs the original author, closing the
  loop). Routed via the `DM_NOTE` target; falls back to a plain DM when there's
  no targeted recipient. Reply resolves the Teams user (`from.aadObjectId`) to
  a stored identity and calls `addReviewNote`; the card refreshes to confirm.
- Reminders: DM assignee, except `Loan Docs` in `Merge Done` where reminder DM
  goes to creator
- **Amendments**: a task edited under whoever is holding it DMs them, and only
  them — plain one-line DMs, never a channel post, because an amendment is
  two-party business (ADR-0002). Silent while the task is unclaimed, and never
  sent to the person who made the change. Three edits qualify, all covered in
  [task-fields.md](task-fields.md):
  - **Urgency** — their deadline moved.
  - **An OOO task's dates** — the window they are covering the desk across
    moved.
  - **The instructions** — what they are working from moved
    ([ADR-0010](../adr/0010-every-task-has-an-instructions-box.md) rule 7). The
    sentence **names the box by its own heading** and quotes none of the new
    text: `Dana changed the things to look out for on Smith-1042 — check them
    before you carry on`, and an LOI keeps the short `the terms` it has read
    since ADR-0008 rule 9. The phrase comes from `instructionsFieldPhrase`
    (`packages/shared/src/types.ts`), derived from the same heading table the
    box itself is drawn from, so the message cannot call a box something the
    box does not call itself. A Fraud Check is the exception on both counts:
    its ask stays in the thread rather than a box, so its note change is
    silent.

  A points change is silent on every type. Every amendment also re-renders the
  task's delivered cards through the silent [DM Card Sync](#dm-card-sync) path,
  so no card is left quoting a stale value; a no-op save does neither.
- **Plain lifecycle DMs carry the task link too** (#174). The one-line notices —
  `Merge done`, the completion notice, `Got the green light`, the fraud round
  trip, handoff displacement, OOO auto-completion, the overdue nudge — read as
  `<friendly type> - <message>`, with the folder name appended in parentheses
  only when the message doesn't already name it. Whichever occurrence the reader
  sees is a Markdown link to the same **Open in Hot Task** deep link the cards
  use, so the notice is never a dead end. Composed once, in
  `formatLifecycleDmText` (`packages/shared/src/types.ts`), so a lifecycle
  message added later is linked by default. Without `TEAMS_APP_ID` there is no
  link and the text is exactly what it was before — no placeholder, no dangling
  parentheses. The DM send sets the activity's `textFormat` to `markdown`
  explicitly rather than relying on the Bot Framework default, so the link never
  renders as literal Markdown.

## DM Card Sync

Channel cards have always tracked a task's status. **DM cards now do too.** Every
status change — from the tab, from a card tap, or from the scheduler — ends with
a silent `DM_CARD_SYNC` that re-renders each participant's existing DM cards in
place, so a card's buttons always show the step that is actually next.

- Covers both DM card kinds: the interactive note/chat card
  (`apps/server/data/bot-note-cards.json`), which is rebuilt from the live task,
  and the handoff's detail card (`apps/server/data/bot-detail-cards.json`). The
  detail card used to be fire-and-forget — its activity id was discarded, so its
  **Complete** button could never be taken away once the task moved on. It is
  now recorded at send time, along with the rendered title/detail so a
  re-render replays the body (due date, notes, Humperdink) verbatim. Claims sent
  one too until 2026-09-12; those already in people's chats are still on file
  and still re-rendered.
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
  card a claim sends alike, so the three can't drift apart.
- **Not terminal-only.** A *wrong* button is worse than a dead one: advancing a
  Loan Docs task in the tab re-arms the DM cards to `Approve Merge` rather than
  leaving `Merge Done` sitting there. Terminal cleanup is just the last step of
  the same rule, which is also why a **re-open re-arms the cards for free**.
- At a terminal status the card becomes a record: a banner (`✅ Completed —
  Smith-1042 - LOI Check` / `🚫 Cancelled — …` / `📦 Archived — …`) replaces
  the title and every action button is dropped. `Open in Hot Task` survives on
  the detail card. The banner names the task and its type on the conversation
  card and the detail card alike, so a finished handoff card still says what
  kind of task it was. It is worked out from the live task every time the card
  is drawn, so a note added to a completed task keeps it too.
  **COMPLETED keeps the note card's reply box** — `addCompletedNote` (issue #45)
  still accepts notes on a completed task — while CANCELLED/ARCHIVED lose it.
  The card's Reply therefore routes through `TaskService.addNoteFromCard`, which
  picks `addCompletedNote` for a COMPLETED task and `addReviewNote` otherwise;
  wiring Reply straight to `addReviewNote` would make the surviving reply box a
  button that always errors ("Notes cannot be added to closed tasks").
- Per-viewer button rules match `DM_NOTE` exactly: the advance goes to the party
  whose move it is, and a FRAUD task carries its role-aware two-phase set instead
  of the generic advance. The handoff's detail card never carries a fraud button
  (that move is note-required and lives on the chat card). Full matrix in
  [Who Gets Which Button](#who-gets-which-button).
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

- Tapping the card's `Action.Execute` **Claim** — the linkless fallback, and
  every card posted before **Claim & Open** — resolves the Teams user
  (`from.aadObjectId`) to a stored identity, claims the task, then refreshes the
  card (button removed) and threads the "grabbed this one" reply.
  Unknown/inactive users get a toast and no claim, and so does anyone the rule
  refuses: the toast is `claimRefusalMessage`'s sentence, which names the real
  reason rather than a catch-all.
- **Advance/Complete** buttons (conversation + handoff cards) call `botPrimaryAdvance` for
  the next forward step (Merge Done → Approve Merge → Complete for Loan
  Docs; Complete otherwise), then transition via the task service and refresh to
  a confirmation card that offers the *next* step — so a user can step a task all
  the way through from one card. The button reaches only the party whose move it
  is: see [Who Gets Which Button](#who-gets-which-button). Permission is still
  enforced at transition time (toast on failure), because a card in somebody's
  chat is a copy that can go stale. A failed tap also kicks off a card re-sync —
  see [DM Card Sync](#dm-card-sync).
- **A step button carries the text typed in the card's box** (#250). Any card tap
  arriving with non-empty text in the conversation box posts that text as a note
  first — through the same path the **Reply** button uses, so it is an ordinary
  note, attributed to the tapper, DMed to the counterpart, and routed to the
  completed-note call on a completed task — and only then takes the step. The
  rule is uniform rather than per-button, so a step button added to a card later
  inherits it. Order is note-then-step, so the caveat reaches the counterpart
  ahead of the notice it qualifies. A note that can't be posted aborts the step
  and the tap returns the note's own error sentence, plus a card re-sync — notes
  are closed only on statuses whose card carries neither a box nor a step button,
  so a carried note refused is a stale card by definition (a refused **Reply** is
  unchanged and gets no re-sync). The confirmation card gains
  a sentence ("Note posted. Smith-1042 is now merge approved.") and nothing else;
  it carries no box, so there is nothing to double-post. Whitespace-only counts
  as empty, and an empty box behaves exactly as it always did. The note-required
  fraud moves keep their own box: both sentences are honoured, and identical text
  in both produces one note.
- **Fraud two-phase buttons** are the exception — see
  [fraud-workflow.md](fraud-workflow.md#fraud-card-buttons).
- Copy is intentionally personable/casual (e.g. "tossed a new file check on the
  pile", "grabbed this one — on it now"), low on emoji.

## Who Gets Which Button

Every advance button on every bot surface is gated by `botAdvanceFor`
(`packages/shared/src/workflow.ts`): the flow's next step (`botPrimaryAdvance`)
filtered through `canTransitionStatus`, the same predicate the server runs on the
tap. One rule, so no surface can offer a move its owner would be refused (#182).

It used to gate on whether the advance target happened to be `COMPLETED` and
restrict only that one to the assignee, which meant a Loan Docs assignee was
offered **Approve Merge** — the creator's move — and the creator was offered
**Merge Done**, which is the assignee's.

**The advance button, by flow, status and party.** ✅ means the button is
rendered; — means it isn't.

Loan Docs (the merge chain hands the ball from one named person to the other):

| Status | Forward step | Creator | Assignee | Anyone else |
|---|---|---|---|---|
| `OPEN` | — | — | — | — |
| `CLAIMED` | Merge Done | — | ✅ | — |
| `MERGE_DONE` | Approve Merge | ✅ | — | — |
| `MERGE_APPROVED` | Complete | — | ✅ | — |
| `COMPLETED` / `CANCELLED` / `ARCHIVED` | — | — | — | — |

Every other type (LOI, Value, Buddy Chat, OOO, …):

| Status | Forward step | Creator | Assignee | Anyone else |
|---|---|---|---|---|
| `OPEN` | — | — | — | — |
| `CLAIMED` | Complete (`Confirm` after corrections) | — | ✅ | — |
| `NEEDS_REVIEW` (LOI only) | Complete | ✅ | — | — |
| `COMPLETED` / `CANCELLED` / `ARCHIVED` | — | — | — | — |

`NEEDS_REVIEW` is the LOI corrections state ([ADR-0007](../adr/0007-loi-corrections-loop.md),
#236): the checker has looked, found something, and handed the ball back to the
creator. It is the one completion in the app that is not the assignee's, and it
exists on no other task type — Loan Docs and Fraud Check cannot reach it, which
is why neither of their tables has a row for it.

A `CLAIMED` LOI the creator sent back out of corrections for a confirming look
reads `Confirm` rather than `Complete`, because that press also archives the
task (#238, ADR-0007 rule 5 — see
[status-model.md](status-model.md)). Same transition and one request either
way; the card only changes the word, from the same shared rule the web row
reads, so the two cannot drift.

Fraud Check renders `fraudCardActions` instead — a role-aware set keyed on the
viewer's **seat**, which is a live `FILE_CHECKER` role plus the assignee slot for
the checker, and the creator for the requester (ADR-0003):

| Status | Requester (creator) | Checker (assignee) | Anyone else |
|---|---|---|---|
| `OPEN` | — | — | — |
| `CLAIMED` | — | Send Items (opens a note input) | — |
| `AWAITING_ITEMS` | Submit — disabled with a reason until every checklist item is checked or noted (#184) | — | — |
| `PENDING_APPROVAL` | Release for any fraud checker, while a checker still holds it | Approve, Send Back (note) | — |
| `COMPLETED` / `CANCELLED` / `ARCHIVED` | — | — | — |

A Fraud Check used to be sendable to review from `CLAIMED` and then had no
forward step for either seat (#240). The corrections state is LOI-only since
ADR-0007, so the cell no longer exists rather than being a "nobody" cell.

Two consequences worth stating outright:

- **`NEEDS_REVIEW` is a handoff to the creator, and its button is the
  creator's.** Only the assignee can send an LOI there, only from `CLAIMED`;
  from there the creator either completes it or sends it back to `CLAIMED`
  (`Send back to checker`, a web hamburger action that has never been on a
  card). The assignee cannot complete it and cannot pull it back; they keep the
  notes thread. Admin buys nothing here either — admin is back-end access, not a
  seat (#143 / ADR-0003). `pendingPartyFor` reports the creator, so the web
  row's `Waiting on` and the card's button point at the same person.
- **A vacant seat gets no button.** `pendingPartyFor` names a seat, not a
  person: a Fraud Check released back to the pool still reads as waiting on the
  checker, but nobody is sitting there, so the card offers nothing until someone
  claims it.

**Which surfaces carry an action at all.** Party gating only matters where a card
has a forward move to offer:

| Surface | Actions | Party-gated? |
|---|---|---|
| Channel root card, claimable | Claim & Open, Open in Hot Task, plus an invisible **Refresh** action listing the creator's MRI | No — addressed to the room. Refresh is Teams' user-specific-view mechanism rather than a button anyone taps: it makes the creator's copy re-fetch, and their copy swaps Claim & Open for **Cancel Task** (`canCancelTask`). The claim itself is re-checked on arrival (`claimRefusalMessage`) |
| Channel root card, claimed / terminal | Open in Hot Task | n/a — no move on it |
| DM handoff detail card | advance, Open in Hot Task | Yes, per recipient. Never carries a fraud move: that one is note-required and lives on the chat card |
| DM share card | Open in Hot Task | n/a — a share informs, it never offers a move |
| DM note / chat card (also what a claim sends) | Reply, advance *or* the fraud set, Open in Hot Task | Advance yes; **Reply no** — the card goes to the task's two parties and a note is a conversation between them (`canAddNoteToTask`). It survives `COMPLETED` (#45) and is dropped at `CANCELLED` / `ARCHIVED`, which is a status rule, not a party one |
| Transition confirm card | the *next* advance | Yes — the tapper is offered the next rung only when it is theirs, so marking a merge done doesn't hand you the creator's approval |

`scripts/card-advance-party-sim-test.mjs` mirrors these tables as a single
matrix and replays it across every surface above, so a new rung or a new surface
is a row there rather than a hand-written case per card. The tables here are a
hand-kept copy of that matrix — change one, change the other.

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

## Bot Scope

- Notifications/reminders
- One-tap claim from channel cards
- Note replies, the fraud advance buttons, and user-specific card refresh

**The bot does not create tasks.** The app is the only place a task is filed.

## Why the bot's task creation was removed (#315)

The bot used to carry a full step-by-step task builder behind `/bot new`:
Folder Name, task type, urgency or return dates, Poops, notes, Humperdink link,
a review message with field-level edits, and a final create confirmation. It was
removed, along with `/bot back` and `/bot cancel`, and the `new` command is gone
from the Teams manifest.

The reasoning:

- **Nobody used it.** Every task is filed through the tab. The flow was a second
  filing route kept alive for no traffic.
- **A second route cannot be kept honest for free.** It re-asked every field the
  create form asks, in its own words, and it had to re-learn every rule the form
  learns. It had already fallen behind on two: it stored the literal text
  `No additional notes` when somebody skipped the notes step — which since #300
  is the first thing a person reads on the card, under a heading promising to say
  what the task is for — and it never learned that a Fraud Check may be filed on
  its outstanding items alone (ADR-0010 rule 3), because it never asked for
  outstanding items at all.
- **Deleted rather than hidden.** Closing the entrance and keeping the machinery
  would have left several hundred lines that nothing reaches and nothing tests,
  which is how the two drifts above went unnoticed in the first place.

Existing tasks that already carry `No additional notes` in their request field
are deliberately left alone. Rewriting somebody's stored request text after the
fact is worse than stale words, and nothing new can produce it.

What a typed message to the bot gets now: one line saying tasks are created in
the tab. `help` says the same thing. The retired commands are answered by name
rather than ignored, so muscle memory gets an explanation.

Everything else the bot does is untouched. Claim, the fraud advance buttons,
note replies and card refresh all arrive as card actions rather than typed
messages, and never went through the message handler.

### If filing from the bot is ever wanted again

This is not a rebuild-from-scratch. The removal landed as **PR #336**, and the
commit on `main` immediately before it holds a complete, working implementation.

- **Where to look:** PR #336's diff, or on `main`, the commit *before* the one
  whose subject begins "Take task creation off the bot". `git log --oneline -1
  --grep "Take task creation off the bot"` finds it; the parent of that commit
  has the flow as it last ran, in `apps/server/src/bot.ts`.
- **Deliberately not a raw SHA.** The branch commits are squash-merged, so the
  hash this work was developed under does not exist on `main` and dies with the
  branch. The PR number and the commit subject are the durable handles.
- **What was taken out:** the `QuickAddDraft` state machine and its
  per-person-per-conversation draft map, the step prompts and their parsers
  (task type, urgency, Poops, start and return dates, Humperdink link), the
  review message with field-level edits, the create confirmation, the message
  handler branches for `/bot new`, `/bot back` and `/bot cancel`, the
  `BotTaskCreator` wiring from the server into the flow, and the `new` entry in
  both Teams manifests.

What would have to be **fixed, not just restored**, before it could be trusted
again — these are live bugs in that code, not new requirements:

1. **The skipped-notes filler.** It writes the literal text
   `No additional notes` into the request field. That was the whole of #315. A
   restored flow has to either refuse a skip the way it already refuses a bad
   urgency or a bad date, or leave the field genuinely empty and let every
   surface that draws the Instructions box handle its absence.
2. **Fraud Checks.** It never asks for outstanding items, so it cannot satisfy
   ADR-0010 rule 3 honestly — it only got past the rule by leaning on the
   filler. A restored flow either collects outstanding items, requires a written
   request for a Fraud Check specifically, or stops offering the type.
3. **Whatever has changed since.** The deeper lesson is that a second filing
   route has to re-learn every rule the create form learns. Before restoring,
   diff the fields and rules the web form asks for against the ones that flow
   asks for, rather than assuming the list is still the one it was written
   against.

The reason to check all three rather than reverting straight is that both of the
first two drifted silently, in a flow nobody was walking and no test covered. A
revert reinstates the drift along with the feature.

## Activity Feed

- Left-rail icon dot is not used
- Teams activity feed is used instead
- Activity type is `systemDefault` for v1
- The notification's topic `webUrl` is the same shared `teamsTaskDeepLink`
  the bot cards use (no task id → the bare tab link). It used to be a
  near-duplicate builder here that emitted `{subEntityId, taskId}`; the
  canonical context shape is `{subEntityId}` alone.
- Activity feed alerts trigger on:
  - State change
  - Hourly reminder cadence during business hours
- Bounce-back condition is `Needs corrections` (stored as `NEEDS_REVIEW`)
- Pickup scope is tasks claimable by the user
- Due condition is overdue-only
