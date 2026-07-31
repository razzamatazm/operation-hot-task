#!/usr/bin/env node
/* Unit test for the toast host's pure queue logic (apps/web/src/toast-store.ts).
   The React layer (`toast.tsx`) only owns timers; all the shaping/queueing logic
   lives in the framework-free store so it can run here under node's TS type
   stripping (node >= 24). Run: `node --test scripts/toast-host-sim-test.mjs`. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_TOAST_MS,
  MAX_TOASTS,
  dismissToast,
  makeToast,
  pushToast
} from "../apps/web/src/toast-store.ts";

test("makeToast fills defaults (info variant + default duration)", () => {
  const t = makeToast("Shared");
  assert.equal(t.message, "Shared");
  assert.equal(t.variant, "info");
  assert.equal(t.durationMs, DEFAULT_TOAST_MS);
  assert.ok(t.id.length > 0);
});

test("makeToast honors variant + duration and clamps negatives to 0", () => {
  const t = makeToast("Nope", { variant: "error", durationMs: -50 });
  assert.equal(t.variant, "error");
  assert.equal(t.durationMs, 0);
});

test("makeToast ids are unique across calls", () => {
  const a = makeToast("a");
  const b = makeToast("b");
  assert.notEqual(a.id, b.id);
});

test("pushToast appends in order", () => {
  const list = pushToast(pushToast([], makeToast("one")), makeToast("two"));
  assert.deepEqual(list.map((t) => t.message), ["one", "two"]);
});

test("pushToast caps the stack at MAX_TOASTS, dropping oldest first", () => {
  let list = [];
  for (let i = 0; i < MAX_TOASTS + 2; i++) list = pushToast(list, makeToast(`m${i}`));
  assert.equal(list.length, MAX_TOASTS);
  // The two oldest (m0, m1) were dropped; newest survives at the tail.
  assert.deepEqual(list.map((t) => t.message), ["m2", "m3", "m4"]);
});

test("dismissToast removes by id and leaves others untouched", () => {
  const keep = makeToast("keep");
  const drop = makeToast("drop");
  const list = dismissToast([keep, drop], drop.id);
  assert.deepEqual(list.map((t) => t.message), ["keep"]);
});

test("dismissToast is a no-op for an unknown id", () => {
  const only = makeToast("only");
  const list = dismissToast([only], "no-such-id");
  assert.deepEqual(list.map((t) => t.id), [only.id]);
});
