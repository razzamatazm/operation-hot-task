#!/usr/bin/env node
/* Issue #343 — Save for later on the new task form, and the Saved for Later
 * section on the board (ADR-0011).
 *
 * The server half (who can see one, where it is stored) is
 * `saved-for-later-sim-test.mjs` and the smoke test. This file is the screen.
 *
 * Two techniques, the arrangement `task-draft-form-sim-test.mjs` uses:
 *
 * 1. RENDERED. The form and the section are bundled and rendered through
 *    `react-dom/server`. A first paint proves where the button is, whether it is
 *    pressable, that edit mode has none, and exactly what a row carries.
 * 2. READ OUT OF THE SOURCE. A static render fires no clicks, so what pressing
 *    the button does (save, clear the autosave, close) and where App mounts the
 *    section are asserted against the source itself.
 *
 * What is left for a person: pressing it in a real browser and watching the
 * row appear. Named in the PR report.
 *
 * Run: `node --test scripts/saved-for-later-board-sim-test.mjs`. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { TASK_TYPE_LABELS } from "@loan-tasks/shared";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const FORM_SOURCE = readFileSync(join(REPO, "apps/web/src/task-form.tsx"), "utf8");
const APP_SOURCE = readFileSync(join(REPO, "apps/web/src/App.tsx"), "utf8");

const scratch = mkdtempSync(join(REPO, "node_modules", ".saved-for-later-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const entry = join(scratch, "entry.tsx");
writeFileSync(
  entry,
  `export { TaskForm } from ${JSON.stringify(join(REPO, "apps/web/src/task-form.tsx"))};\n` +
    `export { ToastProvider } from ${JSON.stringify(join(REPO, "apps/web/src/toast.tsx"))};\n` +
    `export { SavedForLaterSection } from ${JSON.stringify(join(REPO, "apps/web/src/saved-for-later.tsx"))};\n` +
    `export { draftKey, serializeDraft } from ${JSON.stringify(join(REPO, "apps/web/src/create-form-draft.ts"))};\n`
);
const bundle = join(scratch, "saved-for-later.mjs");
await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  external: ["react", "react/jsx-runtime", "@loan-tasks/shared"],
  logLevel: "silent"
});
const { TaskForm, ToastProvider, SavedForLaterSection, draftKey, serializeDraft } = await import(pathToFileURL(bundle).href);

const storage = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key)
  }
};
test.beforeEach(() => storage.clear());

const USER = { id: "user-1", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] };

const renderForm = (props) =>
  renderToStaticMarkup(
    createElement(ToastProvider, null, createElement(TaskForm, {
      loans: [],
      directory: [],
      user: USER,
      tasks: [],
      onClose: () => {},
      onCreate: async () => {},
      onSaveForLater: async () => {},
      ...props
    }))
  );

const FORM = {
  folderName: "Adams - Harbor",
  loanId: "",
  taskType: "VALUE",
  urgency: "RED",
  startDate: "",
  returnDate: "",
  notes: "Needs a value by Friday",
  humperdinkLink: "",
  points: 3,
  initialItems: [],
  pickerMode: "share",
  recipientUserId: "",
  recipientNote: ""
};

/* ── The button ──────────────────────────────────────────── */

const FOOT_ORDER = /Cancel<\/button><button type="button" class="btn-ghost"( disabled="")?>Save for later<\/button><button type="submit"[^>]*>Create Task<\/button>/;

test("Save for later sits between Cancel and Create Task, in the secondary style", () => {
  const html = renderForm();
  assert.match(html, FOOT_ORDER, "Cancel, then Save for later as a ghost button, then the filled Create Task");
});

test("an untouched form cannot be saved for later", () => {
  const [, disabled] = renderForm().match(FOOT_ORDER);
  assert.equal(disabled, ' disabled=""');
});

test("a form holding typing can be saved for later, with nothing else required", () => {
  // A restored autosave is typing somebody did, and the one first paint a static
  // render can show with something in the form.
  storage.set(draftKey(USER.id), serializeDraft({ ...FORM, folderName: "", notes: "half a thought" }, Date.now()));
  const [, disabled] = renderForm().match(FOOT_ORDER);
  assert.equal(disabled, undefined, "no loan and no urgency picked, and it is still pressable");
});

test("edit mode has no Save for later", () => {
  const html = renderForm({
    edit: {
      task: {
        taskType: "VALUE",
        notes: "Needs a value",
        folderName: "Adams - Harbor",
        humperdinkLink: "",
        urgency: "GREEN",
        points: 2,
        createdBy: { id: USER.id, displayName: USER.displayName }
      },
      onSave: async () => {}
    }
  });
  assert.doesNotMatch(html, /Save for later/);
  assert.match(html, />Save<\/button>/, "the edit form's own Save is still there");
});

test("pressing it saves the form, then clears the autosave, then closes — and only once the save landed", () => {
  const body = FORM_SOURCE.match(/const saveForLater = async \(\): Promise<void> => \{([\s\S]*?)\n  \};/)?.[1];
  assert.ok(body, "the form has a saveForLater handler");
  const saving = body.indexOf("await onSaveForLater(");
  const forgetting = body.indexOf("forgetDraft();");
  const closing = body.indexOf("onClose();");
  assert.ok(saving >= 0 && forgetting > saving && closing > forgetting, "save, then forget the autosave, then close");
  assert.ok(body.indexOf("catch") > closing, "a failed save skips both and leaves the form open");
  assert.match(FORM_SOURCE, /onClick=\{saveForLater\}/, "the button is what calls it");
});

test("the form opened from Humperdink is the same create form, so it has the button", () => {
  // Humperdink's deep link carries the create-form intent, which opens App's one
  // create-mode form: the mount that also closes on setFormOpen(false).
  assert.match(APP_SOURCE, /readCreateFormIntent\([^)]*\)\)\s*\{\s*setFormOpen\(true\)/, "the intent opens formOpen");
  const createMount = APP_SOURCE.match(/\{formOpen && \(\s*<TaskForm([\s\S]*?)\/>/)?.[1];
  assert.ok(createMount, "App mounts the create form while formOpen");
  assert.match(createMount, /onSaveForLater=\{onSaveForLater\}/, "and hands it Save for later");
  const editMount = APP_SOURCE.match(/\{editingTask && \(\s*<TaskForm([\s\S]*?)\/>\s*\)\}/)?.[1];
  assert.ok(editMount, "App mounts the edit form");
  assert.doesNotMatch(editMount, /onSaveForLater/, "the edit form never gets it");
});

test("a save lands in the board's list straight away, without a reload", () => {
  const handler = APP_SOURCE.match(/const onSaveForLater = async \([\s\S]*?\n  \};/)?.[0];
  assert.ok(handler, "App has an onSaveForLater handler");
  assert.match(handler, /"\/saved-for-later", \{ method: "POST"/);
  assert.match(handler, /setSavedForLater\(/, "the saved item goes into the list the section renders");
});

/* ── The section ─────────────────────────────────────────── */

const NOW = Date.parse("2026-09-11T12:00:00.000Z");
const item = (id, minutesAgo, overrides = {}) => ({
  id,
  ownerId: USER.id,
  savedAt: new Date(NOW - minutesAgo * 60000).toISOString(),
  form: { ...FORM, ...overrides }
});

const renderSection = (items) => renderToStaticMarkup(createElement(SavedForLaterSection, { items, now: NOW }));

test("the section is not there at all when the viewer has none", () => {
  assert.equal(renderSection([]), "");
});

test("the section is headed Saved for Later with a count, and lists newest saved first", () => {
  const html = renderSection([
    item("a", 180, { folderName: "Three hours" }),
    item("b", 5, { folderName: "Five minutes" }),
    item("c", 60 * 24 * 2, { folderName: "Two days" })
  ]);
  assert.match(html, /<h2>Saved for Later<span class="section-count">3<\/span><\/h2>/);
  const names = [...html.matchAll(/<span class="saved-row-name">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(names, ["Five minutes", "Three hours", "Two days"]);
});

test("the section is not collapsible", () => {
  const html = renderSection([item("a", 5)]);
  assert.doesNotMatch(html, /<button|<details|aria-expanded/);
});

test("a row is the loan name, the task type and when it was saved, and nothing else", () => {
  const html = renderSection([item("a", 5, { folderName: "Adams - Harbor", taskType: "VALUE" })]);
  const rows = [...html.matchAll(/<li[\s\S]*?<\/li>/g)].map((m) => m[0]);
  assert.equal(rows.length, 1);
  assert.equal(
    rows[0],
    `<li class="saved-row"><span class="saved-row-name">Adams - Harbor</span>` +
      `<span class="saved-row-type">${TASK_TYPE_LABELS.VALUE}</span>` +
      `<time class="saved-row-when" dateTime="${new Date(NOW - 5 * 60000).toISOString()}">saved 5m ago</time></li>`
  );
});

test("a row with no loan typed says No loan yet", () => {
  const html = renderSection([item("a", 5, { folderName: "   " })]);
  assert.match(html, /<span class="saved-row-name">No loan yet<\/span>/);
});

test("a row does nothing when tapped, yet", () => {
  const html = renderSection([item("a", 5)]);
  assert.doesNotMatch(html, /role="button"|tabindex|<a /i);
});

test("in Grouped view the section sits right after Needs you, on the Tasks board only", () => {
  const grouped = APP_SOURCE.match(/const renderTaskList = \([\s\S]*?\n  \};/)?.[0];
  assert.ok(grouped, "renderTaskList exists");
  assert.match(
    grouped,
    /s\.key === "you" && <SavedForLaterSection items=\{savedItems\} now=\{now\} \/>/,
    "rendered directly after the Needs you court, whether or not Needs you has any tasks"
  );
  assert.match(APP_SOURCE, /renderTaskList\(unifiedTasks, "No tasks yet\.", savedForLater\)/, "the Tasks board passes them");
  assert.match(APP_SOURCE, /renderTaskList\(allTasksAdmin, "No tasks yet\."\)/, "admin All Tasks does not");
});
