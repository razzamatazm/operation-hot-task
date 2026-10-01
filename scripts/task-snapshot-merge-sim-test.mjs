#!/usr/bin/env node
/* The first task list lands after the live stream may already have delivered
   newer copies of some tasks; the list must not roll those back (#518 review).
   Run: `node --test scripts/task-snapshot-merge-sim-test.mjs`. */
import assert from "node:assert/strict";
import test from "node:test";

import { mergeTaskSnapshot } from "../apps/web/src/task-snapshot-merge.ts";

const task = (id, updatedAt, extra = {}) => ({ id, updatedAt, ...extra });

test("nothing streamed yet: the list is taken as it came", () => {
  const snapshot = [task("a", "2026-10-01T10:00:00.000Z"), task("b", "2026-10-01T09:00:00.000Z")];
  assert.equal(mergeTaskSnapshot([], snapshot), snapshot);
});

test("a task the stream updated after the list was read keeps the streamed copy", () => {
  const streamed = task("a", "2026-10-01T10:05:00.000Z", { status: "CLAIMED" });
  const snapshot = [task("a", "2026-10-01T10:00:00.000Z", { status: "OPEN" }), task("b", "2026-10-01T09:00:00.000Z")];
  const merged = mergeTaskSnapshot([streamed], snapshot);
  assert.deepEqual(merged.map((t) => t.id), ["a", "b"]);
  assert.equal(merged[0], streamed);
});

test("a streamed copy older than the list's gives way to the list", () => {
  const streamed = task("a", "2026-10-01T09:55:00.000Z", { status: "OPEN" });
  const listed = task("a", "2026-10-01T10:00:00.000Z", { status: "CLAIMED" });
  const merged = mergeTaskSnapshot([streamed], [listed]);
  assert.deepEqual(merged, [listed]);
});

test("a task created after the list was read is kept, newest first", () => {
  const created = task("new", "2026-10-01T11:00:00.000Z");
  const snapshot = [task("a", "2026-10-01T10:00:00.000Z")];
  const merged = mergeTaskSnapshot([created], snapshot);
  assert.deepEqual(merged.map((t) => t.id), ["new", "a"]);
});
