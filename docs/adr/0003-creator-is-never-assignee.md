# 0003. A task's creator is never its assignee

Status: Accepted. Supersedes the self-handoff rule in
[ADR-0002](0002-task-handoff.md).

## Context

A task is a request for someone *else* to do something — you don't file a Buddy
Chat to have a chat with yourself, and the whole point of a Fraud Check is that
a second person looks at the file. That was never written down as a rule, so the
code drifted into contradicting it from both sides.

`canClaimTask` never looked at `createdBy`: the API happily let a creator claim
their own task, and `scripts/smoke-test.mjs` asserted it. The only thing
stopping it was one `!isCreator` clause in the web row (`apps/web/src/App.tsx`),
which the handoff paths routed straight around — ADR-0002 deliberately allowed
self-handoff ("it is just a claim"), kept the creator in the handoff picker, and
left `assigneeUserId` at creation unguarded against pointing at yourself.

The same confusion ran through the ADMIN role. Admin wasn't a set of extra
system powers; it was a second identity. `checklist.ts` counted an admin as
*both* the checker seat and the requester seat on any Fraud Check, which is how
an admin working as the checker got two identical `+ note` buttons on every
outstanding item and could write a note in the requester's name.

## Decision

**`createdBy.id !== assignee.id` is an invariant of a task, checked at every
door.** There are four ways a person becomes assignee — claiming, handoff,
self-handoff, and `assigneeUserId` at creation — and the creator is refused at
all four. It is a property of the task, not of the actor, so a *third party*
handing a task back to its creator is refused too. It holds for every task type,
including OOO: the creator is the person going out, the assignee is the person
covering, and you cannot cover for yourself.

**A role gates entry to a seat; it is not a seat.** `FILE_CHECKER` is what lets
you *become* a Fraud Check's checker, and holding it remains a live requirement
— only a file checker can check a file, though anybody can create a file to be
checked. Losing the role mid-flight therefore auto-releases the checker's live
Fraud Checks back to the pool (unassign in place, any checker can pick them up),
as does deactivating the user. Demotion warns the admin about the tasks it is
about to release.

**ADMIN grants back-end access only.** User CRUD, roles, notification-channel
config, `GET /api/status`, Metrics, and the cross-user `All Tasks` view stay —
seeing everything is part of running the system. Every override *over other
people's work* is removed: unclaim, cancel, complete, restore, merge-undo,
NEEDS_REVIEW moves, acting as the fraud checker, submitting items in the
requester's stead, releasing another's fraud task, editing another's poop
points, adding notes anywhere, and holding either checklist seat. An admin is
not a second identity.

The scheduler's synthetic actor stops borrowing `ADMIN` (it wore it to
auto-complete OOO tasks on their return date) and becomes an explicit SYSTEM
actor, because "acts without a human" and "administers the system" were two
unrelated things sharing one role.

## Considered and rejected

**Making it a fraud-only rule** — separation of duties matters most where an
auditor would care, and a Buddy Chat you'd rather just do yourself has no
victim. Rejected: the friction is correct in every case. If you were going to do
it yourself, you wouldn't have filed a task, and recreating it under the right
person's name puts the request where it belongs.

**Keeping it a UI-only nudge**, hiding the affordance without blocking the API.
Rejected: that is exactly the state this replaces, and it left the server, the
bot, and the handoff paths all disagreeing with the row.

**An escape hatch for the sole checker on duty.** If the only available file
checker files a Fraud Check, nobody can work it, and there is no error message
that helps. Accepted as a cost rather than fixed: an escape hatch is
indistinguishable from letting one person file and check their own review. The
create form warns up front instead, so it fails at filing time with a redirect
rather than silently at claim time.

**Keeping one or two admin overrides as break-glass.** Rejected: the common case
(a task stuck with someone who's out) is already solved by handoff, which needs
no admin. A stray override would reintroduce the second-identity problem the
rest of this decision removes.

**Letting a demoted checker finish the exchange they started**, on the grounds
that a stranded task is worse than a lapsed role. Rejected: the role *is* the
check, so holding the seat without it is meaningless. Auto-release makes the
stranding impossible instead.

## Consequences

The claim / assign / handoff paths all route through one shared predicate rather
than repeating the rule, and the web pickers filter the creator out. ADR-0002's
"handing a task to yourself is allowed" no longer holds for the creator; it
still holds for anyone else, who may still take a task off its current assignee.

`smoke-test.mjs` asserted creator-self-claim in two places; the Loan Docs one
walked the entire merge chain with the creator as assignee, so it needs a second
user rather than an inverted assertion. 88 archived tasks in the store violate
the invariant — all smoke-test residue from before the test isolated its
`DATA_FILE`, none live — so the rule is enforced going forward with no migration.
