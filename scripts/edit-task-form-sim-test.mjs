#!/usr/bin/env node
/* Issues #260 and #262 / ADR-0008 rules 4 and 7 — `Edit Task` opens the create
 * form in edit mode, and saves the request field, the folder name and the
 * Humperdink link.
 *
 * Two halves, because the ticket makes two different kinds of promise.
 *
 * The first is arithmetic: what a save actually sends. There is deliberately no
 * catch-all update route (ADR-0008 rule 4, inherited from ADR-0006), so the
 * form has to work out which focused operation to call, and setting a field to
 * what it already says must call nothing at all — no request, so no history
 * event and no notification. That decision is a pure function over the task and
 * the form's values, and it is tested as one.
 *
 * The second is what a person sees: the same form they file with, preloaded,
 * with the two filing-time controls gone, the type shown but locked, and a save
 * action. That is rendered markup, so this file compiles the form with esbuild
 * and renders it through `react-dom/server`, the way the terms section is
 * tested in `instructions-box-sim-test.mjs`.
 *
 * Source checks at the end cover what neither half can: the hamburger is the
 * only door (`Edit Task` in the menu), the old `Edit request` button is gone
 * from the terms head and the conversation head alike, each field lands on the
 * record that owns it, and a link edit that would fold two loans together is
 * refused by the server rather than merged.
 *
 * One thing this file cannot do: type into the form. There is no DOM harness
 * here, and the form seeds itself from the task, so its first paint is always
 * the unchanged one. WHEN the shared-record line appears is therefore tested as
 * the pure predicate `touchesSharedLoan`, and what the form does with that
 * answer is read out of the source.
 *
 * Run: `node --test scripts/edit-task-form-sim-test.mjs`. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TASK_TYPES, getNotesFieldLabel } from "../packages/shared/dist/types.js";
import { canAmendTask } from "../packages/shared/dist/workflow.js";
import {
  BLANK_CREATE_FORM,
  editFormValues,
  editRefusal,
  initialCreateForm,
  taskEdit,
  touchesSharedLoan
} from "../apps/web/src/create-form-state.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));

const TERMS = "Loan Amount: $2,340,000\nRate: 9.75%\nBroker: Dana Whitfield";

const loiTask = (over = {}) => ({
  id: "task-1",
  taskType: "LOI",
  notes: TERMS,
  loanId: "loan-1",
  folderName: "Whitfield 4471",
  humperdinkLink: "https://h.example/whitfield-4471",
  urgency: "GREEN",
  points: 2,
  createdBy: { id: "creator-1", displayName: "Dana Requester" },
  ...over
});

/* An out-of-office task: no loan, so its folder name is a vacation description
   that lives on the task, and there is no Humperdink link at all. */
const oooTask = (over = {}) => ({
  id: "task-ooo",
  taskType: "OOO",
  notes: "back on the 4th",
  folderName: "Two weeks in Lisbon",
  startDate: "2026-03-02",
  returnDate: "2026-03-09",
  urgency: "GREEN",
  points: 2,
  createdBy: { id: "creator-1", displayName: "Dana Requester" },
  ...over
});

/* ── What the form opens with ───────────────────────────── */

test("edit mode opens preloaded with what the task already says", () => {
  const values = editFormValues(loiTask());
  assert.equal(values.notes, TERMS);
  assert.equal(values.taskType, "LOI");
});

test("edit mode preloads the equivalent field on the other five types", () => {
  for (const taskType of ["BUDDY_CHAT", "VALUE", "FRAUD", "LOAN_DOCS", "OOO"]) {
    const values = editFormValues(loiTask({ taskType, notes: "what I asked for" }));
    assert.equal(values.taskType, taskType);
    assert.equal(values.notes, "what I asked for");
  }
});

/* The loan fields open preloaded too (#262), read off the task — the server
   pushes the loan's current name and link onto every linked task, so the task
   already IS the loan's copy and nothing has to be looked up. */
test("edit mode opens preloaded with the loan's name and link", () => {
  const values = editFormValues(loiTask());
  assert.equal(values.folderName, "Whitfield 4471");
  assert.equal(values.humperdinkLink, "https://h.example/whitfield-4471");
});

test("an OOO task preloads its vacation description and no link", () => {
  const values = editFormValues(oooTask());
  assert.equal(values.folderName, "Two weeks in Lisbon");
  assert.equal(values.humperdinkLink, "");
});

test("a loan with no link yet opens with an empty link box, not undefined", () => {
  const values = editFormValues(loiTask({ humperdinkLink: undefined }));
  assert.equal(values.humperdinkLink, "");
});

/* #261 put urgency and poop points on the form beside the request field. They
   preload from the task, not from the blank form's defaults — an urgency select
   sitting on GREEN when the task is RED is a control that lies, and saving it
   would quietly downgrade the deadline. */
test("edit mode preloads the task's urgency and points", () => {
  const values = editFormValues(loiTask({ urgency: "RED", points: 4 }));
  assert.equal(values.urgency, "RED");
  assert.equal(values.points, 4);
});

test("an unrated task preloads no poops rather than the blank form's default", () => {
  assert.equal(editFormValues(loiTask({ points: 0 })).points, 0);
});

/* The dates are blank on an LOI because an LOI has none; the OOO case is its
   own section further down. Nothing else in the form can move the fields below,
   and `taskEdit` refuses to send them even if something did. */
test("edit mode carries no other field into the form", () => {
  const values = editFormValues(loiTask());
  assert.equal(values.loanId, BLANK_CREATE_FORM.loanId);
  assert.equal(values.startDate, BLANK_CREATE_FORM.startDate);
  assert.equal(values.returnDate, BLANK_CREATE_FORM.returnDate);
  assert.equal(values.recipientUserId, BLANK_CREATE_FORM.recipientUserId);
  assert.deepEqual(values.initialItems, []);
});

test("filing a new task is unaffected — the blank form still opens blank", () => {
  assert.deepEqual(initialCreateForm(), BLANK_CREATE_FORM);
});

/* ── What a save sends ──────────────────────────────────── */

test("a changed request field is the one thing sent", () => {
  const task = loiTask();
  const values = { ...editFormValues(task), notes: "Rate: 9.25%" };
  assert.deepEqual(taskEdit(task, values), { notes: "Rate: 9.25%" });
});

test("saving an unchanged request field sends nothing", () => {
  const task = loiTask();
  assert.deepEqual(taskEdit(task, editFormValues(task)), {});
});

/* Trailing whitespace is not an edit. The server would happily record one and
   DM about it, so the no-op is decided before the request, not after it. */
test("a whitespace-only difference is not a change", () => {
  const task = loiTask({ notes: "Rate: 9.75%" });
  const values = { ...editFormValues(task), notes: "  Rate: 9.75%\n\n" };
  assert.deepEqual(taskEdit(task, values), {});
});

/* Terms are required on edit as well as on create (ADR-0008 rule 1): an edit
   that could empty them would leave a checked LOI saying nothing about what was
   checked. Emptying the box is therefore never a change to send. */
test("an emptied request field is refused rather than saved", () => {
  const task = loiTask();
  const values = { ...editFormValues(task), notes: "   " };
  assert.deepEqual(taskEdit(task, values), {});
});

/* …and the person has to be told. `taskEdit` returning nothing is
   indistinguishable from "you changed nothing", which closes the form without a
   word. The browser's `required` catches a box emptied to "", but a single
   space satisfies it, so the refusal is decided here and shown on the field. */
test("wiping the request field to whitespace is refused with a reason", () => {
  for (const wiped of [" ", "   ", "\n", " \n\t "]) {
    const refusal = editRefusal({ ...editFormValues(loiTask()), notes: wiped }, loiTask());
    assert.equal(refusal?.field, "notes", `"${wiped}" should be refused, on the request box`);
    assert.ok(refusal.message.length > 0);
  }
});

test("a box emptied outright is refused the same way", () => {
  assert.equal(editRefusal({ ...editFormValues(loiTask()), notes: "" }, loiTask())?.field, "notes");
});

/* #262: the folder name is the loan's name on every task pointing at it, so a
   blank one is a mistake rather than an instruction — refused like the terms,
   and named separately so the message lands on the box it is about. */
test("wiping the folder name is refused too, and says so on that box", () => {
  for (const wiped of ["", " ", "  \n "]) {
    const refusal = editRefusal({ ...editFormValues(loiTask()), folderName: wiped }, loiTask());
    assert.equal(refusal?.field, "folderName", `"${wiped}" should be refused, on the folder name`);
    assert.ok(refusal.message.length > 0);
  }
});

/* The link is optional. Clearing it is a real edit, not a mistake. */
test("clearing the Humperdink link is never refused", () => {
  assert.equal(editRefusal({ ...editFormValues(loiTask()), humperdinkLink: "" }, loiTask()), null);
  assert.equal(editRefusal({ ...editFormValues(loiTask()), humperdinkLink: "   " }, loiTask()), null);
});

test("an OOO task's description is refused when wiped, like any folder name", () => {
  assert.equal(editRefusal({ ...editFormValues(oooTask()), folderName: " " }, oooTask())?.field, "folderName");
  assert.equal(editRefusal(editFormValues(oooTask()), oooTask()), null);
});

test("real terms are not refused, whatever whitespace surrounds them", () => {
  assert.equal(editRefusal(editFormValues(loiTask()), loiTask()), null);
  assert.equal(editRefusal({ ...editFormValues(loiTask()), notes: "  Rate: 9.25%\n" }, loiTask()), null);
});

/* ── Urgency and points (#261) ──────────────────────────── */

test("a changed urgency is sent on its own", () => {
  const task = loiTask();
  assert.deepEqual(taskEdit(task, { ...editFormValues(task), urgency: "RED" }), { urgency: "RED" });
});

test("changed points are sent on their own", () => {
  const task = loiTask();
  assert.deepEqual(taskEdit(task, { ...editFormValues(task), points: 5 }), { points: 5 });
});

test("clearing the poops sends the zero rather than nothing", () => {
  const task = loiTask({ points: 3 });
  assert.deepEqual(taskEdit(task, { ...editFormValues(task), points: 0 }), { points: 0 });
});

test("changing all three in one save sends all three", () => {
  const task = loiTask();
  const values = { ...editFormValues(task), notes: "Rate: 9.25%", urgency: "YELLOW", points: 5 };
  assert.deepEqual(taskEdit(task, values), { notes: "Rate: 9.25%", urgency: "YELLOW", points: 5 });
});

test("changing none of the three sends nothing", () => {
  const task = loiTask();
  assert.deepEqual(taskEdit(task, editFormValues(task)), {});
});

/* An OOO task's timing is its start and return dates, not an urgency — the
   server refuses the route outright — so the form neither shows the control nor
   lets a stale value leak into a save. */
test("an OOO task never sends an urgency", () => {
  const task = loiTask({ taskType: "OOO", notes: "back on the 9th", urgency: "GREEN" });
  const values = { ...editFormValues(task), urgency: "RED", points: 4 };
  assert.deepEqual(taskEdit(task, values), { points: 4 });
});

/* ── An OOO task's dates (#264, ADR-0008 rule 8) ────────── */

test("edit mode preloads an OOO task's start and return dates", () => {
  const values = editFormValues(oooTask());
  assert.equal(values.startDate, "2026-03-02");
  assert.equal(values.returnDate, "2026-03-09");
});

/* The two are one range, so one of them moving sends both: the server's rule is
   that the start is on or before the return, which it cannot check against half
   of the pair, and history that named one value would say less than what
   changed. */
test("moving one date sends both", () => {
  const task = oooTask();
  const values = { ...editFormValues(task), returnDate: "2026-03-06" };
  assert.deepEqual(taskEdit(task, values), { dates: { startDate: "2026-03-02", returnDate: "2026-03-06" } });
});

test("moving both sends both", () => {
  const task = oooTask();
  const values = { ...editFormValues(task), startDate: "2026-03-03", returnDate: "2026-03-06" };
  assert.deepEqual(taskEdit(task, values), { dates: { startDate: "2026-03-03", returnDate: "2026-03-06" } });
});

test("saving unchanged dates sends nothing", () => {
  const task = oooTask();
  assert.deepEqual(taskEdit(task, editFormValues(task)), {});
});

/* A return date already gone is a correction, not a mistake: somebody back
   early is the case the edit exists for. Nothing here refuses it — the server
   accepts it and the next maintenance pass auto-completes the task. */
test("a return date in the past is sent like any other", () => {
  const task = oooTask();
  const values = { ...editFormValues(task), startDate: "2020-01-06", returnDate: "2020-01-08" };
  assert.deepEqual(taskEdit(task, values), { dates: { startDate: "2020-01-06", returnDate: "2020-01-08" } });
});

/* A cleared input is a half-finished edit, not an instruction to unset a
   vacation's start date. There is no route that can express that, so the form
   sends nothing rather than something the server would have to interpret. */
test("an emptied date is not a change to send", () => {
  const task = oooTask();
  assert.deepEqual(taskEdit(task, { ...editFormValues(task), startDate: "" }), {});
  assert.deepEqual(taskEdit(task, { ...editFormValues(task), returnDate: "" }), {});
});

/* The mirror of "an OOO task never sends an urgency": only an OOO task has
   dates, so nothing else can leak a stray value into a route that refuses it. */
test("the other five types never send dates", () => {
  for (const taskType of ["LOI", "BUDDY_CHAT", "VALUE", "FRAUD", "LOAN_DOCS"]) {
    const task = loiTask({ taskType, notes: "what I asked for" });
    const values = { ...editFormValues(task), startDate: "2026-03-02", returnDate: "2026-03-09" };
    assert.deepEqual(taskEdit(task, values), {}, taskType);
  }
});

test("an OOO task can change its dates, its poops and its notes in one save", () => {
  const task = oooTask();
  const values = { ...editFormValues(task), notes: "back Monday, not Tuesday", points: 3, returnDate: "2026-03-06" };
  assert.deepEqual(taskEdit(task, values), {
    notes: "back Monday, not Tuesday",
    points: 3,
    dates: { startDate: "2026-03-02", returnDate: "2026-03-06" }
  });
});

/* The guard against a catch-all update creeping in: even a form whose every
   other value has moved sends only the fields this form actually offers. The
   seeded items, the recipient and the task type are not among them. */
test("only the fields the form offers are ever sent, whatever else moved", () => {
  const task = loiTask();
  const values = {
    ...editFormValues(task),
    notes: "Rate: 9.25%",
    folderName: "Some Other Loan",
    humperdinkLink: "https://example.test/other",
    startDate: "2026-01-01",
    returnDate: "2026-01-08",
    initialItems: ["appraisal"],
    recipientUserId: "someone",
    taskType: "FRAUD"
  };
  assert.deepEqual(taskEdit(task, values), {
    notes: "Rate: 9.25%",
    folderName: "Some Other Loan",
    humperdinkLink: "https://example.test/other"
  });
});

/* ── What a save sends for the loan fields (#262) ────────── */

test("a corrected folder name is sent on its own", () => {
  const task = loiTask();
  const values = { ...editFormValues(task), folderName: "Whitfield 4417" };
  assert.deepEqual(taskEdit(task, values), { folderName: "Whitfield 4417" });
});

test("a corrected link is sent on its own", () => {
  const task = loiTask();
  const values = { ...editFormValues(task), humperdinkLink: "https://h.example/whitfield-4417" };
  assert.deepEqual(taskEdit(task, values), { humperdinkLink: "https://h.example/whitfield-4417" });
});

test("unchanged loan fields send nothing, whitespace included", () => {
  const task = loiTask();
  const values = { ...editFormValues(task), folderName: "  Whitfield 4471 ", humperdinkLink: " https://h.example/whitfield-4471 " };
  assert.deepEqual(taskEdit(task, values), {});
});

/* The folder name is the loan's name on every task pointing at it, so an
   emptied box is a mistake rather than an instruction. The link is optional, so
   clearing it is a real edit and does go. */
test("an emptied folder name is refused, an emptied link is a real edit", () => {
  const task = loiTask();
  assert.deepEqual(taskEdit(task, { ...editFormValues(task), folderName: "   " }), {});
  assert.deepEqual(taskEdit(task, { ...editFormValues(task), humperdinkLink: "" }), { humperdinkLink: "" });
});

/* An OOO task has no loan, so nothing may ever produce a link for one — a stray
   value in the form state must not be posted at a Loan record that isn't there. */
test("an OOO task sends its description and never a link", () => {
  const task = oooTask();
  const values = { ...editFormValues(task), folderName: "Three weeks in Lisbon", humperdinkLink: "https://h.example/nope" };
  assert.deepEqual(taskEdit(task, values), { folderName: "Three weeks in Lisbon" });
});

/* ── When the shared-record line appears (ADR-0008 rule 7) ─ */

test("the shared-loan line stays away until a value actually moves", () => {
  const task = loiTask();
  assert.equal(touchesSharedLoan(task, editFormValues(task)), false, "an untouched form warns about nothing");
  assert.equal(
    touchesSharedLoan(task, { ...editFormValues(task), notes: "Rate: 9.25%" }),
    false,
    "correcting the terms is not a shared-record edit"
  );
  assert.equal(
    touchesSharedLoan(task, { ...editFormValues(task), folderName: "  Whitfield 4471 " }),
    false,
    "and neither is retyping the same name with different whitespace"
  );
});

test("the shared-loan line appears for either field, and is one line for both", () => {
  const task = loiTask();
  assert.equal(touchesSharedLoan(task, { ...editFormValues(task), folderName: "Whitfield 4417" }), true);
  assert.equal(touchesSharedLoan(task, { ...editFormValues(task), humperdinkLink: "https://h.example/x" }), true);
  assert.equal(
    touchesSharedLoan(task, { ...editFormValues(task), folderName: "Whitfield 4417", humperdinkLink: "https://h.example/x" }),
    true,
    "both moving is still the one answer, and the form draws one line from it"
  );
});

test("an OOO task never shows it — there is no shared record", () => {
  const task = oooTask();
  assert.equal(touchesSharedLoan(task, { ...editFormValues(task), folderName: "Somewhere else entirely" }), false);
});

/* ── Who is offered the door ────────────────────────────── */

/* The menu item asks the shared predicate the server's own refusal is written
   from, so an `Edit Task` the server would turn away cannot be drawn — and,
   since #263, so an edit the server WOULD take is not hidden either.

   Who that is: the creator on any type, plus the checker holding an LOI, whose
   request field holds the loan's terms (ADR-0008 rule 5). Never an observer,
   never an unclaimed file checker, never on a closed task.

   Asserted here as well as in `amend-task-sim-test.mjs` because these two
   files are the comparison the ticket asks for — the server's answer and the
   surface's answer to the same question — and they only mean something read
   against each other. */
const CREATOR = { id: "creator-1", displayName: "Dana Requester" };
const ASSIGNEE = { id: "assignee-1", displayName: "Casey Checker" };
const OBSERVER = { id: "observer-1", displayName: "Sam Bystander" };
const OTHER_TYPES = ["BUDDY_CHAT", "VALUE", "FRAUD", "LOAN_DOCS", "OOO"];
const owned = (status, over = {}) => ({ createdBy: CREATOR, status, taskType: "VALUE", ...over });
const heldLoi = (status) => owned(status, { taskType: "LOI", assignee: ASSIGNEE });

test("the creator of an open task is offered Edit Task, on every type", () => {
  for (const status of ["OPEN", "CLAIMED", "NEEDS_REVIEW", "AWAITING_ITEMS", "PENDING_APPROVAL"]) {
    for (const taskType of ["LOI", ...OTHER_TYPES]) {
      assert.equal(canAmendTask(owned(status, { taskType }), CREATOR), true, `${taskType} ${status}`);
    }
  }
});

/* CLAIMED and NEEDS_REVIEW are every open status an LOI has — it runs the
   standard flow plus the corrections side branch, and AWAITING_ITEMS /
   PENDING_APPROVAL belong to FRAUD. NEEDS_REVIEW matters most: it moves whose
   turn it is, not who holds the task, so the checker is still the assignee. */
test("the checker holding an LOI is offered it too, at every open status", () => {
  for (const status of ["CLAIMED", "NEEDS_REVIEW"]) {
    assert.equal(canAmendTask(heldLoi(status), ASSIGNEE), true, status);
  }
});

test("the assignee of any other type is not", () => {
  for (const taskType of OTHER_TYPES) {
    assert.equal(
      canAmendTask(owned("CLAIMED", { taskType, assignee: ASSIGNEE }), ASSIGNEE),
      false,
      taskType
    );
  }
});

test("an observer is offered it on nothing, an LOI included", () => {
  assert.equal(canAmendTask(owned("CLAIMED", { assignee: ASSIGNEE }), OBSERVER), false);
  assert.equal(canAmendTask(heldLoi("CLAIMED"), OBSERVER), false);
});

/* A file checker who could take the LOI but hasn't is an observer until they
   do — the rule is about holding the task, not about being able to. */
test("an unclaimed LOI offers nothing to the checker who might claim it", () => {
  assert.equal(canAmendTask(owned("OPEN", { taskType: "LOI" }), ASSIGNEE), false);
});

test("a closed task offers no Edit Task, to either party", () => {
  for (const status of ["COMPLETED", "CANCELLED", "ARCHIVED"]) {
    assert.equal(canAmendTask(owned(status), CREATOR), false, status);
    assert.equal(canAmendTask(heldLoi(status), CREATOR), false, `LOI creator ${status}`);
    assert.equal(canAmendTask(heldLoi(status), ASSIGNEE), false, `LOI holder ${status}`);
  }
});

/* ── What edit mode looks like ──────────────────────────── */

/* The form is TSX with relative imports, so esbuild bundles rather than
   transforms. The toast provider comes out of the same bundle: the form calls
   `useToast`, and a provider imported separately would be a different module
   instance holding a different context. */
const scratch = mkdtempSync(join(REPO, "node_modules", ".edit-task-form-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const entry = join(scratch, "entry.tsx");
writeFileSync(
  entry,
  `export { TaskForm } from ${JSON.stringify(join(REPO, "apps/web/src/task-form.tsx"))};\n` +
    `export { ToastProvider } from ${JSON.stringify(join(REPO, "apps/web/src/toast.tsx"))};\n`
);
const formModule = join(scratch, "task-form.mjs");
await build({
  entryPoints: [entry],
  outfile: formModule,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  external: ["react", "react/jsx-runtime", "@loan-tasks/shared"],
  logLevel: "silent"
});
const { TaskForm, ToastProvider } = await import(pathToFileURL(formModule).href);

const DIRECTORY = [
  { id: ASSIGNEE.id, displayName: ASSIGNEE.displayName, roles: ["FILE_CHECKER"] },
  { id: OBSERVER.id, displayName: OBSERVER.displayName, roles: ["LOAN_OFFICER"] }
];
const USER = { ...CREATOR, roles: ["LOAN_OFFICER"] };

const render = (props) =>
  renderToStaticMarkup(
    createElement(ToastProvider, null, createElement(TaskForm, {
      loans: [],
      directory: DIRECTORY,
      user: USER,
      tasks: [],
      onClose: () => {},
      onCreate: async () => {},
      ...props
    }))
  );

const editing = (task = loiTask()) => render({ edit: { task, onSave: async () => {} } });

test("edit mode opens the create form preloaded, with a save action", () => {
  const html = editing();
  assert.match(html, /class="task-form"/);
  assert.ok(html.includes("Loan Amount: $2,340,000"), "the terms are in the box");
  assert.ok(html.includes(">Save<"), "the create action reads Save");
  assert.ok(!html.includes("Create Task"), "and the create action is gone");
});

test("the person picker is hidden in edit mode, with people to point at", () => {
  const html = editing();
  assert.ok(!html.includes("Share Directly"));
  assert.ok(!html.includes("Assign Directly"));
  assert.ok(!html.includes(ASSIGNEE.displayName));
});

test("the outstanding-items seeder is hidden in edit mode, even on a Fraud Check", () => {
  const html = editing(loiTask({ taskType: "FRAUD", notes: "please check this one" }));
  assert.ok(!html.includes("Outstanding Items"));
  assert.ok(!html.includes("Add an item"));
});

/* The type is shown and cannot be changed. It used to be a disabled <select>;
   it is now a padlocked chip, which keeps the promise and drops the invitation
   — a select that will not open still looks like the three live controls beside
   it in the top row. What is pinned is the promise, not the widget: the type is
   readable, there is no control offering to change it, and the reason and the
   way out are on the page and attached to the chip. */
test("the task type is shown, locked, with a reason", () => {
  const html = editing();
  assert.match(html, /class="task-form-type-locked"[^>]*>[\s\S]*?LOI Check/, "the type reads off the chip");
  assert.ok(!/<select[^>]*value="LOI"/.test(html), "and there is no type control to change it with");
  assert.ok(/can(’|')t be changed/.test(html), "the reason says the type can't change");
  assert.ok(/cancel/i.test(html) && /refile/i.test(html), "and says to cancel and refile");
});

/* The sentence is a popover on the chip rather than a line under the row: it
   answers a question nobody has until they reach for the control. Three things
   have to hold for that to be an improvement rather than a hiding place.

   It is always in the DOM, so `aria-describedby` resolves at all times and the
   explanation is not something only a pointer can reach. It is hidden by
   `visibility`, not `display: none`, which would take it out of the
   accessibility tree along with the layout. And it is positioned out of flow,
   so revealing it moves nothing on the form. */
test("the reason is a popover on the chip, and always reachable", () => {
  const html = editing();
  const chip = html.match(/class="task-form-type-locked" aria-describedby="([^"]+)"/);
  assert.ok(chip, "the chip names a description");
  assert.ok(
    html.includes(`<p id="${chip[1]}" class="task-form-type-note">`),
    "and it is the can't-be-changed popover, mounted with the form"
  );
  assert.ok(!html.includes("span-full task-form-locked"), "no permanent line under the row");

  const css = readFileSync(join(REPO, "apps/web/src/styles.css"), "utf8");
  const note = css.match(/\.task-form-type-note \{([^}]*)\}/);
  assert.ok(note, "the popover has its own rule");
  assert.match(note[1], /position: absolute/, "out of flow, so revealing it reflows nothing");
  assert.match(note[1], /visibility: hidden/, "hidden by visibility");
  assert.ok(!/display: none/.test(note[1]), "never display:none — that takes it out of the a11y tree too");
  assert.match(css, /\.task-form-type-locked:hover \+ \.task-form-type-note/, "hover reveals it");
  assert.match(css, /\.task-form-type-locked:focus-visible \+ \.task-form-type-note/, "and so does the keyboard");
});

/* ── The request field's heading (#301) ─────────────────── */

/* #301's table, spelled out because it is the product decision rather than
   something derivable. The card asserts the same list in
   `instructions-box-sim-test.mjs`; the point of writing it twice is that the
   form and the card have to agree, and a single shared constant would let both
   drift together. */
const HEADINGS = {
  LOI: "Loan Terms and Contacts",
  BUDDY_CHAT: "Concerns",
  VALUE: "Things to Look Out For",
  LOAN_DOCS: "Extras and Edits",
  OOO: "Coverage Notes",
  FRAUD: "Notes"
};

/* The heading is the label wrapping the textarea, so this looks for it there
   rather than anywhere in the page — "Notes" alone would match half the form. */
const notesHeading = (html) => html.match(/<label class="span-full">([^<]*)<textarea/)?.[1];

test("the create form heads the request field with what belongs in it, on every type", () => {
  for (const taskType of TASK_TYPES) {
    assert.equal(notesHeading(render({ initialValues: { taskType } })), HEADINGS[taskType], taskType);
  }
});

test("the edit form heads it identically — no surface disagrees", () => {
  for (const taskType of TASK_TYPES) {
    assert.equal(notesHeading(editing(loiTask({ taskType, notes: "what I asked for" }))), HEADINGS[taskType], taskType);
  }
});

test("both forms read the shared table rather than a heading of their own", () => {
  for (const taskType of TASK_TYPES) {
    assert.equal(HEADINGS[taskType], getNotesFieldLabel(taskType), `${taskType} is the table's own wording`);
  }
  const source = readFileSync(join(REPO, "apps/web/src/task-form.tsx"), "utf8");
  assert.ok(
    !/taskType === "FRAUD" \? "Notes"/.test(source),
    "the create form no longer hardcodes a heading for a Fraud Check"
  );
});

/* Hover alone is no affordance on a touch screen, and the chip sits where a
   control sits, so people press it. The press has to land somewhere. */
test("the chip is a real button, and Escape closes only the popover", () => {
  assert.match(editing(), /<button type="button" class="task-form-type-locked"/, "reachable by pointer and keyboard");
  const chip = formSource.slice(formSource.indexOf('className="task-form-type-locked"'));
  const escape = chip.slice(0, chip.indexOf("</button>"));
  assert.match(escape, /e\.key === "Escape"/, "Escape is handled on the chip");
  assert.match(escape, /e\.stopPropagation\(\)/, "and stopped, or the overlay closes the form and eats the draft");
});

/* What edit mode draws. Anything a viewer may not move is kept out rather than
   shown disabled:
   a control nobody can move is noise, and the type is shown at all only because
   a form that hid it would read as having lost the task's type. */
test("edit mode carries the request field, urgency and points", () => {
  const html = editing();
  assert.ok(html.includes("How Bad?"), "the poop picker is on the form");
  assert.ok(html.includes("Urgency"), "and so is urgency");
});

/* #261. Both preloaded, so the form opens saying what the task says. */
test("urgency opens on the task's band, not the blank form's", () => {
  const html = editing(loiTask({ urgency: "RED" }));
  assert.match(html, /<option [^>]*value="RED"[^>]*selected/, "RED is the selected option");
});

test("the poop picker opens on the task's rating", () => {
  const html = editing(loiTask({ points: 4 }));
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 4);
});

/* ADR-0008 rule 5: urgency is permanently the creator's, and on an OOO task it
   is not a field at all — the timing is the start and return dates, which the
   server refuses to express as an urgency. */
test("an OOO task's edit form has no urgency control", () => {
  const html = editing(loiTask({ taskType: "OOO", notes: "back on the 9th" }));
  assert.ok(!html.includes("Urgency"), "no urgency on an OOO task");
  assert.ok(html.includes("How Bad?"), "but the poops are still there");
});

/* The due date is derived from the band, never typed (docs/product/
   due-date-urgency.md). On the five types that have a urgency band, that leaves
   nothing in edit mode that is a date at all. */
test("no date input exists in the edit form on a task that has no dates", () => {
  for (const taskType of ["LOI", "BUDDY_CHAT", "VALUE", "FRAUD", "LOAN_DOCS"]) {
    const html = editing(loiTask({ taskType, notes: "what I asked for" }));
    assert.ok(!/type="date"/.test(html), taskType);
  }
  assert.ok(!editing().includes("Due"), "and nothing offers to set a due date");
});

/* #263's second half: the form a checker opens must offer nothing the server
   would refuse them. Urgency and poop points are the creator's on every type,
   and the form carries neither — so what the holder of an LOI sees is the one
   field they may write, with its terms in it. */
test("the checker holding an LOI gets the terms box and no creator-only control", () => {
  const html = render({
    user: { ...ASSIGNEE, roles: ["FILE_CHECKER"] },
    edit: { task: loiTask(), onSave: async () => {} }
  });
  assert.ok(html.includes("Loan Terms and Contacts"), "the terms box is there");
  assert.ok(html.includes("Loan Amount: $2,340,000"), "with the terms in it");
  assert.ok(!html.includes("Urgency"), "no urgency control");
  assert.ok(!html.includes("How Bad?"), "no poop points control");
});

/* The other half of the same promise: not drawing the controls is only half a
   guarantee if a stale value could still ride out on the save. It cannot — the
   form opens on the task's own urgency and rating, so with nothing to move
   them there is nothing for a checker's Save to send. */
test("a checker's save carries no urgency and no rating, only the terms", () => {
  const task = loiTask();
  const values = { ...editFormValues(task), notes: "Rate: 9.25%" };
  assert.deepEqual(taskEdit(task, values), { notes: "Rate: 9.25%" });
});

/* ── The loan fields in edit mode (#262) ────────────────── */

test("both loan fields are in the form, filled in from the task", () => {
  const html = editing();
  assert.ok(html.includes("Folder Name"), "the folder name is editable");
  assert.ok(html.includes("Humperdink Link"), "and so is the link");
  assert.ok(html.includes('value="Whitfield 4471"'), "the name is preloaded");
  assert.ok(html.includes('value="https://h.example/whitfield-4471"'), "and so is the link");
});

/* The typeahead picks an EXISTING loan to file a NEW task against. On a task
   that is already filed, typing here renames the loan it is already on, and a
   suggestion list offering to repoint it elsewhere is a different move wearing
   this one's clothes. */
test("edit mode offers a plain box, never the loan typeahead", () => {
  const html = editing();
  assert.ok(!html.includes("loan-typeahead"), "no typeahead wrapper");
  assert.ok(!html.includes('role="combobox"'), "and no combobox");
  assert.ok(!html.includes("Search or type a loan"), "and none of its placeholder");
});

test("an OOO task edits a vacation description, and has no link field", () => {
  const html = editing(oooTask());
  assert.ok(html.includes("Vacation Description"));
  assert.ok(html.includes('value="Two weeks in Lisbon"'));
  assert.ok(!html.includes("Humperdink"), "a vacation has no loan and no link");
});

/* ── No control offered to somebody the server will refuse (#266) ──
   ADR-0008 rule 5 narrows a loan edit to the task's two parties. The form is
   handed the server's own refusal sentence, and the two boxes shut. What is
   pinned here is that they shut *properly*: read-only rather than merely
   un-submittable, with the reason attached to them rather than left to a toast
   after the save. The rule that produces the sentence is exercised end to end
   over HTTP in `loan-edit-permission-sim-test.mjs`. */

const REFUSAL = "Only the person who requested this task or the person working it can change its loan's name or link";
/* React escapes the apostrophe on the way out, so the markup is searched for
   the escaped form rather than the sentence as written. */
const REFUSAL_HTML = REFUSAL.replace(/'/g, "&#x27;");
const locked = (task = loiTask()) =>
  render({ edit: { task, onSave: async () => {}, loanRefusal: REFUSAL } });

test("a non-party gets the loan's two boxes read-only, with the reason", () => {
  const html = locked();
  /* Both boxes, not one: they land on one record and the rule is about the
     record, so half a lock would be an invitation to try the other half. */
  assert.equal((html.match(/readonly=""/g) ?? []).length, 2, "both loan boxes are read-only");
  assert.ok(html.includes(REFUSAL_HTML), "and the reason is on the page");
  assert.match(html, /class="task-form-locked task-form-loan-locked"/, "in the muted register");
});

test("the boxes still show what the loan says — locked, not hidden", () => {
  const html = locked();
  assert.ok(html.includes("Whitfield 4471"), "the folder name is still readable");
  assert.ok(html.includes("https://h.example/whitfield-4471"), "so is the link");
  assert.ok(html.includes("Folder Name"), "and both keep their labels");
  assert.ok(html.includes("Humperdink Link"));
});

test("the reason is announced with the fields, not just drawn near them", () => {
  const html = locked();
  const ids = [...html.matchAll(/aria-describedby="([^"]+)"/g)].map((m) => m[1]);
  const paragraph = html.match(/<p id="([^"]+)" class="task-form-locked task-form-loan-locked"/);
  assert.ok(paragraph, "the refusal has an id to point at");
  assert.equal(
    ids.filter((id) => id === paragraph[1]).length,
    2,
    "both boxes are described by the one sentence about both of them"
  );
});

test("a locked-out viewer is not also warned about a save they cannot make", () => {
  const html = locked();
  assert.ok(!SHARED_LINE.test(html), "the shared-record line is unreachable");
  assert.ok(!html.includes("task-form-shared-loan"), "and never drawn");
});

test("a party sees no lock and no refusal at all", () => {
  const html = editing();
  assert.ok(!html.includes("readonly"), "nothing is read-only for the two people it belongs to");
  assert.ok(!html.includes(REFUSAL_HTML));
  assert.ok(!html.includes("task-form-loan-locked"));
});

/* The Save button is part of "no control is offered". The lock is recomputed
   live from the task, so it can close over a draft somebody had already typed —
   a handoff landing mid-edit takes the assignee seat away with the boxes still
   full. What must not then happen is the Save posting that draft and eating a
   refusal. Read out of the source, because reaching it needs typing into a
   rendered form and there is no DOM harness here. */
test("a locked form drops the loan pair from what a Save sends", () => {
  const source = readFileSync(join(REPO, "apps/web/src/task-form.tsx"), "utf8");
  assert.match(
    source,
    /if \(loanLocked\) \{\s*\n\s*delete changed\.folderName;\s*\n\s*delete changed\.humperdinkLink;\s*\n\s*\}/,
    "the pair never leaves a locked form"
  );
  /* It is dropped from the real diff, and before the nothing-moved check, so a
     lock-only edit closes the form instead of posting an empty save. */
  assert.ok(
    source.indexOf("if (loanLocked) {") > source.indexOf("const changed = taskEdit(edit.task, form)"),
    "dropped from the real diff, not from a second one"
  );
  assert.ok(
    source.indexOf("if (loanLocked) {") < source.indexOf("if (Object.keys(changed).length === 0)"),
    "and before the nothing-moved check"
  );
});

test("locked boxes show what the loan says, not an abandoned draft", () => {
  const source = readFileSync(join(REPO, "apps/web/src/task-form.tsx"), "utf8");
  assert.match(source, /value=\{loanLocked \? lockedFolderName : form\.folderName\}/);
  assert.match(source, /value=\{loanLocked \? lockedLink : form\.humperdinkLink\}/);
  const html = locked();
  assert.ok(html.includes("Whitfield 4471"), "the loan's current name");
  assert.ok(html.includes("https://h.example/whitfield-4471"), "and its current link");
});

/* An OOO task's "folder name" is a vacation description on the task itself,
   governed by the creator-only amend rule and not by this one. A loan refusal
   must never reach it — there is no loan behind it to protect. */
test("an out-of-office description is never locked by the loan rule", () => {
  const html = locked(oooTask());
  assert.ok(!html.includes("readonly"), "the description stays editable");
  assert.ok(!html.includes(REFUSAL_HTML), "and the loan refusal is not shown");
});

/* ── The muted shared-record line (ADR-0008 rule 7) ─────── */

const SHARED_LINE = /Saving updates them on every task for this loan/;

test("nothing warns about the shared record until a value has changed", () => {
  const html = editing();
  assert.ok(!SHARED_LINE.test(html), "an untouched form says nothing");
  assert.ok(!html.includes("task-form-shared-loan"), "and draws no line at all");
});

/* The form is rendered here without a browser, so nobody can type into it and
   the changed state can't be reached by rendering — the form seeds itself from
   the task, so its first paint is always the unchanged one. WHEN the line
   appears is therefore the pure predicate above, exercised exhaustively; what
   the form does with that answer is read out of the source. Between them:
   one line for the pair, drawn from `touchesSharedLoan` and from nothing else,
   with no focus handler anywhere near it. */
const formSource = readFileSync(join(REPO, "apps/web/src/task-form.tsx"), "utf8");

test("the line is drawn from the changed-value predicate, never from focus", () => {
  assert.match(
    formSource,
    /const sharedLoanWarning = editing && edit && !loanLocked \? touchesSharedLoan\(edit\.task, form\) : false;/,
    "the only thing that reveals it is a value having moved — and #266's lock takes it away"
  );
  assert.equal(
    (formSource.match(/sharedLoanWarning &&/g) ?? []).length,
    1,
    "and it is drawn once — one line for the pair, not one per field"
  );
  assert.ok(
    !/onFocus[\s\S]{0,400}sharedLoan/.test(formSource),
    "no focus handler goes anywhere near it"
  );
});

/* Prose under the fields, not a dialog, a banner or a toast — the person is
   fixing a typo, not opening a negotiation. */
test("the line is a paragraph inside the form, in its own muted style", () => {
  assert.match(formSource, /<p className="task-form-shared-loan" aria-hidden="true">\{sharedLoanCopy\}<\/p>/);
  assert.ok(!/showToast\([^)]*sharedLoanCopy/.test(formSource), "it is never toasted");
  // Two nodes for one sentence: the visible copy is hidden from a screen
  // reader, and an always-mounted live region carries it instead.
  assert.match(formSource, /<p className="sr-only" role="status">\{sharedLoanWarning \? sharedLoanCopy : ""\}<\/p>/);
  const css = readFileSync(join(REPO, "apps/web/src/styles.css"), "utf8");
  assert.match(css, /\.task-form-shared-loan \{[^}]*color: var\(--muted\)/, "muted, through the theme token");
});

test("the copy says what saving does, in plain words", () => {
  assert.match(formSource, SHARED_LINE);
  assert.ok(/every task for this loan, including finished ones/.test(formSource));
});

/* An OOO task has no shared record, so the whole block — both fields and the
   line — is absent, and the bare description field is drawn instead. */
test("an OOO task is never told about a shared record", () => {
  const html = editing(oooTask());
  assert.ok(!SHARED_LINE.test(html));
  assert.ok(!html.includes("task-form-shared-loan"));
  assert.ok(!html.includes("task-form-loan"), "and gets no paired block at all");
});

/* #264, ADR-0008 rule 8. The one type that does have dates gets them back, on
   the same form and preloaded — a correction surface that opened blank would
   ask the creator to retype what they are correcting. */
test("an OOO task's edit form carries both dates, preloaded", () => {
  const html = editing(oooTask());
  assert.ok(html.includes("Start Date"), "the start date is on the form");
  assert.ok(html.includes("Return Date"), "and so is the return date");
  assert.match(html, /type="date"[^>]*value="2026-03-02"/, "start preloaded from the task");
  assert.match(html, /type="date"[^>]*value="2026-03-09"/, "return preloaded from the task");
});

/* Nothing refuses a past date, at any layer. A `min` of today on either input
   is exactly the guard ADR-0008 rule 8 rules out: somebody back early
   correcting the record is the case this exists for. The only `min` on the form
   is the return date's, which is the start date — the range rule, not a
   calendar floor. */
test("neither date input floors itself at today", () => {
  const html = editing(oooTask());
  const mins = [...html.matchAll(/type="date"[^>]*?\bmin="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(mins, ["2026-03-02"], "the only min is the return date's start-date floor");
});

/* ── The redesigned layout ──────────────────────────────
   One form, so the two modes have to be the same shape: the same four controls
   across the top, the same request field under them, the same footer strip. The
   things that differ are the things the mode differs about. */

test("both modes open on the same four-across top row", () => {
  for (const html of [render({}), editing()]) {
    const row = html.match(/<div class="task-form-quad">([\s\S]*?)<\/div><p|<div class="task-form-quad">([\s\S]*?)<\/div><label class="span-full"/);
    assert.ok(row, "the top row is drawn");
    const inner = row[1] ?? row[2];
    for (const label of ["Folder Name", "Type", "Urgency", "How Bad?"]) {
      assert.ok(inner.includes(label), `${label} is in the top row`);
    }
  }
});

/* The request field is the only thing on the form that wants vertical room, and
   in edit mode reading what is already there is the whole job. The mono face is
   LOI's alone: that box holds a pasted term sheet whose columns only line up in
   a fixed-width font. Every other type's field is prose. */
test("the terms box goes tall on edit, and mono only on an LOI", () => {
  assert.match(editing(), /class="task-form-terms task-form-terms-mono"/, "an LOI's term sheet keeps its columns");
  const chat = editing(loiTask({ taskType: "BUDDY_CHAT", notes: "n" }));
  assert.match(chat, /class="task-form-terms"/, "still the tall box");
  assert.ok(!chat.includes("task-form-terms-mono"), "but prose stays in the body face");
  assert.ok(!render({}).includes("task-form-terms"), "and filing keeps its short box");
});

/* The footer strip carries the two exits plus the one thing each mode has to
   say beside them. Filing: the Humperdink import, which is a shortcut past the
   form rather than a field in it. Editing: the shared-record line, which is the
   only place that is genuinely under BOTH loan fields now that they no longer
   sit side by side. */
test("the footer holds the exits, and the import belongs to filing alone", () => {
  const create = render({});
  const foot = create.slice(create.indexOf('class="task-form-foot"'));
  assert.ok(foot.includes("Paste what Send to Hot Task copied"), "the paste box is in the footer");
  assert.ok(foot.includes("Import from Humperdink"), "and so is its button");
  assert.ok(foot.includes(">Cancel<") && foot.includes(">Create Task<"), "beside the two exits");
  assert.ok(!editing().includes("Import from Humperdink"), "editing offers no import");
});

/* `Send to Hot Task` in Humperdink copies a term sheet, and an LOI Check is the
   only task type whose request field is one. On the other five the control took
   a paste nobody has, so it is not drawn — not disabled, not left to fail on the
   parse. The create form opens on LOI, which is why the test above sees it. */
test("the import is offered on an LOI Check and on nothing else", () => {
  assert.ok(render({}).includes("Import from Humperdink"), "an LOI Check gets it");
  for (const taskType of ["BUDDY_CHAT", "VALUE", "FRAUD", "LOAN_DOCS", "OOO"]) {
    const html = render({ initialValues: { taskType } });
    assert.ok(!html.includes("Import from Humperdink"), `${taskType} does not`);
    assert.ok(!html.includes("Paste what Send to Hot Task copied"), `${taskType} has no paste box either`);
  }
});

test("the loan fields are no longer paired, and the sentence is in the footer", () => {
  const html = locked();
  assert.ok(!html.includes('class="task-form-loan"'), "no paired block");
  const foot = html.slice(html.indexOf('class="task-form-foot"'));
  assert.ok(foot.includes(REFUSAL_HTML), "the one sentence about both boxes sits in the footer");
});

test("the field keeps the label its task type gives it", () => {
  assert.ok(editing().includes("Loan Terms and Contacts"));
  assert.ok(editing(loiTask({ taskType: "BUDDY_CHAT", notes: "n" })).includes("Concerns"));
});

/* ── Filing a new task is unaffected ────────────────────── */

test("without an edit, the form is the create form it has always been", () => {
  const html = render({});
  assert.ok(html.includes("Create Task"));
  assert.ok(html.includes("Folder Name"));
  assert.ok(html.includes("Paste from Humperdink"));
  assert.ok(html.includes("How Bad?"));
  assert.ok(html.includes("Share Directly"));
  assert.ok(!html.includes("task-form-locked"), "and the type select is live");
  assert.ok(!/<select[^>]*disabled/.test(html));
});

/* ── One door, and the old one is gone ──────────────────── */

const app = readFileSync(join(REPO, "apps/web/src/App.tsx"), "utf8");
const thread = readFileSync(join(REPO, "apps/web/src/thread.tsx"), "utf8");

test("the hamburger carries Edit Task, gated on the shared predicate", () => {
  assert.match(app, /const editMenuItemBlock = canAmendTask\(task, user\)/);
  assert.match(app, />\s*Edit Task\s*</);
});

test("the Edit request button is gone from the terms head and the thread head", () => {
  assert.ok(!/>\s*Edit request\s*</.test(app), "App.tsx no longer draws it");
  assert.ok(!/action\?:/.test(thread), "and the terms section has no action slot left");
});

/* The refusal is only worth anything if the save path asks for it, and asks
   before it can mistake a wiped box for an untouched one and close. */
test("the save path asks for the refusal before deciding nothing moved", () => {
  const save = formSource.slice(formSource.indexOf("const handleSave"));
  const refusalAt = save.indexOf("editRefusal(");
  const changedAt = save.indexOf("taskEdit(");
  assert.ok(refusalAt >= 0, "handleSave consults editRefusal");
  assert.ok(refusalAt < changedAt, "and does so before working out what moved");
});

const routes = readFileSync(join(REPO, "apps/server/src/routes.ts"), "utf8");

test("no catch-all update route was introduced", () => {
  assert.ok(!/router\.(patch|put)\("\/tasks/.test(routes), "no PATCH or PUT on a task");
  assert.ok(routes.includes('router.post("/tasks/:taskId/notes"'), "the focused notes route is still the way in");
  assert.ok(routes.includes('router.post("/tasks/:taskId/folder-name"'), "and the OOO description has its own");
  assert.ok(routes.includes('router.post("/tasks/:taskId/urgency"'), "and urgency has its own");
  assert.ok(routes.includes('router.post("/tasks/:taskId/points"'), "and so do the poops");
  assert.ok(routes.includes('router.post("/tasks/:taskId/dates"'), "and the OOO dates got their own rather than a patch");
});

/* Where each field lands (#262, ADR-0008 rule 7). The loan fields go to the
   LOAN, in one call, so the correction reaches every task on that loan; only an
   OOO task's description is written on the task itself. */
test("the loan fields save to the loan record, and OOO's to the task", () => {
  /* The dispatch itself moved out of App into `save-task-edit.ts` with #281, so
     it can be run rather than read — see `edit-save-order-sim-test.mjs`. Where
     each field lands is still the same answer, asserted where it now lives. */
  const save = readFileSync(join(REPO, "apps/web/src/save-task-edit.ts"), "utf8");
  assert.match(save, /if \(task\.taskType === "OOO" && edit\.folderName !== undefined\) \{\s*\n\s*await write\.setFolderName/);
  /* The task id travels with it since #266: the server checks that the caller
     is a party to that task and that the task is on that loan, so the id is
     part of the request rather than context for the log. */
  assert.match(save, /await write\.saveLoanFields\(task\.loanId, task\.id, \{/, "everything else goes to the loan, from a named task");
  /* Since #265 the request itself is made one level down, in `patchLoan`, which
     is the shared step that asks before a merge — but it is still the same
     existing loan route, and still one call carrying both fields. */
  assert.match(app, /await patchLoan\(loanId, \{/, "through the shared loan save");
  assert.match(app, /`\/loans\/\$\{loanId\}`,\s*\n\s*\{ method: "PATCH"/, "which is the existing loan route");
});

/* A link edit that would fold two loans together is refused rather than done,
   and the refusal names the other loan (#262). #265 turned that refusal into a
   question the person can answer — see `loan-merge-confirm-sim-test.mjs`. What
   stays true here is that no save merges without one. */
test("a colliding link is refused by the server, not silently merged", () => {
  const loanService = readFileSync(join(REPO, "apps/server/src/loan-service.ts"), "utf8");
  assert.match(loanService, /export class LoanLinkCollisionError extends Error/);
  assert.match(loanService, /if \(collision && !options\.confirmMerge\) \{[\s\S]{0,600}?throw new LoanLinkCollisionError/);
  assert.match(routes, /error instanceof LoanLinkCollisionError[\s\S]{0,120}status\(409\)/, "answered as a 409");
});

/* ── Every loan-editing surface is accounted for (#266) ───
   The ticket's fourth criterion is an inventory, not a behaviour, so this is
   the inventory. There were two surfaces that could change a loan's name or
   link. One kept the ability under the new rule; the other lost it. */

test("the edit form is the one surface that still edits a loan, and it names its task", () => {
  /* `patchLoan` is the only place the app issues a loan PATCH, and every body
     through it carries a `taskId` — there is no path to the route without
     one. */
  assert.equal(
    (app.match(/method: "PATCH", body: JSON\.stringify\(\{ \.\.\.body/g) ?? []).length,
    1,
    "one loan-save step, not one per surface"
  );
  assert.match(app, /const saveLoanFields = useCallback\(async \(loanId: string, taskId: string,/);
  assert.match(app, /await patchLoan\(loanId, \{\s*\n\s*taskId,/, "and the task rides on the body");
  /* Which means the confirmed re-send carries it too: `patchLoan` re-sends the
     same `body` with only `confirmMerge` added, so the second request is judged
     by the same rule as the first. A refusal reachable only after answering a
     merge dialog is a refusal that arrives too late. */
  assert.match(app, /const result = await send\(\{ confirmMerge: true \}\);/);
});

test("the loan-filter header no longer edits anything", () => {
  const from = app.indexOf("const LoanFilterHeader = (");
  assert.ok(from > 0, "the header is still there — it says which loan the list is filtered to");
  const header = app.slice(from, app.indexOf("\nconst ", from + 1));
  /* It sits outside any task, so under ADR-0008 rule 5 there is nobody to
     check. The answer this surface got is that the ability goes, rather than
     the rule being softened for it: no inputs, no save, no edit toggle. */
  assert.ok(!/<input/.test(header), "no boxes to type in");
  assert.ok(!/onSave/.test(header), "and nothing to save with");
  assert.ok(!/setEditing/.test(header), "and no way into an editing state");
  assert.match(header, /<h2 className="loan-header-name">\{loan\.name\}<\/h2>/, "still a heading");
  assert.match(header, /href=\{loan\.humperdinkLink\}/, "still linking out to Humperdink");
  /* And App no longer carries the save that served it. */
  assert.ok(!/const onSaveLoan = /.test(app), "the header's save is gone from App too");
});

/* The due date is derived from the urgency band at the moment of the edit, the
   same computation filing uses. Nothing on the edit path may carry one — not
   the payload type, not the form. (`toCreateInput` still passes a `dueAt`
   through on *creation*; that is a separate, older surface and not this
   ticket's.) */
test("nothing on the edit path can express a due date", () => {
  const state = readFileSync(join(REPO, "apps/web/src/create-form-state.ts"), "utf8");
  const form = readFileSync(join(REPO, "apps/web/src/task-form.tsx"), "utf8");
  /* A member or an assignment, not the word — both files talk about `dueAt` in
     their comments precisely to say they don't carry one. */
  const carriesADueDate = /dueAt\s*[?:=]/;
  assert.ok(!carriesADueDate.test(state), "the edit payload has no due date");
  assert.ok(!carriesADueDate.test(form), "and neither does the form");
});

/* A save is a dispatch across the focused routes, one line per field — the
   thing that must never appear is one request carrying a task-shaped body. */
test("the save dispatches each field to its own route", () => {
  /* The dispatch is `saveTaskEdit` since #281 — it moved out of App so that
     what it does NOT write on a declined merge could be run rather than
     regex'd. What it dispatches is unchanged, and the order it dispatches in is
     asserted by running it, in `edit-save-order-sim-test.mjs`. */
  const save = readFileSync(join(REPO, "apps/web/src/save-task-edit.ts"), "utf8");
  const dispatch = /export const saveTaskEdit = async \([\s\S]*?\n\};/.exec(save);
  assert.ok(dispatch, "saveTaskEdit is still a dispatch over the edit");
  assert.match(dispatch[0], /edit\.notes !== undefined.*setNotes/);
  assert.match(dispatch[0], /edit\.urgency !== undefined.*setUrgency/);
  assert.match(dispatch[0], /edit\.points !== undefined.*setPoints/);
  assert.match(dispatch[0], /edit\.dates !== undefined.*setDates/);
  assert.ok(!/apiRequest|fetch\(/.test(save), "and it dispatches over an injected writer rather than making the calls");
  /* And the list is refetched once for the whole save, not once per field —
     which stayed in App, because the refetch is the shell's. */
  const shell = /const onSaveEdit = useCallback\([\s\S]*?\n  \}, \[amendApi[^\]]*\]\);/.exec(app);
  assert.ok(shell, "onSaveEdit is still where a save starts");
  assert.equal((shell[0].match(/refresh\(\)/g) ?? []).length, 1);
});

/* ADR-0008 rule 4: two paths to one number is worth more than the tidiness of
   removing the fast one. The collapsed row keeps its click-to-rate track. */
test("the poop track on the row still works", () => {
  assert.match(app, /onChange=\{\(n\) => \{ void onUpdatePoints\(task\.id, n\); \}\}/);
});
