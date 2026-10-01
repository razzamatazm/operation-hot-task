#!/usr/bin/env node
/* The first task list lands after the live stream may already have delivered
   newer copies of some tasks; the list must not roll those back (#518 review).
   Run: `node --test scripts/task-snapshot-merge-sim-test.mjs`. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createStreamReload, mergeTaskSnapshot } from "../apps/web/src/task-snapshot-merge.ts";

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

test("a streamed change that left the timestamp alone, like a loan rename, is kept", () => {
  const streamed = task("a", "2026-10-01T10:00:00.000Z", { loanName: "New name" });
  const listed = task("a", "2026-10-01T10:00:00.000Z", { loanName: "Old name" });
  assert.equal(mergeTaskSnapshot([streamed], [listed])[0], streamed);
});

test("the board passes the first task list through the merge", () => {
  const app = readFileSync(new URL("../apps/web/src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /setTasks\(\(current\) => mergeTaskSnapshot\(current, firstTasks\.tasks\)\)/);
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

/* After a stream reconnect the board reloads the list (#519 review). Only what
   streamed in during that reload may override it: the board's own copies are
   from before the gap, so a rename missed in the gap must come from the list. */
/* A reload whose answer the test releases by hand. */
const reloads = () => {
  const pending = [];
  const state = { applied: [], failures: [] };
  const reload = createStreamReload({
    load: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    apply: (tasks) => state.applied.push(tasks),
    fail: (error) => state.failures.push(error.message)
  });
  return { reload, pending, state };
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a reconnect reload keeps only what streamed while it was in flight", async () => {
  const { reload, pending, state } = reloads();
  reload.streamed(task("before", "2026-10-01T10:09:00.000Z", { status: "STALE" }));
  reload.reload();
  const during = task("changed", "2026-10-01T10:06:00.000Z", { status: "CLAIMED" });
  reload.streamed(during);
  pending[0].resolve([task("changed", "2026-10-01T10:00:00.000Z"), task("before", "2026-10-01T10:00:00.000Z", { status: "FRESH" })]);
  await settle();
  const applied = state.applied[0];
  assert.equal(applied.find((t) => t.id === "changed"), during);
  assert.equal(applied.find((t) => t.id === "before").status, "FRESH", "a change from before the reload doesn't override it");
});

test("an older reload that lands after a newer one is dropped", async () => {
  const { reload, pending, state } = reloads();
  reload.reload();
  reload.reload();
  pending[1].resolve([task("x", "2026-10-01T10:05:00.000Z", { status: "NEWER" })]);
  await settle();
  pending[0].resolve([task("x", "2026-10-01T10:00:00.000Z", { status: "OLDER" })]);
  await settle();
  assert.equal(state.applied.length, 1);
  assert.equal(state.applied[0][0].status, "NEWER");
});

test("an older reload that lands first is applied, then the newer one", async () => {
  const { reload, pending, state } = reloads();
  reload.reload();
  reload.reload();
  pending[0].resolve([task("x", "2026-10-01T10:00:00.000Z")]);
  await settle();
  pending[1].resolve([task("x", "2026-10-01T10:05:00.000Z")]);
  await settle();
  assert.equal(state.applied.length, 2);
});

test("a failed reload reports its error; a stopped one applies and reports nothing", async () => {
  const { reload, pending, state } = reloads();
  reload.reload();
  pending[0].reject(new Error("Failed to load tasks"));
  await settle();
  assert.deepEqual(state.failures, ["Failed to load tasks"]);
  reload.reload();
  reload.reload();
  reload.stop();
  pending[1].resolve([task("x", "2026-10-01T10:00:00.000Z")]);
  pending[2].reject(new Error("late"));
  await settle();
  assert.equal(state.applied.length, 0);
  assert.deepEqual(state.failures, ["Failed to load tasks"]);
});

test("the board feeds its stream into the reconnect reload", () => {
  const app = readFileSync(new URL("../apps/web/src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /createStreamReload</);
  assert.match(app, /onConnected: streamReload\.reload/);
  assert.match(app, /streamReload\.streamed\(incoming\)/);
  assert.match(app, /streamReload\.stop\(\)/);
});

test("a rename missed in the gap comes from the list; a change during the reload is kept", () => {
  const listed = [
    task("renamed", "2026-10-01T10:00:00.000Z", { loanName: "New name" }),
    task("changed", "2026-10-01T10:00:00.000Z", { status: "OPEN" })
  ];
  const streamedDuringReload = [task("changed", "2026-10-01T10:06:00.000Z", { status: "CLAIMED" })];
  const merged = mergeTaskSnapshot(streamedDuringReload, listed);
  assert.equal(merged.find((t) => t.id === "renamed").loanName, "New name");
  assert.equal(merged.find((t) => t.id === "changed").status, "CLAIMED");
});
