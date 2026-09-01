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
A standard task is a single section (assignee works it to `COMPLETED`); a Loan
Docs task has several, passing the ball assignee → creator → assignee through
its merge phases.

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
or the requester of a Fraud Check. A fact about the task, distinct from _Role_
(what you are allowed to do anywhere) and from _Party_ (creator-or-assignee,
which is type-agnostic and takes no side).
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
deadline is approaching.

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
