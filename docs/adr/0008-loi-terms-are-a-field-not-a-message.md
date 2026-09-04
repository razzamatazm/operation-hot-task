# 0008. An LOI's terms are a field, not a message

Status: Accepted, not yet implemented. Supersedes
[ADR-0006](0006-amend-task-ask.md).

## Context

[ADR-0006](0006-amend-task-ask.md) drew the line that mattered at the time: a
task's *ask* is revisable by the person making it, and the *record* is not. It
gave the creator two fields — notes and urgency — and gave nobody else
anything.

It also left one thing conflated, because nothing yet forced the question. On an
LOI Check the notes field is labelled **Loan Terms and Contacts**, and the
Humperdink import appends its terms block into it, *below* whatever the officer
typed. The web app then renders that same field as the first row of the notes
thread, styled identically to every reply. So one field is doing two jobs at
once — it is the standing description of the loan being checked, and it is
message number one in a conversation — and the UI presents it as the second.

That works until somebody types a rate wrong. The terms are the thing the
checker is checking *against*; a transposed figure makes the whole check wrong.
Under ADR-0006 the creator can already fix it, but the affordance is a small
`Edit request` button on the thread head inside the expanded body, and the
person who notices is almost always the checker, who is refused. The rule reads
as "corrections are hard and belong to the wrong person" at the one moment
accuracy matters most.

Two further pressures arrived after ADR-0006:
[ADR-0007](0007-loi-corrections-loop.md) built a corrections loop whose entire
premise is that the creator has something to fix, and a direct import from the
originating system is planned, which will hand the app terms as structured data
rather than as pasted text.

The question is not "should more fields be editable". It is whether an LOI's
terms are part of the conversation at all.

## Decision

**An LOI's terms are a standing description of the loan. The conversation is a
log of what people said. They are different things, they get different boxes,
and they get different rules.**

Everything below follows from that sentence.

**1. Terms become their own section, and leave the thread.**

The LOI request field is rendered as a distinct bordered section in the expanded
task, above the conversation. It is **not** echoed as the first message. The
conversation therefore starts genuinely empty on a new task and says so.

Echoing was considered and rejected: it is the exact confusion this removes, and
it has no answer to what happens to the copy when the terms are corrected.

**Free text, not structured fields.** People type a handful of lines — amount,
term, rate, points, broker, borrower — and the value is in the box being
separate, not in the app parsing it. A form of ~25 optional fields, most empty
on most loans, would clutter the surface to buy a formatting improvement nobody
asked for. Structured terms are the right end state and are deliberately
deferred until the direct import exists, at which point the app will receive
them already structured and the question can be answered with real field
coverage rather than a guess at it. Rendered in the body font with tight
leading, so a typed list reads as a list.

**Terms are required, on creation and on edit.** They are required today; an
edit that could empty them would make a checked LOI that says nothing about what
was checked.

**2. LOI only.**

The other five types keep one blended field rendered as the thread's first
message, unchanged. The split earns its keep where a field holds *facts a second
person is verifying*. A Buddy Chat's concerns and an Out of Office's description
are the creator's own words about their own situation; there is nothing in them
for anyone else to correct, and giving all six types two boxes would add a
section that is empty of purpose on five of them.

This does mean an LOI and a Buddy Chat are laid out differently. Accepted
deliberately, after looking at the two side by side.

**3. The create form does not change, and no new field is added.**

No opening-message field. Nobody writes a message to a task nobody has claimed
yet.

More than that: **Terms are the field the task already has.** The LOI request
field has always held them, has always been required, and has always been
authored by the creator at creation — which is why every existing LOI's first
thread row is its terms. So this decision adds no column, changes no payload,
and migrates no data. It changes where that field is drawn and who may write to
it.

A separate structured `terms` field is the shape the direct import will
eventually want, and adding it now would be paying for that before it can be
designed against real field coverage. Deferred with rule 1.

The import's existing behaviour — appending its block beneath anything already
typed, and replacing that block rather than stacking on a re-import — is
untouched and still correct.

**4. Editing moves into the hamburger, as `Edit Task`, and it is the only door.**

The `Edit request` button on the thread head is removed. The hamburger is
already where the app keeps "what can I do to this task", and a second entrance
on the terms box was considered and rejected as a surface that can drift from
the first.

The form is shaped like the create form, with a save action in place of the
create action, and covers:

| Field | Editable by |
|---|---|
| Terms (LOI) / notes (other types) | LOI: both parties. Others: creator |
| Folder name | both parties — writes the shared Loan record |
| Humperdink link | both parties — writes the shared Loan record |
| Poop points | creator |
| Urgency (non-OOO) | **creator only** |
| OOO start and return dates | creator |
| Task type | nobody — shown disabled with its reason |

Poop points remain editable in place on the collapsed row. Two paths to one
number is worth more than the tidiness of removing the fast one.

**5. Both parties may correct the task. Urgency is the exception.**

ADR-0006 admitted the creator alone. That was right about urgency and
over-broad about everything else.

Urgency stays the creator's, for ADR-0006's original reason unchanged: it sets
the deadline, the assignee is the person under it, and an assignee who can
extend their own deadline is not accepting a deal. It also destroys the only
signal that a task ran long.

Everything else on the form is a *fact* — what the loan says, what it is called,
where it lives, what it is worth. The checker is the person reading those facts
closely enough to notice one is wrong, and requiring them to ask the creator to
fix a transposed digit is ceremony around a typo.

**Only the two parties, at any status.** Not an observer, not a file checker who
has not claimed the task, not an admin — per
[ADR-0003](0003-creator-is-never-assignee.md), back-end access confers nothing
over other people's work. This narrows the *existing* Loan edit surface, which
is open to any authenticated user today.

Messages themselves stay immutable. Editing your own message, with an edited
marker, is a coherent thing to want and is deliberately left as separate future
work rather than smuggled in here — it is the one change in this area that
touches what people said to each other rather than what the task says.

**6. Closed tasks stay frozen.**

Unchanged from ADR-0006. Reopening is the route for a genuine late correction,
and the conversation stays open on completed tasks regardless.

**7. Editing the folder name or Humperdink link writes the shared Loan record.**

Both already live in two places — on the task and on the linked `Loan` — and the
row displays the Loan's copy ([ADR-0001](0001-loan-entity.md)). An edit targets
the Loan, so the two can never disagree. If the name is wrong on one task it is
wrong on all of them, which is the case that motivates the edit in the first
place.

The consequence is visible but quiet: **one** muted line beneath the two fields,
covering both, appearing only once a value has actually been changed. Not on
focus — clicking a field to read it should warn about nothing — and never as a
dialog. A user thinks "the file name is wrong", not "I am editing a shared
reference record", and the design's job is to tell them at the moment it becomes
true, without theatre.

**A link edit that would merge two Loans is confirmed first, naming the other
loan.** Merging is usually correct — duplicate records for one loan is the
problem the merge exists to solve — but absorbing another loan's tasks is too
large a consequence to fall out of fixing a URL unannounced.

**8. Vacation dates become editable.**

ADR-0006 excluded them as "a genuinely different behaviour to build", correctly
identifying that an OOO return date is a scheduled action rather than a
deadline. It is now built, by the creator, and **any date is accepted, including
one in the past**. Someone back early is exactly the case that needs correcting,
and a task whose return date has passed auto-completes on the next maintenance
pass — which is the honest outcome, not a bug to guard against. Both dates
re-derive everything that hangs off them.

**9. Who hears about it.**

- **Terms** — silent while the task is unclaimed; the assignee is told once
  there is one. Terms changing under a working checker is the change most likely
  to make their work wrong, which is what separates it from the wording fix
  ADR-0006 was right to keep silent.
- **Urgency** — the assignee is told, unchanged.
- **OOO start and return dates** — silent while unclaimed; the assignee is told
  once there is one. Not because the dates are a deadline — rule 8 is explicit
  that a return date is a scheduled action — but because the assignee is
  covering that desk across the window, and the window moved. This list
  originally omitted the dates only because ADR-0006 had banned editing them
  outright; rule 8 lifts the ban, so the silence was a gap rather than a ruling.
- **Notes on the other five types** — silent, unchanged.
- **Nothing goes to the channel**, per [ADR-0002](0002-task-handoff.md).
- **Cards stop quoting an LOI's terms.** The notification cards include a
  `Notes:` line today; on an LOI that becomes the full terms block. A card is a
  nudge to go and look at the task, and one that has to be scrolled is one
  people stop reading. The other five keep their line, which is a sentence.
- **Every applied edit is in the task's history with both values**, unchanged
  from ADR-0006 and extended to the new fields.

**10. Existing LOI tasks migrate.**

An existing LOI's first message is always its terms — the field has always been
required and has always been authored by the creator at creation. It moves into
the terms box; replies stay in the conversation. No detection or parsing is
involved, so there is nothing to get wrong.

## Considered and rejected

**Two boxes on every task type.** The tidier-sounding answer, and the one
originally recommended: the ask is a standing thing on all six types, so give
them all the same layout. Rejected on the specific grounds that five of the six
have no second party verifying the field's contents, so the section would be
structure without meaning — and one consistent-but-pointless section on five
types is a worse trade than two layouts where the difference is real.

**Structured term fields now.** See rule 1. Right eventually, wrong before the
import that would populate them.

**A second edit entrance on the terms box itself.** Fewer clicks from where the
error is spotted, at the cost of two surfaces that must be kept in agreement.
Rejected in favour of one door.

**Letting the assignee change urgency.** See rule 5. This is the one place
ADR-0006's reasoning survives intact.

**A dialog, or a persistent warning banner, on the shared-name edit.** Rejected
as disproportionate — see rule 7.

**Detecting and separating the imported terms block from text typed after it in
existing tasks.** Rejected: guesswork on other people's writing, to slightly
improve a handful of short-lived tasks that clear within days.

## Consequences

ADR-0006 is superseded rather than amended. The rule it wrote —
creator-only, notes-and-urgency — survives in exactly one clause (urgency), and
a decision record whose every other clause has been overturned is more
misleading kept than replaced.

The glossary's **Amend** entry, which warns against saying "edit the task" as
too broad, no longer holds: `Edit Task` is what this is, and the entry is
rewritten alongside a new **Terms** entry.

The two edit surfaces ADR-0006 noted as deliberately answering "who may change
this" differently now answer it the same way, in the narrower direction: the
Loan editor stops being open to any authenticated user. Any surface that edits a
Loan outside a task context must be checked against this.

`notes` on an LOI stops being a thread member. Anything that assumed the thread's
first row is the originating note must be checked, including the unread-message
calculation and the bot's DM reply cards.
