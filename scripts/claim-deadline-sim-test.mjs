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
 * Neither seam reads the wall clock for anything it asserts, so the suite means
 * the same thing on a Tuesday afternoon and on a Sunday night. The clamp checks
 * pass their own instant. The service checks either hand `runMaintenance` an
 * instant (#204) or state the expected deadline as the shared clamp applied to
 * the instant the service itself stamped on the task -- which is the
 * service-level claim worth making anyway: that the door routes through the
 * clamp. What the clamp then computes is the pure checks' subject, above.
 *
 * An earlier draft held business hours wide open and read the wall clock, which
 * made the suite a test of what time of day it happened to run:
 * `isWithinBusinessHours` rejects Saturday and Sunday before it ever looks at
 * the configured hours, so those checks failed every weekend.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  computeClaimAnchoredDueAt,
  computeDueAtFromUrgency,
  isDeadlineRecomputeExempt,
  isOverdue,
  isUnclaimed,
  isUnclaimedTooLong,
  isPoolNagDue,
  isPoolNagEligible
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
   them has to say so itself. Handed to `runMaintenance`, whose reminder gating
   is the only wall-clock read left in this suite's path. */
const MAINTENANCE_INSTANT = new Date("2026-03-11T10:00:00-07:00");

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

await check("claiming a task that sat in the pool restarts its hour", async () => {
  const { service, store } = await setup();
  const task = await service.createTask(
    { folderName: "Sat In Pool", taskType: "VALUE", notes: "n", urgency: "ORANGE" },
    CREATOR
  );
  // 45 minutes in the pool: under the old rule this task is 15 minutes from
  // overdue at the moment it is claimed, which is the whole complaint.
  const stale = new Date(Date.now() + 15 * 60_000).toISOString();
  await backdate(store, task.id, { createdAt: minutesAgo(45), dueAt: stale });

  const claimed = await service.claimTask(task.id, CHECKER);
  /* The claim's own instant is on the task: `updatedAt`. Stating the expected
     deadline against it says the door re-anchors through the clamp and drops
     what the pool left behind. The hour itself is pinned by "ORANGE claimed
     mid-morning is due one hour later" above, which can state its instant
     outright because it calls the clamp directly. Asserting a literal hour here
     would only be asserting what time this suite happened to run: claimed on a
     Saturday, the same correct clamp hands back Monday morning. */
  assert.notEqual(claimed.dueAt, stale, "the deadline the pool burned down does not survive the claim");
  assert.ok(new Date(claimed.dueAt) > new Date(stale), "and it is further out than what the pool left");
  assert.equal(
    claimed.dueAt,
    computeClaimAnchoredDueAt("ORANGE", new Date(claimed.updatedAt), config),
    "the hour restarts from the claim, not from creation"
  );
});

await check("a stale reminder stamp does not survive the recompute", async () => {
  const { service, store } = await setup();
  const task = await service.createTask({ folderName: "Stale Stamp", taskType: "VALUE", notes: "n", urgency: "ORANGE" }, CREATOR);
  await backdate(store, task.id, { lastReminderAt: minutesAgo(30) });
  const claimed = await service.claimTask(task.id, CHECKER);
  assert.equal(claimed.lastReminderAt, undefined, "the fresh clock gets a fresh reminder cadence");
});

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

await check("the normal overdue reminder names the task, not the person", async () => {
  const { service, store, events } = await setup();
  const task = await service.createTask({ folderName: "Ran Out", taskType: "VALUE", notes: "n", urgency: "ORANGE" }, CREATOR);
  await service.claimTask(task.id, CHECKER);
  // Overdue as of the instant maintenance is handed, not as of the wall clock.
  await backdate(store, task.id, { dueAt: new Date(MAINTENANCE_INSTANT.getTime() - 5 * 60_000).toISOString() });

  await service.settleBackgroundWork();
  events.length = 0;
  await service.runMaintenance(MAINTENANCE_INSTANT);
  await service.settleBackgroundWork();
  const reminder = events.find((e) => e.target === "DM" && e.type === "TASK_REMINDER");
  assert.match(reminder.message, /^your time's up on Ran Out$/);
});

await check("a handoff re-anchors the deadline to the new holder", async () => {
  const { service, store } = await setup();
  const task = await service.createTask({ folderName: "Passed On", taskType: "VALUE", notes: "n", urgency: "ORANGE" }, CREATOR);
  await service.claimTask(task.id, CHECKER);
  // The first assignee burns most of their hour before passing it on.
  const nearlySpent = new Date(Date.now() + 5 * 60_000).toISOString();
  await backdate(store, task.id, { dueAt: nearlySpent });

  const handed = await service.assignTask({ taskId: task.id, target: OTHER, actor: CHECKER });
  assert.notEqual(handed.dueAt, nearlySpent, "the recipient does not inherit what is left of somebody else's hour");
  assert.equal(
    handed.dueAt,
    computeClaimAnchoredDueAt("ORANGE", new Date(handed.updatedAt), config),
    "the handoff re-anchors from its own instant, the same as a claim"
  );
  assert.ok(new Date(handed.dueAt) > new Date(handed.updatedAt), "and not into a deadline already gone");
});

await check("unclaiming and releasing leave the deadline alone", async () => {
  const { service } = await setup();
  const task = await service.createTask({ folderName: "Handed Back", taskType: "VALUE", notes: "n", urgency: "ORANGE" }, CREATOR);
  const claimed = await service.claimTask(task.id, CHECKER);
  const unclaimed = await service.unclaimTask(task.id, CHECKER);
  assert.equal(unclaimed.dueAt, claimed.dueAt, "the next claimer re-anchors; nothing to do here");

  // The other door back to the pool. This check was named for both and only
  // ever exercised one of them.
  const fraud = await service.createTask({ folderName: "Released", taskType: "FRAUD", notes: "n", urgency: "ORANGE" }, CREATOR);
  await service.claimTask(fraud.id, CHECKER);
  await service.transitionStatus(fraud.id, "AWAITING_ITEMS", CHECKER, "please gather these");
  const pending = await service.transitionStatus(fraud.id, "PENDING_APPROVAL", CREATOR);
  const released = await service.releaseForAnyChecker(fraud.id, CREATOR);
  assert.equal(released.dueAt, pending.dueAt, "release leaves it alone too");
  assert.equal(released.assignee, undefined);
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

await check("a born-assigned RED task is not overdue the instant it exists", async () => {
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
  assert.ok(new Date(task.dueAt) > new Date(task.createdAt), "urgent still cannot mean already late");
  /* The fifteen minutes themselves are pinned by "RED gets a real fifteen-minute
     window" above. What is only provable here is that creation-with-an-assignee
     goes through the CLAIM rule rather than the creation-time one — which is
     #181 through the one door that has no claim. */
  assert.equal(
    task.dueAt,
    computeClaimAnchoredDueAt("RED", new Date(task.createdAt), config),
    "born assigned goes through the clamp, not the creation-time rule"
  );
  assert.notEqual(
    task.dueAt,
    computeDueAtFromUrgency("RED", new Date(task.createdAt), config),
    "which is a different answer — the creation-time rule is due-now"
  );

  const unassigned = await service.createTask(
    { folderName: "Born Open", taskType: "VALUE", notes: "n", urgency: "RED" },
    CREATOR
  );
  assert.equal(
    unassigned.dueAt,
    unassigned.createdAt,
    "unclaimed RED still sorts to the top on a due-now deadline"
  );
});

await check("a FRAUD task released at PENDING_APPROVAL re-anchors for whoever picks it up", async () => {
  const { service, store } = await setup();
  const task = await service.createTask({ folderName: "Left Hanging", taskType: "FRAUD", notes: "n", urgency: "ORANGE" }, CREATOR);
  await service.claimTask(task.id, CHECKER);
  await service.transitionStatus(task.id, "AWAITING_ITEMS", CHECKER, "please gather these");
  const pending = await service.transitionStatus(task.id, "PENDING_APPROVAL", CREATOR);
  assert.equal(pending.status, "PENDING_APPROVAL");

  // Entering PENDING_APPROVAL stamps an end-of-today clock. Burn it down to
  // the state a Friday-evening release leaves behind: a deadline that is
  // nearly gone before the next approver has even seen the task.
  const nearlySpent = new Date(Date.now() + 60_000).toISOString();
  await backdate(store, task.id, { dueAt: nearlySpent });
  await service.releaseForAnyChecker(task.id, CREATOR);

  const claimed = await service.claimTask(task.id, OTHER);
  assert.equal(claimed.status, "PENDING_APPROVAL", "released in place — the status does not rewind");
  assert.notEqual(claimed.dueAt, nearlySpent, "the new approver does not inherit the last one's expired clock");
  // The end-of-business clamp lands on 17:30 Pacific whatever day the claim
  // falls on, so this literal costs nothing and is the one that has teeth.
  assert.equal(pacificClock(claimed.dueAt), "17:30", "an end-of-day, not the scraps of somebody else's");
  assert.equal(
    claimed.dueAt,
    computeDueAtFromUrgency("YELLOW", new Date(claimed.updatedAt), config),
    "the same end-of-day the status grants on entry, measured from the claim"
  );
});

/* ------------------------------------------------ the creator's in-app signal */

await check("an unclaimed overdue task no longer raises an in-app signal for its creator", async () => {
  const { service, store, events } = await setup();
  const task = await service.createTask({ folderName: "Nobody Home", taskType: "VALUE", notes: "n", urgency: "ORANGE" }, CREATOR);
  const halfAnHourBefore = new Date(MAINTENANCE_INSTANT.getTime() - 30 * 60_000).toISOString();
  await backdate(store, task.id, { createdAt: halfAnHourBefore, dueAt: halfAnHourBefore });

  await service.settleBackgroundWork();
  events.length = 0;
  await service.runMaintenance(MAINTENANCE_INSTANT);
  await service.settleBackgroundWork();
  const feed = events.filter((e) => e.target === "ACTIVITY_FEED" && /running late/.test(e.message));
  assert.equal(feed.length, 0, "an unclaimed task is a staffing problem, not the creator's lateness");
});

await check("the creator's row reddens at twenty minutes unclaimed, and never for OOO", async () => {
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
});

await check("a task released back to the pool reads as unclaimed, not as overdue", async () => {
  const { service, store, events } = await setup();
  const task = await service.createTask({ folderName: "Up For Grabs", taskType: "FRAUD", notes: "n", urgency: "ORANGE" }, CREATOR);
  await service.claimTask(task.id, CHECKER);
  await service.transitionStatus(task.id, "AWAITING_ITEMS", CHECKER, "please gather these");
  await service.transitionStatus(task.id, "PENDING_APPROVAL", CREATOR);
  await service.releaseForAnyChecker(task.id, CREATOR);
  // Blow the deadline while nobody holds it.
  await backdate(store, task.id, { dueAt: minutesAgo(30) });

  const released = await service.getTask(task.id);
  assert.equal(released.status, "PENDING_APPROVAL", "released in place — it is not OPEN");
  assert.equal(released.assignee, undefined);
  assert.equal(
    isUnclaimed(released),
    true,
    "keying on OPEN instead of the holder is what let the row render a red OVERDUE BY here"
  );
  assert.equal(isOverdue(released, new Date()), true, "the deadline really has passed — the row just must not say so");

  // And the server agrees it is nobody's lateness: no in-app overdue signal,
  // because collectActiveSignals asks about the assignee, not the status.
  await service.settleBackgroundWork();
  events.length = 0;
  await service.runMaintenance(MAINTENANCE_INSTANT);
  await service.settleBackgroundWork();
  const overdueSignals = events.filter((e) => e.target === "ACTIVITY_FEED" && /running late/.test(e.message));
  assert.equal(overdueSignals.length, 0);
});

await check("a fraud check released for any checker counts up for its creator, and does not nag the room", async () => {
  const { service, store } = await setup();
  const task = await service.createTask({ folderName: "Needs A Checker", taskType: "FRAUD", notes: "n", urgency: "ORANGE" }, CREATOR);
  await service.claimTask(task.id, CHECKER);
  await service.transitionStatus(task.id, "AWAITING_ITEMS", CHECKER, "please gather these");
  await service.transitionStatus(task.id, "PENDING_APPROVAL", CREATOR);
  await service.releaseForAnyChecker(task.id, CREATOR);

  /* The clock is `pooledSince`, stamped by the release — NOT `createdAt`,
     which here counts the time the first checker spent working on it (#210).
     Backdating only `pooledSince` is what tells the two apart. Measured from
     MAINTENANCE_INSTANT rather than the wall clock because `isPoolNagDue` also
     refuses outside business hours, and a `false` for THAT reason would pass
     this check every weekend while proving nothing. */
  const pooledFor = (minutes) =>
    backdate(store, task.id, {
      pooledSince: new Date(MAINTENANCE_INSTANT.getTime() - minutes * 60_000).toISOString()
    });

  await pooledFor(19);
  const young = await service.getTask(task.id);
  assert.equal(young.status, "PENDING_APPROVAL", "released in place — it is not OPEN");
  assert.equal(isUnclaimedTooLong(young, MAINTENANCE_INSTANT), false, "19 minutes is not yet 20, released or otherwise");

  await pooledFor(21);
  const old = await service.getTask(task.id);
  assert.equal(
    isUnclaimedTooLong(old, MAINTENANCE_INSTANT),
    true,
    "the seat is empty and has been for twenty minutes — the creator is the one person who can chase it (#213)"
  );

  /* #213 option 2: the creator gets told, the channel does not. The release
     announces itself once and then stays quiet, so a released check must
     never become nag-eligible. */
  assert.equal(isPoolNagEligible(old), false, "final approval asks the room once, not every twenty minutes (#213)");
  assert.equal(isPoolNagDue(old, MAINTENANCE_INSTANT, config), false, "mid-morning on a Wednesday, and still not asked");
});

console.log(`\n${passed} checks passed`);
