#!/usr/bin/env node
/*
 * Issue #160 / ADR-0006, extended by #263 / ADR-0008 rule 5 — a task's ask is
 * amendable by the people with a stake in it, and only its ask.
 *
 * ADR-0006's original rule (creator-only, notes and urgency) is asserted first
 * and still holds for urgency on every type and for the request field on five
 * of the six types. The final section covers what ADR-0008 widened: an LOI's
 * request field is the loan's *terms*, and either party may correct them.
 *
 * Focused operations, never a generic patch: `updateTaskNotes`,
 * `updateTaskUrgency`, and — since #262 / ADR-0008 rule 7 —
 * `updateTaskFolderName`, which is OOO-only because every other type's folder
 * name is its LOAN's name and is edited on the shared Loan record instead.
 * This drives the real TaskService against a real
 * (temp-file) TaskStore with a mock notifier and asserts the SERVER behaviour:
 *   - The creator may amend notes, and urgency on a non-OOO task, while the
 *     task is active.
 *   - Setting the urgency re-derives `dueAt` through the SHARED computation at
 *     the moment of the edit, and clears the last-reminder stamp so the cadence
 *     restarts against the new deadline.
 *   - Nobody but the creator may amend a non-LOI task — assignee, admin and
 *     outsider are all refused, with a message naming the rule, and ADMIN
 *     confers nothing. On an LOI the checker holding it may correct the terms,
 *     and still nobody else may.
 *   - Closed tasks are frozen; an OOO task's urgency is not amendable at all.
 *   - A no-op edit writes no history and notifies nobody.
 *   - An urgency change DMs the assignee when there is one. So does a change to
 *     an LOI's terms, unless the holder made it themselves (#267, rule 9); a
 *     notes change on the other five types is silent. Nothing posts to the
 *     channel, and every applied edit re-renders existing cards through the
 *     silent card-sync path.
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
const makeTask = async (service, { taskType = "VALUE", claimed = false, holder = ASSIGNEE, urgency = "GREEN", notes = "original ask" } = {}) => {
  const oooDates = taskType === "OOO" ? { startDate: isoDay(1), returnDate: isoDay(3) } : {};
  const task = await service.createTask(
    { folderName: "Amend Sim", taskType, notes, ...(taskType === "OOO" ? {} : { urgency }), ...oooDates },
    CREATOR
  );
  if (claimed) {
    await service.claimTask(task.id, holder);
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

await check("all three operations are refused on a closed task", async () => {
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
    // The other half of the gate #261 rewrote: widening it to every non-closed
    // status must not have widened it past closed.
    await rejects(
      () => service.updateTaskPoints(id, 5, CREATOR),
      /closed/i,
      `poops refused at ${status}`
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

/* ── An OOO task's vacation description (#262, ADR-0008 rule 7) ──────────
   The third focused operation, and the one that is OOO-only. Every other type's
   folder name is its LOAN's name — shared by every task on that loan and edited
   through the loan — so writing it on a single task is refused outright rather
   than quietly putting that task's copy out of step with its siblings. */

await check("the creator rewrites an OOO task's description, on the task", async () => {
  const { service, store } = await setup();
  const id = await makeTask(service, { taskType: "OOO" });
  const updated = await service.updateTaskFolderName(id, "Ski trip, not a conference", CREATOR);
  assert.equal(updated.folderName, "Ski trip, not a conference");
  assert.equal(updated.loanName, "Ski trip, not a conference", "the alias field moves with it");
  const reloaded = await store.findTask(id);
  assert.equal(reloaded.folderName, "Ski trip, not a conference", "visible on reload");
  assert.equal(reloaded.loanId, undefined, "an OOO task still has no loan");
});

await check("every other type's folder name is refused — it belongs to the loan", async () => {
  const { service, store } = await setup();
  for (const taskType of ["LOI", "BUDDY_CHAT", "VALUE", "FRAUD", "LOAN_DOCS"]) {
    const id = await makeTask(service, { taskType });
    await rejects(
      () => service.updateTaskFolderName(id, "Renamed On One Task Only", CREATOR),
      /loan/i,
      `${taskType} folder name refused`
    );
    assert.equal((await store.findTask(id)).folderName, "Amend Sim", `${taskType} name untouched`);
  }
});

await check("the description follows the same rule as the rest of the ask", async () => {
  const { service, store } = await setup();
  const id = await makeTask(service, { taskType: "OOO" });
  await rejects(
    () => service.updateTaskFolderName(id, "Nice try", ASSIGNEE),
    /creator/i,
    "a non-creator is refused"
  );
  await rejects(
    () => service.updateTaskFolderName(id, "Nice try", ADMIN),
    /creator/i,
    "and so is an admin"
  );
  await rejects(() => service.updateTaskFolderName(id, "   ", CREATOR), /empt/i, "emptying it is refused");
  assert.equal((await store.findTask(id)).folderName, "Amend Sim", "none of that landed");

  await service.transitionStatus(id, "CANCELLED", CREATOR);
  await rejects(
    () => service.updateTaskFolderName(id, "Too late", CREATOR),
    /closed task/i,
    "a closed task is frozen"
  );
});

await check("a description edit is silent, lands in history, and no-ops cleanly", async () => {
  const { service, store, events } = await setup();
  const id = await makeTask(service, { taskType: "OOO" });
  await drain(service, events);

  await service.updateTaskFolderName(id, "Amend Sim", CREATOR);
  await service.settleBackgroundWork();
  assert.equal((await store.allHistoryForTask(id)).filter((e) => e.action === "TASK_FOLDER_NAME_AMENDED").length, 0,
    "setting it to what it already says writes no history");
  assert.equal(events.length, 0, "and notifies nobody");

  await service.updateTaskFolderName(id, "Paternity leave", CREATOR);
  await service.settleBackgroundWork();
  const event = (await store.allHistoryForTask(id)).find((e) => e.action === "TASK_FOLDER_NAME_AMENDED");
  assert.ok(event, "an applied edit is in history");
  assert.match(event.detail, /Amend Sim/, "old value");
  assert.match(event.detail, /Paternity leave/, "new value");
  assert.equal(event.by.id, CREATOR.id);
  assert.ok(
    events.every((e) => e.type !== "channel"),
    "nothing goes to the channel"
  );
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

/* #261 put the poops on the same edit form as the urgency, so what each one
   says out loud is now a choice a person makes in one place. They differ: the
   urgency moved somebody's deadline, a rating did not. */
await check("a points change is silent, even on a claimed task", async () => {
  const { service, store, events } = await setup();
  const id = await makeTask(service, { claimed: true });
  await drain(service, events);
  const before = await store.findTask(id);

  const updated = await service.updateTaskPoints(id, 5, CREATOR);
  await service.settleBackgroundWork();

  assert.equal(updated.points, 5, "the rating changed");
  assert.equal(events.length, 0, "and nobody was told, by any route");
  assert.equal(updated.dueAt, before.dueAt, "the deadline is untouched");
  const history = await store.allHistoryForTask(id);
  assert.ok(history.some((e) => e.action === "TASK_POINTS_UPDATED"), "but it is in the history");
});

/* ADR-0008 rule 9: every applied edit lands in the history with both values.
   The rating used to record only where it ended up, which was survivable while
   it lived on the row alone; #261 put it on the same form as the notes, the
   urgency and the OOO dates, all three of which name what they moved from. */
await check("the rating's history line names the value it moved from", async () => {
  const { service, store } = await setup();
  const id = await makeTask(service);
  const before = await service.updateTaskPoints(id, 2, CREATOR);
  assert.equal(before.points, 2, "the starting rating is the one we set");

  await service.updateTaskPoints(id, 5, CREATOR);

  const history = await store.allHistoryForTask(id);
  const entry = history.filter((e) => e.action === "TASK_POINTS_UPDATED").pop();
  assert.match(entry.detail, /from 2 to 5/, "the line names both values, as the other amended fields do");
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

  // Points too (#261). They used to be gated on the reminder engine's
  // ACTIVE_STATUSES, which excludes AWAITING_ITEMS for a scheduling reason that
  // has nothing to do with permission — so the one edit form that now offers
  // all three fields would have had its poops refused as "closed" on a task
  // plainly not closed.
  assert.equal((await service.updateTaskPoints(task.id, 4, CREATOR)).points, 4);
});

await check("each applied edit lands in history with the field and both values", async () => {
  const { service, store } = await setup();
  const id = await makeTask(service, { urgency: "GREEN", notes: "first draft" });
  await service.updateTaskNotes(id, "second draft", CREATOR);
  await service.updateTaskUrgency(id, "RED", CREATOR);
  await service.updateTaskPoints(id, 3, CREATOR);
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

  const pointsEvent = history.find((e) => e.action === "TASK_POINTS_UPDATED");
  assert.ok(pointsEvent, "a points-updated event");
  assert.match(pointsEvent.detail, /from 1/, "old value");
  assert.match(pointsEvent.detail, /to 3/, "new value");
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

/* ──────────────────────────────────────────────────────────────────────────
   #263 / ADR-0008 rule 5 — whoever holds an LOI may correct its terms.

   ADR-0006's creator-only rule survives in exactly one clause (urgency) and on
   exactly five task types. On an LOI the request field is the loan's *terms*:
   facts a second person is verifying, and the checker is the one reading them
   closely enough to spot a transposed digit. So both parties may correct them,
   at any open status, and nobody else may — not an observer, not a file checker
   who has not claimed it, not an admin (ADR-0003).

   Everything below is asked of the real TaskService, because the ADR's promise
   is about what the server accepts, not about what a form draws.
   ────────────────────────────────────────────────────────────────────────── */

await check("the checker holding an LOI corrects its terms", async () => {
  const { service, store } = await setup();
  const id = await makeTask(service, { taskType: "LOI", claimed: true, holder: CHECKER, notes: "Rate: 9.75%" });
  const updated = await service.updateTaskNotes(id, "Rate: 9.57%", CHECKER);
  assert.equal(updated.notes, "Rate: 9.57%");
  assert.equal((await store.findTask(id)).notes, "Rate: 9.57%", "visible on reload");
});

await check("the creator of an LOI still corrects its terms", async () => {
  const { service } = await setup();
  const id = await makeTask(service, { taskType: "LOI", claimed: true, holder: CHECKER, notes: "Rate: 9.75%" });
  assert.equal((await service.updateTaskNotes(id, "Rate: 9.57%", CREATOR)).notes, "Rate: 9.57%");
});

/* Still correctable while the ball is in the creator's court. `NEEDS_REVIEW`
   moves whose turn it is, not who holds the task — `task.assignee` is
   unchanged — and a checker who spots the typo that caused the corrections
   round is exactly the person this rule is for. */
await check("an LOI in the corrections state is still correctable by both parties", async () => {
  const { service } = await setup();
  const id = await makeTask(service, { taskType: "LOI", claimed: true, holder: CHECKER, notes: "Rate: 9.75%" });
  await service.transitionStatus(id, "NEEDS_REVIEW", CHECKER, "the rate looks wrong");
  await service.settleBackgroundWork();
  assert.equal((await service.getTask(id)).status, "NEEDS_REVIEW");

  assert.equal((await service.updateTaskNotes(id, "Rate: 9.57%", CHECKER)).notes, "Rate: 9.57%");
  assert.equal((await service.updateTaskNotes(id, "Rate: 9.50%", CREATOR)).notes, "Rate: 9.50%");
});

await check("nobody outside the two parties may touch an LOI's terms", async () => {
  // Unclaimed, then claimed. CHECKER on the unclaimed pass is the case the
  // ticket names: a file checker who COULD take the task is still an outsider
  // until they do. On the claimed pass CHECKER holds it, so the outsiders are
  // the observer and the admin — back-end access confers nothing (ADR-0003).
  for (const [claimed, actors] of [[false, [OUTSIDER, ADMIN, CHECKER]], [true, [OUTSIDER, ADMIN]]]) {
    for (const actor of actors) {
      const { service } = await setup();
      const id = await makeTask(service, { taskType: "LOI", claimed, holder: CHECKER, notes: "Rate: 9.75%" });
      await rejects(
        () => service.updateTaskNotes(id, "not mine to correct", actor),
        /terms/i,
        `LOI terms refused for ${actor.displayName} on a ${claimed ? "claimed" : "unclaimed"} LOI`
      );
    }
  }
});

/* All six types, because "on any type" is the acceptance criterion. OOO is the
   odd one out only in what the creator hears: its timing is a pair of dates, so
   even the creator is refused — and the permission check runs first, so a
   non-creator still hears the rule that actually refused them. */
await check("urgency stays the creator's on every type, holder or not", async () => {
  for (const taskType of ["LOI", "BUDDY_CHAT", "VALUE", "FRAUD", "LOAN_DOCS", "OOO"]) {
    const { service } = await setup();
    const id = await makeTask(service, { taskType, claimed: true, holder: CHECKER });
    await rejects(
      () => service.updateTaskUrgency(id, "RED", CHECKER),
      /creator/i,
      `${taskType} urgency refused for its holder`
    );
    await rejects(
      () => service.updateTaskUrgency(id, "RED", OUTSIDER),
      /creator/i,
      `${taskType} urgency refused for an observer`
    );
    await rejects(
      () => service.updateTaskUrgency(id, "RED", ADMIN),
      /creator/i,
      `${taskType} urgency refused for an admin`
    );
    if (taskType === "OOO") {
      await rejects(() => service.updateTaskUrgency(id, "RED", CREATOR), /OOO/i, "OOO has no urgency to set");
    } else {
      assert.equal((await service.updateTaskUrgency(id, "RED", CREATOR)).urgency, "RED", `${taskType} creator may`);
    }
  }
});

await check("the other five types' request fields stay creator-only", async () => {
  for (const taskType of ["BUDDY_CHAT", "VALUE", "FRAUD", "LOAN_DOCS", "OOO"]) {
    const { service } = await setup();
    const id = await makeTask(service, { taskType, claimed: true, holder: CHECKER, notes: "my own words" });
    for (const actor of [CHECKER, OUTSIDER, ADMIN]) {
      await rejects(
        () => service.updateTaskNotes(id, "reworded by someone else", actor),
        /creator/i,
        `${taskType} notes refused for ${actor.displayName}`
      );
    }
    assert.equal((await service.updateTaskNotes(id, "my own words, fixed", CREATOR)).notes, "my own words, fixed");
  }
});

await check("a closed LOI refuses every edit, including from both parties", async () => {
  for (const status of ["COMPLETED", "CANCELLED", "ARCHIVED"]) {
    const { service } = await setup();
    const id = await makeTask(service, { taskType: "LOI", claimed: true, holder: CHECKER, notes: "Rate: 9.75%" });
    if (status === "ARCHIVED") {
      await service.transitionStatus(id, "COMPLETED", CHECKER);
      await service.transitionStatus(id, "ARCHIVED", CREATOR);
    } else {
      await service.transitionStatus(id, status, status === "COMPLETED" ? CHECKER : CREATOR);
    }
    await service.settleBackgroundWork();
    for (const actor of [CREATOR, CHECKER]) {
      await rejects(
        () => service.updateTaskNotes(id, "too late", actor),
        /closed/i,
        `LOI terms refused at ${status} for ${actor.displayName}`
      );
    }
  }
});

/* The refusal names the rule that refused, not a generic denial — the same
   convention every other refusal in this file is asserted against. On an LOI
   the field is called what the app calls it. */
await check("the LOI refusals name the rule and the field by its own name", async () => {
  const { service } = await setup();
  const id = await makeTask(service, { taskType: "LOI", claimed: true, holder: CHECKER });
  await rejects(
    () => service.updateTaskNotes(id, "nope", OUTSIDER),
    /^Only the person who filed this LOI or the checker holding it can change its terms$/,
    "outsider hears who may"
  );
  await rejects(
    () => service.updateTaskUrgency(id, "RED", CHECKER),
    /^Only the task creator can change its urgency$/,
    "the holder hears the urgency rule by name"
  );

  await service.transitionStatus(id, "COMPLETED", CHECKER);
  await service.settleBackgroundWork();
  await rejects(
    () => service.updateTaskNotes(id, "nope", CREATOR),
    /^The terms cannot be changed on a closed task$/,
    "a closed LOI says terms, not notes"
  );
});

/* One noun for the field, everywhere a sentence names it. A reader told "the
   terms cannot be changed on a closed task" and then shown a history line
   reading "Notes changed" is reading about two different fields. */
await check("an LOI calls the field terms in the history and in the empty refusal", async () => {
  const { service, store } = await setup();
  const id = await makeTask(service, { taskType: "LOI", claimed: true, holder: CHECKER, notes: "Rate: 9.75%" });
  await service.updateTaskNotes(id, "Rate: 9.57%", CHECKER);
  const event = (await store.allHistoryForTask(id)).find((e) => e.action === "TASK_NOTES_AMENDED");
  assert.match(event.detail, /^Terms changed from/, "the history entry says Terms");

  await rejects(
    () => service.updateTaskNotes(id, "   ", CREATOR),
    /^The terms cannot be emptied$/,
    "and so does the required-field refusal"
  );

  const other = await setup();
  const plain = await makeTask(other.service, { taskType: "VALUE", notes: "the ask" });
  await rejects(
    () => other.service.updateTaskNotes(plain, "  ", CREATOR),
    /^The notes cannot be emptied$/,
    "the other five types still say notes"
  );
});

/* ──────────────────────────────────────────────────────────────────────────
   #267 / ADR-0008 rule 9 — who hears about a terms change.

   The terms are what the checker is checking against, so a change to them
   under a working checker is the one amendment likely to make somebody's work
   wrong. That is what separates it from the wording fix on the other five
   types, which stays silent. Nobody but the assignee is told, nothing reaches
   the channel, and the existing cards re-render either way so no surface is
   left quoting stale terms.
   ────────────────────────────────────────────────────────────────────────── */

await check("a terms change on a claimed LOI DMs the holder, and stays off the channel", async () => {
  const { service, events } = await setup();
  const id = await makeTask(service, { taskType: "LOI", claimed: true, holder: CHECKER, notes: "Rate: 9.75%" });
  await drain(service, events);

  await service.updateTaskNotes(id, "Rate: 9.57%", CREATOR);
  await service.settleBackgroundWork();

  const dms = events.filter((e) => e.target === "DM");
  assert.equal(dms.length, 1, "exactly one plain DM");
  assert.deepEqual(dms[0].recipientUserIds, [CHECKER.id], "it goes to the checker holding it");
  assert.match(dms[0].message, /^Dana changed the terms on Amend Sim\b/, "named actor, named file");
  assert.doesNotMatch(dms[0].message, /9\.57/, "the DM is a nudge, not a copy of the terms");
  assert.equal(events.filter((e) => e.target.startsWith("CHANNEL")).length, 0, "nothing posted to the channel");
});

await check("a terms change on an unclaimed LOI DMs nobody, but still syncs cards", async () => {
  const { service, events } = await setup();
  const id = await makeTask(service, { taskType: "LOI", notes: "Rate: 9.75%" });
  await drain(service, events);

  await service.updateTaskNotes(id, "Rate: 9.57%", CREATOR);
  await service.settleBackgroundWork();

  assert.equal(events.filter((e) => e.target === "DM").length, 0, "there is nobody holding it to tell");
  assert.equal(events.filter((e) => e.target.startsWith("CHANNEL")).length, 0, "nothing posted to the channel");
  assert.equal(events.filter((e) => e.target === "DM_CARD_SYNC").length, 1, "cards are still re-rendered");
});

/* The holder may now correct the terms themselves (#263), so "always tell the
   assignee" would DM a checker about their own typo fix. The DM is for the
   party who did not make the change, and on an LOI that is only ever the
   assignee — a checker correcting the terms does not tell the creator, because
   ADR-0008 rule 9 names the assignee and nobody else. */
await check("the holder correcting the terms themselves is told nothing, and neither is the creator", async () => {
  const { service, events } = await setup();
  const id = await makeTask(service, { taskType: "LOI", claimed: true, holder: CHECKER, notes: "Rate: 9.75%" });
  await drain(service, events);

  await service.updateTaskNotes(id, "Rate: 9.57%", CHECKER);
  await service.settleBackgroundWork();

  assert.equal(events.filter((e) => e.target !== "DM_CARD_SYNC").length, 0, "silent apart from the sync");
  assert.equal(events.filter((e) => e.target === "DM_CARD_SYNC").length, 1, "cards are re-rendered");
});

await check("the other five types' request field stays silent even when claimed", async () => {
  for (const taskType of ["BUDDY_CHAT", "VALUE", "FRAUD", "LOAN_DOCS", "OOO"]) {
    const { service, events } = await setup();
    const id = await makeTask(service, { taskType, claimed: true, holder: CHECKER, notes: "the original ask" });
    await drain(service, events);

    await service.updateTaskNotes(id, "the reworded ask", CREATOR);
    await service.settleBackgroundWork();

    assert.equal(
      events.filter((e) => e.target !== "DM_CARD_SYNC").length,
      0,
      `${taskType}: a wording fix is still silent`
    );
  }
});

await check("a no-op terms save on a claimed LOI notifies nobody", async () => {
  const { service, events } = await setup();
  const id = await makeTask(service, { taskType: "LOI", claimed: true, holder: CHECKER, notes: "Rate: 9.75%" });
  await drain(service, events);

  await service.updateTaskNotes(id, "  Rate: 9.75%  ", CREATOR);
  await service.settleBackgroundWork();

  assert.equal(events.length, 0, "no notification of any kind, not even a card sync");
});

await check("the card sync carries the new terms, so no card is left quoting the old ones", async () => {
  const { service, events } = await setup();
  const id = await makeTask(service, { taskType: "LOI", claimed: true, holder: CHECKER, notes: "Rate: 9.75%" });
  await drain(service, events);

  await service.updateTaskNotes(id, "Rate: 9.57%", CREATOR);
  await service.settleBackgroundWork();

  const syncs = events.filter((e) => e.target === "DM_CARD_SYNC");
  assert.equal(syncs.length, 1, "the existing cards are re-rendered in place");
  assert.equal(syncs[0].task.notes, "Rate: 9.57%", "and they are rebuilt from the corrected terms");
});

/* Poop points are the creator's on every type, ADR-0008 rule 4 — the number
   says what the *creator* thinks the ask is worth. Unchanged by this ticket,
   asserted here so widening the terms rule can't quietly widen this one. */
await check("poop points stay the creator's, holder or not", async () => {
  const { service } = await setup();
  const id = await makeTask(service, { taskType: "LOI", claimed: true, holder: CHECKER });
  for (const actor of [CHECKER, OUTSIDER, ADMIN]) {
    await rejects(
      () => service.updateTaskPoints(id, 4, actor),
      /creator/i,
      `points refused for ${actor.displayName}`
    );
  }
  assert.equal((await service.updateTaskPoints(id, 4, CREATOR)).points, 4);
});

console.log(`\n${passed} checks passed.`);
