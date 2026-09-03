#!/usr/bin/env node
/*
 * A step button carries the text typed in its box (#250).
 *
 * The bot's task card holds two things: a box to type into and the button for
 * the next step. Reply posted what you typed; every step button — Approve
 * Merge, Complete, Merge Done, Release, the fraud Approve — took the step and
 * threw the sentence away without a word. "Approving, with these fixes…" landed
 * as a bare approval and the person who wrote it had no way to tell.
 *
 * The fix is one rule at the bot's card-action handler, uniform across buttons:
 * a tap carrying non-empty text from the conversation box posts that text as a
 * note first, through the same path the Reply button uses, and only then takes
 * the step. A note that can't be posted aborts the step — taking the step and
 * dropping the words would be the same bug with an extra message.
 *
 * What's asserted here, over a real TeamsBotClient with the connector stubbed
 * and the task service stubbed by an in-memory task that records the order it
 * was touched in:
 *   1. A step button with text posts the note, then takes the step.
 *   2. The order is note-then-step, in the task's own history.
 *   3. The confirmation card says both happened.
 *   4. An empty box, and a whitespace-only box, behave exactly as today.
 *   5. The fraud Approve and the Release button carry text the same way.
 *   6. A note-required fraud move honours both boxes, and dedupes identical text.
 *   7. A refused note refuses the step too, leaving the status alone.
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

const CREATOR = { id: "aad-creator", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] };
const ASSIGNEE = { id: "aad-assignee", displayName: "Sam Officer", roles: ["LOAN_OFFICER", "FILE_CHECKER"] };

/* The two shapes an invoke response comes back in: a refreshed card, and the
   plain toast a refusal returns. */
const confirmText = (response) => response.body?.value?.body?.[0]?.text;
const toastText = (response) => response.body?.value;
/* What the conversation reads, one line per note: who said it and what. */
const conversation = (task) => task.reviewNotes.map((note) => `${note.by.displayName}: ${note.text}`);

/* An in-memory task plus the two service calls the bot is wired to, recording
   every touch in one list so the *order* of note and status change is a fact
   the test can read rather than an assumption. */
const world = (over = {}) => {
  const task = {
    id: "task-1",
    folderName: "Smith-1042",
    taskType: "LOAN_DOCS",
    status: "MERGE_DONE",
    createdBy: { id: CREATOR.id, displayName: CREATOR.displayName },
    assignee: { id: ASSIGNEE.id, displayName: ASSIGNEE.displayName },
    reviewNotes: [],
    ...over
  };
  const history = [];
  const users = new Map([
    [CREATOR.id, CREATOR],
    [ASSIGNEE.id, ASSIGNEE]
  ]);
  const state = {
    task,
    history,
    /* Set to a message to make the note path refuse, the way the service
       refuses a note on a task that is closed to notes. */
    refuseNote: undefined,
    reviewNotesSeen: [],
    resynced: []
  };

  const resolveUser = async (aadObjectId) => users.get(aadObjectId);

  const addNote = async (taskId, text, user) => {
    if (state.refuseNote) {
      throw new Error(state.refuseNote);
    }
    task.reviewNotes.push({ id: `note-${task.reviewNotes.length + 1}`, by: { id: user.id, displayName: user.displayName }, text, createdAt: new Date().toISOString() });
    history.push({ kind: "NOTE", text, author: user.displayName });
    return task;
  };

  const transition = async (taskId, status, user, reviewNotes) => {
    task.status = status;
    state.reviewNotesSeen.push(reviewNotes);
    history.push({ kind: "STATUS", status, author: user.displayName });
    return task;
  };

  const release = async (taskId, user) => {
    task.assignee = undefined;
    history.push({ kind: "RELEASE", author: user.displayName });
    return task;
  };

  return { state, resolveUser, addNote, transition, release };
};

const botSetup = async (over) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "card-note-carry-sim-"));
  const dataFile = path.join(dir, "bot-references.json");
  await fs.writeFile(dataFile, "[]", "utf8");

  const client = new TeamsBotClient("app-id", "app-password", undefined, dataFile);
  await client.init();
  client.adapter.createConnectorClient = () => ({
    conversations: {
      createConversation: async () => ({ id: "19:thread-1", activityId: "activity-1" }),
      updateActivity: async () => ({ id: "activity-1" }),
      sendToConversation: async () => ({ id: "activity-reply" }),
      deleteActivity: async () => {}
    }
  });

  const { state, resolveUser, addNote, transition, release } = world(over);
  client.setNoteReplyHandler(resolveUser, addNote);
  client.setTransitionHandler(resolveUser, transition);
  client.setReleaseHandler(resolveUser, release);
  client.setCardResync(async (taskId) => {
    state.resynced.push(taskId);
  });

  const tap = (verb, data, user) =>
    client.bot.onInvokeActivity({
      activity: {
        type: "invoke",
        name: "adaptiveCard/action",
        conversation: { id: "19:dm-1", conversationType: "personal" },
        from: { id: "29:tapper", aadObjectId: user.id, name: user.displayName },
        recipient: { id: "29:bot" },
        serviceUrl: "https://example.invalid",
        value: { action: { verb, data: { taskId: "task-1", ...data } } }
      }
    });

  return { client, state, tap };
};

console.log("A step button carries the box's text (#250)");

await check("Approve Merge with text posts the note and takes the step", async () => {
  const { state, tap } = await botSetup();
  await tap("transitionTask", { targetStatus: "MERGE_APPROVED", replyText: "approving, with these fixes" }, CREATOR);

  assert.deepEqual(
    conversation(state.task),
    ["Dana Requester: approving, with these fixes"],
    "the sentence is on the task as an ordinary note, attributed to whoever tapped"
  );
  assert.equal(state.task.status, "MERGE_APPROVED", "and the step still happened");
  assert.equal(
    state.reviewNotesSeen.at(-1),
    undefined,
    "the text is posted as a note, not smuggled into the transition's own note argument"
  );
});

await check("the note is recorded before the status change", async () => {
  const { state, tap } = await botSetup();
  await tap("transitionTask", { targetStatus: "MERGE_APPROVED", replyText: "conditions attached" }, CREATOR);

  assert.deepEqual(
    state.history.map((entry) => entry.kind),
    ["NOTE", "STATUS"],
    "the caveat precedes the approval it qualifies"
  );
});

await check("the confirmation card says the note posted as well as the step", async () => {
  const { tap } = await botSetup();
  const response = await tap("transitionTask", { targetStatus: "MERGE_APPROVED", replyText: "with fixes" }, CREATOR);
  const text = confirmText(response);

  assert.match(text, /Note posted\./, "the tapper can see the text landed");
  assert.match(text, /Smith-1042 is now/, "alongside the step's own confirmation");
});

await check("an empty box behaves exactly as today", async () => {
  const { state, tap } = await botSetup();
  const response = await tap("transitionTask", { targetStatus: "MERGE_APPROVED" }, CREATOR);

  assert.deepEqual(state.task.reviewNotes, [], "no empty note in the conversation");
  assert.deepEqual(state.history.map((entry) => entry.kind), ["STATUS"]);
  assert.equal(state.task.status, "MERGE_APPROVED");
  assert.doesNotMatch(confirmText(response), /Note posted/, "one confirmation, not two");
});

await check("a whitespace-only box counts as empty", async () => {
  const { state, tap } = await botSetup();
  const response = await tap("transitionTask", { targetStatus: "MERGE_APPROVED", replyText: "  \n \t " }, CREATOR);

  assert.deepEqual(state.task.reviewNotes, [], "no blank note");
  assert.equal(state.task.status, "MERGE_APPROVED");
  assert.doesNotMatch(confirmText(response), /Note posted/);
});

await check("Merge Done from the assignee carries text the same way", async () => {
  const { state, tap } = await botSetup({ status: "CLAIMED" });
  await tap("transitionTask", { targetStatus: "MERGE_DONE", replyText: "merged, but the trust docs are outstanding" }, ASSIGNEE);

  assert.deepEqual(conversation(state.task), ["Sam Officer: merged, but the trust docs are outstanding"]);
  assert.equal(state.task.status, "MERGE_DONE");
});

await check("a fraud Approve carries text", async () => {
  const { state, tap } = await botSetup({ taskType: "FRAUD", status: "PENDING_APPROVAL" });
  await tap("transitionTask", { targetStatus: "COMPLETED", replyText: "approved, watch this next time" }, ASSIGNEE);

  assert.equal(state.task.reviewNotes.at(-1).text, "approved, watch this next time");
  assert.equal(state.task.status, "COMPLETED");
  assert.deepEqual(state.history.map((entry) => entry.kind), ["NOTE", "STATUS"]);
});

await check("Release for any fraud checker carries text", async () => {
  const { state, tap } = await botSetup({ taskType: "FRAUD", status: "PENDING_APPROVAL" });
  const response = await tap("releaseTask", { replyText: "handing this back, no capacity today" }, ASSIGNEE);

  assert.equal(state.task.reviewNotes.at(-1).text, "handing this back, no capacity today");
  assert.deepEqual(state.history.map((entry) => entry.kind), ["NOTE", "RELEASE"]);
  assert.match(confirmText(response), /Note posted\./);
  assert.match(confirmText(response), /up for grabs/);
});

await check("a note-required fraud move honours both boxes", async () => {
  const { state, tap } = await botSetup({ taskType: "FRAUD", status: "CLAIMED" });
  await tap(
    "transitionWithNote",
    { targetStatus: "AWAITING_ITEMS", fraudNote: "need the 2023 return", replyText: "also, ring them first" },
    ASSIGNEE
  );

  assert.deepEqual(
    state.task.reviewNotes.map((note) => note.text),
    ["also, ring them first"],
    "the conversation box posts as a note"
  );
  assert.equal(state.reviewNotesSeen.at(-1), "need the 2023 return", "and the required note still rides in as the transition's note");
  assert.equal(state.task.status, "AWAITING_ITEMS");
});

await check("identical text in both boxes results in one note, not two", async () => {
  const { state, tap } = await botSetup({ taskType: "FRAUD", status: "CLAIMED" });
  await tap(
    "transitionWithNote",
    { targetStatus: "AWAITING_ITEMS", fraudNote: "need the 2023 return", replyText: "need the 2023 return" },
    ASSIGNEE
  );

  assert.deepEqual(state.task.reviewNotes, [], "the required note is the only note the move makes");
  assert.equal(state.reviewNotesSeen.at(-1), "need the 2023 return");
  assert.equal(state.task.status, "AWAITING_ITEMS");
});

await check("a refused note refuses the step and leaves the status alone", async () => {
  const { state, tap } = await botSetup();
  state.refuseNote = "This task is closed to notes.";

  const response = await tap("transitionTask", { targetStatus: "MERGE_APPROVED", replyText: "conditions attached" }, CREATOR);

  assert.equal(state.task.status, "MERGE_DONE", "the task did not move");
  assert.deepEqual(state.history, [], "and nothing was recorded");
  assert.match(toastText(response), /closed to notes/, "the tap returns the note's own error sentence");
});

await check("a refused note repairs the card, like any other refused tap", async () => {
  const { state, tap } = await botSetup();
  // Notes are closed only on statuses whose card carries neither a box nor a
  // step button, so this tap can only have come from a card that never got its
  // in-place edit. Self-repair is exactly what the stale-card path is for.
  state.refuseNote = "This task is closed to notes.";

  const response = await tap("transitionTask", { targetStatus: "MERGE_APPROVED", replyText: "conditions attached" }, CREATOR);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(state.resynced, ["task-1"], "the stale card is re-synced");
  assert.match(toastText(response), /Refreshing this card\./);
});

await check("a refused note refuses a release too", async () => {
  const { state, tap } = await botSetup({ taskType: "FRAUD", status: "PENDING_APPROVAL" });
  state.refuseNote = "This task is closed to notes.";

  await tap("releaseTask", { replyText: "handing this back" }, ASSIGNEE);

  assert.equal(state.task.assignee?.id, ASSIGNEE.id, "the seat was not vacated");
  assert.deepEqual(state.history, []);
});

await check("the Reply button is unchanged — one note, no double post", async () => {
  const { state, tap } = await botSetup();
  await tap("replyNote", { replyText: "just a note" }, CREATOR);

  assert.deepEqual(state.task.reviewNotes.map((note) => note.text), ["just a note"]);
  assert.deepEqual(state.history.map((entry) => entry.kind), ["NOTE"]);
});

await check("a refused Reply is unchanged — its own sentence, no card repair", async () => {
  const { state, tap } = await botSetup();
  state.refuseNote = "This task is closed to notes.";

  const response = await tap("replyNote", { replyText: "just a note" }, CREATOR);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(toastText(response), "This task is closed to notes.");
  assert.deepEqual(state.resynced, [], "Reply's refusal path is left alone");
});

await check("a Teams card refresh posts nothing", async () => {
  const { client, state, tap } = await botSetup();
  client.setTaskLookup(async () => state.task);
  await tap("refreshTaskCard", { replyText: "typed but not sent" }, CREATOR);

  assert.deepEqual(state.task.reviewNotes, [], "an auto-refresh is not a tap on a step button");
});

console.log(`\n${passed} checks passed`);
