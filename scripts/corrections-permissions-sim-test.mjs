#!/usr/bin/env node
/*
 * The corrections state belongs to the creator, and only the checker can send
 * work there (#236, ADR-0007).
 *
 * The defect this closes was never one wrong rule. Two rules drifted apart —
 * the status-level gate on NEEDS_REVIEW admitted creator and assignee, while
 * completion admitted the assignee alone — and the web app rendered its
 * Complete button from the wider one. A creator was shown a button that
 * answered with "User cannot complete this task". No test compared what a
 * surface offers with what the server accepts, which is how it survived #182's
 * audit of the bot cards.
 *
 * So the first section here is that comparison, and it is the criterion that
 * matters most: for EVERY task type, EVERY status and EVERY seat, any control a
 * surface offers is one `canTransitionStatus` — the predicate the server runs
 * on the request — would accept. The bot surfaces are asked directly. The web
 * ladder is React and cannot be imported into a node script, so it is covered
 * one level down: every seat predicate a surface might gate a control on is
 * checked, over the whole matrix, against the server's answer for the move it
 * guards. That is the exact shape of the defect — `canMoveNeedsReview` said
 * yes to the creator, the flow allowed the move, and the server still said
 * no — so a surface that reads a seat predicate plus flow legality (as the web
 * ladder did, and as its other branches still do) cannot be wrong-footed. The
 * three controls this ticket owns now read `canTransitionStatus` itself in
 * App.tsx, which this file cannot assert and says so here rather than pretend.
 *
 * The sections after it pin the rule itself (ADR-0007 rules 1–3), first as
 * pure predicates over the full matrix and then end to end through the real
 * TaskService, and finally the store's start-up migration for any task of
 * another type left sitting in the state.
 *
 * Runs against the compiled dist, mirroring card-advance-party-sim-test.mjs.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SYSTEM_ACTOR, TASK_STATUSES, TASK_TYPES } from "../packages/shared/dist/types.js";
import {
  botAdvanceFor,
  canApproveMerge,
  canCancelTask,
  canCompleteTask,
  canMarkMergeDone,
  canMoveNeedsReview,
  canMoveToNeedsReview,
  canTransitionStatus,
  nextFlowStatuses,
  pendingPartyFor
} from "../packages/shared/dist/workflow.js";
import { fraudCardActions, taskCardRecipients } from "../packages/shared/dist/fraud.js";
import { TaskStore } from "../apps/server/dist/store.js";
import { SseHub } from "../apps/server/dist/sse.js";
import { TaskService } from "../apps/server/dist/task-service.js";

const CREATOR = { id: "creator-1", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] };
/* FILE_CHECKER so the same person can sit in the checker seat on the FRAUD
   rows; it buys nothing on any other type. */
const ASSIGNEE = { id: "worker-1", displayName: "Sam Officer", roles: ["LOAN_OFFICER", "FILE_CHECKER"] };
/* Neither party. Also an admin, so every row doubles as the "ADMIN confers
   nothing" case (ADR-0003). */
const OBSERVER = { id: "admin-1", displayName: "Avery Admin", roles: ["LOAN_OFFICER", "FILE_CHECKER", "ADMIN"] };
const PEOPLE = [CREATOR, ASSIGNEE, OBSERVER];
/* The scheduler. Not a seat: the rule is about people, and the automatic route
   survives it (ADR-0007 rule 1). */
const SYSTEM = SYSTEM_ACTOR;

const makeTask = (overrides = {}) => ({
  id: "task-1",
  folderName: "Smith-1042",
  taskType: "LOI",
  dueAt: new Date("2026-08-14T20:00:00Z").toISOString(),
  urgency: "GREEN",
  points: 2,
  notes: "have a look",
  status: "CLAIMED",
  createdAt: new Date("2026-08-14T00:00:00Z").toISOString(),
  updatedAt: new Date("2026-08-14T00:00:00Z").toISOString(),
  createdBy: { id: CREATOR.id, displayName: CREATOR.displayName },
  assignee: { id: ASSIGNEE.id, displayName: ASSIGNEE.displayName },
  ...overrides
});

/* Every cell: each type, each status, with and without someone in the assignee
   slot. Some cells are unreachable in practice (a Value Check in MERGE_DONE);
   the agreement must hold there too, because the surfaces don't know which
   cells are reachable and a stranded task is still rendered. */
const CELLS = [];
for (const taskType of TASK_TYPES) {
  for (const status of TASK_STATUSES) {
    CELLS.push({ taskType, status, unassigned: false });
    CELLS.push({ taskType, status, unassigned: true });
  }
}
const taskFor = (cell) => makeTask({ taskType: cell.taskType, status: cell.status, ...(cell.unassigned ? { assignee: undefined } : {}) });
const cellName = (cell) => `${cell.taskType} @ ${cell.status}${cell.unassigned ? " (unassigned)" : ""}`;

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

const refused = async (fn, expected, message) => {
  await assert.rejects(fn, (err) => {
    assert.match(err.message, expected, message ?? "refused for the stated reason");
    return true;
  });
};

console.log("The corrections state belongs to the creator, and only the checker can send work there (#236)");

// ---------------------------------------------------------------------------
// 1. No surface offers a control the server would refuse
// ---------------------------------------------------------------------------

/* Every seat predicate the shared module exports, paired with the move(s) it
   guards. A surface that renders a control from "this predicate says yes and
   the flow lists the move" — which is how the web ladder read NEEDS_REVIEW →
   Complete when the defect shipped, and how several of its branches still
   read — must never be shown a control the server refuses. */
const SEAT_PREDICATES = [
  { name: "canCompleteTask", holds: canCompleteTask, targets: () => ["COMPLETED"] },
  { name: "canMoveNeedsReview", holds: canMoveNeedsReview, targets: () => ["CLAIMED", "COMPLETED"] },
  { name: "canMoveToNeedsReview", holds: canMoveToNeedsReview, targets: () => ["NEEDS_REVIEW"] },
  { name: "canMarkMergeDone", holds: canMarkMergeDone, targets: () => ["MERGE_DONE"] },
  { name: "canApproveMerge", holds: canApproveMerge, targets: () => ["MERGE_APPROVED"] },
  { name: "canCancelTask", holds: canCancelTask, targets: () => ["CANCELLED"] }
];

await check("web: a seat predicate that says yes to a flow-legal move is never contradicted by the server", () => {
  for (const cell of CELLS) {
    const task = taskFor(cell);
    const legal = nextFlowStatuses(task);
    for (const viewer of PEOPLE) {
      for (const predicate of SEAT_PREDICATES) {
        if (!predicate.holds(task, viewer)) {
          continue;
        }
        for (const target of predicate.targets().filter((status) => legal.includes(status))) {
          const verdict = canTransitionStatus(task, target, viewer);
          assert.ok(
            verdict.ok,
            `${cellName(cell)}: ${predicate.name} says ${viewer.displayName} may go to ${target}, but the server says "${verdict.reason}"`
          );
        }
      }
    }
  }
  // And the check has teeth: the original defect is exactly this shape, with
  // the old creator-admitting out-of-review rule standing in for the predicate.
  const inCorrections = makeTask({ status: "NEEDS_REVIEW" });
  const oldRule = (task, user) => task.createdBy.id === user.id || task.assignee?.id === user.id;
  assert.ok(oldRule(inCorrections, ASSIGNEE) && !canTransitionStatus(inCorrections, "COMPLETED", ASSIGNEE).ok, "the pre-#236 rule would fail this check today");
});

await check("bot cards: every advance button offered is a move the server accepts", () => {
  for (const cell of CELLS) {
    const task = taskFor(cell);
    for (const viewer of PEOPLE) {
      const advance = botAdvanceFor(task, viewer);
      if (advance) {
        const verdict = canTransitionStatus(task, advance.status, viewer);
        assert.ok(verdict.ok, `${cellName(cell)}: ${viewer.displayName} is offered "${advance.label}" but the server says "${verdict.reason}"`);
      }
      const [recipient] = taskCardRecipients(task, [viewer]);
      if (recipient?.showAdvance) {
        assert.ok(advance, `${cellName(cell)}: showAdvance for ${viewer.displayName} with no advance to show`);
      }
    }
  }
});

await check("fraud cards: every enabled transition offered is a move the server accepts", () => {
  for (const cell of CELLS) {
    if (cell.taskType !== "FRAUD") {
      continue;
    }
    const task = taskFor(cell);
    for (const viewer of PEOPLE) {
      for (const action of fraudCardActions(task, viewer)) {
        // A disabled Submit (blockedReason) is rendered but not tappable, and the
        // server's refusal carries that same sentence; only enabled controls
        // must be accepted.
        if (!action.targetStatus || action.blockedReason) {
          continue;
        }
        const verdict = canTransitionStatus(task, action.targetStatus, viewer);
        assert.ok(verdict.ok, `${cellName(cell)}: ${viewer.displayName} is offered "${action.label}" but the server says "${verdict.reason}"`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 2. The rule, as predicates over the whole matrix (ADR-0007 rules 1–3)
// ---------------------------------------------------------------------------

await check("rule 3: no task of another type can reach the corrections state by any path", () => {
  for (const cell of CELLS) {
    if (cell.taskType === "LOI" || cell.status === "NEEDS_REVIEW") {
      continue;
    }
    const task = taskFor(cell);
    assert.ok(!nextFlowStatuses(task).includes("NEEDS_REVIEW"), `${cellName(cell)}: the status is not on offer`);
    for (const actor of [...PEOPLE, SYSTEM]) {
      const verdict = canTransitionStatus(task, "NEEDS_REVIEW", actor);
      assert.equal(verdict.ok, false, `${cellName(cell)}: refused for ${actor.displayName}`);
    }
    const verdict = canTransitionStatus(task, "NEEDS_REVIEW", ASSIGNEE);
    assert.match(verdict.reason, /LOI/, `${cellName(cell)}: the refusal names the task-type rule`);
  }
});

await check("rule 1: the one entrance is the assignee's, from the task they are holding", () => {
  for (const status of TASK_STATUSES) {
    if (status === "NEEDS_REVIEW") {
      continue;
    }
    const task = makeTask({ status });
    const expected = status === "CLAIMED";
    assert.equal(nextFlowStatuses(task).includes("NEEDS_REVIEW"), expected, `LOI @ ${status}: on offer only from CLAIMED`);
    assert.equal(canTransitionStatus(task, "NEEDS_REVIEW", ASSIGNEE).ok, expected, `LOI @ ${status}: the assignee`);
    assert.equal(canTransitionStatus(task, "NEEDS_REVIEW", SYSTEM).ok, expected, `LOI @ ${status}: the system actor keeps its route`);
    assert.equal(canTransitionStatus(task, "NEEDS_REVIEW", CREATOR).ok, false, `LOI @ ${status}: never the creator`);
    assert.equal(canTransitionStatus(task, "NEEDS_REVIEW", OBSERVER).ok, false, `LOI @ ${status}: never a bystander, admin or not`);
  }
  const claimed = makeTask({ status: "CLAIMED" });
  assert.match(canTransitionStatus(claimed, "NEEDS_REVIEW", CREATOR).reason, /only the assignee/i, "the creator's refusal names the rule");
  assert.match(canTransitionStatus(claimed, "NEEDS_REVIEW", OBSERVER).reason, /only the assignee/i, "so does the bystander's");
  const vacant = makeTask({ status: "CLAIMED", assignee: undefined });
  assert.equal(canTransitionStatus(vacant, "NEEDS_REVIEW", ASSIGNEE).ok, false, "a vacant seat sends nothing");
});

await check("rule 2: from corrections the creator has two moves, and the assignee waits", () => {
  const task = makeTask({ status: "NEEDS_REVIEW" });
  for (const target of ["COMPLETED", "CLAIMED"]) {
    assert.equal(canTransitionStatus(task, target, CREATOR).ok, true, `${target}: the creator's move`);
    assert.equal(canTransitionStatus(task, target, SYSTEM).ok, true, `${target}: the system actor keeps its route`);
    assert.equal(canTransitionStatus(task, target, ASSIGNEE).ok, false, `${target}: not the assignee's`);
    assert.equal(canTransitionStatus(task, target, OBSERVER).ok, false, `${target}: not a bystander's, admin or not`);
    assert.match(canTransitionStatus(task, target, ASSIGNEE).reason, /only the task creator/i, `${target}: the refusal names the rule`);
  }
  assert.equal(canCompleteTask(task, CREATOR), true, "the completion gate itself admits the creator here");
  assert.equal(canCompleteTask(task, ASSIGNEE), false, "and no longer the assignee");
  assert.equal(canMoveNeedsReview(task, CREATOR), true);
  assert.equal(canMoveNeedsReview(task, ASSIGNEE), false);
  assert.equal(pendingPartyFor(task), "CREATOR", "the row's `Waiting on` points at the creator");
  // Cancel is unchanged: still the creator's, from here as from anywhere.
  assert.equal(canTransitionStatus(task, "CANCELLED", CREATOR).ok, true);
  assert.equal(canTransitionStatus(task, "CANCELLED", ASSIGNEE).ok, false);
});

await check("completion from every other status is exactly as it was: the assignee's alone", () => {
  for (const cell of CELLS) {
    if (cell.status === "NEEDS_REVIEW" || cell.unassigned) {
      continue;
    }
    const task = taskFor(cell);
    const completable = ["CLAIMED", "MERGE_APPROVED", "PENDING_APPROVAL"].includes(cell.status);
    const assigneeMayComplete = completable && (cell.taskType !== "FRAUD" || ASSIGNEE.roles.includes("FILE_CHECKER"));
    assert.equal(canCompleteTask(task, ASSIGNEE), assigneeMayComplete, `${cellName(cell)}: assignee`);
    assert.equal(canCompleteTask(task, CREATOR), false, `${cellName(cell)}: never the creator outside corrections`);
    assert.equal(canCompleteTask(task, OBSERVER), false, `${cellName(cell)}: never a bystander`);
  }
});

// ---------------------------------------------------------------------------
// 3. End to end through the real service
// ---------------------------------------------------------------------------

const config = {
  businessTimezone: "America/Los_Angeles",
  businessStartHour: 8,
  businessStartMinute: 30,
  businessEndHour: 17,
  businessEndMinute: 30,
  archiveRetentionDays: 90
};

const setup = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "corrections-sim-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.init();
  const notifier = { notify: async () => {}, canReachDm: async () => true };
  return { dir, store, service: new TaskService(store, notifier, new SseHub(), config) };
};

const claimedTask = async (service, taskType = "LOI") => {
  // An Out of Office cover is the one type with a required extra field.
  const extra = taskType === "OOO" ? { startDate: "2026-09-20", returnDate: "2026-09-30" } : {};
  const task = await service.createTask({ folderName: "Corrections Sim", taskType, notes: "n", ...extra }, CREATOR);
  return service.claimTask(task.id, ASSIGNEE);
};

await check("service: the checker sends an LOI back, the creator finishes it", async () => {
  const { service } = await setup();
  const task = await claimedTask(service);

  await refused(() => service.transitionStatus(task.id, "NEEDS_REVIEW", CREATOR), /only the assignee/i, "the creator cannot send their own request to corrections");
  assert.equal((await service.getTask(task.id)).status, "CLAIMED");

  await service.transitionStatus(task.id, "NEEDS_REVIEW", ASSIGNEE, "typo in the borrower name");
  assert.equal((await service.getTask(task.id)).status, "NEEDS_REVIEW");

  await refused(() => service.transitionStatus(task.id, "COMPLETED", ASSIGNEE), /only the task creator/i, "the assignee cannot complete from corrections");
  await refused(() => service.transitionStatus(task.id, "CLAIMED", ASSIGNEE), /only the task creator/i, "nor pull it back to themselves");
  await refused(() => service.transitionStatus(task.id, "COMPLETED", OBSERVER), /only the task creator/i, "and admin confers nothing");
  assert.equal((await service.getTask(task.id)).status, "NEEDS_REVIEW");

  const noted = await service.addReviewNote(task.id, "actually, leave that one", ASSIGNEE);
  assert.equal(noted.status, "NEEDS_REVIEW", "the assignee keeps the notes thread");
  assert.ok(noted.reviewNotes.some((note) => note.text === "actually, leave that one"));

  const done = await service.transitionStatus(task.id, "COMPLETED", CREATOR);
  assert.equal(done.status, "COMPLETED", "the creator's Complete succeeds");
});

await check("service: the creator can instead send it back for a confirming look", async () => {
  const { service } = await setup();
  const task = await claimedTask(service);
  await service.transitionStatus(task.id, "NEEDS_REVIEW", ASSIGNEE, "wrong loan amount");
  const back = await service.transitionStatus(task.id, "CLAIMED", CREATOR);
  assert.equal(back.status, "CLAIMED");
  assert.equal(back.assignee.id, ASSIGNEE.id, "still in the assignee's hands");
  // And the loop can run again from there.
  await service.transitionStatus(task.id, "NEEDS_REVIEW", ASSIGNEE, "still wrong");
  assert.equal((await service.getTask(task.id)).status, "NEEDS_REVIEW");
});

await check("service: a finished LOI cannot be sent to corrections", async () => {
  const { service } = await setup();
  const task = await claimedTask(service);
  await service.transitionStatus(task.id, "COMPLETED", ASSIGNEE);
  await refused(() => service.transitionStatus(task.id, "NEEDS_REVIEW", ASSIGNEE), /cannot move from COMPLETED/i);
  assert.equal((await service.getTask(task.id)).status, "COMPLETED");
});

await check("service: no other task type reaches corrections, for anyone", async () => {
  const { service } = await setup();
  for (const taskType of TASK_TYPES.filter((type) => type !== "LOI")) {
    const task = await claimedTask(service, taskType);
    await refused(() => service.transitionStatus(task.id, "NEEDS_REVIEW", ASSIGNEE), /LOI/, `${taskType}: the assignee`);
    await refused(() => service.transitionStatus(task.id, "NEEDS_REVIEW", CREATOR), /LOI/, `${taskType}: the creator`);
    await refused(() => service.transitionStatus(task.id, "NEEDS_REVIEW", SYSTEM), /LOI/, `${taskType}: even the scheduler`);
    assert.equal((await service.getTask(task.id)).status, "CLAIMED", `${taskType}: untouched`);
  }
});

await check("service: the system actor keeps its automatic route in and out", async () => {
  const { service } = await setup();
  const task = await claimedTask(service);
  await service.transitionStatus(task.id, "NEEDS_REVIEW", SYSTEM);
  assert.equal((await service.getTask(task.id)).status, "NEEDS_REVIEW");
  await service.transitionStatus(task.id, "COMPLETED", SYSTEM);
  assert.equal((await service.getTask(task.id)).status, "COMPLETED");
});

// ---------------------------------------------------------------------------
// 4. Migration: a task of another type left in the state is moved, not stranded
// ---------------------------------------------------------------------------

await check("store: on start-up, stranded non-LOI tasks leave the corrections state", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "corrections-migrate-"));
  const file = path.join(dir, "tasks.json");
  const stranded = [
    makeTask({ id: "value-held", taskType: "VALUE", status: "NEEDS_REVIEW" }),
    makeTask({ id: "ooo-vacant", taskType: "OOO", status: "NEEDS_REVIEW", assignee: undefined }),
    makeTask({ id: "loi-fine", taskType: "LOI", status: "NEEDS_REVIEW" }),
    makeTask({ id: "fraud-elsewhere", taskType: "FRAUD", status: "PENDING_APPROVAL" })
  ];
  await fs.writeFile(file, JSON.stringify({ tasks: stranded, history: [] }, null, 2), "utf8");

  const store = new TaskStore(file);
  await store.init();
  const byId = Object.fromEntries((await store.allTasks()).map((task) => [task.id, task]));
  assert.equal(byId["value-held"].status, "CLAIMED", "a held task goes back to its holder");
  assert.equal(byId["value-held"].assignee.id, ASSIGNEE.id, "and keeps them");
  assert.equal(byId["ooo-vacant"].status, "OPEN", "a task nobody holds goes back to the pool");
  assert.equal(byId["loi-fine"].status, "NEEDS_REVIEW", "an LOI in corrections is left alone");
  assert.equal(byId["fraud-elsewhere"].status, "PENDING_APPROVAL", "every other status is left alone");

  const history = await store.allHistoryForTask("value-held");
  assert.equal(history.length, 1, "the move is on the record");
  assert.equal(history[0].by.id, SYSTEM.id, "and attributed to the system");
  assert.match(history[0].detail ?? "", /NEEDS_REVIEW/, "naming where it came from");
  assert.equal((await store.allHistoryForTask("loi-fine")).length, 0, "nothing recorded for tasks left alone");

  // Idempotent: a second start-up finds nothing to do.
  const again = new TaskStore(file);
  await again.init();
  assert.equal((await again.allHistoryForTask("value-held")).length, 1, "not recorded twice");
});

await check("store: more than a handful, or a cluster on one type, is left alone and raised instead", async () => {
  /* #236: "If there are more than a handful, or they cluster on one task type,
     stop and raise it on this issue rather than migrating." */
  const strandedSet = async (tasks) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "corrections-cluster-"));
    const file = path.join(dir, "tasks.json");
    await fs.writeFile(file, JSON.stringify({ tasks, history: [] }, null, 2), "utf8");
    const errors = [];
    const original = console.error;
    console.error = (line) => errors.push(String(line));
    try {
      const store = new TaskStore(file);
      await store.init();
      return { tasks: await store.allTasks(), errors };
    } finally {
      console.error = original;
    }
  };

  // Three Value Checks: a cluster on one type, under the handful.
  const cluster = await strandedSet([1, 2, 3].map((n) => makeTask({ id: `value-${n}`, taskType: "VALUE", status: "NEEDS_REVIEW" })));
  assert.ok(cluster.tasks.every((task) => task.status === "NEEDS_REVIEW"), "a cluster is not migrated");
  assert.equal(cluster.errors.length, 1, "and is shouted about once");
  assert.match(cluster.errors[0], /NOT migrated/);
  assert.match(cluster.errors[0], /"VALUE":3/, "naming the type and count");

  // Six across types: more than a handful, no cluster.
  const many = await strandedSet(
    ["VALUE", "VALUE", "OOO", "OOO", "BUDDY_CHAT", "BUDDY_CHAT"].map((taskType, n) => makeTask({ id: `t-${n}`, taskType, status: "NEEDS_REVIEW" }))
  );
  assert.ok(many.tasks.every((task) => task.status === "NEEDS_REVIEW"), "more than a handful is not migrated");
  assert.equal(many.errors.length, 1);

  // Two here, two there: a handful, no cluster — migrated as normal.
  const few = await strandedSet(
    ["VALUE", "VALUE", "OOO", "OOO"].map((taskType, n) => makeTask({ id: `t-${n}`, taskType, status: "NEEDS_REVIEW" }))
  );
  assert.ok(few.tasks.every((task) => task.status === "CLAIMED"), "a handful spread across types is migrated");
  assert.equal(few.errors.length, 0);
});

console.log(`\n${passed} checks passed`);
