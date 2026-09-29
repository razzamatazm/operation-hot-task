#!/usr/bin/env node
/*
 * Issue #453 — a claimed Out of Office task is a hold, not a job.
 *
 * Shared rules are tested directly; the service doors (end early, release,
 * handoff, maintenance) run against a real temp-file store.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  botAdvanceFor,
  botPrimaryAdvance,
  canAssignTaskTo,
  canCompleteTask,
  canEndOooEarly,
  handoffRefusal,
  isOverdue,
  isPoolNagDue,
  oooReturnCountdown,
  OOO_ENDED_EARLY_DETAIL
} from "../packages/shared/dist/index.js";
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

const CREATOR = { id: "creator-1", displayName: "Dana Away", roles: ["LOAN_OFFICER"] };
const COVER = { id: "cover-1", displayName: "Casey Cover", roles: ["FILE_CHECKER"] };
const OTHER = { id: "other-1", displayName: "Robin Other", roles: ["FILE_CHECKER"] };
const ADMIN = { id: "admin-1", displayName: "Ada Admin", roles: ["ADMIN"] };

const setup = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ooo-hold-sim-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.init();
  const events = [];
  const notifier = { notify: async (event) => { events.push(event); }, canReachDm: async () => true };
  const service = new TaskService(store, notifier, new SseHub(), config);
  return { service, store, events };
};

/* Far enough out that the task is still live whenever this runs. */
const OOO_INPUT = { folderName: "Beach", taskType: "OOO", notes: "n", startDate: "2099-06-01", returnDate: "2099-06-08" };

const makeOoo = async (service, { claimed = false } = {}) => {
  const task = await service.createTask(OOO_INPUT, CREATOR);
  return claimed ? service.claimTask(task.id, COVER) : task;
};

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

console.log("OOO hold — #453");

await check("claiming an OOO task leaves it CLAIMED with no forward step anywhere", async () => {
  const { service } = await setup();
  const claimed = await makeOoo(service, { claimed: true });
  assert.equal(claimed.status, "CLAIMED");
  assert.equal(botPrimaryAdvance(claimed), undefined, "the Teams card gets no step button");
  assert.equal(botAdvanceFor(claimed, COVER), undefined, "not even for the coverer");
  assert.equal(botAdvanceFor(claimed, CREATOR), undefined);
});

await check("a claimed VALUE task still offers Complete (non-OOO unchanged)", async () => {
  const { service } = await setup();
  const task = await service.createTask({ folderName: "Smith", taskType: "VALUE", notes: "n" }, CREATOR);
  const claimed = await service.claimTask(task.id, COVER);
  assert.equal(botPrimaryAdvance(claimed)?.status, "COMPLETED");
  assert.equal(canCompleteTask(claimed, CREATOR), false, "the creator still cannot complete other types");
});

await check("the countdown reads in calendar days in the business timezone", async () => {
  const task = { taskType: "OOO", returnDate: "2026-03-14" };
  // 2026-03-11 23:30 Pacific is still the 11th there, though the 12th in UTC.
  assert.equal(oooReturnCountdown(task, new Date("2026-03-11T23:30:00-07:00"), config), "Back in 3 days");
  assert.equal(oooReturnCountdown(task, new Date("2026-03-13T08:00:00-07:00"), config), "Back tomorrow");
  assert.equal(oooReturnCountdown(task, new Date("2026-03-14T00:05:00-07:00"), config), "Back today");
  assert.equal(oooReturnCountdown(task, new Date("2026-03-16T09:00:00-07:00"), config), "Back today", "never a negative count");
  assert.equal(oooReturnCountdown({ taskType: "VALUE", returnDate: "2026-03-14" }, new Date(), config), undefined);
  assert.equal(oooReturnCountdown({ taskType: "OOO" }, new Date(), config), undefined);
});

await check("an OOO task never reads as overdue, even past its return time", async () => {
  const task = { taskType: "OOO", status: "CLAIMED", dueAt: "2026-03-11T16:00:00.000Z" };
  assert.equal(isOverdue(task, new Date("2026-03-20T00:00:00.000Z")), false);
  assert.equal(isOverdue({ ...task, taskType: "VALUE" }, new Date("2026-03-20T00:00:00.000Z")), true);
});

await check("the creator can end an OPEN OOO task early; it lands COMPLETED with a named history row", async () => {
  const { service, store } = await setup();
  const task = await makeOoo(service);
  assert.equal(canEndOooEarly(task, CREATOR), true);
  const ended = await service.transitionStatus(task.id, "COMPLETED", CREATOR);
  assert.equal(ended.status, "COMPLETED");
  const history = await store.allHistoryForTask(task.id);
  const row = history.find((e) => e.action === "TASK_COMPLETED");
  assert.ok(row, "a completion row is written");
  assert.equal(row.by.id, CREATOR.id, "naming who ended it");
  assert.ok(row.detail.includes(OOO_ENDED_EARLY_DETAIL), "and marking it as ended before the return date");
  assert.notEqual(row.detail, "AUTO_COMPLETED_RETURN_DATE");
});

await check("the creator can end a CLAIMED OOO task early", async () => {
  const { service, store } = await setup();
  const task = await makeOoo(service, { claimed: true });
  assert.equal(canEndOooEarly(task, CREATOR), true);
  const ended = await service.transitionStatus(task.id, "COMPLETED", CREATOR);
  assert.equal(ended.status, "COMPLETED");
  const row = (await store.allHistoryForTask(task.id)).find((e) => e.action === "TASK_COMPLETED");
  assert.equal(row.by.id, CREATOR.id);
});

await check("the coverer can end it early with the same result", async () => {
  const { service, store } = await setup();
  const task = await makeOoo(service, { claimed: true });
  assert.equal(canEndOooEarly(task, COVER), true);
  const ended = await service.transitionStatus(task.id, "COMPLETED", COVER);
  assert.equal(ended.status, "COMPLETED");
  const row = (await store.allHistoryForTask(task.id)).find((e) => e.action === "TASK_COMPLETED");
  assert.equal(row.by.id, COVER.id);
  assert.ok(row.detail.includes(OOO_ENDED_EARLY_DETAIL));
});

await check("restoring a reopened OOO task is not recorded as an early end", async () => {
  const { service, store } = await setup();
  const task = await makeOoo(service, { claimed: true });
  await service.transitionStatus(task.id, "COMPLETED", COVER);
  const reopened = await service.transitionStatus(task.id, "OPEN", CREATOR);
  assert.equal(reopened.status, "CLAIMED");
  await service.transitionStatus(task.id, "COMPLETED", CREATOR);
  const rows = (await store.allHistoryForTask(task.id)).filter((e) => e.action === "TASK_COMPLETED");
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((e) => e.detail.includes(OOO_ENDED_EARLY_DETAIL)).length, 1, "only the first close was the early end");
});

await check("anyone else is refused the early end, on the server as well", async () => {
  const { service } = await setup();
  const open = await makeOoo(service);
  const claimed = await makeOoo(service, { claimed: true });
  for (const task of [open, claimed]) {
    for (const outsider of [OTHER, ADMIN]) {
      assert.equal(canEndOooEarly(task, outsider), false);
      await assert.rejects(service.transitionStatus(task.id, "COMPLETED", outsider));
    }
  }
});

await check("releasing a claimed OOO task returns it to the pool, and it is never nagged", async () => {
  const { service } = await setup();
  const task = await makeOoo(service, { claimed: true });
  const released = await service.unclaimTask(task.id, COVER);
  assert.equal(released.status, "OPEN");
  assert.equal(released.assignee, undefined);
  // A weekday mid-morning an hour on — any other type would be due a nag.
  const later = new Date(new Date(released.updatedAt).getTime() + 60 * 60_000);
  assert.equal(isPoolNagDue(released, later, { ...config, businessStartHour: 0, businessStartMinute: 0, businessEndHour: 23, businessEndMinute: 59 }), false);
  const reclaimed = await service.claimTask(task.id, OTHER);
  assert.equal(reclaimed.assignee.id, OTHER.id, "someone else can then claim it");
});

await check("handing a claimed OOO task to someone else is refused by the server", async () => {
  const { service } = await setup();
  const task = await makeOoo(service, { claimed: true });
  assert.equal(canAssignTaskTo(task, OTHER, CREATOR), false);
  assert.ok(handoffRefusal(task, OTHER, CREATOR));
  await assert.rejects(service.assignTask({ taskId: task.id, target: OTHER, actor: CREATOR }));
  await assert.rejects(service.assignTask({ taskId: task.id, target: OTHER, actor: COVER }));
});

await check("an OPEN OOO task can still be handed to a coverer", async () => {
  const { service } = await setup();
  const task = await makeOoo(service);
  assert.equal(canAssignTaskTo(task, COVER, CREATOR), true);
  const assigned = await service.assignTask({ taskId: task.id, target: COVER, actor: CREATOR });
  assert.equal(assigned.status, "CLAIMED");
});

await check("maintenance still auto-completes a claimed OOO task at its return date", async () => {
  const { service, store } = await setup();
  const task = await makeOoo(service, { claimed: true });
  const after = new Date(new Date(task.dueAt).getTime() + 60_000);
  await service.runMaintenance(after);
  const [stored] = await store.allTasks();
  assert.equal(stored.status, "COMPLETED");
  const history = await store.allHistoryForTask(task.id);
  assert.ok(history.some((e) => e.detail === "AUTO_COMPLETED_RETURN_DATE"));
});

console.log(`\n${passed} checks passed`);
