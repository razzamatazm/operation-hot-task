#!/usr/bin/env node
/* Unit test for the accordion expansion state (apps/web/src/expand-state.ts).

   Expansion is the viewer's alone (#161): a card is open because they opened
   it, and nothing — status, notes, refresh — moves it, bar the one collapse
   when the board sees a task close (#452, at the bottom). Issue #177 adds a
   "Collapse all" control to the list header, which has to know which cards in
   view are currently open, the same question `TaskCard` answers for itself.
   The state therefore lives in a framework-free module both sides import, so
   the header and the card can't drift. It takes plain values and returns plain
   values, so it runs here under node's TS type stripping (node >= 24).
   Run: `node --test scripts/expand-state-sim-test.mjs`. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  collapseNewlyClosed,
  collapseTasks,
  expandedTaskIds,
  headerKeyToggles,
  isTaskExpanded,
  newlyClosedIds
} from "../apps/web/src/expand-state.ts";

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

/* ── #504: keys on controls inside the header row ──────── */

test("Enter and Space on the header row itself toggle the card", () => {
  const row = {};
  assert.equal(headerKeyToggles("Enter", row, row), true);
  assert.equal(headerKeyToggles(" ", row, row), true);
  assert.equal(headerKeyToggles("Tab", row, row), false);
});

test("Enter and Space on a control inside the row (task menu, menu items, action button) leave the card alone", () => {
  const row = {};
  for (const control of [{ name: "Task menu" }, { name: "Edit Task" }, { name: "Complete" }]) {
    assert.equal(headerKeyToggles("Enter", control, row), false, `Enter on ${control.name}`);
    assert.equal(headerKeyToggles(" ", control, row), false, `Space on ${control.name}`);
  }
});

test("the card's header key handler goes through headerKeyToggles", () => {
  const app = readFileSync(new URL("../apps/web/src/App.tsx", import.meta.url), "utf8");
  const handler = app.slice(app.indexOf("const handleHeaderKey"), app.indexOf("const stopBubble"));
  assert.match(handler, /headerKeyToggles\(\s*e\.key,\s*e\.target,\s*e\.currentTarget\s*\)/);
});

/* ── #452: collapse once when a task closes ────────────── */

/* The one exception to "nothing closes a card for the viewer": a task that
   moves from an open status into a closed one collapses, once, when the board
   sees it happen. `observe` is the loop App runs on every change to its task
   list — diff against the last snapshot, collapse what just closed, keep the
   new snapshot — so the rules are checked as a sequence of refreshes. */
const at = (id, status, taskType = "CONTRACT") => ({ id, status, taskType });
const observe = (state, tasks) => ({
  snapshot: new Map(tasks.map((t) => [t.id, t.status])),
  overrides: collapseNewlyClosed(state.overrides, newlyClosedIds(state.snapshot, tasks))
});
const fresh = (overrides) => ({ snapshot: new Map(), overrides });

test("an open card collapses when its task goes from open to Completed, Cancelled or Archived", () => {
  for (const closed of ["COMPLETED", "CANCELLED", "ARCHIVED"]) {
    let state = observe(fresh({ a: true }), [at("a", "CLAIMED")]);
    assert.equal(isTaskExpanded(state.overrides.a), true, "still open while the task is open");
    state = observe(state, [at("a", closed)]);
    assert.equal(isTaskExpanded(state.overrides.a), false, `collapsed on ${closed}`);
  }
});

test("reopening the card after the close sticks through later refreshes", () => {
  let state = observe(fresh({ a: true }), [at("a", "CLAIMED")]);
  state = observe(state, [at("a", "COMPLETED")]);
  state = { ...state, overrides: { ...state.overrides, a: true } }; // the viewer opens it again
  const reopened = state.overrides;
  for (let i = 0; i < 3; i++) state = observe(state, [at("a", "COMPLETED")]);
  assert.equal(state.overrides, reopened, "same map: no render, no storage write");
  assert.equal(isTaskExpanded(state.overrides.a), true);
});

test("a task first seen already closed keeps its stored open card (page load)", () => {
  const state = observe(fresh({ a: true }), [at("a", "COMPLETED")]);
  assert.equal(isTaskExpanded(state.overrides.a), true);
});

test("Completed to Archived is not a close", () => {
  let state = observe(fresh({ a: true }), [at("a", "COMPLETED")]);
  state = observe(state, [at("a", "ARCHIVED")]);
  assert.equal(isTaskExpanded(state.overrides.a), true);
});

test("Loan Docs at merge-done is not closed, so the card stays open", () => {
  let state = observe(fresh({ a: true }), [at("a", "CLAIMED", "LOAN_DOCS")]);
  state = observe(state, [at("a", "MERGE_DONE", "LOAN_DOCS")]);
  assert.equal(isTaskExpanded(state.overrides.a), true);
});

test("closing tasks whose cards are already shut changes nothing", () => {
  const overrides = { a: false };
  let state = observe(fresh(overrides), [at("a", "CLAIMED"), at("b", "NEW")]);
  state = observe(state, [at("a", "COMPLETED"), at("b", "CANCELLED")]);
  assert.equal(state.overrides, overrides, "same map: no render, no storage write");
});

test("only the task that closed collapses", () => {
  let state = observe(fresh({ a: true, b: true }), [at("a", "CLAIMED"), at("b", "CLAIMED")]);
  state = observe(state, [at("a", "COMPLETED"), at("b", "CLAIMED")]);
  assert.deepEqual(state.overrides, { a: false, b: true });
});

/* App wiring: the collapse rides the snapshot the green pulse already keeps,
   so it inherits the pulse's rules — nothing on load, and a user switch
   clears the snapshot. */
test("the board collapses closes from the pulse snapshot", () => {
  const app = readFileSync(new URL("../apps/web/src/App.tsx", import.meta.url), "utf8");
  const start = app.indexOf("const prevStatusesRef");
  const effect = app.slice(start, app.indexOf("}, [tasks, tasksLoaded, user.id]);", start));
  assert.match(effect, /if \(!tasksLoaded\) return;[\s\S]*newlyClosedIds\(prevStatusesRef\.current, tasks\)/, "the saved list never seeds the snapshot");
  assert.match(effect, /newlyClosedIds\(prevStatusesRef\.current, tasks\)/);
  assert.match(effect, /setExpandOverrides\(\(prev\) => collapseNewlyClosed\(prev, closedIds\)\)/);
  assert.match(app, /useEffect\(\(\) => \{\s*prevStatusesRef\.current = new Map\(\);/, "a user switch clears the snapshot");
});
