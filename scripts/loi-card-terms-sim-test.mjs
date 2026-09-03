#!/usr/bin/env node
/*
 * Issue #259 — notification cards stop quoting an LOI's terms.
 *
 * Every detail DM card carries a `Notes:` line repeating the task's request
 * field. On an LOI that field is the whole block of loan terms (ADR-0008), so
 * the card becomes a wall of figures nobody reads. An LOI card drops the line
 * and relies on its link through to the task; the other five types keep it,
 * where the field is usually a sentence.
 *
 * Drives the real TeamsNotificationProvider against a mock bot client, so the
 * assertions are on the card bodies the server actually sends. Runs against the
 * compiled dist, mirroring dm-card-sync-sim-test.mjs.
 */
import assert from "node:assert/strict";

// The deep link is only built when a Teams app id is configured, and config.ts
// reads the environment as it loads — so this has to be set before the import.
process.env.TEAMS_APP_ID ??= "00000000-0000-0000-0000-000000000259";
const { TeamsNotificationProvider } = await import("../apps/server/dist/notifications.js");

const CREATOR = { id: "creator-1", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] };
const CHECKER = { id: "checker-1", displayName: "Casey Checker", roles: ["FILE_CHECKER"] };

const TERMS = [
  "Loan Amount: $1,300,000",
  "Term: 12 months",
  "Rate: 9.75%",
  "Points: 2",
  "Broker: Ada Broker",
  "Borrower: Smith Family Trust"
].join("\n");

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

const makeTask = (overrides = {}) => ({
  id: "task-259",
  folderName: "Smith-1042",
  taskType: "LOI",
  dueAt: new Date("2026-08-14T20:00:00Z").toISOString(),
  urgency: "GREEN",
  points: 2,
  notes: TERMS,
  humperdinkLink: "https://humperdink.example/loan/1042",
  status: "CLAIMED",
  createdAt: new Date("2026-08-14T16:00:00Z").toISOString(),
  updatedAt: new Date("2026-08-14T16:00:00Z").toISOString(),
  createdBy: { id: CREATOR.id, displayName: CREATOR.displayName },
  assignee: { id: CHECKER.id, displayName: CHECKER.displayName },
  reviewNotes: [],
  ...overrides
});

/* Both detail-card send paths land in the same list: DM_SHARE goes out
   untracked, DM_ASSIGN and DM_CLAIM go out tracked, and all three build their
   body in one place. */
const notifierSetup = () => {
  const cards = [];
  const botClient = {
    sendDetailCardToUsers: async (_userIds, card) => {
      cards.push(card);
    },
    sendTrackedDetailCard: async (_userIds, card) => {
      cards.push(card);
    },
    sendToDms: async () => {}
  };
  const directory = new Map([CHECKER, CREATOR].map((u) => [u.id, u]));
  const notifier = new TeamsNotificationProvider(
    botClient,
    { isEnabled: () => false, sendToUsers: async () => {} },
    { getNotificationChannelId: async () => "channel-1" },
    async (userId) => directory.get(userId)
  );
  return { notifier, cards };
};

const detailEvent = (task, target) => ({
  type: "TASK_STATUS_CHANGED",
  task,
  actor: { id: CREATOR.id, displayName: CREATOR.displayName },
  message: "have a look",
  target,
  recipientUserIds: [CHECKER.id],
  createdAt: new Date().toISOString()
});

const DETAIL_TARGETS = ["DM_SHARE", "DM_ASSIGN", "DM_CLAIM"];

const cardFor = async (task, target) => {
  const { notifier, cards } = notifierSetup();
  await notifier.notify(detailEvent(task, target));
  assert.equal(cards.length, 1, `${target} sends exactly one detail card`);
  return cards[0];
};

const notesLine = (card) => card.detail.split("\n").find((line) => line.startsWith("Notes:"));

console.log("LOI card terms sim");

// --- 1. An LOI card drops the request-field line -----------------------------

await check("no detail card for an LOI quotes its terms", async () => {
  for (const target of DETAIL_TARGETS) {
    const card = await cardFor(makeTask(), target);
    assert.equal(notesLine(card), undefined, `${target} carries no Notes line on an LOI`);
    assert.ok(!card.detail.includes("Rate: 9.75%"), `${target} does not leak the terms into the body`);
  }
});

await check("the rest of the LOI card is untouched", async () => {
  const card = await cardFor(makeTask(), "DM_CLAIM");
  assert.deepEqual(card.detail.split("\n"), [
    "Type: LOI Check",
    "How Bad: 💩💩",
    "Urgency: Within 24 Hours",
    "Due: Aug 14, 2026",
    "Humperdink: [link](https://humperdink.example/loan/1042)"
  ]);
});

await check("a personal share note still leads the body", async () => {
  // The terms go; what a human typed to the recipient stays.
  const { notifier, cards } = notifierSetup();
  await notifier.notify({ ...detailEvent(makeTask(), "DM_SHARE"), note: "second TD looks off" });
  assert.equal(cards[0].detail.split("\n")[0], '"second TD looks off"');
  assert.equal(notesLine(cards[0]), undefined);
});

// --- 2. An LOI card still links through to the task --------------------------

await check("an LOI card still links through to the task", async () => {
  for (const target of DETAIL_TARGETS) {
    const card = await cardFor(makeTask(), target);
    assert.ok(card.openUrl, `${target} keeps its deep link`);
    assert.ok(card.openUrl.includes("task-259"), `${target} deep link points at the task`);
  }
});

// --- 3. The other five types are unchanged -----------------------------------

await check("the four other blended-field types keep their Notes line", async () => {
  for (const taskType of ["BUDDY_CHAT", "VALUE", "FRAUD", "LOAN_DOCS"]) {
    for (const target of DETAIL_TARGETS) {
      const card = await cardFor(makeTask({ taskType, notes: "have a quick look at this one" }), target);
      assert.equal(
        notesLine(card),
        "Notes: have a quick look at this one",
        `${taskType} keeps its ${target} Notes line`
      );
    }
  }
});

await check("an Out of Office card keeps its own body, which never had a Notes line", async () => {
  const card = await cardFor(
    makeTask({ taskType: "OOO", notes: "back Monday", startDate: "2026-08-17", returnDate: "2026-08-21" }),
    "DM_CLAIM"
  );
  assert.deepEqual(card.detail.split("\n"), [
    "Type: Out of Office",
    "Out: Aug 17, 2026 → Aug 21, 2026",
    "Details: Smith-1042"
  ]);
});

console.log(`\n${passed} checks passed`);
