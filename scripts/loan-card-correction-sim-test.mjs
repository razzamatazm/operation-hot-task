#!/usr/bin/env node
/*
 * Renaming a loan leaves already-posted cards quoting the old name (#280).
 *
 * A loan's name and Humperdink link are held once and pushed down onto every
 * task linked to it, so the app shows the corrected values everywhere the
 * moment the edit lands. The cards already sitting in Teams were not touched by
 * that propagation, so the same loan read one way in the app and another way in
 * chat — on three different surfaces:
 *
 *   1. The channel card posted when the task was created. Its headline carries
 *      the loan name, hyperlinked to Humperdink when there is one.
 *   2. The claim-detail DM card, whose title quotes the name and which is
 *      re-rendered from a snapshot captured when it was first sent — so a plain
 *      refresh repainted the OLD name.
 *   3. The note/conversation DM cards, rebuilt from the task's live values, so
 *      an ordinary refresh already corrects those.
 *
 * The whole point is that this is an in-place CORRECTION: every card is edited
 * where it sits, nothing is posted, nothing is deleted, nobody is re-pinged,
 * and a channel card keeps whatever lifecycle shape it was already in. A rename
 * that visually un-claimed a claimed task, or put a Claim button back on a
 * finished one, would be a worse bug than the one being fixed.
 *
 * Runs against the compiled dist with only the Bot Framework connector stubbed,
 * mirroring dm-card-sync-sim-test.mjs, so every card write is observed where it
 * actually happens: the real loan service, task service, notification layer and
 * bot client, over temp stores.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TeamsBotClient, correctedDetailSnapshot } from "../apps/server/dist/bot.js";
import { TeamsNotificationProvider } from "../apps/server/dist/notifications.js";
import { LoanStore, TaskStore } from "../apps/server/dist/store.js";
import { SseHub } from "../apps/server/dist/sse.js";
import { LoanService } from "../apps/server/dist/loan-service.js";
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

const cardOf = (entry) => entry.activity.attachments[0].content;
const headline = (card) => card.body?.[0]?.text;
const actionTitles = (card) => (card.actions ?? []).map((action) => action.title);

console.log("Loan card correction sim");

// --- 1. The stored DM snapshot, corrected -----------------------------------

/* The claim-detail card is replayed from what was stored when it was sent, so
   correcting the posted card means correcting that snapshot too — otherwise the
   next refresh quietly repaints the old name over the new one. */

const snapshot = (over = {}) => ({
  title: "You claimed Smith-1042",
  detail: "Type: LOI Check\nHow Bad: 💩💩\nDue: Aug 14",
  folderName: "Smith-1042",
  ...over
});

await check("the recorded name is swapped out of the card's title", () => {
  const next = correctedDetailSnapshot(snapshot(), { folderName: "Smith-1043" });
  assert.equal(next.title, "You claimed Smith-1043");
  assert.equal(next.folderName, "Smith-1043");
});

await check("a handoff card's title is corrected the same way", () => {
  // Two surfaces send a tracked detail card and they word the title
  // differently. Swapping the recorded name corrects both without either one
  // having to be recognised.
  const next = correctedDetailSnapshot(
    snapshot({ title: "Dana Requester assigned Smith-1042 to you" }),
    { folderName: "Smith-1043" }
  );
  assert.equal(next.title, "Dana Requester assigned Smith-1043 to you");
});

await check("somebody's typed words are never rewritten", () => {
  // The body can carry a personal note and a Notes line — text a human wrote.
  // The loan name does not appear in the generated body at all, so there is
  // nothing there to correct and everything there to leave alone.
  const withNote = snapshot({ detail: '"heads up on Smith-1042"\n\nType: LOI Check' });
  const next = correctedDetailSnapshot(withNote, { folderName: "Smith-1043" });
  assert.equal(next.detail, withNote.detail, "the quoted note is left exactly as typed");
});

await check("a corrected Humperdink link replaces the one in the body", () => {
  const before = snapshot({
    detail: "Type: LOI Check\nHumperdink: [link](https://humperdink.example/Loans/Details/1)",
    humperdinkLink: "https://humperdink.example/Loans/Details/1"
  });
  const next = correctedDetailSnapshot(before, {
    folderName: "Smith-1042",
    humperdinkLink: "https://humperdink.example/Loans/Details/2"
  });
  assert.equal(next.detail, "Type: LOI Check\nHumperdink: [link](https://humperdink.example/Loans/Details/2)");
  assert.equal(next.humperdinkLink, "https://humperdink.example/Loans/Details/2");
});

await check("a link cleared on the loan takes its line off the card", () => {
  const before = snapshot({
    detail: "Type: LOI Check\nHumperdink: [link](https://humperdink.example/Loans/Details/1)",
    humperdinkLink: "https://humperdink.example/Loans/Details/1"
  });
  const next = correctedDetailSnapshot(before, { folderName: "Smith-1042" });
  assert.equal(next.detail, "Type: LOI Check");
  assert.equal(next.humperdinkLink, undefined);
});

await check("a link added to a loan gains its line", () => {
  const next = correctedDetailSnapshot(snapshot(), {
    folderName: "Smith-1042",
    humperdinkLink: "https://humperdink.example/Loans/Details/7"
  });
  assert.equal(
    next.detail,
    "Type: LOI Check\nHow Bad: 💩💩\nDue: Aug 14\nHumperdink: [link](https://humperdink.example/Loans/Details/7)"
  );
});

await check("nothing moved means nothing is rewritten", () => {
  assert.equal(correctedDetailSnapshot(snapshot(), { folderName: "Smith-1042" }), undefined);
});

await check("a card recorded before corrections existed is left alone", () => {
  // No recorded name means no safe substring to swap, and guessing one would
  // corrupt the card. Leaving it is the best-effort answer.
  const legacy = { title: "You claimed Smith-1042", detail: "Type: LOI Check" };
  assert.equal(correctedDetailSnapshot(legacy, { folderName: "Smith-1043" }), undefined);
});

// --- 2. End to end, with only the connector stubbed -------------------------

const harness = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loan-card-correction-sim-"));
  const refsFile = path.join(dir, "bot-references.json");
  const serviceUrl = "https://example.invalid";
  const channelRef = { serviceUrl, conversation: { id: "19:general@thread.tacv2", conversationType: "channel" } };
  await fs.writeFile(
    refsFile,
    JSON.stringify([
      {
        key: `dm:${CREATOR.id}`,
        reference: { serviceUrl, conversation: { id: "dm-creator" }, user: { id: "29:creator", aadObjectId: CREATOR.id } },
        scope: "DM",
        userId: CREATOR.id,
        userAadObjectId: CREATOR.id
      },
      {
        key: `dm:${CHECKER.id}`,
        reference: { serviceUrl, conversation: { id: "dm-checker" }, user: { id: "29:checker", aadObjectId: CHECKER.id } },
        scope: "DM",
        userId: CHECKER.id,
        userAadObjectId: CHECKER.id
      },
      { key: "channel:general", reference: channelRef, scope: "CHANNEL" }
    ]),
    "utf8"
  );

  const bot = new TeamsBotClient("app-id", "app-password", undefined, refsFile);
  await bot.init();

  const sent = [];
  const updated = [];
  const created = [];
  const attempted = [];
  let nextId = 0;
  const connector = { mode: "ok" };
  bot.adapter.createConnectorClient = () => ({
    conversations: {
      createConversation: async (params) => {
        nextId += 1;
        created.push(params);
        return { id: `channel-thread-${nextId}`, activityId: `activity-${nextId}` };
      },
      sendToConversation: async (conversationId, activity) => {
        nextId += 1;
        sent.push({ conversationId, activity });
        return { id: `activity-${nextId}` };
      },
      updateActivity: async (conversationId, activityId, activity) => {
        attempted.push({ conversationId, activityId });
        if (connector.mode === "throw") {
          throw new Error("Activity not found");
        }
        if (connector.mode === "hang") {
          await new Promise(() => {});
        }
        updated.push({ conversationId, activityId, activity });
        return { id: activityId };
      },
      deleteActivity: async () => {}
    }
  });

  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.init();
  const loanStore = new LoanStore(path.join(dir, "loans.json"));
  await loanStore.init();
  const sse = new SseHub();
  const users = new Map([
    [CREATOR.id, CREATOR],
    [CHECKER.id, CHECKER]
  ]);
  const notifier = new TeamsNotificationProvider(
    bot,
    { isEnabled: () => false, sendToUsers: async () => {} },
    { getNotificationChannelId: async () => undefined },
    async (id) => users.get(id)
  );
  const loans = new LoanService(loanStore, store, sse);
  const service = new TaskService(store, notifier, sse, config, undefined, loans);
  // The loan service reaches the cards through a callback handed to it here, so
  // it keeps knowing nothing about the notification layer.
  loans.setCardCorrector((taskId) => service.correctTaskCards(taskId));
  bot.setTaskLookup(async (taskId) => service.getTask(taskId));

  const settle = async () => {
    await service.settleBackgroundWork();
  };

  return { bot, loans, service, store, loanStore, sent, updated, created, attempted, connector, settle };
};

/* The channel card is the one posted through createConversation, so its edits
   are the ones addressed at a channel thread. */
const channelEdits = (updated) => updated.filter((entry) => entry.conversationId.startsWith("channel-thread-"));
const dmEdits = (updated) => updated.filter((entry) => entry.conversationId.startsWith("dm-"));
const editsTitled = (updated, prefix) =>
  dmEdits(updated).filter((entry) => (headline(cardOf(entry)) ?? "").startsWith(prefix));

const createLoanTask = async (service, folderName, humperdinkLink) =>
  service.createTask(
    {
      folderName,
      taskType: "LOI",
      urgency: "GREEN",
      points: 2,
      notes: "",
      ...(humperdinkLink ? { humperdinkLink } : {})
    },
    CREATOR
  );

await check("a rename corrects all three posted surfaces, in place", async () => {
  const h = await harness();
  const task = await createLoanTask(h.service, "Smith-1042");
  await h.service.claimTask(task.id, CHECKER);
  await h.service.addReviewNote(task.id, "starting on it", CHECKER);
  await h.settle();

  const postsBefore = h.created.length;
  const sendsBefore = h.sent.length;
  assert.equal(postsBefore, 1, "one channel card was posted for the task");
  const loanId = (await h.store.findTask(task.id)).loanId;
  h.updated.length = 0;

  await h.loans.update(loanId, { name: "Smith-1043" }, { actor: CREATOR });
  await h.settle();

  // Nothing new anywhere: this is a correction of messages that already exist.
  assert.equal(h.created.length, postsBefore, "no new channel post");
  assert.equal(h.sent.length, sendsBefore, "no new DM to anyone");

  // 1. The channel card — and it keeps the shape it was in.
  const channel = channelEdits(h.updated).at(-1);
  assert.ok(channel, "the channel card was edited");
  assert.equal(headline(cardOf(channel)), "Casey Checker grabbed Smith-1043");
  assert.deepEqual(actionTitles(cardOf(channel)), [], "a claimed card gains no Claim button back");

  // 2. The claim-detail DM card. Its title is replayed from a snapshot taken
  // when it was sent, which is why this one is the surface a plain refresh got
  // wrong: it repainted "You claimed Smith-1042" over the corrected task.
  const detail = editsTitled(h.updated, "You claimed").at(-1);
  assert.ok(detail, "the claim-detail card was edited");
  assert.equal(headline(cardOf(detail)), "You claimed Smith-1043");

  // 3. The note cards, which are rebuilt from the task's live values.
  const note = editsTitled(h.updated, "Conversation on").at(-1);
  assert.ok(note, "the note card was edited");
  assert.equal(headline(cardOf(note)), "Conversation on Smith-1043");
});

await check("corrected cards keep the exact messages they were posted as", async () => {
  const h = await harness();
  const task = await createLoanTask(h.service, "Keep-1");
  await h.service.claimTask(task.id, CHECKER);
  await h.settle();
  const loanId = (await h.store.findTask(task.id)).loanId;
  const channelActivityId = channelEdits(h.updated).at(-1).activityId;
  h.updated.length = 0;

  await h.loans.update(loanId, { name: "Keep-2" }, { actor: CREATOR });
  await h.settle();

  assert.equal(
    channelEdits(h.updated).at(-1).activityId,
    channelActivityId,
    "the same message is edited, so the card never moves in the channel"
  );
});

await check("a corrected Humperdink link is the one behind the name", async () => {
  const h = await harness();
  const task = await createLoanTask(h.service, "Link-1", "https://humperdink.example/Loans/Details/1");
  await h.settle();
  const loanId = (await h.store.findTask(task.id)).loanId;
  h.updated.length = 0;

  await h.loans.update(
    loanId,
    { humperdinkLink: "https://humperdink.example/Loans/Details/2" },
    { actor: CREATOR }
  );
  await h.settle();

  const channel = channelEdits(h.updated).at(-1);
  assert.ok(
    headline(cardOf(channel)).includes("[Link-1](https://humperdink.example/Loans/Details/2)"),
    `the name links to the corrected loan, got: ${headline(cardOf(channel))}`
  );
});

await check("an unclaimed task's card is still claimable afterwards", async () => {
  const h = await harness();
  const task = await createLoanTask(h.service, "Open-1");
  await h.settle();
  const loanId = (await h.store.findTask(task.id)).loanId;
  h.updated.length = 0;

  await h.loans.update(loanId, { name: "Open-2" }, { actor: CREATOR });
  await h.settle();

  const card = cardOf(channelEdits(h.updated).at(-1));
  assert.equal(headline(card), "Dana Requester needs an LOI checked: Open-2");
  assert.deepEqual(actionTitles(card), ["Claim"], "the task is still up for grabs");
});

await check("a finished task's card is corrected and stays terminal", async () => {
  const h = await harness();
  const task = await createLoanTask(h.service, "Done-1");
  await h.service.claimTask(task.id, CHECKER);
  await h.service.transitionStatus(task.id, "COMPLETED", CHECKER);
  await h.settle();
  // The task that motivates the edit is usually a finished one, and the loan
  // edit is made from some other, live task on the same loan.
  const loanId = (await h.store.findTask(task.id)).loanId;
  h.updated.length = 0;

  await h.loans.update(loanId, { name: "Done-2" }, { actor: CREATOR });
  await h.settle();

  const channel = cardOf(channelEdits(h.updated).at(-1));
  assert.equal(headline(channel), "✅ Completed — Done-2");
  assert.deepEqual(actionTitles(channel), [], "no action button is reintroduced");

  const detail = cardOf(editsTitled(h.updated, "✅ Completed").at(-1));
  assert.deepEqual(actionTitles(detail), [], "and none on the DM card either");
});

await check("the rename returns without waiting on the card writes", async () => {
  const h = await harness();
  const task = await createLoanTask(h.service, "Async-1");
  await h.service.claimTask(task.id, CHECKER);
  await h.settle();
  const loanId = (await h.store.findTask(task.id)).loanId;

  // Every card write hangs forever. The person renaming the loan must not.
  h.connector.mode = "hang";
  const renamed = await Promise.race([
    h.loans.update(loanId, { name: "Async-2" }, { actor: CREATOR }).then(() => "renamed"),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 2000))
  ]);
  assert.equal(renamed, "renamed", "the card work is background work");
  assert.equal((await h.store.findTask(task.id)).folderName, "Async-2");
});

await check("a card that cannot be updated fails neither the rename nor the next task", async () => {
  const h = await harness();
  const one = await createLoanTask(h.service, "Fail-1");
  const two = await h.service.createTask(
    { folderName: "Fail-1", taskType: "VALUE", urgency: "GREEN", points: 1, notes: "" },
    CREATOR
  );
  await h.settle();
  const loanId = (await h.store.findTask(one.id)).loanId;
  assert.equal((await h.store.findTask(two.id)).loanId, loanId, "both tasks sit on the one loan");
  h.attempted.length = 0;

  h.connector.mode = "throw";
  const result = await h.loans.update(loanId, { name: "Fail-2" }, { actor: CREATOR });
  await h.settle();

  assert.equal(result.loan.name, "Fail-2", "the rename succeeded");
  assert.equal((await h.store.findTask(two.id)).folderName, "Fail-2");
  const channels = h.attempted.filter((entry) => entry.conversationId.startsWith("channel-thread-"));
  assert.equal(channels.length, 2, "both tasks' cards were still attempted");
});

await check("folding two loans together corrects the absorbed loan's cards", async () => {
  const h = await harness();
  const original = await createLoanTask(h.service, "Alpha", "https://humperdink.example/Loans/Details/10");
  const absorbed = await createLoanTask(h.service, "Beta", "https://humperdink.example/Loans/Details/11");
  await h.service.claimTask(absorbed.id, CHECKER);
  await h.settle();
  const absorbedLoanId = (await h.store.findTask(absorbed.id)).loanId;
  assert.notEqual(absorbedLoanId, (await h.store.findTask(original.id)).loanId);
  h.updated.length = 0;

  // Pointing Beta at Alpha's link folds the two records together and repoints
  // Beta's tasks — which changes the name those tasks display.
  const merged = await h.loans.update(
    absorbedLoanId,
    { humperdinkLink: "https://humperdink.example/Loans/Details/10" },
    { actor: CREATOR, confirmMerge: true }
  );
  await h.settle();

  assert.equal(merged.loan.name, "Alpha");
  assert.equal((await h.store.findTask(absorbed.id)).folderName, "Alpha");
  const channel = channelEdits(h.updated).at(-1);
  assert.equal(headline(cardOf(channel)), "Casey Checker grabbed Alpha");
  const detail = editsTitled(h.updated, "You claimed").at(-1);
  assert.equal(headline(cardOf(detail)), "You claimed Alpha");
});

console.log(`\n${passed} checks passed`);
