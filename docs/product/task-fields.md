# Task Fields

## Amending a task after it is filed

A task's **creator** may correct the ask while the task is **active** — its
request field, and (on a non-OOO task) its urgency. On an **LOI Check** the
request field holds the loan's terms, and the **current assignee** may correct
those too: they are facts the checker is checking against, and the checker is
the person reading them closely enough to notice a wrong figure.

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
| Poop points | yes | creator | while the task is active (not `AWAITING_ITEMS`) |
| Due date | **never directly** — derived from urgency | — | — |
| Task type, linked loan, creator, assignee, OOO dates | no | — | — |

Two focused operations, never a generic patch: `POST /api/tasks/:id/notes` and
`POST /api/tasks/:id/urgency`. Each refuses with the rule that refused it.

- **Due date is derived, never set.** Changing the urgency re-derives `dueAt`
  from the new band at the moment of the edit, through the same computation
  creation uses (weekend roll and all) — see
  [due-date-urgency.md](due-date-urgency.md). No route accepts a `dueAt`, and
  the web surface renders no date input.
- **`OOO` urgency is refused.** An OOO task's `dueAt` is the person's return
  date and the maintenance pass auto-completes on it, so it is a scheduled
  action rather than a deadline. Its notes are still amendable.
- **The request field cannot be emptied.** On an LOI that is ADR-0008 rule 1 —
  a checked LOI that says nothing about what was checked is worse than one that
  is slightly wrong.
- **Refusals name the rule.** "Only the person who filed this LOI or the checker
  holding it can change its terms", "Only the task creator can change its
  urgency", "The terms cannot be changed on a closed task" — never a generic
  denial, and on an LOI the field is called *terms* in the sentence, in the
  history entry, and in the box.
- **A no-op is a no-op.** Setting a field to the value it already has writes no
  history event and notifies nobody.
- **What the other party sees.** Both edits re-render the task's existing DM
  cards in place through the silent card-sync path, so no surface quotes a
  stale value. On top of that:
  - **An urgency change DMs the assignee** when there is one — their deadline
    moved.
  - **A change to an LOI's terms DMs the checker holding it**, unless the
    checker is the one who made the change — the terms are what they are
    checking against, so a change to them is the amendment most likely to make
    their work wrong (ADR-0008 rule 9). While the LOI is unclaimed there is
    nobody to tell, so it is silent. The DM names the person and the file and
    says to check the terms; it does not quote them, because the terms are a
    block and a DM you have to scroll is one people stop reading. Nobody else
    hears — a checker correcting a transposed digit does not DM the creator.
  - **A notes change on the other five types is silent**, claimed or not.
  Nothing posts to the channel.
- **The reminder cadence restarts.** Moving `dueAt` clears the task's
  last-reminder stamp, so a task made newly overdue by the edit is eligible for
  its next reminder immediately (see
  [reminders-retention.md](reminders-retention.md)).
- **Every applied edit is in the task's history**, with the field and both
  values (`TASK_NOTES_AMENDED` / `TASK_URGENCY_AMENDED`).
- **In the web app**, whoever may edit an active task gets `Edit Task` in the
  row's hamburger — its creator, plus the assignee on an LOI — and that is the
  only way in (ADR-0008 rule 4); the old `Edit request` button on the thread
  head is gone. The menu item is drawn from the same shared predicate the
  server's refusal is written from, so no surface offers an edit the server
  would turn away. It opens the same form the task was filed with, preloaded,
  with the task type shown disabled and a reason, and `Save` in place of
  `Create Task`. Today it carries the request field alone — which is exactly the
  field a non-creator party may write, so a checker is never shown a control
  they cannot use. Urgency, poop points, the loan fields and the OOO dates land
  on it in later work and bring their own gating. A save that changed nothing
  sends nothing.

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
- Notes label by task type:
  - LOI: `Loan Terms and Contacts` — the task's _Terms_. Since #258 this one
    field renders as its own bordered section in the expanded card, above the
    conversation, and is **not** echoed as the thread's first message, so a
    brand-new LOI opens on an empty conversation that says so. Free text, line
    breaks as typed. It is the same field with the same payload — no new
    column, nothing to migrate — drawn somewhere else. See
    [ADR-0008](../adr/0008-loi-terms-are-a-field-not-a-message.md)
  - Buddy Chat: `Concerns`
  - Fraud: `Notes` — `NOTES_FIELD_LABELS.FRAUD` heads the card's free-text
    **discussion thread** (#68), not a separate outstanding-items field;
    relabeled from `Discussion` to `Notes` for consistency (#81). The
    create form (#69) uses a purpose-built `Notes` field plus an
    outstanding-items checklist seeder — see
    [fraud-workflow.md](fraud-workflow.md#structured-outstanding-items-checklist-44)
  - Value / Loan Docs / OOO: `Notes`
