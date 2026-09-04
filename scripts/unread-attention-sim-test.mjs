#!/usr/bin/env node
/*
 * Issue #161 — who an unread note is allowed to shout at.
 *
 * The card's unread flag used to be "is there a note by someone other than me
 * that I haven't acknowledged", with no check on whether the viewer had a seat
 * on the task. An Observer has never opened the card, so `seenNoteAt` is
 * undefined, every note reads as unread, and they got all three attention
 * signals — force-open, undim, red dot — for work that isn't theirs.
 *
 * `hasUnreadNoteForViewer` (packages/shared/src/notes.ts) is the single
 * definition both surfaces now ask: the card's flag and the grouped view's
 * message-pull. It answers the whole question — party membership AND the note
 * lookup — because the bug was precisely a caller combining the two by hand and
 * forgetting half.
 *
 * Runs against the compiled dist, mirroring task-ordering-sim-test.mjs.
 */
import assert from "node:assert/strict";

import { hasUnreadNoteForViewer, unreadNoteFor } from "../packages/shared/dist/notes.js";
import { isTaskParty } from "../packages/shared/dist/parties.js";

const CREATOR = { id: "creator-1", displayName: "Dana Requester" };
const ASSIGNEE = { id: "assignee-1", displayName: "Casey Checker" };
const OBSERVER = { id: "observer-1", displayName: "Sam Bystander" };

const T1 = "2026-08-20T10:00:00.000Z";
const T2 = "2026-08-20T11:00:00.000Z";

const note = (by, at) => ({ by: { ...by }, at, text: "note" });

const task = (overrides = {}) => ({
  id: "task-1",
  folderName: "Folder 1",
  taskType: "VALUE",
  dueAt: T2,
  urgency: "GREEN",
  points: 1,
  status: "CLAIMED",
  createdAt: T1,
  updatedAt: T2,
  createdBy: { ...CREATOR },
  assignee: { ...ASSIGNEE },
  reviewNotes: [],
  ...overrides
});

/* ── Party membership ─────────────────────────────────────── */

assert.equal(isTaskParty(task(), CREATOR), true, "creator is a party");
assert.equal(isTaskParty(task(), ASSIGNEE), true, "assignee is a party");
assert.equal(isTaskParty(task(), OBSERVER), false, "observer is not a party");
assert.equal(
  isTaskParty(task({ assignee: undefined }), OBSERVER),
  false,
  "an unclaimed task has no assignee seat for an observer to fill"
);

/* ── Which note comes back ────────────────────────────────────
   `unreadNoteFor` hands back the timestamp the caller must acknowledge, so the
   flag and the write-back can't disagree. The note-scanning helper underneath
   is private on purpose — half the question is what #161 handed out. */

assert.equal(unreadNoteFor(task(), CREATOR, undefined), undefined, "no notes → nothing to read");
assert.equal(
  unreadNoteFor(task({ reviewNotes: [note(CREATOR, T1)] }), CREATOR, undefined),
  undefined,
  "your own note is not a note from the other party"
);
assert.equal(
  unreadNoteFor(task({ reviewNotes: [note(ASSIGNEE, T1), note(CREATOR, T2)] }), CREATOR, undefined),
  T1,
  "returns the latest note that isn't yours, ignoring your own later one"
);
assert.equal(
  unreadNoteFor(task({ reviewNotes: [note(ASSIGNEE, T2)] }), OBSERVER, undefined),
  undefined,
  "an observer is handed no note to acknowledge"
);

/* ── The signal itself ────────────────────────────────────── */

const withNote = task({ reviewNotes: [note(ASSIGNEE, T2)] });

// The bug: an observer has acknowledged nothing, so every note reads unread.
assert.equal(
  hasUnreadNoteForViewer(withNote, OBSERVER, undefined),
  false,
  "#161: an observer gets no unread signal, however much note activity there is"
);

// Party behaviour is unchanged — this is what the new gate must not catch.
assert.equal(
  hasUnreadNoteForViewer(withNote, CREATOR, undefined),
  true,
  "creator with an unacknowledged note from the assignee is signalled"
);
assert.equal(
  hasUnreadNoteForViewer(task({ reviewNotes: [note(CREATOR, T2)] }), ASSIGNEE, undefined),
  true,
  "assignee with an unacknowledged note from the creator is signalled"
);

// Acknowledging clears it, for a party.
assert.equal(
  hasUnreadNoteForViewer(withNote, CREATOR, T2),
  false,
  "acknowledging the latest note clears the signal"
);
assert.equal(
  hasUnreadNoteForViewer(withNote, CREATOR, T1),
  true,
  "an acknowledgement older than the note leaves the signal up"
);

// A party's own note never signals them.
assert.equal(
  hasUnreadNoteForViewer(task({ reviewNotes: [note(CREATOR, T2)] }), CREATOR, undefined),
  false,
  "your own note never signals you"
);

// An observer stays silent even once a party has acknowledged theirs, and even
// on an OPEN task — status is not part of this rule.
assert.equal(
  hasUnreadNoteForViewer(task({ status: "OPEN", assignee: undefined, reviewNotes: [note(CREATOR, T2)] }), OBSERVER, undefined),
  false,
  "an unclaimed OPEN task's notes don't signal a bystander"
);

console.log("unread-attention-sim-test: all assertions passed");
