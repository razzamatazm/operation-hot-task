#!/usr/bin/env node
/*
 * The Checked panel: an LOI checker's two exits in one control (#231, from
 * #172; ADR-0007 rule 1 gives the second exit its meaning).
 *
 * A checker holding an LOI can finish two ways — the check was clean, or the
 * check found something. Until now only the first was a button on the row and
 * the second lived somewhere else entirely, so a check that found problems
 * tended to end as a silent Complete with a note nobody was required to write.
 * Both exits now sit behind one `Checked` control, and the second one cannot be
 * taken without saying what needs fixed.
 *
 * The panel itself is React and cannot be imported into a node script. It is
 * covered the way `corrections-permissions-sim-test.mjs` covers the ladder: one
 * level down, at the shared predicate the panel renders from
 * (`canUseCheckedPanel`), asserted over the whole task-type x status x seat
 * matrix against the answer the server gives on the click. That is the
 * agreement ADR-0007 exists to keep, and it is the half a screenshot cannot
 * check.
 *
 * Everything below the predicate — the required note, the one thread entry it
 * writes, the clean exit's silence, and the fact that neither reaches any other
 * task type — runs end to end through the real TaskService against a temp-file
 * TaskStore.
 *
 * Runs against the compiled dist.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SYSTEM_ACTOR, TASK_STATUSES, TASK_TYPES } from "../packages/shared/dist/types.js";
import { canTransitionStatus, canUseCheckedPanel, canUseFixedPanel } from "../packages/shared/dist/workflow.js";
import { ACTION_LABELS, NEEDS_FIXES_NOTE_REQUIRED, needsFixesNote } from "../packages/shared/dist/labels.js";
import { TaskStore } from "../apps/server/dist/store.js";
import { SseHub } from "../apps/server/dist/sse.js";
import { TaskService } from "../apps/server/dist/task-service.js";

const CREATOR = { id: "creator-1", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] };
/* FILE_CHECKER so the same person sits in the checker seat on the FRAUD rows
   too; it buys nothing on any other type. */
const ASSIGNEE = { id: "worker-1", displayName: "Sam Officer", roles: ["LOAN_OFFICER", "FILE_CHECKER"] };
/* Neither party, and an admin — so every row doubles as "ADMIN confers
   nothing" (ADR-0003). */
const OBSERVER = { id: "admin-1", displayName: "Avery Admin", roles: ["LOAN_OFFICER", "FILE_CHECKER", "ADMIN"] };
const PEOPLE = [CREATOR, ASSIGNEE, OBSERVER];
const SYSTEM = SYSTEM_ACTOR;

const makeTask = (overrides = {}) => ({
  id: "task-1",
  folderName: "Smith-1042",
  taskType: "LOI",
  dueAt: new Date("2026-08-14T20:00:00Z").toISOString(),
  urgency: "GREEN",
  points: 2,
  notes: "have a look",
  status: "CLAIMED",
  createdAt: new Date("2026-08-14T00:00:00Z").toISOString(),
  updatedAt: new Date("2026-08-14T00:00:00Z").toISOString(),
  createdBy: { id: CREATOR.id, displayName: CREATOR.displayName },
  assignee: { id: ASSIGNEE.id, displayName: ASSIGNEE.displayName },
  ...overrides
});

const CELLS = [];
for (const taskType of TASK_TYPES) {
  for (const status of TASK_STATUSES) {
    CELLS.push({ taskType, status, unassigned: false });
    CELLS.push({ taskType, status, unassigned: true });
  }
}
const taskFor = (cell) => makeTask({ taskType: cell.taskType, status: cell.status, ...(cell.unassigned ? { assignee: undefined } : {}) });
const cellName = (cell) => `${cell.taskType} @ ${cell.status}${cell.unassigned ? " (unassigned)" : ""}`;

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

const refused = async (fn, expected, message) => {
  await assert.rejects(fn, (err) => {
    assert.match(err.message, expected, message ?? "refused for the stated reason");
    return true;
  });
};

console.log("The Checked panel: an LOI checker's two exits in one control (#231)");

// ---------------------------------------------------------------------------
// 1. The panel and the server agree, over the whole matrix
// ---------------------------------------------------------------------------

await check("every exit the panel draws is a move the server accepts", () => {
  for (const cell of CELLS) {
    const task = taskFor(cell);
    for (const viewer of [...PEOPLE, SYSTEM]) {
      if (!canUseCheckedPanel(task, viewer)) {
        continue;
      }
      for (const [exit, target] of [["Good to go", "COMPLETED"], ["Needs fixes", "NEEDS_REVIEW"]]) {
        const verdict = canTransitionStatus(task, target, viewer);
        assert.ok(
          verdict.ok,
          `${cellName(cell)}: ${viewer.displayName} is offered "${exit}" but the server says "${verdict.reason}"`
        );
      }
    }
  }
});

await check("the panel is drawn on exactly one cell: the checker holding a claimed LOI", () => {
  for (const cell of CELLS) {
    const task = taskFor(cell);
    const applies = cell.taskType === "LOI" && cell.status === "CLAIMED" && !cell.unassigned;
    assert.equal(canUseCheckedPanel(task, ASSIGNEE), applies, `${cellName(cell)}: the assignee`);
    assert.equal(canUseCheckedPanel(task, CREATOR), false, `${cellName(cell)}: never the creator — a creator never enters corrections`);
    assert.equal(canUseCheckedPanel(task, OBSERVER), false, `${cellName(cell)}: never a bystander, admin or not`);
  }
});

await check("both halves are open together or the panel is not drawn at all", () => {
  /* A panel with one dead half is worse than no panel: the checker taps the
     control that promises two exits and finds one of them refuses. So the one
     answer is only ever yes when both moves are. */
  for (const cell of CELLS) {
    for (const viewer of [...PEOPLE, SYSTEM]) {
      const task = taskFor(cell);
      const complete = canTransitionStatus(task, "COMPLETED", viewer).ok;
      const needsFixes = canTransitionStatus(task, "NEEDS_REVIEW", viewer).ok;
      assert.equal(canUseCheckedPanel(task, viewer), complete && needsFixes, `${cellName(cell)}: ${viewer.displayName}`);
    }
  }
});

await check("the creator's Fixed panel is drawn on exactly one cell: the creator, in corrections", () => {
  /* The other side of the loop, added when the user directed it live during
     #231's visual pass. Same shape, same agreement requirement: both exits are
     the server's own answer, so the panel is never drawn with a dead half. */
  for (const cell of CELLS) {
    const task = taskFor(cell);
    const applies = cell.taskType === "LOI" && cell.status === "NEEDS_REVIEW";
    assert.equal(canUseFixedPanel(task, CREATOR), applies, `${cellName(cell)}: the creator`);
    assert.equal(canUseFixedPanel(task, ASSIGNEE), false, `${cellName(cell)}: never the assignee — they wait`);
    assert.equal(canUseFixedPanel(task, OBSERVER), false, `${cellName(cell)}: never a bystander, admin or not`);
  }
});

await check("every exit the Fixed panel draws is a move the server accepts", () => {
  for (const cell of CELLS) {
    const task = taskFor(cell);
    for (const viewer of [...PEOPLE, SYSTEM]) {
      if (!canUseFixedPanel(task, viewer)) {
        continue;
      }
      for (const [exit, target] of [["Complete", "COMPLETED"], ["Send back to checker", "CLAIMED"]]) {
        const verdict = canTransitionStatus(task, target, viewer);
        assert.ok(
          verdict.ok,
          `${cellName(cell)}: ${viewer.displayName} is offered "${exit}" but the server says "${verdict.reason}"`
        );
      }
    }
  }
});

await check("the two panels never appear on the same row", () => {
  /* One is the checker's on a claimed LOI, the other the creator's in
     corrections, and they are different statuses — but they share a slot, so
     the row would have to choose. It never has to. */
  for (const cell of CELLS) {
    const task = taskFor(cell);
    for (const viewer of [...PEOPLE, SYSTEM]) {
      assert.ok(
        !(canUseCheckedPanel(task, viewer) && canUseFixedPanel(task, viewer)),
        `${cellName(cell)}: ${viewer.displayName} is offered both panels`
      );
    }
  }
});

await check("the labels come from the shared module, one string per action", () => {
  assert.equal(ACTION_LABELS.FIXED, "Fixed");
  assert.ok(ACTION_LABELS.FIXED.length <= ACTION_LABELS.APPROVE_MERGE.length, "the creator's trigger fits the slot too");
  assert.equal(ACTION_LABELS.CHECKED, "Checked");
  assert.equal(ACTION_LABELS.GOOD_TO_GO, "Good to go");
  assert.equal(ACTION_LABELS.NEEDS_FIXES, "Needs fixes");
  // The trigger rides the 116px slot; `Approve Merge` sets that ceiling.
  assert.ok(ACTION_LABELS.CHECKED.length <= ACTION_LABELS.APPROVE_MERGE.length, "the trigger fits the slot");
  assert.equal(needsFixesNote("the borrower name"), "Needs fixes: the borrower name");
  // The held-back button and the server's refusal say the same sentence.
  assert.match(NEEDS_FIXES_NOTE_REQUIRED, /requires a note/i);
  assert.ok(needsFixesNote("x").startsWith(ACTION_LABELS.NEEDS_FIXES), "the thread prefix is the label, not a second string");
});

// ---------------------------------------------------------------------------
// 2. End to end through the real service
// ---------------------------------------------------------------------------

const config = {
  businessTimezone: "America/Los_Angeles",
  businessStartHour: 8,
  businessStartMinute: 30,
  businessEndHour: 17,
  businessEndMinute: 30,
  archiveRetentionDays: 90
};

const setup = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "checked-panel-sim-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.init();
  const notifier = { notify: async () => {}, canReachDm: async () => true };
  return { store, service: new TaskService(store, notifier, new SseHub(), config) };
};

const claimedTask = async (service, taskType = "LOI") => {
  const extra = taskType === "OOO" ? { startDate: "2026-09-20", returnDate: "2026-09-30" } : {};
  const task = await service.createTask({ folderName: "Checked Sim", taskType, notes: "n", ...extra }, CREATOR);
  return service.claimTask(task.id, ASSIGNEE);
};

const threadTexts = (task) => (task.reviewNotes ?? []).map((note) => note.text);

await check("Good to go completes the task and writes nothing to the thread", async () => {
  /* The user's ruling on #231, which overrode that ticket's own acceptance
     criterion ("writes `Good to go!` to the notes thread"). The line said
     nothing the completion did not already say and reached the creator twice —
     as the task landing as done, and again as a note. The clean exit records
     the completion and stops. */
  const { service } = await setup();
  const task = await claimedTask(service);
  const done = await service.transitionStatus(task.id, "COMPLETED", ASSIGNEE);
  assert.equal(done.status, "COMPLETED");
  assert.deepEqual(threadTexts(done), [], "the clean exit is silent on the thread");
});

await check("Needs fixes will not proceed until a note is written", async () => {
  const { service } = await setup();
  const task = await claimedTask(service);

  /* Asserted against the shared constant, not a paraphrase: the panel's
     held-back button shows this exact sentence, so the control cannot teach a
     different rule from the one that stops it. */
  await refused(() => service.transitionStatus(task.id, "NEEDS_REVIEW", ASSIGNEE), new RegExp(NEEDS_FIXES_NOTE_REQUIRED), "no note at all");
  await refused(() => service.transitionStatus(task.id, "NEEDS_REVIEW", ASSIGNEE, "   "), /requires a note/i, "and whitespace is not a finding");
  assert.equal((await service.getTask(task.id)).status, "CLAIMED", "the task has not moved");
  assert.deepEqual(threadTexts(await service.getTask(task.id)), [], "and nothing was written");
});

await check("the note is persisted and reads as `Needs fixes: <text>`", async () => {
  const { service } = await setup();
  const task = await claimedTask(service);
  const sent = await service.transitionStatus(task.id, "NEEDS_REVIEW", ASSIGNEE, "  borrower name is misspelt  ");
  assert.equal(sent.status, "NEEDS_REVIEW");
  assert.deepEqual(threadTexts(sent), ["Needs fixes: borrower name is misspelt"], "trimmed, prefixed, and in the thread");
  assert.equal(sent.reviewNotes[0].by.id, ASSIGNEE.id);
});

await check("a second trip round the loop appends rather than erasing the first finding", async () => {
  const { service } = await setup();
  const task = await claimedTask(service);
  await service.transitionStatus(task.id, "NEEDS_REVIEW", ASSIGNEE, "borrower name is misspelt");
  await service.transitionStatus(task.id, "CLAIMED", CREATOR);
  await service.transitionStatus(task.id, "NEEDS_REVIEW", ASSIGNEE, "still misspelt");
  const back = await service.transitionStatus(task.id, "CLAIMED", CREATOR);
  const done = await service.transitionStatus(task.id, "COMPLETED", ASSIGNEE);
  assert.equal(back.status, "CLAIMED");
  assert.deepEqual(threadTexts(done), [
    "Needs fixes: borrower name is misspelt",
    "Needs fixes: still misspelt"
  ], "append-only and in order — and the clean exit that ended it added nothing");
});

await check("the creator's completion out of corrections is a different move and writes nothing", async () => {
  /* Rule 2's common case: the correction was a typo and the creator closes it
     themselves. That is not a check, so the thread does not claim one. */
  const { service } = await setup();
  const task = await claimedTask(service);
  await service.transitionStatus(task.id, "NEEDS_REVIEW", ASSIGNEE, "borrower name is misspelt");
  const done = await service.transitionStatus(task.id, "COMPLETED", CREATOR);
  assert.equal(done.status, "COMPLETED");
  assert.deepEqual(threadTexts(done), ["Needs fixes: borrower name is misspelt"], "no `Good to go!` from the creator's close");
});

await check("every other task type completes exactly as it did, with no thread entry", async () => {
  for (const taskType of TASK_TYPES) {
    if (taskType === "LOI") {
      continue;
    }
    const { service } = await setup();
    const task = await claimedTask(service, taskType);
    // LOAN_DOCS and FRAUD travel longer flows; only the types that complete
    // straight from CLAIMED are the comparison this criterion is about.
    if (canTransitionStatus(await service.getTask(task.id), "COMPLETED", ASSIGNEE).ok) {
      const done = await service.transitionStatus(task.id, "COMPLETED", ASSIGNEE);
      assert.equal(done.status, "COMPLETED", `${taskType}: still completes`);
      assert.deepEqual(threadTexts(done), [], `${taskType}: and writes nothing to the thread`);
    }
    await refused(
      () => service.transitionStatus(task.id, "NEEDS_REVIEW", ASSIGNEE, "a finding"),
      /LOI/,
      `${taskType}: has no corrections exit to offer`
    );
  }
});

await check("the system actor keeps its noteless route in", async () => {
  /* The note requirement is about people: nothing the app does on its own
     behalf has a finding to type. Same carve-out every actor clause makes. */
  const { service } = await setup();
  const task = await claimedTask(service);
  const sent = await service.transitionStatus(task.id, "NEEDS_REVIEW", SYSTEM);
  assert.equal(sent.status, "NEEDS_REVIEW");
  assert.deepEqual(threadTexts(sent), [], "and writes no finding it does not have");
});

console.log(`\n${passed} checks passed`);
