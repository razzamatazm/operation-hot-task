#!/usr/bin/env node
/*
 * Issue #133 — how the grouped view's active courts rank tasks.
 *
 * A FRAUD task in AWAITING_ITEMS is paused: its `dueAt` belongs to the
 * requester's original ask, is excluded from `isOverdue` and from the reminder
 * engine, and keeps sliding into the past. Sorting the courts by raw `dueAt`
 * therefore floated those tasks to the top of the list as the most urgent thing
 * present. #132 stopped the row *claiming* it was overdue; this is the ranking
 * half.
 *
 * `byAttentionClaim` (packages/shared/src/ordering.ts) is two-tier: anything
 * carrying a live deadline outranks anything that doesn't, paused tasks order
 * longest-held first among themselves, and ties resolve by createdAt then id so
 * the order is total and stable across renders.
 *
 * Asserts observable ordering — build a list, sort it, check the sequence — not
 * the comparator's internals. Runs against the compiled dist, mirroring
 * fraud-cards-sim-test.mjs.
 */
import assert from "node:assert/strict";

import { byAttentionClaim, handedOffAt } from "../packages/shared/dist/ordering.js";

const CHECKER = { id: "checker-1", displayName: "Casey Checker" };
const CREATOR = { id: "creator-1", displayName: "Dana Requester" };

const NOW = new Date("2026-08-21T12:00:00Z");
const iso = (offsetDays) => new Date(NOW.getTime() + offsetDays * 86400000).toISOString();

const task = (id, overrides = {}) => ({
  id,
  folderName: `Folder ${id}`,
  taskType: "VALUE",
  dueAt: iso(1),
  urgency: "GREEN",
  points: 1,
  status: "CLAIMED",
  createdAt: iso(-10),
  updatedAt: iso(-1),
  createdBy: { ...CREATOR },
  assignee: { ...CHECKER },
  ...overrides
});

/* A FRAUD task handed to the requester `heldForDays` ago, carrying the dead
   deadline that caused the bug. */
const paused = (id, heldForDays, overrides = {}) =>
  task(id, {
    taskType: "FRAUD",
    status: "AWAITING_ITEMS",
    dueAt: iso(-365 * 2),
    awaitingItemsSince: iso(-heldForDays),
    ...overrides
  });

const order = (list) => [...list].sort(byAttentionClaim).map((t) => t.id);

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
};

// --- The bug ----------------------------------------------------------------
check("a paused task with a years-dead deadline sorts below one due next month", () => {
  const dueNextMonth = task("live", { dueAt: iso(30) });
  const held = paused("held", 3);
  assert.deepEqual(order([held, dueNextMonth]), ["live", "held"]);
  assert.deepEqual(order([dueNextMonth, held]), ["live", "held"]);
});

check("a paused task sorts below every live deadline, overdue ones included", () => {
  const list = [paused("held", 3), task("overdue", { dueAt: iso(-2) }), task("soon", { dueAt: iso(0.25) }), task("later", { dueAt: iso(9) })];
  assert.deepEqual(order(list), ["overdue", "soon", "later", "held"]);
});

// --- Inside the paused tier -------------------------------------------------
check("two paused tasks order longest-held first", () => {
  const list = [paused("recent", 1), paused("oldest", 20), paused("middle", 5)];
  assert.deepEqual(order(list), ["oldest", "middle", "recent"]);
});

check("a paused task with no awaitingItemsSince falls back to updatedAt and stays paused", () => {
  const legacy = paused("legacy", 0, { awaitingItemsSince: undefined, updatedAt: iso(-30) });
  assert.equal(handedOffAt(legacy), legacy.updatedAt);
  const list = [paused("stamped", 5), legacy, task("live", { dueAt: iso(20) })];
  // Held 30 days by its fallback anchor, so it leads the paused tier — but the
  // live deadline still leads the list.
  assert.deepEqual(order(list), ["live", "legacy", "stamped"]);
});

// --- The live tier is unchanged ---------------------------------------------
check("non-FRAUD tasks order by dueAt exactly as before", () => {
  const list = [task("c", { dueAt: iso(3) }), task("a", { dueAt: iso(-1) }), task("b", { dueAt: iso(1) })];
  assert.deepEqual(order(list), ["a", "b", "c"]);
});

check("FRAUD tasks in every status but AWAITING_ITEMS order by dueAt", () => {
  for (const status of ["OPEN", "CLAIMED", "PENDING_APPROVAL", "NEEDS_REVIEW"]) {
    const list = [
      task("late", { taskType: "FRAUD", status, dueAt: iso(5) }),
      task("early", { taskType: "FRAUD", status, dueAt: iso(-5) })
    ];
    assert.deepEqual(order(list), ["early", "late"], status);
  }
});

check("a non-FRAUD task in AWAITING_ITEMS keeps its deadline", () => {
  // Only FRAUD reaches this status today; the tier is defined by task type too,
  // so a non-FRAUD task there is not treated as paused.
  const list = [task("awaiting", { status: "AWAITING_ITEMS", dueAt: iso(-2) }), task("live", { dueAt: iso(2) })];
  assert.deepEqual(order(list), ["awaiting", "live"]);
});

check("a list with no paused task sorts identically to the old dueAt comparator", () => {
  const byDue = (a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
  const list = [
    task("v1", { dueAt: iso(4) }),
    task("f1", { taskType: "FRAUD", status: "PENDING_APPROVAL", dueAt: iso(-3) }),
    task("v2", { dueAt: iso(0) }),
    task("f2", { taskType: "FRAUD", status: "CLAIMED", dueAt: iso(11) }),
    task("v3", { dueAt: iso(-9) })
  ];
  assert.deepEqual(order(list), [...list].sort(byDue).map((t) => t.id));
});

// --- Total and stable -------------------------------------------------------
check("equal keys resolve by createdAt, then id", () => {
  const list = [
    task("zzz", { dueAt: iso(1), createdAt: iso(-2) }),
    task("aaa", { dueAt: iso(1), createdAt: iso(-2) }),
    task("mmm", { dueAt: iso(1), createdAt: iso(-5) })
  ];
  assert.deepEqual(order(list), ["mmm", "aaa", "zzz"]);
});

check("paused tasks with the same anchor resolve by createdAt, then id", () => {
  const list = [paused("zzz", 4, { createdAt: iso(-2) }), paused("aaa", 4, { createdAt: iso(-2) }), paused("mmm", 4, { createdAt: iso(-6) })];
  assert.deepEqual(order(list), ["mmm", "aaa", "zzz"]);
});

check("the order is the same whatever order the list arrives in", () => {
  const list = [paused("held-a", 2), task("due-soon", { dueAt: iso(1) }), paused("held-b", 8), task("due-late", { dueAt: iso(6) })];
  const expected = ["due-soon", "due-late", "held-b", "held-a"];
  assert.deepEqual(order(list), expected);
  assert.deepEqual(order([...list].reverse()), expected);
  assert.deepEqual(order([list[2], list[0], list[3], list[1]]), expected);
});

check("comparing a task with itself is zero, and the comparator is antisymmetric", () => {
  const pairs = [
    [paused("p", 3), task("t")],
    [paused("p1", 3), paused("p2", 9)],
    [task("t1", { dueAt: iso(1) }), task("t2", { dueAt: iso(2) })]
  ];
  for (const [a, b] of pairs) {
    assert.equal(byAttentionClaim(a, a), 0);
    assert.equal(Math.sign(byAttentionClaim(a, b)), -Math.sign(byAttentionClaim(b, a)));
  }
});

console.log(`\nAll ${passed} task-ordering checks passed.`);
