# 0005. A task's ask is amendable by its creator, and only its ask

Status: Accepted (design). Implementation tracked in
[#160](https://github.com/razzamatazm/operation-hot-task/issues/160).

## Context

A task's own fields are immutable once created. File one with the wrong urgency
or a typo in the notes and the only remedy is to cancel and refile, which throws
away the task's history, its notes thread, any seeded checklist, and re-posts a
fresh card to the channel and to DMs. There is no `PATCH /tasks/:taskId` route;
the complete set of task mutations is claim, unclaim, release, transition,
points, note-append, checklist operations, share, and assign.

Two things *are* editable, and neither is a general answer. A `Loan`'s name and
Humperdink link can be changed — but they live on the `Loan` record, so the
change ripples to every task linked to it ([ADR-0001](0001-loan-entity.md)), and
it cannot touch a task-level field anyway. Poop points can be changed by the
creator on an active task. That second one is the shape this decision follows.

The question is not merely "add an edit endpoint". It is which parts of a task
are a standing description of the request, revisable by the person making it,
and which are a record of what happened, or a deal someone else has already
accepted.

## Decision

**A task's creator may amend the ask; nobody amends the record.** Three rules
decide what that covers.

**1. The editable set is the notes and the urgency, and nothing else.**

- **Notes** — the free-text description of the request, on every task type.
- **Urgency** — on non-OOO tasks. `dueAt` is **derived** from it, exactly as at
  creation, computed from the moment of the edit. It is never set directly.
  This is not a simplification: due date is tracked backend-only and is
  deliberately not a field anywhere in the main tab UI
  ([due-date-urgency.md](../product/due-date-urgency.md)). Users express timing
  as "within 1 hour" or "end of day", so an edit that offered a raw date picker
  would introduce a control the product does not otherwise have and would let
  `urgency` and `dueAt` disagree — a colour band describing a deadline it did
  not produce.

Everything else is excluded, each for its own reason rather than by default:

- **Task type** selects the status ladder. A FRAUD task travels a two-phase flow
  and carries a checklist no other type has; a LOAN_DOCS task has merge steps.
  Changing type mid-flight would require answering what happens to a task
  standing on a status its new ladder does not contain, and there is no useful
  answer. Refiling is correct here.
- **The linked loan.** Repointing a task at a different `Loan` is a different
  operation from correcting the request, and ADR-0001 already gave loan data its
  own edit surface.
- **Creator and assignee.** Both already have doors —
  [ADR-0002](0002-task-handoff.md) for the seat,
  [ADR-0003](0003-creator-is-never-assignee.md) for who may hold it.
- **OOO start and return dates.** An OOO task derives `dueAt` from its return
  date *and auto-completes on it*, so the field is a scheduled action rather
  than a deadline. Editing it is a coherent thing to want and a genuinely
  different behaviour to build; it is deliberately left out of this decision
  rather than smuggled in under "timing".

**2. The creator alone, and only while the task is active.**

The creator defines the ask — the same reasoning that makes points theirs ("the
points say what the creator thinks the ask is worth") and that ADR-0003 built
the second-pair-of-hands invariant on. The assignee is often the person who
*discovers* the urgency is wrong, and they have the notes thread to say so; that
is a conversation, not a unilateral edit of someone else's request.

ADMIN confers nothing here. Per ADR-0003 admin is back-end access only and holds
no power over other people's work.

Editing is refused on closed tasks — completed, cancelled, archived — mirroring
the points rule and the checklist freeze. A closed task is a record.

**3. An edit that changes the deal is announced; an edit that changes the
description is not.**

Both kinds re-render the task's existing cards in place through the silent
card-sync path, so no surface is left quoting a stale value.

Beyond that they differ, and the difference is whether somebody else's
obligation moved:

- **Urgency** — when the task has an assignee, they are told. Somebody accepted
  a deadline and it has changed; discovering that from a quietly re-rendered
  card is how a person is made late without being told.
- **Notes** — silent. Correcting a typo in a description is not an event, and a
  DM for every wording fix is exactly the noise that would train people to
  ignore the ones that matter.

Neither posts to the channel. The channel saw the task when it was created, and
[ADR-0002](0002-task-handoff.md) already rejected channel announcements for
two-party business.

**Every edit is recorded in the task's history with its old and new value.**
`TaskHistoryEvent.action` is a free-form string, so this is cheap, and an
amendable ask without a trail is one where "it always said that" is
unfalsifiable.

**Moving `dueAt` clears the reminder stamp.** The reminder engine gates on
overdue and then on time-since-last-reminder. Left alone, shortening a deadline
would leave a newly-overdue task silent for up to the remaining cadence window
because it happens to have been reminded on recently.

## Considered and rejected

**A generic `PATCH /tasks/:taskId` accepting any subset of the task.** Rejected:
it inverts the decision. The whole content of this ADR is *which* fields are
amendable and by whom, and a generic patch endpoint pushes that question out to
a validation list that nobody reads as a rule. Focused operations that each name
their field and refuse with a message naming the rule — the shape the points
update already has — keep the rule where it can be seen.

**Letting the assignee edit the due date.** They are the person who most often
knows it is wrong. Rejected because the ask belongs to the requester: an
assignee who could move their own deadline is not accepting a deal, and the
notes thread is a better answer to "this needs longer" than a silent
self-extension. Widening this later is easy; narrowing it after people have
built habits on it is not.

**Allowing a raw `dueAt` edit alongside urgency.** Rejected — see rule 1. Two
fields that can disagree, in a product whose UI shows only one of them.

**Announcing every edit, including notes.** Rejected as noise, per rule 3.

**Editing closed tasks, to correct the historical record.** Rejected: that is
the definition of a record. The notes thread stays open on completed tasks for
anything that needs saying afterwards.

**Backfilling or retroactively correcting tasks that are already wrong today.**
Out of scope — they are amendable going forward like anything else.

## Consequences

The app gains its first task-level edit surface. Until now the only
post-creation edit was on the `Loan` record, which is open to any authenticated
user; this one is not, so the two edit surfaces answer "who may change this"
differently and the difference is deliberate — a Loan is shared reference data,
a task is one person's request.

`dueAt` becomes a value that can move during a task's life for a non-OOO task,
where previously it was stamped once at creation. Anything that assumed
otherwise must be checked: the ordering comparator reads it live and is fine,
`isOverdue` reads it live and is fine, and the reminder stamp is handled by rule
3. Note that [#181](https://github.com/razzamatazm/operation-hot-task/issues/181)
is separately weighing whether `dueAt` should move on claim — that is a
different question about whose clock is running, and this decision neither
settles it nor depends on it.
