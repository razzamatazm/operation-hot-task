#!/usr/bin/env node
/*
 * The LOAN_DOCS merge seat (#173).
 *
 * `canTransitionStatus` guarded every other move — cancel, needs-review, the
 * fraud moves, complete, undo-merge-done — and had no clause at all for
 * MERGE_DONE or MERGE_APPROVED, so both fell through to `{ ok: true }` for
 * anybody. The creator's chat card offered them Merge Done, and the server
 * would have taken the tap.
 *
 * Each merge rung belongs to one named person: the assignee did the merge, the
 * creator signs it off. This drives the real TaskService against a real
 * (temp-file) store, plus the bot's note card, which asks the same predicate.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SYSTEM_ACTOR } from "../packages/shared/dist/types.js";
import { canApproveMerge, canMarkMergeDone } from "../packages/shared/dist/workflow.js";
import { TaskStore } from "../apps/server/dist/store.js";
import { SseHub } from "../apps/server/dist/sse.js";
import { TaskService } from "../apps/server/dist/task-service.js";
import { noteCardDataFromTask } from "../apps/server/dist/bot.js";

const config = {
  businessTimezone: "America/Los_Angeles",
  businessStartHour: 8,
  businessStartMinute: 30,
  businessEndHour: 17,
  businessEndMinute: 30,
  archiveRetentionDays: 90
};

const CREATOR = { id: "creator-1", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] };
const WORKER = { id: "worker-1", displayName: "Sam Officer", roles: ["LOAN_OFFICER"] };
/* Deliberately an admin who is a party to nothing: admin is back-end access
   only (ADR-0003), so it buys no seat on either rung. */
const ADMIN = { id: "admin-1", displayName: "Avery Admin", roles: ["LOAN_OFFICER", "FILE_CHECKER", "ADMIN"] };

const setup = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "merge-seat-sim-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.init();
  const notifier = { notify: async () => {}, canReachDm: async () => true };
  return new TaskService(store, notifier, new SseHub(), config);
};

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

/* Refused, and refused for the reason we mean — a flow-legality refusal or a
   missing task would otherwise satisfy these without any seat check running. */
const refused = async (fn, expected, message) => {
  await assert.rejects(fn, (err) => {
    assert.match(err.message, expected, message ?? "refused for the stated reason");
    return true;
  });
};

/* A LOAN_DOCS task created by CREATOR and claimed by WORKER. */
const claimed = async (service) => {
  const task = await service.createTask(
    { folderName: "Merge Seat Sim", taskType: "LOAN_DOCS", notes: "n" },
    CREATOR
  );
  return service.claimTask(task.id, WORKER);
};

const mergeDone = async (service) => {
  const task = await claimed(service);
  return service.transitionStatus(task.id, "MERGE_DONE", WORKER);
};

console.log("The LOAN_DOCS merge seat (#173) — TaskService sim");

await check("the creator cannot mark the merge done", async () => {
  const service = await setup();
  const task = await claimed(service);
  await refused(() => service.transitionStatus(task.id, "MERGE_DONE", CREATOR), /only the assignee can mark the merge done/i);
  assert.equal((await service.getTask(task.id)).status, "CLAIMED", "the task did not move");
});

await check("the assignee cannot approve their own merge", async () => {
  const service = await setup();
  const task = await mergeDone(service);
  await refused(() => service.transitionStatus(task.id, "MERGE_APPROVED", WORKER), /only the task creator can approve the merge/i);
  assert.equal((await service.getTask(task.id)).status, "MERGE_DONE", "the task did not move");
});

await check("an admin cannot mark somebody else's merge done", async () => {
  const service = await setup();
  const task = await claimed(service);
  await refused(() => service.transitionStatus(task.id, "MERGE_DONE", ADMIN), /only the assignee can mark the merge done/i);
  assert.equal((await service.getTask(task.id)).status, "CLAIMED");
});

await check("an admin cannot approve somebody else's merge", async () => {
  const service = await setup();
  const task = await mergeDone(service);
  await refused(() => service.transitionStatus(task.id, "MERGE_APPROVED", ADMIN), /only the task creator can approve the merge/i);
  assert.equal((await service.getTask(task.id)).status, "MERGE_DONE");
});

await check("the happy path still works: assignee marks done, creator approves, assignee completes", async () => {
  const service = await setup();
  const task = await claimed(service);
  const done = await service.transitionStatus(task.id, "MERGE_DONE", WORKER);
  assert.equal(done.status, "MERGE_DONE", "the assignee marked the merge done");
  const approved = await service.transitionStatus(task.id, "MERGE_APPROVED", CREATOR);
  assert.equal(approved.status, "MERGE_APPROVED", "the creator approved it");
  const completed = await service.transitionStatus(task.id, "COMPLETED", WORKER);
  assert.equal(completed.status, "COMPLETED", "the assignee closed it out");
});

await check("SYSTEM can still drive both rungs — the scheduler path is unaffected", async () => {
  const service = await setup();
  const task = await claimed(service);
  const done = await service.transitionStatus(task.id, "MERGE_DONE", SYSTEM_ACTOR);
  assert.equal(done.status, "MERGE_DONE");
  const approved = await service.transitionStatus(task.id, "MERGE_APPROVED", SYSTEM_ACTOR);
  assert.equal(approved.status, "MERGE_APPROVED");
});

await check("the creator's chat card offers no Merge Done button while the task is CLAIMED", async () => {
  const service = await setup();
  const task = await claimed(service);
  const forCreator = noteCardDataFromTask(task, CREATOR);
  assert.equal(forCreator.advance, undefined, "the creator is offered nothing to advance");
  const forWorker = noteCardDataFromTask(task, WORKER);
  assert.equal(forWorker.advance?.status, "MERGE_DONE", "the assignee still gets the button");
});

await check("and the approval card mirrors it: the creator's button, not the assignee's", async () => {
  const service = await setup();
  const task = await mergeDone(service);
  assert.equal(noteCardDataFromTask(task, WORKER).advance, undefined, "the assignee cannot approve their own merge");
  assert.equal(noteCardDataFromTask(task, CREATOR).advance?.status, "MERGE_APPROVED", "the creator can");
});

await check("the web and the bot read one predicate, not two copies of the rule", async () => {
  const service = await setup();
  const task = await claimed(service);
  assert.ok(canMarkMergeDone(task, WORKER), "assignee holds the merge-done seat");
  assert.ok(!canMarkMergeDone(task, CREATOR), "the creator does not");
  assert.ok(!canApproveMerge(task, CREATOR), "and nobody approves a merge that hasn't been done");
  const done = await service.transitionStatus(task.id, "MERGE_DONE", WORKER);
  assert.ok(canApproveMerge(done, CREATOR), "creator holds the approval seat");
  assert.ok(!canApproveMerge(done, WORKER), "the assignee does not");
  // Type-scoped: the merge rungs exist only on the LOAN_DOCS flow.
  const other = await service.createTask({ folderName: "Not Loan Docs", taskType: "VALUE", notes: "n" }, CREATOR);
  const otherClaimed = await service.claimTask(other.id, WORKER);
  assert.ok(!canMarkMergeDone(otherClaimed, WORKER), "a VALUE task has no merge seat to hold");
});

console.log(`\n${passed} checks passed`);
