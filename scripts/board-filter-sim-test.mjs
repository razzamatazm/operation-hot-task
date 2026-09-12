#!/usr/bin/env node
/* Unit test for the Mine filter (apps/web/src/board-filter.ts, #334).

   The Tasks board can be narrowed to the viewer's own work. "Own" means Party
   and nothing else: the viewer filed the task or holds it right now. Unclaimed
   tasks are the exception that never gets filtered out, on either setting, so
   the pool stays in front of everybody. Closed tasks follow the Party half of
   the rule alone, since a closed task is never unclaimed.

   The module imports its two shared predicates as values, so this reads
   `@loan-tasks/shared`'s compiled `dist` — hence the freshness guard in
   `pretest:board-filter`. It runs under node's TS type stripping (node >= 24),
   the same arrangement as `expand-state.ts` and `court-latch.ts`.
   Run: `node --test scripts/board-filter-sim-test.mjs`. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  BOARD_HISTORY_CHOICES,
  boardBody,
  isOnMineBoard,
  isWithinHistory,
  parseBoardHistory,
  parseBoardShow,
  showForTab,
  tabForLink,
  tabForShow,
  visibleBoardTasks
} from "../apps/web/src/board-filter.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-12T12:00:00.000Z");
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();
/* Every task in the Mine and search fixtures below is open or was last updated
   two days before NOW, so History never has a say in those tests. */
const base = { history: 14, now: NOW };

const viewer = { id: "u-viewer", displayName: "Viewer" };
const other = { id: "u-other", displayName: "Other" };
const third = { id: "u-third", displayName: "Third" };

const task = (id, fields) => ({
  id,
  folderName: `Loan ${id}`,
  taskType: "LOAN_DOCS",
  dueAt: "2026-09-11T12:00:00.000Z",
  urgency: "GREEN",
  points: 0,
  notes: "",
  status: "OPEN",
  createdAt: "2026-09-10T12:00:00.000Z",
  updatedAt: "2026-09-10T12:00:00.000Z",
  createdBy: other,
  ...fields
});

/* ── The rule ───────────────────────────────────────────── */

test("a task the viewer filed is on the Mine board", () => {
  assert.equal(isOnMineBoard(task("filed", { createdBy: viewer, assignee: other, status: "CLAIMED" }), viewer), true);
});

test("a task the viewer holds is on the Mine board", () => {
  assert.equal(isOnMineBoard(task("held", { assignee: viewer, status: "CLAIMED" }), viewer), true);
});

test("an unclaimed task somebody else filed is on the Mine board", () => {
  assert.equal(isOnMineBoard(task("pool", {}), viewer), true, "the pool is never filtered out");
});

test("a released Fraud Check with no holder, filed by somebody else, is on the Mine board", () => {
  const released = task("released", { taskType: "FRAUD", status: "PENDING_APPROVAL" });
  assert.equal(isOnMineBoard(released, viewer), true, "unclaimed by the shared definition, whatever its status");
});

test("a task somebody else filed and a third person holds is not on the Mine board", () => {
  assert.equal(isOnMineBoard(task("observed", { assignee: third, status: "CLAIMED" }), viewer), false);
});

test("a closed task the viewer filed is on the Mine board", () => {
  assert.equal(isOnMineBoard(task("done-mine", { createdBy: viewer, assignee: other, status: "COMPLETED" }), viewer), true);
});

test("a closed task the viewer held is on the Mine board", () => {
  assert.equal(isOnMineBoard(task("archived-held", { assignee: viewer, status: "ARCHIVED" }), viewer), true);
});

test("a closed task the viewer was not a Party to is not on the Mine board", () => {
  assert.equal(isOnMineBoard(task("done-theirs", { assignee: third, status: "COMPLETED" }), viewer), false);
});

test("a task cancelled while still unclaimed is not on the Mine board for a non-Party", () => {
  const cancelled = task("cancelled-unclaimed", { status: "CANCELLED" });
  assert.equal(isOnMineBoard(cancelled, viewer), false, "a closed task is never unclaimed, so nothing keeps it");
});

/* ── The list the board renders ─────────────────────────── */

const board = [
  task("filed", { createdBy: viewer, assignee: other, status: "CLAIMED" }),
  task("observed", { assignee: third, status: "CLAIMED" }),
  task("pool", {}),
  task("held", { assignee: viewer, status: "CLAIMED" }),
  task("done-theirs", { assignee: third, status: "COMPLETED" }),
  task("done-mine", { createdBy: viewer, status: "CANCELLED" })
];

test("Everyone hands back the list it was given", () => {
  assert.equal(visibleBoardTasks(board, { show: "everyone", viewer, ...base }), board, "same reference, so nothing downstream re-renders");
});

test("Mine keeps the tasks the rule keeps, in the order they came", () => {
  const ids = visibleBoardTasks(board, { show: "mine", viewer, ...base }).map((t) => t.id);
  assert.deepEqual(ids, ["filed", "pool", "held", "done-mine"]);
});

test("Mine can come back empty", () => {
  const theirs = [task("observed", { assignee: third, status: "CLAIMED" })];
  assert.deepEqual(visibleBoardTasks(theirs, { show: "mine", viewer, ...base }), []);
});

/* ── A picked loan (#333) ───────────────────────────────── */

/* The board a search narrows: two loans, active and closed on each, plus a task
   filed before loans existed and so carrying no loan at all. */
const loanBoard = [
  task("h-open", { loanId: "loan-h" }),
  task("other-open", { loanId: "loan-o" }),
  task("h-observed", { loanId: "loan-h", assignee: third, status: "CLAIMED" }),
  task("unlinked", {}),
  task("h-done", { loanId: "loan-h", assignee: third, status: "COMPLETED" }),
  task("other-done", { loanId: "loan-o", createdBy: viewer, status: "ARCHIVED" })
];

test("a picked loan keeps only that loan's tasks, active and closed, in the order they came", () => {
  const ids = visibleBoardTasks(loanBoard, { show: "everyone", viewer, ...base, loanId: "loan-h" }).map((t) => t.id);
  assert.deepEqual(ids, ["h-open", "h-observed", "h-done"]);
});

test("a picked loan shows the whole file, somebody else's work and closed tasks included", () => {
  const ids = visibleBoardTasks(loanBoard, { show: "everyone", viewer, ...base, loanId: "loan-h" }).map((t) => t.id);
  assert.deepEqual(ids, ["h-open", "h-observed", "h-done"], "somebody else's work and closed tasks the viewer was not a Party to stay");
});

test("a picked loan narrows All Tasks only: the Mine list ignores it (#390)", () => {
  const ids = visibleBoardTasks(loanBoard, { show: "mine", viewer, ...base, loanId: "loan-h" }).map((t) => t.id);
  assert.deepEqual(ids, ["h-open", "other-open", "unlinked", "other-done"], "the My Tasks tab is the Mine board, searching or not");
});

test("a picked loan with nothing on the board comes back empty", () => {
  assert.deepEqual(visibleBoardTasks(loanBoard, { show: "everyone", viewer, ...base, loanId: "loan-none" }), []);
});

test("no picked loan leaves the Show setting in charge", () => {
  assert.equal(visibleBoardTasks(loanBoard, { show: "everyone", viewer, ...base, loanId: null }), loanBoard, "same reference");
  const ids = visibleBoardTasks(loanBoard, { show: "mine", viewer, ...base, loanId: null }).map((t) => t.id);
  assert.deepEqual(ids, ["h-open", "other-open", "unlinked", "other-done"]);
});

/* ── The stored choice ──────────────────────────────────── */

test("All Tasks is stored as Everyone, My Tasks as Mine, and Task Drafts is never stored (#390)", () => {
  assert.equal(showForTab("all"), "everyone");
  assert.equal(showForTab("mine"), "mine");
  assert.equal(showForTab("drafts"), null, "a reload never opens on Task Drafts");
});

test("the stored value opens its tab, so a Mine stored before the tabs existed opens My Tasks", () => {
  assert.equal(tabForShow(parseBoardShow("mine")), "mine");
  assert.equal(tabForShow(parseBoardShow("everyone")), "all");
  assert.equal(tabForShow(parseBoardShow(null)), "all", "first load");
  for (const tab of ["all", "mine"]) assert.equal(tabForShow(showForTab(tab)), tab, `${tab} survives a reload`);
});

/* ── A link to a task (#390) ────────────────────────────── */

test("a link lands on My Tasks when My Tasks is what's stored and the task is on it", () => {
  assert.equal(tabForLink({ show: "mine", onMineBoard: true }), "mine");
});

test("a link to a task My Tasks hides lands on All Tasks", () => {
  assert.equal(tabForLink({ show: "mine", onMineBoard: false }), "all", "an Observer task opens on All Tasks");
});

test("with All Tasks stored a link always lands on All Tasks", () => {
  assert.equal(tabForLink({ show: "everyone", onMineBoard: true }), "all");
  assert.equal(tabForLink({ show: "everyone", onMineBoard: false }), "all");
});

test("nothing stored, or anything unrecognised, reads as Everyone", () => {
  assert.equal(parseBoardShow(null), "everyone", "first load");
  assert.equal(parseBoardShow("everyone"), "everyone");
  assert.equal(parseBoardShow("MINE"), "everyone", "only the exact stored value turns it on");
  assert.equal(parseBoardShow("true"), "everyone");
});

test("a stored Mine reads back as Mine", () => {
  assert.equal(parseBoardShow("mine"), "mine");
});

/* ── History: how far back finished tasks go (#391) ─────── */

test("the setting offers Last 7, 14 and 30 days, then All", () => {
  assert.deepEqual(BOARD_HISTORY_CHOICES.map((c) => c.label), ["Last 7 days", "Last 14 days", "Last 30 days", "All"]);
  assert.deepEqual(BOARD_HISTORY_CHOICES.map((c) => c.value), [7, 14, 30, "all"]);
});

test("nothing stored, or anything unrecognised, reads as Last 14 days", () => {
  assert.equal(parseBoardHistory(null), 14, "first load");
  assert.equal(parseBoardHistory(undefined), 14);
  for (const garbage of ["", "14 days", "07", "ALL", "60", "0", "-7", "true", "{}"]) {
    assert.equal(parseBoardHistory(garbage), 14, JSON.stringify(garbage));
  }
});

test("each stored choice reads back as itself", () => {
  assert.equal(parseBoardHistory("7"), 7);
  assert.equal(parseBoardHistory("14"), 14);
  assert.equal(parseBoardHistory("30"), 30);
  assert.equal(parseBoardHistory("all"), "all");
});

test("a stored choice survives being written and read back", () => {
  for (const { value } of BOARD_HISTORY_CHOICES) {
    assert.equal(parseBoardHistory(String(value)), value);
  }
});

/* Closed tasks at a spread of ages, each closed by a different stamp so the
   close-stamp fallback order is exercised, plus open and in-flight work filed
   a year ago. */
const aged = [
  task("done-6", { status: "COMPLETED", completedAt: daysAgo(6), updatedAt: daysAgo(1) }),
  task("cancelled-8", { status: "CANCELLED", cancelledAt: daysAgo(8), updatedAt: daysAgo(1) }),
  task("archived-13", { status: "ARCHIVED", completedAt: daysAgo(13), archivedAt: daysAgo(1), updatedAt: daysAgo(1) }),
  task("archived-15", { status: "ARCHIVED", archivedAt: daysAgo(15), updatedAt: daysAgo(1) }),
  task("stampless-29", { status: "COMPLETED", updatedAt: daysAgo(29) }),
  task("done-31", { status: "COMPLETED", completedAt: daysAgo(31) }),
  task("done-100", { status: "COMPLETED", completedAt: daysAgo(100) }),
  task("open-old", { createdAt: daysAgo(400), updatedAt: daysAgo(400) }),
  task("claimed-old", { status: "CLAIMED", assignee: third, createdAt: daysAgo(400), updatedAt: daysAgo(400) }),
  task("awaiting-old", { taskType: "FRAUD", status: "AWAITING_ITEMS", assignee: third, createdAt: daysAgo(400), updatedAt: daysAgo(400) })
];
const shown = (history, extra = {}) =>
  visibleBoardTasks(aged, { show: "everyone", viewer, history, now: NOW, ...extra }).map((t) => t.id);
const OPEN_OLD = ["open-old", "claimed-old", "awaiting-old"];

test("Last 7 days keeps closed tasks inside a week and drops the rest", () => {
  assert.deepEqual(shown(7), ["done-6", ...OPEN_OLD]);
});

test("Last 14 days keeps closed tasks inside two weeks, reading the completion stamp before a later archive", () => {
  assert.deepEqual(shown(14), ["done-6", "cancelled-8", "archived-13", ...OPEN_OLD]);
});

test("Last 30 days keeps closed tasks inside a month, falling back to the last update when nothing else is stamped", () => {
  assert.deepEqual(shown(30), ["done-6", "cancelled-8", "archived-13", "archived-15", "stampless-29", ...OPEN_OLD]);
});

test("All keeps every closed task, and hands back the list it was given", () => {
  assert.deepEqual(shown("all"), aged.map((t) => t.id));
  assert.equal(visibleBoardTasks(aged, { show: "everyone", viewer, history: "all", now: NOW }), aged, "same reference");
});

test("open and in-flight work is never cut, however old", () => {
  for (const { value } of BOARD_HISTORY_CHOICES) {
    const ids = shown(value);
    for (const id of OPEN_OLD) assert.ok(ids.includes(id), `${id} under ${value}`);
  }
});

test("a task closed exactly on the edge of the window is still in it", () => {
  const edge = [task("edge", { status: "COMPLETED", completedAt: daysAgo(7) })];
  assert.deepEqual(visibleBoardTasks(edge, { show: "everyone", viewer, history: 7, now: NOW }).map((t) => t.id), ["edge"]);
  const past = [task("past", { status: "COMPLETED", completedAt: new Date(NOW - 7 * DAY - 1).toISOString() })];
  assert.deepEqual(visibleBoardTasks(past, { show: "everyone", viewer, history: 7, now: NOW }), []);
});

test("Last 14 days cuts exactly what the fixed fourteen-day window cut", () => {
  /* The rule this replaced, as it stood in App's buildSorted. */
  const cutoff = NOW - 14 * DAY;
  const legacy = aged.filter((t) => {
    if (!["COMPLETED", "CANCELLED", "ARCHIVED"].includes(t.status)) return true;
    const stamp = t.completedAt ?? t.cancelledAt ?? t.archivedAt ?? t.updatedAt;
    return new Date(stamp).getTime() >= cutoff;
  });
  assert.deepEqual(shown(parseBoardHistory(null)), legacy.map((t) => t.id));
});

test("an uncut list comes back as the same reference", () => {
  const recent = aged.filter((t) => t.id === "done-6" || OPEN_OLD.includes(t.id));
  assert.equal(visibleBoardTasks(recent, { show: "everyone", viewer, history: 7, now: NOW }), recent);
});

test("History and Mine combine", () => {
  const mixed = [
    task("mine-recent", { createdBy: viewer, status: "COMPLETED", completedAt: daysAgo(2) }),
    task("mine-old", { createdBy: viewer, status: "COMPLETED", completedAt: daysAgo(20) }),
    task("theirs-recent", { assignee: third, status: "COMPLETED", completedAt: daysAgo(2) })
  ];
  const ids = visibleBoardTasks(mixed, { show: "mine", viewer, history: 14, now: NOW }).map((t) => t.id);
  assert.deepEqual(ids, ["mine-recent"]);
});

test("a picked loan ignores History and shows the loan's closed tasks of any age, in the order they came", () => {
  const onLoan = [
    task("l-open", { loanId: "loan-h" }),
    task("l-done-3", { loanId: "loan-h", status: "COMPLETED", completedAt: daysAgo(3) }),
    task("o-done-60", { loanId: "loan-o", status: "COMPLETED", completedAt: daysAgo(60) }),
    task("l-done-60", { loanId: "loan-h", status: "ARCHIVED", archivedAt: daysAgo(60) })
  ];
  const searched = visibleBoardTasks(onLoan, { show: "everyone", viewer, history: 7, now: NOW, loanId: "loan-h" }).map((t) => t.id);
  assert.deepEqual(searched, ["l-open", "l-done-3", "l-done-60"]);
  const cleared = visibleBoardTasks(onLoan, { show: "everyone", viewer, history: 7, now: NOW, loanId: null }).map((t) => t.id);
  assert.deepEqual(cleared, ["l-open", "l-done-3"], "clearing the search puts the cutoff back");
});

test("a kept task stays on the board outside the window, and only that one", () => {
  const ids = shown(7, { keep: new Set(["done-100"]) });
  assert.deepEqual(ids, ["done-6", "done-100", ...OPEN_OLD]);
});

test("a kept task is still subject to Mine", () => {
  const theirs = [task("theirs-old", { assignee: third, status: "COMPLETED", completedAt: daysAgo(40) })];
  assert.deepEqual(visibleBoardTasks(theirs, { show: "mine", viewer, history: 7, now: NOW, keep: new Set(["theirs-old"]) }), []);
});

test("isWithinHistory answers for one task", () => {
  assert.equal(isWithinHistory(aged[0], 7, NOW), true);
  assert.equal(isWithinHistory(aged[1], 7, NOW), false);
  assert.equal(isWithinHistory(aged[6], "all", NOW), true);
  assert.equal(isWithinHistory(aged[7], 7, NOW), true, "open work is always within");
});

/* ── Which tab's body the board shows (#363, #390) ──────── */

test("the Task Drafts tab shows the drafts, whatever the search says", () => {
  for (const searching of [false, true]) {
    for (const shownCount of [0, 3]) {
      assert.equal(boardBody({ tab: "drafts", searching, shownCount }), "drafts", JSON.stringify({ searching, shownCount }));
    }
  }
});

test("All Tasks and My Tasks show the task list when there is something on it", () => {
  assert.equal(boardBody({ tab: "all", searching: false, shownCount: 4 }), "tasks");
  assert.equal(boardBody({ tab: "all", searching: true, shownCount: 1 }), "tasks");
  assert.equal(boardBody({ tab: "mine", searching: false, shownCount: 4 }), "tasks");
  assert.equal(boardBody({ tab: "mine", searching: true, shownCount: 4 }), "tasks");
});

test("an empty All Tasks with nothing narrowing it is still the task list, which says No tasks yet itself", () => {
  assert.equal(boardBody({ tab: "all", searching: false, shownCount: 0 }), "tasks");
});

test("on All Tasks an empty search says so", () => {
  assert.equal(boardBody({ tab: "all", searching: true, shownCount: 0 }), "search-empty");
});

test("an empty My Tasks says so, and a search never stands in for it, since the search narrows All Tasks only", () => {
  assert.equal(boardBody({ tab: "mine", searching: false, shownCount: 0 }), "mine-empty");
  assert.equal(boardBody({ tab: "mine", searching: true, shownCount: 0 }), "mine-empty");
});
