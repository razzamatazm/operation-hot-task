#!/usr/bin/env node
/*
 * Issue #232 — a clean LOI check tells the requester it was clean.
 *
 * On a completed LOI the requester's DM reads `LOI Check - Good to go!
 * (<folder>)`; every other type keeps `Done and dusted 🎉` verbatim and the
 * merge steps are untouched. Why, in `completionDmMessage`
 * (packages/shared/src/types.ts).
 *
 * Drives the real TaskService against a real (temp-file) TaskStore with a mock
 * notifier, so the assertions are on the events the server actually emits.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TaskStore } from "../apps/server/dist/store.js";
import { SseHub } from "../apps/server/dist/sse.js";
import { TaskService } from "../apps/server/dist/task-service.js";
import { flowFor } from "../packages/shared/dist/workflow.js";
import { COMPLETION_DM_MESSAGE_DEFAULT, TASK_TYPE_LABELS, completionDmMessage, formatLifecycleDmText } from "../packages/shared/dist/types.js";

const config = {
  businessTimezone: "America/Los_Angeles",
  businessStartHour: 8,
  businessStartMinute: 30,
  businessEndHour: 17,
  businessEndMinute: 30,
  archiveRetentionDays: 90
};

const CREATOR = { id: "creator-1", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] };
const ASSIGNEE = { id: "assignee-1", displayName: "Sam Solver", roles: ["LOAN_OFFICER", "FILE_CHECKER"] };

const FOLDER = "Smith-1042";

const setup = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clean-loi-dm-sim-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.init();
  const events = [];
  const notifier = { notify: async (event) => { events.push(event); } };
  const service = new TaskService(store, notifier, new SseHub(), config);
  return { service, events };
};

/* Create a task and walk its type-specific flow all the way to COMPLETED.
   LOAN_DOCS travels the longer MERGE_DONE → MERGE_APPROVED path, and each
   merge rung has its own seat (#173), so the approval step is driven by the
   creator rather than the assignee. FRAUD travels its own two-phase flow where
   the requester is the one who submits the outstanding items back. */
const completeTask = async (service, taskType) => {
  const isoDay = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
  const oooDates = taskType === "OOO" ? { startDate: isoDay(1), returnDate: isoDay(3) } : {};
  const task = await service.createTask({ folderName: FOLDER, taskType, notes: "n", ...oooDates }, CREATOR);
  await service.claimTask(task.id, ASSIGNEE);
  const flow = flowFor(task).filter((s) => s !== "ARCHIVED");
  for (let i = flow.indexOf("CLAIMED") + 1; i < flow.length; i += 1) {
    const step = flow[i];
    const actor = step === "MERGE_APPROVED" || step === "PENDING_APPROVAL" ? CREATOR : ASSIGNEE;
    // Sending outstanding items needs something to send.
    const note = step === "AWAITING_ITEMS" ? "missing paystub" : undefined;
    await service.transitionStatus(task.id, step, actor, note);
  }
  // The status fan-out runs in the background per task (#204), so the events
  // aren't on the mock notifier until it settles.
  await service.settleBackgroundWork();
  return task;
};

const dmsFor = (events, status) =>
  events.filter((e) => e.target === "DM" && e.task.status === status);

const run = async () => {
  // 1. A completed LOI tells the requester the check came back clean.
  {
    const { service, events } = await setup();
    await completeTask(service, "LOI");
    const dms = dmsFor(events, "COMPLETED");
    assert.equal(dms.length, 1, "one completion DM");
    assert.equal(dms[0].message, "Good to go!");
    assert.deepEqual(dms[0].recipientUserIds, [CREATOR.id], "the requester is the recipient");

    // The reader-facing string, composed the way notifications.ts composes it.
    assert.equal(
      formatLifecycleDmText({
        typeLabel: TASK_TYPE_LABELS[dms[0].task.taskType],
        message: dms[0].message,
        folderName: dms[0].task.folderName
      }),
      `LOI Check - Good to go! (${FOLDER})`
    );
  }

  // 2. Every other task type keeps today's message, unchanged.
  for (const taskType of ["VALUE", "BUDDY_CHAT", "FRAUD", "LOAN_DOCS", "OOO"]) {
    const { service, events } = await setup();
    await completeTask(service, taskType);
    const dms = dmsFor(events, "COMPLETED");
    assert.equal(dms.length, 1, `one completion DM for ${taskType}`);
    assert.equal(dms[0].message, COMPLETION_DM_MESSAGE_DEFAULT, `${taskType} completion DM unchanged`);
    assert.deepEqual(dms[0].recipientUserIds, [CREATOR.id], `${taskType} requester is the recipient`);
  }

  // 3. The MERGE_DONE message is untouched.
  {
    const { service, events } = await setup();
    await completeTask(service, "LOAN_DOCS");
    const merge = dmsFor(events, "MERGE_DONE");
    assert.equal(merge.length, 1, "one merge-done DM");
    assert.equal(merge[0].message, "Merge done — almost home");
  }

  // 4. Nothing new is posted to the channel, and nobody new is notified.
  {
    const loi = await setup();
    await completeTask(loi.service, "LOI");
    const value = await setup();
    await completeTask(value.service, "VALUE");
    const shape = (events) => events.map((e) => `${e.target}:${e.task.status}`);
    assert.deepEqual(shape(loi.events), shape(value.events), "same notification shape as any other type");
  }

  // 5. Closing an LOI out of corrections reads differently, and goes the other
  //     way. The creator closes a task they've just fixed themselves
  //     (NEEDS_REVIEW → COMPLETED, ADR-0007), so the per-type "clean check"
  //     wording would be the wrong news for the wrong reader: #239 gives that
  //     closure its own "closed after corrections" line and sends it to the
  //     assignee, who is the one who didn't press the button.
  {
    const { service, events } = await setup();
    const task = await service.createTask({ folderName: FOLDER, taskType: "LOI", notes: "n" }, CREATOR);
    await service.claimTask(task.id, ASSIGNEE);
    await service.transitionStatus(task.id, "NEEDS_REVIEW", ASSIGNEE, "wrong contact on the term sheet");
    await service.transitionStatus(task.id, "COMPLETED", CREATOR);
    await service.settleBackgroundWork();
    const dms = dmsFor(events, "COMPLETED");
    assert.equal(dms.length, 1, "one completion DM out of corrections");
    assert.equal(dms[0].message, `${CREATOR.displayName} closed ${FOLDER} after corrections — nothing more needed from you`);
    assert.deepEqual(dms[0].recipientUserIds, [ASSIGNEE.id], "the party who did not close it");
  }

  // 6. The rule lives in shared, and it is per-type rather than per-string.
  {
    assert.equal(completionDmMessage("LOI"), "Good to go!");
    for (const taskType of ["VALUE", "BUDDY_CHAT", "FRAUD", "LOAN_DOCS", "OOO"]) {
      assert.equal(completionDmMessage(taskType), COMPLETION_DM_MESSAGE_DEFAULT);
    }
  }

  console.log("clean-loi-dm-sim-test: OK");
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
