# 0011. Saved for Later is private server state, and never a task

Status: Accepted, and built. Settled while triaging #337. (#343): saving a new
task for later, the server store and its owner-only routes, and the Grouped
view section. (#344): reopening one, saving it again onto the same record, and
creating it, which removes it. (#347): removal with the owner. (#345): deleting
one from the board, after a confirmation, with no undo. (#346): the same section
as the one group Flat view shows. (#348): Cancel offering Save for later, and
typing on a reopened one kept on that record rather than in the autosave.
(#363): moved off the task list onto their own Task Drafts tab, which replaced
the section in both views. Amended by #371: the new task form's autosave moved
onto the server beside them, under the same rules, and is listed on that tab
(rule 5). Amended by #388: Discard on a reopened one, once a second question is
answered Delete, deletes the record rather than clearing only its unsaved
typing, so there is no longer a way back to its last save.

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

**5. The autosave stays, as a separate thing, and since #371 it is server state
too.** The autosave is the accidental safety net; Saved for Later is deliberate.
So there is one autosave per person, the new task form they last typed into and
did not finish, written as they type and gone seven days after its last write,
where Saved for Later tasks are many and never expire.

It is kept on the server under its owner, beside their Saved for Later tasks,
so it follows them to any device like one. Rules 2 and 6 apply to it exactly:
nobody else can read or clear it, admins included, nothing notifies, posts,
counts or scores anything about it, and it goes when its owner goes. It is
listed on the Task Drafts tab as `Autosaved N ago`, so it can be found from the
board as well as by opening New Task, and tapping it opens New Task on it.

Pressing Save for later turns the autosave into a Saved for Later task and
clears it in the same write, so the same form never shows twice. Typing into a
reopened Saved for Later task lands back on that same record and never in the
autosave, so there is never a second copy either way.

The browser keeps a copy only of typing the server did not take. A write that
reaches the server removes it; one that fails writes it; the next New Task opens
on whichever copy was written last. So a server that cannot be reached behaves
the way the form always did, loses nothing, and says nothing on every keystroke.
That copy is a fallback, not a second autosave: it exists only while the server
is behind.

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

**Keeping the autosave in the browser and listing it on the tab as `Autosaved on
this device`** (#371's first default). Rejected by the maintainer: a row that
exists on one device and not another is a row people cannot rely on, and it has
every weakness this decision gave for Saved for Later tasks — no following a
person from desktop to phone, and nothing at all where Teams blocks storage.

**Moving the autosave to the server with no browser copy at all.** Rejected: a
server that could not be reached while someone typed would lose that typing, and
not losing typing is the whole of what the autosave is for.

## Consequences

**The server holds per-person private data for the first time.** Any future
feature that exports, backs up, or reports on stored data has to decide what it
does with these, rather than inheriting "everything is visible." The autosave
(#371) is in the same file and needs the same decision. It is also written far
more often than a Saved for Later task: every pause in typing on a new task form
is a request and a rewrite of that file.

**The board gains a tab that is not a list of tasks.** Saved for Later tasks
are shown on the board's **Task Drafts** tab, beside Tasks (#363), and never in
the task list. They first shipped as a section inside the list, after Needs you
in Grouped view and as the one group in Flat view (#343, #346). That put them in
a different place per view, mixed them in with live tasks, and left the search
and Mine filters (#333, #334) to decide what to do with them: a search showed a
draft for another loan, and an empty Mine hid them. On their own tab neither
filter reaches them. "Task Draft" is the name on screen only; the domain term is
unchanged.
