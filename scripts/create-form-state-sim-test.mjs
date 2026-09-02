#!/usr/bin/env node
/* Unit test for the create form's value state (apps/web/src/create-form-state.ts).

   The create form used to be openable exactly one way: blank, from a hardcoded
   state literal inside <CreateTaskForm>. Issue #194 needs it openable with
   values already in it — an imported Humperdink loan fills Folder Name and the
   Humperdink Link — so the literal moved out into a framework-free module that
   takes initial values and returns the whole form state.

   Both functions here are plain value-in/value-out, so they run under node's TS
   type stripping (node >= 24) with no build and no React.
   Run: `node --test scripts/create-form-state-sim-test.mjs`. */
import assert from "node:assert/strict";
import test from "node:test";

import { BLANK_CREATE_FORM, applyImportedLoan, initialCreateForm } from "../apps/web/src/create-form-state.ts";

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
