#!/usr/bin/env node
/* Unit test for the create form's value state (apps/web/src/create-form-state.ts).

   The create form used to be openable exactly one way: blank, from a hardcoded
   state literal inside <CreateTaskForm>. Issue #194 needs it openable with
   values already in it — an imported Humperdink loan fills Folder Name and the
   Humperdink Link — so the literal moved out into a framework-free module that
   takes initial values and returns the whole form state.

   #283 added a third question to the same module — whether the form differs from
   the one that was opened, which is what closing it asks before throwing the
   draft away.

   Everything here is plain value-in/value-out, so it runs under node's TS type
   stripping (node >= 24) with no build and no React.
   Run: `node --test scripts/create-form-state-sim-test.mjs`. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  BLANK_CREATE_FORM,
  applyImportedLoan,
  editFormValues,
  formHasChanges,
  initialCreateForm
} from "../apps/web/src/create-form-state.ts";

/* ── The prefactor: opening blank must not change ───────── */

test("no initial values opens the form blank", () => {
  assert.deepEqual(initialCreateForm(), BLANK_CREATE_FORM);
  assert.deepEqual(initialCreateForm(undefined), BLANK_CREATE_FORM);
  assert.deepEqual(initialCreateForm({}), BLANK_CREATE_FORM);
});

test("the blank form is the shape the form has always opened in", () => {
  assert.equal(BLANK_CREATE_FORM.folderName, "");
  assert.equal(BLANK_CREATE_FORM.loanId, "");
  assert.equal(BLANK_CREATE_FORM.taskType, "LOI");
  assert.equal(BLANK_CREATE_FORM.urgency, "GREEN");
  assert.equal(BLANK_CREATE_FORM.startDate, "");
  assert.equal(BLANK_CREATE_FORM.returnDate, "");
  assert.equal(BLANK_CREATE_FORM.notes, "");
  assert.equal(BLANK_CREATE_FORM.humperdinkLink, "");
  assert.equal(BLANK_CREATE_FORM.points, 0);
  assert.deepEqual(BLANK_CREATE_FORM.initialItems, []);
  assert.equal(BLANK_CREATE_FORM.pickerMode, "share");
  assert.equal(BLANK_CREATE_FORM.recipientUserId, "");
  assert.equal(BLANK_CREATE_FORM.recipientNote, "");
});

test("initial values seed the fields they name and nothing else", () => {
  const form = initialCreateForm({ folderName: "Adams - Harbor", humperdinkLink: "https://h/Loans/Details/1" });
  assert.equal(form.folderName, "Adams - Harbor");
  assert.equal(form.humperdinkLink, "https://h/Loans/Details/1");
  // Untouched fields keep their blank-form defaults.
  assert.equal(form.taskType, "LOI");
  assert.equal(form.urgency, "GREEN");
  assert.equal(form.notes, "");
});

test("initial values can set task type, urgency, notes and points", () => {
  const form = initialCreateForm({ taskType: "FRAUD", urgency: "RED", notes: "check this", points: 3 });
  assert.equal(form.taskType, "FRAUD");
  assert.equal(form.urgency, "RED");
  assert.equal(form.notes, "check this");
  assert.equal(form.points, 3);
});

test("an explicitly-undefined initial value falls back to blank, it does not blank the field out", () => {
  // Callers spread optional values in, so `{ folderName: undefined }` is a
  // normal thing to receive and must behave like "not supplied".
  const form = initialCreateForm({ folderName: undefined, taskType: undefined });
  assert.equal(form.folderName, "");
  assert.equal(form.taskType, "LOI");
});

test("initialCreateForm never hands back the shared blank object", () => {
  const a = initialCreateForm();
  const b = initialCreateForm();
  assert.notEqual(a, BLANK_CREATE_FORM, "mutating form state must not corrupt the blank");
  assert.notEqual(a.initialItems, BLANK_CREATE_FORM.initialItems, "the array is copied too");
  assert.notEqual(a, b);
});

/* ── Applying an imported loan to a form already open ───── */

const payload = {
  kind: "hot-task-humperdink",
  version: 1,
  loanName: "Adams - Harbor",
  loanUrl: "https://humperdink.loneoakfund.com/Loans/Details/335203"
};

test("an imported loan fills Folder Name and the Humperdink Link", () => {
  const next = applyImportedLoan(initialCreateForm(), payload);
  assert.equal(next.folderName, "Adams - Harbor");
  assert.equal(next.humperdinkLink, "https://humperdink.loneoakfund.com/Loans/Details/335203");
});

test("an import leaves everything the filer already typed alone", () => {
  const typed = { ...initialCreateForm(), notes: "half-written note", urgency: "RED", points: 2 };
  const next = applyImportedLoan(typed, payload);
  assert.equal(next.notes, "half-written note");
  assert.equal(next.urgency, "RED");
  assert.equal(next.points, 2);
});

/* The loan link is the canonical key for a Loan (ADR-0001) and the server
   resolves it with `findLoanForCreate`. A stale loanId from an earlier
   typeahead pick would override that resolution and file the task against the
   wrong loan, so importing clears it. */
test("an import clears any loan picked earlier from the typeahead", () => {
  const picked = { ...initialCreateForm(), folderName: "Someone else", loanId: "loan-9" };
  assert.equal(applyImportedLoan(picked, payload).loanId, "");
});

test("applyImportedLoan does not mutate the form it was given", () => {
  const before = initialCreateForm();
  applyImportedLoan(before, payload);
  assert.equal(before.folderName, "");
  assert.equal(before.humperdinkLink, "");
});

/* ── The terms an import writes into the notes (#196) ───── */

const TERMS_NOTE = ["Loan Terms", "Loan Amount: $1,300,000", "LTV: 39.87%"].join("\n");

test("an import writes the terms into the notes field", () => {
  const next = applyImportedLoan(initialCreateForm(), payload, { noteText: TERMS_NOTE });
  assert.equal(next.notes, TERMS_NOTE);
});

/* The notes field for an LOI is already labelled "Loan Terms and Contacts",
   and this import is LOI-only for now. */
test("an import sets the task type to LOI", () => {
  const typed = { ...initialCreateForm(), taskType: "VALUE" };
  assert.equal(applyImportedLoan(typed, payload, { noteText: TERMS_NOTE }).taskType, "LOI");
  assert.equal(applyImportedLoan(initialCreateForm(), payload).taskType, "LOI");
});

test("terms land under whatever the filer had already typed, not over it", () => {
  const typed = { ...initialCreateForm(), notes: "Ask about the second TD" };
  const next = applyImportedLoan(typed, payload, { noteText: TERMS_NOTE });
  assert.equal(next.notes, `Ask about the second TD\n\n${TERMS_NOTE}`);
});

/* Pasting the wrong loan and re-importing is the ordinary correction, so the
   second import replaces the first one's block rather than stacking a copy of
   the terms under it. */
test("re-importing replaces the last import's block and keeps the filer's own text", () => {
  const first = applyImportedLoan(
    { ...initialCreateForm(), notes: "Ask about the second TD" },
    payload,
    { noteText: TERMS_NOTE }
  );
  const second = applyImportedLoan(first, payload, {
    noteText: "Loan Terms\nLoan Amount: $900,000",
    previousNoteText: TERMS_NOTE
  });
  assert.equal(second.notes, "Ask about the second TD\n\nLoan Terms\nLoan Amount: $900,000");
});

test("importing the same loan twice does not double the terms", () => {
  const once = applyImportedLoan(initialCreateForm(), payload, { noteText: TERMS_NOTE });
  const twice = applyImportedLoan(once, payload, { noteText: TERMS_NOTE, previousNoteText: TERMS_NOTE });
  assert.equal(twice.notes, TERMS_NOTE);
});

/* A block the filer has since reworded is theirs. Matching literally means an
   edited block is left alone rather than half-removed. */
test("a previous block the filer has edited is left where it is", () => {
  const edited = { ...initialCreateForm(), notes: "Loan Terms\nLoan Amount: $1,300,000 (confirmed)" };
  const next = applyImportedLoan(edited, payload, { noteText: TERMS_NOTE, previousNoteText: TERMS_NOTE });
  assert.equal(next.notes, `Loan Terms\nLoan Amount: $1,300,000 (confirmed)\n\n${TERMS_NOTE}`);
});

test("a payload with no terms leaves the notes exactly as they were", () => {
  const typed = { ...initialCreateForm(), notes: "half-written note" };
  assert.equal(applyImportedLoan(typed, payload).notes, "half-written note");
  assert.equal(applyImportedLoan(typed, payload, {}).notes, "half-written note");
});

test("an import still touches nothing else the filer typed", () => {
  const typed = { ...initialCreateForm(), urgency: "RED", points: 2, startDate: "2026-01-05" };
  const next = applyImportedLoan(typed, payload, { noteText: TERMS_NOTE });
  assert.equal(next.urgency, "RED");
  assert.equal(next.points, 2);
  assert.equal(next.startDate, "2026-01-05");
});

test("applying terms does not mutate the form it was given", () => {
  const before = { ...initialCreateForm(), notes: "mine" };
  applyImportedLoan(before, payload, { noteText: TERMS_NOTE });
  assert.equal(before.notes, "mine");
  assert.equal(before.taskType, "LOI");
});

test("a re-import tidies only the seam it left, not the filer's own paragraphs", () => {
  const typed = "Ask about the second TD\n\n\nAnd the appraisal date";
  const first = applyImportedLoan({ ...initialCreateForm(), notes: typed }, payload, { noteText: TERMS_NOTE });
  const second = applyImportedLoan(first, payload, { noteText: TERMS_NOTE, previousNoteText: TERMS_NOTE });
  assert.equal(second.notes, `${typed}\n\n${TERMS_NOTE}`);
});

/* ── Is there anything to lose on the way out? (#283) ───────

   Closing the form asks first once someone has done something to it, and the
   whole of "has someone done something to it" is `formHasChanges`. It is a plain
   function over two value objects precisely so this can be asked without
   rendering a form, and so the draft-saving ticket that follows can reuse it.

   The comparison is always against the values the form OPENED with, which is
   what lets one predicate serve both modes: a blank create form, a seeded one,
   and an edit form full of the task's own values are all "untouched" until
   somebody touches them. */

test("a form nobody has touched has nothing to lose, in either mode", () => {
  const blank = initialCreateForm();
  assert.equal(formHasChanges(blank, blank), false, "the same object");
  assert.equal(formHasChanges(initialCreateForm(), initialCreateForm()), false, "and two equal ones");

  /* Edit mode opens full of values nobody typed. Measured against a blank form
     every edit would prompt, which is why the opening values are the yardstick. */
  const task = {
    taskType: "LOI",
    notes: "Loan Amount: $2,340,000",
    folderName: "Whitfield 4471",
    humperdinkLink: "https://h.example/whitfield-4471",
    urgency: "RED",
    points: 3,
    createdBy: { id: "creator-1", displayName: "Dana Requester" }
  };
  const opened = editFormValues(task);
  assert.equal(formHasChanges(opened, editFormValues(task)), false, "an untouched edit form closes at once");
  assert.equal(formHasChanges(blank, opened), true, "though it is nothing like a blank one");
});

/* A form opened with values in it (#194 — an imported Humperdink loan, a deep
   link) is untouched until somebody changes those values, not because they are
   blank but because they are what was put there. */
test("values the form was opened with are not changes", () => {
  const seeded = initialCreateForm({ folderName: "Adams - Harbor", taskType: "FRAUD" });
  assert.equal(formHasChanges(seeded, initialCreateForm({ folderName: "Adams - Harbor", taskType: "FRAUD" })), false);
  assert.equal(formHasChanges(seeded, { ...seeded, folderName: "Adams - Harbour" }), true, "editing one is");
});

/* Deliberately over-eager. Every field counts, one on its own is enough, and
   nothing is trimmed or normalised first — this answers "did this person do
   anything here", not `taskEdit`'s much more forgiving "is this worth sending". */
test("any single field differing from the opening form is enough", () => {
  const opened = initialCreateForm();
  const changes = {
    folderName: "Adams - Harbor",
    loanId: "loan-9",
    taskType: "FRAUD",
    urgency: "RED",
    startDate: "2026-03-02",
    returnDate: "2026-03-09",
    notes: "n",
    humperdinkLink: "https://h.example/1",
    points: 1,
    initialItems: ["Missing appraisal"],
    pickerMode: "assign",
    recipientUserId: "user-3",
    recipientNote: "please take this"
  };
  for (const [field, value] of Object.entries(changes)) {
    assert.equal(formHasChanges(opened, { ...opened, [field]: value }), true, `${field} alone counts`);
  }
  assert.equal(Object.keys(changes).length, Object.keys(BLANK_CREATE_FORM).length, "and every field is covered here");
});

/* The ticket calls this one out by name: a type picked and nothing else typed is
   still a decision somebody made, and a threshold that ignored the type picker
   would eventually eat real work. */
test("changing only the task type is something to lose", () => {
  const opened = initialCreateForm();
  assert.equal(formHasChanges(opened, { ...opened, taskType: "OOO" }), true);
});

/* Whitespace is not normalised away. A space typed into an empty box is a box
   somebody typed into, and the prompt costs one click while the wrong answer
   costs the draft. */
test("even typing a single space counts", () => {
  const opened = initialCreateForm();
  assert.equal(formHasChanges(opened, { ...opened, notes: " " }), true);
});

/* The seeder rebuilds the list on every add, so reference equality would call
   every form changed and comparing the references as values would call none of
   them changed. */
test("the outstanding-items list is compared item by item, not by reference", () => {
  const opened = initialCreateForm();
  assert.equal(formHasChanges(opened, { ...opened, initialItems: [] }), false, "a fresh empty array is no change");
  assert.equal(formHasChanges(opened, { ...opened, initialItems: ["Missing appraisal"] }), true, "an added item is");
  const seeded = { ...opened, initialItems: ["Missing appraisal", "No W-2"] };
  assert.equal(formHasChanges(seeded, { ...seeded, initialItems: ["Missing appraisal", "No W-2"] }), false);
  assert.equal(formHasChanges(seeded, { ...seeded, initialItems: ["Missing appraisal"] }), true, "a removed one too");
  assert.equal(formHasChanges(seeded, { ...seeded, initialItems: ["No W-2", "Missing appraisal"] }), true, "reordered");
});

/* The FRAUD seeder's input holds typing that has not been committed to the list
   yet. It lives outside the values object in the component, so it is passed in
   — and losing a half-typed item silently is exactly what this ticket is about. */
test("a half-typed outstanding item counts as something to lose", () => {
  const opened = initialCreateForm();
  assert.equal(formHasChanges(opened, opened, "Missing appr"), true);
  assert.equal(formHasChanges(opened, opened, ""), false, "an empty box is not");
  assert.equal(formHasChanges(opened, opened, "   "), false, "nor is one holding only spaces");
  assert.equal(formHasChanges(opened, opened), false, "and it is optional");
});

test("formHasChanges does not touch either form it is given", () => {
  const opened = initialCreateForm();
  const current = { ...opened, notes: "typed" };
  formHasChanges(opened, current);
  assert.deepEqual(opened, initialCreateForm());
  assert.equal(current.notes, "typed");
});
