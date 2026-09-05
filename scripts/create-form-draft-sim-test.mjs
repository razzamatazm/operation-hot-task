#!/usr/bin/env node
/* Issue #284 — the new task form remembers your progress if you get pulled away.
 *
 * The ticket's last acceptance criterion asks for exactly this file: "the
 * save/restore/expiry rules are testable without rendering the form". So the
 * rules live in `apps/web/src/create-form-draft.ts`, framework-free, with the
 * browser reachable only through a three-method storage object — and here that
 * object is a plain Map wrapper. No DOM, no React, no build: the module imports
 * its one type type-only, so node's TS type stripping runs it as it stands.
 *
 * What is NOT here: whether the form is worth saving at all (that is
 * `formHasChanges`, tested in `create-form-state-sim-test.mjs`), and how the
 * form is wired to any of this (that is `task-draft-form-sim-test.mjs`).
 *
 * Run: `node --test scripts/create-form-draft-sim-test.mjs`. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DRAFT_KEY_PREFIX,
  DRAFT_MAX_AGE_MS,
  DRAFT_VERSION,
  browserDraftStorage,
  clearDraft,
  draftFieldNames,
  draftKey,
  parseDraft,
  readDraft,
  serializeDraft,
  writeDraft
} from "../apps/web/src/create-form-draft.ts";
import { BLANK_CREATE_FORM, formHasChanges, initialCreateForm } from "../apps/web/src/create-form-state.ts";

/* A localStorage that lives in a Map. `throws` turns it into the locked-down or
   full one — the Teams profile that refuses to store anything, which the ticket
   says must look exactly like today's form and nothing else. */
const fakeStorage = ({ throws = false } = {}) => {
  const items = new Map();
  return {
    items,
    getItem: (key) => {
      if (throws) throw new Error("storage unavailable");
      return items.has(key) ? items.get(key) : null;
    },
    setItem: (key, value) => {
      if (throws) throw new Error("QuotaExceededError");
      items.set(key, value);
    },
    removeItem: (key) => {
      if (throws) throw new Error("storage unavailable");
      items.delete(key);
    }
  };
};

const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

/* A form with something in every single box, which is what "restores every
   field, with no exceptions" needs to be tested against. */
const FILLED = {
  folderName: "Adams - Harbor",
  loanId: "loan-9",
  taskType: "FRAUD",
  urgency: "RED",
  startDate: "2026-09-07",
  returnDate: "2026-09-14",
  notes: "Second TD needs confirming before this goes out",
  humperdinkLink: "https://humperdink.loneoakfund.com/Loans/Details/335203",
  points: 3,
  initialItems: ["Missing appraisal", "No W-2"],
  pickerMode: "assign",
  recipientUserId: "user-3",
  recipientNote: "yours if you can take it today"
};

/* ── The stored shape ───────────────────────────────────── */

/* The duplication guard. The field list in the codec is written out by hand so
   the module can import the form's type type-only and run with no build; this
   is what stops that list drifting from the form. A field added to the form and
   not to the codec would silently never be saved, which is the exact failure
   this ticket exists to prevent. */
test("the draft covers every field the form holds, and nothing else", () => {
  assert.deepEqual(draftFieldNames().sort(), Object.keys(BLANK_CREATE_FORM).sort());
});

test("a draft is one per person, under the app's existing key convention", () => {
  assert.equal(DRAFT_KEY_PREFIX, "loan-tasks:create-draft:");
  assert.equal(draftKey("user-1"), "loan-tasks:create-draft:user-1");
  assert.notEqual(draftKey("user-1"), draftKey("user-2"));
});

test("seven days is the shelf life, so a Friday draft is there on Monday", () => {
  assert.equal(DRAFT_MAX_AGE_MS, 7 * DAY);
});

test("what is written is the version, the time and the values", () => {
  const record = JSON.parse(serializeDraft(FILLED, NOW));
  assert.equal(record.version, DRAFT_VERSION);
  assert.equal(record.savedAt, NOW);
  assert.deepEqual(record.values, FILLED);
});

/* `formHasChanges` walks both key sets and counts a field present on one side
   only as a change. A stray key riding into storage would come back out and
   make an untouched restored form ask "discard this task?" on the way out. */
test("only the form's own fields go into storage", () => {
  const record = JSON.parse(serializeDraft({ ...FILLED, somethingElse: "hitchhiker" }, NOW));
  assert.equal("somethingElse" in record.values, false);
});

/* ── Round trip: every field comes back ─────────────────── */

test("a full form written and read back is the same form, field for field", () => {
  const storage = fakeStorage();
  writeDraft(storage, "user-1", FILLED, NOW);
  assert.deepEqual(readDraft(storage, "user-1", NOW), FILLED);
});

/* The criterion names these four by name, so they are asserted by name. */
test("the task type, the fraud items, the OOO dates and the recipient all survive", () => {
  const storage = fakeStorage();
  writeDraft(storage, "user-1", FILLED, NOW);
  const back = readDraft(storage, "user-1", NOW);
  assert.equal(back.taskType, "FRAUD");
  assert.deepEqual(back.initialItems, ["Missing appraisal", "No W-2"]);
  assert.equal(back.startDate, "2026-09-07");
  assert.equal(back.returnDate, "2026-09-14");
  assert.equal(back.pickerMode, "assign");
  assert.equal(back.recipientUserId, "user-3");
  assert.equal(back.recipientNote, "yours if you can take it today");
});

test("a restored draft shares no array with anything else", () => {
  const storage = fakeStorage();
  writeDraft(storage, "user-1", FILLED, NOW);
  const first = readDraft(storage, "user-1", NOW);
  const second = readDraft(storage, "user-1", NOW);
  first.initialItems.push("mutated");
  assert.deepEqual(second.initialItems, ["Missing appraisal", "No W-2"]);
});

/* A restored form is the form the person left, so closing it untouched must not
   ask them to discard anything — the two modules meet exactly here. */
test("a restored draft reads as untouched against itself", () => {
  const storage = fakeStorage();
  writeDraft(storage, "user-1", FILLED, NOW);
  const restored = readDraft(storage, "user-1", NOW);
  assert.equal(formHasChanges(restored, restored), false);
  assert.equal(formHasChanges(restored, { ...restored, notes: "changed" }), true);
});

test("an empty form round-trips too — nothing here assumes values", () => {
  const storage = fakeStorage();
  writeDraft(storage, "user-1", initialCreateForm(), NOW);
  assert.deepEqual(readDraft(storage, "user-1", NOW), initialCreateForm());
});

/* ── Whose draft it is ──────────────────────────────────── */

test("two people on one machine never see each other's draft", () => {
  const storage = fakeStorage();
  writeDraft(storage, "user-1", { ...FILLED, notes: "Dana's half-written task" }, NOW);
  writeDraft(storage, "user-2", { ...FILLED, notes: "Sam's half-written task" }, NOW);
  assert.equal(readDraft(storage, "user-1", NOW).notes, "Dana's half-written task");
  assert.equal(readDraft(storage, "user-2", NOW).notes, "Sam's half-written task");
});

test("someone with no draft of their own sees nothing, not the other person's", () => {
  const storage = fakeStorage();
  writeDraft(storage, "user-1", FILLED, NOW);
  assert.equal(readDraft(storage, "user-2", NOW), null);
});

test("clearing one person's draft leaves the other's alone", () => {
  const storage = fakeStorage();
  writeDraft(storage, "user-1", FILLED, NOW);
  writeDraft(storage, "user-2", FILLED, NOW);
  clearDraft(storage, "user-1");
  assert.equal(readDraft(storage, "user-1", NOW), null);
  assert.notEqual(readDraft(storage, "user-2", NOW), null);
});

/* ── Going away ─────────────────────────────────────────── */

test("clearing a draft means the next form opens blank", () => {
  const storage = fakeStorage();
  writeDraft(storage, "user-1", FILLED, NOW);
  clearDraft(storage, "user-1");
  assert.equal(readDraft(storage, "user-1", NOW), null);
  assert.equal(storage.items.size, 0, "and the key is gone, not left holding an empty record");
});

test("clearing a draft that was never there is not an error", () => {
  const storage = fakeStorage();
  assert.doesNotThrow(() => clearDraft(storage, "user-1"));
});

test("a draft still inside seven days comes back", () => {
  const storage = fakeStorage();
  writeDraft(storage, "user-1", FILLED, NOW - 6 * DAY);
  assert.deepEqual(readDraft(storage, "user-1", NOW), FILLED);
  writeDraft(storage, "user-1", FILLED, NOW - (7 * DAY - 1));
  assert.notEqual(readDraft(storage, "user-1", NOW), null, "right up to the boundary");
});

test("a draft older than seven days does not come back", () => {
  const storage = fakeStorage();
  writeDraft(storage, "user-1", FILLED, NOW - 7 * DAY);
  assert.equal(readDraft(storage, "user-1", NOW), null, "seven days exactly is gone");
  writeDraft(storage, "user-1", FILLED, NOW - 30 * DAY);
  assert.equal(readDraft(storage, "user-1", NOW), null);
});

/* Nothing sweeps storage in the background, so the read is the only moment a
   draft's age is ever asked about — a stale record left in place would be
   re-read and re-rejected forever. */
test("reading a stale draft prunes it", () => {
  const storage = fakeStorage();
  writeDraft(storage, "user-1", FILLED, NOW - 30 * DAY);
  readDraft(storage, "user-1", NOW);
  assert.equal(storage.items.size, 0);
});

/* Age is measured from the last write, so a draft somebody keeps coming back to
   keeps living. */
test("saving again restarts the seven days", () => {
  const storage = fakeStorage();
  writeDraft(storage, "user-1", FILLED, NOW - 30 * DAY);
  writeDraft(storage, "user-1", FILLED, NOW);
  assert.deepEqual(readDraft(storage, "user-1", NOW), FILLED);
});

/* Throwing work away over a clock that went backwards is worse than the failure
   it would prevent. */
test("a draft saved in the future is not treated as corrupt", () => {
  const storage = fakeStorage();
  writeDraft(storage, "user-1", FILLED, NOW + DAY);
  assert.deepEqual(readDraft(storage, "user-1", NOW), FILLED);
});

/* ── Anything malformed is no draft ─────────────────────── */

test("nothing stored is no draft, and prunes nothing", () => {
  const storage = fakeStorage();
  assert.equal(readDraft(storage, "user-1", NOW), null);
  assert.equal(parseDraft(null, NOW), null);
  assert.equal(parseDraft("", NOW), null);
});

test("anything that is not this app's record reads as no draft", () => {
  const cases = {
    "not JSON at all": "{oh dear",
    "JSON that is not an object": '"a string"',
    "null": "null",
    "an array": "[]",
    "no version": JSON.stringify({ savedAt: NOW, values: FILLED }),
    "a version from the future": JSON.stringify({ version: 99, savedAt: NOW, values: FILLED }),
    "no timestamp": JSON.stringify({ version: DRAFT_VERSION, values: FILLED }),
    "a timestamp that is not a number": JSON.stringify({ version: DRAFT_VERSION, savedAt: "yesterday", values: FILLED }),
    "no values": JSON.stringify({ version: DRAFT_VERSION, savedAt: NOW }),
    "values that are not an object": JSON.stringify({ version: DRAFT_VERSION, savedAt: NOW, values: 7 })
  };
  for (const [what, raw] of Object.entries(cases)) {
    assert.equal(parseDraft(raw, NOW), null, what);
  }
});

/* Half a draft is worse than none: a form that is neither what they typed nor
   blank is a form nobody can trust. */
test("a draft missing any single field is no draft", () => {
  for (const field of draftFieldNames()) {
    const values = { ...FILLED };
    delete values[field];
    const raw = JSON.stringify({ version: DRAFT_VERSION, savedAt: NOW, values });
    assert.equal(parseDraft(raw, NOW), null, `${field} missing`);
  }
});

test("a draft with a field of the wrong shape is no draft", () => {
  const wrong = {
    folderName: 7,
    taskType: null,
    points: "three",
    initialItems: "Missing appraisal",
    pickerMode: "delegate",
    recipientNote: { text: "hi" }
  };
  for (const [field, value] of Object.entries(wrong)) {
    const raw = JSON.stringify({ version: DRAFT_VERSION, savedAt: NOW, values: { ...FILLED, [field]: value } });
    assert.equal(parseDraft(raw, NOW), null, `${field} = ${JSON.stringify(value)}`);
  }
  const items = JSON.stringify({
    version: DRAFT_VERSION,
    savedAt: NOW,
    values: { ...FILLED, initialItems: ["fine", 7] }
  });
  assert.equal(parseDraft(items, NOW), null, "an outstanding item that is not text");
});

test("a garbled record is pruned on the read that rejects it", () => {
  const storage = fakeStorage();
  storage.items.set(draftKey("user-1"), "{oh dear");
  assert.equal(readDraft(storage, "user-1", NOW), null);
  assert.equal(storage.items.size, 0);
});

test("a draft carrying extra keys comes back as the form's fields only", () => {
  const raw = JSON.stringify({
    version: DRAFT_VERSION,
    savedAt: NOW,
    values: { ...FILLED, hitchhiker: "left over from some other version" }
  });
  assert.deepEqual(parseDraft(raw, NOW), FILLED);
});

/* ── When the browser will not store anything ───────────── */

/* The ticket: the form behaves exactly as it does today, with no error and no
   warning. Every entry point has to survive it, because they are all called
   from a form that has no way to handle a throw. */
test("storage that throws on every call is silently no draft", () => {
  const storage = fakeStorage({ throws: true });
  assert.doesNotThrow(() => writeDraft(storage, "user-1", FILLED, NOW));
  assert.doesNotThrow(() => clearDraft(storage, "user-1"));
  assert.equal(readDraft(storage, "user-1", NOW), null);
});

/* A locked-down Teams profile can throw on the `window.localStorage` property
   itself, so the caller is handed `null` and every function takes it. */
test("no storage object at all is silently no draft", () => {
  assert.equal(readDraft(null, "user-1", NOW), null);
  assert.doesNotThrow(() => writeDraft(null, "user-1", FILLED, NOW));
  assert.doesNotThrow(() => clearDraft(null, "user-1"));
});

test("asking the browser for storage where there is no browser returns null rather than throwing", () => {
  /* Node has no `window`, which is the same shape of failure as a profile that
     refuses the property — and is what makes this assertable here. */
  assert.equal(browserDraftStorage(), null);
});
