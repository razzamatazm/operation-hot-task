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
a task off, but only to someone eligible to work it.
_Avoid_: "reassignment" as a separate concept — reassigning is just a handoff of
an already-claimed task. (The control still reads "Reassign" when there is a
current assignee, for clarity at the point of use.)

**Observer**:
A viewer who is neither creator nor assignee. Has no move to make, but still
sees the task — visibility is deliberate, so an idle teammate feels the pull to
claim when unclaimed/in-flight work is piling up. Observer in-flight tasks are
de-emphasised relative to a viewer's own.

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
