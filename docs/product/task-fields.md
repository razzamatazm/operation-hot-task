# Task Fields

## Amending a task after it is filed

A task's **creator** may correct the ask while the task is **active** — its
request field, its urgency (on a non-OOO task) and its start and return dates
(on an OOO task). On an **LOI Check** the request field holds the loan's terms,
and the **current assignee** may correct those too: they are facts the checker
is checking against, and the checker is the person reading them closely enough
to notice a wrong figure.

Editing stops at the task's two parties, its creator and whoever currently holds
it. Not an observer, not a file checker who has not claimed the task, and not an
admin, whose back-end access confers nothing over other people's work. Closed
tasks — `COMPLETED`, `CANCELLED`, `ARCHIVED` — are frozen for everyone,
parties included; every other status is amendable, `AWAITING_ITEMS` and
`NEEDS_REVIEW` included (a check parked on its requester, or an LOI in
corrections, is waiting rather than finished — and on an LOI in corrections the
checker is still the assignee).

The rule is [ADR-0008](../adr/0008-loi-terms-are-a-field-not-a-message.md)
rules 5 and 6, superseding [ADR-0006](../adr/0006-amend-task-ask.md), and one
shared predicate (`canAmendTask` / `amendRefusal`) answers it for the server and
the web alike.

| Field | Amendable | By whom | When |
|---|---|---|---|
| Terms (`LOI`) | yes | creator **or** current assignee | any non-closed status |
| Notes (other five types) | yes | creator | any non-closed status |
| Urgency | yes, except on `OOO` | creator | any non-closed status |
| Poop points | yes | creator | any non-closed status |
| Folder name / Humperdink link (non-`OOO`) | yes — **on the loan**, not the task | the task's creator or its current assignee, and only from that task | any non-closed status |
| Vacation description (`OOO` folder name) | yes, on the task | creator | any non-closed status |
| OOO start + return dates | yes, `OOO` only | creator | any non-closed status |
| Due date | **never directly** — derived from urgency, or on `OOO` from the return date | — | — |
| Task type, which loan a task is on, creator, assignee | no | — | — |

Poop points are the creator's too, on the same terms, and have their own
`POST /api/tasks/:id/points` — see
[claiming-scoring.md](claiming-scoring.md#poop-points-rules).

Focused operations, never a generic patch: `POST /api/tasks/:id/notes`,
`POST /api/tasks/:id/urgency`, `POST /api/tasks/:id/points`,
`POST /api/tasks/:id/folder-name` and `POST /api/tasks/:id/dates`. Each refuses
with the rule that refused it. The folder-name and dates routes are `OOO`-only
and say so — every other type's folder name belongs to the shared Loan record
and goes to `PATCH /api/loans/:loanId`, below.

- **Due date is derived, never set.** Changing the urgency re-derives `dueAt`
  from the new band at the moment of the edit, through the same computation
  creation uses (weekend roll and all) — see
  [due-date-urgency.md](due-date-urgency.md). No route accepts a `dueAt`, and
  the web surface renders no due-date input.
- **`OOO` urgency is refused.** An OOO task's `dueAt` is the person's return
  date and the maintenance pass auto-completes on it, so it is a scheduled
  action rather than a deadline. Its notes are still amendable, and so are its
  dates.
- **The request field cannot be emptied.** On an LOI that is ADR-0008 rule 1 —
  a checked LOI that says nothing about what was checked is worse than one that
  is slightly wrong.
- **Refusals name the rule.** "Only the person who filed this LOI or the checker
  holding it can change its terms", "Only the task creator can change its
  urgency", "The terms cannot be changed on a closed task" — never a generic
  denial, and on an LOI the field is called *terms* in the sentence, in the
  history entry, and in the box.
- **`OOO` dates are amendable, and any date is accepted — including one in the
  past** (ADR-0008 rule 8, which reverses ADR-0006's exclusion of them).
  Somebody back early correcting the record is the case this exists for, and
  refusing a past date would block the only person with a reason to fix it. A
  return date that has already gone simply means the next maintenance pass
  auto-completes the task, which is the honest outcome. This is the one place
  editing deliberately disagrees with filing, which still refuses a return date
  that is already behind us.
  - Both dates go in **one** call, because they are one range: the rule is that
    the start is on or before the return, and that cannot be checked against
    half of it. Sending either sends both, and the history entry names all four
    values. The range rule itself is shared with filing — one rule, not two
    copies. What each surface *says* when it refuses stays its own: filing's
    request check speaks in field names, the rest in English.
  - The new return date re-derives `dueAt` through the same shared computation
    filing uses, so everything hanging off the dates is recomputed: the
    auto-completion, the overdue arithmetic, the ordering, the `Returns` line
    in the hamburger, and the headline the cards quote. The last-reminder stamp
    is left alone — there is no cadence to restart, because a task whose new
    return date has passed gets completed on the pass that would have reminded
    about it.
  - The other five task types have no dates; the route refuses them.
- **A no-op is a no-op.** Setting a field to the value it already has writes no
  history event and notifies nobody.
- **What the other party sees.** Every edit re-renders the task's existing DM
  cards in place through the silent card-sync path, so no surface quotes a
  stale value. On top of that:
  - **An urgency change DMs the assignee** when there is one — their deadline
    moved. **A date change does too**, for a related but distinct reason: an OOO
    task's dates are a scheduled action rather than a deadline, but they are the
    window the assignee is covering the desk across, and it just moved.
  - **An instructions change DMs whoever is holding the task**, unless they are
    the one who made the change — the instructions are what they are working
    from, so a change to them is the amendment most likely to make their work
    wrong (ADR-0010 rule 7, widening the LOI-only ADR-0008 rule 9). While the
    task is unclaimed there is nobody to tell, so it is silent. The DM names the
    person, the file and **the box by its own heading** — a Value Check says its
    things to look out for changed, a Loan Docs task its extras and edits. It
    quotes none of the new text, because a brief is a block and a DM you have to
    scroll is one people stop reading. Nobody else hears — a checker correcting
    a transposed digit on an LOI does not DM the creator.
  - **A Fraud Check's note change is silent**, claimed or not: its ask is the
    outstanding-items list rather than a box, so there is no box to say has
    moved. **A points change is silent** on every type.
  Nothing posts to the channel.
- **The reminder cadence restarts on an urgency change.** Moving `dueAt` from a
  new band clears the task's last-reminder stamp, so a task made newly overdue
  by the edit is eligible for its next reminder immediately (see
  [reminders-retention.md](reminders-retention.md)). A date change does not: an
  OOO task whose return date has passed is completed rather than nagged.
- **Every applied edit is in the task's history**, with the field and both
  values (`TASK_NOTES_AMENDED` / `TASK_URGENCY_AMENDED` /
  `TASK_FOLDER_NAME_AMENDED` / `TASK_POINTS_UPDATED` / `TASK_DATES_AMENDED`).
  The points line named only the new rating until #261 put it on the edit form
  alongside the others.
- **In the web app there are two doors onto the request field**, and they write
  through the same route so they cannot produce different results (ADR-0010
  rule 4, amending ADR-0008 rule 4). The first is `Edit Task` in the row's
  hamburger, offered to whoever may edit an active task — its creator, plus the
  assignee on an LOI. The second is the **Instructions box itself**: press and
  hold it, or right-click it, exactly as on a message, and the menu appears
  beside it with one entry and the box becomes an editor in place. It behaves
  as a field rather than as a message once open — Enter makes a new line, an
  explicit `Save` commits, cancelling a changed draft asks before discarding it,
  and there is no delete, because instructions cannot be emptied. A Fraud
  Check's note is still in the thread and has no box, so it has only the first
  door. The box does not respond to a hold for anyone the shared rule refuses,
  or on a closed task; reopening restores it. The old `Edit request` button on
  the thread head is gone. The menu item is drawn from the same shared predicate the
  server's refusal is written from, so no surface offers an edit the server
  would turn away. It opens the same form the task was filed with, preloaded,
  with the task type shown disabled and a reason, and `Save` in place of
  `Create Task`. It carries the request field, the folder name, the Humperdink
  link, **urgency**, **poop points** and — on an `OOO` task — its **start and
  return dates**. Urgency and the poops are drawn **only for the person who
  filed the task**, because they are permanently the creator's — a checker
  correcting an LOI's terms is never shown a control the server would refuse
  them, and is left with the one field they may write. The two timing controls
  are exclusive: an `OOO` task shows its dates and no urgency, every other type
  shows its urgency and no dates. Neither date input floors itself at today.
  A save that changed nothing sends nothing, and a save
  that changed two things makes two focused calls — there is no request that
  carries a task-shaped body. The row's click-to-rate poop track still works:
  two ways to one number is intended (ADR-0008 rule 4).

## Correcting the folder name and the Humperdink link

Those two are not the task's own. They belong to the **loan**, which every
non-OOO task points at, and the task carries a copy the server keeps in step
([ADR-0001](../adr/0001-loan-entity.md)'s live reference). So an edit writes the
loan, and the correction lands on **every task for that loan, finished ones
included** — which is the case that motivates the edit: a name wrong on one task
is wrong on all of them.

- **In the edit form** the two sit side by side. The folder name is a plain
  text box there, not the create form's loan typeahead: on a task that already
  exists, typing here renames the loan it is on, and offering to pick a
  different existing loan would be repointing the task, which is a different
  move nobody asked for.
- **One muted line beneath the pair**, covering both, appearing only once a
  value has actually changed — never on focus, and never as a popup, banner,
  dialog or toast. Clicking a field to read it warns about nothing. It says that
  saving updates the name and link on every task for this loan, including
  finished ones ([ADR-0008](../adr/0008-loi-terms-are-a-field-not-a-message.md)
  rule 7).
- **A link edit that would merge two loans asks first, and names the other
  loan.** Two loans sharing a Humperdink link become one — the other loan's tasks
  move over, its name survives only as an old name, and its record goes away.
  Merging is usually the right outcome, but that is too large a consequence to
  fall out of fixing a URL unannounced, so the save stops and asks. Nothing is
  written before the answer: the first save comes back refused, the app shows a
  confirmation dialog naming the loan in the way, and only a **yes** re-sends the
  same change with permission to merge. The dialog also says **which of the two
  survives** — the older record, which is usually the loan that was already
  there, so the one that disappears is often the one you are editing. It then merges exactly as it always has,
  including the brief "Merged with …" notice afterwards. **No** sends nothing at
  all — both records and the link are untouched — and leaves you in the form with
  your typing still in it.
  - This is the app's **one** confirmation dialog, and it is deliberate: the
    muted line above is not a dialog because nothing has gone wrong there, and a
    toast is not an option because a toast cannot ask a question
    ([ADR-0008](../adr/0008-loi-terms-are-a-field-not-a-message.md) rule 7). The
    edit form is now the only surface that edits a loan (see *Who may correct a
    loan*, below), and it asks through the one shared save path.
  - Merging at task **creation** is untouched and asks nothing: filing against a
    link that already has a loan simply joins that loan, which is the dedupe that
    stops a duplicate record being minted. Nobody's tasks are absorbed there,
    because there is no second record yet.
- **Every affected task records it.** A loan edit writes a history row on each
  task the loan reaches — `TASK_LOAN_NAME_AMENDED` and/or
  `TASK_LOAN_LINK_AMENDED`, naming who did it and both values
  ([ADR-0008](../adr/0008-loi-terms-are-a-field-not-a-message.md) rule 9). It is
  the only place that says who renamed the loan under a task and what it used to
  say. A field that didn't move earns no row.
- **The cards already posted to Teams are corrected too.** A loan's name shows
  on the channel card announcing each of its tasks, on the details card sent to
  whoever claimed one, and on the conversation cards in those people's chats.
  Each of those messages is **edited where it sits**: the card keeps its place
  in the channel and in every chat, keeps whatever state it was already in — up
  for grabs, claimed, completed, cancelled — and gains no button it did not
  have. Nothing new is posted and nobody is notified a second time; renaming a
  loan is not an event anyone needs telling about. A card that can no longer be
  reached (its message deleted, say) is left alone rather than reposted, and
  never holds up the rename or the other tasks. The correction runs in the
  background, so saving returns straight away however many tasks the loan has.
  The **Open in Hot Task** button keeps the address it was posted with — it
  still opens the right task.
- **An out-of-office task has no loan.** Its folder name is a vacation
  description, it edits on the task through `POST /api/tasks/:id/folder-name`
  (creator only, non-closed only, silent, in history with both values), it has
  no Humperdink link field at all, and it shows no shared-record line — there is
  no shared record.
### Who may correct a loan

**Only the two people with a stake in the task it is corrected from: its creator
or its current assignee.** Not an observer, not a file checker who has not
claimed the task, and **not an admin** — back-end access confers nothing over
other people's work ([ADR-0003](../adr/0003-creator-is-never-assignee.md)).

This **removed an ability that used to exist**. Until this landed, any signed-in
person could rename any loan or repoint its link, and a loan's name shows on
every task pointing at it, so an edit by someone with no involvement rewrote
other people's work. [ADR-0008](../adr/0008-loi-terms-are-a-field-not-a-message.md)
rule 5 and its consequences section name the narrower answer; this is it.

- **A loan edit is made from a task.** The request carries which task you were
  editing from, and the server checks three things before it writes anything:
  that the task exists, that it is on that loan, and that you are a party to it.
  A request with no task named, or naming a task on a different loan, is
  refused — being a party to one task confers nothing over somebody else's loan.
- **The refusal names the rule**, not just "forbidden": you are told it is the
  requester's or the checker's to change. Same sentence on the server and in the
  app, written once beside the rule so the two cannot drift.
- **A closed task is frozen**, for both parties
  ([ADR-0008](../adr/0008-loi-terms-are-a-field-not-a-message.md) rule 6). Reopen
  it if a genuinely late correction is needed. The refusal says so, and says it
  differently from the not-a-party one — those are different facts.
- **Nothing is offered to someone who would be refused.** In the edit form the
  two boxes render **read-only** with the reason beneath them, rather than
  accepting typing and refusing it at save time. The shared-record line and the
  merge confirmation are unreachable for them, and the confirmed re-send of a
  merge takes the same check as the save that asked — a refusal is never
  something you discover only after answering a dialog.
- **Filing a task is untouched.** Creating a loan, joining an existing one by
  name or link, and filling in a link the loan was missing all still happen for
  anyone who may file a task. This rule is about *changing* an existing loan's
  name or link.

**Known edge, not yet answered: the loan on the other side of a merge.** The
check is made against the loan you are editing. A confirmed link edit merges a
*second* loan in, and nothing checks that you have any standing over **that**
one — so a party to one loan can still absorb another loan's tasks. This is not
a regression (before ADR-0008 rule 5 anyone could do it to either side, unasked
and without a dialog), and the confirmation names the other loan so nobody does
it by accident. But narrowing it needs an answer that does not exist yet: a loan
has many tasks and many parties, so "a party to the absorbed loan" would have to
mean a party to *any one* of its tasks, and a loan with no tasks has nobody at
all. Deliberately left open rather than guessed at.

**Every loan-editing surface, and what each got:**

| Surface | Answer |
|---|---|
| The two loan fields in `Edit Task` | Kept, narrowed to the task's two parties, open tasks only |
| The header above a loan-filtered task list | **Editing removed.** It stands outside any task, so it has no two parties to check. It is now a read-only heading with the loan's name and its Humperdink link |

The header's ability went rather than being softened for it: a surface with
nobody to check cannot carry the rule, and keeping it would have left one editing
surface with a rule and another without — the drift this closes. The name and
link are still corrected from `Edit Task` on any task on that loan, which is one
click away in the list directly beneath that header.

## Create Task Fields

- Required fields:
  - Folder Name
  - Task Type: `LOI`, `Buddy Chat`, `Value`, `Fraud`, `Loan Docs`, `OOO`
  - Poop points: `1`-`5`, default `1` (see
    [claiming-scoring.md](claiming-scoring.md#poop-points-rules))
  - Timing:
    - Non-OOO: urgency (see [due-date-urgency.md](due-date-urgency.md))
    - OOO: start date and return date in `YYYY-MM-DD`, PT (start ≤ return; both
      required) — see [ooo.md](ooo.md)
  - Notes
- Non-OOO only, above Folder Name: **Import from Humperdink** and the paste
  field beside it. Paste what the **Send to Hot Task** userscript copied off a
  Humperdink loan page and press it; Folder Name, the Humperdink Link and the
  loan's terms, broker, borrower and acquired properties fill in, the task type
  becomes LOI, and the button reads `Imported`. A malformed or empty paste
  reports the problem in a toast and leaves every field untouched — it never
  half-fills. The terms land *below*
  anything already typed in Notes rather than over it, and a second import
  replaces the block the first one wrote instead of stacking another copy.
  Nothing else on the form is touched. See
  [integrations-hosting.md](integrations-hosting.md) and
  [tools/humperdink/](../../tools/humperdink/).
- Optional fields:
  - Non-OOO only: Humperdink Link
  - All types: one person picker with a **Share / Assign** toggle, plus one
    optional note. It is either a share or a handoff, never both — two DMs about
    the same brand-new task is exactly the noise this avoids. Hidden when
    there's nobody to point at.
    - **Share** — DM them about the task; it stays in the pool. Fires as a
      follow-up call to `POST /tasks/:id/share` right after the task is
      persisted, because that response carries the `delivered` reachability flag
      the toast reports and the create response has no place to hold it.
    - **Assign** — hand the task to them (see
      [ADR-0002](../adr/0002-task-handoff.md)). Never yourself: a task's creator
      can never be its assignee
      ([ADR-0003](../adr/0003-creator-is-never-assignee.md)), so the picker
      excludes you. Rides the create payload
      (`assigneeUserId`, `assigneeNote`) so the task is born `Claimed` in ONE
      call; create-then-assign would post a claimable channel card and then edit
      its claim affordance away. The picker narrows to people eligible to work the
      task, so a Fraud Check only offers file checkers. If you are the only
      eligible file checker, the form says so up front — nobody will be able to
      claim it, and someone else needs to file it.
- Folder Name is the canonical task name
- There is no separate file name field
- OOO UI wording:
  - Folder Name label becomes `Vacation Description`
- **Where the field is drawn.** On every type but a Fraud Check it renders as
  its own bordered Instructions box in the expanded card, above the
  conversation, and is **not** echoed as the thread's first message — so a
  brand-new task opens on an empty conversation that says so. Free text, line
  breaks as typed, capped height with internal scroll. It is the same field
  with the same payload — no new column, nothing to migrate — drawn somewhere
  else. A Fraud Check keeps its note as the thread's first message, because its
  standing ask is the outstanding-items list at the top of its card. Built for
  the LOI by #258 ([ADR-0008](../adr/0008-loi-terms-are-a-field-not-a-message.md))
  and widened to five types by #300
  ([ADR-0010](../adr/0010-every-task-has-an-instructions-box.md) rule 1).
- **Heading by task type** (#301,
  [ADR-0010](../adr/0010-every-task-has-an-instructions-box.md) rule 2). One
  table, `NOTES_FIELD_LABELS`, read by the card, the create form, the edit form
  and the bot, so no two surfaces can name the same field differently. Four
  types said `Notes` until #301; as the title of a box telling somebody what to
  do, a word four types share carries nothing.
  - LOI: `Loan Terms and Contacts` — the task's _Terms_
  - Buddy Chat: `Concerns`
  - Value: `Things to Look Out For`
  - Loan Docs: `Extras and Edits` — the standard set falls out of the merge, so
    what wants writing down is the delta: wording to type into a document, or an
    extra document to generate
  - OOO: `Coverage Notes`
  - Fraud: `Notes` — the one type whose field is still the thread's first
    message, so this heads the card's free-text **discussion thread** (#68)
    rather than a box, and is not a separate outstanding-items field; relabeled
    from `Discussion` to `Notes` for consistency (#81). The create form (#69)
    seeds that thread and carries an outstanding-items checklist seeder beside
    it; since #301 its heading comes from this table like every other type — see
    [fraud-workflow.md](fraud-workflow.md#structured-outstanding-items-checklist-44)
