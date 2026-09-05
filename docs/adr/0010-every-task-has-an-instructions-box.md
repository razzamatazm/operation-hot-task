# 0010. Every task has an instructions box, edited where it stands

Status: Accepted, not yet implemented. Amends
[ADR-0008](0008-loi-terms-are-a-field-not-a-message.md) rules 2, 4 and 9.
Extends the gesture built for [ADR-0009](0009-messages-are-editable-by-their-author.md)
to a field.

## Context

[ADR-0008](0008-loi-terms-are-a-field-not-a-message.md) split an LOI's terms
out of the notes thread and gave them their own bordered section, and it drew
the line there deliberately. Rule 2 says LOI only, on the grounds that the split
earns its keep where a field holds *facts a second person is verifying* — true
of a loan's terms and of nothing else. Rule 4 says the task's hamburger is the
only door to editing, on the grounds that a second entrance on the box itself is
a surface that can drift from the first. Its "considered and rejected" section
names "two boxes on every task type" and refuses it as "structure without
meaning" on five of the six.

Both of those were argued before anyone had used either thing. Now both are
built, and the argument reads differently from the inside.

The terms box turns out not to be about verification at all. What it does is
put the standing description of the work at the top of the card, where somebody
picking the task up reads it, and keep it out of a conversation that grows away
from it. That is worth exactly as much on a Value Check. On the other five types
the creator's required field is rendered as the thread's first message — a
bubble with an avatar and a byline, deliberately carrying no message menu
because it is a field pretending to be a message. Two or three replies later it
has scrolled, and the instructions somebody is working from are somewhere above
the fold in a list of chat.

Rule 4 fell to the same kind of evidence.
[ADR-0009](0009-messages-are-editable-by-their-author.md) shipped press-and-hold
and right-click on a message, and it is now the gesture people in this app know.
The single-door rule was bought with a real cost: the person who spots the wrong
rate is looking straight at it, and has to go and find a menu. A second door is
a genuine risk of drift, and it is a smaller cost than the one being paid.

A Fraud Check is the case that does not move, and the reason is instructive. Its
standing ask is already a structured list of outstanding conditions at the top
of the card. It is the one type that already solved this, in its own way, and a
second box above the list would be the structure-without-meaning ADR-0008 was
worried about.

## Decision

**The instructions are the standing ask: what a task is for, and what it should
say right now. The conversation is what people have said since. They are
different things, they get different boxes, and every type gets the split — bar
the one type that already has it.**

**1. Every type gets an Instructions box. A Fraud Check does not.**

Five types — LOI Check, Buddy Chat, Value Check, Loan Docs, Out of Office — draw
their existing required field as a bordered section above the conversation, and
out of it. This is the section ADR-0008 rule 1 built, unchanged in shape or
placement, extended to four more types.

A Fraud Check keeps its note in the thread as message one, and its outstanding
conditions list stays the standing surface at the top of the card. It is the
only type whose ask was already a structured thing rather than a paragraph, and
stacking a prose box above that list would ask a filer to say the same thing
twice in two shapes.

ADR-0008 rule 2's reasoning — the split is for fields a second person verifies —
is withdrawn. The split is for the standing ask, and every type has one.

**2. The headings.**

| Type | Heading |
|---|---|
| LOI Check | `Loan Terms and Contacts` |
| Buddy Chat | `Concerns` |
| Value Check | `Things to Look Out For` |
| Loan Docs | `Extras and Edits` |
| Out of Office | `Coverage Notes` |
| Fraud Check | `Notes` (in the thread, no box) |

Four of the six said `Notes` before this. That was survivable as the header of a
message list. As the title of the bordered box telling somebody what to do, it
is the weakest word available, and four types sharing it means the heading
carries no information at all.

`Extras and Edits` is the one worth explaining. Loan Docs are drawn by merge:
the standard set falls out of the template, and what the requester needs to say
is the delta — wording to be typed into a document, or an extra document to be
generated. An addition to a document is an edit and an extra document is an
extra, so the heading names both cases without listing them, and without
depending on the reader knowing the word *merge*.

**3. A Fraud Check's note stops being required, and filing needs one of the
two.**

The note is required on every type today, including Fraud, and predates the
conditions list. Now that a filer can seed the list at creation, a Fraud Check
whose conditions are already itemised has nothing left to put in a note, and
requiring one buys a line of filler.

So the Fraud form requires **a note, or at least one condition**. Neither is
refused, because a request that says nothing is not a request. A Fraud Check
filed with conditions and no note opens with an empty conversation, which is
what an LOI has done since ADR-0008 rule 1.

The other five keep a required field, unchanged. There is no version of those
where something else carries the ask.

**4. The box is edited where it stands, and in the form.**

Press and hold, or right-click, exactly as on a message: the menu appears beside
the box and the box becomes an editor in place.

**It behaves like a field once it is open, not like a message.** Enter makes a
new line, an explicit save commits, escape cancels. A message editor can take
Enter as save because a message is a sentence; this box holds a pasted term
sheet a dozen lines long, and a rewrite in progress is a real loss rather than a
shrug. **There is no delete** — instructions cannot be emptied, per ADR-0008
rule 1, and offering a control that is always refused is worse than not offering
it.

The box also stays in `Edit Task`. Two doors to one field is the thing ADR-0008
rule 4 refused, and it is accepted here: the field the most people most often
need to fix should not be the one field missing from the edit form, and somebody
changing three things at once should not have to close the form to change the
fourth. The drift risk is real and is answered the way the permission rules
already are — one shared rule, asked by both surfaces, never re-implemented at
either.

**5. Who may correct it is unchanged.**

Both parties on an LOI; the creator alone on the other four. ADR-0008 rule 5's
reasoning survives intact and is not re-opened by the box moving: an LOI's terms
are facts the checker is checking against, and a Buddy Chat's concerns or a
Loan Docs brief are the requester's instructions, which the person carrying them
out should not be able to rewrite. A checker who thinks the brief is wrong says
so in the conversation.

The hold gesture is offered only to somebody the rule admits. A box nobody may
edit is a box that does not respond to a hold.

**6. The box freezes when the task closes.**

ADR-0008 rule 6, unchanged and now applied to five types. A completed, cancelled
or archived task offers no hold and no `Edit Task`; reopening restores both.

This is deliberately stricter than a message, which stays editable until the
task is archived (ADR-0009 rule 2), and the two rules are about different
things. A message is what one person said, and the thread's job is to read
correctly today. The box is what the task asked for, and a completed check is
the record of what was checked — quietly rewriting the brief afterwards is the
one version of this that damages something.

**7. The holder is told, on every type.**

ADR-0008 rule 9 made a terms change notify the LOI's assignee and left the other
five silent, because on those five the field was a wording fix. It is now the
instructions somebody is working from, and the reason the LOI was noisy — the
change most likely to make the work wrong — applies to all five.

So: silent while the task is unclaimed, a DM to the assignee once there is one,
and never to the actor. The message **names the box by its heading and does not
quote the new text**, so a Value Check says its things to look out for changed
and a Loan Docs says its extras and edits changed. Nothing goes to the channel,
per [ADR-0002](0002-task-handoff.md). Every applied change is in the task's
history with both values, unchanged.

**8. The notification cards are untouched.**

The DM and channel cards quote a short `Notes:` line on five types and omit it
on an LOI, whose terms were long enough to make a card people had to scroll
(ADR-0008 rule 9). That difference is about length, and nothing here changes how
long a Value Check's instructions are. The five keep the line; the LOI keeps its
silence.

**9. Nothing migrates.**

As with ADR-0008 rule 10 and for the same reason: this is the one required field
every task has always had, drawn somewhere else. No column is added, no payload
changes, and no text is parsed or split. `standingTermsFor` (renamed
`standingInstructionsFor` when #300 built this rule) is the single place
the question "is this field in the thread?" is answered, and this decision
changes that one answer from *LOI* to *anything but a Fraud Check*.

## Considered and rejected

**A box on a Fraud Check too, for consistency.** The tidy answer, and the one
this ADR's own principle argues for if applied without looking. Rejected because
a Fraud Check's standing ask is the conditions list, sitting where the box would
go and doing the box's job better than prose can. Six identical layouts bought
at the price of asking one filer to state their ask twice is a bad trade, and it
is the same trade ADR-0008 refused in the other direction.

**Keeping `Notes` as the heading on the four types that had it.** No migration,
no arguing about words. Rejected: promoting a field to a titled box at the top
of the card and titling it with the least informative noun available wastes the
change. If the box is worth building it is worth naming.

**`Anything Unusual` on Loan Docs**, pairing it with the Value Check's heading.
Rejected on two counts. A Value Check is verification, where exception reporting
genuinely is the whole ask; Loan Docs is production, where "nothing unusual" is
a true answer and a useless brief. And two adjacent types headed with two
phrasings of one idea read as the same box named twice, so people stop noticing
which type they are on.

**Making the Value Check box optional**, since a heading that asks for
exceptions will often be answered "nothing". Rejected: "nothing unusual" is a
real answer that takes four seconds, and an empty box leaves the checker unable
to tell whether the requester had nothing to say or could not be bothered. The
distinction is the whole value of asking.

**Making the box behave exactly like a message** — Enter to save, delete
available, escape discarding silently. Rejected in rule 4. The gesture is worth
copying because it is the one people know; the keystrokes are not, because the
content is not a sentence.

**Dropping the field from `Edit Task` now that the box is holdable.** Restores
the single door in the other direction, and was tempting for exactly that
reason. Rejected in rule 4.

**Letting the assignee edit the box on the four non-LOI types**, since they are
the person reading it. Rejected in rule 5 — reading the brief is not the same
standing as being the second person verifying a fact, and an assignee who can
rewrite their own instructions is not accepting a brief.

**Letting the box be edited on a closed task**, matching the message rule.
Rejected in rule 6.

## Consequences

ADR-0008 is amended rather than superseded. Rules 1, 3, 5, 6, 7, 8 and 10 stand
untouched, and rule 2's *mechanism* survives entirely — this ADR widens who it
applies to and replaces the reason. A record whose core survives intact is worse
replaced than amended.

**All five box-carrying types now open with an empty conversation.** Today four
of them open with the requester's note as message one. The empty state built for
ADR-0008 rule 1 becomes the normal case rather than the LOI's oddity.

**The LOI box keeps its fixed-width font and the four new ones do not.** The
exception documented in `apps/web/CLAUDE.md` holds and its reason is unchanged:
a term sheet is tabular matter whose columns only line up in a mono face, and a
Buddy Chat's concerns are prose.

**A field gets an inline editor for the first time.** The message editor built
for ADR-0009 is the model for the gesture and the menu, not for the behaviour
once open, and the two will need to stay recognisably siblings without being
merged into one component that has to know which it is.

**Anything that assumed the thread's first row is the originating note must be
checked on all five types, not just the LOI.** ADR-0008 flagged this for one
type; the surface area is now five. The unread calculation is already safe — the
originating field has never been a thread member on the wire — but the bot's
reply cards and anything that counts replies want re-reading.
