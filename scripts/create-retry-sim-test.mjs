#!/usr/bin/env node
/*
 * Issue #495: a Create the browser gave up on (10s timeout, #468) may already
 * be filed. Pressing Create again sends the same key, and the server must hand
 * back the task it filed rather than file a second one and repeat its Teams
 * notifications. Runs the real TaskService on a temp-file store whose writes
 * we can hold, so the "slow but alive" server is a gate, not a sleep.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TaskStore } from "../apps/server/dist/store.js";
import { SseHub } from "../apps/server/dist/sse.js";
import { TaskService } from "../apps/server/dist/task-service.js";
import { keyCreateAttempt } from "../apps/web/src/create-key.ts";
import { withRequestTimeout } from "../apps/web/src/request-timeout.ts";

const config = {
  businessTimezone: "America/Los_Angeles",
  businessStartHour: 8,
  businessStartMinute: 30,
  businessEndHour: 17,
  businessEndMinute: 30,
  archiveRetentionDays: 90
};

const CREATOR = { id: "creator-1", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] };
const OTHER = { id: "creator-2", displayName: "Riley Other", roles: ["LOAN_OFFICER"] };

const gate = () => {
  let open;
  const opened = new Promise((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
};

const setup = async (dir) => {
  const dataDir = dir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "create-retry-sim-")));
  const store = new TaskStore(path.join(dataDir, "tasks.json"));
  await store.init();
  const events = [];
  const notifier = {
    notify: async (event) => {
      events.push(event);
    },
    canReachDm: async () => true
  };
  const service = new TaskService(store, notifier, new SseHub(), config);
  return { service, store, events, dataDir };
};

/* Hold every task write until the test lets it go: the server is alive and
   doing the work, just slower than the browser is willing to wait. */
const slowWrites = (store) => {
  const held = gate();
  const original = store.upsertTask.bind(store);
  store.upsertTask = async (...args) => {
    await held.opened;
    return original(...args);
  };
  return held;
};

const input = (createKey) => ({ folderName: "Retry Sim", taskType: "VALUE", notes: "n", ...(createKey ? { createKey } : {}) });

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

console.log("Create retry after a timeout (#495)");

await check("a retry sent while the slow first attempt is still filing files one task", async () => {
  const { service, events } = await setup();
  const slow = slowWrites(service["store"]);
  const first = service.createTask(input("key-a"), CREATOR);
  const retry = service.createTask(input("key-a"), CREATOR);
  slow.open();
  const [a, b] = await Promise.all([first, retry]);
  await service.settleBackgroundWork();
  assert.equal(a.id, b.id, "the retry answers with the task the first attempt filed");
  assert.equal((await service.listTasks()).length, 1, "exactly one task on the board");
  assert.deepEqual(events.map((e) => e.target), ["IN_APP", "CHANNEL"], "notifications sent once");
});

await check("a retry sent after the slow first attempt landed files nothing new", async () => {
  const { service, events } = await setup();
  const slow = slowWrites(service["store"]);
  const first = service.createTask(input("key-b"), CREATOR);
  slow.open();
  const a = await first;
  await service.settleBackgroundWork();
  const b = await service.createTask(input("key-b"), CREATOR);
  await service.settleBackgroundWork();
  assert.equal(b.id, a.id);
  assert.equal((await service.listTasks()).length, 1);
  assert.deepEqual(events.map((e) => e.target), ["IN_APP", "CHANNEL"]);
});

await check("the key survives a server restart", async () => {
  const before = await setup();
  const a = await before.service.createTask(input("key-c"), CREATOR);
  await before.service.settleBackgroundWork();
  const after = await setup(before.dataDir);
  const b = await after.service.createTask(input("key-c"), CREATOR);
  await after.service.settleBackgroundWork();
  assert.equal(b.id, a.id);
  assert.equal((await after.service.listTasks()).length, 1);
  assert.equal(after.events.length, 0, "the restarted server sends nothing for the retry");
});

await check("a normal Create is unchanged: different keys, or none, file separate tasks", async () => {
  const { service, events } = await setup();
  await service.createTask(input("key-d"), CREATOR);
  await service.createTask(input("key-e"), CREATOR);
  await service.createTask(input(), CREATOR);
  await service.createTask(input(), CREATOR);
  await service.settleBackgroundWork();
  assert.equal((await service.listTasks()).length, 4);
  assert.equal(events.length, 8);
});

await check("someone else's key never hands back their task", async () => {
  const { service } = await setup();
  const mine = await service.createTask(input("key-f"), CREATOR);
  const theirs = await service.createTask(input("key-f"), OTHER);
  assert.notEqual(theirs.id, mine.id);
  assert.equal(theirs.createdBy.id, OTHER.id);
});

await check("a first attempt that failed leaves the key free for the retry", async () => {
  const { service } = await setup();
  const original = service["store"].upsertTask.bind(service["store"]);
  service["store"].upsertTask = async () => {
    throw new Error("disk full");
  };
  await assert.rejects(service.createTask(input("key-g"), CREATOR));
  service["store"].upsertTask = original;
  const task = await service.createTask(input("key-g"), CREATOR);
  assert.ok(task.id);
  assert.equal((await service.listTasks()).length, 1);
});

/* The browser's side: the form keys each Create with keyCreateAttempt and the
   request gives up after the #468 timeout, while the slow server files anyway. */
const pressCreate = (service, last, payload, timeoutMs) => {
  const attempt = keyCreateAttempt(last, payload);
  const sent = service.createTask({ ...payload, createKey: attempt.key }, CREATOR);
  return { attempt, answer: withRequestTimeout(() => sent, timeoutMs), sent };
};

await check("timed out, then Create pressed again unchanged: one task, one set of notifications", async () => {
  const { service, events } = await setup();
  const slow = slowWrites(service["store"]);
  const payload = input();
  const first = pressCreate(service, null, payload, 20);
  await assert.rejects(first.answer, /Failed to fetch/);
  slow.open();
  await first.sent;
  const retry = pressCreate(service, first.attempt, input(), 1_000);
  const task = await retry.answer;
  await service.settleBackgroundWork();
  assert.equal(retry.attempt.key, first.attempt.key, "an unchanged retry keeps its key");
  assert.equal((await service.listTasks()).length, 1);
  assert.equal(task.id, (await first.sent).id);
  assert.deepEqual(events.map((e) => e.target), ["IN_APP", "CHANNEL"]);
});

await check("timed out, then a different task from the same form (Start fresh, import): both are filed", async () => {
  const { service } = await setup();
  const slow = slowWrites(service["store"]);
  const first = pressCreate(service, null, input(), 20);
  await assert.rejects(first.answer, /Failed to fetch/);
  slow.open();
  await first.sent;
  const next = pressCreate(service, first.attempt, { folderName: "Another Loan", taskType: "LOI", notes: "m" }, 1_000);
  const task = await next.answer;
  assert.notEqual(next.attempt.key, first.attempt.key);
  assert.equal(task.folderName, "Another Loan");
  assert.equal((await service.listTasks()).length, 2);
});

await check("the New Task form keys its Create payload", async () => {
  const source = await fs.readFile(new URL("../apps/web/src/task-form.tsx", import.meta.url), "utf8");
  assert.match(source, /lastCreate\.current = keyCreateAttempt\(lastCreate\.current, payload\);\s*payload\.createKey = lastCreate\.current\.key;/);
});

console.log(`${passed} passed`);
