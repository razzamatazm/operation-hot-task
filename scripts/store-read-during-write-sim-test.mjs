#!/usr/bin/env node
/*
 * A read that lands while a save is half-written (#331, #339).
 *
 * The server keeps its state in JSON files and rewrites a whole file on every
 * save, and a whole-file write truncates before it fills. A read taken in that
 * gap got an empty or partial file. Depending on the store it threw, or quietly
 * answered "nothing here": a loan rename left a channel card on the old name
 * (#331), and admin settings answered "no channel chosen", broadcasting a
 * notification to every channel (#339).
 *
 * It was fixed one store at a time until there were seven copies of the same
 * queue. Now there is one: `JsonFile` owns reading and writing a data file, and
 * every store is built on it. So this file checks three things:
 *
 *   1. `JsonFile` itself — a read waits behind a save, a change is one
 *      read-change-write step, a failed change stays contained, and an
 *      unreadable file behaves as its store declares.
 *   2. Each store, through its own interface — so a store that bypassed
 *      `JsonFile` would be caught by the promise it breaks, not by inspection.
 *   3. That nothing else in the server touches the filesystem, so an eighth
 *      store can't quietly bring the problem back.
 *
 * On a fast local disk the gap closes too quickly to land in on purpose, so
 * looping a test does not reproduce it. These checks hold one save open
 * between its truncate and its fill, start a read in that moment, and let the
 * save finish only once any file read that started has come back. No sleeps:
 * a read that goes to the file mid-save always sees the torn file, and a read
 * that waits its turn never touches the file until the save is done. The
 * filesystem is the only thing stubbed.
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
import { JsonFile } from "../apps/server/dist/json-file.js";
import { SettingsStore } from "../apps/server/dist/settings-store.js";
import { LoanStore, TaskStore } from "../apps/server/dist/store.js";
import { UserStore } from "../apps/server/dist/user-store.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const root = mkdtempSync(path.join(os.tmpdir(), "store-read-during-write-"));
after(() => rmSync(root, { recursive: true, force: true }));
let dirs = 0;
const fileIn = (name) => {
  dirs += 1;
  const dir = path.join(root, String(dirs));
  fs.mkdirSync(dir);
  return path.join(dir, name);
};

/* Hold the next save to `file` open between the truncate and the fill. All
   file access goes through the shared `fs.promises` object, so wrapping its
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

/* Count the saves to `file` until `stop` is called. */
const countWrites = (file) => {
  const { writeFile } = fs.promises;
  let count = 0;
  fs.promises.writeFile = (target, ...rest) => {
    if (target === file) count += 1;
    return writeFile.call(fs.promises, target, ...rest);
  };
  return {
    get count() {
      return count;
    },
    stop: () => {
      fs.promises.writeFile = writeFile;
    }
  };
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

// --- 1. The one file store ------------------------------------------------

const counterFile = async (options = {}) => {
  const file = fileIn("counter.json");
  const store = new JsonFile(file, { empty: () => ({ count: 0 }), ...options });
  await store.init();
  return { file, store };
};

test("a read while a save is half-written returns what was saved", async () => {
  const { file, store } = await counterFile();
  await store.update(() => ({ count: 1 }));

  const hold = holdNextWrite(file);
  const saving = store.update((current) => ({ count: current.count + 1 }));
  await hold.truncated;
  const read = outcome(store.read());
  await hold.release();

  assert.deepEqual(await saving, { count: 2 }, "the change resolves with what it saved");
  assert.deepEqual(assertRead(await read, "read"), { count: 2 });
});

test("a change is handed the file as it is at its turn, so changes never overwrite each other", async () => {
  const { store } = await counterFile();
  // Queued back to back, each change must see the one before it.
  await Promise.all(
    Array.from({ length: 20 }, () => store.update((current) => ({ count: current.count + 1 })))
  );
  assert.deepEqual(await store.read(), { count: 20 });
});

test("a change that returns nothing saves nothing", async () => {
  const { file, store } = await counterFile();
  await store.update(() => ({ count: 5 }));

  const writes = countWrites(file);
  const result = await store.update(() => undefined);
  writes.stop();

  assert.equal(result, undefined);
  assert.equal(writes.count, 0, "the file was not rewritten");
  assert.deepEqual(await store.read(), { count: 5 });
});

test("a change that throws fails only its caller, and the file and the queue carry on", async () => {
  const { store } = await counterFile();
  await store.update(() => ({ count: 1 }));

  const failing = store.update(() => {
    throw new Error("bad change");
  });
  const after = store.update((current) => ({ count: current.count + 1 }));

  await assert.rejects(failing, /bad change/);
  assert.deepEqual(await after, { count: 2 }, "the next change still ran, on the untouched file");
  assert.deepEqual(await store.read(), { count: 2 });
});

test("init creates a missing file with the empty value and leaves an existing one alone", async () => {
  const fresh = fileIn("fresh.json");
  await new JsonFile(fresh, { empty: () => ({ items: [] }) }).init();
  assert.deepEqual(JSON.parse(fs.readFileSync(fresh, "utf8")), { items: [] });

  const existing = fileIn("existing.json");
  fs.writeFileSync(existing, JSON.stringify({ items: ["kept"] }));
  await new JsonFile(existing, { empty: () => ({ items: [] }) }).init();
  assert.deepEqual(JSON.parse(fs.readFileSync(existing, "utf8")), { items: ["kept"] });
});

test("an unreadable file throws by default, and reads as empty for a store that says so", async () => {
  const strictFile = fileIn("strict.json");
  fs.writeFileSync(strictFile, "{not json");
  await assert.rejects(new JsonFile(strictFile, { empty: () => [] }).read(), SyntaxError);

  const lenientFile = fileIn("lenient.json");
  fs.writeFileSync(lenientFile, "{not json");
  assert.deepEqual(await new JsonFile(lenientFile, { empty: () => [], lenient: true }).read(), []);
});

test("decode shapes what is read and encode shapes what is saved", async () => {
  const file = fileIn("shaped.json");
  const store = new JsonFile(file, {
    empty: () => ({ names: [] }),
    decode: (parsed) => ({ names: Array.isArray(parsed?.names) ? parsed.names : [] }),
    encode: (value) => ({ names: value.names.map((name) => name.trim()) })
  });
  fs.writeFileSync(file, JSON.stringify({ other: true }));
  await store.init();

  assert.deepEqual(await store.read(), { names: [] }, "a file missing the field decodes to the store's shape");
  await store.update(() => ({ names: ["  Dana  "] }));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { names: ["Dana"] });
});

// --- 2. Every store, through its own interface ---------------------------

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

// --- 3. Nothing else touches the filesystem --------------------------------

/* Which server modules may import the filesystem, and why. Anything else that
   wants to keep state in a file builds on `JsonFile`, so it inherits the
   guarantee instead of re-deriving it — which is how there came to be seven
   copies, and how #331 and #339 each found a store the last fix missed. */
const MAY_IMPORT_FS = new Map([
  ["json-file.ts", "the one module that reads and writes data files"],
  ["index.ts", "checks whether the built web app exists before serving it"]
]);

test("no server module touches the filesystem except the shared file store", () => {
  const src = path.join(repoRoot, "apps/server/src");
  const importsFs = /from\s+["'](?:node:)?fs(?:\/promises)?["']|require\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)/;
  const offenders = fs
    .readdirSync(src, { recursive: true })
    .filter((name) => /\.(ts|tsx|mts|cts)$/.test(name))
    .filter((name) => !MAY_IMPORT_FS.has(name))
    .filter((name) => importsFs.test(fs.readFileSync(path.join(src, name), "utf8")))
    .sort();

  assert.deepEqual(
    offenders,
    [],
    `these modules import the filesystem directly; keep state through JsonFile instead: ${offenders.join(", ")}`
  );
});
