#!/usr/bin/env node
/*
 * "Claim & Open" — one tap instead of two (#180).
 *
 * The claimable channel card used to offer a bare Claim (an Action.Execute the
 * bot handled server-side) beside Open in Hot Task, so taking a task and then
 * going to work it cost two taps in two places with a card refresh in between.
 * An Adaptive Card action can't do both — Execute can't navigate, OpenUrl hits
 * no API — so the combined button is a deep link carrying an explicit claim
 * intent, and the web app claims on arrival as the signed-in user.
 *
 * The whole risk of that design is the link. This builder is shared with the
 * DM cards, the activity feed and the web app's "Copy link", and a link that
 * claims a task for whoever opens it would be a bug with a blast radius. So:
 *
 *   1. Every existing caller's URL is byte-identical to what it was. The claim
 *      intent is opt-in, in its own field inside the context JSON, never a
 *      prefix or sentinel on subEntityId.
 *   2. The card's two buttons carry different URLs: only "Claim & Open" has
 *      the intent.
 *   3. The reader is strict — anything it can't positively identify as the
 *      intent reads as view-only.
 *   4. The creator is never offered a claim affordance, including when they
 *      have never messaged the bot and their Teams MRI has to come off the
 *      channel roster instead.
 *
 * Runs against the compiled dist, like its channel-card siblings.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readClaimIntent, teamsTaskDeepLink, withClaimIntent } from "../packages/shared/dist/index.js";
import { TeamsBotClient } from "../apps/server/dist/bot.js";

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

const cardOf = (entry) => entry.activity.attachments[0].content;
const actionTitles = (card) => (card.actions ?? []).map((action) => action.title);
const urlFor = (card, title) => (card.actions ?? []).find((action) => action.title === title)?.url;
const contextOf = (url) => JSON.parse(new URLSearchParams(url.split("?", 2)[1]).get("context"));

console.log("Claim & Open sim");

await check("a view-only link is byte-identical to the one built before the option existed", () => {
  // Frozen literals, not a re-derivation: this is the contract every existing
  // caller depends on, and comparing the builder to itself would prove nothing.
  assert.equal(
    teamsTaskDeepLink("app-id", "task-1"),
    "https://teams.microsoft.com/l/entity/app-id/loan-tasks-home?context=%7B%22subEntityId%22%3A%22task-1%22%7D"
  );
  assert.equal(
    teamsTaskDeepLink("app-id", "task-1", { label: "Smith-1042", webUrl: "https://hot.example" }),
    "https://teams.microsoft.com/l/entity/app-id/loan-tasks-home?context=%7B%22subEntityId%22%3A%22task-1%22%7D&label=Smith-1042&webUrl=https%3A%2F%2Fhot.example"
  );
  assert.equal(teamsTaskDeepLink("app-id"), "https://teams.microsoft.com/l/entity/app-id/loan-tasks-home");
  assert.equal(teamsTaskDeepLink(undefined, "task-1"), undefined);
  // Explicitly off is the same as never asked.
  assert.equal(teamsTaskDeepLink("app-id", "task-1", { claim: false }), teamsTaskDeepLink("app-id", "task-1"));
});

await check("the claim intent is its own field beside subEntityId, never a prefix on it", () => {
  const url = teamsTaskDeepLink("app-id", "task-1", { claim: true });
  const context = contextOf(url);
  assert.equal(context.subEntityId, "task-1", "the task id is still a bare task id");
  assert.equal(context.claimOnOpen, true);
});

await check("withClaimIntent turns a recorded link into its claim twin and nothing else", () => {
  const viewOnly = teamsTaskDeepLink("app-id", "task-1", { label: "Smith-1042", webUrl: "https://hot.example" });
  const claim = withClaimIntent(viewOnly);
  assert.deepEqual(contextOf(claim), { subEntityId: "task-1", claimOnOpen: true });

  const params = new URLSearchParams(claim.split("?", 2)[1]);
  assert.equal(params.get("label"), "Smith-1042", "the rest of the link rides along untouched");
  assert.equal(params.get("webUrl"), "https://hot.example");
  assert.equal(claim.split("?", 2)[0], viewOnly.split("?", 2)[0]);

  // Nothing to claim → no button rather than one that lands on the plain tab.
  assert.equal(withClaimIntent(undefined), undefined);
  assert.equal(withClaimIntent(teamsTaskDeepLink("app-id")), undefined);
  assert.equal(withClaimIntent("https://teams.microsoft.com/l/entity/app-id/loan-tasks-home?context=not-json"), undefined);
});

await check("the reader treats anything it can't positively identify as view-only", () => {
  assert.equal(readClaimIntent({ page: { subPageId: "task-1", claimOnOpen: true } }), true);
  assert.equal(readClaimIntent({ subEntityId: "task-1", claimOnOpen: true }), true);
  assert.equal(readClaimIntent({ page: { subPageId: "task-1" } }), false);
  assert.equal(readClaimIntent({ page: { subPageId: "task-1" }, claimOnOpen: "true" }), false, "a truthy string is not the intent");
  assert.equal(readClaimIntent(undefined), false);
  assert.equal(readClaimIntent("claimOnOpen"), false);
});

/* A TeamsBotClient wired to one captured CHANNEL reference, with the connector
   stubbed. `roster` is what getConversationMembers answers with — the fallback
   the creator's MRI comes off when they have never messaged the bot. */
const botSetup = async (roster = []) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claim-and-open-sim-"));
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
  let nextId = 0;
  client.adapter.createConnectorClient = () => ({
    conversations: {
      createConversation: async (params) => {
        nextId += 1;
        posted.push({ params, activity: params.activity });
        return { id: `19:thread-${nextId}`, activityId: `activity-${nextId}` };
      },
      updateActivity: async () => ({ id: "activity-1" }),
      sendToConversation: async () => ({ id: "activity-reply" }),
      deleteActivity: async () => {},
      getConversationMembers: async () => roster
    }
  });
  return { client, posted };
};

const OPEN_URL = teamsTaskDeepLink("app-id", "task-1", { label: "Smith-1042" });

await check("the claimable card offers Claim & Open and Open in Hot Task, and only one of them claims", async () => {
  const { client, posted } = await botSetup();
  await client.postTaskCard("task-1", "Dana needs an LOI checked: Smith-1042", "How Bad: —", OPEN_URL);

  const card = cardOf(posted[0]);
  assert.deepEqual(actionTitles(card), ["Claim & Open", "Open in Hot Task"], "no bare Claim remains");
  assert.equal(card.actions[0].type, "Action.OpenUrl", "the combined button navigates; Execute could not");
  assert.equal(contextOf(urlFor(card, "Claim & Open")).claimOnOpen, true);
  assert.equal(urlFor(card, "Open in Hot Task"), OPEN_URL, "the plain button is the recorded view-only link, unchanged");
});

await check("with no deep link the card keeps the one-tap Claim it always had", async () => {
  // TEAMS_APP_ID is unset in local and test environments, so there is no link
  // to hang Claim & Open on — and a card with no actions is a card nobody can
  // claim from.
  const { client, posted } = await botSetup();
  await client.postTaskCard("task-1", "Dana needs an LOI checked: Smith-1042", "How Bad: —", undefined);

  const card = cardOf(posted[0]);
  assert.deepEqual(actionTitles(card), ["Claim"]);
  assert.equal(card.actions[0].type, "Action.Execute");
  assert.equal(card.actions[0].verb, "claimTask");
});

const taskAt = (status, creatorId = "aad-creator") => ({
  id: "task-1",
  folderName: "Smith-1042",
  taskType: "LOI",
  status,
  createdBy: { id: creatorId, displayName: "Dana Requester" },
  assignee: undefined
});

await check("the creator's view carries no claim affordance of either kind", async () => {
  const { client } = await botSetup();
  await client.postTaskCard("task-1", "Dana needs an LOI checked: Smith-1042", "How Bad: —", OPEN_URL);
  client.setTaskLookup(async () => taskAt("OPEN"));

  const creatorCard = await client.handleRefreshCard("task-1", "aad-creator");
  assert.deepEqual(actionTitles(creatorCard), ["Cancel Task", "Open in Hot Task"]);

  const everyoneElse = await client.handleRefreshCard("task-1", "aad-viewer");
  assert.deepEqual(actionTitles(everyoneElse), ["Claim & Open", "Open in Hot Task"]);
});

await check("a creator who has never messaged the bot is still not offered a claim", async () => {
  /* THE GAP: the user-specific view is opted into by listing the creator's
     Teams MRI in the card's refresh block, and that MRI used to come only from
     a stored DM reference. No DM, no refresh block, and the creator fell back
     to the claim-for-all card — which with a bare Claim was a misleading toast
     and with Claim & Open is a failure after navigation. The roster knows who
     they are. */
  const roster = [{ id: "29:dana", aadObjectId: "aad-creator", name: "Dana Requester" }];
  const { client, posted } = await botSetup(roster);
  await client.postTaskCard("task-1", "Dana needs an LOI checked: Smith-1042", "How Bad: —", OPEN_URL, undefined, "aad-creator");

  const card = cardOf(posted[0]);
  assert.deepEqual(card.refresh?.userIds, ["29:dana"], "the creator is opted into their own view");
  assert.equal(card.refresh.action.verb, "refreshTaskCard");

  client.setTaskLookup(async () => taskAt("OPEN"));
  const creatorCard = await client.handleRefreshCard("task-1", "aad-creator");
  assert.deepEqual(actionTitles(creatorCard), ["Cancel Task", "Open in Hot Task"]);
});

await check("a creator the roster can't place degrades to the old behaviour, not to a crash", async () => {
  const { client, posted } = await botSetup([{ id: "29:someone-else", aadObjectId: "aad-other" }]);
  await client.postTaskCard("task-1", "Dana needs an LOI checked: Smith-1042", "How Bad: —", OPEN_URL, undefined, "aad-creator");
  assert.equal("refresh" in cardOf(posted[0]), false);
});

await check("a claim still lands from the card, and says why when it can't", async () => {
  // The combined button claims through the web app, but the Execute path is
  // still live for linkless cards and for every card posted before #180.
  const { client } = await botSetup();
  await client.postTaskCard("task-1", "Dana needs an LOI checked: Smith-1042", "How Bad: —", OPEN_URL);

  client.setClaimHandler(
    async () => ({ id: "aad-checker", displayName: "Casey Checker" }),
    async () => ({ ...taskAt("CLAIMED"), assignee: { id: "aad-checker", displayName: "Casey Checker" } })
  );
  const ok = await client.handleClaim("task-1", "aad-checker", "Casey Checker");
  assert.equal(ok.ok, true);
  assert.equal(ok.message, "Casey Checker grabbed Smith-1042");

  /* The refusal is the sentence the rule gives, not a catch-all. `claimTask`
     throws `claimRefusalMessage`, so the creator hears why they of all people
     can't take this one (ADR-0003). */
  client.setClaimHandler(
    async () => ({ id: "aad-creator", displayName: "Dana Requester" }),
    async () => {
      throw new Error("Dana Requester created this task — a task takes a second pair of hands");
    }
  );
  const refused = await client.handleClaim("task-1", "aad-creator", "Dana Requester");
  assert.equal(refused.ok, false);
  assert.equal(refused.message, "Dana Requester created this task — a task takes a second pair of hands");
});

console.log(`\n${passed} checks passed`);
