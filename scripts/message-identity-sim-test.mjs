#!/usr/bin/env node
/*
 * A message becomes an addressable thing (#286, ADR-0009 rules 5 and 6).
 *
 * This ticket changes nothing anybody can see. Its whole promise is that every
 * conversation already stored renders exactly as it did before, while the
 * record underneath gains the two things the edit and delete tickets need:
 *
 *   - a stable identifier that is NOT the message's timestamp, because rule 6
 *     freezes that timestamp across an edit so it stays the value the unread
 *     comparison reads, which leaves it unable to double as a handle;
 *   - the app's own label — the `Needs fixes:` prefix a send-back writes — held
 *     apart from the author's words, because rule 5 says an edit reaches one
 *     and not the other.
 *
 * Neither is visible, so "unchanged" is the thing under test. That is asserted
 * three ways: the migration's output for a task holding a mix of prefixed and
 * ordinary messages, the rendered web thread and the Teams card thread before
 * and after that migration, and the unread signal across it. The store's
 * start-up migration is then run for real, twice, against a temp file.
 *
 * Run: `node --test scripts/message-identity-sim-test.mjs`.
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

import { ACTION_LABELS, needsFixesNote } from "../packages/shared/dist/labels.js";
import {
  hasUnreadNoteForViewer,
  migrateTaskMessages,
  NOTE_LABELS,
  noteBodyText,
  unreadNoteFor
} from "../packages/shared/dist/notes.js";
import { TaskStore } from "../apps/server/dist/store.js";
import { SseHub } from "../apps/server/dist/sse.js";
import { TaskService } from "../apps/server/dist/task-service.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/* The thread is TSX with a relative import, so esbuild bundles rather than
   transforms — the same trick `instructions-box-sim-test.mjs` uses, and for
   the same reason: the promise is about rendered markup, and App.tsx cannot be
   imported into a node script. */
const scratch = mkdtempSync(join(REPO, "node_modules", ".message-identity-"));
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

const T0 = "2026-08-20T09:00:00.000Z";
const T1 = "2026-08-20T10:00:00.000Z";
const T2 = "2026-08-20T11:00:00.000Z";
const T3 = "2026-08-20T12:00:00.000Z";

/* A message as it was stored BEFORE this ticket: no identifier, and the app's
   prefix sitting inside the text where nothing could tell it apart from
   something a person typed. */
const legacyNote = (by, at, text) => ({ by: { id: by.id, displayName: by.displayName }, at, text });

/* The mix the ticket asks for: two ordinary replies from both parties and one
   send-back the app prefixed, oldest to newest. */
const LEGACY_THREAD = [
  legacyNote(CREATOR, T1, "Terms are attached, shout if anything looks off."),
  legacyNote(ASSIGNEE, T2, needsFixesNote("borrower name is misspelt on page 3")),
  legacyNote(CREATOR, T3, "Fixed, back to you.")
];

const legacyTask = (overrides = {}) => ({
  id: "task-1",
  folderName: "Smith-1042",
  taskType: "VALUE",
  dueAt: T3,
  urgency: "GREEN",
  points: 2,
  status: "CLAIMED",
  notes: "Comps look thin on the north side.",
  createdAt: T0,
  updatedAt: T3,
  createdBy: { id: CREATOR.id, displayName: CREATOR.displayName },
  assignee: { id: ASSIGNEE.id, displayName: ASSIGNEE.displayName },
  reviewNotes: LEGACY_THREAD.map((note) => ({ ...note })),
  ...overrides
});

/* A counter rather than a UUID so the assertions can name the ids. Uniqueness
   within the task is the requirement; the store hands in `randomUUID`. */
const counter = () => {
  let n = 0;
  return () => `msg-${++n}`;
};

const migrate = (task, mint = counter()) => migrateTaskMessages(task, mint);

const renderThread = (task, viewerId = ASSIGNEE.id) =>
  renderToStaticMarkup(createElement(ThreadMessages, { task, viewerId, canReply: true }));

const rowCount = (markup) => (markup.match(/class="msg[ "]/g) ?? []).length;

/* ── The migration's output for a mixed thread ───────────────────────────── */

test("every message comes out with an identifier that is not its timestamp", () => {
  const { task, changed } = migrate(legacyTask());
  assert.equal(changed, true, "a thread stored before #286 needs migrating");
  const ids = task.reviewNotes.map((note) => note.id);
  assert.deepEqual(ids, ["msg-1", "msg-2", "msg-3"], "one identifier per message, in thread order");
  assert.equal(new Set(ids).size, ids.length, "unique within the task");
  for (const note of task.reviewNotes) {
    assert.notEqual(note.id, note.at, "the identifier is its own value, not the moment it landed");
  }
  assert.deepEqual(
    task.reviewNotes.map((note) => note.at),
    [T1, T2, T3],
    "and no message was re-stamped on the way through"
  );
});

test("the prefixed message keeps its prefix as a label, and the ordinary ones get none", () => {
  const { task } = migrate(legacyTask());
  const [first, sendBack, last] = task.reviewNotes;

  assert.equal(sendBack.label, ACTION_LABELS.NEEDS_FIXES, "the app's prefix is now the app's label");
  assert.equal(sendBack.text, "borrower name is misspelt on page 3", "and the author is left holding only their own words");
  assert.ok(!sendBack.text.startsWith(ACTION_LABELS.NEEDS_FIXES), "the prefix is out of the text entirely");

  assert.equal(first.label, undefined, "a reply somebody typed carries no label");
  assert.equal(last.label, undefined);
  assert.equal(first.text, "Terms are attached, shout if anything looks off.", "and its words are untouched");
});

test("a migrated message reads exactly as it did before", () => {
  const { task } = migrate(legacyTask());
  assert.deepEqual(
    task.reviewNotes.map((note) => noteBodyText(note)),
    LEGACY_THREAD.map((note) => note.text),
    "label plus text is the string that was stored"
  );
  /* Pinned against the function that WROTE the prefix, so the joiner and the
     writer cannot drift apart into two ideas of what a send-back looks like. */
  assert.equal(
    noteBodyText({ label: ACTION_LABELS.NEEDS_FIXES, text: "borrower name is misspelt on page 3" }),
    needsFixesNote("borrower name is misspelt on page 3")
  );
  /* The derivation has to recognise what is on disk, which is a historical
     fact, not a live string. Renaming the button must not orphan the send-backs
     already filed under the old wording. */
  assert.ok(NOTE_LABELS.includes("Needs fixes"), "the prefix as it was actually written into stored threads");
  assert.ok(NOTE_LABELS.includes(ACTION_LABELS.NEEDS_FIXES), "and whatever the button says today");
  assert.equal(new Set(NOTE_LABELS).size, NOTE_LABELS.length, "with no prefix tried twice");
});

test("the migration is safe to run twice", () => {
  const mint = counter();
  const first = migrate(legacyTask(), mint);
  const second = migrateTaskMessages(first.task, mint);
  assert.equal(second.changed, false, "the second pass finds nothing to repair");
  assert.equal(second.task, first.task, "and hands back the same task rather than a rewritten one");
  assert.deepEqual(second.task.reviewNotes, first.task.reviewNotes, "identifiers are stable and no label is peeled twice");
});

test("a message already carrying a label is left alone, prefix-shaped text and all", () => {
  /* The case a second pass would break if the derivation looked only at the
     text: an author who genuinely typed `Needs fixes: ` into a send-back. Once
     labelled, the remaining text is theirs and stays theirs. */
  const doubled = legacyTask({
    reviewNotes: [{ id: "msg-kept", label: ACTION_LABELS.NEEDS_FIXES, text: "Needs fixes: and also the rate", by: ASSIGNEE, at: T2 }]
  });
  const { task, changed } = migrate(doubled);
  assert.equal(changed, false);
  assert.equal(task.reviewNotes[0].text, "Needs fixes: and also the rate", "not peeled a second time");
  assert.equal(task.reviewNotes[0].id, "msg-kept", "and its identifier is not reissued");
});

test("a task with no conversation is not touched", () => {
  const empty = legacyTask({ reviewNotes: [] });
  const { task, changed } = migrate(empty);
  assert.equal(changed, false);
  assert.equal(task, empty);
  const { changed: noField } = migrate(legacyTask({ reviewNotes: undefined }));
  assert.equal(noField, false, "and neither is a task that never had the field");
});

/* ── Nothing downstream moves ────────────────────────────────────────────── */

test("the thread view renders identically before and after the migration", () => {
  const before = renderThread(legacyTask());
  const after = renderThread(migrate(legacyTask()).task);
  assert.equal(after, before, "same markup, character for character");
  assert.ok(after.includes(needsFixesNote("borrower name is misspelt on page 3")), "the send-back still reads with its prefix");
});

test("the reply count and the empty-conversation state are unchanged", () => {
  const migrated = migrate(legacyTask()).task;
  assert.equal(migrated.reviewNotes.length, LEGACY_THREAD.length, "the collapsed row counts what it always counted");
  assert.equal(rowCount(renderThread(migrated)), 3, "the three replies, and nothing this ticket added");

  /* Three, not the four this asserted before #300. A Value Check's request
     field is now a standing Instructions box rather than message number one
     (ADR-0010 rule 1), so it is not a row here — which is a fact about where
     that field is drawn and not about the migration. What this test is for is
     that the count is the same either side of the migration, and it is: the
     stored `reviewNotes` above are untouched, and both counts move together. */
  assert.equal(rowCount(renderThread(legacyTask())), 3, "and the same count before the migration ran");

  /* The field being a standing section is what makes a reply-less task the
     empty state — before the migration and after. */
  const emptyTask = legacyTask({ reviewNotes: [] });
  const emptyMarkup = renderThread(migrate(emptyTask).task);
  assert.match(emptyMarkup, /msgs-empty/, "still says the conversation is empty");
  assert.equal(emptyMarkup, renderThread(emptyTask), "and says it in the same words");
});

test("the Teams card thread quotes the same lines", () => {
  const before = recentNoteThread(legacyTask());
  const after = recentNoteThread(migrate(legacyTask()).task);
  assert.deepEqual(after, before, "the card builder is unmoved by the split");
  assert.deepEqual(
    after.map((entry) => entry.text),
    LEGACY_THREAD.map((note) => note.text),
    "and the send-back still quotes with its prefix"
  );
});

test("the unread signal is unchanged across the migration", () => {
  /* One function owns this rule and this ticket gives it no new reason to
     care: it walks author and time, and the migration moves neither. */
  const before = legacyTask();
  const after = migrate(legacyTask()).task;
  for (const [viewer, seen] of [
    [ASSIGNEE, undefined],
    [ASSIGNEE, T2],
    [CREATOR, undefined],
    [CREATOR, T3],
    [OBSERVER, undefined]
  ]) {
    assert.equal(
      unreadNoteFor(after, viewer, seen),
      unreadNoteFor(before, viewer, seen),
      `same unread answer for ${viewer.displayName} at ${seen ?? "nothing seen"}`
    );
    assert.equal(hasUnreadNoteForViewer(after, viewer, seen), hasUnreadNoteForViewer(before, viewer, seen));
  }
  assert.equal(unreadNoteFor(after, ASSIGNEE, undefined), T3, "and it is still the newest message from the other party");
  assert.equal(unreadNoteFor(after, OBSERVER, undefined), undefined, "with an Observer still reading nothing (#161)");
});

/* ── The store runs it at start-up, and can run it again ─────────────────── */

const seedStore = async (tasks) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "message-identity-sim-"));
  const file = path.join(dir, "tasks.json");
  await fsp.writeFile(file, JSON.stringify({ tasks, history: [] }, null, 2), "utf8");
  return file;
};

const readTasks = async (file) => JSON.parse(await fsp.readFile(file, "utf8")).tasks;

test("the store backfills a file written before #286, and a second start-up changes nothing", async () => {
  const file = await seedStore([legacyTask()]);
  await new TaskStore(file).init();
  const [first] = await readTasks(file);
  assert.equal(first.reviewNotes.length, 3);
  for (const note of first.reviewNotes) {
    assert.ok(typeof note.id === "string" && note.id.length > 0, "every stored message has an identifier");
    assert.notEqual(note.id, note.at);
  }
  assert.equal(new Set(first.reviewNotes.map((note) => note.id)).size, 3, "unique within the task");
  assert.equal(first.reviewNotes[1].label, ACTION_LABELS.NEEDS_FIXES);
  assert.deepEqual(first.reviewNotes.map((note) => noteBodyText(note)), LEGACY_THREAD.map((note) => note.text));
  assert.equal(first.updatedAt, T3, "and the migration is not activity — updatedAt did not move");

  await new TaskStore(file).init();
  const [second] = await readTasks(file);
  assert.deepEqual(second.reviewNotes, first.reviewNotes, "the second start-up reissues nothing");
});

/* ── A message written from now on is born with both ─────────────────────── */

const CONFIG = {
  businessTimezone: "America/Los_Angeles",
  businessStartHour: 8,
  businessStartMinute: 30,
  businessEndHour: 17,
  businessEndMinute: 30,
  archiveRetentionDays: 90
};

const service = async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "message-identity-svc-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.init();
  return new TaskService(store, { notify: async () => {}, canReachDm: async () => true }, new SseHub(), CONFIG);
};

const claimedLoi = async (svc) => {
  const task = await svc.createTask({ folderName: "Smith-1042", taskType: "LOI", notes: "terms attached" }, CREATOR);
  return svc.claimTask(task.id, ASSIGNEE);
};

test("a new send-back stores its prefix as a label, not inside the text", async () => {
  const svc = await service();
  const task = await claimedLoi(svc);
  const sent = await svc.transitionStatus(task.id, "NEEDS_REVIEW", ASSIGNEE, "borrower name is misspelt");
  const [note] = sent.reviewNotes;
  assert.equal(note.label, ACTION_LABELS.NEEDS_FIXES, "the app's words are the app's field");
  assert.equal(note.text, "borrower name is misspelt", "the author's field holds only what they typed");
  assert.ok(typeof note.id === "string" && note.id.length > 0, "and it is addressable from birth");
  assert.notEqual(note.id, note.at);
  assert.equal(noteBodyText(note), needsFixesNote("borrower name is misspelt"), "reading as it always did");
  /* Re-running the migration over freshly written data must be a no-op, which
     is what says the writer and the migration agree on the shape. */
  assert.equal(migrate(sent).changed, false, "nothing left for the migration to repair");
});

test("an ordinary reply gets an identifier and no label", async () => {
  const svc = await service();
  const task = await claimedLoi(svc);
  const replied = await svc.addReviewNote(task.id, "one more thing", CREATOR);
  const [note] = replied.reviewNotes;
  assert.ok(typeof note.id === "string" && note.id.length > 0);
  assert.equal(note.label, undefined, "the app has nothing to say about somebody else's reply");
  assert.equal(noteBodyText(note), "one more thing");
  assert.equal(migrate(replied).changed, false);
});
