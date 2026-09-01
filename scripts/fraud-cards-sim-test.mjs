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

import { fraudCardActions, fraudSeat } from "../packages/shared/dist/fraud.js";
import { botPrimaryAdvance } from "../packages/shared/dist/workflow.js";

const CHECKER = { id: "checker-1", displayName: "Casey Checker", roles: ["FILE_CHECKER"] };
const CREATOR = { id: "creator-1", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] };
const OUTSIDER = { id: "rando-1", displayName: "Sam Nobody", roles: ["LOAN_OFFICER"] };

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
check("fraudSeat maps assignee → checker, creator → requester, else null", () => {
  const t = makeFraudTask();
  assert.equal(fraudSeat(t, CHECKER), "checker");
  assert.equal(fraudSeat(t, CREATOR), "requester");
  assert.equal(fraudSeat(t, OUTSIDER), null);
});

/* The exhaustive truth table for the one seat function. Seat is derived from
   identity, never from status, so the answer is the same in every live state. */
check("fraudSeat: a role gates entry to a seat, and ADMIN is not a seat", () => {
  const t = makeFraudTask();
  const DEMOTED_CHECKER = { ...CHECKER, roles: ["LOAN_OFFICER"] };
  const ADMIN = { id: "admin-1", displayName: "Alex Admin", roles: ["FILE_CHECKER", "ADMIN"] };
  const ADMIN_CREATOR = { ...ADMIN, id: CREATOR.id };
  const ADMIN_ASSIGNEE = { ...ADMIN, id: CHECKER.id };

  for (const status of ["OPEN", "CLAIMED", "AWAITING_ITEMS", "PENDING_APPROVAL", "COMPLETED", "CANCELLED", "ARCHIVED"]) {
    const at = makeFraudTask({ status });
    assert.equal(fraudSeat(at, CHECKER), "checker", `assignee + FILE_CHECKER holds the checker seat in ${status}`);
    assert.equal(fraudSeat(at, CREATOR), "requester", `the creator holds the requester seat in ${status}`);
    assert.equal(fraudSeat(at, DEMOTED_CHECKER), null, `the assignee who lost FILE_CHECKER holds no seat in ${status}`);
    assert.equal(fraudSeat(at, ADMIN), null, `an admin who is neither party holds no seat in ${status}`);
    assert.equal(fraudSeat(at, OUTSIDER), null, `a stranger holds no seat in ${status}`);
    // Being an admin never adds a seat you don't otherwise hold, and never a second one.
    assert.equal(fraudSeat(at, ADMIN_CREATOR), "requester", `an admin who is the creator holds only the requester seat in ${status}`);
    assert.equal(fraudSeat(at, ADMIN_ASSIGNEE), "checker", `an admin who is the assignee holds only the checker seat in ${status}`);
  }

  // No assignee yet: nobody holds the checker seat.
  const unclaimed = makeFraudTask({ status: "OPEN", assignee: undefined });
  assert.equal(fraudSeat(unclaimed, CHECKER), null, "no assignee, no checker seat");
  assert.equal(fraudSeat(unclaimed, CREATOR), "requester", "the requester seat exists from the start");

  // Seats are a fraud concept; a non-FRAUD task has none.
  const value = makeFraudTask({ taskType: "VALUE" });
  assert.equal(fraudSeat(value, CHECKER), null);
  assert.equal(fraudSeat(value, CREATOR), null);
});

// --- CLAIMED ----------------------------------------------------------------
check("CLAIMED: checker sees Send Outstanding Items (note), creator sees nothing", () => {
  const t = makeFraudTask({ status: "CLAIMED" });
  assert.deepEqual(fraudCardActions(t, CHECKER), [
    { kind: "transitionWithNote", label: "Send Items", targetStatus: "AWAITING_ITEMS" }
  ]);
  assert.deepEqual(fraudCardActions(t, CREATOR), []);
  // The single forward step matches the checker's button.
  assert.deepEqual(botPrimaryAdvance(t), { status: "AWAITING_ITEMS", label: "Send Items" });
});

// --- AWAITING_ITEMS ---------------------------------------------------------
check("AWAITING_ITEMS: creator sees Submit (plain), checker sees nothing", () => {
  const t = makeFraudTask({ status: "AWAITING_ITEMS" });
  assert.deepEqual(fraudCardActions(t, CREATOR), [
    { kind: "transition", label: "Submit", targetStatus: "PENDING_APPROVAL" }
  ]);
  assert.deepEqual(fraudCardActions(t, CHECKER), []);
  assert.deepEqual(botPrimaryAdvance(t), { status: "PENDING_APPROVAL", label: "Submit" });
});

check("AWAITING_ITEMS: Submit carries a blockedReason while items are unresolved (#184)", () => {
  const item = (over) => ({ id: "i", text: "bank statement", checked: false, addedBy: "checker", addedOnPass: 1, ...over });
  const blocked = makeFraudTask({ status: "AWAITING_ITEMS", checklist: [item({ id: "a" }), item({ id: "b" })] });
  assert.deepEqual(fraudCardActions(blocked, CREATOR), [
    // The count rides alongside the sentence so a narrow slot doesn't recompute
    // it and end up disagreeing with the reason next to it.
    { kind: "transition", label: "Submit", targetStatus: "PENDING_APPROVAL", blockedReason: "2 items still need a check or a note", blockedCount: 2 }
  ]);
  // Checked, or unchecked with the requester's own note — either resolves.
  const resolved = makeFraudTask({
    status: "AWAITING_ITEMS",
    checklist: [item({ id: "a", checked: true }), item({ id: "b", note: "lender never issued one" })]
  });
  assert.deepEqual(fraudCardActions(resolved, CREATOR), [
    { kind: "transition", label: "Submit", targetStatus: "PENDING_APPROVAL" }
  ]);
});

// --- PENDING_APPROVAL -------------------------------------------------------
check("PENDING_APPROVAL: checker sees Approve + Send Back (note)", () => {
  const t = makeFraudTask({ status: "PENDING_APPROVAL" });
  assert.deepEqual(fraudCardActions(t, CHECKER), [
    { kind: "transition", label: "Approve", targetStatus: "COMPLETED" },
    { kind: "transitionWithNote", label: "Send Back", targetStatus: "AWAITING_ITEMS" }
  ]);
  assert.deepEqual(botPrimaryAdvance(t), { status: "COMPLETED", label: "Approve" });
});

check("PENDING_APPROVAL: creator sees Release while still assigned, nothing once released", () => {
  const assigned = makeFraudTask({ status: "PENDING_APPROVAL" });
  assert.deepEqual(fraudCardActions(assigned, CREATOR), [
    { kind: "release", label: "Release for any fraud checker" }
  ]);
  const released = makeFraudTask({ status: "PENDING_APPROVAL", assignee: undefined });
  assert.deepEqual(fraudCardActions(released, CREATOR), []);
});

// --- Note-required moves carry a target the card submits as reviewNotes ------
check("only Send Outstanding Items / Send Back are note-required", () => {
  const noteMoves = [
    ...fraudCardActions(makeFraudTask({ status: "CLAIMED" }), CHECKER),
    ...fraudCardActions(makeFraudTask({ status: "PENDING_APPROVAL" }), CHECKER)
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
    assert.deepEqual(fraudCardActions(t, CHECKER), []);
    assert.deepEqual(fraudCardActions(t, CREATOR), []);
  }
});

// --- Terminal / OPEN fraud states have no buttons ---------------------------
check("no fraud buttons in OPEN or terminal states", () => {
  for (const status of ["OPEN", "COMPLETED", "CANCELLED", "ARCHIVED"]) {
    const t = makeFraudTask({ status });
    assert.deepEqual(fraudCardActions(t, CHECKER), []);
    assert.deepEqual(fraudCardActions(t, CREATOR), []);
  }
});

console.log(`\nAll ${passed} FRAUD bot-cards checks passed.`);
