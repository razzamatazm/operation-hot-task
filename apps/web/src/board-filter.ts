/* Which tasks the Tasks board shows (#334).

   The board has one setting that narrows it, `Show`: Everyone (the default) or
   Mine. It is a view preference like Grouped/Flat and combines with both, so it
   is applied once, to the list, before anything reads that list — the heading,
   its count, the court sections or the flat list, Done, the empty state and
   Collapse all all describe the same set because they are all handed the output
   of `visibleBoardTasks`. A later narrowing (a search, say) belongs in that same
   function for the same reason.

   Mine is a Party filter with one fixed exception. A task is on the Mine board
   when the viewer filed it or holds it (shared `isTaskParty`), or when it is
   unclaimed (shared `isUnclaimed`), whoever filed it. Unclaimed work is never
   filtered out, on either setting, so the pool stays in front of everybody.
   What that hides is Observer tasks — somebody else's work somebody else holds
   — and closed tasks the viewer was not a Party to, since a closed task is
   never unclaimed. A task shared with the viewer does not count: sharing only
   sends a DM and leaves no trace on the task.

   Both predicates are imported as values, which ties this module to
   `@loan-tasks/shared`'s compiled `dist` under node. That is the price of not
   restating either test here; the sim test's `pretest` guards freshness. */
import { isTaskParty, isUnclaimed } from "@loan-tasks/shared";
import type { LoanTask, UserIdentity } from "@loan-tasks/shared";

export type BoardShow = "everyone" | "mine";

export const BOARD_SHOW_KEY = "loan-tasks:show";

export const BOARD_SHOW_CHOICES: ReadonlyArray<{ value: BoardShow; label: string }> = [
  { value: "everyone", label: "Everyone" },
  { value: "mine", label: "Mine" }
];

/* The stored choice. Only the exact value Mine was written as turns it on;
   nothing stored, storage that refuses, or anything unrecognised is Everyone. */
export const parseBoardShow = (stored: string | null | undefined): BoardShow =>
  stored === "mine" ? "mine" : "everyone";

export const isOnMineBoard = (
  task: Pick<LoanTask, "createdBy" | "assignee" | "status">,
  viewer: Pick<UserIdentity, "id">
): boolean => isTaskParty(task, viewer) || isUnclaimed(task);

/* The list the board renders. Everyone hands back the input untouched, same
   reference, so a memo downstream does not see a change that is not one. Mine
   keeps the input's order: sorting is the caller's, and it has already run. */
export const visibleBoardTasks = <T extends Pick<LoanTask, "createdBy" | "assignee" | "status">>(
  tasks: T[],
  { show, viewer }: { show: BoardShow; viewer: Pick<UserIdentity, "id"> }
): T[] => (show === "mine" ? tasks.filter((t) => isOnMineBoard(t, viewer)) : tasks);
