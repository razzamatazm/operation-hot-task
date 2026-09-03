# 0007. The LOI corrections loop: review is the checker's, corrections are the creator's

Status: Accepted, not yet implemented. Tickets
[#236](https://github.com/razzamatazm/operation-hot-task/issues/236) (permissions),
[#237](https://github.com/razzamatazm/operation-hot-task/issues/237) (naming),
[#238](https://github.com/razzamatazm/operation-hot-task/issues/238) (confirm and archive),
[#239](https://github.com/razzamatazm/operation-hot-task/issues/239) (notification and actor).
Decided on [#228](https://github.com/razzamatazm/operation-hot-task/issues/228).

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

#182 recorded the mismatch as a documentation gap, on the reasoning that the
creator "was never offered a control that did it". That was wrong about the web
app, and the error mattered: it turned a live defect into a docs ticket. The
status quo was not "creators cannot do this", it was "creators are invited to do
this and then refused".

So the question was never only which of the two predicates to keep. It was what
the status is *for*, and the answer turned out to be narrower than the status.

## Decision

**Review is what the checker does. Corrections are what the creator does. They
are different steps and they get different names.**

**1. The corrections state means the ball is with the creator, and it has one
entrance.**

Only the assignee may send a task there, and only from their own review. A
creator never moves a task into corrections, because handing over the task in
the first place *is* the request; a creator who wants another look is asking for
the work to be redone, not flagging a fix. The creator's current route in is
removed.

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

An LOI is the only task type sent back for corrections. FRAUD already has a
two-phase back-and-forth of its own (outstanding items, submit, approve) and
does not need a second one wearing a different name. The remaining types have no
review step to fail: a Buddy Chat, a Value request, or an Out of Office cover is
done or it is not.

This is a removal on four task types. Any live task of another type sitting in
the state at ship time is migrated rather than stranded, and a large or
clustered population is a signal to stop and re-open the question rather than to
migrate harder.

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

**Notifying only the assignee when a creator closes.** This was the first
instinct on #228 and was widened during the same conversation. A one-directional
rule needs a reason for its direction, and there isn't one here.

**Fixing this as a documentation change,** which is what #182 concluded.
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
single rule above. Both #182 and this decision were reached by a human noticing
a mismatch by eye.

An assignee loses the ability to complete a task from the corrections state.
This is the only user-visible removal in the decision, and it will be the one
people notice.
