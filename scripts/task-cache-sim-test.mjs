#!/usr/bin/env node
/* Unit test for the board's saved task list (apps/web/src/task-cache.ts).

   The board paints the last list it saw while sign-in and the first fetch run,
   then the server's list replaces it. A copy from another build, or one too old
   to be worth showing, reads as nothing.
   Run: `node --test scripts/task-cache-sim-test.mjs`. */
import assert from "node:assert/strict";
import test from "node:test";

import { TASK_CACHE_KEY, TASK_CACHE_MAX_AGE_MS, readTaskCache, writeTaskCache } from "../apps/web/src/task-cache.ts";

const memoryStorage = () => {
  const items = new Map();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
    removeItem: (key) => items.delete(key)
  };
};

const tasks = [
  { id: "a", updatedAt: "2026-10-02T10:00:00.000Z" },
  { id: "b", updatedAt: "2026-10-01T10:00:00.000Z" }
];

test("a saved list reads back on the same build", () => {
  const storage = memoryStorage();
  writeTaskCache(storage, "build-1", tasks, 1000);
  assert.deepEqual(readTaskCache(storage, "build-1", 2000), tasks);
});

test("nothing saved reads as an empty list", () => {
  assert.deepEqual(readTaskCache(memoryStorage(), "build-1", 0), []);
});

test("a list saved by another build reads as nothing, since the task shape may have moved", () => {
  const storage = memoryStorage();
  writeTaskCache(storage, "build-1", tasks, 1000);
  assert.deepEqual(readTaskCache(storage, "build-2", 2000), []);
});

test("a list older than the limit reads as nothing", () => {
  const storage = memoryStorage();
  writeTaskCache(storage, "build-1", tasks, 1000);
  assert.deepEqual(readTaskCache(storage, "build-1", 1000 + TASK_CACHE_MAX_AGE_MS), tasks);
  assert.deepEqual(readTaskCache(storage, "build-1", 1001 + TASK_CACHE_MAX_AGE_MS), []);
});

test("garbage in storage reads as nothing", () => {
  const storage = memoryStorage();
  storage.setItem(TASK_CACHE_KEY, "{not json");
  assert.deepEqual(readTaskCache(storage, "build-1", 0), []);
  storage.setItem(TASK_CACHE_KEY, JSON.stringify({ build: "build-1", savedAt: 0, tasks: "nope" }));
  assert.deepEqual(readTaskCache(storage, "build-1", 0), []);
});

test("no storage, or storage that throws, is quiet both ways", () => {
  assert.deepEqual(readTaskCache(null, "build-1", 0), []);
  assert.doesNotThrow(() => writeTaskCache(null, "build-1", tasks, 0));
  const full = { getItem: () => { throw new Error("locked"); }, setItem: () => { throw new Error("quota"); }, removeItem: () => {} };
  assert.deepEqual(readTaskCache(full, "build-1", 0), []);
  assert.doesNotThrow(() => writeTaskCache(full, "build-1", tasks, 0));
});
