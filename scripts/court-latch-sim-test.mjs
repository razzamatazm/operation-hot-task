#!/usr/bin/env node
/* Unit test for the court hold (apps/web/src/court-latch.ts).

   The message pull lifts a task carrying an unread reply into the recipient's
   "Needs you". Opening that task is the gesture that marks the note seen, which
   drops the pull, which recomputes the court — so the row the viewer just
   opened leaves the section they opened it in and lands somewhere further down
   a thirteen-row list, still open, while they are reading it. #161 removed
   auto-open because the list must not rearrange itself under the viewer; this
   is the same rule from the other side, and the hold is what enforces it.

   Framework-free and plain values in, plain values out, so it runs here under
   node's TS type stripping (node >= 24), the same arrangement as
   `expand-state.ts` next door.
   Run: `node --test scripts/court-latch-sim-test.mjs`. */
import assert from "node:assert/strict";
import test from "node:test";

import { holdCourt, isCourtHeld, releaseCourt } from "../apps/web/src/court-latch.ts";

/* ── Taking and reading a hold ──────────────────────────── */

test("a task is held only once it has been held", () => {
  assert.equal(isCourtHeld({}, "t1"), false, "nothing is held on a fresh map");
  assert.equal(isCourtHeld(holdCourt({}, "t1"), "t1"), true, "the one just taken");
  assert.equal(isCourtHeld(holdCourt({}, "t1"), "t2"), false, "and no neighbour with it");
});

test("holding twice returns the same map", () => {
  const held = holdCourt({}, "t1");
  assert.equal(holdCourt(held, "t1"), held, "same reference, so no re-render and no re-sort");
});

test("a hold does not disturb the holds beside it", () => {
  const two = holdCourt(holdCourt({}, "t1"), "t2");
  assert.deepEqual(Object.keys(two).sort(), ["t1", "t2"]);
});

/* ── Releasing ──────────────────────────────────────────── */

test("collapsing releases the hold, so the row is free to re-sort", () => {
  const held = holdCourt({}, "t1");
  assert.equal(isCourtHeld(releaseCourt(held, ["t1"]), "t1"), false);
});

test("releasing what was never held returns the same map", () => {
  const held = holdCourt({}, "t1");
  assert.equal(releaseCourt(held, ["t2"]), held, "a no-op costs nothing");
  const empty = {};
  assert.equal(releaseCourt(empty, ["t1"]), empty, "and so does releasing from nothing");
});

test("Collapse all releases every hold it closes", () => {
  /* The bulk path (#177). A hold left behind by Collapse all would pin a row to
     "Needs you" with no open card anywhere to justify it — the exact stuck
     state this module exists to avoid, arrived at from the other direction. */
  let holds = holdCourt(holdCourt(holdCourt({}, "t1"), "t2"), "t3");
  holds = releaseCourt(holds, ["t1", "t2", "t3"]);
  assert.deepEqual(holds, {}, "nothing survives the sweep");
});

test("a partial sweep leaves the cards still open still held", () => {
  const holds = releaseCourt(holdCourt(holdCourt({}, "t1"), "t2"), ["t1"]);
  assert.equal(isCourtHeld(holds, "t1"), false, "closed, so free");
  assert.equal(isCourtHeld(holds, "t2"), true, "still open, still pinned");
});

/* ── The maps are never mutated ─────────────────────────── */

test("neither operation writes through to the map it was given", () => {
  /* App holds these in `useState`. A mutated map is the same object, so React
     skips the render and the section the row is in silently stops matching the
     hold that decides it. */
  const before = holdCourt({}, "t1");
  const snapshot = { ...before };
  holdCourt(before, "t2");
  releaseCourt(before, ["t1"]);
  assert.deepEqual(before, snapshot, "the input survives both calls untouched");
});
