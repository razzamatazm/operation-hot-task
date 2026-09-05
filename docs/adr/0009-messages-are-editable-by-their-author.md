# 0009. A message is editable by the person who wrote it

Status: Accepted, not yet implemented. Amends
[ADR-0008](0008-loi-terms-are-a-field-not-a-message.md) rule 5.

## Context

[ADR-0008](0008-loi-terms-are-a-field-not-a-message.md) made a task's *facts*
correctable — terms, folder name, link, points, dates — and drew the line at the
conversation: "Messages themselves stay immutable. Editing your own message,
with an edited marker, is a coherent thing to want and is deliberately left as
separate future work." It was right to defer. The pressing case was an LOI's
terms being wrong, and rule 1 solved that by taking terms out of the thread
entirely, so a transposed rate is now fixed in a field without anybody touching
what was said.

What is left is the ordinary case: somebody typed a message and got it wrong.
Every app these people use all day lets them fix it, and the absence here reads
as a missing feature rather than as a principle. It is real and it is no longer
urgent, which is exactly the kind of thing that gets decided on its own terms
instead of inherited by proximity.

The question this ADR answers is narrower than it looks. It is not "should the
record be mutable". The record of what happened to a task is its history, which
is append-only and untouched by anything below. It is "does a person own the
sentence they typed", and the answer is yes.

## Decision

**A message belongs to the person who wrote it. They may correct it or withdraw
it, at any time, and the thread says so plainly. Nobody else may touch it, and
neither act is news.**

**1. The author, and only the author.**

Not the other party, not an observer, not an admin — consistent with
[ADR-0003](0003-creator-is-never-assignee.md), where back-end access confers
nothing over other people's work. This is narrower than ADR-0008's field rules,
which admit both parties to a task's facts. The reason is the distinction the
whole ADR turns on: a fact is a thing about the loan that either party can see
is wrong, and a message is a thing one person said.

**2. Indefinitely, until the task is archived.**

No time window. A window buys protection against somebody quietly rewriting old
history, which the edited marker and the history row already cover, and it costs
a rule that refuses a typo fix at minute sixteen. People route around such a
rule by posting a correction reply, which is what they do today.

The gate is archival, not completion. **The conversation deliberately stays open
on a completed task** — a note can be posted to one — and archived tasks refuse
notes. Editing follows the conversation it lives in rather than the task's
fields, which freeze at completion per ADR-0008 rule 6. Letting somebody post a
brand new message to a completed task while refusing them a typo fix in it is
not a defensible pair of rules.

**3. An edited message says `(edited)`, and nothing more.**

No edit timestamp, no previous version in the thread. The thread's job is the
conversation as it now stands. A second time next to the message's own invites
"so which one is this", and an expandable previous version is the affordance
that makes people hesitate before fixing a typo — the opposite of the point.

Whoever genuinely needs to know what changed reads the task's history, which is
where this app already keeps that kind of question.

**4. Deletion is in, and leaves a marked gap.**

ADR-0008 and the originating issue both parked deletion as a separate question.
It is answered here, deliberately, because the alternative is an edit box that
can be emptied — deletion by the back door, shipped without the decision being
made.

A deleted message leaves a muted **`Message deleted`** row, keeping the author's
name and its place in the thread. The name is what makes the gap legible: you
can see who withdrew something and roughly when, which is the reason to leave a
tombstone rather than vanish the row. A tombstone **counts as a message** — it
occupies a row, so the reply count includes it and a thread holding only a
tombstone does not claim to be empty.

**No undo.** An undelete makes the tombstone a maybe, and people treat a maybe
differently. Somebody who deleted by mistake retypes it. The original text
survives in the history row for the rare case that matters — recoverable, but
not by the author and not from the app. #289 declined to build a screen over
the history log, so reading that row back is a technical act performed by
someone with API access, not something the person who deleted the message can
do for themselves. Retyping it is the route for everybody else, which is what
this rule already asks of them.

**An edit may not empty a message.** Deletion has its own action; an edit still
has to say something.

**5. A workflow-move message is a message, but its prefix is not.**

When a checker sends work back or flags fixes, the reason they type is filed
into the thread as a message authored by them, under a prefix naming the exit
that wrote it. That prefix is part of the stored text today.

The author may edit and delete these like any other message, **and the prefix
survives both.** They edit their finding; `Needs fixes:` stays put. A deleted one
reads `Needs fixes: message deleted`.

The author owns the words. The app owns the label saying why the row exists, and
that label is the only thing marking the message as the reason a task changed
hands. Erasing it is a different act from fixing a typo and nobody wants it on
purpose. Protecting it against the edit but not the delete would leave the same
hole behind a different door.

**6. Neither act is news.**

- **Nothing is notified.** No DM, no activity-feed ping, nothing to the channel.
- **An edit does not re-raise the message as unread.** The message keeps its
  original post time, which is what the unread calculation compares. The person
  who most needs the correction is usually the one who has not read the message
  yet, and they will see the corrected version when they do. Where an edit
  genuinely changes the meaning for somebody who already read it, the reply box
  is the honest route.
- **Deleting the only unread message clears the dot.** A deleted message is not
  something to read, and sending somebody to a task to find `Message deleted`
  spends their attention on nothing.
- **Teams cards redraw quietly.** A delivered card quotes the last few messages,
  so a card sitting in somebody's chat would otherwise be the one surface still
  showing the typo after it was fixed. It refreshes in place, with no new nudge,
  through the same mechanism a checklist write already uses.
- **The task's `updatedAt` does not move.** This is a carve-out: every other
  write in the app stamps it. The done list and the archive sort by it, so a
  typo fixed on a task finished three weeks ago would otherwise jump above work
  genuinely finished yesterday. A correction is not activity — the same sentence
  that governs the unread rule.

**7. Every edit and every delete is in the task's history, with both values.**

Matching ADR-0008 rule 9's treatment of field edits, and for the same reason:
the append-only history is where "what did this used to say" is answered, which
is what allows rules 3 and 4 to keep the thread clean.

History is readable by any authenticated user, wider than the two parties who
can see the thread. Accepted knowingly: an edit to an LOI's terms already lands
there under the same visibility, and a message is not more private than the
terms. The alternative — a row saying something changed and refusing to say
what — is worse than not logging it.

Noted honestly: **no screen in the app shows a task's history.** The web app
reads a couple of specific rows out of it for the hamburger's timestamps and
nothing else. This ADR therefore writes durable rows that nobody can read
without calling the API by hand. That is a gap in the history surface, not a
reason to log less.

**And it stays a gap, deliberately.** This was raised as its own future work,
grilled in #289, and declined: the history log is a durable record rather than
a product surface, and reading one back is an occasional technical act. See
[.out-of-scope/task-history-screen.md](../../.out-of-scope/task-history-screen.md).
Rules 3 and 4 are unaffected — they lean on the row existing, which it does.
What they may not do is promise a person they can go and look at it.

**8. In the web app only.**

The Teams DM card has a reply box, so messages are posted from Teams already,
but the card renders the thread as a block of text with no per-message controls.
Adding them there is a real chunk of work and a cramped place for a dozen tiny
menus. A card is a nudge to go and look at the task, and going to look at the
task is what fixing a typo requires. Revisit if people actually hit it.

**9. The control lives on the message.**

A small menu on the author's own messages — hover on desktop, tap-and-hold on
touch — offering `Edit` and `Delete`. Editing turns the message into a box in
place, with save and cancel.

This is a deliberate exception to ADR-0008 rule 4's "one door", which put every
task edit in the hamburger. It has to be: the hamburger belongs to the task and
has no way to know which of a dozen messages is meant. The object being edited
is the message, so the control belongs to the message.

## Considered and rejected

**A time window.** See rule 2.

**Showing the previous wording in the thread**, behind an expander on the
`(edited)` marker. The most honest option and the most work, and the one that
makes people hesitate to fix a typo. History carries it instead.

**An anonymous tombstone.** Rejected with rule 4: a conversation with anonymous
holes in it is less readable than one with attributed gaps.

**Emptying a message as the delete.** Rejected — it ships deletion without
deciding it.

**Protecting workflow-move messages from editing altogether.** The typo case is
identical to any other message's, and the alternative asks a person why the
sentence they just typed is the one sentence in the thread they cannot fix. The
record of *why the task moved* is in history, not in the thread. Rule 5 protects
the part that is actually load-bearing.

**Letting an edit re-raise unread.** Cheap to build — bump the message's time and
the existing comparison does the rest — and wrong: it makes a one-character fix
indistinguishable from a new message, with no way to opt out.

**Per-message controls on the Teams card.** See rule 8.

## Consequences

ADR-0008 is amended, not superseded: rule 5's immutability clause is the only
sentence overturned, and it named this as future work while writing it.

The glossary's **Amend** entry states that posted messages are never amendable.
It is rewritten, alongside vocabulary for the edited marker and the tombstone.

A message needs a **stable handle**. Today one is identified only by its author
and the moment it landed, which is also the value the unread comparison reads —
and rule 6 keeps that value fixed across an edit, so it cannot double as a
version marker. Anything that addresses a single message needs an identifier
that is not its timestamp.

The **reply count** and the **empty-conversation state** now count tombstones,
per rule 4. The **unread calculation** gains its first reason to care about a
message's contents rather than only its author and time, per rule 6.
