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
  for (const event of [...history].sort((a, b) => epoch(a) - epoch(b))) {
    if (ASSIGNEE_TAKEN.has(event.action)) takenAt = event.at;
    else if (ASSIGNEE_CLEARED.has(event.action)) takenAt = undefined;
  }
  return takenAt;
};
