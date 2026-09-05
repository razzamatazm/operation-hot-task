import type { TaskHistoryEvent } from "./types.js";

/* When a task's current assignee took it on, read out of the task's
   history rather than off a stored field (#166).

   ADR-0005 rejected persisting a claim timestamp on `LoanTask`, and named this
   issue while doing it: every door an assignee arrives through already writes a
   history row, and a reference detail behind a hamburger menu can afford to
   read it from there.

   Two history actions put an assignee on a task, and two take one off:

   | door                                   | action           |
   |----------------------------------------|------------------|
   | claim, incl. self-claim                | `TASK_CLAIMED`   |
   | handoff, reassign, born assigned       | `TASK_ASSIGNED`  |
   | sent back to the pool, returned        | `TASK_UNCLAIMED` |
   | released in place for any fraud checker| `TASK_RELEASED`  |

   `TASK_RELEASED` matters as much as `TASK_UNCLAIMED` here: it clears the
   assignee while leaving the status alone, so a scan that only watched for
   unclaims would keep quoting someone who has already stepped off.

   These are bare strings on the server (`makeHistory`), and `action` is typed as
   a plain `string`, so this is a string match by necessity. Note that
   `TASK_CLAIMED` and `TASK_UNCLAIMED` also appear as `NotificationEvent.type`
   values — a different union that happens to share spellings. */
const ASSIGNEE_TAKEN = new Set(["TASK_CLAIMED", "TASK_ASSIGNED"]);
const ASSIGNEE_CLEARED = new Set(["TASK_UNCLAIMED", "TASK_RELEASED"]);

const epoch = (event: Pick<TaskHistoryEvent, "at">): number => new Date(event.at).getTime();

/* Every rule in this file is about chronology, and none of them trusts the
   order the events arrive in. The server's history endpoint does return them
   ascending by `at`, but these are pure functions over a list, so they
   establish the order themselves — and on a copy, because a caller's array is
   not theirs to reorder. */
const inTimeOrder = <T extends Pick<TaskHistoryEvent, "at">>(history: readonly T[]): T[] =>
  [...history].sort((a, b) => epoch(a) - epoch(b));

/* The instant the current assignee took the task, or `undefined` when the task
   has nobody on it — or when history is empty, truncated, or predates the row.

   A single forward pass over the events in time order, rather than "the last
   claim after the last unclaim": a take sets the answer, a clear wipes it, and
   the last word wins. A task claimed, released, and claimed again by someone
   else therefore reports the second claim, not the first — quoting the first
   would credit the current assignee with a previous person's shift.

   The events are sorted here rather than trusted in the order they arrive. The
   server's history endpoint does return them ascending by `at`, but this is a
   pure function over a list and the rule it encodes is about chronology, so it
   establishes the chronology itself.

   Says nothing about *who* the assignee is — the caller has that from
   `task.assignee` and should not render this at all when there is no assignee.
   History alone can't be the authority on that: retention could have dropped
   the clearing event. */
export const currentAssigneeSince = (history: readonly Pick<TaskHistoryEvent, "action" | "at">[]): string | undefined => {
  let takenAt: string | undefined;
  for (const event of inTimeOrder(history)) {
    if (ASSIGNEE_TAKEN.has(event.action)) takenAt = event.at;
    else if (ASSIGNEE_CLEARED.has(event.action)) takenAt = undefined;
  }
  return takenAt;
};

/* The two closing doors get their own history actions rather than riding the
   generic `TASK_STATUS_CHANGED` row (#239, ADR-0007 rule 6).

   The actor was always on the row — `by` is on every history event — but
   finding *the closure* among a task's rows meant matching the free-text
   `detail` string ("CLAIMED -> COMPLETED"), and ADR-0002 is explicit that the
   detail string is nobody's parser. `action` is a plain `string` by design, so
   naming these two costs nothing and makes the closure findable.

   Deliberately not a status name. These say what happened to the task, in the
   tense the rest of the actions use, and a status name would invite the reader
   to expect a row for every status. */
export const TASK_COMPLETED_ACTION = "TASK_COMPLETED";
export const TASK_ARCHIVED_ACTION = "TASK_ARCHIVED";

/* The row a message correction writes (#287, ADR-0009 rule 7), carrying the
   author's words on both sides of the change.

   Named here rather than left a bare string beside `REVIEW_NOTE_ADDED` because
   this is the row rules 3 and 4 lean on: the thread deliberately shows no
   previous version and no edit time, which is only defensible while history
   reliably carries them. A constant is what lets the test that guards that
   promise, and the delete row that joins it in #288, name the same thing the
   writer does. */
export const REVIEW_NOTE_EDITED_ACTION = "REVIEW_NOTE_EDITED";

/* Which statuses get a named closure row, in one place, so the writer and the
   readers below cannot come to disagree about it. `undefined` means "this
   arrival is an ordinary status change" — the caller supplies its own action.

   `CANCELLED` is deliberately not here. A cancellation is the creator calling
   the request off, not a closure anybody signed off on, and nothing asks who
   did it. */
export const closureActionFor = (status: string): string | undefined => {
  if (status === "COMPLETED") return TASK_COMPLETED_ACTION;
  if (status === "ARCHIVED") return TASK_ARCHIVED_ACTION;
  return undefined;
};

/* The generic row every unnamed move writes. On a closed task the only such
   move is the reopen, which is why it reads as one below. */
const REOPEN_ACTION = "TASK_STATUS_CHANGED";

type ActorEvent = Pick<TaskHistoryEvent, "action" | "at" | "by">;

/* The actor on the closure the task is standing in NOW, or `undefined`.

   A single forward pass in time order, same shape as `currentAssigneeSince`
   above and for the same reason: closure is not final, so a row sets the
   answer and a reopen wipes it, and the last word wins. A task completed by
   one person, reopened and completed again by another therefore reports the
   second — quoting the first would credit the current closure to somebody who
   had nothing to do with it.

   The wipe is any plain status change after the closure, which on a closed
   task is a reopen and nothing else: the only other move out of `COMPLETED` is
   the archive, and that writes its own named row. It matters on the restore
   path, where a reopened task is sent straight back to `ARCHIVED` without
   passing through a fresh completion — the old completer is then a stale
   answer, and a blank is the better one. */
const closerFor = (history: readonly ActorEvent[], action: string): ActorEvent["by"] | undefined => {
  let by: ActorEvent["by"] | undefined;
  for (const event of inTimeOrder(history)) {
    if (event.action === action) by = event.by;
    else if (event.action === REOPEN_ACTION) by = undefined;
  }
  return by;
};

/* Who completed the task, and who archived it — or `undefined` for either.

   `undefined` is the answer for every task whose closure predates this row,
   and it is the honest one: those closures were written as bare status
   changes, and the actor is not recoverable from them. Reading the assignee
   instead would be right on most of them and confidently wrong on exactly the
   ones anybody asks about. Callers render nothing rather than a guess. */
export const completedBy = (history: readonly ActorEvent[]): ActorEvent["by"] | undefined =>
  closerFor(history, TASK_COMPLETED_ACTION);

export const archivedBy = (history: readonly ActorEvent[]): ActorEvent["by"] | undefined =>
  closerFor(history, TASK_ARCHIVED_ACTION);
