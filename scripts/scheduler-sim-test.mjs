#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";

import { TaskStore } from "../apps/server/dist/store.js";
import { TaskService } from "../apps/server/dist/task-service.js";
import { SseHub } from "../apps/server/dist/sse.js";
import { computeDueAtFromReturnDate, canCompleteTask } from "../packages/shared/dist/workflow.js";
import { SYSTEM_ACTOR, isSystemActor } from "../packages/shared/dist/types.js";

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

/* Friday 2026-02-13. 09:00 PT is inside the real 8:30-17:30 window and 08:00 PT
   is before it opens — the two checks about the reminder window are the reason
   this suite states an instant at all rather than reading the wall clock. */
const IN_HOURS = new Date("2026-02-13T17:00:00.000Z");
const OUT_OF_HOURS = new Date("2026-02-13T16:00:00.000Z");

// `now` is the ISO stamp the task is filed at — every check states the instant
// it is reasoning from, and hands the same one to `runMaintenance`.
const makeTask = (now, overrides = {}) => {
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

    {
      const now = IN_HOURS;
      const overdue = makeTask(now.toISOString(), {
        dueAt: "2026-02-13T15:00:00.000Z",
        status: "CLAIMED"
      });

      const { service, store, notifier } = await bootService([overdue]);
      const output = await service.runMaintenance(now);

      assert.equal(output.reminded, 1);
      assert.equal(output.autoArchived, 0);
      assert.equal(output.purged, 0);
      const tasks = await store.allTasks();
      assert.ok(tasks[0].lastReminderAt, "lastReminderAt should be set");
      assert.equal(notifier.events.filter((e) => e.type === "TASK_REMINDER").length, 1);
      pass("overdue task is reminded during business hours");
    }

    {
      const now = OUT_OF_HOURS;
      const overdue = makeTask(now.toISOString(), {
        dueAt: "2026-02-13T15:00:00.000Z",
        status: "CLAIMED"
      });

      const { service, store } = await bootService([overdue]);
      const output = await service.runMaintenance(now);

      assert.equal(output.reminded, 0);
      const tasks = await store.allTasks();
      assert.equal(tasks[0].lastReminderAt, undefined);
      pass("no reminder sent outside business hours");
    }

    {
      const now = IN_HOURS;
      const throttled = makeTask(now.toISOString(), {
        dueAt: "2026-02-13T15:00:00.000Z",
        status: "CLAIMED",
        lastReminderAt: "2026-02-13T16:30:00.000Z"
      });

      const { service } = await bootService([throttled]);
      const output = await service.runMaintenance(now);

      assert.equal(output.reminded, 0);
      pass("hourly reminder throttle is enforced");
    }

    {
      const now = IN_HOURS;
      const staleCompleted = makeTask(now.toISOString(), {
        status: "COMPLETED",
        completedAt: "2026-01-20T10:00:00.000Z",
        assignee: { id: "assignee", displayName: "Assignee" }
      });

      const { service, store } = await bootService([staleCompleted]);
      const output = await service.runMaintenance(now);

      assert.equal(output.autoArchived, 1);
      const tasks = await store.allTasks();
      assert.equal(tasks[0].status, "ARCHIVED");
      assert.ok(tasks[0].archivedAt, "archivedAt should be set");
      pass("completed tasks older than 14 days are auto-archived");
    }

    {
      const now = IN_HOURS;
      const staleArchived = makeTask(now.toISOString(), {
        status: "ARCHIVED",
        archivedAt: "2025-10-01T10:00:00.000Z"
      });
      const recentArchived = makeTask(now.toISOString(), {
        status: "ARCHIVED",
        archivedAt: "2026-01-20T10:00:00.000Z"
      });

      const { service, store } = await bootService([staleArchived, recentArchived]);
      const output = await service.runMaintenance(now);

      assert.equal(output.purged, 1);
      const tasks = await store.allTasks();
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].id, recentArchived.id);
      pass("archive retention purge removes only records older than 90 days");
    }

    {
      const now = IN_HOURS;
      const ooo = makeTask(now.toISOString(), {
        taskType: "OOO",
        dueAt: "2026-02-13T16:59:00.000Z",
        status: "OPEN",
        assignee: undefined
      });

      const { service, store, notifier } = await bootService([ooo]);
      const output = await service.runMaintenance(now);

      assert.equal(output.reminded, 0);
      const tasks = await store.allTasks();
      assert.equal(tasks[0].status, "COMPLETED");
      assert.ok(tasks[0].completedAt, "completedAt should be set");
      // In-app event, the "welcome back" DM, and the silent DM card sync that
      // retires the Complete button on the participants' existing cards.
      assert.deepEqual(
        notifier.events.filter((e) => e.type === "TASK_STATUS_CHANGED").map((e) => e.target),
        ["IN_APP", "DM", "DM_CARD_SYNC"]
      );
      const history = await store.allHistoryForTask(ooo.id);
      const autoComplete = history.find((e) => e.detail === "AUTO_COMPLETED_RETURN_DATE");
      assert.ok(autoComplete, "the auto-completion is recorded in history");
      assert.ok(isSystemActor(autoComplete.by), "recorded against the SYSTEM actor, not a borrowed ADMIN");
      pass("ooo task auto-completes at return-date due time, driven by SYSTEM");

      /* Every stamp the pass writes comes off the instant it was handed, not
         off a fresh read of the wall clock. A half-injected pass would let
         these drift while the decisions above stayed frozen. */
      assert.equal(tasks[0].completedAt, now.toISOString(), "completedAt is the injected instant");
      assert.equal(tasks[0].updatedAt, now.toISOString(), "updatedAt is the injected instant");
      assert.equal(autoComplete.at, now.toISOString(), "the history event is stamped with the injected instant");
      assert.deepEqual(
        [...new Set(notifier.events.map((e) => e.createdAt))],
        [now.toISOString()],
        "every notification the pass sends is stamped with the injected instant"
      );
      pass("maintenance stamps come from the injected instant, not the wall clock");
    }

    /* SYSTEM carries no roles at all — it gets past the actor gates on the
       strength of its id, so stripping ADMIN's workflow powers (#143) can't
       take OOO auto-completion down with it. */
    assert.deepEqual(SYSTEM_ACTOR.roles, [], "SYSTEM holds no roles");
    {
      const now = IN_HOURS;
      const fraud = makeTask(now.toISOString(), { taskType: "FRAUD", status: "CLAIMED" });
      const strangerWithRole = { id: "nobody", displayName: "Nobody", roles: ["FILE_CHECKER"] };
      assert.ok(canCompleteTask(fraud, SYSTEM_ACTOR), "SYSTEM passes the actor gate it holds no role or seat for");
      assert.ok(!canCompleteTask(fraud, strangerWithRole), "a human who is neither party still cannot");
      const closed = makeTask(now.toISOString(), { status: "ARCHIVED" });
      assert.ok(!canCompleteTask(closed, SYSTEM_ACTOR), "SYSTEM still cannot make a move the flow disallows");
      pass("SYSTEM bypasses actor gates but not flow legality");
    }

    {
      const now = IN_HOURS;
      const alreadyCompletedOoo = makeTask(now.toISOString(), {
        taskType: "OOO",
        dueAt: "2026-02-13T16:00:00.000Z",
        status: "COMPLETED",
        completedAt: "2026-02-13T16:00:00.000Z"
      });

      const { service, store } = await bootService([alreadyCompletedOoo]);
      const output = await service.runMaintenance(now);

      assert.equal(output.reminded, 0);
      const tasks = await store.allTasks();
      assert.equal(tasks[0].status, "COMPLETED");
      pass("closed ooo tasks are not auto-completed again");
    }
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
