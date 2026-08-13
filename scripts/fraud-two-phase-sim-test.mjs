#!/usr/bin/env node
/*
 * Issue #39 — FRAUD two-phase completion lifecycle.
 *
 * A FRAUD check runs Open → Claimed → Awaiting Items → Pending Approval →
 * Completed → Archived. AWAITING_ITEMS and PENDING_APPROVAL are NON-closed
 * (notes keep flowing); each transition is driven by a specific party:
 *   - CLAIMED → AWAITING_ITEMS       : fraud checker (assignee)
 *   - AWAITING_ITEMS → PENDING_APPROVAL : task creator (requester)
 *   - PENDING_APPROVAL → COMPLETED    : fraud checker (assignee) — completion gate
 *   - PENDING_APPROVAL → AWAITING_ITEMS : fraud checker (bounce back)
 *   - AWAITING_ITEMS → CLAIMED        : fraud checker (reopen initial pass)
 *   - either new state → CANCELLED    : creator / admin
 *
 * This exercises the pure workflow core in packages/shared, mirroring the
 * assertion style of scheduler-sim-test.mjs (no server/store needed — every
 * rule under test lives in workflow.ts).
 */
import assert from "node:assert/strict";

import {
  CLOSED_STATUSES,
  FRAUD_FLOW,
  botPrimaryAdvance,
  canClaimTask,
  canTransitionStatus,
  flowFor,
  isOverdue,
  nextFlowStatuses,
  shouldSendReminder
} from "../packages/shared/dist/workflow.js";

const appConfig = {
  businessTimezone: "America/Los_Angeles",
  businessStartHour: 8,
  businessStartMinute: 30,
  businessEndHour: 17,
  businessEndMinute: 30,
  archiveRetentionDays: 90
};

// --- Actors ----------------------------------------------------------------
const CHECKER = { id: "checker-1", displayName: "Casey Checker", roles: ["FILE_CHECKER"] };
const CHECKER_2 = { id: "checker-2", displayName: "Robin Checker", roles: ["FILE_CHECKER"] };
const CREATOR = { id: "creator-1", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] };
const ADMIN = { id: "admin-1", displayName: "Alex Admin", roles: ["FILE_CHECKER", "ADMIN"] };
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

const ok = (task, next, user) => canTransitionStatus(task, next, user).ok;

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

console.log("FRAUD two-phase lifecycle sim");

// --- Flow shape ------------------------------------------------------------
check("FRAUD_FLOW is the two-phase order", () => {
  assert.deepEqual(FRAUD_FLOW, ["OPEN", "CLAIMED", "AWAITING_ITEMS", "PENDING_APPROVAL", "COMPLETED", "ARCHIVED"]);
  assert.deepEqual(flowFor(makeFraudTask()), FRAUD_FLOW);
});

check("new states are NOT closed (notes keep flowing)", () => {
  assert.ok(!CLOSED_STATUSES.includes("AWAITING_ITEMS"));
  assert.ok(!CLOSED_STATUSES.includes("PENDING_APPROVAL"));
  assert.deepEqual(CLOSED_STATUSES, ["COMPLETED", "CANCELLED", "ARCHIVED"]);
});

// --- Forward happy path ----------------------------------------------------
check("CLAIMED → AWAITING_ITEMS by fraud checker", () => {
  const t = makeFraudTask({ status: "CLAIMED" });
  assert.ok(ok(t, "AWAITING_ITEMS", CHECKER));
  assert.ok(nextFlowStatuses(t).includes("AWAITING_ITEMS"));
});

check("AWAITING_ITEMS → PENDING_APPROVAL by creator", () => {
  const t = makeFraudTask({ status: "AWAITING_ITEMS" });
  assert.ok(ok(t, "PENDING_APPROVAL", CREATOR));
  assert.ok(nextFlowStatuses(t).includes("PENDING_APPROVAL"));
});

check("PENDING_APPROVAL → COMPLETED by fraud checker", () => {
  const t = makeFraudTask({ status: "PENDING_APPROVAL" });
  assert.ok(ok(t, "COMPLETED", CHECKER));
  assert.ok(nextFlowStatuses(t).includes("COMPLETED"));
});

// --- Backward transitions --------------------------------------------------
check("PENDING_APPROVAL → AWAITING_ITEMS (bounce back) by fraud checker", () => {
  const t = makeFraudTask({ status: "PENDING_APPROVAL" });
  assert.ok(nextFlowStatuses(t).includes("AWAITING_ITEMS"));
  assert.ok(ok(t, "AWAITING_ITEMS", CHECKER));
});

check("AWAITING_ITEMS → CLAIMED (reopen initial pass) by fraud checker", () => {
  const t = makeFraudTask({ status: "AWAITING_ITEMS" });
  assert.ok(nextFlowStatuses(t).includes("CLAIMED"));
  assert.ok(ok(t, "CLAIMED", CHECKER));
});

// --- Cancel from each new state --------------------------------------------
check("AWAITING_ITEMS → CANCELLED by creator and admin, not others", () => {
  const t = makeFraudTask({ status: "AWAITING_ITEMS" });
  assert.ok(nextFlowStatuses(t).includes("CANCELLED"));
  assert.ok(ok(t, "CANCELLED", CREATOR));
  assert.ok(ok(t, "CANCELLED", ADMIN));
  assert.ok(!ok(t, "CANCELLED", CHECKER));
});

check("PENDING_APPROVAL → CANCELLED by creator and admin, not others", () => {
  const t = makeFraudTask({ status: "PENDING_APPROVAL" });
  assert.ok(nextFlowStatuses(t).includes("CANCELLED"));
  assert.ok(ok(t, "CANCELLED", CREATOR));
  assert.ok(ok(t, "CANCELLED", ADMIN));
  assert.ok(!ok(t, "CANCELLED", CHECKER));
});

// --- Permission gates per driver (creator vs checker vs admin) -------------
check("CLAIMED → AWAITING_ITEMS: creator/outsider blocked, admin allowed", () => {
  const t = makeFraudTask({ status: "CLAIMED" });
  assert.ok(!ok(t, "AWAITING_ITEMS", CREATOR));
  assert.ok(!ok(t, "AWAITING_ITEMS", OUTSIDER));
  assert.ok(ok(t, "AWAITING_ITEMS", ADMIN));
});

check("AWAITING_ITEMS → PENDING_APPROVAL: checker/outsider blocked", () => {
  const t = makeFraudTask({ status: "AWAITING_ITEMS" });
  assert.ok(!ok(t, "PENDING_APPROVAL", CHECKER));
  assert.ok(!ok(t, "PENDING_APPROVAL", OUTSIDER));
  assert.ok(ok(t, "PENDING_APPROVAL", ADMIN));
});

check("PENDING_APPROVAL → COMPLETED: creator/outsider blocked (completion gate)", () => {
  const t = makeFraudTask({ status: "PENDING_APPROVAL" });
  assert.ok(!ok(t, "COMPLETED", CREATOR));
  assert.ok(!ok(t, "COMPLETED", OUTSIDER));
  assert.ok(ok(t, "COMPLETED", ADMIN));
});

check("bounce/reopen blocked for non-checkers", () => {
  const pending = makeFraudTask({ status: "PENDING_APPROVAL" });
  assert.ok(!ok(pending, "AWAITING_ITEMS", CREATOR));
  const awaiting = makeFraudTask({ status: "AWAITING_ITEMS" });
  assert.ok(!ok(awaiting, "CLAIMED", CREATOR));
});

// --- Release for any fraud checker -----------------------------------------
check("unassigned PENDING_APPROVAL FRAUD task claimable by any FILE_CHECKER", () => {
  const released = makeFraudTask({ status: "PENDING_APPROVAL", assignee: undefined });
  assert.ok(canClaimTask(released, CHECKER_2));
  assert.ok(canClaimTask(released, CHECKER));
  assert.ok(!canClaimTask(released, CREATOR)); // not a FILE_CHECKER
});

check("assigned PENDING_APPROVAL is NOT open-claimable (release only when unassigned)", () => {
  const assigned = makeFraudTask({ status: "PENDING_APPROVAL" });
  assert.ok(!canClaimTask(assigned, CHECKER_2));
});

check("OPEN-claim behavior intact", () => {
  const open = makeFraudTask({ status: "OPEN", assignee: undefined });
  assert.ok(canClaimTask(open, CHECKER));
  assert.ok(!canClaimTask(open, CREATOR)); // FRAUD OPEN still needs FILE_CHECKER
});

// --- Reminder silence in AWAITING_ITEMS ------------------------------------
check("AWAITING_ITEMS never overdue and fully silent", () => {
  const overdueAt = new Date("2026-07-30T12:00:00Z").toISOString(); // in the past
  const awaiting = makeFraudTask({ status: "AWAITING_ITEMS", dueAt: overdueAt });
  // A Thursday inside business hours so only the status can silence it.
  const now = new Date("2026-07-30T20:00:00Z"); // 1pm PT
  assert.ok(!isOverdue(awaiting, now));
  assert.ok(!shouldSendReminder(awaiting, now, appConfig));

  // Sanity: PENDING_APPROVAL past due DOES read overdue (normal engine).
  const pending = makeFraudTask({ status: "PENDING_APPROVAL", dueAt: overdueAt });
  assert.ok(isOverdue(pending, now));
  assert.ok(shouldSendReminder(pending, now, appConfig));
});

// --- Bot forward action per state ------------------------------------------
check("botPrimaryAdvance labels the correct single fraud step per state", () => {
  assert.deepEqual(botPrimaryAdvance(makeFraudTask({ status: "CLAIMED" })), {
    status: "AWAITING_ITEMS",
    label: "Send Outstanding Items"
  });
  assert.deepEqual(botPrimaryAdvance(makeFraudTask({ status: "AWAITING_ITEMS" })), {
    status: "PENDING_APPROVAL",
    label: "Submit"
  });
  assert.deepEqual(botPrimaryAdvance(makeFraudTask({ status: "PENDING_APPROVAL" })), {
    status: "COMPLETED",
    label: "Approve"
  });
});

// --- Non-FRAUD types untouched ---------------------------------------------
check("non-FRAUD flows never see the new states", () => {
  const standard = makeFraudTask({ taskType: "VALUE", status: "CLAIMED", assignee: { id: OUTSIDER.id, displayName: OUTSIDER.displayName } });
  assert.deepEqual(flowFor(standard), ["OPEN", "CLAIMED", "COMPLETED", "ARCHIVED"]);
  assert.ok(!nextFlowStatuses(standard).includes("AWAITING_ITEMS"));
  assert.ok(botPrimaryAdvance(standard) === undefined || botPrimaryAdvance(standard).status === "COMPLETED");
});

console.log(`\nAll ${passed} FRAUD two-phase checks passed.`);
