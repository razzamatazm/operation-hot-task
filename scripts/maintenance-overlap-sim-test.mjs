#!/usr/bin/env node
/*
 * A maintenance pass overlapping other task saves (#385).
 *
 * `runMaintenance` used to read every task, walk the list awaiting each
 * notification, then write the list it read back over the whole store. Anything
 * saved in that gap was lost: an edit reverted, a new task vanished, a task
 * completed meanwhile got reminded on its stale state and written back open.
 *
 * Each check here pauses the pass inside a reminder send, with a notifier the
 * test releases by hand (never a timer), saves something in that gap, then lets
 * the pass finish and looks at what survived.
 *
 * Run: `node --test scripts/maintenance-overlap-sim-test.mjs`.
 */
import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { SseHub } from "../apps/server/dist/sse.js";
import { TaskStore } from "../apps/server/dist/store.js";
import { TaskService } from "../apps/server/dist/task-service.js";

const config = {
  businessTimezone: "America/Los_Angeles",
  businessStartHour: 8,
  businessStartMinute: 30,
  businessEndHour: 17,
  businessEndMinute: 30,
  archiveRetentionDays: 90
};

const CREATOR = { id: "creator-1", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] };
const CHECKER = { id: "checker-1", displayName: "Casey Checker", roles: ["FILE_CHECKER"] };

/* Friday 2026-02-13 09:00 in Los Angeles: inside business hours, so reminders
   are due whenever the suite runs (#204). */
const NOW = new Date("2026-02-13T17:00:00.000Z");
const hoursBefore = (hours) => new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
const hoursAfter = (hours) => new Date(NOW.getTime() + hours * 60 * 60 * 1000).toISOString();

const root = mkdtempSync(path.join(os.tmpdir(), "maintenance-overlap-"));
after(() => rmSync(root, { recursive: true, force: true }));
let dirs = 0;

const gate = () => {
  let open;
  const opened = new Promise((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
};

const claimedTask = ({ id, folderName, dueAt, updatedAt }) => ({
  id,
  folderName,
  loanName: folderName,
  taskType: "VALUE",
  dueAt,
  urgency: "RED",
  points: 1,
  notes: `${folderName} notes`,
  status: "CLAIMED",
  createdAt: hoursBefore(8),
  updatedAt,
  claimedAt: updatedAt,
  createdBy: { id: CREATOR.id, displayName: CREATOR.displayName },
  assignee: { id: CHECKER.id, displayName: CHECKER.displayName }
});

/* Three claimed tasks. The pass reads newest-updated first, so it reaches
   "first-overdue" before "second-overdue": both are overdue and owed a
   reminder. "not-due" is due tomorrow, so the pass has nothing to do to it.

   The notifier holds the pass inside the first reminder send until the test
   releases it. `paused` resolves once the pass is sitting there. */
const pausedPass = async () => {
  dirs += 1;
  const dir = path.join(root, String(dirs));
  fs.mkdirSync(dir);
  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.init();
  await store.replaceTasks([
    claimedTask({ id: "first-overdue", folderName: "First Overdue", dueAt: hoursBefore(6), updatedAt: hoursBefore(5) }),
    claimedTask({ id: "second-overdue", folderName: "Second Overdue", dueAt: hoursBefore(6), updatedAt: hoursBefore(7) }),
    claimedTask({ id: "not-due", folderName: "Not Due", dueAt: hoursAfter(24), updatedAt: hoursBefore(6) })
  ]);

  const paused = gate();
  const release = gate();
  const events = [];
  const notifier = {
    notify: async (event) => {
      events.push(event);
      if (event.type === "TASK_REMINDER" && event.task.id === "first-overdue") {
        paused.open();
        await release.opened;
      }
    },
    canReachDm: async () => true
  };
  const service = new TaskService(store, notifier, new SseHub(), config);

  const pass = service.runMaintenance(NOW);
  await paused.opened;

  return {
    store,
    service,
    events,
    /* Let the pass go and wait for it, and for any fan-out the gap's own saves
       queued, so every notification is on the record. */
    finish: async () => {
      release.open();
      const result = await pass;
      await service.settleBackgroundWork();
      return result;
    }
  };
};

const remindersFor = (events, taskId) =>
  events.filter((event) => event.type === "TASK_REMINDER" && event.task.id === taskId);

test("an edit to another task saved while the pass is paused survives the pass", async () => {
  const { store, service, finish } = await pausedPass();

  await service.updateTaskNotes("not-due", "Edited mid-pass", CREATOR);
  await finish();

  assert.equal((await store.findTask("not-due"))?.notes, "Edited mid-pass", "the edit was not reverted");
});

test("a task filed while the pass is paused still exists after the pass", async () => {
  const { store, service, finish } = await pausedPass();

  const filed = await service.createTask({ folderName: "Filed Mid-Pass", taskType: "VALUE", notes: "n" }, CREATOR);
  await finish();

  assert.ok(await store.findTask(filed.id), "the new task was not deleted");
});

test("a task completed while the pass is paused stays completed and is not reminded", async () => {
  const { store, service, events, finish } = await pausedPass();

  await service.transitionStatus("second-overdue", "COMPLETED", CHECKER);
  const result = await finish();

  const task = await store.findTask("second-overdue");
  assert.equal(task?.status, "COMPLETED", "the completion was not written over");
  assert.equal(task?.lastReminderAt, undefined, "no reminder stamp landed on it");
  assert.equal(remindersFor(events, "second-overdue").length, 0, "no reminder went out for it");
  assert.equal(remindersFor(events, "first-overdue").length, 1, "the task that still qualified was reminded");
  assert.equal(result.reminded, 1, "`reminded` counts only the reminder that was written");
});

test("a task deleted while the pass is paused is skipped, not brought back", async () => {
  const { store, events, finish } = await pausedPass();

  await store.removeTasks(["second-overdue"]);
  const result = await finish();

  assert.equal(await store.findTask("second-overdue"), undefined, "the deleted task stayed deleted");
  assert.equal(remindersFor(events, "second-overdue").length, 0, "no reminder went out for it");
  assert.equal(result.reminded, 1);
});
