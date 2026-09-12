/* Which tasks the Tasks board shows (#334).

   The board has one setting that narrows it, `Show`: Everyone (the default) or
   Mine. It is a view preference like Grouped/Flat and combines with both, so it
   is applied once, to the list, before anything reads that list — the heading,
   its count, the court sections or the flat list, Done, the empty state and
   Collapse all all describe the same set because they are all handed the output
   of `visibleBoardTasks`. A later narrowing (a search, say) belongs in that same
   function for the same reason, and the loan search (#333) is there.

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
   keeps the input's order: sorting is the caller's, and it has already run.

   A picked loan (#333) is the search, and it wins over Show rather than
   combining with it. The search answers "where are we on this file", and the
   ticket's answer is every task on the loan the board holds, whoever's court it
   is in and whether or not it is closed. Mine would cut that to the viewer's
   own slice of the file, which is the one thing the search promises not to do.
   Show is not changed by it: clear the search and Mine is still on. */
export const visibleBoardTasks = <T extends Pick<LoanTask, "createdBy" | "assignee" | "status" | "loanId">>(
  tasks: T[],
  { show, viewer, loanId }: { show: BoardShow; viewer: Pick<UserIdentity, "id">; loanId?: string | null }
): T[] => {
  if (loanId) return tasks.filter((t) => t.loanId === loanId);
  return show === "mine" ? tasks.filter((t) => isOnMineBoard(t, viewer)) : tasks;
};

/* What sits under the Tasks board's tab row (#363). The tabs are Tasks and Task
   Drafts, and the header draws both whatever else is true, so nothing here can
   take a tab away.

   The search and Mine narrow the task list and nothing else: a draft is not a
   task (ADR-0011), so on the Task Drafts tab neither is asked. On the Tasks tab
   an empty search is said before an empty Mine, because the search wins over
   Mine in `visibleBoardTasks` too. An empty board with nothing narrowing it is
   still the task list, which carries its own `No tasks yet.` */
export type BoardBody = "drafts" | "search-empty" | "mine-empty" | "tasks";

export const boardBody = ({
  tab,
  searching,
  mine,
  shownCount
}: {
  tab: "tasks" | "drafts";
  searching: boolean;
  mine: boolean;
  shownCount: number;
}): BoardBody => {
  if (tab === "drafts") return "drafts";
  if (shownCount > 0) return "tasks";
  if (searching) return "search-empty";
  return mine ? "mine-empty" : "tasks";
};
