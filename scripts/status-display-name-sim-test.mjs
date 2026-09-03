#!/usr/bin/env node
/* Issue #237 / ADR-0007 rule 4 — the names were backwards.

   The stored status `NEEDS_REVIEW` displayed as "In review", which describes a
   claimed LOI (the checker is reviewing it), not a task the checker has
   already found something wrong with. The corrections state now reads
   "Needs corrections" on every surface, a claimed LOI takes the freed-up
   "In review", and the move back out of corrections stopped calling itself an
   undo.

   `statusDisplayName` (packages/shared/src/labels.ts) is the single place the
   web rail and the bot ask, so no surface can invent its own name for either
   state. It is a pure function over two strings, so it runs here under node's
   TS type stripping with no build and no store.

   Run: `node --test scripts/status-display-name-sim-test.mjs`. */
import assert from "node:assert/strict";
import test from "node:test";

import { ACTION_LABELS, statusDisplayName } from "../packages/shared/src/labels.ts";
import { TASK_STATUSES, TASK_TYPES } from "../packages/shared/src/types.ts";

const OTHER_TYPES = TASK_TYPES.filter((t) => t !== "LOI");

/* ── The corrections state ─────────────────────────────── */

test("the corrections state reads Needs corrections, whatever the task type", () => {
  for (const taskType of TASK_TYPES) {
    assert.equal(statusDisplayName("NEEDS_REVIEW", taskType), "Needs corrections", taskType);
  }
});

test("nothing displays the corrections state as In review", () => {
  for (const taskType of TASK_TYPES) {
    const shown = statusDisplayName("NEEDS_REVIEW", taskType) ?? "";
    assert.ok(!/in review/i.test(shown), `${taskType}: ${shown}`);
  }
});

/* ── A claimed task ────────────────────────────────────── */

test("a claimed LOI is In review", () => {
  assert.equal(statusDisplayName("CLAIMED", "LOI"), "In review");
});

test("a claimed task of any other type keeps the surface's own wording", () => {
  for (const taskType of OTHER_TYPES) {
    assert.equal(statusDisplayName("CLAIMED", taskType), undefined, taskType);
  }
});

/* ── Every other status is the surface's business ──────── */

test("no other status is renamed", () => {
  for (const status of TASK_STATUSES) {
    if (status === "NEEDS_REVIEW" || status === "CLAIMED") continue;
    for (const taskType of TASK_TYPES) {
      assert.equal(statusDisplayName(status, taskType), undefined, `${status} / ${taskType}`);
    }
  }
});

/* ── The move back out of corrections ──────────────────── */

test("the move back to the checker is not labelled as an undo", () => {
  assert.equal("UNDO_REVIEW" in ACTION_LABELS, false, "the undo key is gone");
  /* Reworded again by the user on #254, from `Send back to checker` to name
     what the checker is being asked for rather than where the task goes. The
     assertion that carries #237's point is the one below: whatever it is
     called, it must not read as an undo. */
  assert.equal(ACTION_LABELS.SEND_BACK_TO_CHECKER, "Send Back For Review");
  assert.ok(!/undo/i.test(ACTION_LABELS.SEND_BACK_TO_CHECKER));
});
