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
 *   - No deletion: there is no delete method on the service at all.
 *   - Checked/stale: a checker editing a checked item's text clears the check
 *     and marks it stale (server round-trip), and it can be re-checked.
 *   - Approval gate: the checker approves (PENDING_APPROVAL → COMPLETED);
 *     the creator cannot. Approve-with-exceptions works (unresolved items).
 *   - Pass counter: 1 on the first send, ++ on each bounce-back; new items
 *     stamp the current pass.
 *   - Outstanding-items requirement is satisfied by a non-empty checklist
 *     (no free-text note needed), while the note-only path still works.
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

await check("the service has NO checklist delete/remove method (no-deletion is structural)", async () => {
  const { service } = await setup();
  const names = [
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(service)),
    ...Object.getOwnPropertyNames(service)
  ];
  const offenders = names.filter((n) => /checklist/i.test(n) && /(delete|remove)/i.test(n));
  assert.deepEqual(offenders, [], `no checklist delete method (found: ${offenders.join(", ")})`);
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

await check("submission notes are stored separate from per-item notes", async () => {
  const { service } = await setup();
  const id = await claimedFraud(service);
  await service.addChecklistItem(id, "an item", CHECKER);
  await service.transitionStatus(id, "AWAITING_ITEMS", CHECKER);
  const t = await service.setChecklistSubmissionNotes(id, "Everything attached in the shared drive.", CREATOR);
  assert.equal(t.submissionNotes, "Everything attached in the shared drive.");
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
