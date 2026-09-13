#!/usr/bin/env node
/*
 * What the channel card says at each stage of a task (#193, reworded
 * 2026-09-12).
 *
 * The root channel card is edited in place for a task's whole life. Every
 * stage names who did what to whose task, then the file and its type on a
 * line of their own, so a reader scrolling the channel can tell what the work
 * was and who asked for it without opening anything:
 *
 *   Dana needs an LOI checked           new (then How Bad and Urgency)
 *   Casey grabbed Dana's LOI Check      claimed
 *   ✅ Casey completed Dana's LOI Check  completed, and archived
 *   🚫 Dana cancelled their LOI Check   cancelled
 *   Smith-1042 - LOI Check              the line under every one of them
 *
 * What's asserted here, over a real TeamsBotClient with the connector stubbed:
 *   1. Each stage's headline and name line, driven through the notification
 *      layer that composes them.
 *   2. No stage links the file name to Humperdink.
 *   3. An OOO task's description stands in for the file name.
 *   4. The user-specific refresh path renders the identical body, so a card
 *      doesn't change wording the first time Teams refreshes it.
 *   5. A card-tap claim and a web claim produce the same card body.
 *   6. A task born assigned says so, rather than reading as a claim.
 *   7. A handoff edits the posted card the same way: no Claim button, and a
 *      headline saying the holder was assigned it.
 *
 * Sibling of channel-card-terminal-sim-test.mjs, built the same way and
 * running against the compiled dist.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TeamsBotClient } from "../apps/server/dist/bot.js";
import { TeamsNotificationProvider } from "../apps/server/dist/notifications.js";

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

const cardOf = (entry) => entry.activity.attachments[0].content;
const headline = (card) => card.body?.[0]?.text;
const nameLine = (card) => card.body?.[1]?.text;
const actionTitles = (card) => (card.actions ?? []).map((action) => action.title);

const CREATOR = { id: "aad-creator", displayName: "Dana Requester" };
const CHECKER = { id: "aad-checker", displayName: "Casey Checker" };

/* What the notification layer threads in from the task snapshot. */
const contextFor = (over = {}) => ({
  taskType: "LOI",
  folderName: "Smith-1042",
  createdBy: CREATOR.displayName,
  assignee: CHECKER.displayName,
  ...over
});

const taskAt = (status, over = {}) => ({
  id: "task-1",
  folderName: "Smith-1042",
  taskType: "LOI",
  status,
  createdBy: CREATOR,
  assignee: CHECKER,
  ...over
});

/* A whole task, for the paths that build the card from one. */
const liveTask = (status, over = {}) => ({
  ...taskAt(status),
  dueAt: "2026-08-14T20:00:00.000Z",
  urgency: "GREEN",
  points: 2,
  notes: "",
  humperdinkLink: "https://humperdink.example/Loans/Details/1042",
  createdAt: "2026-08-14T16:00:00.000Z",
  updatedAt: "2026-08-14T16:00:00.000Z",
  reviewNotes: [],
  ...over
});

const botSetup = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "channel-card-facts-sim-"));
  const dataFile = path.join(dir, "bot-references.json");
  const reference = {
    serviceUrl: "https://example.invalid",
    conversation: { id: "19:channel-1@thread.tacv2", conversationType: "channel" },
    user: { id: "29:bot" }
  };
  await fs.writeFile(dataFile, JSON.stringify([{ key: "channel:19:channel-1@thread.tacv2", reference, scope: "CHANNEL" }]), "utf8");

  const client = new TeamsBotClient("app-id", "app-password", undefined, dataFile);
  await client.init();

  const posted = [];
  const updated = [];
  let nextId = 0;
  client.adapter.createConnectorClient = () => ({
    conversations: {
      createConversation: async (params) => {
        nextId += 1;
        posted.push({ params, activity: params.activity });
        return { id: `19:thread-${nextId}`, activityId: `activity-${nextId}` };
      },
      updateActivity: async (conversationId, activityId, activity) => {
        updated.push({ conversationId, activityId, activity });
        return { id: activityId };
      },
      sendToConversation: async () => ({ id: "activity-reply" }),
      deleteActivity: async () => {},
      getConversationMembers: async () => []
    }
  });
  const notifier = new TeamsNotificationProvider(
    client,
    { isEnabled: () => false, sendToUsers: async () => {} },
    { getNotificationChannelId: async () => "channel-1" },
    async () => undefined
  );
  const notify = (target, task, actor) =>
    notifier.notify({ type: "TASK_STATUS_CHANGED", task, actor, message: "", target, createdAt: new Date().toISOString() });
  return { client, posted, updated, notify };
};

const postOpenTask = async (client) => {
  await client.postTaskCard("task-1", "Dana needs an LOI checked", "Smith-1042 - LOI Check\nHow Bad: —\nUrgency: Today");
};

console.log("Channel card facts sim");

await check("a new task's card says who needs what, then the file and its type", async () => {
  const { posted, notify } = await botSetup();
  await notify("CHANNEL", liveTask("OPEN", { assignee: undefined }), CREATOR);

  const card = cardOf(posted.at(-1));
  assert.equal(headline(card), "Dana needs an LOI checked");
  assert.equal(
    card.body[1].text,
    "Smith-1042 - LOI Check\nHow Bad: 💩💩\nUrgency: Within 24 Hours",
    "the task has a Humperdink link, and the card still doesn't carry it"
  );
  assert.equal(posted.at(-1).activity.summary, "Dana needs an LOI checked");
});

await check("the claimed card names the claimer and whose task, then the file and its type", async () => {
  const { updated, notify } = await botSetup();
  await notify("CHANNEL", liveTask("OPEN", { assignee: undefined }), CREATOR);
  await notify("CHANNEL_CLAIMED", liveTask("CLAIMED"), CHECKER);

  const card = cardOf(updated.at(-1));
  assert.equal(headline(card), "Casey grabbed Dana's LOI Check");
  assert.equal(nameLine(card), "Smith-1042 - LOI Check");
  assert.equal(card.body.length, 2, "one headline plus the name line, no detail block");
});

await check("the completed card names who finished whose task", async () => {
  const { updated, notify } = await botSetup();
  await notify("CHANNEL", liveTask("OPEN", { assignee: undefined }), CREATOR);
  await notify("CHANNEL_COMPLETED", liveTask("COMPLETED"), CHECKER);

  const card = cardOf(updated.at(-1));
  assert.equal(headline(card), "✅ Casey completed Dana's LOI Check");
  assert.equal(nameLine(card), "Smith-1042 - LOI Check");
  assert.equal(card.body.length, 2);
});

await check("the cancelled card says the creator cancelled it, held or not", async () => {
  const { updated, notify } = await botSetup();
  await notify("CHANNEL", liveTask("OPEN", { assignee: undefined }), CREATOR);

  // Only the creator can cancel, so the card names them whoever held it.
  await notify("CHANNEL_CANCELLED", liveTask("CANCELLED"), CREATOR);
  assert.equal(headline(cardOf(updated.at(-1))), "🚫 Dana cancelled their LOI Check");

  await notify("CHANNEL_CANCELLED", liveTask("CANCELLED", { assignee: undefined }), CREATOR);
  const card = cardOf(updated.at(-1));
  assert.equal(headline(card), "🚫 Dana cancelled their LOI Check");
  assert.equal(nameLine(card), "Smith-1042 - LOI Check");
  assert.equal(card.body.length, 2);
});

await check("an OOO task's description stands in for the file name", async () => {
  const { updated, notify } = await botSetup();
  await notify("CHANNEL", liveTask("OPEN", { assignee: undefined }), CREATOR);
  const ooo = { taskType: "OOO", folderName: "Cabo, back Monday" };

  await notify("CHANNEL_CLAIMED", liveTask("CLAIMED", ooo), CHECKER);
  assert.equal(headline(cardOf(updated.at(-1))), "Casey grabbed Dana's Out of Office");
  assert.equal(nameLine(cardOf(updated.at(-1))), "Cabo, back Monday - Out of Office");

  await notify("CHANNEL_COMPLETED", liveTask("COMPLETED", ooo), CHECKER);
  assert.equal(headline(cardOf(updated.at(-1))), "✅ Casey completed Dana's Out of Office");

  await notify("CHANNEL_CANCELLED", liveTask("CANCELLED", ooo), CREATOR);
  assert.equal(headline(cardOf(updated.at(-1))), "🚫 Dana cancelled their Out of Office");
  assert.equal(nameLine(cardOf(updated.at(-1))), "Cabo, back Monday - Out of Office");
});

await check("a Teams refresh replays the card the edit rendered", async () => {
  const { client, updated } = await botSetup();
  await postOpenTask(client);

  // Drive the in-place edit, then ask the refresh path for the same task and
  // require the two bodies to match. This is the "stays in sync" criterion: the
  // refresh path rebuilds from the task, so a builder change that misses it
  // silently changes the card's wording.
  const cases = [
    ["CLAIMED", () => client.markTaskClaimed("task-1", "Casey grabbed Dana's LOI Check", contextFor())],
    ["COMPLETED", () => client.markTaskCompleted("task-1", contextFor())],
    ["ARCHIVED", () => client.markTaskCompleted("task-1", contextFor())],
    ["CANCELLED", () => client.markTaskCancelled("task-1", contextFor())]
  ];
  for (const [status, edit] of cases) {
    await edit();
    const edited = cardOf(updated.at(-1));
    client.setTaskLookup(async () => taskAt(status));
    const refreshed = await client.handleRefreshCard("task-1", "aad-viewer");
    assert.deepEqual(refreshed.body, edited.body, `${status}: the refresh renders what the edit rendered`);
  }
});

await check("a refresh of a cancelled task nobody claimed reads the same", async () => {
  const { client } = await botSetup();
  await postOpenTask(client);
  client.setTaskLookup(async () => taskAt("CANCELLED", { assignee: undefined }));
  const card = await client.handleRefreshCard("task-1", "aad-viewer");
  assert.equal(headline(card), "🚫 Dana cancelled their LOI Check");
  assert.equal(nameLine(card), "Smith-1042 - LOI Check");
});

await check("a card-tap claim renders the same body as a web claim", async () => {
  const { client, updated } = await botSetup();
  await postOpenTask(client);

  client.setClaimHandler(
    async () => CHECKER,
    async () => taskAt("CLAIMED")
  );
  const outcome = await client.handleClaim("task-1", CHECKER.id, CHECKER.displayName);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.message, "Casey grabbed Dana's LOI Check");

  // The web claim's edit, for comparison.
  await client.markTaskClaimed("task-1", outcome.message, contextFor());
  const webCard = cardOf(updated.at(-1));

  // What the tapper's own client is refreshed to.
  const response = await client.bot.onInvokeActivity({
    activity: {
      type: "invoke",
      name: "adaptiveCard/action",
      conversation: { id: "19:channel-1@thread.tacv2", conversationType: "channel" },
      from: { id: "29:casey", aadObjectId: CHECKER.id, name: CHECKER.displayName },
      recipient: { id: "29:bot" },
      serviceUrl: "https://example.invalid",
      value: { action: { verb: "claimTask", data: { taskId: "task-1" } } }
    }
  });
  assert.deepEqual(response.body.value.body, webCard.body, "one claim, one card body");
});

const postBornAssigned = async (client) => {
  await client.postTaskCard(
    "task-1",
    "Dana needs an LOI checked",
    "Smith-1042 - LOI Check\nHow Bad: —\nUrgency: Today",
    undefined,
    "Dana needs an LOI checked",
    CREATOR.id,
    { ...contextFor(), assigneeId: CHECKER.id }
  );
};

await check("a task born assigned says it was assigned, not grabbed", async () => {
  const { client, posted } = await botSetup();
  await postBornAssigned(client);

  const card = cardOf(posted[0]);
  assert.equal(headline(card), "Casey was assigned Dana's LOI Check");
  assert.equal(nameLine(card), "Smith-1042 - LOI Check");
  assert.deepEqual(actionTitles(card), [], "no Claim button to appear and then vanish");
});

await check("a refresh does not turn a task born assigned into a claim", async () => {
  const { client, posted } = await botSetup();
  await postBornAssigned(client);

  // Nothing on the task says it was never claimed — the assignee looks the
  // same either way — so the refresh leans on what the post recorded.
  client.setTaskLookup(async () => taskAt("CLAIMED"));
  const card = await client.handleRefreshCard("task-1", "aad-viewer");
  assert.equal(headline(card), "Casey was assigned Dana's LOI Check");
  assert.equal(nameLine(card), "Smith-1042 - LOI Check");
  assert.deepEqual(card.body, cardOf(posted[0]).body, "the refresh renders what the post rendered");

  // Once it changes hands somebody really did claim it, and the card says so.
  const other = { id: "aad-other", displayName: "Robin Checker" };
  client.setTaskLookup(async () => taskAt("CLAIMED", { assignee: other }));
  const reclaimed = await client.handleRefreshCard("task-1", "aad-viewer");
  assert.equal(headline(reclaimed), "Robin grabbed Dana's LOI Check");
  assert.equal(nameLine(reclaimed), "Smith-1042 - LOI Check");
});

await check("handing off a posted task takes the Claim button off its card", async () => {
  const { client, posted, updated, notify } = await botSetup();
  await notify("CHANNEL", liveTask("OPEN", { assignee: undefined }), CREATOR);
  assert.ok(actionTitles(cardOf(posted.at(-1))).some((title) => /Claim/.test(title)), "the posted card offers Claim");

  // A handoff is a silent edit of the card already there, never a new post.
  await notify("CHANNEL_ASSIGNED", liveTask("CLAIMED"), CREATOR);
  assert.equal(posted.length, 1, "nothing new in the channel");
  const card = cardOf(updated.at(-1));
  assert.equal(headline(card), "Casey was assigned Dana's LOI Check", "nobody grabbed it, and the card doesn't say they did");
  assert.equal(nameLine(card), "Smith-1042 - LOI Check");
  assert.ok(!actionTitles(card).some((title) => /Claim/.test(title)), "and nobody can claim it from the card any more");

  // A later Teams refresh keeps saying so, rather than reverting to "grabbed".
  client.setTaskLookup(async () => taskAt("CLAIMED"));
  const refreshed = await client.handleRefreshCard("task-1", "aad-viewer");
  assert.deepEqual(refreshed.body, card.body, "the refresh renders what the edit rendered");
});

await check("reassigning an in-flight task names the new holder on the card", async () => {
  const { updated, notify } = await botSetup();
  await notify("CHANNEL", liveTask("OPEN", { assignee: undefined }), CREATOR);
  await notify("CHANNEL_CLAIMED", liveTask("CLAIMED"), CHECKER);

  const robin = { id: "aad-robin", displayName: "Robin Checker" };
  await notify("CHANNEL_ASSIGNED", liveTask("CLAIMED", { assignee: robin }), CREATOR);
  assert.equal(headline(cardOf(updated.at(-1))), "Robin was assigned Dana's LOI Check");
});

await check("the startup repair fixes a card a handoff left offering Claim, once", async () => {
  const { client, updated, notify } = await botSetup();
  // Posted as claimable, then handed off before the handoff edited the card.
  await notify("CHANNEL", liveTask("OPEN", { assignee: undefined }), CREATOR);
  client.setTaskLookup(async () => liveTask("CLAIMED"));

  const first = await client.repairHandedOffCards(async () => true);
  assert.equal(first.repaired, 1);
  const card = cardOf(updated.at(-1));
  assert.equal(headline(card), "Casey was assigned Dana's LOI Check");
  assert.ok(!actionTitles(card).some((title) => /Claim/.test(title)), "the Claim button is gone");

  // Every boot runs it; a card already repaired is left alone.
  const edits = updated.length;
  const second = await client.repairHandedOffCards(async () => true);
  assert.equal(second.repaired, 0, "nothing left to repair");
  assert.equal(updated.length, edits, "and nothing is edited again");
});

await check("the startup repair leaves claimed, open and closed tasks alone", async () => {
  const { client, updated, notify } = await botSetup();
  await notify("CHANNEL", liveTask("OPEN", { assignee: undefined }), CREATOR);

  // Somebody grabbed it: the claim already edited the card.
  client.setTaskLookup(async () => liveTask("CLAIMED"));
  assert.equal((await client.repairHandedOffCards(async () => false)).repaired, 0);

  // Still in the pool, or finished: history is never even asked.
  const asked = [];
  for (const task of [liveTask("OPEN", { assignee: undefined }), liveTask("COMPLETED"), liveTask("CANCELLED")]) {
    client.setTaskLookup(async () => task);
    const result = await client.repairHandedOffCards(async (t) => {
      asked.push(t.status);
      return true;
    });
    assert.equal(result.repaired, 0, `${task.status} is not repaired`);
  }
  assert.deepEqual(asked, [], "only a task somebody holds is looked into");
  assert.equal(updated.length, 0, "no card was touched");
});

console.log(`\n${passed} checks passed`);
