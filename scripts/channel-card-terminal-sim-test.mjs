#!/usr/bin/env node
/*
 * The channel card drops "Open in Hot Task" the moment a task goes terminal.
 *
 * The root channel card is edited in place through a task's whole life, and
 * every live state spreads the recorded deep link into its actions — claimable,
 * the creator's cancel view, and claimed. The terminal cards did not: the
 * `✅ Completed` and `🚫 Cancelled` builders rendered a body and no actions at
 * all, so the card stopped being clickable at exactly the point it became the
 * permanent record of the work (#178). Archived reuses the completed builder
 * and inherited the same gap.
 *
 * What's asserted here, over a real TeamsBotClient with the connector stubbed:
 *   1. Completion / cancellation edit the posted card to a terminal state that
 *      carries the link and nothing else — no Claim, no Cancel Task.
 *   2. With no link recorded (the real local/test case: the deep-link builder
 *      returns undefined when TEAMS_APP_ID is unset) the card renders with no
 *      `actions` key at all, exactly as it did before.
 *   3. The user-specific refresh path returns the same cards as the direct
 *      edit, so a manual refresh neither resurrects nor strips the link.
 *
 * The channel counterpart of dm-card-sync-sim-test.mjs, and built the same way:
 * post a card first so a thread with a recorded URL exists, drive the
 * transition, then assert on what got updated. Runs against the compiled dist.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TeamsBotClient } from "../apps/server/dist/bot.js";

const OPEN_URL = "https://teams.microsoft.com/l/entity/app-id/tab?context=%7B%22subEntityId%22%3A%22task-1%22%7D";

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

const actionTitles = (card) => (card.actions ?? []).map((action) => action.title);
const headline = (card) => card.body?.[0]?.text;
const cardOf = (entry) => entry.activity.attachments[0].content;

/* A TeamsBotClient wired to a single captured CHANNEL reference, with the Bot
   Framework connector stubbed so posts and in-place edits are both captured.
   New top-level channel posts go through createConversation, edits through
   updateActivity — the same split the real client makes. */
const botSetup = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "channel-card-terminal-sim-"));
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

const postOpenTask = async (client, openUrl) => {
  await client.postTaskCard("task-1", "Smith-1042 needs an LOI check", "Type: LOI Check\nDue: Aug 14", openUrl);
};

/* The facts the terminal builders are handed (#193). What they say is
   channel-card-facts-sim-test.mjs's business; here they're just the argument
   the link assertions need. */
const CONTEXT = { taskType: "LOI", folderName: "Smith-1042", createdBy: "Dana Requester", assignee: "Casey Checker" };

console.log("Channel terminal card sim");

await check("a completed task's card keeps the deep link and drops Claim", async () => {
  const { client, posted, updated } = await botSetup();
  await postOpenTask(client, OPEN_URL);
  assert.deepEqual(actionTitles(cardOf(posted[0])), ["Claim", "Open in Hot Task"]);

  await client.markTaskCompleted("task-1", CONTEXT);

  // The bug in one assertion: the terminal card is still clickable.
  assert.deepEqual(actionTitles(cardOf(updated.at(-1))), ["Open in Hot Task"]);
  assert.equal(cardOf(updated.at(-1)).actions[0].url, OPEN_URL, "the same URL the card carried while open");
  assert.equal(headline(cardOf(updated.at(-1))), "✅ Completed — Smith-1042");
  assert.equal(cardOf(updated.at(-1)).body[1].text, "LOI Check · Smith-1042 · asked by Dana Requester · done by Casey Checker");
});

await check("completion edits the posted message in place — no second post", async () => {
  const { client, posted, updated } = await botSetup();
  await postOpenTask(client, OPEN_URL);
  await client.markTaskCompleted("task-1", CONTEXT);

  assert.equal(posted.length, 1, "completion must not put a new card in the channel");
  assert.equal(updated.length, 1);
  assert.equal(updated[0].activityId, "activity-1", "the recorded activity id is the one edited");
});

await check("a cancelled task's card keeps the link and drops Cancel Task", async () => {
  const { client, updated } = await botSetup();
  await postOpenTask(client, OPEN_URL);
  await client.markTaskCancelled("task-1", CONTEXT);

  assert.deepEqual(actionTitles(cardOf(updated.at(-1))), ["Open in Hot Task"]);
  assert.equal(headline(cardOf(updated.at(-1))), "🚫 Cancelled — Smith-1042");
});

await check("with no link recorded the terminal cards carry no actions key at all", async () => {
  const { client, updated } = await botSetup();
  await postOpenTask(client, undefined);

  await client.markTaskCompleted("task-1", CONTEXT);
  // Not an empty array — TEAMS_APP_ID is unset in local and test environments,
  // so this is the deployed-today rendering and it must not change.
  assert.equal("actions" in cardOf(updated.at(-1)), false);

  await client.markTaskCancelled("task-1", CONTEXT);
  assert.equal("actions" in cardOf(updated.at(-1)), false);
});

const taskAt = (status) => ({
  id: "task-1",
  folderName: "Smith-1042",
  taskType: "LOI",
  status,
  createdBy: { id: "aad-creator", displayName: "Dana Requester" },
  assignee: { id: "aad-checker", displayName: "Casey Checker" }
});

await check("the refresh path returns the same terminal cards as the direct edit", async () => {
  const { client } = await botSetup();
  await postOpenTask(client, OPEN_URL);

  for (const [status, banner] of [
    ["COMPLETED", "✅ Completed — Smith-1042"],
    ["ARCHIVED", "✅ Completed — Smith-1042"],
    ["CANCELLED", "🚫 Cancelled — Smith-1042"]
  ]) {
    client.setTaskLookup(async () => taskAt(status));
    const card = await client.handleRefreshCard("task-1", "aad-viewer");
    assert.deepEqual(actionTitles(card), ["Open in Hot Task"], `${status} refresh keeps the link`);
    assert.equal(card.actions[0].url, OPEN_URL);
    assert.equal(headline(card), banner);
  }
});

await check("a refresh with no recorded link stays actionless", async () => {
  const { client } = await botSetup();
  await postOpenTask(client, undefined);
  client.setTaskLookup(async () => taskAt("COMPLETED"));
  const card = await client.handleRefreshCard("task-1", "aad-viewer");
  assert.equal("actions" in card, false);
});

console.log(`\n${passed} checks passed`);
