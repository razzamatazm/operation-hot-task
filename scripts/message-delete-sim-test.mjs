#!/usr/bin/env node
/*
 * Delete your own message, leaving a tombstone (#288, ADR-0009 rule 4).
 *
 * The delete path end to end, driven against the real `TaskService` over a real
 * (temp-file) `TaskStore` with a recording notifier, plus the real web thread
 * rendered to markup — the same arrangement as `message-edit-sim-test.mjs`,
 * because this is that ticket's other half and the two must stay one rule.
 *
 * The promises under test are the ones a reader of the code cannot check by
 * looking:
 *
 *   - **Author only** (rule 1), enforced in the service. The other party, an
 *     observer and an admin are all refused, and the menu the web draws comes
 *     off the same function.
 *   - **No window, archival is the gate** (rule 2). Open, claimed and completed
 *     tasks take a delete; an archived one refuses it.
 *   - **A tombstone, and one way** (rule 4). A muted `Message deleted` row that
 *     keeps its author and its place; no undelete, no editing one back into a
 *     message, and the withdrawn words are gone from the record the API serves.
 *   - **A tombstone counts as a message.** The thread's length is unchanged, so
 *     the collapsed row's reply count includes it, and a thread holding only a
 *     tombstone does not claim to be empty.
 *   - **The label survives** (rule 5): a withdrawn send-back reads
 *     `Needs fixes: message deleted`.
 *   - **Silence** (rule 6): no DM, no feed ping, no channel post; `updatedAt`
 *     unmoved so the task holds its place in the done list and the archive; and
 *     the DM cards refreshed in place through the silent sync, quoting the
 *     tombstone rather than the words or a blank.
 *   - **Unread** (rule 6): a withdrawn message is not something to read. The
 *     signal clears for a viewer who had nothing else outstanding, and a
 *     tombstone is never itself unread — decided inside the one shared function
 *     that owns the rule.
 *   - **History carries the withdrawn text** (rule 7), and is the only place it
 *     survives.
 *
 * Run: `node --test scripts/message-delete-sim-test.mjs`.
 */
import assert from "node:assert/strict";
import { promises as fsp, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path, { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ACTION_LABELS } from "../packages/shared/dist/labels.js";
import { REVIEW_NOTE_DELETED_ACTION } from "../packages/shared/dist/history.js";
import {
  MESSAGE_DELETED_BODY,
  MESSAGE_EDITED_MARKER,
  canDeleteMessage,
  canEditMessage,
  deleteMessageInThread,
  hasUnreadNoteForViewer,
  messageDeleteRefusal,
  noteBodyText,
  unreadNoteFor
} from "../packages/shared/dist/notes.js";
import { TaskStore } from "../apps/server/dist/store.js";
import { SseHub } from "../apps/server/dist/sse.js";
import { TaskService } from "../apps/server/dist/task-service.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/* The thread is TSX with a relative import, so esbuild bundles it into
   something node can load and the promise about what a tombstone LOOKS like is
   checked against real markup rather than described in a comment. */
const scratch = mkdtempSync(join(REPO, "node_modules", ".message-delete-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const threadModule = join(scratch, "thread.mjs");
await build({
  entryPoints: [join(REPO, "apps/web/src/thread.tsx")],
  outfile: threadModule,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  external: ["react", "react/jsx-runtime", "@loan-tasks/shared"],
  logLevel: "silent"
});
const { ThreadMessages } = await import(pathToFileURL(threadModule).href);

const { recentNoteThread } = await import(pathToFileURL(join(REPO, "apps/server/dist/bot.js")).href);

const CREATOR = { id: "creator-1", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] };
const ASSIGNEE = { id: "checker-1", displayName: "Casey Checker", roles: ["LOAN_OFFICER", "FILE_CHECKER"] };
const OBSERVER = { id: "observer-1", displayName: "Sam Bystander", roles: ["LOAN_OFFICER"] };
const ADMIN = { id: "admin-1", displayName: "Alex Admin", roles: ["ADMIN"] };

const CONFIG = {
  businessTimezone: "America/Los_Angeles",
  businessStartHour: 8,
  businessStartMinute: 30,
  businessEndHour: 17,
  businessEndMinute: 30,
  archiveRetentionDays: 90
};

const setup = async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "message-delete-sim-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.init();
  const events = [];
  const service = new TaskService(
    store,
    { notify: async (event) => { events.push(event); }, canReachDm: async () => true },
    new SseHub(),
    CONFIG
  );
  return { service, store, events };
};

/* A claimed VALUE task with one message on it from `author`, and every
   notification the setting-up generated already drained — so anything left in
   `events` after a delete was generated BY the delete. */
const taskWithMessage = async (service, events, { author = CREATOR, text = "Comps look thin." } = {}) => {
  const task = await service.createTask(
    { folderName: "Smith-1042", taskType: "VALUE", notes: "Please value this.", urgency: "GREEN" },
    CREATOR
  );
  await service.claimTask(task.id, ASSIGNEE);
  const withNote = await service.addReviewNote(task.id, text, author);
  await service.settleBackgroundWork();
  events.length = 0;
  return { taskId: task.id, message: withNote.reviewNotes[0] };
};

const rejects = (fn, pattern, label) =>
  assert.rejects(fn, (error) => {
    assert.match(error.message, pattern, `${label}: the refusal names the rule (got "${error.message}")`);
    return true;
  }, label);

const renderThread = (task, viewerId, handlers = {}) =>
  renderToStaticMarkup(
    createElement(ThreadMessages, { task, viewerId, canReply: true, ...handlers })
  );

const handlers = { onEditMessage: async () => {}, onDeleteMessage: async () => {} };
const triggerCount = (markup) => (markup.match(/msg-menu-trigger/g) ?? []).length;

/* ── The author, and only the author (rule 1) ────────────────────────────── */

test("the author can withdraw their own message", async () => {
  const { service, events } = await setup();
  const { taskId, message } = await taskWithMessage(service, events);

  const updated = await service.deleteReviewNote(taskId, message.id, CREATOR);
  const [tombstone] = updated.reviewNotes;

  assert.equal(tombstone.deleted, true, "the row is a tombstone");
  assert.equal(tombstone.id, message.id, "and it is still the same row");
  assert.equal(tombstone.by.displayName, CREATOR.displayName, "keeping the author's name");
  assert.equal(tombstone.at, message.at, "and its place in the thread");
  assert.equal(tombstone.text, "", "the words are gone from the record the API serves");
  assert.equal(noteBodyText(tombstone), MESSAGE_DELETED_BODY, "and the row reads as the app's words");
});

test("the other party, an observer and an admin are all refused by the service", async () => {
  const { service, events } = await setup();
  const { taskId, message } = await taskWithMessage(service, events);

  for (const stranger of [ASSIGNEE, OBSERVER, ADMIN]) {
    await rejects(
      () => service.deleteReviewNote(taskId, message.id, stranger),
      /Only the person who wrote/,
      stranger.displayName
    );
  }

  /* ADR-0003 again: back-end access confers nothing over other people's work,
     and the admin refusal is that sentence rather than a missing role check. */
  const stored = await service.store.findTask(taskId);
  assert.equal(stored.reviewNotes[0].deleted, undefined, "nothing they sent landed");
  assert.equal(stored.reviewNotes[0].text, "Comps look thin.", "and the message still says what it said");
});

test("the refusal and the menu read the same rule, and it is the edit's rule", () => {
  /* Edit and delete are one permission asked twice. Two copies of it is how you
     end up with a message you can delete but not edit. */
  const task = { status: "CLAIMED" };
  const mine = { by: { id: CREATOR.id, displayName: CREATOR.displayName } };
  assert.equal(canDeleteMessage(task, mine, CREATOR), true);
  assert.equal(messageDeleteRefusal(task, mine, CREATOR), undefined);
  assert.equal(canDeleteMessage(task, mine, ASSIGNEE), false);
  assert.ok(messageDeleteRefusal(task, mine, ASSIGNEE));
  assert.equal(canDeleteMessage({ status: "ARCHIVED" }, mine, CREATOR), false);
  for (const status of ["OPEN", "CLAIMED", "NEEDS_REVIEW", "COMPLETED", "ARCHIVED"]) {
    assert.equal(
      canDeleteMessage({ status }, mine, CREATOR),
      canEditMessage({ status }, mine, CREATOR),
      `${status}: the two halves of the menu agree about who and when`
    );
  }
});

/* ── No window; archival is the gate (rule 2) ────────────────────────────── */

test("an open, a claimed and a completed task all take a delete", async () => {
  const { service, events } = await setup();

  const open = await service.createTask(
    { folderName: "Open-1", taskType: "VALUE", notes: "ask", urgency: "GREEN" },
    CREATOR
  );
  const openNoted = await service.addReviewNote(open.id, "first thought", CREATOR);
  await service.settleBackgroundWork();
  const openDeleted = await service.deleteReviewNote(open.id, openNoted.reviewNotes[0].id, CREATOR);
  assert.equal(openDeleted.status, "OPEN", "the status is untouched by the delete");
  assert.equal(openDeleted.reviewNotes[0].deleted, true);

  const { taskId, message } = await taskWithMessage(service, events);
  const claimedDeleted = await service.deleteReviewNote(taskId, message.id, CREATOR);
  assert.equal(claimedDeleted.status, "CLAIMED");
  assert.equal(claimedDeleted.reviewNotes[0].deleted, true);

  /* A completed task's conversation is deliberately still open — a message can
     be posted to one — so refusing to withdraw one would not be a defensible
     pair of rules. */
  const second = await service.addReviewNote(taskId, "a later thought", CREATOR);
  await service.transitionStatus(taskId, "COMPLETED", ASSIGNEE);
  await service.settleBackgroundWork();
  const completedDeleted = await service.deleteReviewNote(taskId, second.reviewNotes[1].id, CREATOR);
  assert.equal(completedDeleted.status, "COMPLETED", "still completed");
  assert.equal(completedDeleted.reviewNotes[1].deleted, true);
});

test("an archived task refuses a delete, as it already refuses new messages", async () => {
  const { service, events } = await setup();
  const { taskId, message } = await taskWithMessage(service, events);
  await service.transitionStatus(taskId, "COMPLETED", ASSIGNEE);
  await service.transitionStatus(taskId, "ARCHIVED", CREATOR);
  await service.settleBackgroundWork();

  await rejects(() => service.deleteReviewNote(taskId, message.id, CREATOR), /archived/i, "an archived task");
  await rejects(() => service.addReviewNote(taskId, "too late", CREATOR), /closed/i, "and so does a new message");
});

test("a message posted six weeks ago is as withdrawable as one posted a minute ago", async () => {
  const { service, store, events } = await setup();
  const { taskId, message } = await taskWithMessage(service, events);

  const longAgo = new Date(Date.now() - 42 * 86400000).toISOString();
  await store.updateTask(taskId, (current) => ({
    task: { ...current, reviewNotes: current.reviewNotes.map((note) => ({ ...note, at: longAgo })) }
  }));

  const updated = await service.deleteReviewNote(taskId, message.id, CREATOR);
  assert.equal(updated.reviewNotes[0].deleted, true, "no window closed behind it");
  assert.equal(updated.reviewNotes[0].at, longAgo, "and the tombstone sits where the message did");
});

/* ── One way (rule 4) ────────────────────────────────────────────────────── */

test("a tombstone cannot be edited back into a message, and cannot be deleted twice", async () => {
  const { service, events } = await setup();
  const { taskId, message } = await taskWithMessage(service, events);
  await service.deleteReviewNote(taskId, message.id, CREATOR);
  await service.settleBackgroundWork();
  events.length = 0;

  await rejects(
    () => service.editReviewNote(taskId, message.id, "actually, what I meant was", CREATOR),
    /deleted message cannot be edited/i,
    "editing a tombstone"
  );
  await rejects(
    () => service.deleteReviewNote(taskId, message.id, CREATOR),
    /already been deleted/i,
    "deleting it again"
  );

  const stored = await service.store.findTask(taskId);
  assert.equal(stored.reviewNotes[0].text, "", "nothing was written back into it");
  assert.equal(stored.reviewNotes.length, 1, "and no second row appeared");
  assert.equal(events.length, 0, "a refusal is not an act: no resync went out");
});

test("the pure transform is what guarantees the tombstone's shape", () => {
  const thread = [
    { id: "a", text: "one", by: { id: CREATOR.id, displayName: "Dana" }, at: "2026-08-01T00:00:00.000Z" },
    {
      id: "b",
      label: ACTION_LABELS.NEEDS_FIXES,
      text: "two",
      edited: true,
      by: { id: ASSIGNEE.id, displayName: "Casey" },
      at: "2026-08-02T00:00:00.000Z"
    }
  ];
  const after = deleteMessageInThread(thread, "b");
  assert.equal(after[0], thread[0], "an untouched message is the same object");
  assert.deepEqual(after[1], {
    id: "b",
    label: ACTION_LABELS.NEEDS_FIXES,
    text: "",
    by: { id: ASSIGNEE.id, displayName: "Casey" },
    at: "2026-08-02T00:00:00.000Z",
    deleted: true
  });
  assert.equal(after[1].edited, undefined, "and the (edited) marker goes with the words it annotated");
  assert.equal(deleteMessageInThread(after, "b")[1], after[1], "a second delete rewrites nothing");
  assert.equal(after.length, thread.length, "the row stays: a delete removes nothing from the list");
});

/* ── A tombstone counts as a message (rule 4) ────────────────────────────── */

test("the thread keeps its length, so the reply count includes the tombstone", async () => {
  const { service, events } = await setup();
  const { taskId, message } = await taskWithMessage(service, events);
  await service.addReviewNote(taskId, "and the roof needs a look", ASSIGNEE);
  await service.settleBackgroundWork();

  const before = await service.store.findTask(taskId);
  const after = await service.deleteReviewNote(taskId, message.id, CREATOR);

  /* The collapsed row counts `reviewNotes.length` (`reviewCount` in App.tsx),
     so a delete that removed the row would silently drop the count by one. */
  assert.equal(after.reviewNotes.length, before.reviewNotes.length, "two messages before, two rows after");
  assert.equal(after.reviewNotes[0].deleted, true, "the first is the tombstone");
  assert.equal(after.reviewNotes[1].text, "and the roof needs a look", "and the second is untouched");
});

/* ── What the thread shows (rules 4 and 9) ───────────────────────────────── */

const threadTask = (notes, status = "CLAIMED") => ({
  taskType: "VALUE",
  status,
  notes: "Please value this.",
  createdBy: { id: CREATOR.id, displayName: CREATOR.displayName },
  createdAt: "2026-08-20T09:00:00.000Z",
  reviewNotes: notes
});

const TOMBSTONE = {
  id: "m1",
  text: "",
  deleted: true,
  by: { id: CREATOR.id, displayName: CREATOR.displayName },
  at: "2026-08-20T10:00:00.000Z"
};
const THEIRS = {
  id: "m2",
  text: "Agreed, re-pulling them.",
  by: { id: ASSIGNEE.id, displayName: ASSIGNEE.displayName },
  at: "2026-08-20T11:00:00.000Z"
};

test("a thread holding only a tombstone does not claim to be empty", () => {
  /* An LOI, because its request field has left the thread (ADR-0008), so the
     tombstone really is the only row and the empty state is genuinely in play. */
  const task = {
    taskType: "LOI",
    status: "CLAIMED",
    notes: "Loan terms here.",
    createdBy: { id: CREATOR.id, displayName: CREATOR.displayName },
    createdAt: "2026-08-20T09:00:00.000Z",
    reviewNotes: [TOMBSTONE]
  };
  const markup = renderThread(task, CREATOR.id, handlers);
  assert.ok(markup.includes(MESSAGE_DELETED_BODY), "the tombstone is on screen");
  assert.ok(!markup.includes("No messages yet"), "so the conversation does not also say it is empty");

  const empty = renderThread({ ...task, reviewNotes: [] }, CREATOR.id, handlers);
  assert.ok(empty.includes("No messages yet"), "an actually-empty thread still says so");
});

test("a tombstone renders muted, named, and in its original position", () => {
  const markup = renderThread(threadTask([TOMBSTONE, THEIRS]), CREATOR.id, handlers);
  assert.ok(markup.includes(MESSAGE_DELETED_BODY), "it says what happened");
  assert.match(markup, /msg-deleted/, "in the muted treatment, not as an ordinary message");
  assert.ok(
    markup.indexOf(MESSAGE_DELETED_BODY) < markup.indexOf("Agreed, re-pulling them."),
    "and it holds its place above the reply that followed it"
  );
  /* The name is what makes the gap legible (rule 4). It rides the row exactly
     as it does on every other message: the avatar's initials, the row's title
     and its visually-hidden byline. */
  assert.ok(markup.includes(CREATOR.displayName), "the author's name is on the row");
  assert.ok(markup.includes(">DR<"), "including the initials every message row wears");
  assert.ok(!markup.includes(MESSAGE_EDITED_MARKER), "a tombstone is not an edited message");
});

test("a tombstone offers no menu — no undelete, and no way to edit it back", () => {
  const asAuthor = renderThread(threadTask([TOMBSTONE, THEIRS]), CREATOR.id, handlers);
  assert.equal(triggerCount(asAuthor), 0, "the author's own tombstone carries no control");
  assert.ok(!asAuthor.includes(">Edit<"), "nothing offering to edit it");
  assert.ok(!asAuthor.includes("Undelete"), "and nothing offering to bring it back");

  /* The live message beside it still has its menu, so the absence above is the
     tombstone's state and not the menu having gone missing. */
  const asOther = renderThread(threadTask([TOMBSTONE, THEIRS]), ASSIGNEE.id, handlers);
  assert.equal(triggerCount(asOther), 1, "their own live message still has one");
});

test("a live message of your own offers Delete beside Edit", () => {
  const mine = { ...THEIRS, by: { id: CREATOR.id, displayName: CREATOR.displayName } };
  const markup = renderThread(threadTask([mine]), CREATOR.id, handlers);
  assert.equal(triggerCount(markup), 1, "one menu on the one message the viewer wrote");
  const readOnly = renderThread(threadTask([mine]), CREATOR.id, {});
  assert.equal(triggerCount(readOnly), 0, "and a surface with nothing to save to draws none");
});

/* ── The label survives (rule 5) ─────────────────────────────────────────── */

test("withdrawing an app-prefixed message leaves `Needs fixes: message deleted`", async () => {
  const { service, events } = await setup();
  const task = await service.createTask(
    { folderName: "Jones-77", taskType: "LOI", notes: "terms attached", urgency: "GREEN" },
    CREATOR
  );
  await service.claimTask(task.id, ASSIGNEE);
  const sent = await service.transitionStatus(task.id, "NEEDS_REVIEW", ASSIGNEE, "borrower name is misspelt");
  await service.settleBackgroundWork();
  events.length = 0;

  const sendBack = sent.reviewNotes[0];
  assert.equal(sendBack.label, ACTION_LABELS.NEEDS_FIXES, "the app wrote the label");

  const after = await service.deleteReviewNote(task.id, sendBack.id, ASSIGNEE);
  const tombstone = after.reviewNotes[0];
  assert.equal(tombstone.label, ACTION_LABELS.NEEDS_FIXES, "the delete did not reach the label");
  assert.equal(
    noteBodyText(tombstone),
    `${ACTION_LABELS.NEEDS_FIXES}: message deleted`,
    "so the row still records that a hand-back happened"
  );

  const markup = renderThread(
    {
      taskType: "LOI",
      status: "NEEDS_REVIEW",
      notes: "terms attached",
      createdBy: { id: CREATOR.id, displayName: CREATOR.displayName },
      createdAt: "2026-08-20T09:00:00.000Z",
      reviewNotes: after.reviewNotes
    },
    ASSIGNEE.id,
    handlers
  );
  assert.ok(markup.includes(`${ACTION_LABELS.NEEDS_FIXES}: message deleted`), "and reads that way on screen");
});

/* ── Silence, on every channel (rule 6) ──────────────────────────────────── */

test("a delete sends no DM, no feed ping and no channel post — only the silent card refresh", async () => {
  const { service, events } = await setup();
  const { taskId, message } = await taskWithMessage(service, events);

  await service.deleteReviewNote(taskId, message.id, CREATOR);
  await service.settleBackgroundWork();

  const targets = events.map((event) => event.target);
  assert.deepEqual(targets, ["DM_CARD_SYNC"], `the only thing that goes out is the quiet resync (got ${targets.join(", ")})`);
  for (const target of targets) {
    assert.ok(!target.startsWith("CHANNEL"), "nothing reaches the channel");
    assert.notEqual(target, "ACTIVITY_FEED", "nothing reaches the activity feed");
    assert.notEqual(target, "DM_NOTE", "and nobody is DMed about it");
  }
});

test("the task does not move in the done list or the archive", async () => {
  const { service, store, events } = await setup();
  const { taskId, message } = await taskWithMessage(service, events);
  await service.transitionStatus(taskId, "COMPLETED", ASSIGNEE);
  await service.settleBackgroundWork();

  const later = await service.createTask(
    { folderName: "Later-9", taskType: "VALUE", notes: "ask", urgency: "GREEN" },
    CREATOR
  );
  await service.claimTask(later.id, ASSIGNEE);
  await service.transitionStatus(later.id, "COMPLETED", ASSIGNEE);
  await service.settleBackgroundWork();

  const before = await service.store.findTask(taskId);
  const orderBefore = (await store.allTasks()).map((task) => task.id);

  await service.deleteReviewNote(taskId, message.id, CREATOR);
  await service.settleBackgroundWork();

  const after = await service.store.findTask(taskId);
  assert.equal(after.updatedAt, before.updatedAt, "the carve-out: withdrawing a message does not stamp updatedAt");
  assert.equal(after.completedAt, before.completedAt, "and does not restamp the completion either");
  assert.deepEqual(await store.allTasks().then((tasks) => tasks.map((t) => t.id)), orderBefore,
    "so the old task stays below the one genuinely finished later");
});

test("a Teams card quoting the thread shows the tombstone after its background refresh", async () => {
  const { service, events } = await setup();
  const { taskId, message } = await taskWithMessage(service, events);

  const updated = await service.deleteReviewNote(taskId, message.id, CREATOR);
  await service.settleBackgroundWork();

  const [sync] = events;
  assert.equal(events.length, 1, "one event, and it is not a nudge");
  assert.equal(sync.target, "DM_CARD_SYNC", "the refresh rides the silent sync");
  const quoted = recentNoteThread(sync.task);
  assert.deepEqual(quoted.map((entry) => entry.text), [MESSAGE_DELETED_BODY],
    "the card redraws quoting the tombstone — not the old words, and not a blank");
  assert.equal(quoted[0].author, CREATOR.displayName, "still attributed, as it is in the thread");
  assert.deepEqual(recentNoteThread(updated).map((entry) => entry.text), [MESSAGE_DELETED_BODY]);
});

/* ── Unread: a withdrawn message is not something to read (rule 6) ───────── */

test("deleting the only message a viewer had left to read clears their unread signal", async () => {
  const { service, events } = await setup();
  const { taskId, message } = await taskWithMessage(service, events, { author: ASSIGNEE, text: "page 3 looks wrong" });

  const before = await service.store.findTask(taskId);
  assert.equal(hasUnreadNoteForViewer(before, CREATOR, undefined), true, "the creator has something to read");
  assert.equal(unreadNoteFor(before, CREATOR, undefined), message.at);

  const after = await service.deleteReviewNote(taskId, message.id, ASSIGNEE);
  assert.equal(hasUnreadNoteForViewer(after, CREATOR, undefined), false,
    "and once it is withdrawn there is nothing to send them to the task for");
  assert.equal(unreadNoteFor(after, CREATOR, undefined), undefined);
});

test("a tombstone is never itself unread, for anyone, ever", async () => {
  const { service, events } = await setup();
  const { taskId, message } = await taskWithMessage(service, events, { author: ASSIGNEE, text: "page 3 looks wrong" });
  const after = await service.deleteReviewNote(taskId, message.id, ASSIGNEE);

  for (const viewer of [CREATOR, ASSIGNEE, OBSERVER, ADMIN]) {
    assert.equal(hasUnreadNoteForViewer(after, viewer, undefined), false, `${viewer.displayName} has nothing waiting`);
  }
});

test("a live message beside a tombstone still raises the signal", async () => {
  const { service, events } = await setup();
  const { taskId, message } = await taskWithMessage(service, events, { author: ASSIGNEE, text: "page 3 looks wrong" });
  const withSecond = await service.addReviewNote(taskId, "and page 4", ASSIGNEE);
  await service.settleBackgroundWork();
  const live = withSecond.reviewNotes[1];

  const after = await service.deleteReviewNote(taskId, message.id, ASSIGNEE);
  assert.equal(unreadNoteFor(after, CREATOR, undefined), live.at,
    "the rule did not stop working, it just skips the row nobody can read");

  /* And the tombstone cannot re-raise something already read: a viewer caught
     up to the live message stays caught up. */
  assert.equal(hasUnreadNoteForViewer(after, CREATOR, live.at), false);
});

test("withdrawing your own message never raises a signal at yourself", async () => {
  const { service, events } = await setup();
  const { taskId, message } = await taskWithMessage(service, events);
  const after = await service.deleteReviewNote(taskId, message.id, CREATOR);
  assert.equal(hasUnreadNoteForViewer(after, CREATOR, undefined), false);
});

/* ── History carries the withdrawn text (rule 7) ─────────────────────────── */

test("each delete lands in history with the words that were withdrawn", async () => {
  const { service, events } = await setup();
  const { taskId, message } = await taskWithMessage(service, events);
  const second = await service.addReviewNote(taskId, "second thoughts about the roof", CREATOR);
  await service.settleBackgroundWork();

  await service.deleteReviewNote(taskId, message.id, CREATOR);
  await service.deleteReviewNote(taskId, second.reviewNotes[1].id, CREATOR);
  await service.settleBackgroundWork();

  const rows = (await service.store.allHistoryForTask(taskId)).filter((e) => e.action === REVIEW_NOTE_DELETED_ACTION);
  assert.equal(rows.length, 2, "one row per delete");
  assert.match(rows[0].detail, /"Comps look thin\."/, "carrying the words that were taken out");
  assert.match(rows[1].detail, /"second thoughts about the roof"/);
  assert.equal(rows[0].by.id, CREATOR.id, "attributed to the author who withdrew it");

  /* Rule 4 refuses an undo on the strength of this row being the surviving
     copy, so the words must be here and nowhere else. */
  const stored = await service.store.findTask(taskId);
  assert.ok(
    stored.reviewNotes.every((note) => note.text === ""),
    "and the task itself no longer carries them"
  );
});
