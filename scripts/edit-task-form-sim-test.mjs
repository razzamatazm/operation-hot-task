#!/usr/bin/env node
/* Issue #260 / ADR-0008 rule 4 — `Edit Task` opens the create form in edit
 * mode, and saves one field.
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
 * tested in `loi-terms-section-sim-test.mjs`.
 *
 * Two source checks at the end cover what neither half can: the hamburger is
 * the only door (`Edit Task` in the menu), and the old `Edit request` button is
 * gone from the terms head and the conversation head alike.
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

import { canAmendTask } from "../packages/shared/dist/workflow.js";
import {
  BLANK_CREATE_FORM,
  editFormValues,
  initialCreateForm,
  taskEdit
} from "../apps/web/src/create-form-state.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));

const TERMS = "Loan Amount: $2,340,000\nRate: 9.75%\nBroker: Dana Whitfield";

const loiTask = (over = {}) => ({
  id: "task-1",
  taskType: "LOI",
  notes: TERMS,
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

/* This ticket deliberately carries one editable field. Urgency, points and the
   loan fields are later tickets, so edit mode opens with the blank form's
   values for them and never renders them — nothing in the form can move them,
   and `taskEdit` below refuses to send them even if something did. */
test("edit mode carries no other field into the form", () => {
  const values = editFormValues(loiTask());
  assert.equal(values.folderName, BLANK_CREATE_FORM.folderName);
  assert.equal(values.humperdinkLink, BLANK_CREATE_FORM.humperdinkLink);
  assert.equal(values.points, BLANK_CREATE_FORM.points);
  assert.equal(values.urgency, BLANK_CREATE_FORM.urgency);
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

/* The guard against a catch-all update creeping in: even a form whose every
   other value has moved sends the request field alone. */
test("only the request field is ever sent, whatever else moved", () => {
  const task = loiTask();
  const values = {
    ...editFormValues(task),
    notes: "Rate: 9.25%",
    folderName: "Some Other Loan",
    humperdinkLink: "https://example.test/other",
    points: 5,
    urgency: "RED",
    startDate: "2026-01-01",
    returnDate: "2026-01-08",
    initialItems: ["appraisal"],
    recipientUserId: "someone",
    taskType: "FRAUD"
  };
  assert.deepEqual(taskEdit(task, values), { notes: "Rate: 9.25%" });
});

/* ── Who is offered the door ────────────────────────────── */

/* The menu item asks the shared predicate the server's own refusal is written
   from, so an `Edit Task` the server would turn away cannot be drawn. This
   ticket changes nothing about who that is: the creator, on a task that isn't
   closed. Widening it to both parties is #263. */
const CREATOR = { id: "creator-1", displayName: "Dana Requester" };
const ASSIGNEE = { id: "assignee-1", displayName: "Casey Checker" };
const OBSERVER = { id: "observer-1", displayName: "Sam Bystander" };
const owned = (status) => ({ createdBy: CREATOR, status });

test("the creator of an open task is offered Edit Task", () => {
  for (const status of ["OPEN", "CLAIMED", "NEEDS_REVIEW", "AWAITING_ITEMS", "PENDING_APPROVAL"]) {
    assert.equal(canAmendTask(owned(status), CREATOR), true, status);
  }
});

test("nobody else is offered it", () => {
  assert.equal(canAmendTask(owned("CLAIMED"), ASSIGNEE), false);
  assert.equal(canAmendTask(owned("CLAIMED"), OBSERVER), false);
});

test("a closed task offers no Edit Task", () => {
  for (const status of ["COMPLETED", "CANCELLED", "ARCHIVED"]) {
    assert.equal(canAmendTask(owned(status), CREATOR), false, status);
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

test("the task type is shown, disabled, with a reason", () => {
  const html = editing();
  assert.match(html, /<select[^>]*disabled[^>]*>[\s\S]*?LOI Check/);
  assert.match(html, /class="[^"]*task-form-locked"/);
  assert.ok(/can(’|')t be changed/.test(html), "the reason says the type can't change");
  assert.ok(/cancel/i.test(html) && /refile/i.test(html), "and says to cancel and refile");
});

/* The later tickets' fields (#261–#264). Kept out rather than shown disabled:
   a control nobody can move is noise, and the type is disabled only because a
   form that hid it would read as having lost the task's type. */
test("edit mode carries the request field and nothing else", () => {
  const html = editing();
  assert.ok(!html.includes("Folder Name"));
  assert.ok(!html.includes("Humperdink"));
  assert.ok(!html.includes("How Bad?"));
  assert.ok(!html.includes("Urgency"));
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

test("no catch-all update route was introduced", () => {
  const routes = readFileSync(join(REPO, "apps/server/src/routes.ts"), "utf8");
  assert.ok(!/router\.(patch|put)\("\/tasks/.test(routes), "no PATCH or PUT on a task");
  assert.ok(routes.includes('router.post("/tasks/:taskId/notes"'), "the focused notes route is still the way in");
});
