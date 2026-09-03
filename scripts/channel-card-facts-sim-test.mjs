#!/usr/bin/env node
/*
 * The channel card forgets who asked and what for (#193).
 *
 * The root channel card is edited in place for a task's whole life, and until
 * now every edit after creation rebuilt the body from the folder name alone.
 * The creator and the task type appear exactly once, in the creation
 * headline — so a claim overwrote both, and a completion card recorded that
 * something was done without saying what it was for or who wanted it.
 *
 * What's asserted here, over a real TeamsBotClient with the connector stubbed:
 *   1. The claimed / completed / cancelled cards each carry one headline and
 *      one context line naming the type (as its TASK_TYPE_LABELS label), the
 *      file, the assigner and the current holder. No detail block.
 *   2. The holder segment is omitted, not blanked, when there is no holder —
 *      a cancelled task nobody claimed.
 *   3. An OOO task carries no file name: its Folder Name is a Vacation
 *      Description and it has no Loan behind it.
 *   4. The user-specific refresh path renders the identical body, so an
 *      enriched card doesn't revert the first time Teams refreshes it.
 *   5. A card-tap claim and a web claim produce the same card body.
 *   6. A task born assigned reads "assigned to", not "claimed by" — nobody
 *      claimed that one — on the same context line as the rest.
 *
 * Sibling of channel-card-terminal-sim-test.mjs, built the same way and
 * running against the compiled dist.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TeamsBotClient } from "../apps/server/dist/bot.js";

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

const cardOf = (entry) => entry.activity.attachments[0].content;
const headline = (card) => card.body?.[0]?.text;
const contextLine = (card) => card.body?.[1]?.text;
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
      deleteActivity: async () => {}
    }
  });
  return { client, posted, updated };
};

const postOpenTask = async (client) => {
  await client.postTaskCard("task-1", "Dana Requester needs an LOI checked: Smith-1042", "How Bad: —\nUrgency: Today");
};

console.log("Channel card facts sim");

await check("the claimed card names the type, the file, the assigner and the claimer", async () => {
  const { client, updated } = await botSetup();
  await postOpenTask(client);
  await client.markTaskClaimed("task-1", "Casey Checker grabbed Smith-1042", contextFor());

  const card = cardOf(updated.at(-1));
  assert.equal(headline(card), "Casey Checker grabbed Smith-1042");
  assert.equal(contextLine(card), "LOI Check · Smith-1042 · asked by Dana Requester · claimed by Casey Checker");
  assert.equal(card.body.length, 2, "one headline plus one context line — no detail block");
});

await check("the completed card says who asked and who did it", async () => {
  const { client, updated } = await botSetup();
  await postOpenTask(client);
  await client.markTaskCompleted("task-1", contextFor());

  const card = cardOf(updated.at(-1));
  assert.equal(headline(card), "✅ Completed — Smith-1042");
  assert.equal(contextLine(card), "LOI Check · Smith-1042 · asked by Dana Requester · done by Casey Checker");
  assert.equal(card.body.length, 2);
});

await check("the cancelled card keeps the facts, and drops the holder when there was none", async () => {
  const { client, updated } = await botSetup();
  await postOpenTask(client);

  await client.markTaskCancelled("task-1", contextFor());
  assert.equal(contextLine(cardOf(updated.at(-1))), "LOI Check · Smith-1042 · asked by Dana Requester · claimed by Casey Checker");

  // Cancelled before anyone took it: the segment is absent, not empty.
  await client.markTaskCancelled("task-1", contextFor({ assignee: undefined }));
  const card = cardOf(updated.at(-1));
  assert.equal(headline(card), "🚫 Cancelled — Smith-1042");
  assert.equal(contextLine(card), "LOI Check · Smith-1042 · asked by Dana Requester");
  assert.equal(card.body.length, 2);
});

await check("an OOO task carries no file name on any of the three cards", async () => {
  const { client, updated } = await botSetup();
  await postOpenTask(client);
  const ooo = contextFor({ taskType: "OOO", folderName: "Cabo, back Monday" });

  await client.markTaskClaimed("task-1", "Casey Checker grabbed Cabo, back Monday", ooo);
  assert.equal(contextLine(cardOf(updated.at(-1))), "Out of Office · asked by Dana Requester · claimed by Casey Checker");

  await client.markTaskCompleted("task-1", ooo);
  assert.equal(contextLine(cardOf(updated.at(-1))), "Out of Office · asked by Dana Requester · done by Casey Checker");

  await client.markTaskCancelled("task-1", ooo);
  assert.equal(contextLine(cardOf(updated.at(-1))), "Out of Office · asked by Dana Requester · claimed by Casey Checker");
});

await check("a Teams refresh replays the enriched body rather than the folder-only form", async () => {
  const { client, updated } = await botSetup();
  await postOpenTask(client);

  // Drive the in-place edit, then ask the refresh path for the same task and
  // require the two bodies to match. This is the "stays in sync" criterion: the
  // refresh path rebuilds from the task, so a builder change that misses it
  // silently reverts the card.
  const cases = [
    ["CLAIMED", () => client.markTaskClaimed("task-1", "Casey Checker grabbed Smith-1042", contextFor())],
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

await check("a refresh of a cancelled task nobody claimed omits the holder too", async () => {
  const { client } = await botSetup();
  await postOpenTask(client);
  client.setTaskLookup(async () => taskAt("CANCELLED", { assignee: undefined }));
  const card = await client.handleRefreshCard("task-1", "aad-viewer");
  assert.equal(contextLine(card), "LOI Check · Smith-1042 · asked by Dana Requester");
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
    "Dana Requester needs an LOI checked: Smith-1042",
    "How Bad: —\nUrgency: Today",
    undefined,
    "Dana Requester needs an LOI checked",
    CREATOR.id,
    { ...contextFor(), assigneeId: CHECKER.id }
  );
};

await check("a task born assigned reads 'assigned to', not 'claimed by'", async () => {
  const { client, posted } = await botSetup();
  await postBornAssigned(client);

  const card = cardOf(posted[0]);
  assert.equal(headline(card), "Dana Requester needs an LOI checked: Smith-1042");
  assert.equal(contextLine(card), "LOI Check · Smith-1042 · asked by Dana Requester · assigned to Casey Checker");
  assert.deepEqual(actionTitles(card), [], "no Claim button to appear and then vanish");
});

await check("a refresh does not turn a task born assigned into a claim", async () => {
  const { client } = await botSetup();
  await postBornAssigned(client);

  // Nothing on the task says it was never claimed — the assignee looks the
  // same either way — so the refresh leans on what the post recorded.
  client.setTaskLookup(async () => taskAt("CLAIMED"));
  const card = await client.handleRefreshCard("task-1", "aad-viewer");
  assert.equal(headline(card), "Dana Requester needs an LOI checked: Smith-1042");
  assert.equal(contextLine(card), "LOI Check · Smith-1042 · asked by Dana Requester · assigned to Casey Checker");

  // Once it changes hands somebody really did claim it, and the card says so.
  const other = { id: "aad-other", displayName: "Robin Checker" };
  client.setTaskLookup(async () => taskAt("CLAIMED", { assignee: other }));
  const reclaimed = await client.handleRefreshCard("task-1", "aad-viewer");
  assert.equal(headline(reclaimed), "Robin Checker grabbed Smith-1042");
  assert.equal(contextLine(reclaimed), "LOI Check · Smith-1042 · asked by Dana Requester · claimed by Robin Checker");
});

console.log(`\n${passed} checks passed`);
