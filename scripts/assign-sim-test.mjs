#!/usr/bin/env node
/*
 * Handoff (ADR-0002) — assigning a task to another user, at the TaskService
 * level. Drives the real TaskService against a real (temp-file) TaskStore with
 * a mock notifier, in the style of the FRAUD service sim and the background
 * fan-out sim, and asserts the contract the ADR pins down:
 *
 *   - OPEN → CLAIMED on handoff; an in-flight task (CLAIMED, NEEDS_REVIEW,
 *     FRAUD's AWAITING_ITEMS / PENDING_APPROVAL) swaps assignee IN PLACE with
 *     its status untouched.
 *   - Closed tasks (COMPLETED / CANCELLED / ARCHIVED) are refused.
 *   - Eligibility is enforced on the RECIPIENT: a FRAUD task only goes to a
 *     FILE_CHECKER, whoever is doing the handing.
 *   - Anyone may hand off — an observer who is neither creator nor assignee.
 *   - Handing a task to whoever already holds it is a no-op, not an error.
 *   - DMs only: a DM_ASSIGN card to the recipient, a one-line DM to a displaced
 *     assignee, and nothing on the channel or the activity feed.
 *   - The handoff note rides the DM_ASSIGN card and is NEVER written as a
 *     review note (which would double-notify through DM_NOTE).
 *   - History records TASK_ASSIGNED with a free-text detail string.
 *   - Fan-out is backgrounded: the call resolves before the notifier does.
 *   - A task created with an assignee is born CLAIMED in ONE operation, and its
 *     channel post still goes out (as the claimed-card variant, which the
 *     notifications provider picks off task.assignee).
 *   - Second pair of hands (ADR-0003): the creator is refused at all four doors
 *     an assignee comes through — claim, self-handoff, a third party handing it
 *     back, and assignment at creation — while a NON-creator's self-handoff
 *     survives.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TaskStore } from "../apps/server/dist/store.js";
import { SseHub } from "../apps/server/dist/sse.js";
import { TaskService } from "../apps/server/dist/task-service.js";
import { ActivityFeedStateStore } from "../apps/server/dist/activity-feed-state.js";
import { canAssignTaskTo } from "../packages/shared/dist/workflow.js";

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
const CHECKER_2 = { id: "checker-2", displayName: "Robin Checker", roles: ["FILE_CHECKER"] };
const OFFICER = { id: "officer-1", displayName: "Sam Officer", roles: ["LOAN_OFFICER"] };
const BYSTANDER = { id: "bystander-1", displayName: "Pat Bystander", roles: ["LOAN_OFFICER"] };

/* `withActivityFeed` wires a real ActivityFeedStateStore. Without one,
   `evaluateActivitySignals` returns at its first line, so any assertion about
   activity-feed alerts passes vacuously — which is exactly how a handoff could
   emit one unnoticed. Tests that assert on ACTIVITY_FEED must opt in. */
const setup = async (notifyImpl, { withActivityFeed = false } = {}) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assign-sim-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.init();
  const events = [];
  const notifier = {
    notify: async (event) => {
      events.push(event);
      if (notifyImpl) await notifyImpl(event);
    },
    canReachDm: async () => true
  };
  let feedState;
  if (withActivityFeed) {
    feedState = new ActivityFeedStateStore(path.join(dir, "activity-feed.json"));
    await feedState.init();
  }
  const service = new TaskService(store, notifier, new SseHub(), config, feedState);
  return { service, events };
};

/* Events emitted while `fn` runs. Fan-out is off the request path (#119), so
   settle the outstanding background work rather than sleeping. */
const capture = async ({ service, events }, fn) => {
  await service.settleBackgroundWork();
  const start = events.length;
  const result = await fn();
  await service.settleBackgroundWork();
  return { result, emitted: events.slice(start) };
};

const targeted = (emitted, target) => emitted.filter((e) => e.target === target);

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

const openTask = async (service, overrides = {}) =>
  service.createTask(
    { folderName: "Assign Sim", taskType: "VALUE", notes: "n", ...overrides },
    CREATOR
  );

console.log("Handoff (ADR-0002) — TaskService sim");

await check("an OPEN task handed off becomes CLAIMED for the recipient", async () => {
  const ctx = await setup();
  const task = await openTask(ctx.service);
  const updated = await ctx.service.assignTask({ taskId: task.id, target: OFFICER, actor: CREATOR });

  assert.equal(updated.status, "CLAIMED", "OPEN → CLAIMED, the same end state as a self-claim");
  assert.equal(updated.assignee.id, OFFICER.id, "the recipient is the assignee");
  const stored = await ctx.service.getTask(task.id);
  assert.equal(stored.assignee.id, OFFICER.id, "and it is persisted, not just returned");
});

await check("an in-flight task swaps assignee with its status untouched", async () => {
  const ctx = await setup();
  const task = await openTask(ctx.service);
  await ctx.service.claimTask(task.id, OFFICER);
  const swapped = await ctx.service.assignTask({ taskId: task.id, target: BYSTANDER, actor: CREATOR });
  assert.equal(swapped.status, "CLAIMED", "CLAIMED stays CLAIMED");
  assert.equal(swapped.assignee.id, BYSTANDER.id, "assignee swapped in place");

  // NEEDS_REVIEW is the other non-FRAUD in-flight status.
  await ctx.service.transitionStatus(task.id, "NEEDS_REVIEW", BYSTANDER);
  const inReview = await ctx.service.assignTask({ taskId: task.id, target: OFFICER, actor: CREATOR });
  assert.equal(inReview.status, "NEEDS_REVIEW", "NEEDS_REVIEW is preserved across a handoff");
  assert.equal(inReview.assignee.id, OFFICER.id);
});

await check("FRAUD's two-phase statuses swap in place too", async () => {
  const ctx = await setup();
  const task = await openTask(ctx.service, { folderName: "Fraud Handoff", taskType: "FRAUD" });
  await ctx.service.claimTask(task.id, CHECKER);
  await ctx.service.transitionStatus(task.id, "AWAITING_ITEMS", CHECKER, "Need W-2");
  const awaiting = await ctx.service.assignTask({ taskId: task.id, target: CHECKER_2, actor: CREATOR });
  assert.equal(awaiting.status, "AWAITING_ITEMS", "AWAITING_ITEMS preserved");
  assert.equal(awaiting.assignee.id, CHECKER_2.id);

  await ctx.service.transitionStatus(task.id, "PENDING_APPROVAL", CREATOR);
  const pending = await ctx.service.assignTask({ taskId: task.id, target: CHECKER, actor: CREATOR });
  assert.equal(pending.status, "PENDING_APPROVAL", "PENDING_APPROVAL preserved");
  assert.equal(pending.assignee.id, CHECKER.id, "the wrong-checker fix, which is the whole point");
});

await check("closed tasks are refused", async () => {
  const ctx = await setup();
  for (const closed of ["COMPLETED", "CANCELLED", "ARCHIVED"]) {
    const task = await openTask(ctx.service);
    await ctx.service.claimTask(task.id, OFFICER);
    if (closed === "CANCELLED") {
      await ctx.service.transitionStatus(task.id, "CANCELLED", CREATOR);
    } else {
      await ctx.service.transitionStatus(task.id, "COMPLETED", OFFICER);
      if (closed === "ARCHIVED") await ctx.service.transitionStatus(task.id, "ARCHIVED", CREATOR);
    }
    await assert.rejects(
      () => ctx.service.assignTask({ taskId: task.id, target: BYSTANDER, actor: CREATOR }),
      /closed/i,
      `${closed} can't be handed off`
    );
    const after = await ctx.service.getTask(task.id);
    assert.equal(after.assignee?.id, OFFICER.id, `${closed} keeps its original assignee`);

    /* Closed beats the no-op shortcut. Naming the person who already holds it
       must not slip past the closed check — otherwise whether the API rejects
       you depends on who you happened to name. */
    await assert.rejects(
      () => ctx.service.assignTask({ taskId: task.id, target: OFFICER, actor: CREATOR }),
      /closed/i,
      `${closed} is refused even when the target already holds it`
    );
  }
});

await check("a FRAUD task can only be handed to a FILE_CHECKER", async () => {
  const ctx = await setup();
  const task = await openTask(ctx.service, { folderName: "Fraud Eligibility", taskType: "FRAUD" });

  // Eligibility is on the RECIPIENT, not the actor: a file checker handing it
  // to a loan officer is still refused.
  await assert.rejects(
    () => ctx.service.assignTask({ taskId: task.id, target: OFFICER, actor: CHECKER }),
    /file checker/i,
    "a loan officer can't be handed a fraud check"
  );
  const untouched = await ctx.service.getTask(task.id);
  assert.equal(untouched.status, "OPEN", "the refused handoff changed nothing");
  assert.equal(untouched.assignee, undefined);

  // ...and a plain loan officer handing it to a checker is fine.
  const ok = await ctx.service.assignTask({ taskId: task.id, target: CHECKER, actor: OFFICER });
  assert.equal(ok.assignee.id, CHECKER.id, "any actor may hand off; only the recipient is gated");
  assert.equal(ok.status, "CLAIMED");

  // The shared predicate the UI filters with agrees with the server.
  assert.equal(canAssignTaskTo(untouched, OFFICER), false);
  assert.equal(canAssignTaskTo(untouched, CHECKER), true);
});

await check("an uninvolved bystander may hand a task off", async () => {
  const ctx = await setup();
  const task = await openTask(ctx.service);
  await ctx.service.claimTask(task.id, OFFICER);
  const updated = await ctx.service.assignTask({ taskId: task.id, target: CHECKER, actor: BYSTANDER });
  assert.equal(updated.assignee.id, CHECKER.id, "no creator/assignee/admin gate — ADR-0002");
});

await check("handing a task to its current assignee is a no-op", async () => {
  const ctx = await setup();
  const task = await openTask(ctx.service);
  await ctx.service.claimTask(task.id, OFFICER);
  const before = await ctx.service.getTask(task.id);

  const { result, emitted } = await capture(ctx, () =>
    ctx.service.assignTask({ taskId: task.id, target: OFFICER, actor: CREATOR })
  );
  assert.equal(result.updatedAt, before.updatedAt, "the task comes back untouched, not re-stamped");
  assert.deepEqual(emitted, [], "and nobody is notified about a handoff that didn't happen");

  const history = await ctx.service.getHistory(task.id);
  assert.equal(history.filter((h) => h.action === "TASK_ASSIGNED").length, 0, "no history row either");
});

await check("the recipient gets a DM_ASSIGN card and nothing hits the channel", async () => {
  const ctx = await setup();
  const task = await openTask(ctx.service);

  const { emitted } = await capture(ctx, () =>
    ctx.service.assignTask({ taskId: task.id, target: OFFICER, actor: CREATOR, note: "you know this file" })
  );

  const assigns = targeted(emitted, "DM_ASSIGN");
  assert.equal(assigns.length, 1, "exactly one handoff card");
  assert.deepEqual(assigns[0].recipientUserIds, [OFFICER.id], "sent to the recipient alone");
  assert.equal(assigns[0].note, "you know this file", "the note rides the card");
  assert.match(assigns[0].message, /Dana Requester assigned Assign Sim to you/);

  assert.deepEqual(
    emitted.filter((e) => e.target.startsWith("CHANNEL")),
    [],
    "no channel post — a handoff is a conversation between two people"
  );
  assert.deepEqual(targeted(emitted, "ACTIVITY_FEED"), [], "and no activity-feed alert");

  // The note is a card decoration, never a review note (that would fire the
  // separate DM_NOTE fan-out and double-notify).
  assert.deepEqual(targeted(emitted, "DM_NOTE"), [], "the note never becomes a review note");
  const after = await ctx.service.getTask(task.id);
  assert.equal(after.reviewNotes ?? undefined, undefined, "and it is not stored on the task");
});

await check("handing off a NEEDS_REVIEW task fires no activity-feed alert", async () => {
  /* The regression the DM-only rule actually needs. A handoff moves the task
     into the recipient's court, minting a fresh `<them>:NEEDS_REVIEW:<task>`
     signal key — and the new-signal branch of evaluateActivitySignals pushes
     unconditionally (`allowReminders` gates only the REPEAT branch). So the
     recipient got a feed alert on top of their DM_ASSIGN card. */
  const ctx = await setup(undefined, { withActivityFeed: true });
  for (const user of [CREATOR, OFFICER, BYSTANDER]) {
    await ctx.service.registerUser(user);
  }
  const task = await openTask(ctx.service);
  await ctx.service.claimTask(task.id, OFFICER);
  await ctx.service.transitionStatus(task.id, "NEEDS_REVIEW", OFFICER);

  const { emitted } = await capture(ctx, () =>
    ctx.service.assignTask({ taskId: task.id, target: BYSTANDER, actor: CREATOR })
  );

  assert.equal(targeted(emitted, "DM_ASSIGN").length, 1, "the recipient still gets their card");
  assert.deepEqual(
    targeted(emitted, "ACTIVITY_FEED"),
    [],
    "but no feed alert — ADR-0002 says DMs only"
  );
});

await check("a displaced assignee gets a one-line DM", async () => {
  const ctx = await setup();
  const task = await openTask(ctx.service);
  await ctx.service.claimTask(task.id, OFFICER);

  const { emitted } = await capture(ctx, () =>
    ctx.service.assignTask({ taskId: task.id, target: CHECKER, actor: BYSTANDER })
  );

  const displaced = targeted(emitted, "DM").filter((e) => (e.recipientUserIds ?? []).includes(OFFICER.id));
  assert.equal(displaced.length, 1, "the person it was taken from is always told");
  assert.match(displaced[0].message, /Pat passed Assign Sim to Casey Checker/);
  assert.equal(targeted(emitted, "DM_ASSIGN").length, 1, "and the recipient still gets their card");
});

await check("history records TASK_ASSIGNED with a free-text detail", async () => {
  const ctx = await setup();
  const task = await openTask(ctx.service);
  await ctx.service.assignTask({ taskId: task.id, target: OFFICER, actor: CREATOR });
  await ctx.service.assignTask({ taskId: task.id, target: CHECKER, actor: BYSTANDER });

  const rows = (await ctx.service.getHistory(task.id)).filter((h) => h.action === "TASK_ASSIGNED");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].detail, "Assigned to Sam Officer by Dana Requester");
  assert.equal(rows[1].detail, "Reassigned from Sam Officer to Casey Checker by Pat Bystander");
  assert.equal(rows[1].by.id, BYSTANDER.id, "the actor, not the recipient, is the author");
  // ADR-0002 explicitly declined structured target/previousAssignee fields.
  assert.equal(rows[1].target, undefined);
  assert.equal(rows[1].previousAssignee, undefined);
});

await check("the handoff resolves before its fan-out does", async () => {
  let release;
  const stalled = new Promise((resolve) => { release = resolve; });
  const ctx = await setup(() => stalled);
  const task = await openTask(ctx.service);

  const updated = await ctx.service.assignTask({ taskId: task.id, target: OFFICER, actor: CREATOR });
  assert.equal(updated.assignee.id, OFFICER.id, "resolved with the notifier still hanging");
  assert.equal(
    (await ctx.service.getTask(task.id)).assignee.id,
    OFFICER.id,
    "and the state change is durable by then"
  );

  release();
  await ctx.service.settleBackgroundWork();
  assert.ok(ctx.events.some((e) => e.target === "DM_ASSIGN"), "the card still went out");
});

await check("a task created with an assignee is born CLAIMED, in one operation", async () => {
  const ctx = await setup();
  const { result: task, emitted } = await capture(ctx, () =>
    ctx.service.createTask(
      { folderName: "Born Assigned", taskType: "VALUE", notes: "n", assigneeNote: "all yours" },
      CREATOR,
      { id: OFFICER.id, displayName: OFFICER.displayName }
    )
  );

  assert.equal(task.status, "CLAIMED", "born claimed, not OPEN-then-assigned");
  assert.equal(task.assignee.id, OFFICER.id);

  // Exactly one channel post, carrying the assignee — the provider picks the
  // claimed-card variant off it, so the channel never sees a Claim button
  // appear and then vanish.
  const channel = emitted.filter((e) => e.target.startsWith("CHANNEL"));
  assert.equal(channel.length, 1, "one channel post, not a post plus an edit");
  assert.equal(channel[0].target, "CHANNEL");
  assert.equal(channel[0].task.assignee.id, OFFICER.id);

  const assigns = targeted(emitted, "DM_ASSIGN");
  assert.equal(assigns.length, 1, "the recipient is told the task exists and is theirs");
  assert.equal(assigns[0].note, "all yours");
  assert.deepEqual(targeted(emitted, "DM_CLAIM"), [], "nobody claimed it, so no claim card");

  const rows = (await ctx.service.getHistory(task.id)).filter((h) => h.action === "TASK_ASSIGNED");
  assert.equal(rows.length, 1, "the handoff is its own audit row");
  assert.match(rows[0].detail, /Assigned to Sam Officer by Dana Requester at creation/);
});

await check("a task created without an assignee is unchanged", async () => {
  const ctx = await setup();
  const { result: task, emitted } = await capture(ctx, () => openTask(ctx.service));
  assert.equal(task.status, "OPEN", "the ordinary create path still lands OPEN");
  assert.equal(task.assignee, undefined);
  assert.deepEqual(
    emitted.map((e) => e.target),
    ["IN_APP", "CHANNEL"],
    "and fans out exactly as it did before the Handoff existed"
  );
});

/* ── Second pair of hands (ADR-0003) ───────────────────────────────────────
   Four doors, one rule. The creator is refused at each; the affordance that
   survives is a non-creator handing a task to themselves. */

await check("door 1: a creator cannot claim their own task", async () => {
  const ctx = await setup();
  const task = await openTask(ctx.service);
  await assert.rejects(
    () => ctx.service.claimTask(task.id, CREATOR),
    /second pair of hands/,
    "refused, and the refusal says which rule refused"
  );
  const stored = await ctx.service.getTask(task.id);
  assert.equal(stored.status, "OPEN", "the refused claim changed nothing");
  assert.equal(stored.assignee, undefined);
});

await check("door 2: a creator cannot hand their own task to themselves", async () => {
  const ctx = await setup();
  const task = await openTask(ctx.service);
  await assert.rejects(
    () => ctx.service.assignTask({ taskId: task.id, target: CREATOR, actor: CREATOR }),
    /second pair of hands/,
    "self-handoff is not a way around the claim rule"
  );
  assert.equal((await ctx.service.getTask(task.id)).assignee, undefined);
});

await check("door 3: a third party cannot hand a task back to its creator", async () => {
  const ctx = await setup();
  const task = await openTask(ctx.service);
  await ctx.service.claimTask(task.id, OFFICER);
  // The rule is a property of the TASK, not the actor: a bystander who has
  // broken none of it themselves still can't put the creator on their own
  // request.
  await assert.rejects(
    () => ctx.service.assignTask({ taskId: task.id, target: CREATOR, actor: BYSTANDER }),
    /second pair of hands/
  );
  assert.equal((await ctx.service.getTask(task.id)).assignee.id, OFFICER.id, "the assignee is untouched");
});

await check("door 4: a task cannot be born assigned to its own creator", async () => {
  const ctx = await setup();
  await assert.rejects(
    () =>
      ctx.service.createTask(
        { folderName: "Born To Myself", taskType: "VALUE", notes: "n" },
        CREATOR,
        CREATOR
      ),
    /second pair of hands/
  );
  assert.deepEqual(await ctx.service.listTasks(CREATOR), [], "and no task is written");
});

await check("the affordance that survives: a non-creator hands a task to themselves", async () => {
  const ctx = await setup();
  const task = await openTask(ctx.service);
  await ctx.service.claimTask(task.id, OFFICER);
  // Taking work off someone who is stuck or away. Still allowed (ADR-0002) —
  // it is only the creator ADR-0003 bars.
  const taken = await ctx.service.assignTask({ taskId: task.id, target: BYSTANDER, actor: BYSTANDER });
  assert.equal(taken.assignee.id, BYSTANDER.id);
});

await check("no task type is exempt, including OOO and FRAUD", async () => {
  const ctx = await setup();

  // OOO: the creator is the person going out, the assignee is the person
  // covering, and you cannot cover for yourself.
  const ooo = await ctx.service.createTask(
    {
      folderName: "Beach Week",
      taskType: "OOO",
      notes: "out",
      startDate: "2026-09-01",
      returnDate: "2026-09-08"
    },
    CREATOR
  );
  await assert.rejects(() => ctx.service.claimTask(ooo.id, CREATOR), /second pair of hands/);

  // FRAUD: a file checker cannot check a file they filed themselves — the
  // separation of duties the check exists for.
  const fraud = await ctx.service.createTask(
    { folderName: "My Own File", taskType: "FRAUD", notes: "check it" },
    CHECKER
  );
  await assert.rejects(() => ctx.service.claimTask(fraud.id, CHECKER), /second pair of hands/);
  // ...but anyone else holding the role still can.
  const claimed = await ctx.service.claimTask(fraud.id, CHECKER_2);
  assert.equal(claimed.assignee.id, CHECKER_2.id);
});

console.log(`\nAll ${passed} Handoff checks passed.`);
