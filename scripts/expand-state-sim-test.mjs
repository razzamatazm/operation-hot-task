#!/usr/bin/env node
/* Unit test for the accordion expansion state (apps/web/src/expand-state.ts).

   Expansion is the viewer's alone (#161): a card is open because they opened
   it, and nothing — status, notes, refresh — moves it. Issue #177 adds a
   "Collapse all" control to the list header, which has to know which cards in
   view are currently open, the same question `TaskCard` answers for itself.
   The state therefore lives in a framework-free module both sides import, so
   the header and the card can't drift. It takes plain values and returns plain
   values, so it runs here under node's TS type stripping (node >= 24).
   Run: `node --test scripts/expand-state-sim-test.mjs`. */
import assert from "node:assert/strict";
import test from "node:test";

import { collapseTasks, expandedTaskIds, isTaskExpanded } from "../apps/web/src/expand-state.ts";

/* Only the id is read — expansion no longer looks at status, parties or
   notes, and a test that supplied them would imply it did. */
const task = (id) => ({ id });

/* ── The whole rule ────────────────────────────────────── */

test("a card is expanded only when the viewer expanded it", () => {
  assert.equal(isTaskExpanded(true), true, "the viewer opened it");
  assert.equal(isTaskExpanded(false), false, "the viewer closed it");
  assert.equal(isTaskExpanded(undefined), false, "untouched — collapsed");
});

/* ── What the header needs ─────────────────────────────── */

test("expandedTaskIds reports the open cards, in list order", () => {
  const tasks = [task("a"), task("b"), task("c")];
  assert.deepEqual(expandedTaskIds(tasks, { c: true, a: true }), ["a", "c"]);
});

test("expandedTaskIds is empty for an untouched list", () => {
  assert.deepEqual(expandedTaskIds([task("a"), task("b")], {}), []);
});

/* The crux of #177: the override map is global across every list, so the
   header's scope has to come from the list it was handed, not from the map.
   A card open on another tab or behind a different loan filter must not show
   up in this header's count, or Collapse all would reach outside what the
   viewer can see. */
test("expandedTaskIds ignores open cards outside the list it was handed", () => {
  const overrides = { visible: true, "other-tab": true };
  assert.deepEqual(expandedTaskIds([task("visible")], overrides), ["visible"]);
  assert.deepEqual(expandedTaskIds([], overrides), [], "an empty list collapses nothing");
});

/* ── The bulk collapse ─────────────────────────────────── */

test("collapseTasks writes false for every id in one new map", () => {
  const next = collapseTasks({}, ["a", "b"]);
  assert.deepEqual(next, { a: false, b: false });
});

/* The other half of the scoping crux: the write is as narrow as the read.
   Cards the viewer opened in another list keep their state. */
test("collapseTasks writes only the ids handed to it and preserves the rest", () => {
  const next = collapseTasks({ "other-tab": true, "other-loan": false }, ["a"]);
  assert.deepEqual(next, { "other-tab": true, "other-loan": false, a: false });
});

test("collapseTasks returns the same map when nothing would change", () => {
  const prev = { a: false };
  assert.equal(collapseTasks(prev, ["a"]), prev, "referentially identical — no re-render");
  assert.equal(collapseTasks(prev, []), prev, "empty id list");
});

test("collapseTasks flips a card the viewer had open", () => {
  assert.deepEqual(collapseTasks({ a: true }, ["a"]), { a: false });
});

/* Collapse all writes ordinary manual overrides — byte-identical to what
   clicking each row shut would write. Nothing downstream can tell the two
   apart, and since nothing clears an override any more, a collapse sticks
   until the viewer opens the card again. */
test("a collapse-all entry is identical to a manual collapse", () => {
  const manual = { a: false }; // what setExpandOverride(a, false) writes
  assert.deepEqual(collapseTasks({}, ["a"]), manual);
});

/* Read and write agree: collapsing everything the header reported leaves the
   header with nothing to report, so the control goes quiet after one press. */
test("collapsing what the header reported empties the header", () => {
  const tasks = [task("a"), task("b"), task("c")];
  const overrides = { a: true, c: true };
  const next = collapseTasks(overrides, expandedTaskIds(tasks, overrides));
  assert.deepEqual(expandedTaskIds(tasks, next), []);
  assert.equal(collapseTasks(next, expandedTaskIds(tasks, next)), next, "a second press is a no-op");
});
