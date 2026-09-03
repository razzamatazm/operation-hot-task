#!/usr/bin/env node
/*
 * Who closed the task, and telling whoever did not (#239, ADR-0007 rule 6).
 *
 * Until the corrections loop, "the task was completed" and "the assignee
 * completed it" were the same statement, so a history row saying only that the
 * status changed was a complete answer. Now a creator can close a task that is
 * assigned to somebody else, and that row reads as though the assignee signed
 * off — the wrong answer to the only question anyone asks a task history weeks
 * later.
 *
 * Two things follow, and this file pins both:
 *
 *   1. Closure writes its own history action (`TASK_COMPLETED` /
 *      `TASK_ARCHIVED`) rather than the generic status-change row, so the
 *      actor on it can be found without parsing a free-text detail string —
 *      which ADR-0002 was explicit is nobody's parser. `completedBy` /
 *      `archivedBy` in packages/shared/src/history.ts are the whole rule, and
 *      a history that predates the change answers "nobody" rather than
 *      guessing the assignee.
 *
 *   2. Whoever did not press the button is told. Symmetric, deliberately: the
 *      creator closes it and the assignee hears, the assignee closes it and
 *      the creator hears. Nobody hears about their own action, and nothing new
 *      goes to the channel.
 *
 * Runs against the compiled dist, mirroring corrections-permissions-sim-test.mjs.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SYSTEM_ACTOR, completionDmMessage } from "../packages/shared/dist/types.js";
import { archivedBy, completedBy } from "../packages/shared/dist/history.js";
import { TaskStore } from "../apps/server/dist/store.js";
import { SseHub } from "../apps/server/dist/sse.js";
import { TaskService } from "../apps/server/dist/task-service.js";

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`ok - ${label}`);
};

const CREATOR = { id: "creator-1", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] };
const ASSIGNEE = { id: "worker-1", displayName: "Sam Officer", roles: ["LOAN_OFFICER"] };

// ---------------------------------------------------------------------------
// 1. The pure rule: reading the closer back out of a history list
// ---------------------------------------------------------------------------

const DANA = { id: CREATOR.id, displayName: CREATOR.displayName };
const SAM = { id: ASSIGNEE.id, displayName: ASSIGNEE.displayName };
const event = (action, at, by) => ({ action, at, by });

await check("the completion row names its actor", () => {
  const history = [
    event("TASK_CREATED", "2026-03-01T09:00:00.000Z", DANA),
    event("TASK_CLAIMED", "2026-03-01T09:30:00.000Z", SAM),
    event("TASK_COMPLETED", "2026-03-01T11:00:00.000Z", SAM)
  ];
  assert.deepEqual(completedBy(history), SAM);
});

await check("the closer is the closer, even when that is not the assignee", () => {
  // The corrections loop: Sam holds the task, Dana closes it. Reading the
  // assignee field here would credit Sam with Dana's sign-off.
  const history = [
    event("TASK_CLAIMED", "2026-03-01T09:30:00.000Z", SAM),
    event("TASK_COMPLETED", "2026-03-01T11:00:00.000Z", DANA)
  ];
  assert.deepEqual(completedBy(history), DANA);
});

await check("the archival row names its actor, separately from the completion", () => {
  const history = [
    event("TASK_COMPLETED", "2026-03-01T11:00:00.000Z", SAM),
    event("TASK_ARCHIVED", "2026-03-08T11:00:00.000Z", DANA)
  ];
  assert.deepEqual(completedBy(history), SAM);
  assert.deepEqual(archivedBy(history), DANA);
});

await check("a task completed, reopened and completed again reports the SECOND closer", () => {
  const history = [
    event("TASK_COMPLETED", "2026-03-01T11:00:00.000Z", SAM),
    event("TASK_STATUS_CHANGED", "2026-03-02T09:00:00.000Z", DANA),
    event("TASK_COMPLETED", "2026-03-03T15:00:00.000Z", DANA)
  ];
  assert.deepEqual(completedBy(history), DANA);
});

await check("a reopen wipes the closure rather than leaving a stale name on it", () => {
  // Restore sends a reopened task straight back to the closed status it came
  // from, so an archived task can carry a completion from before the reopen.
  // Whoever completed it then is not who signed off on what is there now.
  const history = [
    event("TASK_COMPLETED", "2026-03-01T11:00:00.000Z", SAM),
    event("TASK_STATUS_CHANGED", "2026-03-02T09:00:00.000Z", DANA),
    event("TASK_ARCHIVED", "2026-03-02T09:05:00.000Z", DANA)
  ];
  assert.equal(completedBy(history), undefined, "no completion since the reopen — a blank, not the old one");
  assert.deepEqual(archivedBy(history), DANA, "but the archival is current and stands");
});

await check("chronology is established here, not trusted from the caller", () => {
  const history = [
    event("TASK_COMPLETED", "2026-03-03T15:00:00.000Z", DANA),
    event("TASK_COMPLETED", "2026-03-01T11:00:00.000Z", SAM)
  ];
  assert.deepEqual(completedBy(history), DANA, "the later row wins whatever order it arrives in");
  assert.deepEqual(
    history.map((e) => e.at),
    ["2026-03-03T15:00:00.000Z", "2026-03-01T11:00:00.000Z"],
    "and the caller's array is left alone"
  );
});

await check("a history that predates the change answers nobody rather than guessing", () => {
  // The AC that matters most for existing data: an old closure is a
  // TASK_STATUS_CHANGED row, and the honest answer is a blank, not the
  // assignee. Backfilling is not recoverable and a guess is worse.
  const history = [
    event("TASK_CLAIMED", "2026-03-01T09:30:00.000Z", SAM),
    event("TASK_STATUS_CHANGED", "2026-03-01T11:00:00.000Z", SAM)
  ];
  assert.equal(completedBy(history), undefined);
  assert.equal(archivedBy(history), undefined);
  assert.equal(completedBy([]), undefined, "history dropped by retention, too");
  assert.equal(archivedBy([]), undefined);
});

// ---------------------------------------------------------------------------
// 2. End to end through the real service
// ---------------------------------------------------------------------------

const config = {
  businessTimezone: "America/Los_Angeles",
  businessStartHour: 8,
  businessStartMinute: 30,
  businessEndHour: 17,
  businessEndMinute: 30,
  archiveRetentionDays: 90
};

const setup = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "closure-actor-sim-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.init();
  const events = [];
  const notifier = {
    notify: async (evt) => {
      events.push(evt);
    },
    canReachDm: async () => true
  };
  return { store, events, service: new TaskService(store, notifier, new SseHub(), config) };
};

const capture = async ({ service, events }, fn) => {
  await service.settleBackgroundWork();
  const start = events.length;
  const result = await fn();
  await service.settleBackgroundWork();
  return { result, emitted: events.slice(start) };
};

const claimedLoi = async (service) => {
  const task = await service.createTask({ folderName: "Closure Sim", taskType: "LOI", notes: "n" }, CREATOR);
  return service.claimTask(task.id, ASSIGNEE);
};

const dmsTo = (emitted, userId) =>
  emitted.filter((e) => e.target === "DM" && (e.recipientUserIds ?? []).includes(userId));

const channelPosts = (emitted) => emitted.filter((e) => e.target.startsWith("CHANNEL"));

await check("service: the assignee completes — history names them, the creator hears", async () => {
  const ctx = await setup();
  const task = await claimedLoi(ctx.service);

  const { emitted } = await capture(ctx, () => ctx.service.transitionStatus(task.id, "COMPLETED", ASSIGNEE));

  const history = await ctx.service.getHistory(task.id);
  assert.deepEqual(completedBy(history), { id: ASSIGNEE.id, displayName: ASSIGNEE.displayName });

  const toCreator = dmsTo(emitted, CREATOR.id);
  assert.equal(toCreator.length, 1, "the creator is told their task landed");
  assert.equal(toCreator[0].message, completionDmMessage("LOI"), "the ordinary close keeps the ordinary per-type wording (#232)");
  assert.equal(dmsTo(emitted, ASSIGNEE.id).length, 0, "nobody is notified about their own action");
  assert.deepEqual(
    channelPosts(emitted).map((e) => e.target),
    ["CHANNEL_COMPLETED"],
    "only the existing silent terminal card edit — the closure notice is two-party business"
  );
});

await check("service: the creator closes from corrections — history names them, the assignee hears", async () => {
  const ctx = await setup();
  const task = await claimedLoi(ctx.service);
  await ctx.service.transitionStatus(task.id, "NEEDS_REVIEW", ASSIGNEE, "typo in the borrower name");

  const { emitted } = await capture(ctx, () => ctx.service.transitionStatus(task.id, "COMPLETED", CREATOR));

  const history = await ctx.service.getHistory(task.id);
  assert.deepEqual(
    completedBy(history),
    { id: CREATOR.id, displayName: CREATOR.displayName },
    "the record names who actually signed off, not who was holding it"
  );

  const toAssignee = dmsTo(emitted, ASSIGNEE.id);
  assert.equal(toAssignee.length, 1, "the assignee is told their task was closed out from under them");
  assert.match(toAssignee[0].message, /Dana Requester/, "and by whom");
  assert.match(
    toAssignee[0].message,
    /after corrections/,
    "the tail of the corrections loop is a fix being accepted, not the ordinary 'done and dusted'"
  );
  assert.doesNotMatch(toAssignee[0].message, /Done and dusted/);
  assert.equal(dmsTo(emitted, CREATOR.id).length, 0, "nobody is notified about their own action");
  assert.deepEqual(
    channelPosts(emitted).map((e) => e.target),
    ["CHANNEL_COMPLETED"],
    "nothing new goes to the channel (ADR-0002)"
  );
  assert.deepEqual(emitted.filter((e) => e.target === "ACTIVITY_FEED"), [], "and no feed alert");
});

await check("service: a confirming look sent back and then closed reads as an ordinary close", async () => {
  // The creator's other move out of corrections hands the task back for a
  // confirming look, and the assignee closes it from CLAIMED like any other
  // task. "After corrections" is worded off the status the close came FROM, so
  // this path keeps the ordinary wording — the fix was re-checked and the work
  // finished normally.
  const ctx = await setup();
  const task = await claimedLoi(ctx.service);
  await ctx.service.transitionStatus(task.id, "NEEDS_REVIEW", ASSIGNEE, "typo");
  await ctx.service.transitionStatus(task.id, "CLAIMED", CREATOR);

  const { emitted } = await capture(ctx, () => ctx.service.transitionStatus(task.id, "COMPLETED", ASSIGNEE));

  const toCreator = dmsTo(emitted, CREATOR.id);
  assert.equal(toCreator.length, 1, "the creator hears their corrected work was confirmed and closed");
  assert.equal(toCreator[0].message, completionDmMessage("LOI"));
  assert.equal(dmsTo(emitted, ASSIGNEE.id).length, 0, "and the closer hears nothing about their own action");
});

await check("service: archival names the person who archived it", async () => {
  const ctx = await setup();
  const task = await claimedLoi(ctx.service);
  await ctx.service.transitionStatus(task.id, "COMPLETED", ASSIGNEE);
  await ctx.service.transitionStatus(task.id, "ARCHIVED", CREATOR);

  const history = await ctx.service.getHistory(task.id);
  assert.deepEqual(archivedBy(history), { id: CREATOR.id, displayName: CREATOR.displayName });
  assert.deepEqual(
    completedBy(history),
    { id: ASSIGNEE.id, displayName: ASSIGNEE.displayName },
    "archiving does not overwrite who completed it"
  );
});

await check("service: an automatic archive is recorded as the system's, not the last person's", async () => {
  const ctx = await setup();
  const task = await claimedLoi(ctx.service);
  await ctx.service.transitionStatus(task.id, "COMPLETED", ASSIGNEE);
  // Old enough for the 14-day auto-archive sweep.
  const later = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
  const result = await ctx.service.runMaintenance(later);
  assert.equal(result.autoArchived, 1);

  const history = await ctx.service.getHistory(task.id);
  assert.deepEqual(archivedBy(history), { id: SYSTEM_ACTOR.id, displayName: SYSTEM_ACTOR.displayName });
});

console.log(`\nAll ${passed} closure-actor checks passed.`);
