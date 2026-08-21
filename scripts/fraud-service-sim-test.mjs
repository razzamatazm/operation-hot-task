#!/usr/bin/env node
/*
 * Issue #39 — FRAUD two-phase completion at the TaskService (server) level.
 *
 * The pure workflow gates live in fraud-two-phase-sim-test.mjs; this sim drives
 * the real TaskService against a real (temp-file) TaskStore with a mock notifier
 * so we can assert the SERVER behavior the shared core can't express:
 *   - CLAIMED → AWAITING_ITEMS is REJECTED without an outstanding-items note,
 *     and ACCEPTED with one (the note is recorded on the task).
 *   - Exactly one creator DM on AWAITING_ITEMS entry; nothing hits the channel.
 *   - PENDING_APPROVAL entry recomputes a fresh end-of-business-day dueAt and
 *     sends exactly one DM to the checker; nothing hits the channel.
 *   - Notes flow in both new states and are blocked once COMPLETED.
 *   - Release unassigns in place (status stays PENDING_APPROVAL); a different
 *     FILE_CHECKER can then claim (status preserved) and approve to COMPLETED.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TaskStore } from "../apps/server/dist/store.js";
import { SseHub } from "../apps/server/dist/sse.js";
import { TaskService } from "../apps/server/dist/task-service.js";
import { computeDueAtFromUrgency } from "../packages/shared/dist/workflow.js";

const config = {
  businessTimezone: "America/Los_Angeles",
  businessStartHour: 8,
  businessStartMinute: 30,
  businessEndHour: 17,
  businessEndMinute: 30,
  archiveRetentionDays: 90
};

const CHECKER = { id: "checker-1", displayName: "Casey Checker", roles: ["FILE_CHECKER"] };
const CHECKER_2 = { id: "checker-2", displayName: "Robin Checker", roles: ["FILE_CHECKER"] };
const CREATOR = { id: "creator-1", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] };
const ADMIN = { id: "admin-1", displayName: "Alex Admin", roles: ["FILE_CHECKER", "ADMIN"] };

const setup = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fraud-svc-sim-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.init();
  const events = [];
  const notifier = { notify: async (event) => { events.push(event); } };
  const service = new TaskService(store, notifier, new SseHub(), config);
  return { service, events };
};

// Return the events emitted while `fn` runs (by slicing the shared buffer).
// Notification fan-out is dispatched off the request path (#119), so wait for
// the service's outstanding background work to settle before reading the buffer
// — never a sleep, this awaits the real completion.
const capture = async ({ service, events }, fn) => {
  // Drain anything still in flight from earlier setup calls first, so the slice
  // below only contains what `fn` itself caused.
  await service.settleBackgroundWork();
  const start = events.length;
  const result = await fn();
  await service.settleBackgroundWork();
  return { result, emitted: events.slice(start) };
};

const dmsTo = (emitted, userId) =>
  emitted.filter((e) => e.target === "DM" && (e.recipientUserIds ?? []).includes(userId));

const channelEvents = (emitted) => emitted.filter((e) => e.target.startsWith("CHANNEL"));

const zonedHourMinute = (iso, timezone) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  })
    .formatToParts(new Date(iso))
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return { hour: Number.parseInt(parts.hour, 10), minute: Number.parseInt(parts.minute, 10) };
};

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

const createClaimedFraud = async (service) => {
  const task = await service.createTask(
    { folderName: "Fraud Svc Sim", taskType: "FRAUD", notes: "check it" },
    CREATOR
  );
  await service.claimTask(task.id, CHECKER);
  return task.id;
};

console.log("FRAUD two-phase lifecycle — TaskService sim");

await check("CLAIMED → AWAITING_ITEMS is rejected without a note", async () => {
  const { service } = await setup();
  const id = await createClaimedFraud(service);
  await assert.rejects(
    () => service.transitionStatus(id, "AWAITING_ITEMS", CHECKER),
    /requires a note/i
  );
  const after = await service.getTask(id);
  assert.equal(after.status, "CLAIMED", "task stays CLAIMED when the hand-back is rejected");
});

await check("hand-back with a note succeeds, records it, and DMs only the creator", async () => {
  const ctx = await setup();
  const { service } = ctx;
  const id = await createClaimedFraud(service);
  const { result, emitted } = await capture(ctx, () =>
    service.transitionStatus(id, "AWAITING_ITEMS", CHECKER, "Need 2023 tax returns")
  );
  assert.equal(result.status, "AWAITING_ITEMS");
  assert.ok(
    (result.reviewNotes ?? []).some((n) => n.text === "Need 2023 tax returns" && n.by.id === CHECKER.id),
    "outstanding-items note recorded on the task"
  );
  // Exactly one creator DM, carrying the "in your court" copy.
  const creatorDms = dmsTo(emitted, CREATOR.id);
  assert.equal(creatorDms.length, 1, "exactly one DM to the creator on AWAITING_ITEMS entry");
  assert.match(creatorDms[0].message, /outstanding items/i);
  assert.equal(dmsTo(emitted, CHECKER.id).length, 0, "no lifecycle DM to the checker on hand-back");
  // Private: nothing on the channel.
  assert.equal(channelEvents(emitted).length, 0, "no channel post on AWAITING_ITEMS entry");
  // The note seeds a DM note card for both participants.
  const noteCard = emitted.find((e) => e.target === "DM_NOTE");
  assert.ok(noteCard, "note card emitted to seed the thread");
  assert.deepEqual(new Set(noteCard.recipientUserIds), new Set([CREATOR.id, CHECKER.id]));
});

await check("PENDING_APPROVAL entry recomputes a fresh EOD dueAt and DMs the checker once", async () => {
  const ctx = await setup();
  const { service } = ctx;
  const id = await createClaimedFraud(service);
  const beforeAwaiting = await service.getTask(id);
  const originalDueAt = beforeAwaiting.dueAt;
  await service.transitionStatus(id, "AWAITING_ITEMS", CHECKER, "Need proof of funds");

  const { result, emitted } = await capture(ctx, () =>
    service.transitionStatus(id, "PENDING_APPROVAL", CREATOR)
  );
  assert.equal(result.status, "PENDING_APPROVAL");
  // dueAt is discarded and recomputed to end-of-business-day (the YELLOW path).
  assert.notEqual(result.dueAt, originalDueAt, "original dueAt is discarded");
  const eod = zonedHourMinute(result.dueAt, config.businessTimezone);
  assert.equal(eod.hour, config.businessEndHour, "fresh dueAt lands at the business end hour");
  assert.equal(eod.minute, config.businessEndMinute, "fresh dueAt lands at the business end minute");
  // Sanity: matches the shared YELLOW computation taken right now.
  assert.equal(result.dueAt, computeDueAtFromUrgency("YELLOW", new Date(), config));
  assert.equal(result.urgency, "YELLOW", "urgency reset to the gentle YELLOW clock");
  // Exactly one DM, to the checker (assignee).
  const checkerDms = dmsTo(emitted, CHECKER.id);
  assert.equal(checkerDms.length, 1, "exactly one DM to the checker on PENDING_APPROVAL entry");
  assert.match(checkerDms[0].message, /back/i);
  assert.equal(dmsTo(emitted, CREATOR.id).length, 0, "no lifecycle DM to the creator on submit");
  assert.equal(channelEvents(emitted).length, 0, "no channel post on PENDING_APPROVAL entry");
});

await check("notes flow in AWAITING_ITEMS and PENDING_APPROVAL, blocked once COMPLETED", async () => {
  const { service } = await setup();
  const id = await createClaimedFraud(service);
  await service.transitionStatus(id, "AWAITING_ITEMS", CHECKER, "Need ID");
  const inAwaiting = await service.addReviewNote(id, "Here's my ID", CREATOR);
  assert.ok((inAwaiting.reviewNotes ?? []).some((n) => n.text === "Here's my ID"), "note added in AWAITING_ITEMS");

  await service.transitionStatus(id, "PENDING_APPROVAL", CREATOR);
  const inPending = await service.addReviewNote(id, "One more thing", CHECKER);
  assert.ok((inPending.reviewNotes ?? []).some((n) => n.text === "One more thing"), "note added in PENDING_APPROVAL");

  await service.transitionStatus(id, "COMPLETED", CHECKER);
  await assert.rejects(
    () => service.addReviewNote(id, "too late", CREATOR),
    /closed/i,
    "notes blocked once COMPLETED"
  );
});

await check("release unassigns in place; a different checker claims (status kept) and approves", async () => {
  const { service } = await setup();
  const id = await createClaimedFraud(service);
  await service.transitionStatus(id, "AWAITING_ITEMS", CHECKER, "Need statements");
  await service.transitionStatus(id, "PENDING_APPROVAL", CREATOR);

  // Assignee alone cannot self-release.
  await assert.rejects(() => service.releaseForAnyChecker(id, CHECKER), /only the task creator/i);

  const released = await service.releaseForAnyChecker(id, CREATOR);
  assert.equal(released.status, "PENDING_APPROVAL", "status stays PENDING_APPROVAL after release");
  assert.equal(released.assignee, undefined, "assignee cleared on release");

  // A different FILE_CHECKER claims — status must NOT snap back to CLAIMED.
  const reclaimed = await service.claimTask(id, CHECKER_2);
  assert.equal(reclaimed.status, "PENDING_APPROVAL", "claiming a released task keeps PENDING_APPROVAL");
  assert.equal(reclaimed.assignee.id, CHECKER_2.id, "claimer becomes the new assignee");

  const approved = await service.transitionStatus(id, "COMPLETED", CHECKER_2);
  assert.equal(approved.status, "COMPLETED", "new checker approves straight to COMPLETED");

  // ADR-0003: releasing somebody else's fraud check is not a back-end power.
  // This used to assert the admin path succeeded.
  const id2 = await createClaimedFraud(service);
  await service.transitionStatus(id2, "AWAITING_ITEMS", CHECKER, "Need W-2");
  await service.transitionStatus(id2, "PENDING_APPROVAL", CREATOR);
  await assert.rejects(() => service.releaseForAnyChecker(id2, ADMIN), /only the task creator/i);
  const stillHeld = await service.getTask(id2);
  assert.equal(stillHeld.assignee.id, CHECKER.id, "the checker still holds it");
});

/* A demoted or deactivated checker can no longer hold the checker seat — the
   role IS the check (ADR-0003). Their live Fraud Checks are released in place
   rather than stranded with somebody who can't act on them. */
await check("a demoted checker's live fraud checks are released in place, at every phase", async () => {
  const { service } = await setup();
  const admin = { id: "admin-1", displayName: "Avery Admin", roles: ["LOAN_OFFICER", "ADMIN"] };

  // One check per live phase, all held by the same checker.
  const claimed = await createClaimedFraud(service);
  const awaiting = await createClaimedFraud(service);
  await service.transitionStatus(awaiting, "AWAITING_ITEMS", CHECKER, "Need statements");
  const pending = await createClaimedFraud(service);
  await service.transitionStatus(pending, "AWAITING_ITEMS", CHECKER, "Need statements");
  await service.transitionStatus(pending, "PENDING_APPROVAL", CREATOR);
  // And one they finished, which is a closed record and stays put.
  const done = await createClaimedFraud(service);
  await service.transitionStatus(done, "AWAITING_ITEMS", CHECKER, "Need statements");
  await service.transitionStatus(done, "PENDING_APPROVAL", CREATOR);
  await service.transitionStatus(done, "COMPLETED", CHECKER);

  const preview = await service.liveFraudChecksForChecker(CHECKER.id);
  assert.deepEqual(
    preview.map((t) => t.id).sort(),
    [claimed, awaiting, pending].sort(),
    "the admin can see exactly what the change will release, before making it"
  );

  const released = await service.releaseFraudChecksForChecker(CHECKER.id, admin);
  assert.equal(released.length, 3, "all three live checks released");

  for (const [id, status] of [[claimed, "CLAIMED"], [awaiting, "AWAITING_ITEMS"], [pending, "PENDING_APPROVAL"]]) {
    const task = await service.getTask(id);
    assert.equal(task.status, status, `${status} is untouched — only the assignee is cleared`);
    assert.equal(task.assignee, undefined, `${status} has no checker now`);
  }
  const closed = await service.getTask(done);
  assert.equal(closed.assignee.id, CHECKER.id, "the completed check keeps its checker — that record is finished");
});

await check("another file checker picks a released check up and carries on from where it was", async () => {
  const { service } = await setup();
  const admin = { id: "admin-1", displayName: "Avery Admin", roles: ["LOAN_OFFICER", "ADMIN"] };
  const id = await createClaimedFraud(service);
  await service.transitionStatus(id, "AWAITING_ITEMS", CHECKER, "Need statements");
  await service.transitionStatus(id, "PENDING_APPROVAL", CREATOR);

  await service.releaseFraudChecksForChecker(CHECKER.id, admin);

  const reclaimed = await service.claimTask(id, CHECKER_2);
  assert.equal(reclaimed.status, "PENDING_APPROVAL", "resumes rather than restarting");
  assert.equal(reclaimed.assignee.id, CHECKER_2.id);
  const approved = await service.transitionStatus(id, "COMPLETED", CHECKER_2);
  assert.equal(approved.status, "COMPLETED", "and the exchange finishes");
});

await check("releasing a checker who holds nothing is a no-op", async () => {
  const { service } = await setup();
  const admin = { id: "admin-1", displayName: "Avery Admin", roles: ["LOAN_OFFICER", "ADMIN"] };
  const released = await service.releaseFraudChecksForChecker(CHECKER_2.id, admin);
  assert.deepEqual(released, [], "nothing to release, nothing released");
});

await check("the release is recorded against the admin who caused it", async () => {
  const { service } = await setup();
  const admin = { id: "admin-1", displayName: "Avery Admin", roles: ["LOAN_OFFICER", "ADMIN"] };
  const id = await createClaimedFraud(service);
  await service.releaseFraudChecksForChecker(CHECKER.id, admin);
  const history = await service.getHistory(id);
  const release = history.find((e) => e.action === "TASK_RELEASED");
  assert.ok(release, "the release is in the task's history");
  assert.equal(release.by.id, admin.id, "named to whoever made the change, not the person who lost the seat");
  assert.match(release.detail, /can no longer check files/i, "and it says why");
});

console.log(`\nAll ${passed} FRAUD TaskService checks passed.`);
