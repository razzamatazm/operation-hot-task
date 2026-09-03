#!/usr/bin/env node
/*
 * DM cards go stale when a task is completed from the Teams tab.
 *
 * Before this, only the *channel* card tracked a task's status. The two DM
 * cards did not: the claim-detail card was fire-and-forget (its activity id was
 * discarded, so it could never be edited), and the note/chat card was only ever
 * rebuilt when a new note arrived. Complete a task from the tab and both cards
 * sat there in the assignee's chat still offering "Complete", forever — tapping
 * it just toasted an error and left the button in place.
 *
 * Three layers are asserted here, bottom-up:
 *   1. Card builders  — a closed task's card carries the terminal banner and no
 *      action buttons; COMPLETED keeps its reply box (addCompletedNote, #45)
 *      while CANCELLED/ARCHIVED lose it.
 *   2. Notification layer — DM_CARD_SYNC reaches the bot as an in-place sync
 *      with the right per-viewer button rules, and creates/pings nothing.
 *   3. Task service — every status change emits DM_CARD_SYNC last, including
 *      mid-flight steps (the button must re-arm to the *next* step, not just
 *      disappear at the end), re-open, and the scheduler's auto-complete.
 *
 * Plus the self-heal: a rejected card tap asks for a re-sync so a card that
 * missed an update repairs itself instead of staying dead.
 *
 * Runs against the compiled dist, mirroring notify-background-sim-test.mjs.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TeamsBotClient, advanceFor, closedStateFor, detailCard, noteCard, noteCardDataFromTask } from "../apps/server/dist/bot.js";
import { TeamsNotificationProvider } from "../apps/server/dist/notifications.js";
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

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

/* Action titles on a rendered Adaptive Card, in order. */
const actionTitles = (card) => (card.actions ?? []).map((action) => action.title);
const hasReplyBox = (card) => (card.body ?? []).some((block) => block.id === "replyText");
const headline = (card) => card.body?.[0]?.text;

const makeTask = (overrides = {}) => ({
  id: "task-1",
  folderName: "Smith-1042",
  taskType: "LOI",
  dueAt: new Date("2026-08-14T20:00:00Z").toISOString(),
  urgency: "GREEN",
  points: 2,
  notes: "have a look",
  status: "CLAIMED",
  createdAt: new Date("2026-08-14T16:00:00Z").toISOString(),
  updatedAt: new Date("2026-08-14T16:00:00Z").toISOString(),
  createdBy: { id: CREATOR.id, displayName: CREATOR.displayName },
  assignee: { id: CHECKER.id, displayName: CHECKER.displayName },
  reviewNotes: [{ text: "started on it", by: { id: CHECKER.id, displayName: CHECKER.displayName }, at: new Date("2026-08-14T17:00:00Z").toISOString() }],
  ...overrides
});

console.log("DM card sync sim");

// --- 1. Card builders -------------------------------------------------------

await check("a live task's note card still carries its advance button", () => {
  const card = noteCard(noteCardDataFromTask(makeTask({ status: "CLAIMED" }), CHECKER));
  assert.deepEqual(actionTitles(card), ["Reply", "Complete"]);
  assert.equal(hasReplyBox(card), true);
  assert.equal(headline(card), "Conversation on Smith-1042");
});

await check("COMPLETED note card drops every button but keeps the reply box", () => {
  const card = noteCard(noteCardDataFromTask(makeTask({ status: "COMPLETED" }), CHECKER));
  // Reply survives because addCompletedNote (#45) still accepts notes on a
  // COMPLETED task — the affordance would otherwise contradict the feature.
  assert.deepEqual(actionTitles(card), ["Reply"]);
  assert.equal(hasReplyBox(card), true);
  assert.equal(headline(card), "✅ Completed — Smith-1042");
});

await check("CANCELLED / ARCHIVED note cards lose the reply box too", () => {
  for (const [status, banner] of [["CANCELLED", "🚫 Cancelled — Smith-1042"], ["ARCHIVED", "📦 Archived — Smith-1042"]]) {
    const card = noteCard(noteCardDataFromTask(makeTask({ status }), CHECKER));
    assert.deepEqual(actionTitles(card), []);
    assert.equal(hasReplyBox(card), false);
    assert.equal(headline(card), banner);
  }
});

await check("a closed note card still shows the conversation", () => {
  const card = noteCard(noteCardDataFromTask(makeTask({ status: "COMPLETED" }), CHECKER));
  assert.ok(
    (card.body ?? []).some((block) => typeof block.text === "string" && block.text.includes("started on it")),
    "the point of keeping the card is keeping the history"
  );
});

await check("a fraud card's role-aware buttons also go away when closed", () => {
  const fraud = makeTask({ taskType: "FRAUD", status: "COMPLETED" });
  const card = noteCard(noteCardDataFromTask(fraud, CHECKER));
  assert.deepEqual(actionTitles(card), ["Reply"]);
  // Live, the same viewer would still be offered a two-phase move.
  const live = noteCard(noteCardDataFromTask(makeTask({ taskType: "FRAUD", status: "PENDING_APPROVAL" }), CHECKER));
  assert.ok(actionTitles(live).length > 1, "a live fraud card keeps its button set");
});

await check("a blocked Submit explains itself on the DM card instead of firing and bouncing (#184)", () => {
  const item = (over) => ({ id: "i", text: "Bank statement", checked: false, addedBy: "checker", addedOnPass: 1, ...over });
  const blocked = makeTask({ taskType: "FRAUD", status: "AWAITING_ITEMS", checklist: [item({ id: "a" })] });
  const card = noteCard(noteCardDataFromTask(blocked, CREATOR));
  assert.deepEqual(actionTitles(card), ["Reply", "Submit"], "the move is still named — it is the phase's next step");
  const submit = (card.actions ?? []).find((a) => a.title === "Submit");
  // Adaptive Cards 1.4 has no disabled action, so the button opens the reason.
  assert.equal(submit.type, "Action.ShowCard", "it doesn't execute the transition");
  assert.equal(submit.card.body[0].text, "1 item still needs a check or a note");

  const resolved = makeTask({ taskType: "FRAUD", status: "AWAITING_ITEMS", checklist: [item({ id: "a", checked: true })] });
  const go = (noteCard(noteCardDataFromTask(resolved, CREATOR)).actions ?? []).find((a) => a.title === "Submit");
  assert.equal(go.type, "Action.Execute", "once the list is answered it fires straight through");
  assert.equal(go.data.targetStatus, "PENDING_APPROVAL");
});

await check("the claim-detail card swaps its title for the banner and drops advance", () => {
  const base = { taskId: "task-1", title: "You claimed Smith-1042", detail: "Type: LOI Check\nDue: Aug 14", openUrl: "https://teams/x", advance: { status: "COMPLETED", label: "Complete" } };
  const live = detailCard(base);
  assert.deepEqual(actionTitles(live), ["Complete", "Open in Hot Task"]);
  assert.equal(headline(live), "You claimed Smith-1042");

  const closed = detailCard({ ...base, closed: closedStateFor("COMPLETED", "Smith-1042") });
  // Open in Hot Task survives — the card is still a useful record of the work.
  assert.deepEqual(actionTitles(closed), ["Open in Hot Task"]);
  assert.equal(headline(closed), "✅ Completed — Smith-1042");
  assert.equal(closed.body?.[1]?.text, base.detail, "the details block is untouched");
});

await check("closedStateFor treats only terminal statuses as closed", () => {
  assert.equal(closedStateFor("CLAIMED", "f"), undefined);
  assert.equal(closedStateFor("OPEN", "f"), undefined);
  assert.equal(closedStateFor("PENDING_APPROVAL", "f"), undefined);
  assert.equal(closedStateFor("COMPLETED", "f").allowReply, true);
  assert.equal(closedStateFor("CANCELLED", "f").allowReply, false);
  // This is what makes a re-open re-arm the buttons for free.
});

// --- 2. Notification layer --------------------------------------------------

const notifierSetup = () => {
  const calls = [];
  const botClient = {
    syncTaskCards: async (opts) => {
      calls.push(opts);
    }
  };
  /* Card recipients arrive as bare ids; the fraud button set needs live roles,
     so the provider looks them up. Anyone unknown resolves roleless. */
  const directory = new Map([CHECKER, CREATOR].map((u) => [u.id, u]));
  const notifier = new TeamsNotificationProvider(
    botClient,
    { isEnabled: () => false, sendToUsers: async () => {} },
    { getNotificationChannelId: async () => "channel-1" },
    async (userId) => directory.get(userId)
  );
  return { notifier, calls };
};

const syncEvent = (task) => ({
  type: "TASK_STATUS_CHANGED",
  task,
  actor: { id: "system", displayName: "Hot Task" },
  message: "sync",
  target: "DM_CARD_SYNC",
  createdAt: new Date().toISOString()
});

await check("DM_CARD_SYNC syncs both participants with the live status", async () => {
  const { notifier, calls } = notifierSetup();
  await notifier.notify(syncEvent(makeTask({ status: "COMPLETED" })));
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.taskId, "task-1");
  assert.equal(call.status, "COMPLETED");
  assert.deepEqual(
    call.recipients.map((r) => r.userId).sort(),
    [CHECKER.id, CREATOR.id].sort()
  );
  assert.deepEqual(call.thread, [{ author: CHECKER.displayName, text: "started on it" }]);
});

await check("the advance button is gated to the assignee, same as DM_NOTE", async () => {
  const { notifier, calls } = notifierSetup();
  await notifier.notify(syncEvent(makeTask({ status: "CLAIMED" })));
  const byUser = Object.fromEntries(calls[0].recipients.map((r) => [r.userId, r.showAdvance]));
  // Complete is the assignee's move; the creator must not be handed it.
  assert.equal(calls[0].advance.status, "COMPLETED");
  assert.equal(byUser[CHECKER.id], true);
  assert.equal(byUser[CREATOR.id], false);
});

await check("a fraud sync carries per-viewer fraud actions instead of an advance", async () => {
  const { notifier, calls } = notifierSetup();
  await notifier.notify(syncEvent(makeTask({ taskType: "FRAUD", status: "AWAITING_ITEMS" })));
  for (const recipient of calls[0].recipients) {
    assert.ok(Array.isArray(recipient.fraudActions), `${recipient.userId} gets a fraud button set`);
  }
});

await check("an unclaimed task syncs only the creator", async () => {
  const { notifier, calls } = notifierSetup();
  const task = makeTask({ status: "OPEN" });
  delete task.assignee;
  await notifier.notify(syncEvent(task));
  assert.deepEqual(calls[0].recipients.map((r) => r.userId), [CREATOR.id]);
});

// --- 3. Task service --------------------------------------------------------

const serviceSetup = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dm-card-sync-sim-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.init();
  const events = [];
  const notifier = {
    notify: async (event) => {
      events.push(event);
    },
    canReachDm: async () => true
  };
  const service = new TaskService(store, notifier, new SseHub(), config, undefined, undefined);
  return { service, events, store };
};

/* Notification fan-out is dispatched off the request path (#119), so a test has
   to let the background chain drain before reading `events`. */
const settle = async () => {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const syncTargets = (events) => events.filter((event) => event.target === "DM_CARD_SYNC");

await check("completing a task emits a DM_CARD_SYNC carrying the COMPLETED task", async () => {
  const { service, events } = await serviceSetup();
  const task = await service.createTask({ folderName: "Smith-1042", taskType: "LOI", urgency: "GREEN", points: 2, notes: "" }, CREATOR);
  await service.claimTask(task.id, CHECKER);
  await settle();
  events.length = 0;

  await service.transitionStatus(task.id, "COMPLETED", CHECKER);
  await settle();

  const syncs = syncTargets(events);
  assert.equal(syncs.length, 1, "exactly one sync per status change");
  assert.equal(syncs[0].task.status, "COMPLETED");
  // Last word: every other branch may have sent or rebuilt a card first.
  assert.equal(events.at(-1).target, "DM_CARD_SYNC");
});

await check("a mid-flight step syncs too, so the button re-arms to the next one", async () => {
  const { service, events } = await serviceSetup();
  const task = await service.createTask({ folderName: "Jones-88", taskType: "LOAN_DOCS", urgency: "GREEN", points: 1, notes: "" }, CREATOR);
  await service.claimTask(task.id, CHECKER);
  await settle();
  events.length = 0;

  // Loan Docs advances CLAIMED → MERGE_DONE → ... rather than straight to done;
  // a card frozen on "Merge Done" is worse than one frozen on "Complete".
  const moved = await service.transitionStatus(task.id, "MERGE_DONE", CHECKER);
  await settle();

  const syncs = syncTargets(events);
  assert.equal(syncs.length, 1);
  assert.equal(syncs[0].task.status, "MERGE_DONE");
  assert.equal(moved.status, "MERGE_DONE");
  // The button doesn't just vanish — it becomes the *next* step's, on the card
  // of whoever owns that step. Approving the merge is the creator's move, not
  // the assignee's (#173), so it re-arms there and nowhere else.
  const forCreator = noteCard(noteCardDataFromTask(syncs[0].task, CREATOR));
  assert.deepEqual(actionTitles(forCreator), ["Reply", "Approve Merge"]);
  const forChecker = noteCard(noteCardDataFromTask(syncs[0].task, CHECKER));
  assert.deepEqual(actionTitles(forChecker), ["Reply"], "the assignee doesn't approve their own merge");
});

/* The confirm card is the one posted straight back to whoever just tapped a
   button, and it carries its own copy of the "what's next" affordance. It used
   to gate that button for FRAUD only, on the reasoning that a fraud hand-off
   passes the task to the other party — but so does every merge rung (#173), and
   after the merge seats were guarded the assignee who tapped Merge Done was
   handed an Approve Merge button the server would refuse. Both card surfaces now
   ask `advanceFor`, which is the same question `canTransitionStatus` answers. */
await check("the confirm card after a tap offers no button the tapper can't press", async () => {
  const { service } = await serviceSetup();
  const task = await service.createTask({ folderName: "Confirm-1", taskType: "LOAN_DOCS", urgency: "GREEN", points: 1, notes: "" }, CREATOR);
  await service.claimTask(task.id, CHECKER);

  // The assignee taps Merge Done. Approving it is the creator's move, so the
  // card that comes back to the assignee shows no forward button at all.
  const merged = await service.transitionStatus(task.id, "MERGE_DONE", CHECKER);
  assert.equal(advanceFor(merged, CHECKER), undefined, "the tapper isn't offered the other party's move");
  assert.deepEqual(
    advanceFor(merged, CREATOR),
    { status: "MERGE_APPROVED", label: "Approve Merge" },
    "and the party who does own it still gets it"
  );

  // The creator taps Approve Merge. Completing is back to the assignee.
  const approved = await service.transitionStatus(task.id, "MERGE_APPROVED", CREATOR);
  assert.equal(advanceFor(approved, CREATOR), undefined, "the creator doesn't complete the task");
  assert.deepEqual(advanceFor(approved, CHECKER), { status: "COMPLETED", label: "Complete" });
});

await check("a viewerless advance still describes the flow's next step", async () => {
  // No viewer means no permission question to ask — the channel card has no one
  // to gate against, and must keep the forward step it always showed.
  const { service } = await serviceSetup();
  const task = await service.createTask({ folderName: "Confirm-2", taskType: "LOAN_DOCS", urgency: "GREEN", points: 1, notes: "" }, CREATOR);
  const claimed = await service.claimTask(task.id, CHECKER);
  assert.deepEqual(advanceFor(claimed), { status: "MERGE_DONE", label: "Merge Done" });
});

await check("unclaiming syncs the ex-assignee, who is no longer a participant", async () => {
  const { service, events } = await serviceSetup();
  const task = await service.createTask({ folderName: "Drop-1", taskType: "LOI", urgency: "GREEN", points: 1, notes: "" }, CREATOR);
  await service.claimTask(task.id, CHECKER);
  await settle();
  events.length = 0;

  const dropped = await service.unclaimTask(task.id, CHECKER);
  await settle();

  const sync = syncTargets(events).at(-1);
  assert.equal(dropped.assignee, undefined, "unclaim strips the assignee");
  // Without naming them the sync would skip the one person whose card is stale:
  // the ex-assignee still holding a Complete button they've just lost.
  assert.deepEqual(sync.recipientUserIds, [CHECKER.id]);
  const { notifier, calls } = notifierSetup();
  await notifier.notify(sync);
  assert.ok(
    calls[0].recipients.some((r) => r.userId === CHECKER.id),
    "the ex-assignee is synced"
  );
  assert.equal(calls[0].recipients.find((r) => r.userId === CHECKER.id).showAdvance, false);
});

await check("re-opening a completed task syncs it back to a live status", async () => {
  const { service, events } = await serviceSetup();
  const task = await service.createTask({ folderName: "Reopen-1", taskType: "LOI", urgency: "GREEN", points: 1, notes: "" }, CREATOR);
  await service.claimTask(task.id, CHECKER);
  await service.transitionStatus(task.id, "COMPLETED", CHECKER);
  await settle();
  events.length = 0;

  await service.transitionStatus(task.id, "OPEN", CREATOR);
  await settle();

  const syncs = syncTargets(events);
  assert.equal(syncs.length, 1);
  // Assignee retained → back to CLAIMED, and the card re-arms rather than
  // staying stuck on "✅ Completed" while the channel says it's live again.
  assert.equal(syncs[0].task.status, "CLAIMED");
  assert.equal(closedStateFor(syncs[0].task.status, "Reopen-1"), undefined);
});

await check("cancelling syncs the cards closed", async () => {
  const { service, events } = await serviceSetup();
  const task = await service.createTask({ folderName: "Cancel-1", taskType: "LOI", urgency: "GREEN", points: 1, notes: "" }, CREATOR);
  await settle();
  events.length = 0;

  await service.transitionStatus(task.id, "CANCELLED", CREATOR);
  await settle();

  assert.equal(syncTargets(events).at(-1).task.status, "CANCELLED");
});

await check("resyncTaskCards re-emits for a task's current state, and no-ops for a stranger", async () => {
  const { service, events } = await serviceSetup();
  const task = await service.createTask({ folderName: "Heal-1", taskType: "LOI", urgency: "GREEN", points: 1, notes: "" }, CREATOR);
  await service.claimTask(task.id, CHECKER);
  await service.transitionStatus(task.id, "COMPLETED", CHECKER);
  await settle();
  events.length = 0;

  await service.resyncTaskCards(task.id);
  const syncs = syncTargets(events);
  assert.equal(syncs.length, 1);
  assert.equal(syncs[0].task.status, "COMPLETED");

  events.length = 0;
  await service.resyncTaskCards("no-such-task");
  assert.deepEqual(syncTargets(events), [], "an unknown id must not throw or emit");
});

await check("a FRAUD checklist write syncs the cards, so the Submit gate can't dead-end them (#184)", async () => {
  const { service, events } = await serviceSetup();
  const task = await service.createTask({ folderName: "Gate-1", taskType: "FRAUD", notes: "check it" }, CREATOR);
  await service.claimTask(task.id, CHECKER);
  const withItem = await service.addChecklistItem(task.id, "Bank statement", CHECKER);
  await service.transitionStatus(task.id, "AWAITING_ITEMS", CHECKER);
  await service.settleBackgroundWork();
  await settle();
  events.length = 0;

  /* The requester answers the last item in the web app. No status moves, so
     nothing in the transition path runs — and before this the card kept
     offering the blocked Submit with no way to repair itself, because a blocked
     Submit no longer produces the rejected tap that used to trigger a re-sync. */
  await service.setChecklistItemChecked(task.id, withItem.checklist[0].id, true, undefined, CREATOR);
  await service.settleBackgroundWork();
  await settle();

  const syncs = syncTargets(events);
  assert.equal(syncs.length, 1, "the checklist write brings the cards along");
  assert.equal(syncs[0].task.status, "AWAITING_ITEMS", "still the requester's phase");
  const submit = (noteCard(noteCardDataFromTask(syncs[0].task, CREATOR)).actions ?? []).find((a) => a.title === "Submit");
  assert.equal(submit.type, "Action.Execute", "and the card the sync renders can finally submit");

  // Non-FRAUD tasks have no checklist path at all, so nothing changes for them.
  events.length = 0;
  const loi = await service.createTask({ folderName: "Gate-2", taskType: "LOI", urgency: "GREEN", points: 1, notes: "" }, CREATOR);
  await service.settleBackgroundWork();
  await settle();
  assert.deepEqual(syncTargets(events).map((s) => s.task.id), [], "creating a plain task still syncs nothing");
  assert.equal(loi.taskType, "LOI");
});

await check("the scheduler's OOO auto-complete retires the cards", async () => {
  const { service, events, store } = await serviceSetup();
  // createTask rejects an OOO whose return date has already passed, so the
  // holiday is booked for real and the scheduler is then run on the day the
  // person gets back (#204).
  const day = (offsetDays) => new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const task = await service.createTask(
    {
      folderName: "Out next week",
      taskType: "OOO",
      urgency: "GREEN",
      points: 1,
      notes: "",
      startDate: day(3),
      returnDate: day(7)
    },
    CREATOR
  );
  await settle();
  const returned = new Date(new Date(task.dueAt).getTime() + 60 * 60 * 1000);
  events.length = 0;

  await service.runMaintenance(returned);
  await settle();

  const syncs = syncTargets(events);
  assert.equal(syncs.length, 1, "the scheduler closes this outside transitionStatus, so it syncs itself");
  assert.equal(syncs[0].task.status, "COMPLETED");
  assert.equal((await store.findTask(task.id)).status, "COMPLETED");
});

await check("auto-archiving retires the reply box the COMPLETED banner allowed", async () => {
  const { service, events } = await serviceSetup();
  const task = await service.createTask({ folderName: "Old-1", taskType: "LOI", urgency: "GREEN", points: 1, notes: "" }, CREATOR);
  await service.claimTask(task.id, CHECKER);
  await service.transitionStatus(task.id, "COMPLETED", CHECKER);
  await settle();
  events.length = 0;

  // Twenty days on, past the 14-day auto-archive window.
  await service.runMaintenance(new Date(Date.now() + 20 * 24 * 60 * 60 * 1000));
  await settle();

  const syncs = syncTargets(events);
  assert.equal(syncs.length, 1);
  assert.equal(syncs[0].task.status, "ARCHIVED");
  assert.equal(closedStateFor("ARCHIVED", "Old-1").allowReply, false);
});

// --- 4. TeamsBotClient, end to end over the card stores ---------------------

/* A real TeamsBotClient with the Bot Framework connector stubbed out, so the
   store round-trip (send -> record activity id -> edit that exact message) is
   exercised for real rather than mocked at the notifier seam. `handleTransition`
   and the private fields below are TypeScript-private only; this is a JS test
   against dist, the same reach-into-internals the repo already does in
   bot-dedupe-sim.mjs. */
const botSetup = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dm-card-bot-sim-"));
  const dataFile = path.join(dir, "bot-references.json");
  const reference = {
    serviceUrl: "https://example.invalid",
    conversation: { id: "dm-conversation-1" },
    user: { id: "29:checker", aadObjectId: "aad-checker" }
  };
  await fs.writeFile(dataFile, JSON.stringify([{ key: `dm:${CHECKER.id}`, reference, scope: "DM", userId: CHECKER.id }]), "utf8");

  const client = new TeamsBotClient("app-id", "app-password", undefined, dataFile);
  await client.init();

  const sent = [];
  const updated = [];
  let nextId = 0;
  client.adapter.createConnectorClient = () => ({
    conversations: {
      sendToConversation: async (conversationId, activity) => {
        nextId += 1;
        sent.push({ conversationId, activity });
        return { id: `activity-${nextId}` };
      },
      updateActivity: async (conversationId, activityId, activity) => {
        updated.push({ conversationId, activityId, activity });
        return { id: activityId };
      },
      deleteActivity: async () => {}
    }
  });
  return { client, sent, updated };
};

const cardOf = (entry) => entry.activity.attachments[0].content;

await check("the claim card is recorded on send, then edited in place on completion", async () => {
  const { client, sent, updated } = await botSetup();
  await client.sendTrackedDetailCard([CHECKER.id], {
    taskId: "task-1",
    title: "You claimed Smith-1042",
    detail: "Type: LOI Check\nDue: Aug 14",
    openUrl: "https://teams/x",
    advance: { status: "COMPLETED", label: "Complete" }
  });
  assert.equal(sent.length, 1, "the claim card goes out once");
  assert.deepEqual(actionTitles(cardOf(sent[0])), ["Complete", "Open in Hot Task"]);

  await client.syncTaskCards({
    taskId: "task-1",
    folder: "Smith-1042",
    status: "COMPLETED",
    thread: [],
    recipients: [{ userId: CHECKER.id, showAdvance: false }]
  });

  // The bug in one assertion: the card that was sent is edited, not re-sent.
  assert.equal(sent.length, 1, "a sync must not put a new message in the chat");
  const edit = updated.find((entry) => entry.activityId === "activity-1");
  assert.ok(edit, "the recorded activity id is the one that gets updated");
  assert.deepEqual(actionTitles(cardOf(edit)), ["Open in Hot Task"]);
  assert.equal(headline(cardOf(edit)), "✅ Completed — Smith-1042");
  assert.equal(cardOf(edit).body[1].text, "Type: LOI Check\nDue: Aug 14", "the stored detail block is replayed");
});

await check("a note card's Complete button is stripped by the same sync", async () => {
  const { client, sent, updated } = await botSetup();
  await client.syncNoteCards({
    taskId: "task-2",
    folder: "Jones-88",
    thread: [{ author: "Casey", text: "on it" }],
    advance: { status: "COMPLETED", label: "Complete" },
    recipients: [{ userId: CHECKER.id, showAdvance: true, createIfMissing: true }]
  });
  assert.deepEqual(actionTitles(cardOf(sent[0])), ["Reply", "Complete"]);

  await client.syncTaskCards({
    taskId: "task-2",
    folder: "Jones-88",
    status: "COMPLETED",
    thread: [{ author: "Casey", text: "on it" }],
    recipients: [{ userId: CHECKER.id, showAdvance: false }]
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(actionTitles(cardOf(updated.at(-1))), ["Reply"]);
});

await check("a silent sync never posts a replacement when the update is rejected", async () => {
  const { client, sent, updated } = await botSetup();
  await client.syncNoteCards({
    taskId: "task-3",
    folder: "Gone-1",
    thread: [{ author: "Casey", text: "hi" }],
    recipients: [{ userId: CHECKER.id, showAdvance: false, createIfMissing: true }]
  });
  assert.equal(sent.length, 1);
  // Simulate a dead activity id (card deleted, or predating a redeploy).
  client.adapter.createConnectorClient = () => ({
    conversations: {
      sendToConversation: async (conversationId, activity) => {
        sent.push({ conversationId, activity });
        return { id: "activity-resent" };
      },
      updateActivity: async () => {
        throw new Error("Activity not found");
      },
      deleteActivity: async () => {}
    }
  });

  await client.syncTaskCards({
    taskId: "task-3",
    folder: "Gone-1",
    status: "COMPLETED",
    thread: [],
    recipients: [{ userId: CHECKER.id, showAdvance: false }]
  });
  // A background sync that resurfaces as a brand-new DM is exactly the
  // unannounced ping this path is supposed to avoid. The dead id is left for
  // the next note-driven send to repair.
  assert.equal(sent.length, 1, "no replacement card was posted");
  assert.equal(updated.length, 0);
});

await check("a rejected card tap asks for a re-sync and says so", async () => {
  const { client } = await botSetup();
  const resynced = [];
  client.setCardResync(async (taskId) => {
    resynced.push(taskId);
  });
  client.setTransitionHandler(
    async () => CHECKER,
    async () => {
      throw new Error("Task cannot move to COMPLETED from COMPLETED");
    }
  );

  const outcome = await client.handleTransition("task-9", "COMPLETED", "aad-checker");
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /Refreshing this card\.$/);
  // Fire-and-forget, so let the microtask queue drain before reading.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(resynced, ["task-9"], "the stale card is scheduled for repair");
});

console.log(`\n${passed} checks passed`);
