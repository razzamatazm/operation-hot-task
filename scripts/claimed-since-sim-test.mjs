#!/usr/bin/env node
/* Issue #166 — the hamburger's timestamp block gains a line saying when the
   person currently holding the task took it on.

   ADR-0005 refused to persist that instant on `LoanTask`, so it is read back
   out of the task's history. `currentAssigneeSince` (packages/shared/src/history.ts)
   is the whole rule, and it is a pure function over an event list, so it runs
   here under node's TS type stripping (node >= 24) with no build and no store.

   The invariant under test: the answer belongs to whoever holds the task NOW.
   Every failure mode of a naive "last claim wins" scan is a misattribution —
   quoting a previous holder's start time against the current holder's name.

   Run: `node --test scripts/claimed-since-sim-test.mjs`. */
import assert from "node:assert/strict";
import test from "node:test";

import { currentAssigneeSince } from "../packages/shared/src/history.ts";

/* Only `action` and `at` are read, and the function's parameter type says so.
   Supplying an id, a taskId and a `by` would imply the rule consulted them. */
const event = (action, at) => ({ action, at });

const CREATED = event("TASK_CREATED", "2026-03-01T09:00:00.000Z");

/* ── The ordinary doors ────────────────────────────────── */

test("a claimed task reports the claim", () => {
  assert.equal(
    currentAssigneeSince([CREATED, event("TASK_CLAIMED", "2026-03-01T09:30:00.000Z")]),
    "2026-03-01T09:30:00.000Z"
  );
});

test("a handoff reports when the recipient received it, not the previous claim", () => {
  const history = [
    CREATED,
    event("TASK_CLAIMED", "2026-03-01T09:30:00.000Z"),
    event("TASK_ASSIGNED", "2026-03-01T14:00:00.000Z")
  ];
  assert.equal(currentAssigneeSince(history), "2026-03-01T14:00:00.000Z");
});

test("a task born assigned reports its creation-time assignment", () => {
  const history = [CREATED, event("TASK_ASSIGNED", "2026-03-01T09:00:00.000Z")];
  assert.equal(currentAssigneeSince(history), "2026-03-01T09:00:00.000Z");
});

/* ── The reason the rule is not "last claim wins" ──────── */

test("a task claimed, returned to the pool and re-claimed reports the SECOND claim", () => {
  const history = [
    CREATED,
    event("TASK_CLAIMED", "2026-03-01T09:30:00.000Z"),
    event("TASK_UNCLAIMED", "2026-03-01T11:00:00.000Z"),
    event("TASK_CLAIMED", "2026-03-02T08:15:00.000Z")
  ];
  assert.equal(currentAssigneeSince(history), "2026-03-02T08:15:00.000Z");
});

test("a release in place clears the holder just as an unclaim does", () => {
  const history = [
    CREATED,
    event("TASK_ASSIGNED", "2026-03-01T09:30:00.000Z"),
    event("TASK_RELEASED", "2026-03-01T11:00:00.000Z")
  ];
  assert.equal(currentAssigneeSince(history), undefined, "released for any checker — nobody holds it");
});

test("noise between the doors does not disturb the answer", () => {
  const history = [
    CREATED,
    event("TASK_CLAIMED", "2026-03-01T09:30:00.000Z"),
    event("CHECKLIST_UPDATED", "2026-03-01T10:00:00.000Z"),
    event("REVIEW_NOTE_ADDED", "2026-03-01T10:05:00.000Z"),
    event("TASK_STATUS_CHANGED", "2026-03-01T10:30:00.000Z"),
    event("TASK_SHARED", "2026-03-01T10:40:00.000Z")
  ];
  assert.equal(currentAssigneeSince(history), "2026-03-01T09:30:00.000Z");
});

test("chronology is established here, not trusted from the caller", () => {
  const shuffled = [
    event("TASK_CLAIMED", "2026-03-02T08:15:00.000Z"),
    CREATED,
    event("TASK_UNCLAIMED", "2026-03-01T11:00:00.000Z"),
    event("TASK_CLAIMED", "2026-03-01T09:30:00.000Z")
  ];
  assert.equal(currentAssigneeSince(shuffled), "2026-03-02T08:15:00.000Z");
});

/* ── Nothing to say ────────────────────────────────────── */

test("a task nobody has taken reports nothing", () => {
  assert.equal(currentAssigneeSince([CREATED]), undefined);
});

test("a task returned to the pool reports nothing", () => {
  const history = [
    CREATED,
    event("TASK_CLAIMED", "2026-03-01T09:30:00.000Z"),
    event("TASK_UNCLAIMED", "2026-03-01T11:00:00.000Z")
  ];
  assert.equal(currentAssigneeSince(history), undefined);
});

test("empty history reports nothing rather than throwing", () => {
  assert.equal(currentAssigneeSince([]), undefined, "history dropped by retention, or a task that predates the row");
});

test("the caller's array is not reordered underneath it", () => {
  const history = [
    event("TASK_CLAIMED", "2026-03-02T08:15:00.000Z"),
    event("TASK_UNCLAIMED", "2026-03-01T11:00:00.000Z")
  ];
  currentAssigneeSince(history);
  assert.deepEqual(history.map((e) => e.action), ["TASK_CLAIMED", "TASK_UNCLAIMED"]);
});
