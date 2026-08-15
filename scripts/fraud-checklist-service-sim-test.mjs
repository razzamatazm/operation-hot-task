#!/usr/bin/env node
/*
 * Issue #44 — structured outstanding-items checklist (server behavior).
 *
 * Drives the real TaskService against a real (temp-file) TaskStore with a mock
 * notifier and asserts the SERVER-enforced invariants the client can't be
 * trusted with:
 *   - Turn permissions: checker builds in CLAIMED; creator resolves/notes/adds
 *     in AWAITING_ITEMS; checker edits/rechecks in PENDING_APPROVAL. Wrong
 *     role/turn is rejected.
 *   - addedBy is derived from the actor's real seat (creator-added items are
 *     flagged), not trusted from the client.
 *   - Gated deletion (#66): the adding seat can delete a fresh item on its own
 *     turn; deletion is rejected once the item is handed off (committed), for
 *     the other seat's items, for outsiders, and on non-FRAUD / closed tasks.
 *   - Checked/stale: a checker editing a checked item's text clears the check
 *     and marks it stale (server round-trip), and it can be re-checked.
 *   - Approval gate: the checker approves (PENDING_APPROVAL → COMPLETED);
 *     the creator cannot. Approve-with-exceptions works (unresolved items).
 *   - Pass counter: 1 on the first send, ++ on each bounce-back; new items
 *     stamp the current pass.
 *   - Outstanding-items requirement is satisfied by a non-empty checklist
 *     (no free-text note needed), while the note-only path still works.
 *   - Creator-seeded-at-creation items (#69): the creator can seed the list at
 *     create time (flagged addedBy=creator, draft, unchecked), manage their own
 *     seeds while the task is OPEN (pre-claim), and the seeds commit on the
 *     checker's first Send Outstanding Items.
 *   - Every mutation records exactly one CHECKLIST_UPDATED history event.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TaskStore } from "../apps/server/dist/store.js";
import { SseHub } from "../apps/server/dist/sse.js";
import { TaskService } from "../apps/server/dist/task-service.js";

const config = {
  businessTimezone: "America/Los_Angeles",
  businessStartHour: 8,
  businessStartMinute: 30,
  businessEndHour: 17,
  businessEndMinute: 30,
  archiveRetentionDays: 90
};

const CREATOR = { id: "creator-1", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] };
const CHECKER = { id: "checker-1", displayName: "Casey Checker", roles: ["FILE_CHECKER"] };
const OUTSIDER = { id: "rando-1", displayName: "Sam Nobody", roles: ["LOAN_OFFICER"] };

const setup = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fraud-checklist-sim-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.init();
  const events = [];
  const notifier = { notify: async (event) => { events.push(event); }, canReachDm: async () => true };
  const service = new TaskService(store, notifier, new SseHub(), config);
  return { service, store, events };
};

/* Create a FRAUD task and claim it as the checker — leaves it CLAIMED. */
const claimedFraud = async (service) => {
  const task = await service.createTask({ folderName: "Checklist Sim", taskType: "FRAUD", notes: "check it" }, CREATOR);
  await service.claimTask(task.id, CHECKER);
  return task.id;
};

/* Push the wall clock past the next millisecond, so two writes in a row get
   distinguishable ISO stamps. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

console.log("FRAUD checklist — TaskService sim");

await check("checker adds items in CLAIMED; flagged addedBy=checker on pass 1", async () => {
  const { service } = await setup();
  const id = await claimedFraud(service);
  const t = await service.addChecklistItem(id, "2023 tax returns", CHECKER);
  assert.equal(t.checklist.length, 1);
  assert.equal(t.checklist[0].addedBy, "checker");
  assert.equal(t.checklist[0].checked, false);
  assert.equal(t.checklist[0].addedOnPass, 1);
});

await check("creator cannot add items during the checker's CLAIMED pass", async () => {
  const { service } = await setup();
  const id = await claimedFraud(service);
  await assert.rejects(() => service.addChecklistItem(id, "sneak in", CREATOR), /can't change the checklist/i);
});

await check("adder deletes their OWN fresh item on their turn; records one CHECKLIST_UPDATED event", async () => {
  const { service, store } = await setup();
  const id = await claimedFraud(service);
  const withItem = await service.addChecklistItem(id, "oops typo item", CHECKER);
  const itemId = withItem.checklist[0].id;
  const before = await store.allHistoryForTask(id);
  const after = await service.removeChecklistItem(id, itemId, CHECKER);
  assert.equal(after.checklist.length, 0, "item removed");
  const hist = await store.allHistoryForTask(id);
  assert.equal(hist.length - before.length, 1, "exactly one history event");
  assert.equal(hist[hist.length - 1].action, "CHECKLIST_UPDATED");
});

await check("deletion is rejected once the item has been handed off (committed)", async () => {
  const { service } = await setup();
  const id = await claimedFraud(service);
  const withItem = await service.addChecklistItem(id, "W-2", CHECKER);
  const itemId = withItem.checklist[0].id;
  // Send Outstanding Items — CLAIMED → AWAITING_ITEMS commits the item.
  await service.transitionStatus(id, "AWAITING_ITEMS", CHECKER);
  await assert.rejects(() => service.removeChecklistItem(id, itemId, CHECKER), /can't delete this checklist item/i);
});

await check("deletion is rejected for the OTHER seat's item (creator can't delete a checker's live item)", async () => {
  const { service } = await setup();
  const id = await claimedFraud(service);
  await service.addChecklistItem(id, "checker item", CHECKER);
  await service.transitionStatus(id, "AWAITING_ITEMS", CHECKER);
  // Checker piles on a fresh item during the creator's turn.
  const withChecker = await service.addChecklistItem(id, "late checker add", CHECKER);
  const checkerItemId = withChecker.checklist.find((i) => i.text === "late checker add").id;
  await assert.rejects(() => service.removeChecklistItem(id, checkerItemId, CREATOR), /can't delete this checklist item/i);
});

await check("a creator CAN delete their own fresh item during AWAITING_ITEMS, but not after submit", async () => {
  const { service } = await setup();
  const id = await claimedFraud(service);
  await service.addChecklistItem(id, "seed", CHECKER);
  await service.transitionStatus(id, "AWAITING_ITEMS", CHECKER);
  const added = await service.addChecklistItem(id, "creator follow-up", CREATOR);
  const followId = added.checklist.find((i) => i.text === "creator follow-up").id;
  const afterDel = await service.removeChecklistItem(id, followId, CREATOR);
  assert.ok(!afterDel.checklist.some((i) => i.id === followId), "creator deleted own fresh item");
  // Add another, then submit → it commits and locks.
  const again = await service.addChecklistItem(id, "another follow-up", CREATOR);
  const anotherId = again.checklist.find((i) => i.text === "another follow-up").id;
  await service.transitionStatus(id, "PENDING_APPROVAL", CREATOR);
  await assert.rejects(() => service.removeChecklistItem(id, anotherId, CREATOR), /can't delete this checklist item/i);
});

await check("deletion is rejected for outsiders and on non-FRAUD / closed tasks", async () => {
  const { service } = await setup();
  const id = await claimedFraud(service);
  const withItem = await service.addChecklistItem(id, "x", CHECKER);
  const itemId = withItem.checklist[0].id;
  await assert.rejects(() => service.removeChecklistItem(id, itemId, OUTSIDER), /can't delete this checklist item/i);
  // Non-FRAUD task has no checklist surface at all.
  const value = await service.createTask({ folderName: "Not fraud", taskType: "VALUE", notes: "n" }, CREATOR);
  await assert.rejects(() => service.removeChecklistItem(value.id, "whatever", CHECKER), /only on fraud checks/i);
  // Closed task: drive to COMPLETED, then deletion is rejected.
  await service.transitionStatus(id, "AWAITING_ITEMS", CHECKER);
  await service.transitionStatus(id, "PENDING_APPROVAL", CREATOR);
  await service.transitionStatus(id, "COMPLETED", CHECKER);
  await assert.rejects(() => service.removeChecklistItem(id, itemId, CHECKER), /can't delete this checklist item/i);
});

await check("deleting a missing item id is rejected (not found)", async () => {
  const { service } = await setup();
  const id = await claimedFraud(service);
  await assert.rejects(() => service.removeChecklistItem(id, "no-such-item", CHECKER), /not found/i);
});

await check("non-empty checklist satisfies Send Outstanding Items with NO free-text note; pass = 1", async () => {
  const { service } = await setup();
  const id = await claimedFraud(service);
  await service.addChecklistItem(id, "W-2", CHECKER);
  const sent = await service.transitionStatus(id, "AWAITING_ITEMS", CHECKER); // no note
  assert.equal(sent.status, "AWAITING_ITEMS");
  assert.equal(sent.checklistPass, 1);
});

await check("Send Outstanding Items still rejected with neither a note nor a checklist item", async () => {
  const { service } = await setup();
  const id = await claimedFraud(service);
  await assert.rejects(() => service.transitionStatus(id, "AWAITING_ITEMS", CHECKER), /note or at least one checklist item/i);
});

await check("creator resolves an item with a per-item note during AWAITING_ITEMS", async () => {
  const { service } = await setup();
  const id = await claimedFraud(service);
  const withItem = await service.addChecklistItem(id, "Proof of funds", CHECKER);
  const itemId = withItem.checklist[0].id;
  await service.transitionStatus(id, "AWAITING_ITEMS", CHECKER);
  const resolved = await service.setChecklistItemChecked(id, itemId, true, "not needed — cash buyer", CREATOR);
  assert.equal(resolved.checklist[0].checked, true);
  assert.equal(resolved.checklist[0].note, "not needed — cash buyer");
  // Creator adds a follow-up item; flagged as creator-added.
  const added = await service.addChecklistItem(id, "HOA statement", CREATOR);
  assert.equal(added.checklist[1].addedBy, "creator");
});

await check("checker editing a checked item's text clears the check + marks stale; re-check clears stale", async () => {
  const { service } = await setup();
  const id = await claimedFraud(service);
  const withItem = await service.addChecklistItem(id, "W-2", CHECKER);
  const itemId = withItem.checklist[0].id;
  await service.transitionStatus(id, "AWAITING_ITEMS", CHECKER);
  await service.setChecklistItemChecked(id, itemId, true, undefined, CREATOR);
  await service.transitionStatus(id, "PENDING_APPROVAL", CREATOR);
  const edited = await service.editChecklistItemText(id, itemId, "W-2 (both employers)", CHECKER);
  assert.equal(edited.checklist[0].checked, false, "check cleared on edit");
  assert.equal(edited.checklist[0].stale, true, "marked stale");
  const rechecked = await service.setChecklistItemChecked(id, itemId, true, undefined, CHECKER);
  assert.ok(!rechecked.checklist[0].stale, "stale cleared on re-check");
});

await check("checker can set a per-item checker note on bounce-back review", async () => {
  const { service } = await setup();
  const id = await claimedFraud(service);
  const withItem = await service.addChecklistItem(id, "Bank statement", CHECKER);
  const itemId = withItem.checklist[0].id;
  await service.transitionStatus(id, "AWAITING_ITEMS", CHECKER);
  await service.setChecklistItemChecked(id, itemId, true, undefined, CREATOR);
  await service.transitionStatus(id, "PENDING_APPROVAL", CREATOR);
  const noted = await service.setChecklistItemCheckerNote(id, itemId, "wrong month — need June", CHECKER);
  assert.equal(noted.checklist[0].checkerNote, "wrong month — need June");
});

await check("bounce-back increments the pass counter; new items stamp the new pass", async () => {
  const { service } = await setup();
  const id = await claimedFraud(service);
  await service.addChecklistItem(id, "item 1", CHECKER);
  await service.transitionStatus(id, "AWAITING_ITEMS", CHECKER); // pass 1
  await service.transitionStatus(id, "PENDING_APPROVAL", CREATOR);
  const bounced = await service.transitionStatus(id, "AWAITING_ITEMS", CHECKER, "still need more"); // pass 2
  assert.equal(bounced.checklistPass, 2);
  const added = await service.addChecklistItem(id, "item 2", CHECKER);
  assert.equal(added.checklist.find((i) => i.text === "item 2").addedOnPass, 2);
});

await check("awaitingItemsSince stamps each hand-off and survives the requester's checklist edits", async () => {
  const { service } = await setup();
  const id = await claimedFraud(service);
  const withItem = await service.addChecklistItem(id, "W-2", CHECKER);
  const itemId = withItem.checklist[0].id;
  const sent = await service.transitionStatus(id, "AWAITING_ITEMS", CHECKER);
  assert.ok(sent.awaitingItemsSince, "stamped on the checker's initial send");
  assert.equal(sent.awaitingItemsSince, sent.updatedAt);

  // The requester working the checklist rewrites updatedAt — the anchor must
  // not move with it, or the web row's "with requester" counter resets every
  // time they tick an item. The sleeps only force a measurable gap: ISO stamps
  // are millisecond-resolution and these calls otherwise land in the same one,
  // which would make the "moved / did not move" comparisons meaningless.
  await tick();
  const ticked = await service.setChecklistItemChecked(id, itemId, true, undefined, CREATOR);
  assert.equal(ticked.awaitingItemsSince, sent.awaitingItemsSince, "anchor held across a checklist edit");
  assert.notEqual(ticked.updatedAt, ticked.awaitingItemsSince, "updatedAt moved, anchor did not");

  // Send Back restarts the clock rather than accumulating across passes.
  await service.transitionStatus(id, "PENDING_APPROVAL", CREATOR);
  await tick();
  const bounced = await service.transitionStatus(id, "AWAITING_ITEMS", CHECKER, "still need more");
  assert.notEqual(bounced.awaitingItemsSince, sent.awaitingItemsSince, "re-stamped on Send Back");
  assert.equal(bounced.awaitingItemsSince, bounced.updatedAt);
});

await check("approval gate: creator cannot approve; checker approves with exceptions (unresolved item)", async () => {
  const { service } = await setup();
  const id = await claimedFraud(service);
  await service.addChecklistItem(id, "leave me open", CHECKER);
  await service.transitionStatus(id, "AWAITING_ITEMS", CHECKER);
  await service.transitionStatus(id, "PENDING_APPROVAL", CREATOR);
  await assert.rejects(() => service.transitionStatus(id, "COMPLETED", CREATOR), /cannot complete/i);
  const done = await service.transitionStatus(id, "COMPLETED", CHECKER); // unresolved item present
  assert.equal(done.status, "COMPLETED");
});

await check("creator seeds outstanding items at creation (#69): flagged addedBy=creator, draft, unchecked, pass 0", async () => {
  const { service } = await setup();
  const task = await service.createTask(
    { folderName: "Seeded", taskType: "FRAUD", notes: "context for the checker", initialItems: [{ text: "2023 tax returns" }, { text: "Bank statement" }] },
    CREATOR
  );
  assert.equal(task.status, "OPEN");
  assert.equal(task.checklist.length, 2);
  assert.ok(task.checklist.every((i) => i.addedBy === "creator"), "all seeded items flagged creator");
  assert.ok(task.checklist.every((i) => i.checked === false), "seeded items start unchecked");
  assert.ok(task.checklist.every((i) => i.draft === true), "seeded items start as deletable drafts");
  assert.equal(task.checklist[0].addedOnPass, 0, "seeded before any pass");
  assert.equal(task.checklist[0].text, "2023 tax returns");
});

await check("non-FRAUD create ignores initialItems (no checklist surface)", async () => {
  const { service } = await setup();
  const task = await service.createTask(
    { folderName: "Not fraud", taskType: "VALUE", notes: "n", initialItems: [{ text: "should be ignored" }] },
    CREATOR
  );
  assert.ok(!task.checklist, "no checklist on non-FRAUD task");
});

await check("creator deletes their own seeded item while OPEN; it locks once the checker sends (#69/#66)", async () => {
  const { service } = await setup();
  const task = await service.createTask(
    { folderName: "Seeded", taskType: "FRAUD", notes: "context", initialItems: [{ text: "keep me" }, { text: "delete me" }] },
    CREATOR
  );
  const deleteId = task.checklist.find((i) => i.text === "delete me").id;
  const afterDel = await service.removeChecklistItem(task.id, deleteId, CREATOR);
  assert.ok(!afterDel.checklist.some((i) => i.id === deleteId), "creator deleted own fresh seed while OPEN");
  assert.equal(afterDel.checklist.length, 1);
  // A checker claims and sends outstanding items — that hand-off commits the seed.
  await service.claimTask(task.id, CHECKER);
  const keepId = afterDel.checklist.find((i) => i.text === "keep me").id;
  await service.transitionStatus(task.id, "AWAITING_ITEMS", CHECKER);
  await assert.rejects(() => service.removeChecklistItem(task.id, keepId, CREATOR), /can't delete this checklist item/i);
});

await check("outsider cannot delete a creator's seeded item while OPEN", async () => {
  const { service } = await setup();
  const task = await service.createTask(
    { folderName: "Seeded", taskType: "FRAUD", notes: "context", initialItems: [{ text: "mine" }] },
    CREATOR
  );
  const itemId = task.checklist[0].id;
  await assert.rejects(() => service.removeChecklistItem(task.id, itemId, OUTSIDER), /can't delete this checklist item/i);
});

await check("each checklist mutation records exactly one CHECKLIST_UPDATED history event", async () => {
  const { service, store } = await setup();
  const id = await claimedFraud(service);
  const before = await store.allHistoryForTask(id);
  await service.addChecklistItem(id, "history item", CHECKER);
  const after = await store.allHistoryForTask(id);
  assert.equal(after.length - before.length, 1);
  assert.equal(after[after.length - 1].action, "CHECKLIST_UPDATED");
});

await check("outsiders can't touch the checklist in any phase", async () => {
  const { service } = await setup();
  const id = await claimedFraud(service);
  const withItem = await service.addChecklistItem(id, "x", CHECKER);
  const itemId = withItem.checklist[0].id;
  await service.transitionStatus(id, "AWAITING_ITEMS", CHECKER);
  await assert.rejects(() => service.setChecklistItemChecked(id, itemId, true, undefined, OUTSIDER), /can't change the checklist/i);
  await assert.rejects(() => service.addChecklistItem(id, "y", OUTSIDER), /can't change the checklist/i);
});

console.log(`\nAll ${passed} FRAUD checklist service checks passed.`);
