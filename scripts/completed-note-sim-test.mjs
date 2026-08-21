#!/usr/bin/env node
/*
 * Issue #45 — add a note to a COMPLETED task (Wave 3).
 *
 * A COMPLETED task can still receive a review note ("Add a note" affordance on
 * the card). This drives the real TaskService against a real (temp-file)
 * TaskStore with a mock notifier and asserts the SERVER behavior:
 *   - addCompletedNote appends a ReviewNote and the task STAYS COMPLETED
 *     (server-atomic — no visible reopen round-trip).
 *   - The base `notes` string is untouched; only reviewNotes[] grows.
 *   - completedAt is preserved and reopenedFrom is never set (Restore stays
 *     correct).
 *   - Exactly one history event is recorded (a single "note added", not a
 *     noisy reopen+complete pair).
 *   - Works for ALL task types (not just FRAUD), for the creator and assignee.
 *   - Rejected for a non-participant, and rejected on a non-COMPLETED task.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TaskStore } from "../apps/server/dist/store.js";
import { SseHub } from "../apps/server/dist/sse.js";
import { TaskService } from "../apps/server/dist/task-service.js";
import { flowFor } from "../packages/shared/dist/workflow.js";

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

const setup = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "completed-note-sim-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.init();
  const events = [];
  const notifier = { notify: async (event) => { events.push(event); } };
  const service = new TaskService(store, notifier, new SseHub(), config);
  return { service, store, events };
};

/* Create a task, claim it, and walk its type-specific flow to COMPLETED —
   ending in COMPLETED with an assignee. LOAN_DOCS travels the longer
   MERGE_DONE → MERGE_APPROVED path, so advance along the shared flow rather
   than assuming CLAIMED → COMPLETED. */
const createCompleted = async (service, taskType = "VALUE") => {
  // Relative to today, not hardcoded: createTask rejects an OOO whose return
  // date resolves to a due time in the past, so fixed dates rot into a failure.
  const isoDay = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
  const oooDates = taskType === "OOO" ? { startDate: isoDay(1), returnDate: isoDay(3) } : {};
  const task = await service.createTask(
    { folderName: "Note Sim", taskType, notes: "base notes here", ...oooDates },
    CREATOR
  );
  await service.claimTask(task.id, ASSIGNEE);
  const flow = flowFor(task).filter((s) => s !== "ARCHIVED");
  for (let i = flow.indexOf("CLAIMED") + 1; i < flow.length; i += 1) {
    await service.transitionStatus(task.id, flow[i], ASSIGNEE);
  }
  return task.id;
};

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

console.log("Add-a-note-to-a-completed-task — TaskService sim");

await check("appends a ReviewNote and the task stays COMPLETED", async () => {
  const { service } = await setup();
  const id = await createCompleted(service);
  const before = await service.getTask(id);
  const completedAtBefore = before.completedAt;

  const updated = await service.addCompletedNote(id, "Post-mortem: clean file", CREATOR);
  assert.equal(updated.status, "COMPLETED", "status stays COMPLETED");
  assert.ok(
    (updated.reviewNotes ?? []).some((n) => n.text === "Post-mortem: clean file" && n.by.id === CREATOR.id),
    "the note is recorded on reviewNotes[]"
  );
  assert.equal(updated.notes, "base notes here", "base notes string is untouched");
  assert.equal(updated.completedAt, completedAtBefore, "completedAt is preserved");
  assert.equal(updated.reopenedFrom, undefined, "reopenedFrom is never set (Restore stays correct)");
});

await check("records exactly one history event (a single note-added, no reopen pair)", async () => {
  const { service, store } = await setup();
  const id = await createCompleted(service);
  const historyBefore = await store.allHistoryForTask(id);
  await service.addCompletedNote(id, "One clean event", ASSIGNEE);
  const historyAfter = await store.allHistoryForTask(id);
  assert.equal(historyAfter.length - historyBefore.length, 1, "exactly one new history event");
  const added = historyAfter[historyAfter.length - 1];
  assert.equal(added.action, "REVIEW_NOTE_ADDED", "the single event is a note-added, not a status change");
});

await check("works for every task type, for both parties — and nobody else", async () => {
  for (const taskType of ["LOI", "BUDDY_CHAT", "VALUE", "LOAN_DOCS", "OOO"]) {
    const { service } = await setup();
    const id = await createCompleted(service, taskType);
    const a = await service.addCompletedNote(id, "from creator", CREATOR);
    const b = await service.addCompletedNote(id, "from assignee", ASSIGNEE);
    assert.equal(a.status, "COMPLETED");
    assert.equal(b.status, "COMPLETED");
    assert.equal((b.reviewNotes ?? []).length, 2, `two notes recorded for ${taskType}`);
    // ADR-0003: the thread is a conversation between the two people on the
    // task, so an admin who is neither is not in it. This used to pass.
    await assert.rejects(() => service.addCompletedNote(id, "from admin", ADMIN), /creator or assignee/i);
  }
});

await check("rejects a non-participant", async () => {
  const { service } = await setup();
  const id = await createCompleted(service);
  await assert.rejects(
    () => service.addCompletedNote(id, "let me in", OUTSIDER),
    /creator or assignee/i
  );
});

await check("rejects when the task is not COMPLETED", async () => {
  const { service } = await setup();
  const task = await service.createTask(
    { folderName: "Still Open", taskType: "VALUE", notes: "x" },
    CREATOR
  );
  await service.claimTask(task.id, ASSIGNEE);
  await assert.rejects(
    () => service.addCompletedNote(task.id, "too early", CREATOR),
    /completed/i,
    "a CLAIMED task rejects the completed-note affordance"
  );
});

console.log(`\nAll ${passed} completed-note TaskService checks passed.`);
