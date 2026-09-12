/* Which tasks the Tasks board shows (#334).

   The board narrows two ways, Everyone or Mine, and since #390 they are two
   tabs, All Tasks and My Tasks, rather than a menu setting. The choice is still
   a view preference like Grouped/Flat and combines with both, so it is applied
   once, to the list, before anything reads that list — the tab's count, the
   court sections or the flat list, Done, the empty state and Collapse all all
   describe the same set because they are all handed the output of
   `visibleBoardTasks`. A later narrowing (a search, say) belongs in that same
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
import { CLOSED_STATUSES, isTaskParty, isUnclaimed } from "@loan-tasks/shared";
import type { LoanTask, UserIdentity } from "@loan-tasks/shared";

export type BoardShow = "everyone" | "mine";

export const BOARD_SHOW_KEY = "loan-tasks:show";

/* The stored choice. Only the exact value Mine was written as turns it on;
   nothing stored, storage that refuses, or anything unrecognised is Everyone. */
export const parseBoardShow = (stored: string | null | undefined): BoardShow =>
  stored === "mine" ? "mine" : "everyone";

/* The board's three tabs (#390): All Tasks, My Tasks, Task Drafts.

   All Tasks is the board under Everyone and My Tasks the board under Mine, so
   the stored Show value is the stored half of the tab. It keeps its key and its
   values, which is what opens someone who had Mine on before the tabs existed
   straight onto My Tasks. Task Drafts has no stored half: a draft is not a task
   (ADR-0011), and a reload opens on whichever of the other two was last open. */
export type BoardTab = "all" | "mine" | "drafts";

export const tabForShow = (show: BoardShow): "all" | "mine" => (show === "mine" ? "mine" : "all");

export const showForTab = (tab: BoardTab): BoardShow | null =>
  tab === "all" ? "everyone" : tab === "mine" ? "mine" : null;

/* The tab a link to a task opens. A link is a request to see the task, so it
   opens a task tab, starting `from` the tab the board is on: the open tab, or,
   mid-search, the tab clearing the search would return to, so the two ways out
   of a search land in the same place. Task Drafts is not a task tab, so from
   there it starts on the stored one. My Tasks stays open only when the task is
   on it. One My Tasks hides (an Observer task, which a Share DM is the usual way
   to) would open a card that is not on the board and scroll to nothing, so the
   link opens All Tasks instead, stored the way a press on that tab is. */
export const tabForLink = ({
  from,
  show,
  onMineBoard
}: {
  from: BoardTab;
  show: BoardShow;
  onMineBoard: boolean;
}): "all" | "mine" => {
  const start = from === "drafts" ? tabForShow(show) : from;
  return start === "mine" && onMineBoard ? "mine" : "all";
};

export const isOnMineBoard = (
  task: Pick<LoanTask, "createdBy" | "assignee" | "status">,
  viewer: Pick<UserIdentity, "id">
): boolean => isTaskParty(task, viewer) || isUnclaimed(task);

/* History (#391): how far back finished tasks go on the board. A view
   preference like Show, per browser, and everyone's; it replaced a fixed
   fourteen-day window and the admin-only All Tasks tab that was the one way
   past it. The longest day choice stays well inside what the server keeps: it
   archives a closed task after fourteen days and purges an archived one after
   its retention period (ninety by default), so `All` means every closed task
   this client holds, not every one ever filed. */
export type BoardHistory = 7 | 14 | 30 | "all";

export const BOARD_HISTORY_KEY = "loan-tasks:history";

export const BOARD_HISTORY_DEFAULT: BoardHistory = 14;

export const BOARD_HISTORY_CHOICES: ReadonlyArray<{ value: BoardHistory; label: string }> = [
  { value: 7, label: "7 days" },
  { value: 14, label: "14 days" },
  { value: 30, label: "30 days" },
  { value: "all", label: "All" }
];

/* The stored choice, written as `String(value)`. Only an exact match reads
   back; nothing stored, storage that refuses, or anything else is the default. */
export const parseBoardHistory = (stored: string | null | undefined): BoardHistory =>
  BOARD_HISTORY_CHOICES.find((c) => String(c.value) === stored)?.value ?? BOARD_HISTORY_DEFAULT;

const DAY_MS = 24 * 60 * 60 * 1000;

type HistoryFields = Pick<LoanTask, "status" | "completedAt" | "cancelledAt" | "archivedAt" | "updatedAt">;

/* Open and in-flight work is always within, however old. A closed task is
   within while its close stamp is no older than the window: the completion
   stamp first, so archiving a finished task does not restart its clock. */
export const isWithinHistory = (task: HistoryFields, history: BoardHistory, now: number): boolean => {
  if (history === "all" || !CLOSED_STATUSES.includes(task.status)) return true;
  const stamp = task.completedAt ?? task.cancelledAt ?? task.archivedAt ?? task.updatedAt;
  return new Date(stamp).getTime() >= now - history * DAY_MS;
};

/* The list the board renders. Hand it the whole sorted list: the History cutoff
   is applied here, so the search can see past it. Nothing cut and Everyone
   hands back the input untouched, same reference, so a memo downstream does not
   see a change that is not one. Every narrowing keeps the input's order: sorting
   is the caller's, and it has already run.

   A picked loan (#333) is the search, and it narrows All Tasks alone (#390): on
   Everyone it wins over History rather than combining with it, and Mine ignores
   it. The search answers "where are we on this file", and the ticket's answer is
   every task on the loan the board holds, whoever's court it is in, whether or
   not it is closed and however long ago it closed. Mine would cut that to the
   viewer's own slice of the file, which is the one thing the search promises not
   to do, so the search is never applied to it: My Tasks stays the Mine board
   while a search is on. Neither setting is changed by it.

   `keep` names tasks that stay on the board past the History window: a deep
   link to an old closed task puts it there for the session without moving the
   stored setting. It bypasses History only; Mine still applies, and the link
   opens All Tasks when My Tasks would hide the task (`tabForLink`). */
export const visibleBoardTasks = <T extends Pick<LoanTask, "id" | "createdBy" | "assignee" | "loanId"> & HistoryFields>(
  tasks: T[],
  {
    show,
    viewer,
    loanId,
    history,
    now,
    keep
  }: {
    show: BoardShow;
    viewer: Pick<UserIdentity, "id">;
    loanId?: string | null;
    history: BoardHistory;
    now: number;
    keep?: ReadonlySet<string>;
  }
): T[] => {
  if (loanId && show === "everyone") return tasks.filter((t) => t.loanId === loanId);
  const windowed = tasks.filter((t) => isWithinHistory(t, history, now) || (keep?.has(t.id) ?? false));
  const cut = windowed.length === tasks.length ? tasks : windowed;
  return show === "mine" ? cut.filter((t) => isOnMineBoard(t, viewer)) : cut;
};

/* What sits under the Tasks board's tab row (#363, #390). The tabs are All
   Tasks, My Tasks and Task Drafts, and the header draws all three whatever else
   is true, so nothing here can take a tab away.

   The search narrows All Tasks and nothing else, and a draft is not a task
   (ADR-0011), so on Task Drafts nothing is asked. An empty search is said on All
   Tasks, an empty Mine on My Tasks. An empty All Tasks with no search is still
   the task list, which carries its own `No tasks yet.` */
export type BoardBody = "drafts" | "search-empty" | "mine-empty" | "tasks";

export const boardBody = ({
  tab,
  searching,
  shownCount
}: {
  tab: BoardTab;
  searching: boolean;
  shownCount: number;
}): BoardBody => {
  if (tab === "drafts") return "drafts";
  if (shownCount > 0) return "tasks";
  if (tab === "mine") return "mine-empty";
  return searching ? "search-empty" : "tasks";
};
