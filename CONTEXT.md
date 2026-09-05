# Operation Hot Task — Domain Language

Internal Microsoft Teams app for loan operations. Loan officers and file
checkers create short-lived operational tasks, then claim, work, and complete
them. This glossary covers the **whose-court** vocabulary that organises how a
viewer sees the task list. Product workflow and backend contracts live in
[AGENTS.md](AGENTS.md).

## Language

### Whose-court model

**Court**:
Whose move a task is waiting on, *from the viewing user's perspective*. One of
four values — `you`, `pool`, `them`, `done` — derived per viewer from the task's
status, the viewer's role on it, and any unread message. Drives the grouped
view's buckets and agrees with the collapsed-row primary-action ladder (the
bucket a task lands in and the button it offers never disagree).

**Completion chain**:
The ordered sequence of *sections* a task passes through before it is complete.
A standard task is a single section (assignee works it to `COMPLETED`). Two
types pass the ball assignee → creator → assignee: a Loan Docs task through its
merge phases, and an LOI through its corrections loop, where the checker sends
the request back to its creator as _Needs corrections_ and the creator returns
it for a confirming look ([ADR-0007](docs/adr/0007-loi-corrections-loop.md)).
The LOI chain has the app's one ending that skips a section: the checker's
confirm at the tail of it completes *and* archives the task in one action,
because they are signing off somebody else's fix and are not left tidying it
away afterwards.

**Section**:
One leg of the completion chain — the part of the work a single party must
finish before the ball moves on.

**Chain owner**:
The party who owns the *current* section. The task stays in the chain owner's
court (`you` for them) until they complete that section — a message from the
other party can never evict it.

**Message pull**:
An unread message from the other party temporarily places the task in the
recipient's court (`you`), even when they are not the chain owner. It clears the
moment the recipient *reads* it; the task then reverts to the chain owner's
court. A message only ever *adds* a court, never removes one.

**Party**:
A user who is the task's creator **or** its current assignee. The two people
with a stake in the task. Contrast _Observer_.
_Avoid_: owner on its own (ambiguous — use _Chain owner_ for the party who owns
the current section; the row columns are labelled ASSIGNER / ASSIGNEE)

**Handoff**:
Putting a task into someone else's court directly, without waiting for them to
claim it. Alongside claiming and releasing, the third — and only third-party —
way a task's assignee changes. Handing off an unclaimed task lands it straight
in the recipient's court; handing off a claimed one moves it out of the previous
assignee's court and into the recipient's. Both people are told. Anyone may hand
a task off, but only to someone eligible to work it — never to the task's
creator, who is barred by _Second pair of hands_ no matter who does the handing.
_Avoid_: "reassignment" as a separate concept — reassigning is just a handoff of
an already-claimed task. (The control still reads "Reassign" when there is a
current assignee, for clarity at the point of use.)

**Observer**:
A viewer who is neither creator nor assignee. Has no move to make, but still
sees the task — visibility is deliberate, so an idle teammate feels the pull to
claim when unclaimed/in-flight work is piling up. Observer in-flight tasks are
de-emphasised relative to a viewer's own, and carry **no attention signal at
all**: an Observer never gets the unread-note dot and is never _Message
pulled_. Background awareness, not a demand — someone else's in-flight work
should be visible without competing with your own.

### Seats and roles

**Second pair of hands**:
The invariant that a task's creator is never its assignee. A task is a request
for someone else to act, so the two ends of it are always two different people —
enforced wherever an assignee is set, not just where one is claimed, and true of
every task type. See [ADR-0003](docs/adr/0003-creator-is-never-assignee.md).

**Seat**:
Which side of a task's exchange a person occupies *on that task* — the checker
or the requester. Two types have seats: a Fraud Check, and an LOI, whose
assignee is the checker (a claimed LOI displays as _In review_ because that is
what they are doing to it) and whose creator is the requester who takes the
corrections. A fact about the task, distinct from _Role_ (what you are allowed
to do anywhere) and from _Party_ (creator-or-assignee, which is type-agnostic
and takes no side).
_Avoid_: using "role" for this — a role gates entry to a seat, it is not one

**Role**:
An org-wide capability a person carries between tasks: loan officer, file
checker, admin. Grants entry to a _Seat_ and nothing more; a file checker holds
the checker seat only on tasks they are actually assigned. Losing a role
vacates the seats it was holding.

**Resolve**:
Ticking an outstanding item — recording that it was collected or isn't needed.
A fact about the world rather than a move in the exchange, so it is open to
both _Seats_ at any live status and never passes the ball. Contrast the
_Completion chain_, which only hand-offs advance.
_Avoid_: "waive"/"N-A" as separate states (one checked state covers both; the
per-item note carries the reason)

**Instructions**:
A task's standing ask — what it is for, and what it should say *now* rather than
what anybody said about it. Free text in its own bordered box above the
conversation, never echoed into it, required, and correctable in place by
press-and-hold or right-click as well as through _Amend_. Every type has one bar
a **Fraud Check**, whose standing ask is its list of outstanding items and whose
note stays in the thread. The heading is the type's own — `Loan Terms and
Contacts`, `Concerns`, `Things to Look Out For`, `Extras and Edits`,
`Coverage Notes` — because four types sharing the word "Notes" named nothing.
The box freezes when the task closes, unlike the conversation beside it. See
[ADR-0010](docs/adr/0010-every-task-has-an-instructions-box.md).
_Avoid_: "the first note", "the originating message" (the split exists precisely
because it is not one); "notes" for the box (that is the Fraud Check's thread
heading, and the one place the word still means a conversation)

**Terms**:
The _Instructions_ of an LOI Check specifically: the standing description of the
loan being checked — amount, rate, fees, broker, borrower. Worth its own word
because it is the one instance that is a *fact about the loan* rather than the
creator's brief, which is why both _Parties_ may correct it where the other four
types admit only the creator: the checker is the one reading it closely enough
to catch a transposed digit. Labelled `Loan Terms and Contacts` at the point of
use, and the one box drawn in a fixed-width face, since a term sheet only lines
up in one. See [ADR-0008](docs/adr/0008-loi-terms-are-a-field-not-a-message.md).
_Avoid_: "the terms message" (see _Instructions_)

**Amend**:
Correcting a task after filing — its _Instructions_, its urgency, its poop
points, its folder name and Humperdink link, and an OOO task's dates. Open to
both _Parties_, with three exceptions. One is about standing: **the
_Instructions_ of every type but an LOI belong to the creator alone**, because
they are the brief, and the person carrying a brief out does not rewrite it. The
other two are about timing: **urgency belongs to
the creator alone**, because it sets the deadline and the assignee is the person
under it, and so do **an OOO task's dates**, which are the creator's own
absence to declare. Those dates are a scheduled action rather than a deadline —
the return date is when the task wraps itself up, not when someone is late. Any
date is accepted there, including one already past; somebody back early
correcting the record is the case it exists for, and a return date that has gone
simply means the next maintenance pass completes the task. The assignee covering
that desk is told when the window moves. Refused
once the task is closed — completed, cancelled or archived — because a closed
task is a record. Not "on an active task": a Fraud Check parked at
`AWAITING_ITEMS` is waiting on its requester rather than finished, and is the
case whose ask most often needs correcting. Distinct from _Resolve_, which
records a fact about the world, and from a _Handoff_, which moves the seat: an
amendment changes what the task says, never what happened or who is doing it. A
task's type and both its seats are not amendable. Says nothing about the
conversation: a posted message is its author's to fix or withdraw, under
different rules and a different control — see _Message edit_. Reached through
`Edit Task` in the task's menu, which covers every amendable field, and — for
the _Instructions_ alone — by holding or right-clicking the box itself, since
the person who spots a wrong figure is already looking at it. See
[ADR-0008](docs/adr/0008-loi-terms-are-a-field-not-a-message.md), which
supersedes [ADR-0006](docs/adr/0006-amend-task-ask.md), and
[ADR-0010](docs/adr/0010-every-task-has-an-instructions-box.md), which adds the
second door and the per-type _Instructions_ rule.
_Avoid_: "editing the notes" (the box is the _Instructions_ on every type but a
Fraud Check, and on an LOI it is the _Terms_)

**Message edit**:
Correcting or withdrawing a message you posted. The author's alone — not the
other _Party_, not an admin — because a message is a thing one person said,
where an _Amend_ corrects a fact either party can see is wrong. Available
indefinitely and at any status, stopping only when the task is archived, which
is where the conversation itself closes. A corrected message carries a plain
`(edited)`; a withdrawn one leaves a **tombstone**, the muted `Message deleted`
row that keeps the author's name and its place in the thread and counts as a
message like any other. Neither act notifies anybody, re-raises the message as
unread, or moves the task in any list — a correction is not activity. Reached
from a menu on the message itself, held or right-clicked — the gesture the
_Instructions_ box later borrowed, though the box saves on a button where a
message saves on Enter, and a message may be withdrawn where instructions may
not. A message the app prefixed — a send-back's `Needs
fixes:` — keeps its prefix through both: the author owns the words, the app owns
the label. See
[ADR-0009](docs/adr/0009-messages-are-editable-by-their-author.md).
_Avoid_: "amending a message" (an _Amend_ is a task's facts, and answers "who
may change this" differently); "removing"/"retracting" a message (the app says
`Delete` and shows `Message deleted`)

**History**:
The append-only record of what happened to a task and who did it — every claim,
handoff, status move, _Amend_, and _Message edit_, each carrying both values
where something changed. It is what lets the thread and the task's fields stay
clean: the reason a corrected message shows a bare `(edited)` and a withdrawn
one shows only a tombstone is that the previous wording is safe here. Readable
more widely than the conversation it describes, which was accepted knowingly.

**A stored record, not a screen.** No view renders it, by decision rather than
by omission, and reading one back is an occasional technical act rather than
something a _Party_ does. The app reads a few specific answers out of it — when
the current assignee took the task, who completed it, who archived it — and
shows those as reference detail in the task's menu. Nothing in the product
points a person at the record itself. See
[.out-of-scope/task-history-screen.md](.out-of-scope/task-history-screen.md).
_Avoid_: "the audit trail", "the activity log" (both imply a surface somebody
opens); "activity" for anything in here (a _Message edit_ is deliberately not
activity, and does not move the task in any list)

**Back-end access**:
The whole of what _admin_ means. Managing users and roles, system config, and
seeing every task. Admin is not a second identity: it confers no power over
anyone else's work, and never a _Seat_.

### The four courts

**Needs you** (`you`):
Tasks where the viewer is the _Chain owner_ (their section to finish), or has
been _Message pulled_ in by an unread reply from the other party.

**Up for grabs** (`pool`):
`OPEN`, unclaimed tasks the viewer *didn't* create. Anyone may claim; first
claim scores the points. A _Handoff_ takes a task out of this bucket without a
claim — the recipient scores it just the same. (An `OPEN` task you created is
**not** here — it's in `them`, since you're waiting on someone else to claim
it.)

**In flight** (`them`):
Everything not in your court and not closed: tasks whose current section another
party owns, your own `OPEN` tasks awaiting a claim, and _Observer_ tasks. Ordered
so the viewer's own tasks sit first and prominent, then Observer tasks,
de-emphasised, below.
_Avoid_: "waiting on others" (only some of the bucket is something you wait on)

**Done** (`done`):
Closed tasks (`COMPLETED` / `ARCHIVED` / `CANCELLED`). All three ride the same
`CLOSED_TTL_DAYS` retention window and drop off the bottom once they age past
it; admin Metrics counts every status regardless of that filter. See
[status-model.md](docs/product/status-model.md#done-view-retention-ui).

**Paused hold** (`paused`):
A Fraud Check in `Awaiting Items` — the one state where a task's deadline has
stopped meaning anything, because the clock belongs to the requester's original
ask and nothing is measuring it. Never overdue, never reminded on
([fraud-workflow.md](docs/product/fraud-workflow.md#reminder-rules)), and ranked
below every task carrying a live deadline in all three active courts
([ADR-0004](docs/adr/0004-ordering-by-attention-claim.md)). It sits in `you` for
the requester and `them` for everyone else; `courtOf` never routes it to `pool`.
_Avoid_: "stalled", "blocked" (nothing is stuck — the ball is with the
requester)

### Deadlines

**Claim-anchored deadline**:
The rule that a task's deadline is measured from the moment an assignee takes
it, not from when it was filed. Recomputed from the task's urgency on claim and
on every handoff, so pool time is never charged to the person who eventually
picks the task up. OOO tasks are the one exemption. See
[ADR-0005](docs/adr/0005-claim-anchored-deadline.md).
_Avoid_: "resetting the clock" (nothing is reset — the deadline is computed
fresh from the urgency that was asked for)

**Pending claim**:
An unclaimed task seen by its creator, showing how long it has gone unclaimed
rather than how long is left. Counts up, and turns red at 20 minutes, because
the fact that matters to the creator is that nobody has taken it, not that a
deadline is approaching. Measured from when the task last entered the pool, not
from when it was filed: a task handed back on Wednesday has been up for grabs
for minutes, whatever its age.
_Avoid_: "unclaimed since it was created" — true only of a task that has never
been claimed, and the reason the count-up used to overstate itself (#210).

**Pool nag**:
The recurring group-channel post that asks the room to pick up a task nobody has
claimed. Fires every 20 minutes during business hours, replaces the nag before
it, and stops the moment someone claims. It also stops on its own after six
asks: past that the room has heard it, and a seventh post persuades nobody who
was not already going to take the task. Only ever concerns unclaimed work — a
claimed task's deadline is between its assignee and the reminder engine, and is
never raised in the channel.
_Avoid_: calling it "the reminder" — that names the assignee's overdue DM, a
different message to a different person about a different clock. (Both ride the
same `TASK_REMINDER` notification type on the wire; the surfaces, not the type,
are what tell them apart.)

### Views

**Grouped view** (a.k.a. **Courts view**):
The task list split into the four court buckets. The default; the choice is
persisted per browser.

**Flat view**:
The single unified list, sorted by status then due, with no sections — the
Assigner / Assignee columns carry whose-court on every row. The user-selectable
counterpart to Grouped view.
_Avoid_: sections (the flat list intentionally has none)

### Loan model

See [ADR-0001](docs/adr/0001-loan-entity.md) for the full decision.

**Loan**:
A first-class, reusable record (name + optional Humperdink link) that
non-OOO tasks link to instead of duplicating loan info as free text. OOO
tasks never have a Loan — their Folder Name is a Vacation Description, not
a loan reference.

**Live reference**:
A task's displayed loan name/link is read from its linked Loan record, not
copied at creation time. Editing a Loan updates every task linked to it,
including historical ones.

**Loan merge**:
When two Loan records are found to share the same Humperdink link (the
canonical unique key for a Loan once it has one), they're auto-merged: the
newer record's tasks repoint to the original, and the newer name is kept
as an alias. Triggered automatically, surfaced with a visible notice —
never a silent, unnoticed change.
