#!/usr/bin/env node
/*
 * Issue #44 — structured outstanding-items checklist (shared-model invariants).
 *
 * Exercises the PURE checklist core in packages/shared/checklist.ts — the
 * data-model invariants the whole feature rides on:
 *   - Gated deletion (#66): the adding seat can delete a fresh (draft) item on
 *     its own turn; it locks once handed off (committed), and the other seat's
 *     items are never deletable.
 *   - Checked/stale: editing a CHECKED item's text auto-clears the check and
 *     marks it stale; re-checking a stale item clears stale.
 *   - Ordering: unresolved (unchecked) items float to the top, checked settle
 *     below, stable (add-order) within each group.
 *   - Purity: every op returns a new array and never mutates the input.
 *   - Turn permissions: canEditChecklist enforces who-can-do-what by status.
 *
 * Mirrors the assertion style of fraud-two-phase-sim-test.mjs (no server/store —
 * every rule under test lives in checklist.ts).
 */
import assert from "node:assert/strict";

import {
  addChecklistItem,
  allChecklistResolved,
  canDeleteChecklistItem,
  canEditChecklist,
  checklistSeat,
  commitChecklistItems,
  editChecklistItemText,
  removeChecklistItem,
  setChecklistItemChecked,
  setChecklistItemCheckerNote,
  setChecklistItemNote,
  sortChecklist,
  unresolvedCount
} from "../packages/shared/dist/checklist.js";

const CHECKER = { id: "checker-1", displayName: "Casey Checker", roles: ["FILE_CHECKER"] };
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

const item = (over = {}) => ({ id: "i", text: "t", checked: false, addedBy: "checker", addedOnPass: 1, ...over });

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

console.log("FRAUD checklist shared-model sim");

// --- add / purity ----------------------------------------------------------
check("addChecklistItem appends an unchecked DRAFT item and doesn't mutate the input", () => {
  const before = [];
  const after = addChecklistItem(before, { id: "a", text: "2023 tax returns", addedBy: "checker", addedOnPass: 1 });
  assert.equal(before.length, 0, "input array untouched");
  assert.equal(after.length, 1);
  assert.deepEqual(after[0], { id: "a", text: "2023 tax returns", checked: false, addedBy: "checker", addedOnPass: 1, draft: true });
});

// --- gated deletion (#66) ---------------------------------------------------
check("removeChecklistItem drops the item by id and doesn't mutate the input", () => {
  const before = [item({ id: "a" }), item({ id: "b" })];
  const after = removeChecklistItem(before, "a");
  assert.deepEqual(after.map((i) => i.id), ["b"]);
  assert.deepEqual(before.map((i) => i.id), ["a", "b"], "input untouched (purity)");
});

check("commitChecklistItems clears every draft flag and doesn't mutate the input", () => {
  const before = [item({ id: "a", draft: true }), item({ id: "b", draft: true }), item({ id: "c" })];
  const after = commitChecklistItems(before);
  assert.ok(after.every((i) => i.draft === undefined), "all drafts cleared");
  assert.equal(before[0].draft, true, "input untouched (purity)");
});

check("adder can delete their OWN fresh draft on their active turn", () => {
  // Checker in CLAIMED (their build turn) deletes a checker-added draft.
  const claimed = makeFraudTask({ status: "CLAIMED" });
  const draftItem = item({ id: "a", addedBy: "checker", draft: true });
  assert.ok(canDeleteChecklistItem(claimed, CHECKER, draftItem), "checker deletes own draft in CLAIMED");
  assert.ok(canDeleteChecklistItem(claimed, ADMIN, item({ id: "a", addedBy: "checker", draft: true })), "admin (checker seat) too");
  // Creator in AWAITING_ITEMS (their turn) deletes a creator-added draft.
  const awaiting = makeFraudTask({ status: "AWAITING_ITEMS" });
  assert.ok(canDeleteChecklistItem(awaiting, CREATOR, item({ id: "b", addedBy: "creator", draft: true })), "creator deletes own draft in AWAITING_ITEMS");
  // Checker in PENDING_APPROVAL (their review turn) deletes a checker-added draft.
  const pending = makeFraudTask({ status: "PENDING_APPROVAL" });
  assert.ok(canDeleteChecklistItem(pending, CHECKER, item({ id: "c", addedBy: "checker", draft: true })), "checker deletes own draft in PENDING_APPROVAL");
});

check("a COMMITTED (handed-off) item is never deletable, even by its adder on their turn", () => {
  const claimed = makeFraudTask({ status: "CLAIMED" });
  const committed = item({ id: "a", addedBy: "checker" }); // no draft flag = committed
  assert.ok(!canDeleteChecklistItem(claimed, CHECKER, committed), "committed checker item locked in CLAIMED");
  const awaiting = makeFraudTask({ status: "AWAITING_ITEMS" });
  assert.ok(!canDeleteChecklistItem(awaiting, CREATOR, item({ id: "b", addedBy: "creator" })), "committed creator item locked");
});

check("the OTHER seat's items are never deletable (check off with a note instead)", () => {
  // Checker cannot delete a creator-added draft; creator cannot delete a checker-added draft.
  const awaiting = makeFraudTask({ status: "AWAITING_ITEMS" });
  assert.ok(!canDeleteChecklistItem(awaiting, CHECKER, item({ id: "a", addedBy: "creator", draft: true })), "checker can't delete creator's item");
  const claimed = makeFraudTask({ status: "CLAIMED" });
  assert.ok(!canDeleteChecklistItem(claimed, CREATOR, item({ id: "b", addedBy: "checker", draft: true })), "creator can't delete checker's item");
});

check("deletion is rejected when it's NOT the adder's active turn", () => {
  // Checker added a draft but it's the creator's AWAITING_ITEMS turn now.
  const awaiting = makeFraudTask({ status: "AWAITING_ITEMS" });
  assert.ok(!canDeleteChecklistItem(awaiting, CHECKER, item({ id: "a", addedBy: "checker", draft: true })), "checker can't delete off-turn (AWAITING_ITEMS)");
  // Creator can't delete during the checker's CLAIMED / PENDING_APPROVAL turns.
  const pending = makeFraudTask({ status: "PENDING_APPROVAL" });
  assert.ok(!canDeleteChecklistItem(pending, CREATOR, item({ id: "b", addedBy: "creator", draft: true })), "creator can't delete off-turn (PENDING_APPROVAL)");
});

check("outsiders can never delete; non-FRAUD / closed tasks allow no deletion", () => {
  const awaiting = makeFraudTask({ status: "AWAITING_ITEMS" });
  assert.ok(!canDeleteChecklistItem(awaiting, OUTSIDER, item({ id: "a", addedBy: "creator", draft: true })), "outsider blocked");
  const value = makeFraudTask({ taskType: "VALUE", status: "CLAIMED" });
  assert.ok(!canDeleteChecklistItem(value, CHECKER, item({ id: "b", addedBy: "checker", draft: true })), "non-FRAUD blocked");
  const done = makeFraudTask({ status: "COMPLETED" });
  assert.ok(!canDeleteChecklistItem(done, CHECKER, item({ id: "c", addedBy: "checker", draft: true })), "closed task blocked");
});

// --- checked / stale invariant ---------------------------------------------
check("editing a CHECKED item's text clears the check and marks it stale", () => {
  const items = [item({ id: "a", text: "W-2", checked: true })];
  const after = editChecklistItemText(items, "a", "W-2 (both jobs)");
  assert.equal(after[0].text, "W-2 (both jobs)");
  assert.equal(after[0].checked, false, "check cleared");
  assert.equal(after[0].stale, true, "marked stale");
  assert.equal(items[0].checked, true, "input untouched (purity)");
});

check("editing an UNCHECKED item's text just updates text, no stale", () => {
  const items = [item({ id: "a", text: "W-2", checked: false })];
  const after = editChecklistItemText(items, "a", "W-2 corrected");
  assert.equal(after[0].text, "W-2 corrected");
  assert.equal(after[0].checked, false);
  assert.ok(!after[0].stale, "not marked stale");
});

check("re-checking a stale item clears the stale flag (re-verified)", () => {
  const items = [item({ id: "a", checked: false, stale: true })];
  const after = setChecklistItemChecked(items, "a", true);
  assert.equal(after[0].checked, true);
  assert.ok(!after[0].stale, "stale cleared on re-check");
});

check("toggle can record the creator note in one gesture", () => {
  const items = [item({ id: "a" })];
  const after = setChecklistItemChecked(items, "a", true, "not needed — cash buyer");
  assert.equal(after[0].checked, true);
  assert.equal(after[0].note, "not needed — cash buyer");
});

check("per-item creator and checker notes are independent", () => {
  let items = [item({ id: "a" })];
  items = setChecklistItemNote(items, "a", "creator says X");
  items = setChecklistItemCheckerNote(items, "a", "checker says Y");
  assert.equal(items[0].note, "creator says X");
  assert.equal(items[0].checkerNote, "checker says Y");
});

// --- ordering --------------------------------------------------------------
check("stable add-order regardless of checked state (#96)", () => {
  const items = [
    item({ id: "1", checked: true }),
    item({ id: "2", checked: false }),
    item({ id: "3", checked: true }),
    item({ id: "4", checked: false })
  ];
  const sorted = sortChecklist(items);
  assert.deepEqual(sorted.map((i) => i.id), ["1", "2", "3", "4"]);
  assert.deepEqual(items.map((i) => i.id), ["1", "2", "3", "4"], "input untouched (purity)");
});

check("unresolvedCount / allChecklistResolved reflect the checked states", () => {
  const items = [item({ id: "1", checked: true }), item({ id: "2", checked: false })];
  assert.equal(unresolvedCount(items), 1);
  assert.equal(allChecklistResolved(items), false);
  assert.equal(allChecklistResolved([item({ id: "1", checked: true })]), true);
  assert.equal(allChecklistResolved([]), true, "empty list is fully resolved");
});

// --- turn permissions ------------------------------------------------------
check("OPEN (pre-claim, #69): creator seeds/manages their own draft list; outsider cannot", () => {
  // Pre-claim there is no assignee — the creator is the only active seat.
  const t = makeFraudTask({ status: "OPEN", assignee: undefined });
  assert.ok(canEditChecklist(t, CREATOR, "add"));
  assert.ok(canEditChecklist(t, CREATOR, "editText"), "creator may fix their own seed text pre-claim");
  assert.ok(canEditChecklist(t, CREATOR, "toggle"));
  assert.ok(canEditChecklist(t, CREATOR, "creatorNote"));
  assert.ok(!canEditChecklist(t, OUTSIDER, "add"));
  // Gated deletion: creator may delete their own fresh seeded draft on their
  // OPEN turn; a committed (handed-off) creator item is locked even in OPEN.
  assert.ok(canDeleteChecklistItem(t, CREATOR, item({ id: "a", addedBy: "creator", draft: true })), "creator deletes own OPEN draft");
  assert.ok(!canDeleteChecklistItem(t, CREATOR, item({ id: "b", addedBy: "creator" })), "committed creator item locked in OPEN");
  assert.ok(!canDeleteChecklistItem(t, OUTSIDER, item({ id: "c", addedBy: "creator", draft: true })), "outsider blocked in OPEN");
});

check("CLAIMED (initial pass): checker builds; creator/outsider cannot", () => {
  const t = makeFraudTask({ status: "CLAIMED" });
  assert.ok(canEditChecklist(t, CHECKER, "add"));
  assert.ok(canEditChecklist(t, CHECKER, "editText"));
  assert.ok(canEditChecklist(t, ADMIN, "add"));
  assert.ok(!canEditChecklist(t, CREATOR, "add"));
  assert.ok(!canEditChecklist(t, OUTSIDER, "add"));
});

check("AWAITING_ITEMS (creator's turn): creator resolves/notes/adds/submits; checker may add + checkerNote + toggle (#95)", () => {
  const t = makeFraudTask({ status: "AWAITING_ITEMS" });
  assert.ok(canEditChecklist(t, CREATOR, "toggle"));
  assert.ok(canEditChecklist(t, CREATOR, "creatorNote"));
  assert.ok(canEditChecklist(t, CREATOR, "add"));
  assert.ok(canEditChecklist(t, CHECKER, "add"));
  assert.ok(canEditChecklist(t, CHECKER, "checkerNote"));
  assert.ok(canEditChecklist(t, CHECKER, "toggle"), "checker can resolve items on the creator's turn (#95)");
  assert.ok(!canEditChecklist(t, CREATOR, "editText"), "creator can't rewrite item text (that's the checker's op, and it clears the check)");
  assert.ok(!canEditChecklist(t, OUTSIDER, "add"));
});

check("PENDING_APPROVAL (checker's turn): checker edits/adds/rechecks/notes; creator cannot mutate", () => {
  const t = makeFraudTask({ status: "PENDING_APPROVAL" });
  assert.ok(canEditChecklist(t, CHECKER, "editText"));
  assert.ok(canEditChecklist(t, CHECKER, "toggle"));
  assert.ok(canEditChecklist(t, CHECKER, "checkerNote"));
  assert.ok(!canEditChecklist(t, CREATOR, "toggle"));
  assert.ok(!canEditChecklist(t, CREATOR, "add"));
});

check("checklistSeat derives addedBy from the actor's real seat", () => {
  const t = makeFraudTask({ status: "AWAITING_ITEMS" });
  assert.equal(checklistSeat(t, CHECKER), "checker", "assignee is the checker");
  assert.equal(checklistSeat(t, CREATOR), "creator", "task creator is the creator");
  assert.equal(checklistSeat(t, ADMIN), "checker", "an admin holding neither seat acts for the checker");
});

check("no checklist edits on non-FRAUD or closed tasks", () => {
  const value = makeFraudTask({ taskType: "VALUE", status: "CLAIMED", assignee: { id: OUTSIDER.id, displayName: OUTSIDER.displayName } });
  assert.ok(!canEditChecklist(value, OUTSIDER, "add"));
  const done = makeFraudTask({ status: "COMPLETED" });
  assert.ok(!canEditChecklist(done, CHECKER, "add"));
  assert.ok(!canEditChecklist(done, CREATOR, "toggle"));
});

console.log(`\nAll ${passed} FRAUD checklist shared-model checks passed.`);
