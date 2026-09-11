#!/usr/bin/env node
/*
 * A read that lands while a save is half-written (#331).
 *
 * The file-backed stores rewrite their whole file on every save, and a
 * whole-file write truncates before it fills. A read taken in that gap got an
 * empty or partial file, `JSON.parse` threw, and the caller's work was dropped.
 * A loan rename made the gap routine: it saves one task, starts that task's
 * card correction in the background, and saves the next task while the
 * correction is looking the first one up — so a channel card silently kept the
 * old loan name. The loan-card correction sim caught it in CI and was written
 * off as a flaky test (#320).
 *
 * On a fast local disk the gap closes too quickly to land in on purpose, so
 * looping a test does not reproduce it. These checks hold one save open
 * between its truncate and its fill, start a read in that moment, and let the
 * save finish only once any file read that started has come back. No sleeps:
 * a read that goes to the file mid-save always sees the torn file, and a read
 * that waits its turn never touches the file until the save is done. The
 * promise under test: the read returns the saved state, never an error and
 * never a torn file. The filesystem is the only thing stubbed.
 *
 * #280 gave the bot's card-record store the same guarantee; these cover the
 * stores it missed: tasks, loans and the bot's conversation references (#331),
 * then admin settings, users and the activity-feed state (#339). Settings is
 * the quiet one: its read swallowed the parse error and answered "no channel
 * chosen", which sends a notification to every channel instead of one.
 *
 * Run: `node --test scripts/store-read-during-write-sim-test.mjs`.
 */
import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { ActivityFeedStateStore } from "../apps/server/dist/activity-feed-state.js";
import { ReferenceStore } from "../apps/server/dist/bot.js";
import { SettingsStore } from "../apps/server/dist/settings-store.js";
import { LoanStore, TaskStore } from "../apps/server/dist/store.js";
import { UserStore } from "../apps/server/dist/user-store.js";

const root = mkdtempSync(path.join(os.tmpdir(), "store-read-during-write-"));
after(() => rmSync(root, { recursive: true, force: true }));
let dirs = 0;
const fileIn = (name) => {
  dirs += 1;
  const dir = path.join(root, String(dirs));
  fs.mkdirSync(dir);
  return path.join(dir, name);
};

/* Hold the next save to `file` open between the truncate and the fill. Every
   store here goes through the shared `fs.promises` object, so wrapping its
   `writeFile` and `readFile` for the length of one save is the whole seam.

   `release` is what keeps this deterministic. Letting the fill go the instant
   the read is started would race the fill against the read on the I/O pool, and
   the read would sometimes win and sometimes lose. So `release` first lets every
   pending callback run — a read that goes straight to the file has asked for it
   by then — and then waits for each read of the file that is still in flight
   before the fill is written. */
const holdNextWrite = (file) => {
  const { writeFile, readFile } = fs.promises;
  const inFlight = new Set();
  let fill;
  const filling = new Promise((resolve) => (fill = resolve));
  let truncatedNow;
  const truncated = new Promise((resolve) => (truncatedNow = resolve));

  fs.promises.readFile = (target, ...rest) => {
    const reading = readFile.call(fs.promises, target, ...rest);
    if (target === file) {
      const settled = reading.then(
        () => undefined,
        () => undefined
      );
      inFlight.add(settled);
    }
    return reading;
  };
  fs.promises.writeFile = async (target, data, options) => {
    if (target !== file) {
      return writeFile.call(fs.promises, target, data, options);
    }
    fs.promises.writeFile = writeFile;
    await writeFile.call(fs.promises, target, "", options);
    truncatedNow();
    await filling;
    fs.promises.readFile = readFile;
    return writeFile.call(fs.promises, target, data, options);
  };

  const release = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.all(inFlight);
    fill();
  };
  return { truncated, release };
};

/* A read's outcome, captured the moment it settles, so a rejection during the
   hold is reported as the failure it is rather than as an unhandled rejection. */
const outcome = (promise) =>
  promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  );

const assertRead = (result, label) => {
  assert.ok(result.ok, `${label} failed mid-save: ${result.error?.message}`);
  return result.value;
};

const at = "2026-09-11T12:00:00.000Z";
const task = (id, name) => ({
  id,
  loanId: "loan-1",
  folderName: name,
  loanName: name,
  taskType: "LOI",
  status: "OPEN",
  urgency: "GREEN",
  points: 2,
  notes: "",
  createdBy: { id: "creator-1", displayName: "Dana Requester" },
  createdAt: at,
  updatedAt: at,
  messages: []
});

test("a task looked up while a save is half-written comes back as saved", async () => {
  const file = fileIn("tasks.json");
  const store = new TaskStore(file);
  await store.init();
  await store.upsertTask(task("task-1", "Smith-1042"));

  const hold = holdNextWrite(file);
  const saving = store.updateTask("task-1", (current) => ({
    task: { ...current, folderName: "Smith-1043", loanName: "Smith-1043" }
  }));
  await hold.truncated;
  const found = outcome(store.findTask("task-1"));
  const listed = outcome(store.allTasks());
  const history = outcome(store.allHistoryForTask("task-1"));
  await hold.release();
  await saving;

  assert.equal(assertRead(await found, "findTask")?.folderName, "Smith-1043");
  assert.deepEqual(
    assertRead(await listed, "allTasks").map((entry) => entry.folderName),
    ["Smith-1043"]
  );
  assert.deepEqual(assertRead(await history, "allHistoryForTask"), []);
});

test("a loan looked up while a save is half-written comes back as saved", async () => {
  const file = fileIn("loans.json");
  const store = new LoanStore(file);
  await store.init();
  await store.upsert({ id: "loan-1", name: "Smith-1042", createdAt: at, updatedAt: at });

  const hold = holdNextWrite(file);
  const saving = store.upsert({ id: "loan-1", name: "Smith-1043", createdAt: at, updatedAt: at });
  await hold.truncated;
  const found = outcome(store.find("loan-1"));
  const listed = outcome(store.all());
  await hold.release();
  await saving;

  assert.equal(assertRead(await found, "find")?.name, "Smith-1043");
  assert.deepEqual(
    assertRead(await listed, "all").map((loan) => loan.name),
    ["Smith-1043"]
  );
});

test("conversation references read while a save is half-written come back as saved", async () => {
  const file = fileIn("bot-references.json");
  const store = new ReferenceStore(file);
  await store.init();
  const channel = { key: "channel:general", scope: "CHANNEL", reference: { conversation: { id: "19:general" } } };
  await store.save(channel);

  const hold = holdNextWrite(file);
  const dm = { key: "dm:creator-1", scope: "DM", userAadObjectId: "creator-1", reference: { conversation: { id: "dm-creator" } } };
  const saving = store.save(dm);
  await hold.truncated;
  const read = outcome(store.read());
  await hold.release();
  await saving;

  assert.deepEqual(
    assertRead(await read, "read").map((entry) => entry.key),
    ["channel:general", "dm:creator-1"]
  );
});

test("the notification channel read while a save is half-written is the one just saved", async () => {
  // The failure here was silent: the torn read was caught and answered with
  // empty settings, and empty means "no channel chosen" — broadcast to all.
  const file = fileIn("admin-settings.json");
  const store = new SettingsStore(file);
  await store.init();
  await store.setNotificationChannelId("19:chosen@thread.tacv2");

  const hold = holdNextWrite(file);
  const saving = store.setNotificationChannelId("19:moved@thread.tacv2");
  await hold.truncated;
  const channel = outcome(store.getNotificationChannelId());
  const settings = outcome(store.read());
  await hold.release();
  await saving;

  assert.equal(assertRead(await channel, "getNotificationChannelId"), "19:moved@thread.tacv2");
  assert.deepEqual(assertRead(await settings, "read"), { notificationChannelId: "19:moved@thread.tacv2" });
});

test("a user looked up while a save is half-written comes back as saved", async () => {
  const file = fileIn("users.json");
  const store = new UserStore(file);
  await store.init();
  await store.seed({ id: "checker-1", displayName: "Casey Checker", roles: ["LOAN_OFFICER"] });

  const hold = holdNextWrite(file);
  const saving = store.setRoles("checker-1", ["FILE_CHECKER"]);
  await hold.truncated;
  const found = outcome(store.get("checker-1"));
  const identity = outcome(store.getIdentity("checker-1"));
  const listed = outcome(store.list());
  await hold.release();
  await saving;

  assert.deepEqual(assertRead(await found, "get")?.roles, ["FILE_CHECKER"]);
  assert.deepEqual(assertRead(await identity, "getIdentity")?.roles, ["FILE_CHECKER"]);
  assert.deepEqual(
    assertRead(await listed, "list").map((user) => user.roles),
    [["FILE_CHECKER"]]
  );
});

test("activity-feed state read while a save is half-written comes back as saved", async () => {
  const file = fileIn("activity-feed-state.json");
  const store = new ActivityFeedStateStore(file);
  await store.init();
  await store.upsertUser({ id: "creator-1", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] });

  const hold = holdNextWrite(file);
  const saving = store.upsertUser({ id: "checker-1", displayName: "Casey Checker", roles: ["FILE_CHECKER"] });
  await hold.truncated;
  const read = outcome(store.read());
  await hold.release();
  await saving;

  assert.deepEqual(
    assertRead(await read, "read").users.map((user) => user.id),
    ["creator-1", "checker-1"]
  );
});
