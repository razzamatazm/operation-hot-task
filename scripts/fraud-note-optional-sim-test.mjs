#!/usr/bin/env node
/* Issue #302 / ADR-0010 rule 3 — a Fraud Check's note stops being required, so
 * long as the filer itemised at least one outstanding condition instead.
 *
 * The note has been mandatory on every type since before the conditions list
 * existed. Now that a filer can seed that list at creation (#69), a Fraud Check
 * whose conditions are already itemised has nothing left to put in a note, and
 * demanding one buys a line of filler the checker then has to read. So filing a
 * Fraud Check requires **a note, or at least one outstanding item**. Neither is
 * refused: a request that says nothing is not a request.
 *
 * The point of this file is that the rule is ONE rule. It spans two fields, so
 * it cannot live in the per-field validation on either side — a `required`
 * attribute knows nothing about the conditions list, and a `min(1)` on `notes`
 * knows nothing about it either. The prior art is the out-of-office date range
 * (`oooDatesOutOfOrder`), a single shared function the filing schema and the
 * edit path both ask precisely so the two can never disagree about what a valid
 * filing is. Same shape, same place.
 *
 * One assertion per acceptance criterion:
 *
 *   - a Fraud Check with items and no note is accepted, in the rule and at the
 *     server's create schema,
 *   - a Fraud Check with a note and no items is accepted, as today,
 *   - a Fraud Check with neither is refused, with a sentence naming both of the
 *     things that could have been there,
 *   - the rule is one shared function and both surfaces are asked to call it,
 *   - a Fraud Check filed without a note opens on an empty conversation rather
 *     than a blank first message row with an avatar attached to nothing,
 *   - the other five types still require their field at filing,
 *   - correcting a task still refuses an emptied field on every type,
 *   - the outstanding-items list itself is untouched.
 *
 * Run: `node --test scripts/fraud-note-optional-sim-test.mjs`. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TASK_TYPES } from "../packages/shared/dist/types.js";
import { FRAUD_FILING_REFUSAL, fraudFilingRefusal } from "../packages/shared/dist/workflow.js";
import { threadOpeningNoteFor } from "../packages/shared/dist/notes.js";
import { createTaskSchema } from "../apps/server/dist/validation.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/* The thread is TSX with a relative import, so esbuild bundles rather than
   transforms; the create form's state module is plain TS with type-only
   imports and comes along the same way. Both bundles land inside the repo so
   their externals resolve the way they do everywhere else. */
const scratch = mkdtempSync(join(REPO, "node_modules", ".fraud-note-optional-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

const bundle = async (entry, name) => {
  const outfile = join(scratch, name);
  await build({
    entryPoints: [join(REPO, entry)],
    outfile,
    bundle: true,
    format: "esm",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime", "@loan-tasks/shared"],
    logLevel: "silent"
  });
  return import(pathToFileURL(outfile).href);
};

const { ThreadMessages } = await bundle("apps/web/src/thread.tsx", "thread.mjs");
const { editRefusal } = await bundle("apps/web/src/create-form-state.ts", "create-form-state.mjs");

const CREATOR = { id: "creator-1", displayName: "Dana Requester" };
const ASSIGNEE = { id: "assignee-1", displayName: "Casey Checker" };

const T1 = "2026-08-20T10:00:00.000Z";
const T2 = "2026-08-20T11:00:00.000Z";

const CONDITION = "Bank statement for March is missing";
/* Plain ASCII with no apostrophe, so the markup assertions are about what was
   rendered rather than about HTML escaping. */
const NOTE = "The employer on file could not be reached.";

const task = (overrides = {}) => ({
  id: "task-1",
  folderName: "Folder 1",
  taskType: "FRAUD",
  dueAt: T2,
  urgency: "GREEN",
  points: 1,
  status: "CLAIMED",
  notes: NOTE,
  createdAt: T1,
  updatedAt: T2,
  createdBy: { ...CREATOR },
  assignee: { ...ASSIGNEE },
  reviewNotes: [],
  ...overrides
});

const messages = (t, viewerId = ASSIGNEE.id, canReply = true) =>
  renderToStaticMarkup(createElement(ThreadMessages, { task: t, viewerId, canReply }));

const items = (...texts) => texts.map((text) => ({ text }));

const filing = (overrides = {}) => ({
  folderName: "Fraud Sim",
  taskType: "FRAUD",
  notes: NOTE,
  urgency: "GREEN",
  ...overrides
});

/* ── The rule itself ──────────────────────────────────────── */

test("a Fraud Check with itemised conditions and no note is a complete request", () => {
  assert.equal(fraudFilingRefusal({ taskType: "FRAUD", notes: "", initialItems: items(CONDITION) }), undefined);
  /* Whitespace is not a note, and the items still carry the ask. */
  assert.equal(fraudFilingRefusal({ taskType: "FRAUD", notes: "   \n ", initialItems: items(CONDITION) }), undefined);
});

test("a Fraud Check with a note and no items is accepted, exactly as today", () => {
  assert.equal(fraudFilingRefusal({ taskType: "FRAUD", notes: NOTE, initialItems: [] }), undefined);
  assert.equal(fraudFilingRefusal({ taskType: "FRAUD", notes: NOTE }), undefined);
  assert.equal(fraudFilingRefusal({ taskType: "FRAUD", notes: NOTE, initialItems: items(CONDITION) }), undefined);
});

test("a Fraud Check with neither is refused, and the sentence names both", () => {
  assert.equal(fraudFilingRefusal({ taskType: "FRAUD", notes: "" }), FRAUD_FILING_REFUSAL);
  assert.equal(fraudFilingRefusal({ taskType: "FRAUD", notes: "", initialItems: [] }), FRAUD_FILING_REFUSAL);
  /* Spaces are not a request and neither is a blank condition. */
  assert.equal(fraudFilingRefusal({ taskType: "FRAUD", notes: "  ", initialItems: items("  ") }), FRAUD_FILING_REFUSAL);
  assert.match(FRAUD_FILING_REFUSAL, /note/i, "the refusal names the note");
  assert.match(FRAUD_FILING_REFUSAL, /outstanding item/i, "and the other thing that would have done");
});

test("the cross-field rule says nothing about the other five types", () => {
  /* It is the Fraud rule, not a general one: on the other five the field is
     required on its own terms and there is no second thing that could carry
     the ask. Answering for them here would be a second opinion about a rule
     this function does not own. */
  for (const taskType of TASK_TYPES.filter((t) => t !== "FRAUD")) {
    assert.equal(fraudFilingRefusal({ taskType, notes: "" }), undefined, `${taskType} is not this rule's business`);
    assert.equal(fraudFilingRefusal({ taskType, notes: NOTE }), undefined);
  }
});

/* ── The server asks it ───────────────────────────────────── */

test("the create schema accepts a Fraud Check filed on its conditions alone", () => {
  const parsed = createTaskSchema.safeParse(filing({ notes: "", initialItems: items(CONDITION) }));
  assert.ok(parsed.success, `expected an accepted filing, got ${JSON.stringify(parsed.error?.issues)}`);
  assert.equal(parsed.data.notes, "");
  assert.deepEqual(parsed.data.initialItems, items(CONDITION));
});

test("the create schema still accepts a Fraud Check filed on its note alone", () => {
  const parsed = createTaskSchema.safeParse(filing());
  assert.ok(parsed.success);
  assert.equal(parsed.data.notes, NOTE);
});

test("the create schema refuses a Fraud Check that says nothing, in the shared words", () => {
  const parsed = createTaskSchema.safeParse(filing({ notes: "" }));
  assert.equal(parsed.success, false);
  const messagesOut = parsed.error.issues.map((i) => i.message);
  assert.ok(
    messagesOut.includes(FRAUD_FILING_REFUSAL),
    `expected the shared refusal, got ${JSON.stringify(messagesOut)}`
  );
  /* Hung on the box it is about, so the form can point at it. */
  const issue = parsed.error.issues.find((i) => i.message === FRAUD_FILING_REFUSAL);
  assert.deepEqual(issue.path, ["notes"]);
});

test("the create schema refuses an empty note on the other five types, unchanged", () => {
  for (const taskType of TASK_TYPES.filter((t) => t !== "FRAUD")) {
    const dates = taskType === "OOO" ? { startDate: "2026-06-01", returnDate: "2026-06-05" } : {};
    const urgency = taskType === "OOO" ? {} : { urgency: "GREEN" };
    const blank = createTaskSchema.safeParse({
      folderName: "Sim",
      taskType,
      notes: "",
      ...dates,
      ...urgency
    });
    assert.equal(blank.success, false, `${taskType} still needs its field at filing`);
    const filled = createTaskSchema.safeParse({
      folderName: "Sim",
      taskType,
      notes: NOTE,
      ...dates,
      ...urgency
    });
    assert.ok(filled.success, `${taskType} files as it always has`);
  }
});

test("nothing about the outstanding-items list moved", () => {
  /* Same optional array of the same shape, same cap, and still ignored on the
     other five (#69). The rule reads the list; it does not reshape it. */
  const tooLong = createTaskSchema.safeParse(filing({ notes: "", initialItems: items("x".repeat(501)) }));
  assert.equal(tooLong.success, false, "the 500-character cap is where it was");
  const blankItem = createTaskSchema.safeParse(filing({ notes: NOTE, initialItems: items("") }));
  assert.equal(blankItem.success, false, "an empty item is still refused by the field's own rule");
  const none = createTaskSchema.safeParse(filing());
  assert.ok(none.success);
  assert.equal(none.data.initialItems, undefined, "zero items is still fine and still absent");
  const onAnother = createTaskSchema.safeParse({
    folderName: "Sim",
    taskType: "VALUE",
    notes: NOTE,
    urgency: "GREEN",
    initialItems: items(CONDITION)
  });
  assert.ok(onAnother.success, "a non-Fraud filing still carries the field the service ignores");
});

/* ── The thread opens empty rather than on a blank bubble ─── */

test("a Fraud Check filed without a note opens on an empty conversation", () => {
  const markup = messages(task({ notes: "" }));
  assert.match(markup, /class="msgs-empty"/, "the empty state, not a list");
  assert.ok(!markup.includes("msg-bubble"), "and no bubble hanging off an avatar with nothing in it");
  assert.ok(!markup.includes("expand-avatar"), "and no byline attached to nothing");
});

test("a Fraud Check filed with a note still opens on it", () => {
  const markup = messages(task());
  assert.match(markup, /class="msg-bubble"/);
  assert.ok(markup.includes(NOTE));
});

test("a note-less Fraud Check's replies are still its thread", () => {
  /* The missing note removes the opening row and nothing else: the replies are
     a conversation whether or not the request field started it. */
  const markup = messages(
    task({ notes: "", reviewNotes: [{ id: "n1", by: { ...ASSIGNEE }, at: T2, text: "Found it" }] })
  );
  assert.ok(!markup.includes("msgs-empty"), "a thread with a reply is not empty");
  assert.ok(markup.includes("Found it"));
  assert.equal((markup.match(/msg-bubble/g) ?? []).length, 1, "one row, and it is the reply");
});

test("the five box types are untouched by any of this", () => {
  for (const taskType of TASK_TYPES.filter((t) => t !== "FRAUD")) {
    assert.equal(threadOpeningNoteFor({ taskType, notes: NOTE }), undefined, `${taskType} keeps its field in the box`);
    const markup = messages(task({ taskType }));
    assert.match(markup, /class="msgs-empty"/, `${taskType} still opens on an empty conversation`);
  }
  assert.equal(threadOpeningNoteFor({ taskType: "FRAUD", notes: NOTE }), NOTE);
  assert.equal(threadOpeningNoteFor({ taskType: "FRAUD", notes: "   " }), undefined);
});

/* ── Correcting a task is unchanged ───────────────────────── */

test("an emptied field is still refused on the edit path, on every type", () => {
  /* ADR-0010 rule 3 relaxes *filing*, not correcting. A Fraud Check filed on
     its conditions has no note to empty; one that has a note cannot have it
     wiped through the edit form any more than an LOI can. `editRefusal` never
     asked what type it was looking at and still doesn't — that sameness is the
     assertion. */
  const values = { notes: "   ", folderName: "Folder", humperdinkLink: "", urgency: "GREEN", points: 1, startDate: "", returnDate: "" };
  const refusal = editRefusal(values);
  assert.ok(refusal, "a field wiped to spaces is refused");
  assert.equal(refusal.field, "notes");
  assert.equal(editRefusal({ ...values, notes: NOTE }), null, "and a filled one goes through");
});

/* ── One rule, asked by both sides ────────────────────────── */

test("the form and the server ask the one function rather than agreeing by luck", () => {
  /* The whole reason this is a shared function: a `required` attribute cannot
     see the conditions list and a `min(1)` on `notes` cannot either, so any
     surface enforcing this by itself is enforcing something else. */
  for (const path of ["apps/server/src/validation.ts", "apps/web/src/task-form.tsx"]) {
    assert.match(readFileSync(join(REPO, path), "utf8"), /fraudFilingRefusal/, `${path} asks the shared rule`);
  }
  const shared = readFileSync(join(REPO, "packages/shared/src/workflow.ts"), "utf8");
  assert.match(shared, /export const fraudFilingRefusal/, "and the rule lives in shared");
  assert.match(shared, /export const FRAUD_FILING_REFUSAL/, "with the sentence beside it");
});
