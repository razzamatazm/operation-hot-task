#!/usr/bin/env node
/*
 * The confirm at the tail of the corrections loop closes AND archives, in one
 * press (#238, ADR-0007 rule 5).
 *
 * Completion and archival are two steps everywhere else, and rightly: the
 * creator wants to watch their own task land as done before it goes away. The
 * tail of this loop is the exception. There the checker is confirming a fix on
 * a task that was never theirs, and leaving them to complete it and then tidy
 * it away hands them housekeeping for somebody else's request.
 *
 * Three things have to hold together for that, and this file pins all three:
 *
 *   1. The task can tell where it came from. A CLAIMED LOI that the creator
 *      sent back for a confirming look is otherwise indistinguishable from one
 *      that never entered corrections, so it carries a breadcrumb —
 *      `awaitingConfirmationFrom`, the same shape as `reopenedFrom` — read
 *      through `completionTargetStatus` and never directly. A stale breadcrumb
 *      is inert, and a new holder clears it.
 *
 *   2. It is ONE write. Not a surface firing COMPLETED and then ARCHIVED,
 *      which can leave the task completed and not archived when the second
 *      call fails. The service lands the task on ARCHIVED inside the same
 *      `updateTask` slot that completes it.
 *
 *   3. The history keeps both steps. The user pressed once; the record still
 *      says the task was completed and then archived, and names the actor on
 *      each. An audit trail is not allowed to lose a step because the UI
 *      merged one.
 *
 * Everything else is unchanged, and the negative cases below are the point:
 * an ordinary completion still completes and waits, and the retention sweep
 * still archives on its own schedule as the system.
 *
 * Runs against the compiled dist, mirroring closure-actor-sim-test.mjs.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SYSTEM_ACTOR } from "../packages/shared/dist/types.js";
import { archivedBy, completedBy } from "../packages/shared/dist/history.js";
import { ACTION_LABELS } from "../packages/shared/dist/labels.js";
import { botPrimaryAdvance, completionTargetStatus, isConfirmingLook } from "../packages/shared/dist/workflow.js";
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
const OTHER = { id: "worker-2", displayName: "Kit Checker", roles: ["LOAN_OFFICER"] };

// ---------------------------------------------------------------------------
// 1. The pure rule: where a completion lands
// ---------------------------------------------------------------------------

const task = (overrides) => ({
  id: "t1",
  folderName: "Confirm Sim",
  taskType: "LOI",
  status: "CLAIMED",
  createdBy: { id: CREATOR.id, displayName: CREATOR.displayName },
  assignee: { id: ASSIGNEE.id, displayName: ASSIGNEE.displayName },
  urgency: "YELLOW",
  points: 0,
  notes: "n",
  createdAt: "2026-03-01T09:00:00.000Z",
  updatedAt: "2026-03-01T09:00:00.000Z",
  ...overrides
});

await check("an ordinary completion lands on COMPLETED and stops there", () => {
  assert.equal(completionTargetStatus(task()), "COMPLETED");
  assert.equal(isConfirmingLook(task()), false);
});

await check("a task sent back for a confirming look completes straight to ARCHIVED", () => {
  const sentBack = task({ awaitingConfirmationFrom: "NEEDS_REVIEW" });
  assert.equal(completionTargetStatus(sentBack), "ARCHIVED");
  assert.equal(isConfirmingLook(sentBack), true);
});

await check("the breadcrumb alone is not the answer — a stale one is inert", () => {
  // Everything that moves the task on clears it, but the derivation reads the
  // status too, the same guard `restoreTargetStatus` keeps: a breadcrumb that
  // outlived its move must not quietly archive somebody's task.
  for (const status of ["OPEN", "NEEDS_REVIEW", "COMPLETED", "ARCHIVED", "CANCELLED"]) {
    assert.equal(
      completionTargetStatus(task({ status, awaitingConfirmationFrom: "NEEDS_REVIEW" })),
      "COMPLETED",
      `a ${status} task is not a confirming look`
    );
  }
});

await check("the bot card says which of the two presses it is", () => {
  assert.equal(botPrimaryAdvance(task()).label, ACTION_LABELS.COMPLETE);
  assert.equal(botPrimaryAdvance(task({ awaitingConfirmationFrom: "NEEDS_REVIEW" })).label, ACTION_LABELS.CONFIRM);
  assert.equal(
    botPrimaryAdvance(task({ awaitingConfirmationFrom: "NEEDS_REVIEW" })).status,
    "COMPLETED",
    "same transition either way — one request, the server decides where it lands"
  );
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "confirm-archive-sim-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.init();
  const events = [];
  const notifier = {
    notify: async (evt) => {
      events.push(evt);
    },
    canReachDm: async () => true
  };
  /* Every write the service makes broadcasts exactly once, so counting
     broadcasts counts writes — which is how the one-action requirement is
     actually checked below rather than taken on faith. */
  const hub = new SseHub();
  const writes = [];
  hub.broadcast = (evt) => {
    writes.push(evt);
  };
  return { store, events, writes, service: new TaskService(store, notifier, hub, config) };
};

const capture = async ({ service, events }, fn) => {
  await service.settleBackgroundWork();
  const start = events.length;
  const result = await fn();
  await service.settleBackgroundWork();
  return { result, emitted: events.slice(start) };
};

const claimedLoi = async (service) => {
  const created = await service.createTask({ folderName: "Confirm Sim", taskType: "LOI", notes: "n" }, CREATOR);
  return service.claimTask(created.id, ASSIGNEE);
};

/* Claimed, reviewed, sent to corrections, and sent back by the creator for a
   confirming look — the state rule 5 is about. */
const awaitingConfirmation = async (service) => {
  const held = await claimedLoi(service);
  await service.transitionStatus(held.id, "NEEDS_REVIEW", ASSIGNEE, "typo in the borrower name");
  return service.transitionStatus(held.id, "CLAIMED", CREATOR);
};

const actionsOn = async (service, taskId) => (await service.getHistory(taskId)).map((e) => e.action);

await check("service: the send-back records where the task came from", async () => {
  const ctx = await setup();
  const sentBack = await awaitingConfirmation(ctx.service);

  assert.equal(sentBack.status, "CLAIMED", "the task is back with its assignee");
  assert.equal(sentBack.awaitingConfirmationFrom, "NEEDS_REVIEW", "and remembers it arrived by way of corrections");
  assert.deepEqual(sentBack.assignee, { id: ASSIGNEE.id, displayName: ASSIGNEE.displayName });
});

await check("service: the assignee's confirm archives the task, in one action", async () => {
  const ctx = await setup();
  const sentBack = await awaitingConfirmation(ctx.service);

  const before = ctx.writes.length;
  const confirmed = await ctx.service.transitionStatus(sentBack.id, "COMPLETED", ASSIGNEE);

  assert.equal(confirmed.status, "ARCHIVED", "one press, and the task is filed away");
  assert.ok(confirmed.completedAt, "it was completed");
  assert.ok(confirmed.archivedAt, "and archived");
  assert.equal(
    confirmed.awaitingConfirmationFrom,
    undefined,
    "the breadcrumb goes with the loop it belonged to"
  );
  assert.equal(
    ctx.writes.length - before,
    1,
    "ONE write: a completion followed by a separate archive is what could fail halfway"
  );

  const stored = await ctx.store.findTask(sentBack.id);
  assert.equal(stored.status, "ARCHIVED", "and it is what was persisted, not just what was returned");
});

await check("service: the history keeps both steps, and names the actor on each", async () => {
  const ctx = await setup();
  const sentBack = await awaitingConfirmation(ctx.service);
  await ctx.service.transitionStatus(sentBack.id, "COMPLETED", ASSIGNEE);

  const history = await ctx.service.getHistory(sentBack.id);
  const sam = { id: ASSIGNEE.id, displayName: ASSIGNEE.displayName };
  assert.deepEqual(completedBy(history), sam, "the task was completed, by the person who pressed");
  assert.deepEqual(archivedBy(history), sam, "and archived, by the same person");

  const closing = history.filter((e) => e.action === "TASK_COMPLETED" || e.action === "TASK_ARCHIVED");
  assert.deepEqual(
    closing.map((e) => e.action),
    ["TASK_COMPLETED", "TASK_ARCHIVED"],
    "both rows, in the order the two things happened — the record does not lose a step because the UI merged one"
  );
});

await check("service: nothing lands half-written when the move is refused", async () => {
  // The other half of "a partial failure cannot leave the task completed but
  // unarchived": a refused confirm writes neither row and moves nothing.
  const ctx = await setup();
  const sentBack = await awaitingConfirmation(ctx.service);

  await assert.rejects(() => ctx.service.transitionStatus(sentBack.id, "COMPLETED", OTHER));

  const stored = await ctx.store.findTask(sentBack.id);
  assert.equal(stored.status, "CLAIMED", "the task is exactly where it was");
  assert.equal(stored.archivedAt, undefined);
  assert.equal(stored.completedAt, undefined);
  const actions = await actionsOn(ctx.service, sentBack.id);
  assert.equal(actions.includes("TASK_COMPLETED"), false);
  assert.equal(actions.includes("TASK_ARCHIVED"), false);
});

await check("service: the creator finds it in their finished work afterwards", async () => {
  const ctx = await setup();
  const sentBack = await awaitingConfirmation(ctx.service);
  await ctx.service.transitionStatus(sentBack.id, "COMPLETED", ASSIGNEE);

  const listed = (await ctx.service.listTasks()).find((t) => t.id === sentBack.id);
  assert.ok(listed, "the task is still theirs to look at — archived is filed, not deleted");
  assert.equal(listed.createdBy.id, CREATOR.id);
  assert.equal(listed.status, "ARCHIVED");
  assert.ok(listed.completedAt, "and it reads as work that landed, not as something dropped");
});

await check("service: the creator still hears that their task landed", async () => {
  const ctx = await setup();
  const sentBack = await awaitingConfirmation(ctx.service);

  const { emitted } = await capture(ctx, () => ctx.service.transitionStatus(sentBack.id, "COMPLETED", ASSIGNEE));

  const toCreator = emitted.filter((e) => e.target === "DM" && (e.recipientUserIds ?? []).includes(CREATOR.id));
  assert.equal(toCreator.length, 1, "collapsing the two steps does not cost them the notice (#239)");
  assert.equal(
    emitted.filter((e) => e.target === "DM" && (e.recipientUserIds ?? []).includes(ASSIGNEE.id)).length,
    0,
    "and nobody hears about their own press"
  );

  const feed = emitted.filter((e) => e.target === "IN_APP");
  assert.equal(feed.length, 1);
  assert.match(feed[0].message, /ARCHIVED/, "the feed names where the task actually went");
  assert.doesNotMatch(feed[0].message, /COMPLETED/, "not a status it never rests in");
  assert.equal(feed[0].type, "TASK_ARCHIVED");
});

// ---------------------------------------------------------------------------
// 3. Every other path is untouched — the reason rule 5 is scoped this narrowly
// ---------------------------------------------------------------------------

await check("service: an ordinary completion completes and waits, exactly as before", async () => {
  const ctx = await setup();
  const held = await claimedLoi(ctx.service);

  const completed = await ctx.service.transitionStatus(held.id, "COMPLETED", ASSIGNEE);
  assert.equal(completed.status, "COMPLETED", "the creator gets to see it land as done before it goes away");
  assert.equal(completed.archivedAt, undefined);
  const actions = await actionsOn(ctx.service, held.id);
  assert.equal(actions.includes("TASK_ARCHIVED"), false, "and nothing pretends it was archived");
});

await check("service: the creator's own close from corrections completes and waits", async () => {
  // Rule 2's common case, and NOT rule 5's: the creator closing their own task
  // is not somebody being handed housekeeping, so it keeps the ordinary two
  // steps and their existing archive control.
  const ctx = await setup();
  const held = await claimedLoi(ctx.service);
  await ctx.service.transitionStatus(held.id, "NEEDS_REVIEW", ASSIGNEE, "typo");

  const closed = await ctx.service.transitionStatus(held.id, "COMPLETED", CREATOR);
  assert.equal(closed.status, "COMPLETED");
  assert.equal(closed.archivedAt, undefined);
});

await check("service: a new holder ends the confirming look", async () => {
  // The creator asked a particular checker to look again. A task that has been
  // to the pool and back is the next person's own work, and their Complete is
  // an ordinary completion — the safe direction to fall back in.
  const ctx = await setup();
  const sentBack = await awaitingConfirmation(ctx.service);
  await ctx.service.unclaimTask(sentBack.id, ASSIGNEE);
  const reclaimed = await ctx.service.claimTask(sentBack.id, OTHER);
  assert.equal(reclaimed.awaitingConfirmationFrom, undefined);

  const completed = await ctx.service.transitionStatus(sentBack.id, "COMPLETED", OTHER);
  assert.equal(completed.status, "COMPLETED", "a stranger's press does not quietly archive the task");
});

await check("service: sending the task back to corrections again drops the breadcrumb", async () => {
  // The loop restarting is not the tail of the loop. The assignee found
  // something else, so the ball is with the creator again and the next close
  // is whatever that round makes it.
  const ctx = await setup();
  const sentBack = await awaitingConfirmation(ctx.service);
  const again = await ctx.service.transitionStatus(sentBack.id, "NEEDS_REVIEW", ASSIGNEE, "still not right");
  assert.equal(again.awaitingConfirmationFrom, undefined);

  const closed = await ctx.service.transitionStatus(sentBack.id, "COMPLETED", CREATOR);
  assert.equal(closed.status, "COMPLETED");
});

await check("service: the retention sweep is unchanged", async () => {
  const ctx = await setup();
  const held = await claimedLoi(ctx.service);
  await ctx.service.transitionStatus(held.id, "COMPLETED", ASSIGNEE);

  const later = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
  const result = await ctx.service.runMaintenance(later);
  assert.equal(result.autoArchived, 1, "an ordinary completion still ages into the sweep");

  const history = await ctx.service.getHistory(held.id);
  assert.deepEqual(
    archivedBy(history),
    { id: SYSTEM_ACTOR.id, displayName: SYSTEM_ACTOR.displayName },
    "and still archives as the system"
  );
});

await check("service: a confirmed task is already gone by the time the sweep runs", async () => {
  const ctx = await setup();
  const sentBack = await awaitingConfirmation(ctx.service);
  await ctx.service.transitionStatus(sentBack.id, "COMPLETED", ASSIGNEE);

  const later = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
  const result = await ctx.service.runMaintenance(later);
  assert.equal(result.autoArchived, 0, "nothing left for the sweep to tidy — which is the whole point");

  const archives = (await ctx.service.getHistory(sentBack.id)).filter((e) => e.action === "TASK_ARCHIVED");
  assert.equal(archives.length, 1, "and no second archival row on top of the one the confirm wrote");
});

console.log(`\nAll ${passed} confirm-and-archive checks passed.`);
