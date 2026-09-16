#!/usr/bin/env node
/*
 * What Teams says when the bot puts a new card in the channel (#447).
 *
 * The toast used to read "Hot Task posted a new message", which tells a reader
 * nothing until they open the channel. Two things fix that, and both are
 * asserted here over a real TeamsBotClient with the connector stubbed:
 *
 *   1. Every post that creates a channel thread carries the Teams alert flag,
 *      so the notification is raised from the activity's summary rather than
 *      the generic "posted a new message" line. Five paths create threads —
 *      new task, pool nag, re-open, released Fraud Check, announcement — and
 *      they all go through the same primitive, so none of them can drift.
 *   2. A new task's summary names the creator, what they need, and the How Bad
 *      poops: "Dana needs an LOI checked 💩💩".
 *
 * The in-place card edits (claimed / completed / cancelled) are the quiet
 * half: they edit a card that is already there, and they must not alert.
 *
 * Built like channel-card-facts-sim-test.mjs, and running against the compiled
 * dist.
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

const CREATOR = { id: "aad-creator", displayName: "Dana Requester" };
const CHECKER = { id: "aad-checker", displayName: "Casey Checker" };

const alerts = (entry) => entry.activity.channelData?.notification?.alert;

const liveTask = (over = {}) => ({
  id: "task-1",
  folderName: "Smith-1042",
  taskType: "LOI",
  status: "OPEN",
  createdBy: CREATOR,
  assignee: undefined,
  dueAt: "2026-08-14T20:00:00.000Z",
  urgency: "GREEN",
  points: 2,
  notes: "",
  createdAt: "2026-08-14T16:00:00.000Z",
  updatedAt: "2026-08-14T16:00:00.000Z",
  reviewNotes: [],
  ...over
});

const botSetup = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "channel-notification-preview-sim-"));
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
  const notify = (target, task, actor, message = "") =>
    notifier.notify({ type: "TASK_STATUS_CHANGED", task, actor, message, target, createdAt: new Date().toISOString() });
  return { client, posted, updated, notify };
};

console.log("Channel notification preview sim");

await check("a new task's notification names who needs what, with the How Bad poops", async () => {
  const { posted, notify } = await botSetup();
  await notify("CHANNEL", liveTask(), CREATOR);

  assert.equal(posted.at(-1).activity.summary, "Dana needs an LOI checked 💩💩");
  assert.equal(alerts(posted.at(-1)), true, "the post has to alert, or Teams raises nothing to preview");
});

await check("a task nobody rated shows no poops and no placeholder", async () => {
  const { posted, notify } = await botSetup();
  await notify("CHANNEL", liveTask({ points: 0 }), CREATOR);

  assert.equal(posted.at(-1).activity.summary, "Dana needs an LOI checked");
});

await check("the card body still reads as it did — the poops live on the How Bad line, not the headline", async () => {
  const { posted, notify } = await botSetup();
  await notify("CHANNEL", liveTask(), CREATOR);

  const card = posted.at(-1).activity.attachments[0].content;
  assert.equal(card.body[0].text, "Dana needs an LOI checked");
  assert.equal(card.body[1].text, "Smith-1042 - LOI Check\nHow Bad: 💩💩\nUrgency: Within 24 Hours");
});

await check("an OOO post keeps its own wording and gains no poops", async () => {
  const { posted, notify } = await botSetup();
  await notify(
    "CHANNEL",
    liveTask({ taskType: "OOO", folderName: "Out Thursday", startDate: "2026-08-20T12:00:00.000Z", returnDate: "2026-08-22T12:00:00.000Z" }),
    CREATOR
  );

  const summary = posted.at(-1).activity.summary;
  assert.ok(summary && !summary.includes("💩"), `OOO coverage is not urgency: ${summary}`);
  assert.equal(alerts(posted.at(-1)), true);
});

await check("the pool nag alerts, and previews the nag rather than 'posted a new message'", async () => {
  const { posted, notify } = await botSetup();
  await notify("CHANNEL", liveTask(), CREATOR);
  await notify("CHANNEL_NAG", liveTask(), CREATOR, "Smith-1042 is still up for grabs");

  assert.equal(posted.at(-1).activity.summary, "Smith-1042 is still up for grabs");
  assert.equal(alerts(posted.at(-1)), true);
});

await check("a re-opened task alerts, and previews the headline it already had", async () => {
  const { posted, notify } = await botSetup();
  await notify("CHANNEL", liveTask(), CREATOR);
  await notify("CHANNEL_REOPENED", liveTask(), CREATOR);

  assert.equal(posted.at(-1).activity.summary, "Dana needs an LOI checked");
  assert.equal(alerts(posted.at(-1)), true);
});

await check("a released Fraud Check alerts, and previews that it needs a new checker", async () => {
  const { client, posted } = await botSetup();
  await client.repostReopenedTask("task-1", {
    title: "Smith-1042 needs a new file checker",
    detail: "Smith-1042 - Fraud Check\nHow Bad: 💩💩",
    folder: "Smith-1042"
  });

  assert.equal(posted.at(-1).activity.summary, "Smith-1042 needs a new file checker");
  assert.equal(alerts(posted.at(-1)), true);
});

await check("an announcement post alerts, and previews its title", async () => {
  const { client, posted } = await botSetup();
  await client.sendToChannels("Hot Task is back up", "The API restarted at 4pm.");

  assert.equal(posted.at(-1).activity.summary, "Hot Task is back up");
  assert.equal(alerts(posted.at(-1)), true);
});

await check("a claim edits the card in place and alerts nobody", async () => {
  const { posted, updated, notify } = await botSetup();
  await notify("CHANNEL", liveTask(), CREATOR);
  const postsBefore = posted.length;
  await notify("CHANNEL_CLAIMED", liveTask({ status: "CLAIMED", assignee: CHECKER }), CHECKER);

  assert.equal(posted.length, postsBefore, "a claim posts nothing new");
  assert.ok(updated.length > 0, "a claim edits the existing card");
  for (const edit of updated) {
    assert.notEqual(edit.activity.channelData?.notification?.alert, true, "an in-place edit must not alert the channel");
  }
});

console.log(`\n${passed} checks passed`);
