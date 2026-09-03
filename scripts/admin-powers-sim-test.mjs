#!/usr/bin/env node
/*
 * Admin is back-end access only (ADR-0003) — at the TaskService level, driving
 * the real service against a real (temp-file) store with a mock notifier.
 *
 * ADMIN used to be a second identity: a dozen overrides over other people's
 * work, each one a branch in a permission predicate. It is now a set of
 * back-end powers and nothing else, so an admin who is neither creator nor
 * assignee is refused every move on the task, exactly like any other
 * bystander.
 *
 * What this asserts, one representative refusal per removed power:
 *
 *   - unclaim, cancel, complete, move-to/out-of NEEDS_REVIEW, restore, the
 *     merge-undo transition, both fraud-checker moves, submit-for-approval,
 *     release-for-any-checker, note-adding (active and completed) and
 *     points-editing are all refused for an admin bystander.
 *   - The refusal a points edit gives names the rule it enforces (it used to
 *     say "only the task creator" while quietly permitting admins).
 *   - What survives: handoff is open to EVERY authenticated user, so an admin
 *     bystander can still move a stuck task the only way anyone can. (The
 *     back-end powers admin keeps — user CRUD, config, All Tasks, Metrics —
 *     are route-level gates and belong to scripts/smoke-test.mjs, not here.)
 *   - Removing the admin branches doesn't remove the SYSTEM ones: OOO
 *     auto-completion by the scheduler lives in scripts/scheduler-sim-test.mjs
 *     and is the reason the SYSTEM actor landed before this change.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TaskStore } from "../apps/server/dist/store.js";
import { SseHub } from "../apps/server/dist/sse.js";
import { TaskService } from "../apps/server/dist/task-service.js";

const config = {
  businessTimezone: "America/Los_Angeles",
  businessStartHour: 8,
  businessStartMinute: 30,
  businessEndHour: 17,
  businessEndMinute: 30,
  archiveRetentionDays: 90
};

/* The admin is deliberately also a FILE_CHECKER: the point is that neither the
   role nor the admin bit gets them a seat on somebody else's task. */
const ADMIN = { id: "admin-1", displayName: "Avery Admin", roles: ["LOAN_OFFICER", "FILE_CHECKER", "ADMIN"] };
const CREATOR = { id: "creator-1", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] };
const WORKER = { id: "worker-1", displayName: "Sam Officer", roles: ["LOAN_OFFICER"] };
const CHECKER = { id: "checker-1", displayName: "Casey Checker", roles: ["LOAN_OFFICER", "FILE_CHECKER"] };

const setup = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "admin-powers-sim-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.init();
  const notifier = { notify: async () => {}, canReachDm: async () => true };
  const service = new TaskService(store, notifier, new SseHub(), config);
  return service;
};

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

/* Refused, and refused for the reason we mean. Matching the message matters
   here: "task not found" or a flow-legality refusal would otherwise satisfy
   every one of these checks without the admin strip having done anything. */
const refused = async (fn, expected, message) => {
  await assert.rejects(fn, (err) => {
    assert.match(err.message, expected, message ?? "refused for the stated reason");
    return true;
  });
};

/* A CLAIMED standard task with a creator and a separate assignee — the admin is
   neither. */
const claimedTask = async (service, overrides = {}) => {
  const task = await service.createTask(
    { folderName: "Admin Powers Sim", taskType: "VALUE", notes: "n", ...overrides },
    CREATOR
  );
  return service.claimTask(task.id, WORKER);
};

/* A FRAUD task in the given status, worked by CHECKER (never the admin). */
const fraudTask = async (service, status) => {
  const created = await service.createTask({ folderName: "Fraud Sim", taskType: "FRAUD", notes: "n" }, CREATOR);
  let task = await service.claimTask(created.id, CHECKER);
  if (status === "CLAIMED") {
    return task;
  }
  task = await service.transitionStatus(task.id, "AWAITING_ITEMS", CHECKER, "please gather these");
  if (status === "AWAITING_ITEMS") {
    return task;
  }
  return service.transitionStatus(task.id, "PENDING_APPROVAL", CREATOR);
};

console.log("Admin is back-end access only (ADR-0003) — TaskService sim");

await check("an admin cannot unclaim somebody else's task", async () => {
  const service = await setup();
  const task = await claimedTask(service);
  await refused(() => service.unclaimTask(task.id, ADMIN), /only the assignee/i);
  assert.equal((await service.getTask(task.id)).assignee.id, WORKER.id, "the assignee is untouched");
});

await check("an admin cannot cancel somebody else's task", async () => {
  const service = await setup();
  const task = await claimedTask(service);
  await refused(() => service.transitionStatus(task.id, "CANCELLED", ADMIN), /only the task creator can cancel/i);
  assert.equal((await service.getTask(task.id)).status, "CLAIMED");
});

await check("an admin cannot complete somebody else's task", async () => {
  const service = await setup();
  const task = await claimedTask(service);
  await refused(() => service.transitionStatus(task.id, "COMPLETED", ADMIN), /cannot complete/i);
  assert.equal((await service.getTask(task.id)).status, "CLAIMED");
});

await check("an admin cannot move a needs-review task back out of it", async () => {
  const service = await setup();
  // The corrections state is LOI-only and the assignee's to enter (ADR-0007).
  const task = await claimedTask(service, { taskType: "LOI" });
  await service.transitionStatus(task.id, "NEEDS_REVIEW", WORKER, "wrong loan amount");
  await refused(() => service.transitionStatus(task.id, "CLAIMED", ADMIN), /only the task creator/i);
  assert.equal((await service.getTask(task.id)).status, "NEEDS_REVIEW");
});

await check("an admin cannot restore somebody else's reopened task", async () => {
  const service = await setup();
  const task = await claimedTask(service);
  await service.transitionStatus(task.id, "COMPLETED", WORKER);
  // Reopening leaves the breadcrumb Restore reads, so COMPLETED is now the
  // restore target rather than an ordinary forward move.
  await service.transitionStatus(task.id, "OPEN", CREATOR);
  await refused(() => service.transitionStatus(task.id, "COMPLETED", ADMIN), /restore a reopened task/i);
});

await check("an admin cannot undo somebody else's merge-done", async () => {
  const service = await setup();
  const task = await claimedTask(service, { taskType: "LOAN_DOCS" });
  await service.transitionStatus(task.id, "MERGE_DONE", WORKER);
  await refused(() => service.transitionStatus(task.id, "CLAIMED", ADMIN), /undo merge done/i);
  assert.equal((await service.getTask(task.id)).status, "MERGE_DONE");
});

await check("an admin cannot act as the fraud checker on somebody else's check", async () => {
  const service = await setup();
  const task = await fraudTask(service, "CLAIMED");
  await refused(() => service.transitionStatus(task.id, "AWAITING_ITEMS", ADMIN, "items"), /send outstanding items/i, "sending items is the checker's move");
  const pending = await fraudTask(service, "PENDING_APPROVAL");
  await refused(() => service.transitionStatus(pending.id, "AWAITING_ITEMS", ADMIN, "more please"), /send outstanding items/i, "so is sending it back");
  await refused(() => service.transitionStatus(pending.id, "COMPLETED", ADMIN), /cannot complete/i, "and so is approving it");
});

await check("an admin cannot submit the requester's items for approval", async () => {
  const service = await setup();
  const task = await fraudTask(service, "AWAITING_ITEMS");
  await refused(() => service.transitionStatus(task.id, "PENDING_APPROVAL", ADMIN), /submit for approval/i);
  assert.equal((await service.getTask(task.id)).status, "AWAITING_ITEMS");
});

await check("an admin cannot release somebody else's fraud check for any checker", async () => {
  const service = await setup();
  const task = await fraudTask(service, "PENDING_APPROVAL");
  await refused(() => service.releaseForAnyChecker(task.id, ADMIN), /only the task creator/i);
  assert.equal((await service.getTask(task.id)).assignee.id, CHECKER.id, "the checker still holds it");
});

await check("an admin cannot add a note to a task they are not part of", async () => {
  const service = await setup();
  const task = await claimedTask(service);
  await refused(() => service.addReviewNote(task.id, "a thought", ADMIN), /creator or assignee/i);
  await service.transitionStatus(task.id, "COMPLETED", WORKER);
  await refused(() => service.addCompletedNote(task.id, "a later thought", ADMIN), /creator or assignee/i, "and not once it's completed either");
  assert.equal((await service.getTask(task.id)).reviewNotes ?? undefined, undefined, "nothing was recorded");
});

await check("an admin cannot edit somebody else's poop points, and the refusal says why", async () => {
  const service = await setup();
  const task = await claimedTask(service);
  await assert.rejects(
    () => service.updateTaskPoints(task.id, 5, ADMIN),
    (err) => {
      assert.match(err.message, /creator/i, "the message names the rule it enforces");
      return true;
    }
  );
  assert.equal((await service.getTask(task.id)).points, task.points, "the points are unchanged");
});

await check("an admin can still hand a stuck task to someone else — handoff is open to everyone", async () => {
  const service = await setup();
  const task = await claimedTask(service);
  const updated = await service.assignTask({ taskId: task.id, target: CHECKER, actor: ADMIN });
  assert.equal(updated.assignee.id, CHECKER.id, "the recipient took it");
  assert.equal(updated.status, "CLAIMED", "in place, status untouched");
});

console.log(`\n${passed} checks passed`);
