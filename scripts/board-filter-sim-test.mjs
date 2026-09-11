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
  BOARD_SHOW_CHOICES,
  isOnMineBoard,
  parseBoardShow,
  visibleBoardTasks
} from "../apps/web/src/board-filter.ts";

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
  assert.equal(visibleBoardTasks(board, { show: "everyone", viewer }), board, "same reference, so nothing downstream re-renders");
});

test("Mine keeps the tasks the rule keeps, in the order they came", () => {
  const ids = visibleBoardTasks(board, { show: "mine", viewer }).map((t) => t.id);
  assert.deepEqual(ids, ["filed", "pool", "held", "done-mine"]);
});

test("Mine can come back empty", () => {
  const theirs = [task("observed", { assignee: third, status: "CLAIMED" })];
  assert.deepEqual(visibleBoardTasks(theirs, { show: "mine", viewer }), []);
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
  const ids = visibleBoardTasks(loanBoard, { show: "everyone", viewer, loanId: "loan-h" }).map((t) => t.id);
  assert.deepEqual(ids, ["h-open", "h-observed", "h-done"]);
});

test("a picked loan shows the whole file even with Mine on", () => {
  const ids = visibleBoardTasks(loanBoard, { show: "mine", viewer, loanId: "loan-h" }).map((t) => t.id);
  assert.deepEqual(ids, ["h-open", "h-observed", "h-done"], "somebody else's work and closed tasks the viewer was not a Party to stay");
});

test("a picked loan with nothing on the board comes back empty", () => {
  assert.deepEqual(visibleBoardTasks(loanBoard, { show: "everyone", viewer, loanId: "loan-none" }), []);
});

test("no picked loan leaves the Show setting in charge", () => {
  assert.equal(visibleBoardTasks(loanBoard, { show: "everyone", viewer, loanId: null }), loanBoard, "same reference");
  const ids = visibleBoardTasks(loanBoard, { show: "mine", viewer, loanId: null }).map((t) => t.id);
  assert.deepEqual(ids, ["h-open", "other-open", "unlinked", "other-done"]);
});

/* ── The stored choice ──────────────────────────────────── */

test("the setting offers Everyone then Mine", () => {
  assert.deepEqual(BOARD_SHOW_CHOICES.map((c) => c.label), ["Everyone", "Mine"]);
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
