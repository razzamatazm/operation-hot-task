# 0011. Saved for Later is private server state, and never a task

Status: Accepted, partly built. Settled while triaging #337. Built so far
(#343): saving a new task for later, the server store and its owner-only
routes, and the Grouped view section. (#344): reopening one, saving it again
onto the same record, and creating it, which removes it. (#347): removal with
the owner. (#345): deleting one from the board, after a confirmation, with no
undo. (#346): the same section as the one group Flat view shows. Not yet built:
the Cancel prompt.

## Context

People start a new task, get pulled onto something else, and want to come back
to it. The form already has an autosave (#284, #285): one unfinished form per
person, kept in that browser for seven days, restored the next time New Task is
opened. That covers an accident. It does not cover putting more than one thing
aside on purpose, seeing what you put aside, or coming back on another device.
Some Teams setups block browser storage entirely, and Teams desktop and mobile
do not share it.

Until now the server has held nothing private to one person. Everything it
stores as a task is seen by everyone: the board, the channel, reminders, pool
nags, activity-feed signals, loan rename and merge, and admin metrics all read
every stored task.

## Decision

**A Saved for Later task is kept on the server, belongs to exactly one person,
and is not a task until it is created.**

**1. It lives on the server, not in the browser.** So it follows its owner to
any device, and survives a Teams client that blocks storage.

**2. It is strictly private.** Nobody but its owner sees it, admins included.
It sends no notification, posts nothing to the channel, raises no signal, earns
no points, and appears in no count or metric. Nothing hints to anyone else that
one exists on a loan. The glossary's "admin sees every task" does not reach it,
because it is not a task.

**3. It is kept apart from tasks, not flagged among them.** Every existing
reader of tasks reads every stored task. Storing these as tasks with a "not
filed" marker would make each of those readers responsible for skipping them,
and the first one that forgets leaks a private record or notifies about work
nobody filed. Kept apart, a new reader of tasks cannot reach them by accident.

**4. Creating it ends it.** Pressing Create Task files a normal task through the
normal path, with its normal notifications, and the Saved for Later task is
gone. The loan is resolved at that moment, as the autosave does, so a rename or
merge that happened while it sat there is handled like any new task.

**5. The autosave stays, as a separate thing.** The autosave is the accidental
safety net; Saved for Later is deliberate. Pressing Save for later clears the
autosave, since nothing is at risk. Typing into a reopened Saved for Later task
lands back on that same record, so there is never a second copy.

**6. It goes when its owner goes.** Removing a person from the app removes their
Saved for Later tasks.

## Considered and rejected

**Keeping it in the browser, as a multi-slot autosave.** Much smaller, with no
new private server data. Rejected: it cannot follow someone from desktop to
phone, it disappears where Teams blocks storage, and it adds little the autosave
does not already do.

**Replacing the autosave with Saved for Later.** One mechanism instead of two.
Rejected: someone pulled away without pressing a button would lose their
typing.

**Turning every abandoned form into a Saved for Later task automatically.**
Rejected: the section would fill with every half-opened form.

**Letting admins see them**, in keeping with back-end access seeing every task.
Rejected in rule 2. It is someone's scratch work, not work anyone has asked for.

## Consequences

**The server holds per-person private data for the first time.** Any future
feature that exports, backs up, or reports on stored data has to decide what it
does with these, rather than inheriting "everything is visible."

**The board gains a section that is not a court.** Saved for Later sits after
Needs you in Grouped view, and appears as the one group Flat view shows. The
search and "mine" filters (#333, #334) have to account for it, whichever ships
second.
