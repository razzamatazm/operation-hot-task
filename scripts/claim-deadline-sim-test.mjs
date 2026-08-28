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
 *     notifier, for the doors an assignee arrives through and for the pool nag.
 *
 * runMaintenance reads its own clock, so nag timing is driven by backdating
 * `createdAt`/`lastPoolNagAt` in the store rather than by faking time. Business
 * hours are held wide open for the same reason the fan-out sim does it: a suite
 * that inherits the real 8:30-17:30 window is a test of what time of day it is.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  computeClaimAnchoredDueAt,
  computeDueAtFromUrgency,
  isDeadlineRecomputeExempt,
  isPoolNagDue,
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
const ALWAYS_OPEN_CONFIG = { ...config, businessStartHour: 0, businessStartMinute: 0, businessEndHour: 23, businessEndMinute: 59 };

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

const setup = async (appConfig = ALWAYS_OPEN_CONFIG) => {
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

console.log("Claim-anchored deadlines and the pool nag — #181");

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

await check("RED is due on arrival: a zero-length window clamps to the claim instant", async () => {
  const due = computeClaimAnchoredDueAt("RED", at(10, 0), config);
  assert.equal(due, at(10, 0).toISOString());
});

await check("a claim made after close lands on a close that has already passed", async () => {
  const claimedAt = at(19, 0);
  const due = computeClaimAnchoredDueAt("ORANGE", claimedAt, config);
  assert.equal(pacificClock(due), "17:30");
  assert.ok(new Date(due) < claimedAt, "overdue on arrival, which is the decision — no grace floor");
});

await check("the exemption predicate covers OOO and PENDING_APPROVAL only", async () => {
  assert.equal(isDeadlineRecomputeExempt({ taskType: "OOO", status: "CLAIMED" }), true);
  assert.equal(isDeadlineRecomputeExempt({ taskType: "FRAUD", status: "PENDING_APPROVAL" }), true);
  assert.equal(isDeadlineRecomputeExempt({ taskType: "FRAUD", status: "CLAIMED" }), false);
  assert.equal(isDeadlineRecomputeExempt({ taskType: "VALUE", status: "OPEN" }), false);
});

/* ------------------------------------------------------------- the doors */

await check("claiming a task that sat in the pool restarts its hour", async () => {
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
  assert.equal(claimed.claimedOverdue, undefined, "not overdue on arrival, so no inherited marker");
});

await check("a stale reminder stamp does not survive the recompute", async () => {
  const { service, store } = await setup();
  const task = await service.createTask({ folderName: "Stale Stamp", taskType: "VALUE", notes: "n", urgency: "ORANGE" }, CREATOR);
  await backdate(store, task.id, { lastReminderAt: minutesAgo(30) });
  const claimed = await service.claimTask(task.id, CHECKER);
  assert.equal(claimed.lastReminderAt, undefined, "the fresh clock gets a fresh reminder cadence");
});

await check("a task claimed already-overdue is marked, and the marker clears on the first reminder", async () => {
  const { service, store, events } = await setup();
  const task = await service.createTask({ folderName: "Born Late", taskType: "VALUE", notes: "n", urgency: "RED" }, CREATOR);
  const claimed = await service.claimTask(task.id, CHECKER);
  assert.equal(claimed.claimedOverdue, true, "RED is due the instant it is claimed");

  // RED's deadline IS the claim instant, and isOverdue is a strict `dueAt < now`,
  // so it becomes overdue a millisecond later. Nudge past that boundary rather
  // than racing it — against the real 5-minute maintenance tick it never matters.
  await backdate(store, task.id, { dueAt: minutesAgo(1) });
  await service.settleBackgroundWork();
  events.length = 0;
  await service.runMaintenance();
  await service.settleBackgroundWork();
  const reminder = events.find((e) => e.target === "DM" && e.type === "TASK_REMINDER");
  assert.ok(reminder, "the assignee is reminded");
  assert.match(reminder.message, /^you picked up Born Late when it was already past due, so it\'s first up today$/, "explains the state without asserting a cause it cannot know");

  const after = await service.getTask(task.id);
  assert.equal(after.claimedOverdue, undefined, "the inherited copy is a one-shot");
});

await check("the normal overdue reminder names the task, not the person", async () => {
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
});

await check("a handoff re-anchors the deadline to the new holder", async () => {
  const { service, store } = await setup();
  const task = await service.createTask({ folderName: "Passed On", taskType: "VALUE", notes: "n", urgency: "ORANGE" }, CREATOR);
  await service.claimTask(task.id, CHECKER);
  // The first assignee burns most of their hour before passing it on.
  await backdate(store, task.id, { dueAt: new Date(Date.now() + 5 * 60_000).toISOString() });

  const handed = await service.assignTask({ taskId: task.id, target: OTHER, actor: CHECKER });
  const remainingMinutes = (new Date(handed.dueAt).getTime() - Date.now()) / 60_000;
  assert.ok(remainingMinutes > 55, `the recipient gets their own hour, got ${remainingMinutes}m`);
});

await check("unclaiming and releasing leave the deadline alone", async () => {
  const { service, store } = await setup();
  const task = await service.createTask({ folderName: "Handed Back", taskType: "VALUE", notes: "n", urgency: "ORANGE" }, CREATOR);
  const claimed = await service.claimTask(task.id, CHECKER);
  const unclaimed = await service.unclaimTask(task.id, CHECKER);
  assert.equal(unclaimed.dueAt, claimed.dueAt, "the next claimer re-anchors; nothing to do here");
});

await check("an OOO task keeps its return date across a claim", async () => {
  const { service } = await setup();
  const startDate = "2027-06-01";
  const returnDate = "2027-06-08";
  const task = await service.createTask(
    { folderName: "Beach", taskType: "OOO", notes: "n", startDate, returnDate },
    CREATOR
  );
  const claimed = await service.claimTask(task.id, CHECKER);
  assert.equal(claimed.dueAt, task.dueAt, "moving it would end the vacation on the wrong day");
});

/* -------------------------------------------------------------- the pool nag */

await check("an unclaimed task nags the channel at 20 minutes, not at 19", async () => {
  const { service, store, events } = await setup();
  const task = await service.createTask({ folderName: "Missed In The Shuffle", taskType: "VALUE", notes: "n", urgency: "ORANGE" }, CREATOR);

  await backdate(store, task.id, { createdAt: minutesAgo(19) });
  await service.settleBackgroundWork();
  events.length = 0;
  await service.runMaintenance();
  await service.settleBackgroundWork();
  assert.equal(events.filter((e) => e.target === "CHANNEL_NAG").length, 0, "19 minutes is not yet 20");

  await backdate(store, task.id, { createdAt: minutesAgo(21) });
  await service.settleBackgroundWork();
  events.length = 0;
  await service.runMaintenance();
  await service.settleBackgroundWork();
  const nags = events.filter((e) => e.target === "CHANNEL_NAG");
  assert.equal(nags.length, 1);
  assert.match(nags[0].message, /Missed In The Shuffle is still unclaimed after 21 minutes, who's taking it\?/);
  assert.equal(nags[0].recipientUserIds, undefined, "the room, not a person");
});

await check("the nag repeats every 20 minutes and never DMs anyone", async () => {
  const { service, store, events } = await setup();
  const task = await service.createTask({ folderName: "Still Sitting", taskType: "VALUE", notes: "n", urgency: "ORANGE" }, CREATOR);
  await backdate(store, task.id, { createdAt: minutesAgo(60), lastPoolNagAt: minutesAgo(5) });

  await service.settleBackgroundWork();
  events.length = 0;
  await service.runMaintenance();
  await service.settleBackgroundWork();
  assert.equal(events.filter((e) => e.target === "CHANNEL_NAG").length, 0, "only 5 minutes since the last nag");

  await backdate(store, task.id, { lastPoolNagAt: minutesAgo(25) });
  await service.settleBackgroundWork();
  events.length = 0;
  await service.runMaintenance();
  await service.settleBackgroundWork();
  assert.equal(events.filter((e) => e.target === "CHANNEL_NAG").length, 1);
  assert.equal(events.filter((e) => e.target === "DM").length, 0, "an unclaimed task never DMs anybody");
});

await check("an OOO task is never nagged about — it is a notice, not a request for hands", async () => {
  const { service, store, events } = await setup();
  const task = await service.createTask(
    { folderName: "Beach Week", taskType: "OOO", notes: "n", startDate: "2027-06-01", returnDate: "2027-06-08" },
    CREATOR
  );
  // Born OPEN and unassigned, and it stays that way until it auto-completes on
  // the return date — so a nag rule keyed only on "OPEN and unassigned" would
  // ask the room to pick up a holiday every 20 minutes for a week.
  assert.equal(task.status, "OPEN");
  assert.equal(task.assignee, undefined);
  await backdate(store, task.id, { createdAt: minutesAgo(120) });

  await service.settleBackgroundWork();
  events.length = 0;
  await service.runMaintenance();
  await service.settleBackgroundWork();
  assert.equal(events.filter((e) => e.target === "CHANNEL_NAG").length, 0);

  const aged = await service.getTask(task.id);
  assert.equal(isPoolNagDue(aged, new Date(), ALWAYS_OPEN_CONFIG), false);
  assert.equal(isUnclaimedTooLong(aged, new Date()), false, "and the creator's row does not redden either");
});

await check("the nag stays silent outside business hours", async () => {
  // A window that cannot contain "now", whatever time the suite runs.
  const nowHour = Number(pacificParts(new Date().toISOString()).hour);
  const closedHour = (nowHour + 3) % 24;
  const CLOSED = { ...config, businessStartHour: closedHour, businessStartMinute: 0, businessEndHour: closedHour, businessEndMinute: 1 };
  const { service, store, events } = await setup(CLOSED);
  const task = await service.createTask({ folderName: "After Hours", taskType: "VALUE", notes: "n", urgency: "ORANGE" }, CREATOR);
  await backdate(store, task.id, { createdAt: minutesAgo(90) });

  await service.settleBackgroundWork();
  events.length = 0;
  await service.runMaintenance();
  await service.settleBackgroundWork();
  assert.equal(events.filter((e) => e.target === "CHANNEL_NAG").length, 0);
});

await check("claiming stops the nag, and unclaiming restarts its cadence", async () => {
  const { service, store, events } = await setup();
  const task = await service.createTask({ folderName: "Grabbed At Last", taskType: "VALUE", notes: "n", urgency: "ORANGE" }, CREATOR);
  await backdate(store, task.id, { createdAt: minutesAgo(45), lastPoolNagAt: minutesAgo(25) });

  const claimed = await service.claimTask(task.id, CHECKER);
  assert.equal(claimed.lastPoolNagAt, undefined, "somebody is on it, so it is no longer the pool's problem");

  await service.settleBackgroundWork();
  events.length = 0;
  await service.runMaintenance();
  await service.settleBackgroundWork();
  assert.equal(events.filter((e) => e.target === "CHANNEL_NAG").length, 0, "a claimed task is never nagged about");

  const unclaimed = await service.unclaimTask(task.id, CHECKER);
  assert.ok(unclaimed.lastPoolNagAt, "the reopen post is nag zero, so the cadence is stamped from it");
  await service.settleBackgroundWork();
  events.length = 0;
  await service.runMaintenance();
  await service.settleBackgroundWork();
  assert.equal(
    events.filter((e) => e.target === "CHANNEL_NAG").length,
    0,
    "and the cadence restarts from the unclaim rather than firing immediately on the original createdAt"
  );
});

/* ------------------------------------------------ the creator's in-app signal */

await check("an unclaimed overdue task no longer raises an in-app signal for its creator", async () => {
  const { service, store, events } = await setup();
  const task = await service.createTask({ folderName: "Nobody Home", taskType: "VALUE", notes: "n", urgency: "ORANGE" }, CREATOR);
  await backdate(store, task.id, { dueAt: minutesAgo(30) });

  await service.settleBackgroundWork();
  events.length = 0;
  await service.runMaintenance();
  await service.settleBackgroundWork();
  const feed = events.filter((e) => e.target === "ACTIVITY_FEED" && /running late/.test(e.message));
  assert.equal(feed.length, 0, "the pool nag and the creator's own row cover this now");
});

console.log(`\n${passed} checks passed`);
