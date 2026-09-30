#!/usr/bin/env node
/*
 * Requester handover (#454) at the TaskService level: a real service on a
 * temp-file store with a recording notifier. The requester, the assignee or an
 * admin makes someone else the task's requester in every way, and the old
 * requester is left a bystander.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TaskStore } from "../apps/server/dist/store.js";
import { SseHub } from "../apps/server/dist/sse.js";
import { TaskService } from "../apps/server/dist/task-service.js";
import {
  ACTION_LABELS,
  canHandOverRequesterTo,
  isTaskParty,
  requesterHandoverOfferRefusal,
  requesterHandoverRefusal
} from "../packages/shared/dist/index.js";

const config = {
  businessTimezone: "America/Los_Angeles",
  businessStartHour: 8,
  businessStartMinute: 30,
  businessEndHour: 17,
  businessEndMinute: 30,
  archiveRetentionDays: 90
};

const CREATOR = { id: "creator-1", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] };
const NEWBIE = { id: "newbie-1", displayName: "Riley Newbie", roles: ["LOAN_OFFICER"] };
const WORKER = { id: "worker-1", displayName: "Sam Officer", roles: ["LOAN_OFFICER"] };
const CHECKER = { id: "checker-1", displayName: "Casey Checker", roles: ["FILE_CHECKER"] };
const ADMIN = { id: "admin-1", displayName: "Avery Admin", roles: ["LOAN_OFFICER", "ADMIN"] };
const BYSTANDER = { id: "bystander-1", displayName: "Pat Bystander", roles: ["LOAN_OFFICER"] };
const SYSTEM = { id: "system", displayName: "Hot Task", roles: ["ADMIN"] };

const setup = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "requester-handover-sim-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.init();
  const events = [];
  const notifier = { notify: async (event) => { events.push(event); }, canReachDm: async () => true };
  const service = new TaskService(store, notifier, new SseHub(), config);
  return { service, store, events };
};

const capture = async ({ service, events }, fn) => {
  await service.settleBackgroundWork();
  const start = events.length;
  const result = await fn();
  await service.settleBackgroundWork();
  return { result, emitted: events.slice(start) };
};

const refused = async (fn, expected) => {
  await assert.rejects(fn, (err) => {
    assert.match(err.message, expected);
    return true;
  });
};

const patch = async (store, taskId, apply) => store.updateTask(taskId, (current) => ({ task: apply(current) }));

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

const newTask = (service, overrides = {}) =>
  service.createTask({ folderName: "Handover Sim", taskType: "VALUE", notes: "n", ...overrides }, CREATOR);

const claimedTask = async (service, overrides = {}) => {
  const task = await newTask(service, overrides);
  return service.claimTask(task.id, overrides.taskType === "FRAUD" ? CHECKER : WORKER);
};

console.log("Requester handover (#454) — TaskService sim");

await check("the action is called Change Task Owner", async () => {
  assert.equal(ACTION_LABELS.HAND_OVER_REQUESTER, "Change Task Owner");
});

await check("the requester, the assignee and an admin may each hand it over", async () => {
  for (const actor of [CREATOR, WORKER, ADMIN]) {
    const ctx = await setup();
    const task = await claimedTask(ctx.service);
    const updated = await ctx.service.handOverRequester({ taskId: task.id, target: NEWBIE, actor });
    assert.equal(updated.createdBy.id, NEWBIE.id, `${actor.displayName} handed it over`);
    assert.equal((await ctx.service.getTask(task.id)).createdBy.id, NEWBIE.id, "persisted");
  }
});

await check("an open, unclaimed task can be handed over too", async () => {
  const ctx = await setup();
  const task = await newTask(ctx.service);
  const updated = await ctx.service.handOverRequester({ taskId: task.id, target: NEWBIE, actor: CREATOR });
  assert.equal(updated.createdBy.id, NEWBIE.id);
  assert.equal(updated.status, "OPEN", "status is untouched");
});

await check("anyone else is refused, and is never offered the move", async () => {
  const ctx = await setup();
  const task = await claimedTask(ctx.service);
  const sentence = requesterHandoverOfferRefusal(task, BYSTANDER);
  assert.ok(sentence, "a bystander is not offered it");
  await refused(() => ctx.service.handOverRequester({ taskId: task.id, target: NEWBIE, actor: BYSTANDER }), new RegExp(sentence));
  assert.equal(requesterHandoverOfferRefusal(task, CREATOR), undefined);
  assert.equal(requesterHandoverOfferRefusal(task, WORKER), undefined);
  assert.equal(requesterHandoverOfferRefusal(task, ADMIN), undefined);
});

await check("the assignee, the current requester and someone who can't raise it are refused with the shared sentence", async () => {
  const ctx = await setup();
  const task = await claimedTask(ctx.service);
  for (const target of [WORKER, CREATOR, SYSTEM]) {
    const sentence = requesterHandoverRefusal(task, target, ADMIN);
    assert.ok(sentence, `${target.displayName} is refused`);
    await assert.rejects(
      () => ctx.service.handOverRequester({ taskId: task.id, target, actor: ADMIN }),
      (err) => err.message === sentence
    );
  }
  assert.match(requesterHandoverRefusal(task, WORKER, ADMIN), /Sam Officer is working this task/);
  assert.match(requesterHandoverRefusal(task, CREATOR, ADMIN), /Dana Requester already owns this task/);
  assert.equal((await ctx.service.getTask(task.id)).createdBy.id, CREATOR.id, "nothing moved");
});

await check("OOO and closed tasks refuse a handover", async () => {
  const ctx = await setup();
  const ooo = await ctx.service.createTask(
    { folderName: "Out", taskType: "OOO", notes: "n", startDate: "2099-06-01", returnDate: "2099-06-08" },
    CREATOR
  );
  assert.ok(requesterHandoverOfferRefusal(ooo, CREATOR), "OOO is not offered");
  await refused(() => ctx.service.handOverRequester({ taskId: ooo.id, target: NEWBIE, actor: CREATOR }), /Coverage Notes/);

  const task = await claimedTask(ctx.service);
  await ctx.service.transitionStatus(task.id, "CANCELLED", CREATOR);
  const cancelled = await ctx.service.getTask(task.id);
  assert.ok(requesterHandoverOfferRefusal(cancelled, CREATOR), "closed is not offered");
  await refused(() => ctx.service.handOverRequester({ taskId: task.id, target: NEWBIE, actor: CREATOR }), /closed/);
});

await check("after a handover the new requester makes every requester move and the old one none", async () => {
  const ctx = await setup();
  const task = await claimedTask(ctx.service);
  await ctx.service.handOverRequester({ taskId: task.id, target: NEWBIE, actor: WORKER });

  await refused(() => ctx.service.updateTaskNotes(task.id, "old", CREATOR), /creator/i);
  await refused(() => ctx.service.updateTaskUrgency(task.id, "RED", CREATOR), /creator/i);
  await ctx.service.updateTaskNotes(task.id, "new instructions", NEWBIE);
  await ctx.service.updateTaskUrgency(task.id, "RED", NEWBIE);
  const amended = await ctx.service.getTask(task.id);
  assert.equal(amended.notes, "new instructions");
  assert.equal(amended.urgency, "RED");

  await refused(() => ctx.service.addReviewNote(task.id, "hi", CREATOR), /creator or assignee/);
  await refused(() => ctx.service.transitionStatus(task.id, "CANCELLED", CREATOR), /./);
  const cancelled = await ctx.service.transitionStatus(task.id, "CANCELLED", NEWBIE);
  assert.equal(cancelled.status, "CANCELLED");
});

await check("merge approval and a fraud check's approval follow the requester", async () => {
  const ctx = await setup();
  const docs = await claimedTask(ctx.service, { taskType: "LOAN_DOCS" });
  await ctx.service.transitionStatus(docs.id, "MERGE_DONE", WORKER);
  await ctx.service.handOverRequester({ taskId: docs.id, target: NEWBIE, actor: CREATOR });
  await refused(() => ctx.service.transitionStatus(docs.id, "MERGE_APPROVED", CREATOR), /./);
  assert.equal((await ctx.service.transitionStatus(docs.id, "MERGE_APPROVED", NEWBIE)).status, "MERGE_APPROVED");

  const fraud = await claimedTask(ctx.service, { taskType: "FRAUD" });
  await ctx.service.transitionStatus(fraud.id, "AWAITING_ITEMS", CHECKER, "Need W-2");
  await ctx.service.handOverRequester({ taskId: fraud.id, target: NEWBIE, actor: CHECKER });
  await refused(() => ctx.service.transitionStatus(fraud.id, "PENDING_APPROVAL", CREATOR), /./);
  assert.equal((await ctx.service.transitionStatus(fraud.id, "PENDING_APPROVAL", NEWBIE)).status, "PENDING_APPROVAL");
});

await check("the task follows the new requester onto their board and off the old one's", async () => {
  const ctx = await setup();
  const task = await claimedTask(ctx.service);
  const updated = await ctx.service.handOverRequester({ taskId: task.id, target: NEWBIE, actor: CREATOR });
  assert.ok(isTaskParty(updated, NEWBIE), "the new requester is a party");
  assert.ok(!isTaskParty(updated, CREATOR), "the old requester is a bystander");
  const completed = await ctx.service.transitionStatus(task.id, "COMPLETED", WORKER);
  assert.equal(completed.createdBy.id, NEWBIE.id, "it finishes as the new requester's");
});

await check("the unclaimed nudge names the new requester", async () => {
  const ctx = await setup();
  const task = await newTask(ctx.service);
  await ctx.service.handOverRequester({ taskId: task.id, target: NEWBIE, actor: CREATOR });
  const at = new Date("2026-03-11T10:00:00-07:00");
  await patch(ctx.store, task.id, (current) => {
    const { lastPoolNagAt: _stamp, poolNagCount: _count, ...rest } = current;
    return {
      ...rest,
      createdAt: new Date(at.getTime() - 90 * 60_000).toISOString(),
      updatedAt: new Date(at.getTime() - 90 * 60_000).toISOString(),
      dueAt: new Date(at.getTime() + 24 * 3_600_000).toISOString()
    };
  });
  const { emitted } = await capture(ctx, () => ctx.service.runMaintenance(at));
  const nags = emitted.filter((e) => e.target === "CHANNEL_NAG");
  assert.equal(nags.length, 1, "nagged once");
  assert.match(nags[0].message, /Riley/);
  assert.doesNotMatch(nags[0].message, /Dana/);
});

await check("a merge-approval reminder goes to the new requester", async () => {
  const ctx = await setup();
  const docs = await claimedTask(ctx.service, { taskType: "LOAN_DOCS" });
  await ctx.service.transitionStatus(docs.id, "MERGE_DONE", WORKER);
  await ctx.service.handOverRequester({ taskId: docs.id, target: NEWBIE, actor: WORKER });
  const at = new Date("2026-03-11T10:00:00-07:00");
  await patch(ctx.store, docs.id, (current) => {
    const { lastReminderAt: _r, ...rest } = current;
    return { ...rest, dueAt: new Date(at.getTime() - 3_600_000).toISOString() };
  });
  const { emitted } = await capture(ctx, () => ctx.service.runMaintenance(at));
  const reminders = emitted.filter((e) => e.type === "TASK_REMINDER" && e.target === "DM");
  assert.equal(reminders.length, 1, "reminded once");
  assert.deepEqual(reminders[0].recipientUserIds, [NEWBIE.id]);
});

await check("history records who handed it over, from whom, to whom and when", async () => {
  const ctx = await setup();
  const task = await claimedTask(ctx.service);
  await ctx.service.handOverRequester({ taskId: task.id, target: NEWBIE, actor: WORKER });
  const history = await ctx.service.getHistory(task.id);
  const row = history.find((e) => e.action === "REQUESTER_HANDED_OVER");
  assert.ok(row, "a handover row exists");
  assert.equal(row.by.id, WORKER.id);
  assert.equal(row.detail, "Task owner changed from Dana Requester to Riley Newbie by Sam Officer");
  assert.ok(!Number.isNaN(Date.parse(row.at)));
  assert.ok(history.some((e) => e.action === "TASK_CREATED" && e.by.id === CREATOR.id), "who raised it stays on record");
});

await check("the new requester is told it's theirs and the old one who took over and who did it", async () => {
  const ctx = await setup();
  const task = await claimedTask(ctx.service);
  const { emitted } = await capture(ctx, () =>
    ctx.service.handOverRequester({ taskId: task.id, target: NEWBIE, actor: ADMIN })
  );
  const toNew = emitted.filter((e) => e.target === "DM_REQUESTER");
  assert.equal(toNew.length, 1);
  assert.deepEqual(toNew[0].recipientUserIds, [NEWBIE.id]);
  assert.equal(toNew[0].message, "Avery Admin made you the owner of Handover Sim");
  const toOld = emitted.filter((e) => e.target === "DM" && e.recipientUserIds?.includes(CREATOR.id));
  assert.equal(toOld.length, 1, "the old requester gets one note");
  assert.equal(toOld[0].message, "Avery made Riley Newbie the owner of your task Handover Sim");
  const sync = emitted.filter((e) => e.target === "DM_CARD_SYNC");
  assert.ok(sync.some((e) => e.recipientUserIds?.includes(CREATOR.id)), "the old requester's cards re-render");
  assert.ok(!emitted.some((e) => e.target.startsWith("CHANNEL") || e.target === "ACTIVITY_FEED"), "no channel post");
});

await check("the old requester who hands it over themselves gets no note about their own move", async () => {
  const ctx = await setup();
  const task = await claimedTask(ctx.service);
  const { emitted } = await capture(ctx, () =>
    ctx.service.handOverRequester({ taskId: task.id, target: NEWBIE, actor: CREATOR })
  );
  assert.ok(!emitted.some((e) => e.target === "DM" && e.recipientUserIds?.includes(CREATOR.id)));
});

await check("it can be handed over twice, including back to the original requester", async () => {
  const ctx = await setup();
  const task = await claimedTask(ctx.service);
  await ctx.service.handOverRequester({ taskId: task.id, target: NEWBIE, actor: CREATOR });
  assert.ok(!canHandOverRequesterTo(await ctx.service.getTask(task.id), BYSTANDER, CREATOR), "the old requester can't do it again");
  const back = await ctx.service.handOverRequester({ taskId: task.id, target: CREATOR, actor: NEWBIE });
  assert.equal(back.createdBy.id, CREATOR.id);
  const again = await ctx.service.handOverRequester({ taskId: task.id, target: BYSTANDER, actor: WORKER });
  assert.equal(again.createdBy.id, BYSTANDER.id);
  const rows = (await ctx.service.getHistory(task.id)).filter((e) => e.action === "REQUESTER_HANDED_OVER");
  assert.equal(rows.length, 3);
  assert.equal(again.raisedBy.id, CREATOR.id, "who first raised it is kept for display");
});

await check("an admin who takes the role themselves gets no 'made you the owner' card", async () => {
  const ctx = await setup();
  const task = await claimedTask(ctx.service);
  const { result, emitted } = await capture(ctx, () =>
    ctx.service.handOverRequester({ taskId: task.id, target: ADMIN, actor: ADMIN })
  );
  assert.equal(result.createdBy.id, ADMIN.id);
  assert.ok(!emitted.some((e) => e.target === "DM_REQUESTER"));
});

console.log(`\n${passed} passed`);
