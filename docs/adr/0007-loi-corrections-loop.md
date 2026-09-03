# 0007. The LOI corrections loop: review is the checker's, corrections are the creator's

Status: Accepted and implemented (#236, #237, #238, #239). Tickets
[#236](https://github.com/razzamatazm/operation-hot-task/issues/236) (permissions),
[#237](https://github.com/razzamatazm/operation-hot-task/issues/237) (naming),
[#238](https://github.com/razzamatazm/operation-hot-task/issues/238) (confirm and archive),
[#239](https://github.com/razzamatazm/operation-hot-task/issues/239) (notification and actor).
Decided on [#228](https://github.com/razzamatazm/operation-hot-task/issues/228),
which also turned up
[#240](https://github.com/razzamatazm/operation-hot-task/issues/240) and closed
it as superseded here.

## Context

`NEEDS_REVIEW` was added as a side branch off the main ladder: reachable from
`CLAIMED` or `COMPLETED`, by creator or assignee, on any task type. It is in no
flow array, which is why it needs a special case wherever the forward step is
computed.

Nobody ever settled what it *means*, and two rules drifted apart in the gap.
`canMoveNeedsReview` admits creator, assignee and the scheduler. `canCompleteTask`
admits the assignee alone. The web app gates its Complete button on the first
and the server enforces the second, so a creator has been shown a Complete
button that answers with "User cannot complete this task". No test covers the
agreement between a rendered control and the server that must accept it, which
is why [#182](https://github.com/razzamatazm/operation-hot-task/issues/182)
tightened the bot cards without noticing the web app had the same fault in the
opposite direction.

#182 did not settle this. It raised the three-way opening of the corrections
state as an open question and deferred it here. The docs-gap framing came later,
in #228's own opening: that the creator "was never offered a control that did
it", so nothing needed fixing but the written rule. That was wrong about the web
app, and the error mattered: it would have turned a live defect into a docs
ticket. The status quo was not "creators cannot do this", it was "creators are
invited to do this and then refused".

So the question was never only which of the two predicates to keep. It was what
the status is *for*, and the answer turned out to be narrower than the status.

## Decision

**Review is what the checker does. Corrections are what the creator does. They
are different steps and they get different names.**

**1. The corrections state means the ball is with the creator, and it has one
entrance.**

Only the assignee may send a task there, and only from the task they are
holding — the corrections state is the exit from their own review. A creator
never moves a task into corrections, because handing over the task in the first
place *is* the request; a creator who wants another look is asking for the work
to be redone, not flagging a fix. The creator's current route in is removed.

The rule is about people, so the automatic route in survives it. Alongside the
two parties, the current rule admits the system actor, which is how anything the
app does on its own behalf moves a task. That is not a seat and nothing here
takes it away; "only the assignee" means only the assignee among people.

That gives the state a single meaning. Previously it was reachable from both
directions and so meant "somebody wants somebody to look at something", which is
not a state anyone can act on without first working out how the task got there.
A rule that depends on invisible history is a rule the person looking at the
task cannot see.

**2. From corrections, the creator has two moves, and the assignee waits.**

The creator either closes the task or sends it back for a confirming look. The
common case is the first: the correction is a typo or a formatting fix, and
requiring the checker to re-open it buys nothing. The second exists for anything
the creator would rather have re-checked.

The assignee cannot complete from this state and cannot pull the task back to
themselves. This *removes* an ability they have today, deliberately. If the
state means the ball is with the creator, then a checker closing it out is the
checker deciding the creator's fix was unnecessary without seeing it.

The assignee keeps the notes thread. Waiting is not the same as being shut out,
and the thread is the right surface for "actually, leave that one".

ADMIN confers nothing, per [ADR-0003](0003-creator-is-never-assignee.md).

**3. Corrections are LOI-only.**

An LOI Check is the only task type sent back for corrections. The state is
reachable on all six today, because it sits outside every type's own flow and is
gated by nothing.

Fraud Check already has a two-phase back-and-forth of its own (outstanding
items, submit, approve) and does not need a second one wearing a different name.
Loan Docs already passes the ball back to its creator through its merge phases,
which is the same shape by another route. The last three have no review step to
fail: a Buddy Chat, a Value Check, or an Out of Office cover is done or it is
not.

So this is a removal on five task types, not four — Fraud Check and Loan Docs
included, even though neither loses anything it was using. Any live task of
another type sitting in the state at ship time is migrated rather than stranded,
and a large or clustered population is a signal to stop and re-open the question
rather than to migrate harder.

Fraud Check's own use of the state is being retired rather than repaired. #240
found that a fraud checker sitting in it is permitted to complete and is simply
offered no button — a missing label, not a permission fault. Locking the state
to LOI removes the surface that label would have gone on, which is why #240 is
closed as superseded rather than built.

**4. The names were backwards.**

The status displayed as **IN REVIEW**, which describes a claimed LOI, not this.
By the time a task reaches this state the review has happened and the checker
has found something. It becomes **Needs corrections**, and a claimed LOI takes
the freed-up **In review**.

The claimed-task rename is LOI-only. The other five keep their wording, because
someone claiming an Out of Office cover is not reviewing anything. Per-type
wording is an existing pattern here, not a new one: `NOTES_FIELD_LABELS` already
varies the notes field by task type.

The move out of corrections was labelled **Undo Review**, which reads as an
administrative correction. It is a creator deliberately asking for a second
look, and it is renamed to say so.

**5. The checker's confirm at the tail of the loop closes and archives in one
action.**

Completion and archival are two steps everywhere else, and rightly: the creator
sees their task land as done before it goes away. The tail of this loop is the
exception. There the checker is confirming a fix on a task that was never
theirs, and leaving them to complete it and then tidy it away gives them
housekeeping for someone else's request.

The creator still sees it land as done, via the notification in rule 6 and in
their finished work. What they do not get is a task loitering in an active queue
waiting to be dismissed.

**6. Whoever did not press the button is told, and the record names who did.**

Symmetric, deliberately: the creator closes it and the assignee hears, the
assignee confirms and closes it and the creator hears. One sentence, no cases to
remember. Nothing goes to the channel, per
[ADR-0002](0002-task-handoff.md) — this is two-party business.

Completion and archival record the acting person. Until now "the task was
completed" and "the assignee completed it" were the same statement, so the
history never had to distinguish them. Once a creator can close a task assigned
to somebody else, an unqualified "completed" reads as though the assignee signed
off. That is the wrong answer to the only question anyone asks a task history
weeks later.

## Considered and rejected

**Keeping completion assignee-only and hiding the button from the creator.**
This was the recommendation in #228 and the one triage initially argued for, on
the grounds that whoever does the work says it is done. Rejected on the
operational reality: the correction is usually a spelling error in the creator's
own text, and routing it back through the checker to click Complete is ceremony.
The consistency it buys is with a rule (`canCompleteTask`) rather than with
anything a user experiences.

**Letting the completion rule differ by how the task entered the state.** The
state has two entrances today, and the intuitions about who closes it do differ
between them. Rejected: the button's meaning would depend on history nobody
looking at the task can see. Rule 1 removes the second entrance instead, which
answers the same problem by deleting it.

**Keeping the state on all six task types.** Rejected as unused surface that has
to be reasoned about forever. FRAUD has its own loop; the rest have nothing to
correct.

**Renaming a claimed task to "In review" on every type.** Rejected: it would
mislabel four of the six.

**Auto-archiving every completion.** Rejected. The creator seeing their task
land as done is worth a step on the normal path; rule 5 is scoped to the one
case where the closer is not the owner.

**Notifying only the assignee when a creator closes.** The obvious reading of
rule 2 is that the creator's close is the newsworthy event, because it is the
new ability. Rejected: a one-directional rule needs a reason for its direction,
and there isn't one here. Both closes end the task for somebody who did not
press the button.

**Fixing this as a documentation change,** which is how #228 was opened.
Rejected once the web button was found to be live and erroring. The docs were
wrong *and* the code was.

## Consequences

The app gets its first completion that is not the assignee's, which makes
`canCompleteTask` no longer a synonym for "is the assignee". Anything that
inferred the actor from the assignee field on a completed task is now wrong;
rule 6 exists to make the actor explicit rather than inferred.

`NEEDS_REVIEW` becomes the first status gated on task type. Every other status
is either universal or reached only through a type's own flow array. This one is
universal in the ladder and restricted by rule, so the restriction has to be
enforced where the move is made rather than implied by the flow.

The test suite gains the assertion that was missing: for every combination of
status, seat and task type, a control a surface offers is a control the server
accepts. That is the actual root cause here, and it is worth more than any
single rule above. #182 tightened the bot cards against exactly this fault and
the web app kept it in the opposite direction, which is what an assertion would
have caught and a second audit did not.

Rule 5 leaves the creator's window to amend the ask alone. That window already
ends at completion rather than at archival ([ADR-0006](0006-amend-task-ask.md)),
so collapsing the two steps into one takes away nothing that was reachable.

The glossary owes two entries. CONTEXT.md defines a *seat* as the checker or
requester of a Fraud Check, and gives the assignee-to-creator-and-back
*completion chain* to Loan Docs alone. Rule 2 gives an LOI the same chain shape
and rule 4 puts a checker on it, so both entries are narrower than the app will
be. They are correct until this ships; #237 carries the rename and should carry
the glossary with it.

An assignee loses the ability to complete a task from the corrections state.
This is the only user-visible removal in the decision, and it will be the one
people notice.
