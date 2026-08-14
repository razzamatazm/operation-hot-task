#!/usr/bin/env node
/*
 * Issue #39 — FRAUD two-phase bot cards (card layer).
 *
 * Tranche 3 renders role-aware fraud buttons on the DM cards: the button set a
 * viewer sees depends on the task status AND whether they're the fraud checker
 * (assignee) or the requester (creator). This sim asserts the pure button-set
 * helper `fraudCardActions` (packages/shared/src/fraud.ts) — the same function
 * the bot cards, notification layer, and web courts view (tranche 4) consume —
 * produces the
 * right actions per (status, role), that note-required moves are tagged so the
 * card reveals a note input mapping to reviewNotes, and that it stays aligned
 * with `botPrimaryAdvance` (packages/shared).
 *
 * Runs against the compiled dist, mirroring bot-dedupe-sim.mjs.
 */
import assert from "node:assert/strict";

import { fraudCardActions, fraudRoleFor } from "../packages/shared/dist/fraud.js";
import { botPrimaryAdvance } from "../packages/shared/dist/workflow.js";

const CHECKER = { id: "checker-1", displayName: "Casey Checker", roles: ["FILE_CHECKER"] };
const CREATOR = { id: "creator-1", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] };

const makeFraudTask = (overrides = {}) => ({
  id: "task-fraud-1",
  folderName: "Fraud Sim",
  taskType: "FRAUD",
  dueAt: new Date("2026-07-31T12:00:00Z").toISOString(),
  urgency: "GREEN",
  points: 1,
  notes: "check it",
  status: "CLAIMED",
  createdAt: new Date("2026-07-31T00:00:00Z").toISOString(),
  updatedAt: new Date("2026-07-31T00:00:00Z").toISOString(),
  createdBy: { id: CREATOR.id, displayName: CREATOR.displayName },
  assignee: { id: CHECKER.id, displayName: CHECKER.displayName },
  ...overrides
});

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

console.log("FRAUD two-phase bot-cards sim");

// --- Role resolution -------------------------------------------------------
check("fraudRoleFor maps assignee → CHECKER, creator → CREATOR, else OTHER", () => {
  const t = makeFraudTask();
  assert.equal(fraudRoleFor(t, CHECKER.id), "CHECKER");
  assert.equal(fraudRoleFor(t, CREATOR.id), "CREATOR");
  assert.equal(fraudRoleFor(t, "someone-else"), "OTHER");
  assert.equal(fraudRoleFor(t, undefined), "OTHER");
});

// --- CLAIMED ----------------------------------------------------------------
check("CLAIMED: checker sees Send Outstanding Items (note), creator sees nothing", () => {
  const t = makeFraudTask({ status: "CLAIMED" });
  assert.deepEqual(fraudCardActions(t, CHECKER.id), [
    { kind: "transitionWithNote", label: "Send Items", targetStatus: "AWAITING_ITEMS" }
  ]);
  assert.deepEqual(fraudCardActions(t, CREATOR.id), []);
  // The single forward step matches the checker's button.
  assert.deepEqual(botPrimaryAdvance(t), { status: "AWAITING_ITEMS", label: "Send Items" });
});

// --- AWAITING_ITEMS ---------------------------------------------------------
check("AWAITING_ITEMS: creator sees Submit (plain), checker sees nothing", () => {
  const t = makeFraudTask({ status: "AWAITING_ITEMS" });
  assert.deepEqual(fraudCardActions(t, CREATOR.id), [
    { kind: "transition", label: "Submit", targetStatus: "PENDING_APPROVAL" }
  ]);
  assert.deepEqual(fraudCardActions(t, CHECKER.id), []);
  assert.deepEqual(botPrimaryAdvance(t), { status: "PENDING_APPROVAL", label: "Submit" });
});

// --- PENDING_APPROVAL -------------------------------------------------------
check("PENDING_APPROVAL: checker sees Approve + Send Back (note)", () => {
  const t = makeFraudTask({ status: "PENDING_APPROVAL" });
  assert.deepEqual(fraudCardActions(t, CHECKER.id), [
    { kind: "transition", label: "Approve", targetStatus: "COMPLETED" },
    { kind: "transitionWithNote", label: "Send Back", targetStatus: "AWAITING_ITEMS" }
  ]);
  assert.deepEqual(botPrimaryAdvance(t), { status: "COMPLETED", label: "Approve" });
});

check("PENDING_APPROVAL: creator sees Release while still assigned, nothing once released", () => {
  const assigned = makeFraudTask({ status: "PENDING_APPROVAL" });
  assert.deepEqual(fraudCardActions(assigned, CREATOR.id), [
    { kind: "release", label: "Release for any fraud checker" }
  ]);
  const released = makeFraudTask({ status: "PENDING_APPROVAL", assignee: undefined });
  assert.deepEqual(fraudCardActions(released, CREATOR.id), []);
});

// --- Note-required moves carry a target the card submits as reviewNotes ------
check("only Send Outstanding Items / Send Back are note-required", () => {
  const noteMoves = [
    ...fraudCardActions(makeFraudTask({ status: "CLAIMED" }), CHECKER.id),
    ...fraudCardActions(makeFraudTask({ status: "PENDING_APPROVAL" }), CHECKER.id)
  ].filter((a) => a.kind === "transitionWithNote");
  assert.equal(noteMoves.length, 2);
  for (const move of noteMoves) {
    assert.equal(move.targetStatus, "AWAITING_ITEMS"); // both hand back into AWAITING_ITEMS
  }
});

// --- Non-FRAUD untouched ----------------------------------------------------
check("non-FRAUD tasks get no fraud buttons in any state", () => {
  for (const status of ["OPEN", "CLAIMED", "COMPLETED"]) {
    const t = makeFraudTask({ taskType: "VALUE", status });
    assert.deepEqual(fraudCardActions(t, CHECKER.id), []);
    assert.deepEqual(fraudCardActions(t, CREATOR.id), []);
  }
});

// --- Terminal / OPEN fraud states have no buttons ---------------------------
check("no fraud buttons in OPEN or terminal states", () => {
  for (const status of ["OPEN", "COMPLETED", "CANCELLED", "ARCHIVED"]) {
    const t = makeFraudTask({ status });
    assert.deepEqual(fraudCardActions(t, CHECKER.id), []);
    assert.deepEqual(fraudCardActions(t, CREATOR.id), []);
  }
});

console.log(`\nAll ${passed} FRAUD bot-cards checks passed.`);
