#!/usr/bin/env node
/*
 * The channel card's creator view leaves a trace (#440).
 *
 * A creator kept seeing Claim & Open on their own task instead of Cancel Task.
 * Production couldn't say why, because the step that fails sits between Teams
 * and the bot and nothing on that path wrote a line: whether Teams ever asked
 * for the creator's view, whether the viewer was recognised as the creator,
 * which card went back, and whether the creator's Teams id was ever found at
 * all were all invisible.
 *
 * What's asserted here, over a real TeamsBotClient with the connector stubbed:
 *   1. Every card invoke logs its verb, Teams' own trigger, and whether a
 *      viewer came with it.
 *   2. The creator's refresh logs that the creator card went back.
 *   3. Everyone else's refresh logs the claim card.
 *   4. The roster fallback says how many channels it asked, how many members
 *      came back, and whether one matched — so "asked and found nobody" and
 *      "never asked" stop looking identical.
 *   5. A refresh with nothing recorded to build from says so.
 *   6. No logged line carries a person's name or anything about a loan.
 *
 * Built like channel-card-facts-sim-test.mjs and running against the compiled
 * dist.
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

const CREATOR = { id: "aad-creator", displayName: "Dana Requester" };
const CHECKER = { id: "aad-checker", displayName: "Casey Checker" };

const openTask = (over = {}) => ({
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

/* The log is the thing under test, so it's collected rather than printed.
   Restored before the test's own output goes out. */
const captureLogs = async (fn) => {
  const original = console.log;
  const lines = [];
  console.log = (event, payload) => {
    lines.push({ event, payload });
  };
  let result;
  try {
    result = await fn();
  } finally {
    console.log = original;
  }
  return { lines, result };
};

const events = (lines, name) => lines.filter((line) => line.event === name).map((line) => JSON.parse(line.payload));

const botSetup = async ({ roster = [], rosterFails = false, dmRef = false } = {}) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "creator-card-log-sim-"));
  const dataFile = path.join(dir, "bot-references.json");
  const reference = {
    serviceUrl: "https://example.invalid",
    conversation: { id: "19:channel-1@thread.tacv2", conversationType: "channel" },
    user: { id: "29:bot" }
  };
  /* A creator who has chatted with the bot has their Teams id stored against
     their DM, which is the only way the posted card gets a refresh block at
     all. Without it the creator's version is never fetched in real Teams, so
     the cases that care about that version seed one. */
  const dmEntry = {
    key: "dm:29:creator",
    reference: { ...reference, conversation: { id: "19:dm-1", conversationType: "personal" } },
    scope: "DM",
    userAadObjectId: CREATOR.id,
    userId: "29:creator"
  };
  const entries = [{ key: "channel:19:channel-1@thread.tacv2", reference, scope: "CHANNEL" }, ...(dmRef ? [dmEntry] : [])];
  await fs.writeFile(dataFile, JSON.stringify(entries), "utf8");

  const client = new TeamsBotClient("app-id", "app-password", undefined, dataFile);
  await client.init();
  client.adapter.createConnectorClient = () => ({
    conversations: {
      createConversation: async () => ({ id: "19:thread-1", activityId: "activity-1" }),
      updateActivity: async () => ({ id: "activity-1" }),
      sendToConversation: async () => ({ id: "activity-reply" }),
      deleteActivity: async () => {},
      getConversationMembers: async () => {
        if (rosterFails) {
          throw new Error("Forbidden");
        }
        return roster;
      }
    }
  });
  client.setTaskLookup(async () => openTask());
  return client;
};

const postOpenTask = (client) =>
  client.postTaskCard(
    "task-1",
    "Dana needs an LOI checked",
    "Smith-1042 - LOI Check\nHow Bad: —\nUrgency: Today",
    undefined,
    "Dana needs an LOI checked",
    CREATOR.id
  );

/* Teams fetching a user-specific view: an automatic trigger, not a tap. */
const refreshAs = (client, user) =>
  client.bot.onInvokeActivity({
    activity: {
      type: "invoke",
      name: "adaptiveCard/action",
      conversation: { id: "19:channel-1@thread.tacv2", conversationType: "channel" },
      from: { id: "29:viewer", aadObjectId: user.id, name: user.displayName },
      recipient: { id: "29:bot" },
      serviceUrl: "https://example.invalid",
      value: { trigger: "automatic", action: { verb: "refreshTaskCard", data: { taskId: "task-1" } } }
    }
  });

const titleOf = (card) => (card.actions ?? []).map((action) => action.title);

console.log("Creator card log sim (#440)");

await check("every card invoke logs its verb, trigger and whether a viewer came with it", async () => {
  const client = await botSetup();
  await postOpenTask(client);
  const { lines } = await captureLogs(() => refreshAs(client, CREATOR));

  assert.deepEqual(events(lines, "bot_card_invoke"), [
    { verb: "refreshTaskCard", trigger: "automatic", taskId: "task-1", viewer: "present" }
  ]);
});

await check("the creator's refresh logs that the creator card went back", async () => {
  // With a stored DM id, which is the shape real Teams needs before it fetches
  // the creator's version at all.
  const client = await botSetup({ dmRef: true });
  await postOpenTask(client);
  const { lines, result } = await captureLogs(() => refreshAs(client, CREATOR));

  assert.deepEqual(events(lines, "bot_card_view"), [
    { taskId: "task-1", card: "creator", status: "OPEN", isCreator: true, creatorIds: 1, viewer: "present" }
  ]);
  assert.deepEqual(titleOf(result.body.value), ["Cancel Task"], "and the card really is the Cancel view");
});

await check("everyone else's refresh logs the claim card", async () => {
  const client = await botSetup();
  await postOpenTask(client);
  const { lines, result } = await captureLogs(() => refreshAs(client, CHECKER));

  const [view] = events(lines, "bot_card_view");
  assert.equal(view.card, "claim");
  assert.equal(view.isCreator, false);
  assert.deepEqual(titleOf(result.body.value), ["Claim"], "no deep link configured in test, so the bare Claim");
});

await check("the roster fallback says what it asked and what it found", async () => {
  const client = await botSetup({
    roster: [
      { id: "29:creator", aadObjectId: CREATOR.id },
      { id: "29:checker", aadObjectId: CHECKER.id }
    ]
  });
  const { lines } = await captureLogs(() => postOpenTask(client));

  assert.deepEqual(events(lines, "bot_roster_lookup"), [{ channels: 1, members: 2, matched: 1 }]);
  assert.deepEqual(events(lines, "bot_creator_ids"), [{ source: "roster", count: 1 }]);
});

await check("a roster that answers with nobody is not the same as never asking", async () => {
  const client = await botSetup();
  const { lines } = await captureLogs(() => postOpenTask(client));

  assert.deepEqual(events(lines, "bot_roster_lookup"), [{ channels: 1, members: 0, matched: 0 }]);
  assert.deepEqual(events(lines, "bot_creator_ids"), [{ source: "none", count: 0 }]);
});

await check("a refresh with nothing recorded to build from says so", async () => {
  const client = await botSetup();
  const { lines } = await captureLogs(() => refreshAs(client, CREATOR));

  assert.deepEqual(events(lines, "bot_refresh_empty"), []);
  assert.deepEqual(events(lines, "bot_card_refresh_empty"), [{ taskId: "task-1" }]);
});

await check("a card built with no creator at all says so", async () => {
  const client = await botSetup();
  const { lines } = await captureLogs(() =>
    client.postTaskCard("task-1", "Dana needs an LOI checked", "Smith-1042 - LOI Check\nHow Bad: —\nUrgency: Today")
  );

  assert.deepEqual(events(lines, "bot_creator_ids"), [{ source: "absent", count: 0 }]);
  assert.deepEqual(events(lines, "bot_roster_lookup"), [], "no creator to look up, so no lookup happened");
});

await check("a channel whose member list refuses still counts as a channel we asked", async () => {
  const client = await botSetup({ rosterFails: true });
  const { lines } = await captureLogs(() => postOpenTask(client));

  assert.deepEqual(
    events(lines, "bot_roster_lookup"),
    [{ channels: 1, members: 0, matched: 0 }],
    "a refusal is not the same as never asking"
  );
});

await check("no logged line carries a name or anything about a loan", async () => {
  const client = await botSetup({ roster: [{ id: "29:creator", aadObjectId: CREATOR.id }] });
  const { lines } = await captureLogs(async () => {
    await postOpenTask(client);
    await refreshAs(client, CREATOR);
  });

  const logged = lines.map((line) => `${line.event} ${line.payload}`).join("\n");
  for (const term of [CREATOR.displayName, CHECKER.displayName, "Smith-1042", "LOI Check", CREATOR.id]) {
    assert.doesNotMatch(logged, new RegExp(term), `${term} has no business in a log line`);
  }
});

console.log(`\n${passed} checks passed`);
