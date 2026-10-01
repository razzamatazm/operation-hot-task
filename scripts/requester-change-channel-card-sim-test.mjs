#!/usr/bin/env node
/*
 * Changing a task's owner edits its channel card (#512): the new owner named,
 * a note saying who changed it from whom, and the owner-only Cancel view moved
 * to the new owner. Over a real TeamsBotClient with the connector stubbed,
 * driven through the notification layer, against the compiled dist.
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

const DANA = { id: "aad-dana", displayName: "Dana Requester" };
const RILEY = { id: "aad-riley", displayName: "Riley Newbie" };
const PAT = { id: "aad-pat", displayName: "Pat Bystander" };
const CASEY = { id: "aad-casey", displayName: "Casey Checker" };
const AVERY = { id: "aad-avery", displayName: "Avery Admin" };

const NOTE = "Avery changed the owner from Dana to Riley";

const cardOf = (entry) => entry.activity.attachments[0].content;
const headline = (card) => card.body?.[0]?.text;
const texts = (card) => (card.body ?? []).map((block) => block.text);
const actionTitles = (card) => (card.actions ?? []).map((action) => action.title);

const liveTask = (status, over = {}) => ({
  id: "task-1",
  folderName: "Smith-1042",
  taskType: "LOI",
  status,
  createdBy: DANA,
  dueAt: "2026-08-14T20:00:00.000Z",
  urgency: "GREEN",
  points: 2,
  notes: "",
  createdAt: "2026-08-14T16:00:00.000Z",
  updatedAt: "2026-08-14T16:00:00.000Z",
  reviewNotes: [],
  ...over
});

/* The task as it stands once Avery has made Riley its owner. */
const handedOver = (status, over = {}) =>
  liveTask(status, { createdBy: RILEY, requesterChange: { by: AVERY.displayName, from: DANA.displayName, to: RILEY.displayName }, ...over });

const setup = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "requester-change-card-sim-"));
  const dataFile = path.join(dir, "bot-references.json");
  const reference = {
    serviceUrl: "https://example.invalid",
    conversation: { id: "19:channel-1@thread.tacv2", conversationType: "channel" },
    user: { id: "29:bot" }
  };
  // Both owners have chatted with the bot, so both have Teams ids on record.
  const dm = (user, teamsId) => ({
    key: `dm:${teamsId}`,
    reference: { ...reference, conversation: { id: `a:dm-${teamsId}`, conversationType: "personal" } },
    scope: "DM",
    userAadObjectId: user.id,
    userId: teamsId
  });
  await fs.writeFile(
    dataFile,
    JSON.stringify([{ key: "channel:19:channel-1@thread.tacv2", reference, scope: "CHANNEL" }, dm(DANA, "29:dana"), dm(RILEY, "29:riley")]),
    "utf8"
  );

  const client = new TeamsBotClient("app-id", "app-password", undefined, dataFile);
  await client.init();

  const posted = [];
  const updated = [];
  const replies = [];
  let nextId = 0;
  // Teams refusing new threads, so a release repost falls back to an in-place edit (#516).
  const threads = { failing: false };
  client.adapter.createConnectorClient = () => ({
    conversations: {
      createConversation: async (params) => {
        if (threads.failing) {
          throw new Error("Teams refused the new thread");
        }
        nextId += 1;
        posted.push({ params, activity: params.activity });
        return { id: `19:thread-${nextId}`, activityId: `activity-${nextId}` };
      },
      updateActivity: async (conversationId, activityId, activity) => {
        updated.push({ conversationId, activityId, activity });
        return { id: activityId };
      },
      sendToConversation: async (conversationId, activity) => {
        replies.push({ conversationId, activity });
        return { id: "activity-reply" };
      },
      deleteActivity: async () => {},
      getConversationMembers: async () => []
    }
  });
  let live;
  client.setTaskLookup(async () => live);
  const notifier = new TeamsNotificationProvider(
    client,
    { isEnabled: () => false, sendToUsers: async () => {} },
    { getNotificationChannelId: async () => "channel-1" },
    async () => undefined
  );
  const notify = async (target, task, actor, message = "") => {
    live = task;
    await notifier.notify({ type: "TASK_STATUS_CHANGED", task, actor, message, target, createdAt: new Date().toISOString() });
  };
  return { client, posted, updated, replies, notify, threads };
};

console.log("Owner change channel card sim (#512)");

await check("an open task's card is edited in place to name the new owner, with the change note", async () => {
  const { posted, updated, replies, notify } = await setup();
  await notify("CHANNEL", liveTask("OPEN"), DANA);
  assert.equal(headline(cardOf(posted[0])), "Dana needs an LOI checked");

  await notify("CHANNEL_REQUESTER_CHANGED", handedOver("OPEN"), AVERY);
  assert.equal(posted.length, 1, "no new post");
  assert.equal(replies.length, 0, "no thread reply");
  const card = cardOf(updated.at(-1));
  assert.equal(headline(card), "Riley needs an LOI checked");
  assert.ok(texts(card).includes(NOTE), `the note is on the card: ${JSON.stringify(texts(card))}`);
  assert.ok(actionTitles(card).some((title) => /Claim/.test(title)), "the posted card is still the claimable one");
});

await check("on an open task the Cancel view moves from the old owner to the new one", async () => {
  const { client, posted, updated, notify } = await setup();
  await notify("CHANNEL", liveTask("OPEN"), DANA);
  assert.deepEqual(cardOf(posted[0]).refresh.userIds, ["29:dana"]);

  await notify("CHANNEL_REQUESTER_CHANGED", handedOver("OPEN"), AVERY);
  assert.deepEqual(cardOf(updated.at(-1)).refresh.userIds, ["29:riley"], "only the new owner is fetched a personal view");

  const riley = await client.handleRefreshCard("task-1", RILEY.id);
  assert.ok(actionTitles(riley).includes("Cancel Task"), "the new owner can cancel");
  assert.ok(texts(riley).includes(NOTE));
  assert.equal(headline(riley), "Riley needs an LOI checked");

  const dana = await client.handleRefreshCard("task-1", DANA.id);
  assert.ok(!actionTitles(dana).includes("Cancel Task"), "the old owner can't");
  assert.ok(actionTitles(dana).some((title) => /Claim/.test(title)), "the old owner gets the Claim view");
  assert.ok(texts(dana).includes(NOTE));
});

await check("a claimed task's card names the new owner and carries the note, still claimed", async () => {
  const { posted, updated, replies, notify } = await setup();
  await notify("CHANNEL", liveTask("OPEN"), DANA);
  await notify("CHANNEL_CLAIMED", liveTask("CLAIMED", { assignee: CASEY }), CASEY);

  await notify("CHANNEL_REQUESTER_CHANGED", handedOver("CLAIMED", { assignee: CASEY }), AVERY);
  assert.equal(posted.length, 1);
  assert.equal(replies.length, 0);
  const card = cardOf(updated.at(-1));
  assert.equal(headline(card), "Casey grabbed Riley's LOI Check");
  assert.deepEqual(texts(card), ["Casey grabbed Riley's LOI Check", "Smith-1042 - LOI Check", NOTE]);
  assert.ok(!actionTitles(card).some((title) => /Claim/.test(title)));
});

await check("every later edit, repost, nag and refresh keeps the new owner and the note", async () => {
  const { client, posted, updated, notify } = await setup();
  await notify("CHANNEL", liveTask("OPEN"), DANA);
  await notify("CHANNEL_REQUESTER_CHANGED", handedOver("OPEN"), AVERY);

  await notify("CHANNEL_NAG", handedOver("OPEN"), AVERY, "Nobody's taken Riley's LOI Check on Smith-1042 after 30 minutes, who's got it?");
  const nag = cardOf(posted.at(-1));
  assert.ok(texts(nag).includes(NOTE), "the pool nag");
  assert.deepEqual(nag.refresh.userIds, ["29:riley"]);

  await notify("CHANNEL_CLAIMED", handedOver("CLAIMED", { assignee: CASEY }), CASEY);
  assert.deepEqual(texts(cardOf(updated.at(-1))), ["Casey grabbed Riley's LOI Check", "Smith-1042 - LOI Check", NOTE], "the claim");
  const refreshed = await client.handleRefreshCard("task-1", PAT.id);
  assert.deepEqual(refreshed.body, cardOf(updated.at(-1)).body, "a refresh of the claimed card");

  await notify("CHANNEL_REOPENED", handedOver("OPEN"), CASEY);
  const reposted = cardOf(posted.at(-1));
  assert.equal(headline(reposted), "Riley needs an LOI checked", "the reopen repost");
  assert.ok(texts(reposted).includes(NOTE));
  assert.deepEqual(reposted.refresh.userIds, ["29:riley"]);

  await notify("CHANNEL_RELEASED", handedOver("AWAITING_ITEMS", { taskType: "FRAUD" }), CASEY);
  assert.ok(texts(cardOf(posted.at(-1))).includes(NOTE), "the release repost");

  await notify("CHANNEL_COMPLETED", handedOver("COMPLETED", { assignee: CASEY }), CASEY);
  assert.deepEqual(texts(cardOf(updated.at(-1))), ["✅ Casey completed Riley's LOI Check", "Smith-1042 - LOI Check", NOTE], "completion");

  await notify("CHANNEL_CANCELLED", handedOver("CANCELLED"), RILEY);
  assert.deepEqual(texts(cardOf(updated.at(-1))), ["🚫 Riley cancelled their LOI Check", "Smith-1042 - LOI Check", NOTE], "cancellation");
  const cancelled = await client.handleRefreshCard("task-1", RILEY.id);
  assert.deepEqual(cancelled.body, cardOf(updated.at(-1)).body, "a refresh of the cancelled card");
});

await check("two owner changes in a row show only the latest", async () => {
  const { updated, notify } = await setup();
  await notify("CHANNEL", liveTask("OPEN"), DANA);
  await notify("CHANNEL_REQUESTER_CHANGED", handedOver("OPEN"), AVERY);
  const second = liveTask("OPEN", {
    createdBy: PAT,
    requesterChange: { by: RILEY.displayName, from: RILEY.displayName, to: PAT.displayName }
  });
  await notify("CHANNEL_REQUESTER_CHANGED", second, RILEY);
  const card = cardOf(updated.at(-1));
  assert.equal(headline(card), "Pat needs an LOI checked");
  assert.ok(texts(card).includes("Riley changed the owner from Riley to Pat"));
  assert.ok(!texts(card).includes(NOTE), "the earlier change is gone");
  assert.equal(card.refresh, undefined, "Pat has never messaged the bot, and Riley's view is withdrawn");
});

await check("a task with no channel post is left alone", async () => {
  const { posted, updated, replies, notify } = await setup();
  await notify("CHANNEL_REQUESTER_CHANGED", handedOver("CLAIMED", { assignee: CASEY }), AVERY);
  assert.equal(posted.length + updated.length + replies.length, 0);
});

await check("a card first recorded by a pool nag still takes the new owner's headline", async () => {
  const { updated, notify } = await setup();
  await notify("CHANNEL_NAG", liveTask("OPEN"), DANA, "Nobody's taken Dana's LOI Check on Smith-1042 after 30 minutes, who's got it?");
  await notify("CHANNEL_REQUESTER_CHANGED", handedOver("OPEN"), AVERY);
  assert.equal(headline(cardOf(updated.at(-1))), "Riley needs an LOI checked");
});

for (const status of ["CLAIMED", "AWAITING_ITEMS", "PENDING_APPROVAL"]) {
  await check(`a released Fraud Check (${status}, nobody holding it) stays a claimable released card`, async () => {
    const { client, updated, notify } = await setup();
    await notify("CHANNEL", liveTask("OPEN", { taskType: "FRAUD" }), DANA);
    // Released: the status is untouched and nobody holds it.
    await notify("CHANNEL_RELEASED", liveTask(status, { taskType: "FRAUD" }), CASEY);
    await notify("CHANNEL_REQUESTER_CHANGED", handedOver(status, { taskType: "FRAUD" }), AVERY);
    const card = cardOf(updated.at(-1));
    assert.equal(headline(card), "Smith-1042 needs a new file checker");
    assert.ok(texts(card).includes(NOTE));
    assert.ok(actionTitles(card).some((title) => /Claim/.test(title)), "still claimable");
    assert.deepEqual(card.refresh.userIds, ["29:riley"]);

    const riley = await client.handleRefreshCard("task-1", RILEY.id);
    assert.equal(headline(riley), "Smith-1042 needs a new file checker");
    assert.ok(actionTitles(riley).includes("Cancel Task"), "the new requester gets the Cancel view");
    const dana = await client.handleRefreshCard("task-1", DANA.id);
    assert.ok(actionTitles(dana).some((title) => /Claim/.test(title)), "the old requester gets Claim");
    assert.ok(texts(dana).includes(NOTE));
  });
}

/* #516: the released headline is read from the live task, so it survives a
   release whose fresh thread couldn't be posted, and a loan rename. */
await check("a released Fraud Check whose repost fell back keeps its released headline through an owner change", async () => {
  const { client, posted, updated, notify, threads } = await setup();
  await notify("CHANNEL", liveTask("OPEN", { taskType: "FRAUD" }), DANA);
  await notify("CHANNEL_CLAIMED", liveTask("CLAIMED", { taskType: "FRAUD", assignee: CASEY }), CASEY);
  threads.failing = true;
  await notify("CHANNEL_RELEASED", liveTask("AWAITING_ITEMS", { taskType: "FRAUD" }), CASEY);
  assert.equal(posted.length, 1, "no fresh thread");
  assert.equal(headline(cardOf(updated.at(-1))), "Smith-1042 needs a new file checker", "the fallback edit");
  const refreshed = await client.handleRefreshCard("task-1", PAT.id);
  assert.equal(headline(refreshed), "Smith-1042 needs a new file checker", "the recorded card matches the fallback edit");

  await notify("CHANNEL_REQUESTER_CHANGED", handedOver("AWAITING_ITEMS", { taskType: "FRAUD" }), AVERY);
  const card = cardOf(updated.at(-1));
  assert.equal(headline(card), "Smith-1042 needs a new file checker");
  assert.ok(texts(card).includes(NOTE));
  assert.ok(actionTitles(card).some((title) => /Claim/.test(title)), "still claimable");
});

const rename = async (notify, task) =>
  notify("CARD_CORRECTION", task, { id: "system", displayName: "Hot Task" });

await check("a released Fraud Check renamed afterwards reads the new name in its released headline", async () => {
  const { updated, notify } = await setup();
  await notify("CHANNEL", liveTask("OPEN", { taskType: "FRAUD" }), DANA);
  await notify("CHANNEL_RELEASED", liveTask("CLAIMED", { taskType: "FRAUD" }), CASEY);
  await rename(notify, liveTask("CLAIMED", { taskType: "FRAUD", folderName: "Smith-2000" }));
  const card = cardOf(updated.at(-1));
  assert.equal(headline(card), "Smith-2000 needs a new file checker");
  assert.match(texts(card)[1], /^Smith-2000 - Fraud Check\nPicks up at: the initial pass/);

  await notify("CHANNEL_REQUESTER_CHANGED", handedOver("CLAIMED", { taskType: "FRAUD", folderName: "Smith-2000" }), AVERY);
  assert.equal(headline(cardOf(updated.at(-1))), "Smith-2000 needs a new file checker", "an owner change after the rename");
});

await check("a rename leaves an unreleased task's headline as it was", async () => {
  const { updated, notify } = await setup();
  await notify("CHANNEL", liveTask("OPEN", { taskType: "FRAUD" }), DANA);
  await rename(notify, liveTask("OPEN", { taskType: "FRAUD", folderName: "Smith-2000" }));
  assert.equal(headline(cardOf(updated.at(-1))), "Dana needs a Fraud Check");
});

await check("a claimed Fraud Check keeps its claimed headline through a rename and an owner change", async () => {
  const { updated, notify } = await setup();
  await notify("CHANNEL", liveTask("OPEN", { taskType: "FRAUD" }), DANA);
  await notify("CHANNEL_CLAIMED", liveTask("CLAIMED", { taskType: "FRAUD", assignee: CASEY }), CASEY);
  await rename(notify, liveTask("CLAIMED", { taskType: "FRAUD", assignee: CASEY, folderName: "Smith-2000" }));
  assert.equal(headline(cardOf(updated.at(-1))), "Casey grabbed Dana's Fraud Check", "the rename");
  await notify("CHANNEL_REQUESTER_CHANGED", handedOver("CLAIMED", { taskType: "FRAUD", assignee: CASEY, folderName: "Smith-2000" }), AVERY);
  assert.equal(headline(cardOf(updated.at(-1))), "Casey grabbed Riley's Fraud Check", "the owner change");
});

await check("a rename leaves a non-Fraud task's headline as it was", async () => {
  const { updated, notify } = await setup();
  await notify("CHANNEL", liveTask("OPEN"), DANA);
  await rename(notify, liveTask("OPEN", { folderName: "Smith-2000" }));
  assert.equal(headline(cardOf(updated.at(-1))), "Dana needs an LOI checked");
});

console.log(`\n${passed} passed`);
