#!/usr/bin/env node
/*
 * Issue #495: a Create the browser gave up on (10s timeout, #468) may already
 * be filed. Pressing Create again sends the same key, and the server must hand
 * back the task it filed rather than file a second one and repeat its Teams
 * notifications. Runs the real TaskService on a temp-file store whose writes
 * we can hold, so the "slow but alive" server is a gate, not a sleep.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
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

await check("timed out, then Start fresh and the same values typed again: a second task is filed", async () => {
  const { service } = await setup();
  const slow = slowWrites(service["store"]);
  const first = pressCreate(service, null, input(), 20);
  await assert.rejects(first.answer, /Failed to fetch/);
  slow.open();
  await first.sent;
  // Start fresh (or an import, or a new opening) forgets the last attempt.
  const again = pressCreate(service, null, input(), 1_000);
  await again.answer;
  assert.notEqual(again.attempt.key, first.attempt.key);
  assert.equal((await service.listTasks()).length, 2);
});

await check("the New Task form keys its Create payload, and forgets the key on Start fresh, import and a new opening", async () => {
  const source = await fs.readFile(new URL("../apps/web/src/task-form.tsx", import.meta.url), "utf8");
  assert.match(source, /lastCreate\.current = keyCreateAttempt\(lastCreate\.current, payload\);\s*payload\.createKey = lastCreate\.current\.key;/);
  const body = (name) => {
    const start = source.indexOf(`const ${name} = (`);
    assert.ok(start >= 0, `${name} is still in the form`);
    return source.slice(start, source.indexOf("\n  };\n", start));
  };
  assert.match(body("startFresh"), /lastCreate\.current = null;/);
  assert.match(body("importFromHumperdink"), /lastCreate\.current = null;/);
  assert.match(source, /useEffect\(\(\) => \{\s*lastCreate\.current = null;\s*\}, \[live\?\.mode\]\);/);
});

/* Over HTTP: a born-assigned Create files and its answer is lost, then the
   recipient is deactivated before the retry. The retry still gets the filed
   task, not "User not found". Runs the built server on a free port with its
   own temp files, restarting it between the two presses. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const startServer = async (dir) => {
  const port = await freePort();
  const child = spawn(process.execPath, ["apps/server/dist/index.js"], {
    cwd: path.join(path.dirname(new URL(import.meta.url).pathname), ".."),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_FILE: path.join(dir, "tasks.json"),
      BOT_REFERENCES_FILE: path.join(dir, "bot-references.json"),
      ACTIVITY_FEED_STATE_FILE: path.join(dir, "activity-feed-state.json"),
      USERS_FILE: path.join(dir, "users.json"),
      ADMIN_SETTINGS_FILE: path.join(dir, "admin-settings.json"),
      SAVED_FOR_LATER_FILE: path.join(dir, "saved-for-later.json")
    },
    stdio: "ignore"
  });
  const base = `http://127.0.0.1:${port}/api`;
  for (let i = 0; i < 40; i += 1) {
    const ok = await fetch(`${base}/health`).then((r) => r.ok, () => false);
    if (ok) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const stop = () =>
    new Promise((resolve) => {
      child.once("exit", resolve);
      child.kill("SIGTERM");
    });
  return { base, stop };
};

const person = (id, displayName, roles, active = true) => ({
  id,
  displayName,
  roles,
  active,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: "2026-01-01T00:00:00.000Z"
});

await check("a born-assigned retry gets the filed task even after the recipient was deactivated", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "create-retry-http-"));
  const usersFile = path.join(dir, "users.json");
  const creator = person("creator-1", "Dana Requester", ["LOAN_OFFICER"]);
  const recipient = person("checker-1", "Casey Checker", ["FILE_CHECKER"]);
  await fs.writeFile(usersFile, JSON.stringify({ users: [creator, recipient] }), "utf8");
  const headers = { "content-type": "application/json", "x-user-id": creator.id, "x-user-name": creator.displayName, "x-user-roles": "LOAN_OFFICER" };
  const body = JSON.stringify({ folderName: "Handoff Retry", taskType: "VALUE", notes: "n", assigneeUserId: recipient.id, createKey: "key-http" });

  const first = await startServer(dir);
  const filed = await fetch(`${first.base}/tasks`, { method: "POST", headers, body });
  assert.equal(filed.status, 201, await filed.clone().text());
  const { task } = await filed.json();
  await first.stop();

  const users = JSON.parse(await fs.readFile(usersFile, "utf8"));
  users.users = users.users.map((u) => (u.id === recipient.id ? { ...u, active: false } : u));
  await fs.writeFile(usersFile, JSON.stringify(users), "utf8");

  const second = await startServer(dir);
  try {
    const retry = await fetch(`${second.base}/tasks`, { method: "POST", headers, body });
    assert.equal(retry.status, 201, await retry.clone().text());
    assert.equal((await retry.json()).task.id, task.id);
    const { tasks } = await (await fetch(`${second.base}/tasks`, { headers })).json();
    assert.equal(tasks.length, 1);
  } finally {
    await second.stop();
  }
});

console.log(`${passed} passed`);
