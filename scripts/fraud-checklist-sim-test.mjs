#!/usr/bin/env node
/*
 * Issue #44 — structured outstanding-items checklist (shared-model invariants).
 *
 * Exercises the PURE checklist core in packages/shared/checklist.ts — the
 * data-model invariants the whole feature rides on:
 *   - Gated deletion (#66): the adding seat can delete a fresh (draft) item at
 *     any live status; it locks once handed off (committed), and the other
 *     seat's items are never deletable.
 *   - Checked/stale: editing a CHECKED item's text auto-clears the check and
 *     marks it stale; re-checking a stale item clears stale.
 *   - Ordering: unresolved (unchecked) items float to the top, checked settle
 *     below, stable (add-order) within each group.
 *   - Purity: every op returns a new array and never mutates the input.
 *   - The two permission rules (#146): recording reality (toggle / add / your
 *     own note) is open to both seats at every live status; changing what's
 *     being asked (retext / delete) is scoped to your own uncommitted item,
 *     with the checker's re-ask of a committed item as the one exception.
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
  canEditChecklistItemText,
  checklistSeat,
  commitChecklistItems,
  editChecklistItemText,
  removeChecklistItem,
  setChecklistItemChecked,
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

check("the adder can delete their OWN fresh draft, at every live status", () => {
  // No turn clause any more (#146): either seat may add off-turn, so gating
  // clean-up on whose turn it is would trap the adder with an item they could
  // never remove.
  for (const status of ["OPEN", "CLAIMED", "AWAITING_ITEMS", "PENDING_APPROVAL"]) {
    const t = makeFraudTask({ status, ...(status === "OPEN" ? { assignee: undefined } : {}) });
    if (status !== "OPEN") {
      assert.ok(canDeleteChecklistItem(t, CHECKER, item({ id: "a", addedBy: "checker", draft: true })), `checker deletes own draft in ${status}`);
    }
    assert.ok(canDeleteChecklistItem(t, CREATOR, item({ id: "b", addedBy: "creator", draft: true })), `requester deletes own draft in ${status}`);
  }
  const claimed = makeFraudTask({ status: "CLAIMED" });
  assert.ok(!canDeleteChecklistItem(claimed, ADMIN, item({ id: "a", addedBy: "checker", draft: true })), "an admin who is neither party holds no seat, so no delete");
});

check("a COMMITTED (handed-off) item is never deletable, even by its adder", () => {
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

check("outsiders can never delete; non-FRAUD / closed tasks allow no deletion", () => {
  const awaiting = makeFraudTask({ status: "AWAITING_ITEMS" });
  assert.ok(!canDeleteChecklistItem(awaiting, OUTSIDER, item({ id: "a", addedBy: "creator", draft: true })), "outsider blocked");
  const value = makeFraudTask({ taskType: "VALUE", status: "CLAIMED" });
  assert.ok(!canDeleteChecklistItem(value, CHECKER, item({ id: "b", addedBy: "checker", draft: true })), "non-FRAUD blocked");
  for (const status of ["COMPLETED", "CANCELLED", "ARCHIVED"]) {
    const done = makeFraudTask({ status });
    assert.ok(!canDeleteChecklistItem(done, CHECKER, item({ id: "c", addedBy: "checker", draft: true })), `${status} freezes the list`);
  }
});

// --- rule two, for text ----------------------------------------------------
check("you can retext your OWN uncommitted item, at every live status", () => {
  for (const status of ["OPEN", "CLAIMED", "AWAITING_ITEMS", "PENDING_APPROVAL"]) {
    const t = makeFraudTask({ status, ...(status === "OPEN" ? { assignee: undefined } : {}) });
    assert.ok(canEditChecklistItemText(t, CREATOR, item({ id: "a", addedBy: "creator", draft: true })), `requester fixes their own typo in ${status}`);
  }
});

check("the requester can never retext the checker's item, committed or not", () => {
  const awaiting = makeFraudTask({ status: "AWAITING_ITEMS" });
  assert.ok(!canEditChecklistItemText(awaiting, CREATOR, item({ id: "a", addedBy: "checker", draft: true })), "not a fresh one");
  assert.ok(!canEditChecklistItemText(awaiting, CREATOR, item({ id: "b", addedBy: "checker" })), "and not a committed one");
  assert.ok(!canEditChecklistItemText(awaiting, CREATOR, item({ id: "c", addedBy: "creator" })), "nor their own once it's been handed over");
});

check("the checker may re-ask a COMMITTED item — the one power beyond clean-up", () => {
  const pending = makeFraudTask({ status: "PENDING_APPROVAL" });
  assert.ok(canEditChecklistItemText(pending, CHECKER, item({ id: "a", addedBy: "checker" })), "checker retexts a committed item (uncheck+stale)");
  assert.ok(canEditChecklistItemText(pending, CHECKER, item({ id: "b", addedBy: "creator" })), "including one the requester added, once it's committed");
  // Narrow on purpose: a re-ask applies to what has actually been asked. An
  // uncommitted item of the requester's is a list nobody has been handed yet.
  const claimed = makeFraudTask({ status: "CLAIMED" });
  assert.ok(!canEditChecklistItemText(claimed, CHECKER, item({ id: "c", addedBy: "creator", draft: true })), "but not the requester's still-uncommitted draft");
  const done = makeFraudTask({ status: "COMPLETED" });
  assert.ok(!canEditChecklistItemText(done, CHECKER, item({ id: "d", addedBy: "checker" })), "and never on a closed task");
  assert.ok(!canEditChecklistItemText(pending, ADMIN, item({ id: "e", addedBy: "checker" })), "nor for an admin, who holds no seat");
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

check("a tick records the note in the ticking SEAT's field, never the other's", () => {
  const items = [item({ id: "a" })];
  const byRequester = setChecklistItemChecked(items, "a", true, "already in the file", "creator");
  assert.equal(byRequester[0].note, "already in the file", "the requester's exception note");
  assert.equal(byRequester[0].checkerNote, undefined);
  const byChecker = setChecklistItemChecked(items, "a", true, "saw it myself", "checker");
  assert.equal(byChecker[0].checkerNote, "saw it myself", "the checker's own note");
  assert.equal(byChecker[0].note, undefined, "and never a word in the requester's name");
});

check("toggle can record the creator note in one gesture", () => {
  const items = [item({ id: "a" })];
  const after = setChecklistItemChecked(items, "a", true, "not needed — cash buyer");
  assert.equal(after[0].checked, true);
  assert.equal(after[0].note, "not needed — cash buyer");
});

check("one setter, two fields: the acting seat picks which, and the client can't", () => {
  let items = [item({ id: "a" })];
  items = setChecklistItemNote(items, "a", "requester says X", "creator");
  items = setChecklistItemNote(items, "a", "checker says Y", "checker");
  assert.equal(items[0].note, "requester says X", "the requester's exception note");
  assert.equal(items[0].checkerNote, "checker says Y", "the checker's rework note, from the same function");
});

check("per-item creator and checker notes are independent", () => {
  let items = [item({ id: "a" })];
  items = setChecklistItemNote(items, "a", "creator says X");
  items = setChecklistItemNote(items, "a", "checker says Y", "checker");
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

// --- rule one: recording reality is always open ----------------------------
const LIVE_STATUSES = ["OPEN", "CLAIMED", "AWAITING_ITEMS", "PENDING_APPROVAL"];

check("both seats can record at EVERY live status", () => {
  // The case that broke the old per-status table: in CLAIMED nobody could tick,
  // so a requester who collected a document during the checker's initial pass
  // had nowhere to record it. Tick, add and your own note are one grant (#144),
  // so this is the whole of rule one.
  for (const status of LIVE_STATUSES) {
    const t = makeFraudTask({ status, ...(status === "OPEN" ? { assignee: undefined } : {}) });
    assert.ok(canEditChecklist(t, CREATOR), `requester records in ${status}`);
    if (status === "OPEN") {
      // No assignee yet, so there is no checker seat to hold — that falls out
      // of the seat function, not a status rule.
      assert.ok(!canEditChecklist(t, CHECKER), "no checker seat exists pre-claim");
    } else {
      assert.ok(canEditChecklist(t, CHECKER), `checker records in ${status}`);
    }
  }
});

check("which note field a seat writes is the seat's, not a permission", () => {
  // Since #144 there is one note op and one endpoint. Nobody is refused "the
  // other seat's note" — there is no way to ask for it: the seat picks the
  // field (see setChecklistItemNote), so the two can't be confused.
  for (const status of LIVE_STATUSES) {
    const t = makeFraudTask({ status, ...(status === "OPEN" ? { assignee: undefined } : {}) });
    assert.equal(checklistSeat(t, CREATOR), "creator", `requester writes their own note in ${status}`);
    assert.equal(checklistSeat(t, ADMIN), null, `and an admin writes nothing in ${status}`);
  }
});

check("holding no seat means no checklist ops at all", () => {
  for (const status of LIVE_STATUSES) {
    const t = makeFraudTask({ status, ...(status === "OPEN" ? { assignee: undefined } : {}) });
    assert.ok(!canEditChecklist(t, OUTSIDER), `outsider blocked in ${status}`);
    assert.ok(!canEditChecklist(t, ADMIN), "ADMIN grants back-end access, not a seat");
  }
});

check("checklistSeat derives addedBy from the actor's real seat", () => {
  const t = makeFraudTask({ status: "AWAITING_ITEMS" });
  assert.equal(checklistSeat(t, CHECKER), "checker", "assignee is the checker");
  assert.equal(checklistSeat(t, CREATOR), "creator", "task creator is the requester");
  // Was "checker": an admin used to satisfy both seat predicates at once, which
  // is how they ended up able to write a note in the requester's name.
  assert.equal(checklistSeat(t, ADMIN), null, "an admin holding neither seat holds no seat");
  assert.equal(checklistSeat(t, OUTSIDER), null, "a stranger holds no seat");
  const demoted = { ...CHECKER, roles: ["LOAN_OFFICER"] };
  assert.equal(checklistSeat(t, demoted), null, "the assignee who lost FILE_CHECKER vacates the checker seat");
  assert.ok(!canEditChecklist(makeFraudTask({ status: "CLAIMED" }), demoted), "and with it, the checklist");
});

check("no checklist edits on non-FRAUD tasks; closed means frozen", () => {
  const value = makeFraudTask({ taskType: "VALUE", status: "CLAIMED", assignee: { id: OUTSIDER.id, displayName: OUTSIDER.displayName } });
  assert.ok(!canEditChecklist(value, OUTSIDER));
  // An approve-with-exceptions leaves unresolved items unresolved forever —
  // that is the accurate record of what was true at approval.
  for (const status of ["COMPLETED", "CANCELLED", "ARCHIVED"]) {
    const done = makeFraudTask({ status });
    assert.ok(!canEditChecklist(done, CHECKER), `${status} refuses the checker`);
    assert.ok(!canEditChecklist(done, CREATOR), `${status} refuses the requester`);
  }
});

console.log(`\nAll ${passed} FRAUD checklist shared-model checks passed.`);
