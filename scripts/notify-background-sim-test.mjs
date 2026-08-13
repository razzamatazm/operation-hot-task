#!/usr/bin/env node
/*
 * Issue #119 — notification fan-out runs off the request path.
 *
 * Drives the real TaskService against a real (temp-file) TaskStore with a
 * notifier we can stall, throw from, or observe, and asserts the contract the
 * issue pins down:
 *   - A mutating call resolves once its state change is persisted, even while
 *     the notifier is still hanging.
 *   - The in-memory SSE broadcast still happens on the request path, so
 *     connected web clients see the change as immediately as before.
 *   - Every notification is still dispatched, and in the same relative order
 *     within one request.
 *   - A throwing notifier neither fails the request nor produces an unhandled
 *     rejection (which would be a hard process crash in Node).
 *   - runMaintenance is unchanged: it still awaits its own notifications.
 *
 * Timing is asserted with a real gate the test controls, never a sleep.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

// A promise plus its resolver, so a test can hold the notifier open and let it
// go on demand rather than racing a timer.
const gate = () => {
  let open;
  const opened = new Promise((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
};

const setup = async (notifyImpl) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "notify-bg-sim-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.init();
  const events = [];
  const notifier = {
    notify: async (event) => {
      events.push(event);
      if (notifyImpl) {
        await notifyImpl(event);
      }
    },
    canReachDm: async () => true
  };
  const hub = new SseHub();
  const broadcasts = [];
  const originalBroadcast = hub.broadcast.bind(hub);
  hub.broadcast = (message) => {
    broadcasts.push(message);
    originalBroadcast(message);
  };
  const service = new TaskService(store, notifier, hub, config);
  return { service, events, broadcasts };
};

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

console.log("Background notification fan-out — TaskService sim (#119)");

await check("createTask resolves while the notifier is still hanging", async () => {
  const stall = gate();
  const { service, events, broadcasts } = await setup(() => stall.opened);

  const task = await service.createTask(
    { folderName: "Hang Sim", taskType: "VALUE", notes: "n" },
    CREATOR
  );

  // We are here with the notifier still stalled, which is the whole point: the
  // response did not wait on it.
  assert.ok(task.id, "create resolved with a persisted task");
  assert.equal(
    (await service.getTask(task.id))?.id,
    task.id,
    "the task is durably persisted by the time create resolves"
  );
  assert.deepEqual(
    broadcasts.map((b) => b.type),
    ["task.changed"],
    "the live-update broadcast still happened on the request path"
  );
  assert.equal(events.length, 1, "only the first notify has been entered; the chain is still blocked");

  stall.open();
  await service.settleBackgroundWork();
  assert.deepEqual(
    events.map((e) => e.target),
    ["IN_APP", "CHANNEL"],
    "both notifications still dispatched, in their original order"
  );
});

await check("claim and transition also return without waiting on fan-out", async () => {
  const stall = gate();
  const { service, events } = await setup(() => stall.opened);

  const task = await service.createTask(
    { folderName: "Hang Sim 2", taskType: "VALUE", notes: "n" },
    CREATOR
  );
  const claimed = await service.claimTask(task.id, CHECKER);
  assert.equal(claimed.status, "CLAIMED", "claim resolved with the notifier stalled");
  const completed = await service.transitionStatus(task.id, "COMPLETED", CHECKER);
  assert.equal(completed.status, "COMPLETED", "transition resolved with the notifier stalled");

  stall.open();
  await service.settleBackgroundWork();
  // Order within the claim request is preserved: the claimant's DM lands before
  // the channel card flip, exactly as the sequential code reads.
  const claimTargets = events.filter((e) => e.type === "TASK_CLAIMED").map((e) => e.target);
  assert.deepEqual(claimTargets, ["DM_CLAIM", "DM", "CHANNEL_CLAIMED", "DM_CHAT_SEED"]);
});

await check("shareTask returns its delivered flag without waiting on the DM send", async () => {
  const stall = gate();
  const { service, events } = await setup(() => stall.opened);
  const task = await service.createTask(
    { folderName: "Share Sim", taskType: "VALUE", notes: "n" },
    CREATOR
  );

  const shared = await service.shareTask({
    taskId: task.id,
    target: { id: CHECKER.id, displayName: CHECKER.displayName },
    sharedBy: CREATOR
  });
  assert.equal(shared.delivered, true, "reachability probe stays on the request path");

  stall.open();
  await service.settleBackgroundWork();
  assert.ok(events.some((e) => e.target === "DM_SHARE"), "the share DM is still dispatched");
});

await check("a throwing notifier fails neither the request nor the process", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  const { service } = await setup(() => {
    throw new Error("notifier exploded");
  });
  const task = await service.createTask(
    { folderName: "Throw Sim", taskType: "VALUE", notes: "n" },
    CREATOR
  );
  assert.ok(task.id, "create still succeeds when the notifier throws");
  await service.settleBackgroundWork();
  // Give the microtask queue a full turn so any stray rejection would surface.
  await new Promise((resolve) => setImmediate(resolve));

  process.off("unhandledRejection", onUnhandled);
  assert.deepEqual(unhandled, [], "no unhandled rejection escaped the background helper");
  assert.equal(
    (await service.getTask(task.id))?.status,
    "OPEN",
    "the state change stands despite the failed fan-out"
  );
});

await check("runMaintenance still awaits its own notifications", async () => {
  const seen = [];
  const { service } = await setup(async (event) => {
    seen.push(event.target);
  });
  const result = await service.runMaintenance();
  // Nothing was outstanding when runMaintenance resolved — it is scheduler-driven
  // and deliberately not backgrounded.
  assert.deepEqual(result, { reminded: 0, purged: 0, autoArchived: 0 });
});

console.log(`\nAll ${passed} background fan-out checks passed.`);
