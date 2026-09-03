#!/usr/bin/env node
/*
 * Whose button is it? (#182)
 *
 * `taskCardRecipients` decided `showAdvance` by asking whether the advance
 * target happened to be COMPLETED, and restricted only that one to the
 * assignee. Every earlier rung went to every recipient, so on a Loan Docs task
 * the assignee was handed **Approve Merge** — the creator's move — and the
 * creator was handed **Merge Done**, which is the assignee's. Only the last
 * step was right, and only because it was the one case the condition covered.
 *
 * The gate is now `botAdvanceFor`: the flow's next step, filtered through the
 * same `canTransitionStatus` the server runs on the tap. Complete staying
 * assignee-only falls out of that rule instead of sitting beside it.
 *
 * Everything below is driven from ONE table — the status → party mapping — and
 * replayed across every bot surface that renders an action, so a new rung or a
 * new surface is a row or a loop body, never a hand-written case per card.
 *
 * Runs against the compiled dist, mirroring fraud-cards-sim-test.mjs.
 */
import assert from "node:assert/strict";

import { fraudCardActions, taskCardRecipients } from "../packages/shared/dist/fraud.js";
import { botAdvanceFor, botPrimaryAdvance, canTransitionStatus, pendingPartyFor } from "../packages/shared/dist/workflow.js";
import { detailCard, noteCard, noteCardDataFromTask } from "../apps/server/dist/bot.js";
import { TeamsNotificationProvider } from "../apps/server/dist/notifications.js";

const CREATOR = { id: "creator-1", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] };
/* The assignee carries FILE_CHECKER because the same person plays the assignee
   in the FRAUD rows, where the checker seat needs a live role. It buys nothing
   on the other two flows. */
const ASSIGNEE = { id: "worker-1", displayName: "Sam Officer", roles: ["LOAN_OFFICER", "FILE_CHECKER"] };
/* Neither party. Admin is back-end access, not a seat (ADR-0003), so this one
   doubles as the "an admin who is a party to nothing" case. */
const OBSERVER = { id: "admin-1", displayName: "Avery Admin", roles: ["LOAN_OFFICER", "FILE_CHECKER", "ADMIN"] };
const VIEWERS = [CREATOR, ASSIGNEE, OBSERVER];

const NOBODY = "NOBODY";

const makeTask = (overrides = {}) => ({
  id: "task-1",
  folderName: "Smith-1042",
  taskType: "LOAN_DOCS",
  dueAt: new Date("2026-08-14T20:00:00Z").toISOString(),
  urgency: "GREEN",
  points: 2,
  notes: "have a look",
  status: "CLAIMED",
  createdAt: new Date("2026-08-14T00:00:00Z").toISOString(),
  updatedAt: new Date("2026-08-14T00:00:00Z").toISOString(),
  createdBy: { id: CREATOR.id, displayName: CREATOR.displayName },
  assignee: { id: ASSIGNEE.id, displayName: ASSIGNEE.displayName },
  ...overrides
});

/* The matrix. One row per (flow, status) that a bot card can be rendered in,
   naming the forward step and the party whose move it is. `party: NOBODY` means
   no card anywhere may offer a forward button — either the flow has no next
   step, or nobody is holding a seat for it.
 *
 * `unassigned` covers the states a task reaches with no assignee: OPEN, and a
 * fraud task released back to the pool. */
const MATRIX = [
  // --- LOAN_DOCS: the merge chain, which hands the ball back and forth -------
  { taskType: "LOAN_DOCS", status: "OPEN", unassigned: true, advance: undefined, party: NOBODY },
  { taskType: "LOAN_DOCS", status: "CLAIMED", advance: { status: "MERGE_DONE", label: "Merge Done" }, party: "ASSIGNEE" },
  { taskType: "LOAN_DOCS", status: "MERGE_DONE", advance: { status: "MERGE_APPROVED", label: "Approve Merge" }, party: "CREATOR" },
  { taskType: "LOAN_DOCS", status: "MERGE_APPROVED", advance: { status: "COMPLETED", label: "Complete" }, party: "ASSIGNEE" },
  // No NEEDS_REVIEW row: the corrections state is LOI-only since ADR-0007 and
  // a Loan Docs task cannot reach it (the store migrates any left there).
  { taskType: "LOAN_DOCS", status: "COMPLETED", advance: undefined, party: NOBODY },
  { taskType: "LOAN_DOCS", status: "CANCELLED", advance: undefined, party: NOBODY },
  { taskType: "LOAN_DOCS", status: "ARCHIVED", advance: undefined, party: NOBODY },

  // --- The standard flow: claim, then the assignee closes it out ------------
  { taskType: "LOI", status: "OPEN", unassigned: true, advance: undefined, party: NOBODY },
  { taskType: "LOI", status: "CLAIMED", advance: { status: "COMPLETED", label: "Complete" }, party: "ASSIGNEE" },
  /* The LOI corrections state (ADR-0007): the checker has handed the ball back,
     so the Complete out of it is the CREATOR's — the one completion in the app
     that is not the assignee's. */
  { taskType: "LOI", status: "NEEDS_REVIEW", advance: { status: "COMPLETED", label: "Complete" }, party: "CREATOR" },
  { taskType: "LOI", status: "COMPLETED", advance: undefined, party: NOBODY },
  { taskType: "VALUE", status: "CLAIMED", advance: { status: "COMPLETED", label: "Complete" }, party: "ASSIGNEE" },
  { taskType: "OOO", status: "CLAIMED", advance: { status: "COMPLETED", label: "Complete" }, party: "ASSIGNEE" },

  // --- FRAUD: the two-phase exchange. Its buttons come from `fraudActions`,
  //     but the same party rule holds underneath and is asserted here too. ----
  { taskType: "FRAUD", status: "OPEN", unassigned: true, advance: undefined, party: NOBODY },
  { taskType: "FRAUD", status: "CLAIMED", advance: { status: "AWAITING_ITEMS", label: "Send Items" }, party: "ASSIGNEE" },
  { taskType: "FRAUD", status: "AWAITING_ITEMS", advance: { status: "PENDING_APPROVAL", label: "Submit" }, party: "CREATOR" },
  { taskType: "FRAUD", status: "PENDING_APPROVAL", advance: { status: "COMPLETED", label: "Approve" }, party: "ASSIGNEE" },
  // Released back to the pool mid-flow: the checker seat is empty, so the move
  // out of PENDING_APPROVAL belongs to nobody until somebody claims it.
  { taskType: "FRAUD", status: "PENDING_APPROVAL", unassigned: true, advance: { status: "COMPLETED", label: "Approve" }, party: NOBODY },
  /* No NEEDS_REVIEW row: a Fraud Check used to be sendable to review from
     CLAIMED and then had no forward step for either seat (#240). ADR-0007 made
     the corrections state LOI-only, so the cell no longer exists. */
  { taskType: "FRAUD", status: "COMPLETED", advance: undefined, party: NOBODY }
];

const taskFor = (row) =>
  makeTask({
    taskType: row.taskType,
    status: row.status,
    ...(row.unassigned ? { assignee: undefined } : {})
  });

/* Which of the three viewers holds the move on this row. */
const holderOf = (row) => (row.party === "CREATOR" ? CREATOR : row.party === "ASSIGNEE" ? ASSIGNEE : undefined);
const isHolder = (row, viewer) => holderOf(row)?.id === viewer.id;

const rowName = (row) => `${row.taskType} @ ${row.status}${row.unassigned ? " (unassigned)" : ""}`;

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

/* Action titles on a rendered Adaptive Card, in order. */
const actionTitles = (card) => (card.actions ?? []).map((action) => action.title);

console.log("Bot card advance buttons go to the party whose move it is (#182)");

// --- The table itself is right ---------------------------------------------

await check("the flow's next step is what the table says it is", () => {
  for (const row of MATRIX) {
    const advance = botPrimaryAdvance(taskFor(row));
    assert.deepEqual(advance, row.advance, `${rowName(row)}: forward step`);
  }
});

await check("the party holding each handoff status is the party the flow waits on", () => {
  /* `pendingPartyFor` is the display answer to "who are we waiting on". Where
     it is defined it must name the same person the permission predicate lets
     act, or the passive `Waiting on <name>` indicator and the button would
     point at two different people. Where it is undefined the flow is waiting on
     nobody in particular — which is NOT the same as "anybody may act", and is
     exactly the gap that made deriving the gate from this mapping alone
     impossible: LOAN_DOCS @ CLAIMED is undefined here and still assignee-only. */
  for (const row of MATRIX) {
    const pending = pendingPartyFor(taskFor(row));
    // A vacant seat is the second gap: `pendingPartyFor` names a seat, not a
    // person, and a fraud task released back to the pool has no one in the
    // checker seat it points at. The button goes to nobody until it is filled.
    if (pending === undefined || row.unassigned) {
      continue;
    }
    assert.equal(pending, row.party, `${rowName(row)}: pendingPartyFor agrees with the seat`);
  }
  const released = makeTask({ taskType: "FRAUD", status: "PENDING_APPROVAL", assignee: undefined });
  assert.equal(pendingPartyFor(released), "ASSIGNEE", "the status still points at the checker seat");
  assert.equal(botAdvanceFor(released, ASSIGNEE), undefined, "but nobody is sitting in it");
  // And the gap is real, not hypothetical — the table would be unreachable from
  // `pendingPartyFor` alone.
  const claimed = makeTask({ status: "CLAIMED" });
  assert.equal(pendingPartyFor(claimed), undefined, "CLAIMED is a state, not a handoff");
  assert.equal(botAdvanceFor(claimed, ASSIGNEE)?.status, "MERGE_DONE", "and yet the move out of it has an owner");
});

// --- Surface 1: taskCardRecipients (note card, chat seed, DM_CARD_SYNC) -----

await check("taskCardRecipients: showAdvance is true for the party and nobody else", () => {
  for (const row of MATRIX) {
    const task = taskFor(row);
    const recipients = taskCardRecipients(task, VIEWERS);
    for (const viewer of VIEWERS) {
      const recipient = recipients.find((entry) => entry.userId === viewer.id);
      assert.equal(
        recipient.showAdvance,
        isHolder(row, viewer),
        `${rowName(row)}: showAdvance for ${viewer.displayName}`
      );
    }
  }
});

await check("no card offers a button the server would refuse", () => {
  /* The invariant behind the gate, asserted directly rather than trusted: for
     every row and every viewer, `showAdvance` is exactly what
     `canTransitionStatus` would answer on the tap. */
  for (const row of MATRIX) {
    const task = taskFor(row);
    const recipients = taskCardRecipients(task, VIEWERS);
    for (const viewer of VIEWERS) {
      const recipient = recipients.find((entry) => entry.userId === viewer.id);
      const serverWouldAllow = row.advance ? canTransitionStatus(task, row.advance.status, viewer).ok : false;
      assert.equal(recipient.showAdvance, serverWouldAllow, `${rowName(row)}: ${viewer.displayName} tap would be accepted`);
    }
  }
});

await check("an observer who is neither party is offered no advance on any row", () => {
  for (const row of MATRIX) {
    const task = taskFor(row);
    const [recipient] = taskCardRecipients(task, [OBSERVER]);
    assert.equal(recipient.showAdvance, false, `${rowName(row)}: the observer gets nothing`);
    assert.equal(botAdvanceFor(task, OBSERVER), undefined, `${rowName(row)}: and neither does the shared gate`);
  }
});

// --- Surface 2: the note / chat DM card -------------------------------------

await check("the note card carries the advance button only for the party", () => {
  for (const row of MATRIX) {
    const task = taskFor(row);
    for (const viewer of VIEWERS) {
      const data = noteCardDataFromTask(task, viewer);
      const titles = actionTitles(noteCard(data));
      if (row.taskType === "FRAUD") {
        // A fraud card renders its own role-aware set; the generic advance is
        // never on it. Asserted here so the two button sets can't both appear.
        assert.equal(data.advance, undefined, `${rowName(row)}: fraud cards carry no generic advance`);
        assert.deepEqual(
          titles.filter((title) => title === "Merge Done" || title === "Approve Merge" || title === "Complete"),
          [],
          `${rowName(row)}: no standard-flow button leaks onto a fraud card`
        );
        continue;
      }
      const expected = isHolder(row, viewer) ? row.advance?.label : undefined;
      assert.equal(data.advance?.label, expected, `${rowName(row)}: note card advance for ${viewer.displayName}`);
      assert.equal(
        titles.includes(row.advance?.label ?? " "),
        Boolean(expected),
        `${rowName(row)}: rendered note card actions for ${viewer.displayName}`
      );
    }
  }
});

await check("the note card keeps its reply box for everyone it reaches", () => {
  /* The reply affordance is not an advance and is not party-gated: the card
     goes to the task's two parties, and a note is a conversation between them
     (`canAddNoteToTask`). It survives COMPLETED (#45) and dies at
     CANCELLED/ARCHIVED — that is a status rule, not a party one. */
  for (const row of MATRIX) {
    const task = taskFor(row);
    for (const viewer of VIEWERS) {
      const titles = actionTitles(noteCard(noteCardDataFromTask(task, viewer)));
      const expected = row.status !== "CANCELLED" && row.status !== "ARCHIVED";
      assert.equal(titles.includes("Reply"), expected, `${rowName(row)}: reply box for ${viewer.displayName}`);
    }
  }
});

// --- Surface 3: the claim / assign detail DM card ---------------------------

await check("the detail card renders the advance it is given, and nothing when given none", () => {
  /* `detailCard` is dumb by design — `syncDetailCards` decides per recipient and
     passes `advance` only when `showAdvance` is set AND the recipient carries no
     fraudActions. Both halves of that composition are asserted below. */
  const withButton = detailCard({ taskId: "task-1", title: "You claimed it", detail: "d", advance: { status: "MERGE_DONE", label: "Merge Done" } });
  assert.deepEqual(actionTitles(withButton), ["Merge Done"]);
  const without = detailCard({ taskId: "task-1", title: "You claimed it", detail: "d" });
  assert.deepEqual(actionTitles(without), []);
});

await check("a fraud recipient always carries fraudActions, so the detail card never shows a fraud move", () => {
  /* The deliberate rule (#39): a fraud task's forward move is note-required and
     lives on the chat card. `syncDetailCards` implements it by suppressing the
     advance for any recipient whose `fraudActions` key is present — which is
     every recipient of a fraud task, empty set or not. */
  for (const row of MATRIX.filter((entry) => entry.taskType === "FRAUD")) {
    const recipients = taskCardRecipients(taskFor(row), VIEWERS);
    for (const recipient of recipients) {
      assert.notEqual(recipient.fraudActions, undefined, `${rowName(row)}: ${recipient.userId} marked as a fraud recipient`);
      const detailShowsAdvance = recipient.showAdvance && recipient.fraudActions === undefined;
      assert.equal(detailShowsAdvance, false, `${rowName(row)}: the detail card stays buttonless`);
    }
  }
  // Non-fraud recipients carry no such key, so the same expression lets the
  // button through for the party.
  const loanDocs = taskCardRecipients(makeTask({ status: "MERGE_DONE" }), VIEWERS);
  assert.equal(loanDocs.every((recipient) => recipient.fraudActions === undefined), true);
  assert.deepEqual(
    loanDocs.filter((recipient) => recipient.showAdvance && recipient.fraudActions === undefined).map((r) => r.userId),
    [CREATOR.id],
    "at MERGE_DONE the detail card's Approve Merge reaches the creator alone"
  );
});

// --- Surface 4: the FRAUD role-aware set, unchanged --------------------------

await check("fraudActions stays seat-based and unchanged", () => {
  const claimed = makeTask({ taskType: "FRAUD", status: "CLAIMED" });
  assert.deepEqual(fraudCardActions(claimed, ASSIGNEE), [
    { kind: "transitionWithNote", label: "Send Items", targetStatus: "AWAITING_ITEMS" }
  ]);
  assert.deepEqual(fraudCardActions(claimed, CREATOR), []);
  assert.deepEqual(fraudCardActions(claimed, OBSERVER), []);

  const awaiting = makeTask({ taskType: "FRAUD", status: "AWAITING_ITEMS" });
  assert.deepEqual(fraudCardActions(awaiting, CREATOR), [
    { kind: "transition", label: "Submit", targetStatus: "PENDING_APPROVAL" }
  ]);
  assert.deepEqual(fraudCardActions(awaiting, ASSIGNEE), []);

  const pending = makeTask({ taskType: "FRAUD", status: "PENDING_APPROVAL" });
  assert.deepEqual(fraudCardActions(pending, ASSIGNEE), [
    { kind: "transition", label: "Approve", targetStatus: "COMPLETED" },
    { kind: "transitionWithNote", label: "Send Back", targetStatus: "AWAITING_ITEMS" }
  ]);
  assert.deepEqual(fraudCardActions(pending, CREATOR), [{ kind: "release", label: "Release for any fraud checker" }]);
  assert.deepEqual(fraudCardActions(pending, OBSERVER), []);

  // A checker who has lost the role vacates the seat — and loses the button on
  // both the fraud set and the underlying gate.
  const demoted = { ...ASSIGNEE, roles: ["LOAN_OFFICER"] };
  assert.deepEqual(fraudCardActions(claimed, demoted), []);
  assert.equal(botAdvanceFor(claimed, demoted), undefined);
});

// --- Surface 5: the claim / assign DM send ----------------------------------

const notifierSetup = () => {
  const sent = [];
  const synced = [];
  const botClient = {
    sendTrackedDetailCard: async (userIds, detail) => {
      sent.push({ userIds, detail });
    },
    sendDetailCardToUsers: async (userIds, detail) => {
      sent.push({ userIds, detail });
    },
    syncTaskCards: async (opts) => {
      synced.push(opts);
    },
    sendToDms: async () => {}
  };
  const directory = new Map(VIEWERS.map((user) => [user.id, user]));
  const notifier = new TeamsNotificationProvider(
    botClient,
    { isEnabled: () => false, sendToUsers: async () => {} },
    { getNotificationChannelId: async () => "channel-1" },
    async (userId) => directory.get(userId)
  );
  return { notifier, sent, synced };
};

const dmEvent = (task, target, recipientUserIds) => ({
  type: "TASK_ASSIGNED",
  task,
  actor: CREATOR,
  message: "handed to you",
  target,
  recipientUserIds,
  createdAt: new Date().toISOString()
});

await check("the claim DM card offers the claimer the step that is theirs", async () => {
  const { notifier, sent } = notifierSetup();
  await notifier.notify(dmEvent(makeTask({ status: "CLAIMED" }), "DM_CLAIM", [ASSIGNEE.id]));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].detail.advance?.label, "Merge Done", "the claimer is the assignee and gets their own rung");
});

await check("a handoff mid-merge doesn't hand the creator's Approve Merge to the new assignee", async () => {
  /* The cell this pass turned up: a handoff can point a task at somebody
     mid-flow, and the advance used to be computed once from the task with no
     viewer. A task handed on at MERGE_DONE greeted its new assignee with the
     creator's Approve Merge button. */
  const { notifier, sent } = notifierSetup();
  await notifier.notify(dmEvent(makeTask({ status: "MERGE_DONE" }), "DM_ASSIGN", [ASSIGNEE.id]));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].detail.advance, undefined, "the new assignee is not offered the creator's approval");
  // Still a useful card: it says what happened and carries the task's details.
  assert.equal(sent[0].detail.title.includes("assigned"), true, "the card still says what happened");
  assert.match(sent[0].detail.detail, /Type: Loan Docs/, "and still carries the task's details");
});

await check("the sync at MERGE_DONE re-arms the creator's card and only the creator's", async () => {
  /* The other half of the acceptance criterion, through the notifier rather
     than the pure rule: DM_CARD_SYNC is what re-renders both parties' existing
     cards when a task moves, so it is where Approve Merge actually reaches the
     creator. */
  const { notifier, synced } = notifierSetup();
  await notifier.notify({
    type: "TASK_STATUS_CHANGED",
    task: makeTask({ status: "MERGE_DONE" }),
    actor: ASSIGNEE,
    message: "sync",
    target: "DM_CARD_SYNC",
    createdAt: new Date().toISOString()
  });
  assert.equal(synced.length, 1);
  assert.equal(synced[0].advance?.label, "Approve Merge", "the flow's next step");
  assert.deepEqual(
    synced[0].recipients.filter((recipient) => recipient.showAdvance).map((recipient) => recipient.userId),
    [CREATOR.id],
    "and it is rendered for the creator alone"
  );
});

await check("the share card offers no move to anyone", async () => {
  const { notifier, sent } = notifierSetup();
  await notifier.notify(dmEvent(makeTask({ status: "MERGE_DONE" }), "DM_SHARE", [OBSERVER.id]));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].detail.advance, undefined, "a share card never offers a move");
});

console.log(`\n${passed} checks passed`);
