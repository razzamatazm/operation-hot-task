#!/usr/bin/env node
/*
 * Issue #160 / ADR-0006 — a task's ask is amendable by its creator, and only
 * its ask.
 *
 * Two focused operations, never a generic patch: `updateTaskNotes` and
 * `updateTaskUrgency`. This drives the real TaskService against a real
 * (temp-file) TaskStore with a mock notifier and asserts the SERVER behaviour:
 *   - The creator may amend notes, and urgency on a non-OOO task, while the
 *     task is active.
 *   - Setting the urgency re-derives `dueAt` through the SHARED computation at
 *     the moment of the edit, and clears the last-reminder stamp so the cadence
 *     restarts against the new deadline.
 *   - Nobody but the creator may amend — assignee, admin and outsider are all
 *     refused, with a message naming the rule. ADMIN confers nothing.
 *   - Closed tasks are frozen; an OOO task's urgency is not amendable at all.
 *   - A no-op edit writes no history and notifies nobody.
 *   - An urgency change DMs the assignee when there is one; a notes change is
 *     silent. Neither posts to the channel; both re-render existing cards
 *     through the silent card-sync path.
 *   - Every applied edit lands in history with both values.
 *   - Two simultaneous edits do not erase one another (#158's rule).
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TaskStore } from "../apps/server/dist/store.js";
import { SseHub } from "../apps/server/dist/sse.js";
import { TaskService } from "../apps/server/dist/task-service.js";
import { computeDueAtFromUrgency, shouldSendReminder } from "../packages/shared/dist/workflow.js";

const config = {
  businessTimezone: "America/Los_Angeles",
  businessStartHour: 8,
  businessStartMinute: 30,
  businessEndHour: 17,
  businessEndMinute: 30,
  archiveRetentionDays: 90
};

const CREATOR = { id: "creator-1", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] };
const ASSIGNEE = { id: "assignee-1", displayName: "Sam Solver", roles: ["LOAN_OFFICER"] };
const OUTSIDER = { id: "outsider-1", displayName: "Nosy Neighbor", roles: ["LOAN_OFFICER"] };
const ADMIN = { id: "admin-1", displayName: "Alex Admin", roles: ["ADMIN"] };
const CHECKER = { id: "checker-1", displayName: "Fran Checker", roles: ["FILE_CHECKER"] };

const setup = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "amend-task-sim-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.init();
  const events = [];
  const notifier = { notify: async (event) => { events.push(event); } };
  const service = new TaskService(store, notifier, new SseHub(), config);
  return { service, store, events };
};

const isoDay = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

/* A plain active task filed by CREATOR. `claimed` puts ASSIGNEE on it, which is
   the only difference the urgency DM cares about. */
const makeTask = async (service, { taskType = "VALUE", claimed = false, urgency = "GREEN", notes = "original ask" } = {}) => {
  const oooDates = taskType === "OOO" ? { startDate: isoDay(1), returnDate: isoDay(3) } : {};
  const task = await service.createTask(
    { folderName: "Amend Sim", taskType, notes, ...(taskType === "OOO" ? {} : { urgency }), ...oooDates },
    CREATOR
  );
  if (claimed) {
    await service.claimTask(task.id, ASSIGNEE);
  }
  await service.settleBackgroundWork();
  return task.id;
};

const drain = async (service, events) => {
  await service.settleBackgroundWork();
  events.length = 0;
};

const rejects = async (fn, pattern, label) => {
  await assert.rejects(fn, (error) => {
    assert.match(error.message, pattern, `${label}: message names the rule (got "${error.message}")`);
    return true;
  }, label);
};

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

console.log("Amend a task's ask (ADR-0006) — TaskService sim");

await check("the creator changes the notes on an active task, and it persists", async () => {
  const { service, store } = await setup();
  const id = await makeTask(service);
  const updated = await service.updateTaskNotes(id, "the corrected ask", CREATOR);
  assert.equal(updated.notes, "the corrected ask");
  const reloaded = await store.findTask(id);
  assert.equal(reloaded.notes, "the corrected ask", "visible on reload");
});

await check("the creator changes the urgency, and dueAt is re-derived from it", async () => {
  const { service, store } = await setup();
  const id = await makeTask(service, { urgency: "GREEN" });
  const before = await store.findTask(id);
  const at = Date.now();
  const updated = await service.updateTaskUrgency(id, "ORANGE", CREATOR);
  assert.equal(updated.urgency, "ORANGE");
  assert.notEqual(updated.dueAt, before.dueAt, "the deadline moved");
  // The shared computation, evaluated at the moment of the edit — ORANGE is an
  // hour out, so allow a couple of seconds of slop against the sim's own clock.
  const expected = Date.parse(computeDueAtFromUrgency("ORANGE", new Date(at), config));
  assert.ok(
    Math.abs(Date.parse(updated.dueAt) - expected) < 5000,
    `dueAt comes from the shared computation at edit time (got ${updated.dueAt})`
  );
});

await check("no operation accepts a dueAt from its caller", async () => {
  const { service, store } = await setup();
  // Three parameters each — task id, new value, actor. There is no fourth for a
  // deadline, so no caller can hand one in; `dueAt` is only ever derived.
  assert.equal(service.updateTaskNotes.length, 3, "updateTaskNotes takes id, notes, actor");
  assert.equal(service.updateTaskUrgency.length, 3, "updateTaskUrgency takes id, urgency, actor");

  const id = await makeTask(service);
  const before = await store.findTask(id);
  const updated = await service.updateTaskNotes(id, "still no dueAt", CREATOR);
  assert.equal(updated.dueAt, before.dueAt, "a notes edit never moves the deadline");
});

await check("a non-creator is refused on both operations, with a message naming the rule", async () => {
  for (const actor of [ASSIGNEE, ADMIN, OUTSIDER]) {
    const { service } = await setup();
    const id = await makeTask(service, { claimed: true });
    await rejects(
      () => service.updateTaskNotes(id, "not yours to reword", actor),
      /creator/i,
      `notes refused for ${actor.displayName}`
    );
    await rejects(
      () => service.updateTaskUrgency(id, "RED", actor),
      /creator/i,
      `urgency refused for ${actor.displayName}`
    );
  }
});

await check("both operations are refused on a closed task", async () => {
  for (const status of ["COMPLETED", "CANCELLED", "ARCHIVED"]) {
    const { service } = await setup();
    const id = await makeTask(service, { claimed: true });
    if (status === "ARCHIVED") {
      await service.transitionStatus(id, "COMPLETED", ASSIGNEE);
      await service.transitionStatus(id, "ARCHIVED", CREATOR);
    } else {
      await service.transitionStatus(id, status, status === "COMPLETED" ? ASSIGNEE : CREATOR);
    }
    await rejects(
      () => service.updateTaskNotes(id, "reopening the argument", CREATOR),
      /closed/i,
      `notes refused at ${status}`
    );
    await rejects(
      () => service.updateTaskUrgency(id, "RED", CREATOR),
      /closed/i,
      `urgency refused at ${status}`
    );
  }
});

await check("an urgency edit on an OOO task is refused", async () => {
  const { service } = await setup();
  const id = await makeTask(service, { taskType: "OOO" });
  await rejects(
    () => service.updateTaskUrgency(id, "RED", CREATOR),
    /OOO/i,
    "OOO urgency refused"
  );
  // Its notes are still the creator's to correct.
  const updated = await service.updateTaskNotes(id, "back on the 4th, not the 3rd", CREATOR);
  assert.equal(updated.notes, "back on the 4th, not the 3rd");
});

await check("a no-op edit writes no history and notifies nobody", async () => {
  const { service, store, events } = await setup();
  const id = await makeTask(service, { claimed: true, urgency: "YELLOW", notes: "same as it ever was" });
  await drain(service, events);
  const historyBefore = await store.allHistoryForTask(id);
  const before = await store.findTask(id);

  await service.updateTaskNotes(id, "same as it ever was", CREATOR);
  await service.updateTaskUrgency(id, "YELLOW", CREATOR);
  await service.settleBackgroundWork();

  assert.equal((await store.allHistoryForTask(id)).length, historyBefore.length, "no history event");
  assert.equal(events.length, 0, "no notification of any kind");
  assert.equal((await store.findTask(id)).dueAt, before.dueAt, "the deadline is not even restamped");
});

await check("an urgency change DMs the assignee, and stays off the channel", async () => {
  const { service, events } = await setup();
  const id = await makeTask(service, { claimed: true });
  await drain(service, events);

  await service.updateTaskUrgency(id, "RED", CREATOR);
  await service.settleBackgroundWork();

  const dms = events.filter((e) => e.target === "DM");
  assert.equal(dms.length, 1, "exactly one plain DM");
  assert.deepEqual(dms[0].recipientUserIds, [ASSIGNEE.id], "it goes to the assignee");
  assert.equal(events.filter((e) => e.target === "DM_CARD_SYNC").length, 1, "cards are re-rendered");
  assert.equal(events.filter((e) => e.target.startsWith("CHANNEL")).length, 0, "nothing posted to the channel");
});

await check("an urgency change on an unclaimed task DMs nobody, but still syncs cards", async () => {
  const { service, events } = await setup();
  const id = await makeTask(service);
  await drain(service, events);

  await service.updateTaskUrgency(id, "RED", CREATOR);
  await service.settleBackgroundWork();

  assert.equal(events.filter((e) => e.target === "DM").length, 0, "no DM without an assignee");
  assert.equal(events.filter((e) => e.target === "DM_CARD_SYNC").length, 1, "cards are still re-rendered");
  assert.equal(events.filter((e) => e.target.startsWith("CHANNEL")).length, 0, "nothing posted to the channel");
});

await check("a notes change DMs nobody, and still syncs cards", async () => {
  const { service, events } = await setup();
  const id = await makeTask(service, { claimed: true });
  await drain(service, events);

  await service.updateTaskNotes(id, "actually it's the second file", CREATOR);
  await service.settleBackgroundWork();

  assert.equal(events.filter((e) => e.target !== "DM_CARD_SYNC").length, 0, "silent apart from the sync");
  assert.equal(events.filter((e) => e.target === "DM_CARD_SYNC").length, 1, "cards are re-rendered");
});

await check("an urgency change clears the last-reminder stamp", async () => {
  const { service, store } = await setup();
  const id = await makeTask(service, { claimed: true });
  const stamped = await store.updateTask(id, (current) => ({
    task: { ...current, lastReminderAt: new Date().toISOString() }
  }));
  assert.ok(stamped.lastReminderAt, "the stamp is set to begin with");

  const updated = await service.updateTaskUrgency(id, "RED", CREATOR);
  assert.equal(updated.lastReminderAt, undefined, "the cadence restarts against the new deadline");

  /* And the clearing is what makes the newly-overdue task eligible *now*
     rather than at the end of the cadence window. Judged at a fixed weekday
     mid-morning against a deadline an hour past, so the assertion doesn't turn
     on when the suite happens to run — the only difference between the two
     calls is the stamp. */
  const businessNow = new Date("2026-03-03T18:00:00.000Z"); // Tue 10:00 PT
  const overdue = { ...updated, dueAt: new Date(businessNow.getTime() - 3600000).toISOString() };
  assert.equal(shouldSendReminder(overdue, businessNow, config), true, "eligible immediately");
  assert.equal(
    shouldSendReminder({ ...overdue, lastReminderAt: new Date(businessNow.getTime() - 60000).toISOString() }, businessNow, config),
    false,
    "and would have been suppressed had the stamp survived"
  );
});

await check("an AWAITING_ITEMS task is still amendable — it is waiting, not closed", async () => {
  const { service } = await setup();
  const task = await service.createTask(
    { folderName: "Awaiting Amend Sim", taskType: "FRAUD", notes: "check this", urgency: "GREEN" },
    CREATOR
  );
  await service.claimTask(task.id, CHECKER);
  await service.transitionStatus(task.id, "AWAITING_ITEMS", CHECKER, "need the paystub");
  await service.settleBackgroundWork();
  assert.equal((await service.getTask(task.id)).status, "AWAITING_ITEMS");

  // ADR-0006 freezes *closed* tasks — completed, cancelled, archived. A FRAUD
  // check parked on its requester is the case whose ask most often needs
  // correcting, and the web offers the button here, so the server must take it.
  const updated = await service.updateTaskNotes(task.id, "check this, and the second file", CREATOR);
  assert.equal(updated.notes, "check this, and the second file");
  assert.equal((await service.updateTaskUrgency(task.id, "RED", CREATOR)).urgency, "RED");
});

await check("each applied edit lands in history with the field and both values", async () => {
  const { service, store } = await setup();
  const id = await makeTask(service, { urgency: "GREEN", notes: "first draft" });
  await service.updateTaskNotes(id, "second draft", CREATOR);
  await service.updateTaskUrgency(id, "RED", CREATOR);
  const history = await store.allHistoryForTask(id);

  const notesEvent = history.find((e) => e.action === "TASK_NOTES_AMENDED");
  assert.ok(notesEvent, "a notes-amended event");
  assert.match(notesEvent.detail, /first draft/, "old value");
  assert.match(notesEvent.detail, /second draft/, "new value");
  assert.equal(notesEvent.by.id, CREATOR.id);

  const urgencyEvent = history.find((e) => e.action === "TASK_URGENCY_AMENDED");
  assert.ok(urgencyEvent, "an urgency-amended event");
  assert.match(urgencyEvent.detail, /24 Hours/, "old value");
  assert.match(urgencyEvent.detail, /Urgent Now/, "new value");
});

await check("two simultaneous edits do not lose one another", async () => {
  const { service, store } = await setup();
  const id = await makeTask(service, { urgency: "GREEN", notes: "before" });
  await Promise.all([
    service.updateTaskNotes(id, "after", CREATOR),
    service.updateTaskUrgency(id, "RED", CREATOR),
    service.updateTaskPoints(id, 4, CREATOR)
  ]);
  const task = await store.findTask(id);
  assert.equal(task.notes, "after", "the notes edit survived");
  assert.equal(task.urgency, "RED", "the urgency edit survived");
  assert.equal(task.points, 4, "the unrelated edit survived too");
});

await check("neither edit disturbs the thread, checklist, seats or status", async () => {
  const { service, store } = await setup();
  const task = await service.createTask(
    {
      folderName: "Fraud Amend Sim",
      taskType: "FRAUD",
      notes: "check this one",
      urgency: "GREEN",
      initialItems: [{ text: "paystub" }, { text: "bank statement" }]
    },
    CREATOR
  );
  await service.claimTask(task.id, CHECKER);
  await service.addReviewNote(task.id, "on it", CHECKER);
  await service.settleBackgroundWork();
  const before = await store.findTask(task.id);

  await service.updateTaskNotes(task.id, "check the second file too", CREATOR);
  const after = await service.updateTaskUrgency(task.id, "YELLOW", CREATOR);

  assert.deepEqual(after.reviewNotes, before.reviewNotes, "the notes thread is untouched");
  assert.deepEqual(after.checklist, before.checklist, "the checklist is untouched");
  assert.deepEqual(after.assignee, before.assignee, "the assignee is untouched");
  assert.deepEqual(after.createdBy, before.createdBy, "the creator is untouched");
  assert.equal(after.status, before.status, "the status is untouched");
});

console.log(`\n${passed} checks passed.`);
