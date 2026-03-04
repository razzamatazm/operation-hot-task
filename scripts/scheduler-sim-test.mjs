#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";

import { TaskStore } from "../apps/server/dist/store.js";
import { TaskService } from "../apps/server/dist/task-service.js";
import { SseHub } from "../apps/server/dist/sse.js";
import { computeDueAtFromReturnDate } from "../packages/shared/dist/workflow.js";

const appConfig = {
  businessTimezone: "America/Los_Angeles",
  businessStartHour: 8,
  businessStartMinute: 30,
  businessEndHour: 17,
  businessEndMinute: 30,
  archiveRetentionDays: 90
};

class CaptureNotifier {
  events = [];

  async notify(event) {
    this.events.push(event);
  }
}

const withFrozenTime = async (iso, fn) => {
  const fixedMs = new Date(iso).getTime();
  const RealDate = Date;

  class MockDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(fixedMs);
      } else {
        super(...args);
      }
    }

    static now() {
      return fixedMs;
    }
  }

  globalThis.Date = MockDate;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
};

const makeTask = (overrides = {}) => {
  const now = new Date().toISOString();
  return {
    id: uuid(),
    folderName: "Scheduler Test",
    loanName: "Scheduler Test",
    taskType: "LOI",
    dueAt: now,
    urgency: "GREEN",
    notes: "scheduler-test",
    status: "CLAIMED",
    createdAt: now,
    updatedAt: now,
    createdBy: { id: "creator", displayName: "Creator" },
    assignee: { id: "assignee", displayName: "Assignee" },
    ...overrides
  };
};

const bootService = async (initialTasks) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loan-scheduler-"));
  const dataFile = path.join(tempDir, "tasks.json");
  const notifier = new CaptureNotifier();
  const store = new TaskStore(dataFile);
  await store.init();
  await store.replaceTasks(initialTasks);

  const service = new TaskService(store, notifier, new SseHub(), appConfig);
  return { service, store, notifier };
};

const run = async () => {
  const results = [];
  const pass = (m) => results.push(`PASS ${m}`);
  const fail = (m) => results.push(`FAIL ${m}`);

  try {
    const januaryDue = computeDueAtFromReturnDate("2026-01-15", appConfig);
    assert.equal(januaryDue, "2026-01-15T16:30:00.000Z");
    const julyDue = computeDueAtFromReturnDate("2026-07-15", appConfig);
    assert.equal(julyDue, "2026-07-15T15:30:00.000Z");
    pass("return date conversion respects PT DST offsets");

    await withFrozenTime("2026-02-13T17:00:00.000Z", async () => {
      const overdue = makeTask({
        dueAt: "2026-02-13T15:00:00.000Z",
        status: "CLAIMED"
      });

      const { service, store, notifier } = await bootService([overdue]);
      const output = await service.runMaintenance();

      assert.equal(output.reminded, 1);
      assert.equal(output.autoArchived, 0);
      assert.equal(output.purged, 0);
      const tasks = await store.allTasks();
      assert.ok(tasks[0].lastReminderAt, "lastReminderAt should be set");
      assert.equal(notifier.events.filter((e) => e.type === "TASK_REMINDER").length, 1);
      pass("overdue task is reminded during business hours");
    });

    await withFrozenTime("2026-02-13T16:00:00.000Z", async () => {
      const overdue = makeTask({
        dueAt: "2026-02-13T15:00:00.000Z",
        status: "CLAIMED"
      });

      const { service, store } = await bootService([overdue]);
      const output = await service.runMaintenance();

      assert.equal(output.reminded, 0);
      const tasks = await store.allTasks();
      assert.equal(tasks[0].lastReminderAt, undefined);
      pass("no reminder sent outside business hours");
    });

    await withFrozenTime("2026-02-13T17:00:00.000Z", async () => {
      const throttled = makeTask({
        dueAt: "2026-02-13T15:00:00.000Z",
        status: "CLAIMED",
        lastReminderAt: "2026-02-13T16:30:00.000Z"
      });

      const { service } = await bootService([throttled]);
      const output = await service.runMaintenance();

      assert.equal(output.reminded, 0);
      pass("hourly reminder throttle is enforced");
    });

    await withFrozenTime("2026-02-13T17:00:00.000Z", async () => {
      const staleCompleted = makeTask({
        status: "COMPLETED",
        completedAt: "2026-01-20T10:00:00.000Z",
        assignee: { id: "assignee", displayName: "Assignee" }
      });

      const { service, store } = await bootService([staleCompleted]);
      const output = await service.runMaintenance();

      assert.equal(output.autoArchived, 1);
      const tasks = await store.allTasks();
      assert.equal(tasks[0].status, "ARCHIVED");
      assert.ok(tasks[0].archivedAt, "archivedAt should be set");
      pass("completed tasks older than 14 days are auto-archived");
    });

    await withFrozenTime("2026-02-13T17:00:00.000Z", async () => {
      const staleArchived = makeTask({
        status: "ARCHIVED",
        archivedAt: "2025-10-01T10:00:00.000Z"
      });
      const recentArchived = makeTask({
        status: "ARCHIVED",
        archivedAt: "2026-01-20T10:00:00.000Z"
      });

      const { service, store } = await bootService([staleArchived, recentArchived]);
      const output = await service.runMaintenance();

      assert.equal(output.purged, 1);
      const tasks = await store.allTasks();
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].id, recentArchived.id);
      pass("archive retention purge removes only records older than 90 days");
    });

    await withFrozenTime("2026-02-13T17:00:00.000Z", async () => {
      const ooo = makeTask({
        taskType: "OOO",
        dueAt: "2026-02-13T16:59:00.000Z",
        status: "OPEN",
        assignee: undefined
      });

      const { service, store, notifier } = await bootService([ooo]);
      const output = await service.runMaintenance();

      assert.equal(output.reminded, 0);
      const tasks = await store.allTasks();
      assert.equal(tasks[0].status, "COMPLETED");
      assert.ok(tasks[0].completedAt, "completedAt should be set");
      assert.equal(notifier.events.filter((e) => e.type === "TASK_STATUS_CHANGED").length, 2);
      pass("ooo task auto-completes at return-date due time");
    });

    await withFrozenTime("2026-02-13T17:00:00.000Z", async () => {
      const alreadyCompletedOoo = makeTask({
        taskType: "OOO",
        dueAt: "2026-02-13T16:00:00.000Z",
        status: "COMPLETED",
        completedAt: "2026-02-13T16:00:00.000Z"
      });

      const { service, store } = await bootService([alreadyCompletedOoo]);
      const output = await service.runMaintenance();

      assert.equal(output.reminded, 0);
      const tasks = await store.allTasks();
      assert.equal(tasks[0].status, "COMPLETED");
      pass("closed ooo tasks are not auto-completed again");
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const failed = results.filter((r) => r.startsWith("FAIL"));
  for (const line of results) {
    console.log(line);
  }
  console.log(`SUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length}`);

  if (failed.length > 0) {
    process.exit(1);
  }
};

run();
