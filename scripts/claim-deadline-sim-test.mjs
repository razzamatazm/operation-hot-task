#!/usr/bin/env node
/*
 * Issue #181 — the deadline belongs to whoever currently holds the task.
 *
 * Two seams, both exercised against real code:
 *   - `computeClaimAnchoredDueAt` in packages/shared: a pure function, so the
 *     clamp is tested directly at every urgency with a controlled clock. The
 *     GREEN case is the one that matters most — a clamp that is not scoped to
 *     the claim's own business date collapses a 24-hour window into this
 *     afternoon, and nothing downstream would notice.
 *   - `TaskService` against a real (temp-file) store with an observing
 *     notifier, for the doors an assignee arrives through.
 *
 * Every service-level check runs inside `withFrozenTime` at a Wednesday
 * mid-morning, against the REAL 8:30-17:30 window. An earlier draft instead held
 * business hours wide open and read the wall clock, which made the suite a test
 * of what time of day it happened to run: `isWithinBusinessHours` rejects
 * Saturday and Sunday before it ever looks at the configured hours, so those
 * checks failed every weekend. Freezing the clock is what #192 did to the
 * fan-out sim for exactly this reason; the helper below is its shape.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  computeClaimAnchoredDueAt,
  computeDueAtFromUrgency,
  isDeadlineRecomputeExempt,
  isUnclaimedTooLong
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

const CREATOR = { id: "creator-1", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] };
const CHECKER = { id: "checker-1", displayName: "Casey Checker", roles: ["FILE_CHECKER"] };
const OTHER = { id: "checker-2", displayName: "Robin Second", roles: ["FILE_CHECKER"] };

/* A weekday, mid-morning Pacific, so the clamp tests are not accidentally
   sitting on a weekend or a DST boundary. 2026-03-11 is a Wednesday. */
const at = (hh, mm) => new Date(`2026-03-11T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00-07:00`);
const pacificParts = (iso) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  })
    .formatToParts(new Date(iso))
    .reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
const pacificClock = (iso) => {
  const p = pacificParts(iso);
  return `${p.hour}:${p.minute}`;
};
const pacificDate = (iso) => {
  const p = pacificParts(iso);
  return `${p.year}-${p.month}-${p.day}`;
};

/* Wednesday 2026-03-11, 10:00 Pacific — inside the real business window, well
   clear of open, close and the DST boundary, so a check that cares about any of
   them has to say so itself. */
const FROZEN_INSTANT = "2026-03-11T10:00:00-07:00";

/* Pin `new Date()` and `Date.now()` for the duration of `fn`. The service reads
   its own clock (see #204), so this is the only way to make a service-level
   deadline assertion mean the same thing on a Tuesday and on a Sunday. */
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

const setup = async (appConfig = config) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claim-deadline-sim-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.init();
  const events = [];
  const notifier = { notify: async (event) => { events.push(event); }, canReachDm: async () => true };
  const service = new TaskService(store, notifier, new SseHub(), appConfig);
  return { service, store, events };
};

// Rewind a task's clock so maintenance sees an aged task without faking time.
const backdate = async (store, taskId, patch) =>
  store.updateTask(taskId, (current) => ({ task: { ...current, ...patch } }));

const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

console.log("Claim-anchored deadlines — #181");

/* ---------------------------------------------------------------- the clamp */

await check("ORANGE claimed mid-morning is due one hour later, unclamped", async () => {
  const due = computeClaimAnchoredDueAt("ORANGE", at(10, 0), config);
  assert.equal(pacificClock(due), "11:00");
});

await check("ORANGE claimed 45 minutes before close is due at close", async () => {
  const due = computeClaimAnchoredDueAt("ORANGE", at(16, 45), config);
  assert.equal(pacificClock(due), "17:30", "the hour would overshoot close, so it clamps");
  assert.equal(pacificDate(due), "2026-03-11", "and it clamps to the claim's own date");
});

await check("GREEN is never collapsed into the claim day's close", async () => {
  const due = computeClaimAnchoredDueAt("GREEN", at(10, 0), config);
  assert.equal(pacificDate(due), "2026-03-12", "24 hours out lands tomorrow");
  assert.equal(pacificClock(due), "10:00", "and keeps its time of day");
  assert.equal(due, computeDueAtFromUrgency("GREEN", at(10, 0), config), "the clamp is a no-op for GREEN");
});

await check("YELLOW is left alone — end of day is already end of day", async () => {
  const due = computeClaimAnchoredDueAt("YELLOW", at(16, 45), config);
  assert.equal(pacificClock(due), "17:30");
  assert.equal(pacificDate(due), "2026-03-11", "not rolled to tomorrow by a late claim");
});

await check("RED gets a real fifteen-minute window, not a zero-length one", async () => {
  const claimedAt = at(10, 0);
  const due = computeClaimAnchoredDueAt("RED", claimedAt, config);
  assert.equal(pacificClock(due), "10:15");
  assert.ok(new Date(due) > claimedAt, "urgent still cannot mean already late");
  assert.equal(
    computeDueAtFromUrgency("RED", claimedAt, config),
    claimedAt.toISOString(),
    "creation-time RED is untouched — an unclaimed urgent task still sorts to the top"
  );
});

await check("RED's fifteen minutes survive a claim near close", async () => {
  const due = computeClaimAnchoredDueAt("RED", at(17, 25), config);
  assert.equal(pacificClock(due), "17:40", "the clamp does not get to shave it to five minutes");
});

await check("RED taken in the evening starts at the next open", async () => {
  const due = computeClaimAnchoredDueAt("RED", at(21, 0), config);
  assert.equal(pacificDate(due), "2026-03-12");
  assert.equal(pacificClock(due), "08:45");
});

await check("GREEN taken in the evening still gets its 24 hours, measured from open", async () => {
  const due = computeClaimAnchoredDueAt("GREEN", at(21, 0), config);
  assert.equal(pacificDate(due), "2026-03-13", "24h from the next open, not from 21:00");
  assert.equal(pacificClock(due), "08:30");
});

await check("OOO is the only flow exempt from the recompute", async () => {
  assert.equal(isDeadlineRecomputeExempt({ taskType: "OOO" }), true);
  assert.equal(isDeadlineRecomputeExempt({ taskType: "FRAUD" }), false);
  assert.equal(isDeadlineRecomputeExempt({ taskType: "VALUE" }), false);
});

/* ------------------------------------------------------------- the doors */

await check("claiming a task that sat in the pool restarts its hour", async () => withFrozenTime(FROZEN_INSTANT, async () => {
  const { service, store } = await setup();
  const task = await service.createTask(
    { folderName: "Sat In Pool", taskType: "VALUE", notes: "n", urgency: "ORANGE" },
    CREATOR
  );
  // 45 minutes in the pool: under the old rule this task is 15 minutes from
  // overdue at the moment it is claimed, which is the whole complaint.
  await backdate(store, task.id, { createdAt: minutesAgo(45), dueAt: new Date(Date.now() + 15 * 60_000).toISOString() });

  const claimed = await service.claimTask(task.id, CHECKER);
  const remainingMinutes = (new Date(claimed.dueAt).getTime() - Date.now()) / 60_000;
  assert.ok(remainingMinutes > 55 && remainingMinutes <= 60, `a full hour from the claim, got ${remainingMinutes}m`);
}));

await check("a stale reminder stamp does not survive the recompute", async () => withFrozenTime(FROZEN_INSTANT, async () => {
  const { service, store } = await setup();
  const task = await service.createTask({ folderName: "Stale Stamp", taskType: "VALUE", notes: "n", urgency: "ORANGE" }, CREATOR);
  await backdate(store, task.id, { lastReminderAt: minutesAgo(30) });
  const claimed = await service.claimTask(task.id, CHECKER);
  assert.equal(claimed.lastReminderAt, undefined, "the fresh clock gets a fresh reminder cadence");
}));

await check("a task taken after close starts its clock at the next business open", async () => {
  const evening = at(21, 0);
  const due = computeClaimAnchoredDueAt("ORANGE", evening, config);
  assert.ok(new Date(due) > evening, "you cannot pick up a task that is already late");
  assert.equal(pacificDate(due), "2026-03-12", "the clock starts tomorrow");
  assert.equal(pacificClock(due), "09:30", "an hour from the 08:30 open");
});

await check("a task taken before open waits for the day to start", async () => {
  const dawn = at(6, 30);
  const due = computeClaimAnchoredDueAt("ORANGE", dawn, config);
  assert.equal(pacificDate(due), "2026-03-11", "same day — the day just has not started yet");
  assert.equal(pacificClock(due), "09:30", "an hour from open, not an hour from 06:30");
});

await check("a Friday-evening claim lands on Monday, not Saturday", async () => {
  // 2026-03-13 is a Friday.
  const fridayNight = new Date("2026-03-13T20:00:00-07:00");
  const due = computeClaimAnchoredDueAt("ORANGE", fridayNight, config);
  assert.equal(pacificDate(due), "2026-03-16", "Monday");
  assert.equal(pacificClock(due), "09:30");
});

await check("the normal overdue reminder names the task, not the person", async () => withFrozenTime(FROZEN_INSTANT, async () => {
  const { service, store, events } = await setup();
  const task = await service.createTask({ folderName: "Ran Out", taskType: "VALUE", notes: "n", urgency: "ORANGE" }, CREATOR);
  await service.claimTask(task.id, CHECKER);
  await backdate(store, task.id, { dueAt: minutesAgo(5) });

  await service.settleBackgroundWork();
  events.length = 0;
  await service.runMaintenance();
  await service.settleBackgroundWork();
  const reminder = events.find((e) => e.target === "DM" && e.type === "TASK_REMINDER");
  assert.match(reminder.message, /^your time's up on Ran Out$/);
}));

await check("a handoff re-anchors the deadline to the new holder", async () => withFrozenTime(FROZEN_INSTANT, async () => {
  const { service, store } = await setup();
  const task = await service.createTask({ folderName: "Passed On", taskType: "VALUE", notes: "n", urgency: "ORANGE" }, CREATOR);
  await service.claimTask(task.id, CHECKER);
  // The first assignee burns most of their hour before passing it on.
  await backdate(store, task.id, { dueAt: new Date(Date.now() + 5 * 60_000).toISOString() });

  const handed = await service.assignTask({ taskId: task.id, target: OTHER, actor: CHECKER });
  const remainingMinutes = (new Date(handed.dueAt).getTime() - Date.now()) / 60_000;
  assert.ok(remainingMinutes > 55, `the recipient gets their own hour, got ${remainingMinutes}m`);
}));

await check("unclaiming and releasing leave the deadline alone", async () => withFrozenTime(FROZEN_INSTANT, async () => {
  const { service, store } = await setup();
  const task = await service.createTask({ folderName: "Handed Back", taskType: "VALUE", notes: "n", urgency: "ORANGE" }, CREATOR);
  const claimed = await service.claimTask(task.id, CHECKER);
  const unclaimed = await service.unclaimTask(task.id, CHECKER);
  assert.equal(unclaimed.dueAt, claimed.dueAt, "the next claimer re-anchors; nothing to do here");
}));

await check("an OOO task keeps its return date across a claim", async () => withFrozenTime(FROZEN_INSTANT, async () => {
  const { service } = await setup();
  const startDate = "2027-06-01";
  const returnDate = "2027-06-08";
  const task = await service.createTask(
    { folderName: "Beach", taskType: "OOO", notes: "n", startDate, returnDate },
    CREATOR
  );
  const claimed = await service.claimTask(task.id, CHECKER);
  assert.equal(claimed.dueAt, task.dueAt, "moving it would end the vacation on the wrong day");
}));

await check("a born-assigned RED task is not overdue the instant it exists", async () =>
  withFrozenTime(FROZEN_INSTANT, async () => {
    const { service } = await setup();
    // Creation and claim are the same moment here, so this task never passes
    // through the claim door — it has to be anchored on the way in or it lands
    // on its assignee already late, which is #181 through the one remaining door.
    const task = await service.createTask(
      { folderName: "Born Urgent", taskType: "VALUE", notes: "n", urgency: "RED" },
      CREATOR,
      CHECKER
    );
    assert.equal(task.status, "CLAIMED");
    const remainingMinutes = (new Date(task.dueAt).getTime() - Date.now()) / 60_000;
    assert.ok(remainingMinutes > 14 && remainingMinutes <= 15, `a real fifteen minutes, got ${remainingMinutes}m`);

    const unassigned = await service.createTask(
      { folderName: "Born Open", taskType: "VALUE", notes: "n", urgency: "RED" },
      CREATOR
    );
    assert.equal(
      unassigned.dueAt,
      new Date(Date.now()).toISOString(),
      "unclaimed RED still sorts to the top on a due-now deadline"
    );
  }));

await check("a FRAUD task released at PENDING_APPROVAL re-anchors for whoever picks it up", async () =>
  withFrozenTime(FROZEN_INSTANT, async () => {
    const { service, store } = await setup();
    const task = await service.createTask({ folderName: "Left Hanging", taskType: "FRAUD", notes: "n", urgency: "ORANGE" }, CREATOR);
    await service.claimTask(task.id, CHECKER);
    await service.transitionStatus(task.id, "AWAITING_ITEMS", CHECKER, "please gather these");
    const pending = await service.transitionStatus(task.id, "PENDING_APPROVAL", CREATOR);
    assert.equal(pending.status, "PENDING_APPROVAL");

    // Entering PENDING_APPROVAL stamps an end-of-today clock. Burn it down to
    // the state a Friday-evening release leaves behind: a deadline that is
    // nearly gone before the next approver has even seen the task.
    await backdate(store, task.id, { dueAt: new Date(Date.now() + 60_000).toISOString() });
    await service.releaseForAnyChecker(task.id, CREATOR);

    const claimed = await service.claimTask(task.id, OTHER);
    assert.equal(claimed.status, "PENDING_APPROVAL", "released in place — the status does not rewind");
    const remaining = new Date(claimed.dueAt).getTime() - Date.now();
    assert.ok(remaining > 60_000, "the new approver does not inherit the last one's expired clock");
    assert.equal(pacificClock(claimed.dueAt), "17:30", "they get the same end-of-day the status grants on entry");
  }));

/* ------------------------------------------------ the creator's in-app signal */

await check("an unclaimed overdue task no longer raises an in-app signal for its creator", async () => withFrozenTime(FROZEN_INSTANT, async () => {
  const { service, store, events } = await setup();
  const task = await service.createTask({ folderName: "Nobody Home", taskType: "VALUE", notes: "n", urgency: "ORANGE" }, CREATOR);
  await backdate(store, task.id, { dueAt: minutesAgo(30) });

  await service.settleBackgroundWork();
  events.length = 0;
  await service.runMaintenance();
  await service.settleBackgroundWork();
  const feed = events.filter((e) => e.target === "ACTIVITY_FEED" && /running late/.test(e.message));
  assert.equal(feed.length, 0, "an unclaimed task is a staffing problem, not the creator's lateness");
}));

await check("the creator's row reddens at twenty minutes unclaimed, and never for OOO", async () =>
  withFrozenTime(FROZEN_INSTANT, async () => {
    const { service, store } = await setup();
    const task = await service.createTask({ folderName: "Still Nobody", taskType: "VALUE", notes: "n", urgency: "ORANGE" }, CREATOR);

    await backdate(store, task.id, { createdAt: minutesAgo(19) });
    assert.equal(isUnclaimedTooLong(await service.getTask(task.id), new Date()), false, "19 minutes is not yet 20");

    await backdate(store, task.id, { createdAt: minutesAgo(21) });
    assert.equal(isUnclaimedTooLong(await service.getTask(task.id), new Date()), true);

    // OOO is born OPEN and unassigned and stays that way until it auto-completes
    // on the return date, so a rule keyed only on "OPEN and unassigned" would
    // redden a holiday for its whole duration.
    const ooo = await service.createTask(
      { folderName: "Beach Week", taskType: "OOO", notes: "n", startDate: "2027-06-01", returnDate: "2027-06-08" },
      CREATOR
    );
    assert.equal(ooo.status, "OPEN");
    assert.equal(ooo.assignee, undefined);
    await backdate(store, ooo.id, { createdAt: minutesAgo(120) });
    assert.equal(isUnclaimedTooLong(await service.getTask(ooo.id), new Date()), false);
  }));

console.log(`\n${passed} checks passed`);
