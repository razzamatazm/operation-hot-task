#!/usr/bin/env node
/*
 * Overlapping activity-signal evaluations (#341).
 *
 * `TaskService` evaluates activity signals after most task changes and on every
 * maintenance pass. It used to read the whole activity-feed state, work out the
 * next state from that copy, and write it back as a separate step. Anything
 * saved in between was overwritten, and two evaluations that read the same copy
 * both saw each signal as new and both alerted.
 *
 * Background work is chained per task, and the maintenance pass sits outside
 * any chain, so evaluations do overlap in production. These checks drive the
 * real `TaskService` against temp-file stores and a recording notifier, and
 * compare overlapping runs against a single run so nothing here hardcodes who
 * is eligible for which signal.
 *
 * The evaluation is private in TypeScript; the compiled JS reaches it directly.
 *
 * Run: `node --test scripts/activity-feed-overlap-sim-test.mjs`.
 */
import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { ActivityFeedStateStore } from "../apps/server/dist/activity-feed-state.js";
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
const PEOPLE = [
  { id: "officer-1", displayName: "Sam Officer", roles: ["LOAN_OFFICER"] },
  { id: "officer-2", displayName: "Lee Officer", roles: ["LOAN_OFFICER"] },
  { id: "checker-1", displayName: "Casey Checker", roles: ["FILE_CHECKER"] }
];
const LATECOMER = { id: "officer-3", displayName: "Jo Latecomer", roles: ["LOAN_OFFICER"] };

/* Wednesdays, 10:00 in Los Angeles: inside business hours, a week apart, so a
   reminder is due on the second whatever the reminder interval is. */
const WEEK_ONE = new Date("2026-09-02T17:00:00.000Z");
const WEEK_TWO = new Date("2026-09-09T17:00:00.000Z");

const root = mkdtempSync(path.join(os.tmpdir(), "activity-feed-overlap-"));
after(() => rmSync(root, { recursive: true, force: true }));
let dirs = 0;
const freshDir = () => {
  dirs += 1;
  const dir = path.join(root, String(dirs));
  fs.mkdirSync(dir);
  return dir;
};

const recordingNotifier = () => {
  const events = [];
  return {
    events,
    notify: async (event) => {
      events.push(event);
    },
    canReachDm: async () => true
  };
};

const feedAlerts = (events) => events.filter((event) => event.target === "ACTIVITY_FEED");

/* A service on a fresh task file and a fresh activity-feed file. */
const setup = async () => {
  const dir = freshDir();
  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.init();
  const feedState = new ActivityFeedStateStore(path.join(dir, "activity-feed.json"));
  await feedState.init();
  const notifier = recordingNotifier();
  const service = new TaskService(store, notifier, new SseHub(), config, feedState);
  return { dir, store, feedState, notifier, service };
};

/* A task file holding one open task, filed by a service with no activity feed
   so no signal is recorded yet. Each call to `withFeed` puts a fresh service and
   a fresh activity-feed file over that same task file. */
const openTaskWorld = async () => {
  const dir = freshDir();
  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.init();
  const filer = new TaskService(store, recordingNotifier(), new SseHub(), config);
  await filer.createTask({ folderName: "Overlap Sim", taskType: "VALUE", notes: "n" }, CREATOR);
  await filer.settleBackgroundWork();

  let feeds = 0;
  const withFeed = async () => {
    feeds += 1;
    const feedState = new ActivityFeedStateStore(path.join(dir, `activity-feed-${feeds}.json`));
    await feedState.init();
    const notifier = recordingNotifier();
    const service = new TaskService(store, notifier, new SseHub(), config, feedState);
    for (const person of PEOPLE) {
      await service.registerUser(person);
    }
    return { feedState, notifier, service };
  };
  return { withFeed };
};

test("a user recorded while an evaluation is in flight is still stored afterwards", async () => {
  const { withFeed } = await openTaskWorld();
  const { feedState, service } = await withFeed();

  /* Record the latecomer the moment the evaluation first loads the feed file, so
     their save is queued behind that load and ahead of anything the evaluation
     queues after it. */
  const file = feedState.file;
  const load = file.load.bind(file);
  let registering;
  file.load = async () => {
    const loaded = await load();
    if (!registering) {
      registering = service.registerUser(LATECOMER);
    }
    return loaded;
  };

  await service.evaluateActivitySignals({ now: WEEK_ONE });
  assert.ok(registering, "the evaluation never loaded the activity-feed file");
  await registering;
  file.load = load;

  const { users } = await feedState.read();
  assert.ok(
    users.some((user) => user.id === LATECOMER.id),
    `latecomer missing from stored users: ${users.map((user) => user.id).join(", ")}`
  );
});

test("two evaluations at once alert no more than one evaluation does", async () => {
  const world = await openTaskWorld();

  const single = await world.withFeed();
  await single.service.evaluateActivitySignals({ now: WEEK_ONE });
  const expected = feedAlerts(single.notifier.events).length;
  assert.ok(expected > 0, "a single evaluation sent no activity-feed alert, so this test proves nothing");

  const overlapping = await world.withFeed();
  await Promise.all([
    overlapping.service.evaluateActivitySignals({ now: WEEK_ONE }),
    overlapping.service.evaluateActivitySignals({ now: WEEK_ONE })
  ]);
  assert.equal(feedAlerts(overlapping.notifier.events).length, expected);
});

test("two overlapping maintenance-style evaluations send each reminder once", async () => {
  const world = await openTaskWorld();

  const single = await world.withFeed();
  await single.service.evaluateActivitySignals({ now: WEEK_ONE });
  single.notifier.events.length = 0;
  await single.service.evaluateActivitySignals({ now: WEEK_TWO, allowReminders: true });
  const expected = feedAlerts(single.notifier.events).length;
  assert.ok(expected > 0, "a single reminder pass sent nothing, so this test proves nothing");

  const overlapping = await world.withFeed();
  await overlapping.service.evaluateActivitySignals({ now: WEEK_ONE });
  overlapping.notifier.events.length = 0;
  await Promise.all([
    overlapping.service.evaluateActivitySignals({ now: WEEK_TWO, allowReminders: true }),
    overlapping.service.evaluateActivitySignals({ now: WEEK_TWO, allowReminders: true })
  ]);
  assert.equal(feedAlerts(overlapping.notifier.events).length, expected);
});

test("alertOnNewSignals: false records new signals without alerting", async () => {
  const world = await openTaskWorld();
  const { feedState, notifier, service } = await world.withFeed();

  await service.evaluateActivitySignals({ now: WEEK_ONE, alertOnNewSignals: false });
  assert.equal(feedAlerts(notifier.events).length, 0);
  const { signals } = await feedState.read();
  assert.ok(signals.length > 0, "no signal was recorded");

  /* Recorded, so a normal evaluation afterwards finds nothing new to alert. */
  await service.evaluateActivitySignals({ now: WEEK_ONE });
  assert.equal(feedAlerts(notifier.events).length, 0);
});

/* Alerts as "recipient → folder" pairs, counted. */
const alertPairs = (events) => {
  const counts = new Map();
  for (const event of feedAlerts(events)) {
    for (const recipient of event.recipientUserIds ?? []) {
      const pair = `${recipient} -> ${event.task.folderName}`;
      counts.set(pair, (counts.get(pair) ?? 0) + 1);
    }
  }
  return counts;
};

test("two tasks created at once alert each person once per task", async () => {
  const sequential = await setup();
  for (const person of PEOPLE) {
    await sequential.service.registerUser(person);
  }
  await sequential.service.createTask({ folderName: "Overlap A", taskType: "VALUE", notes: "n" }, CREATOR);
  await sequential.service.settleBackgroundWork();
  await sequential.service.createTask({ folderName: "Overlap B", taskType: "VALUE", notes: "n" }, CREATOR);
  await sequential.service.settleBackgroundWork();
  const expected = alertPairs(sequential.notifier.events);
  assert.ok(
    [...expected.keys()].some((pair) => pair.endsWith("Overlap A")) &&
      [...expected.keys()].some((pair) => pair.endsWith("Overlap B")),
    "sequential creates did not alert anyone for both tasks, so this test proves nothing"
  );

  const concurrent = await setup();
  for (const person of PEOPLE) {
    await concurrent.service.registerUser(person);
  }
  await Promise.all([
    concurrent.service.createTask({ folderName: "Overlap A", taskType: "VALUE", notes: "n" }, CREATOR),
    concurrent.service.createTask({ folderName: "Overlap B", taskType: "VALUE", notes: "n" }, CREATOR)
  ]);
  await concurrent.service.settleBackgroundWork();

  assert.deepEqual(
    Object.fromEntries([...alertPairs(concurrent.notifier.events)].sort()),
    Object.fromEntries([...expected].sort())
  );
});

/* #361. The maintenance pass gathers its tasks up front. If it handed that list
   to the evaluation, a task change saved in between — along with the signals its
   own evaluation recorded — would be missing from it, the pass would drop those
   signals, and the next evaluation would alert for them a second time. */
test("a task change landing mid maintenance pass keeps its signals and alerts each person once", async () => {
  const { feedState, notifier, service } = await setup();
  for (const person of PEOPLE) {
    await service.registerUser(person);
  }

  /* Hold the pass at the point it hands over to the evaluation — after it has
     gathered tasks and saved its own changes — and land a task change there,
     letting that change's own evaluation finish before the pass carries on. */
  let landed;
  service.evaluateActivitySignals = async (args) => {
    delete service.evaluateActivitySignals;
    landed = await service.createTask({ folderName: "Mid Pass", taskType: "VALUE", notes: "n" }, CREATOR);
    await service.settleBackgroundWork();
    return service.evaluateActivitySignals(args);
  };

  await service.runMaintenance(new Date());
  assert.ok(landed, "the maintenance pass never reached its evaluation");

  const { signals } = await feedState.read();
  assert.ok(
    signals.some((signal) => signal.taskId === landed.id),
    "the signals the task change recorded were dropped by the maintenance pass"
  );

  /* The next evaluation must find nothing new for that task. */
  await service.evaluateActivitySignals({ now: new Date() });
  const pairs = [...alertPairs(notifier.events)].filter(([pair]) => pair.endsWith("Mid Pass"));
  assert.ok(pairs.length > 0, "nobody was alerted for the task change, so this test proves nothing");
  assert.deepEqual(
    pairs.filter(([, count]) => count !== 1),
    [],
    "someone was alerted more than once for the same task change"
  );
});
