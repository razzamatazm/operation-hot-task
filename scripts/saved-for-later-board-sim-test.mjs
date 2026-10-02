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

import { AUTOSAVE_MAX_AGE_MS, TASK_TYPES, TASK_TYPE_LABELS } from "@loan-tasks/shared";
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
    `export { TaskDraftsPage, SavedForLaterDeleteConfirm, taskDraftsCount, withUnsaved } from ${JSON.stringify(join(REPO, "apps/web/src/saved-for-later.tsx"))};\n` +
    `export { BoardTabs } from ${JSON.stringify(join(REPO, "apps/web/src/board-tabs.tsx"))};\n` +
    `export { draftKey, serializeDraft } from ${JSON.stringify(join(REPO, "apps/web/src/create-form-draft.ts"))};\n` +
    `export { initialCreateForm } from ${JSON.stringify(join(REPO, "apps/web/src/create-form-state.ts"))};\n` +
    `export { saveForLaterRequest, reopenSavedForLaterRequest, removeSavedForLaterRequest, keepUnsavedRequest, discardUnsavedRequest, loadAutosaveRequest, stampedKeepAutosaveRequest, forgetAutosaveRequest } from ${JSON.stringify(join(REPO, "apps/web/src/saved-for-later-requests.ts"))};\n` +
    `export { createNewTaskSession } from ${JSON.stringify(join(REPO, "apps/web/src/new-task-session.ts"))};\n`
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
const {
  TaskForm,
  ToastProvider,
  TaskDraftsPage,
  BoardTabs,
  SavedForLaterDeleteConfirm,
  taskDraftsCount,
  withUnsaved,
  draftKey,
  serializeDraft,
  initialCreateForm,
  saveForLaterRequest,
  reopenSavedForLaterRequest,
  removeSavedForLaterRequest,
  keepUnsavedRequest,
  discardUnsavedRequest,
  loadAutosaveRequest,
  stampedKeepAutosaveRequest,
  forgetAutosaveRequest,
  createNewTaskSession
} = await import(pathToFileURL(bundle).href);
const SESSION_SOURCE = readFileSync(join(REPO, "apps/web/src/new-task-session.ts"), "utf8");
const SECTION_SOURCE = readFileSync(join(REPO, "apps/web/src/saved-for-later.tsx"), "utf8");

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

/* A blank New Task form, as its session holds it. */
const blankSession = () => {
  const session = createNewTaskSession({ owner: "", request: async () => ({}), storage: null });
  session.adopt(initialCreateForm());
  return session;
};

const renderForm = (props = {}) =>
  renderToStaticMarkup(
    createElement(ToastProvider, null, createElement(TaskForm, {
      loans: [],
      directory: [],
      user: USER,
      tasks: [],
      onClose: () => {},
      onCreate: async () => {},
      ...(props.edit || props.session ? {} : { session: blankSession() }),
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

test("a form holding typing can be saved for later, with nothing else required", async () => {
  // A restored autosave is typing somebody did, and the one first paint a static
  // render can show with something in the form.
  storage.set(draftKey(USER.id), serializeDraft({ ...FORM, folderName: "", notes: "half a thought" }, Date.now()));
  const session = createNewTaskSession({ owner: USER.id, storage: window.localStorage, request: async () => ({ item: null }) });
  await session.open();
  const [, disabled] = renderForm({ session }).match(FOOT_ORDER);
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

/* Save, then clear the Autosave, then close, and only once the save landed, is
   the session's Save for later, driven in new-task-session-sim-test. */
test("pressing it ends the form through its session's Save for later, and a failure is said", () => {
  const body = FORM_SOURCE.match(/const saveForLater = async \(\): Promise<void> => \{([\s\S]*?)\n  \};/)?.[1];
  assert.ok(body, "the form has a saveForLater handler");
  assert.match(body, /await session\.end\(\{ kind: "saveForLater" \}\);/);
  assert.match(body, /catch \(err\) \{\s*showToast\(/, "a failed save is said, and the form stays open");
  assert.match(FORM_SOURCE, /onClick=\{saveForLater\}/, "the button is what calls it");
});

test("the form opened from Humperdink is the same create form, so it has the button", async () => {
  // A Humperdink arrival link (#412) opens App's one create-mode form, the New
  // Task session's (#473), once any autosave has been moved aside (#413).
  assert.match(APP_SOURCE, /if \(!arrivalPending \|\| !user\.id\) return;[\s\S]*?newTask\.arrive\(/, "the arrival opens the session's form");
  const createMount = APP_SOURCE.match(/\{newTaskOpen && \(\s*<TaskForm([\s\S]*?)\/>/)?.[1];
  assert.ok(createMount, "App mounts the create form while the session is open");
  assert.match(createMount, /session=\{newTask\}/, "and hands it the session, whose Save for later it offers");
  const editMount = APP_SOURCE.match(/\{editingTask && \(\s*<TaskForm([\s\S]*?)\/>\s*\)\}/)?.[1];
  assert.ok(editMount, "App mounts the edit form");
  assert.doesNotMatch(editMount, /onSaveForLater|session=/, "the edit form never gets it");

  const session = createNewTaskSession({ owner: USER.id, storage: null, request: async () => ({ item: null }) });
  assert.equal(await session.arrive({ load: () => {} }), "opened");
  const html = renderForm({ session });
  assert.match(html, />Save for later<\/button>/, "the arrival's form has the button");
});

test("a save lands in the board's list straight away, without a reload", () => {
  const handler = APP_SOURCE.match(/onSavedForLater: \(saved, replaced\) =>[\s\S]*?\n    onSavedForLaterLatest/)?.[0];
  assert.ok(handler, "App hears of every Save for later from the session");
  assert.match(SESSION_SOURCE, /saveForLaterRequest\(/, "the save itself is the request helper's, driven below against a fake server");
  assert.match(handler, /setSavedForLater\(/, "the saved item goes into the list the section renders");
});

/* ── The Task Drafts page (#343, moved to its own tab by #363) ── */

const NOW = Date.parse("2026-09-11T12:00:00.000Z");
const item = (id, minutesAgo, overrides = {}) => ({
  id,
  ownerId: USER.id,
  savedAt: new Date(NOW - minutesAgo * 60000).toISOString(),
  form: { ...FORM, ...overrides }
});

const renderSection = (items, extra = {}) =>
  renderToStaticMarkup(createElement(TaskDraftsPage, { items, now: NOW, onOpen: () => {}, onDelete: async () => true, ...extra }));

test("with no drafts the page says there are none", () => {
  assert.equal(
    renderSection([]),
    `<div class="empty-card">No task drafts. Use Save for later on a new task to keep one here.</div>`
  );
});

test("the page lists newest saved first, under no heading of its own, since the tab above it is the heading", () => {
  const html = renderSection([
    item("a", 180, { folderName: "Three hours" }),
    item("b", 5, { folderName: "Five minutes" }),
    item("c", 60 * 24 * 2, { folderName: "Two days" })
  ]);
  assert.match(html, /^<ul class="saved-list">/, "the list is the whole page");
  assert.doesNotMatch(html, /<h2|section-head|Saved for Later/);
  const names = [...html.matchAll(/<span class="saved-row-name">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(names, ["Five minutes", "Three hours", "Two days"]);
});

test("the page is not collapsible", () => {
  const html = renderSection([item("a", 5)]);
  assert.doesNotMatch(html, /<details|aria-expanded/);
});

test("a row is the loan name, the task type and when it was saved, and nothing else", () => {
  const html = renderSection([item("a", 5, { folderName: "Adams - Harbor", taskType: "VALUE" })]);
  const rows = [...html.matchAll(/<li[\s\S]*?<\/li>/g)].map((m) => m[0]);
  assert.equal(rows.length, 1);
  const open = rows[0].match(/^<li class="saved-row"><button type="button" class="saved-row-open">([\s\S]*?)<\/button>/)?.[1];
  assert.equal(
    open,
    `<span class="saved-row-name">Adams - Harbor</span>` +
      `<span class="saved-row-type">${TASK_TYPE_LABELS.VALUE}</span>` +
      `<time class="saved-row-when" dateTime="${new Date(NOW - 5 * 60000).toISOString()}">saved 5m ago</time>`
  );
});

/* ── Deleting one (#345) ─────────────────────────────────── */

test("each row has a delete control beside the button that reopens it, never inside it", () => {
  const html = renderSection([item("a", 5, { folderName: "Adams - Harbor" }), item("b", 10, { folderName: "  " })]);
  const rows = [...html.matchAll(/<li class="saved-row">([\s\S]*?)<\/li>/g)].map((m) => m[1]);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const open = row.match(/^<button type="button" class="saved-row-open">[\s\S]*?<\/button>/)?.[0];
    assert.ok(open, "the row starts with the button that reopens it");
    assert.doesNotMatch(open, /saved-row-delete/, "the delete control is not part of the reopen target");
    assert.match(row.slice(open.length), /^<button type="button" class="saved-row-delete"[^>]*><svg[\s\S]*<\/svg><\/button>$/, "it is its own button, right after");
  }
  assert.match(rows[0], /class="saved-row-delete" aria-label="Delete saved task: Adams - Harbor"/, "named for the row it deletes");
  assert.match(rows[1], /class="saved-row-delete" aria-label="Delete saved task: No loan yet"/);
});

test("pressing the delete control asks first, and does not reopen the form", () => {
  const trigger = SECTION_SOURCE.match(/<button\s+type="button"\s+className="saved-row-delete"[\s\S]*?<\/button>/)?.[0];
  assert.ok(trigger, "the row renders the delete control");
  assert.match(trigger, /onClick=\{\(\) => setConfirming\(true\)\}/, "pressing it only opens the question");
  assert.doesNotMatch(trigger, /onOpen|onDelete/, "it neither reopens the form nor deletes");
});

test("the question is asked in place, the safe answer first and holding focus, the delete in the danger style", () => {
  const html = renderToStaticMarkup(
    createElement(SavedForLaterDeleteConfirm, { name: "Adams - Harbor", deleting: false, onConfirm: () => {}, onCancel: () => {} })
  );
  assert.equal(
    html,
    `<div class="saved-row-confirm" role="alertdialog" aria-label="Delete Adams - Harbor?">` +
      `<span class="saved-row-confirm-question">Delete this saved task?</span>` +
      `<button type="button" class="btn-sm btn-ghost">Keep</button>` +
      `<button type="button" class="btn-sm btn-danger">Delete</button></div>`
  );
  assert.match(SECTION_SOURCE, /keepRef\.current\?\.focus\(\)/, "focus lands on Keep, so a stray Return is not the delete");
  assert.match(SECTION_SOURCE, /ref=\{keepRef\}[^>]*onClick=\{onCancel\}/, "the focused button is the one that declines");
});

test("while the delete is out, neither answer can be pressed again", () => {
  const html = renderToStaticMarkup(
    createElement(SavedForLaterDeleteConfirm, { name: "Adams - Harbor", deleting: true, onConfirm: () => {}, onCancel: () => {} })
  );
  assert.match(html, /<button type="button" class="btn-sm btn-ghost" disabled="">Keep<\/button><button type="button" class="btn-sm btn-danger" disabled="">Deleting…<\/button>/);
});

test("declining — Keep or Escape — deletes nothing and puts the row back", () => {
  const escape = SECTION_SOURCE.match(/onKeyDown=\{\(e\) => \{([\s\S]*?)\}\}/)?.[1];
  assert.ok(escape, "the question listens for keys");
  assert.match(escape, /e\.key === "Escape"/);
  assert.match(escape, /onCancel\(\)/, "Escape gives the safe answer");
  const decline = SECTION_SOURCE.match(/const decline = \(\): void => \{([\s\S]*?)\n  \};/)?.[1];
  assert.ok(decline, "the row has a decline handler");
  assert.doesNotMatch(decline, /onDelete/, "declining never reaches the delete");
  assert.match(decline, /setConfirming\(false\)/, "and closes the question");
  assert.match(SECTION_SOURCE, /onCancel=\{decline\}/, "Keep and Escape both decline");
  const confirm = SECTION_SOURCE.match(/const confirmDelete = async \(\): Promise<void> => \{([\s\S]*?)\n  \};/)?.[1];
  assert.match(confirm, /await onDelete\(item\)/, "the row deletes only from the confirm");
  assert.match(SECTION_SOURCE, /onConfirm=\{\(\) => void confirmDelete\(\)\}/);
  const rowSource = SECTION_SOURCE.match(/const SavedForLaterRow = [\s\S]*?\n\};/)?.[0];
  assert.equal((rowSource.match(/onDelete\(/g) ?? []).length, 1, "and nowhere else in the row");
});

test("once a delete lands, focus moves to the row that took its place, and a failed one leaves it on the row", () => {
  const section = SECTION_SOURCE.match(/export const TaskDraftsPage = [\s\S]*?\n\};/)?.[0];
  assert.ok(section);
  const deleteRow = section.match(/const deleteRow = async <T extends DraftRowItem,>\([\s\S]*?\n  \};/)?.[0];
  assert.ok(deleteRow, "the section wraps the delete");
  assert.ok(
    deleteRow.indexOf("refocus.current = { id: item.id, index }") >= 0 &&
      deleteRow.indexOf("refocus.current = { id: item.id, index }") < deleteRow.indexOf("await remove(item)"),
    "it marks where the row was before asking"
  );
  assert.match(section, /onDelete=\{\(it\) => deleteRow\(it, index, onDelete\)\}/, "a draft's row deletes through it");
  assert.match(deleteRow, /if \(!removed\) refocus\.current = null;/, "a delete that did not land clears the mark");
  const effect = section.match(/useEffect\(\(\) => \{([\s\S]*?)\}, \[listed\]\);/)?.[1];
  assert.ok(effect, "the section moves focus when its list changes");
  assert.match(effect, /listed\.some\(\(i\) => i\.item\.id === mark\.id\)\) return;/, "only once the row is really gone");
  assert.match(effect, /querySelectorAll<HTMLButtonElement>\("\.saved-row-open"\)/);
  assert.match(effect, /\[Math\.min\(mark\.index, rows\.length - 1\)\]\?\.focus\(\)/, "the next row, or the new last one");
  assert.ok(section.indexOf("useEffect(") < section.indexOf("if (listed.length === 0)"), "hooks run before the empty return");
});

test("removing one takes its row off the page, and removing the last leaves the page saying there are none", () => {
  const two = [item("a", 5), item("b", 10)];
  assert.equal([...renderSection(two).matchAll(/<li class="saved-row">/g)].length, 2);
  assert.equal([...renderSection(two.filter((i) => i.id !== "a")).matchAll(/<li class="saved-row">/g)].length, 1);
  assert.match(renderSection([]), /No task drafts\./);
});

test("confirming removes it from the server, then from the section; a failure says so and leaves the row", async () => {
  assert.match(APP_SOURCE, /<TaskDraftsPage[^>]*onDelete=\{newTask\.deleteDraft\}/, "the row deletes through the session");
  const gone = [];
  const notices = [];
  const make = (answers) =>
    createNewTaskSession({ owner: USER.id, storage: null, request: fakeServer(answers).request, onSavedForLaterGone: (id) => gone.push(id), notify: (message) => notices.push(message) });
  assert.equal(await make({ "DELETE /saved-for-later/a": undefined }).deleteDraft(item("a", 5)), true);
  assert.deepEqual([gone, notices], [["a"], []], "the row leaves the section");
  assert.equal(await make({ "DELETE /saved-for-later/a": httpError(500) }).deleteDraft(item("a", 5)), false);
  assert.deepEqual([gone, notices], [["a"], ["Couldn't delete that Task Draft. Try again."]], "a refusal is said, and the row stays");
});

test("a row with no loan typed says No loan yet", () => {
  const html = renderSection([item("a", 5, { folderName: "   " })]);
  assert.match(html, /<span class="saved-row-name">No loan yet<\/span>/);
});

/* #362: on an Out of Office task that field is the vacation description, not a
   loan, so a blank one names what is missing for that type. Every other type
   keeps No loan yet. */
test("an Out of Office row with no description says No description yet, and every other type still says No loan yet", () => {
  const ooo = renderSection([item("a", 5, { folderName: "  ", taskType: "OOO" })]);
  assert.match(ooo, /<span class="saved-row-name">No description yet<\/span>/);
  assert.doesNotMatch(ooo, /No loan yet/);
  assert.match(ooo, /aria-label="Delete saved task: No description yet"/, "the delete control is named the same way");
  for (const taskType of TASK_TYPES.filter((t) => t !== "OOO")) {
    assert.match(
      renderSection([item("a", 5, { folderName: "", taskType })]),
      /<span class="saved-row-name">No loan yet<\/span>/,
      `${taskType} keeps No loan yet`
    );
  }
});

test("an Out of Office row with a description shows it as typed", () => {
  const html = renderSection([item("a", 5, { folderName: "Beach week", taskType: "OOO" })]);
  assert.match(html, /<span class="saved-row-name">Beach week<\/span>/);
});

/* ── The autosave on the Task Drafts tab (#371) ──────────── */

const autosaveOf = (minutesAgo, overrides = {}) => ({
  ownerId: USER.id,
  savedAt: new Date(NOW - minutesAgo * 60000).toISOString(),
  form: { ...FORM, ...overrides }
});
const rowsOf = (html) => [...html.matchAll(/<li class="saved-row">([\s\S]*?)<\/li>/g)].map((m) => m[1]);

test("with an autosave, the page shows one Autosaved row with the loan, the type and when, among the drafts newest first", () => {
  const html = renderSection([item("a", 10, { folderName: "Saved one" }), item("b", 1, { folderName: "Saved just now" })], {
    autosave: autosaveOf(3, { folderName: "Castillo", taskType: "LOI" })
  });
  const rows = rowsOf(html);
  assert.equal(rows.length, 3, "two drafts and the autosave");
  const autosaved = rows.filter((row) => row.includes("Autosaved"));
  assert.equal(autosaved.length, 1, "exactly one Autosaved row");
  assert.equal(
    autosaved[0].match(/^<button type="button" class="saved-row-open">([\s\S]*?)<\/button>/)?.[1],
    `<span class="saved-row-name">Castillo</span>` +
      `<span class="saved-row-type">${TASK_TYPE_LABELS.LOI}</span>` +
      `<time class="saved-row-when" dateTime="${new Date(NOW - 3 * 60000).toISOString()}">Autosaved 3m ago</time>`
  );
  assert.deepEqual(
    rows.map((row) => row.match(/<span class="saved-row-name">([^<]*)<\/span>/)[1]),
    ["Saved just now", "Castillo", "Saved one"],
    "placed by when it was written, like every draft"
  );
  assert.doesNotMatch(html, /on this device/, "it follows the person, so it never says which device");
});

test("an Autosaved row with no loan typed says No loan yet, and the page is a list even with no saved drafts", () => {
  const html = renderSection([], { autosave: autosaveOf(3, { folderName: "  " }) });
  assert.match(html, /^<ul class="saved-list">/, "not the empty page");
  assert.match(html, /<span class="saved-row-name">No loan yet<\/span>/);
  assert.match(html, />Autosaved 3m ago<\/time>/);
});

test("an Autosaved Out of Office row with no description says No description yet, like a saved one", () => {
  const html = renderSection([], { autosave: autosaveOf(3, { folderName: " ", taskType: "OOO" }) });
  const [row] = rowsOf(html);
  assert.match(row, /<span class="saved-row-name">No description yet<\/span>/);
  assert.match(row, /aria-label="Delete autosaved task: No description yet"/);
  assert.match(row, />Autosaved 3m ago<\/time>/);
});

test("with no autosave, or one seven days old, no Autosaved row shows", () => {
  assert.doesNotMatch(renderSection([item("a", 5)]), /Autosaved/, "none handed in");
  assert.doesNotMatch(renderSection([item("a", 5)], { autosave: null }), /Autosaved/, "none on the server");
  assert.doesNotMatch(renderSection([item("a", 5)], { autosave: autosaveOf(7 * 24 * 60) }), /Autosaved/, "aged out");
  assert.equal(
    renderSection([], { autosave: autosaveOf(8 * 24 * 60) }),
    `<div class="empty-card">No task drafts. Use Save for later on a new task to keep one here.</div>`,
    "and an aged-out one alone leaves the page empty"
  );
});

test("the Task Drafts tab counts the autosave with the drafts, and App draws the count from the same rule", () => {
  assert.equal(taskDraftsCount([item("a", 5), item("b", 6)], autosaveOf(3), NOW), 3);
  assert.equal(taskDraftsCount([item("a", 5), item("b", 6)], null, NOW), 2);
  assert.equal(taskDraftsCount([item("a", 5)], autosaveOf(7 * 24 * 60), NOW), 1, "an aged-out one is not counted");
  assert.equal(taskDraftsCount([], autosaveOf(3), NOW), 1);
  assert.match(APP_SOURCE, /draftsCount=\{taskDraftsCount\(savedForLater, autosave, now\)\}/);
  assert.match(APP_SOURCE, /<TaskDraftsPage[^>]*autosave=\{autosave\}/, "the page is handed the same autosave the count is");
});

test("the Autosaved row's bin asks the same question a draft's does, and never opens the form", () => {
  const html = renderSection([], { autosave: autosaveOf(3, { folderName: "Castillo" }) });
  const [row] = rowsOf(html);
  assert.match(row, /<button type="button" class="saved-row-delete" aria-label="Delete autosaved task: Castillo"/, "its own control, named for the row");
  assert.match(SECTION_SOURCE, /onOpen=\{onOpenAutosave\}/, "pressing the row opens New Task");
  assert.match(SECTION_SOURCE, /onDelete=\{\(it\) => deleteRow\(it, index, onDeleteAutosave\)\}/, "the bin forgets the autosave, once confirmed, and focus moves on like a draft's");
  assert.equal((SECTION_SOURCE.match(/<SavedForLaterDeleteConfirm\b/g) ?? []).length, 1, "one confirmation, shared by every row");
});

test("the Autosaved seven days are the server's seven days", () => {
  const draft = readFileSync(join(REPO, "apps/web/src/create-form-draft.ts"), "utf8");
  assert.match(draft, /import \{ AUTOSAVE_MAX_AGE_MS \} from "@loan-tasks\/shared";/, "the offline copy ages on the shared number");
  assert.doesNotMatch(draft, /24 \* 60 \* 60 \* 1000/, "with no second copy of it");
  assert.equal(AUTOSAVE_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000);
});

test("tapping the Autosaved row opens New Task exactly as the New Task button does, on the latest autosave", () => {
  assert.match(APP_SOURCE, /<TaskDraftsPage[^>]*onOpenAutosave=\{newTask\.open\}/);
  assert.match(APP_SOURCE, /<NewTaskButton open=\{newTaskOpen\} onClick=\{\(\) => void newTask\.open\(\)\} \/>/, "the button takes the same way in");
  /* The session asks the server for the latest Autosave first, and leaves a
     form already up alone: driven in new-task-session-sim-test. */
  const newTaskMount = APP_SOURCE.match(/\{newTaskOpen && \(\s*<TaskForm([\s\S]*?)\/>/)?.[1];
  assert.match(newTaskMount, /session=\{newTask\}/, "a New Task gets the session and its autosave");
  /* A reopened record opens through the session, whose reopened mode has no
     Autosave seat: driven in reopened-task-session-sim-test. */
  assert.doesNotMatch(newTaskMount, /reopened/, "a reopened record never gets the create form's autosave");
});

test("App loads the autosave with the drafts, empties it on every identity change, and merges this browser's offline copy", () => {
  const identity = APP_SOURCE.slice(APP_SOURCE.indexOf("savedForLaterOwner.current = user.id;"));
  const block = identity.slice(0, identity.indexOf("}, [user.id]);"));
  assert.ok(block.indexOf("setAutosave(null)") >= 0 && block.indexOf("setAutosave(null)") < block.indexOf("if (!user.id) return;"), "emptied before anything loads");
  assert.match(block, /newTask\.refreshAutosave\(\)/, "and loaded with the drafts, weighed against this browser's offline copy by the session");
});

test("App's autosave callbacks are silent: typing never toasts or re-renders the board", async () => {
  assert.match(APP_SOURCE, /onAutosave: setAutosave,/, "App hears of the Autosave from the session, and only sets the row");

  const calls = [];
  const events = [];
  const session = createNewTaskSession({
    owner: USER.id,
    storage: null,
    request: async (path, init) => {
      calls.push(`${init.method} ${path}`);
      return init.method === "GET" ? { item: null } : {};
    },
    onAutosave: (item) => events.push(["autosave", item]),
    notify: (message) => events.push(["notify", message])
  });
  await session.open();
  events.length = 0;
  session.edit({ ...session.getState().values, folderName: "Alvarez" });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.deepEqual(calls.at(-1), "PUT /autosave", "typing is written");
  assert.deepEqual(events, [], "and nothing is said or re-rendered for it");
  session.edit({ ...session.getState().values, folderName: "" });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.deepEqual(calls.at(-1), "DELETE /autosave", "emptied back out, it is forgotten");
  assert.deepEqual(events, [["autosave", null]], "taking the row with it, silently");
});

/* Both copies going, and a refusal said with the row kept, are driven in
   new-task-session-sim-test. */
test("deleting the Autosaved row goes through the session", () => {
  assert.match(APP_SOURCE, /<TaskDraftsPage[^>]*onDeleteAutosave=\{newTask\.deleteAutosave\}/);
});

test("saving a new form for later leaves one draft and no Autosaved row", async () => {
  const events = [];
  const session = createNewTaskSession({
    owner: USER.id,
    storage: null,
    request: async (path, init) => (init.method === "POST" ? { item: item("new", 0) } : { item: null }),
    onAutosave: (autosave) => events.push(["autosave", autosave]),
    onSavedForLater: (saved) => events.push(["saved", saved.id])
  });
  await session.open();
  session.edit({ ...session.getState().values, folderName: "Alvarez" });
  events.length = 0;
  await session.end({ kind: "saveForLater" });
  assert.deepEqual(events, [["autosave", null], ["saved", "new"]], "the row goes the moment the draft appears; the server cleared it in the same write");
});

/* ── Reopening one (#344) ────────────────────────────────── */

test("tapping a row reopens that Saved for Later task: the whole row is one button that hands its record to App", () => {
  const html = renderSection([item("a", 5), item("b", 10)]);
  assert.equal([...html.matchAll(/<button type="button" class="saved-row-open">/g)].length, 2, "one press target per row");
  assert.match(SECTION_SOURCE, /onClick=\{\(\) => onOpen\(item\)\}/, "pressing it opens that row's own record");
});

const FULL_FORM = {
  folderName: "Baker - Pier 9",
  loanId: "loan-7",
  taskType: "FRAUD",
  urgency: "ORANGE",
  startDate: "",
  returnDate: "",
  notes: "Borrower ID does not match",
  humperdinkLink: "https://humperdink.example/Loans/Details/77",
  points: 4,
  initialItems: ["Missing appraisal", "Unsigned 4506-C"],
  pickerMode: "share",
  recipientUserId: "user-2",
  recipientNote: "Can you look first thing?"
};
const DIRECTORY = [
  USER,
  { id: "user-2", displayName: "Sam Checker", roles: ["FILE_CHECKER"] }
];
const reopened = (form, overrides = {}) => ({
  id: "saved-1",
  ownerId: USER.id,
  savedAt: new Date(NOW - 60 * 60000).toISOString(),
  form,
  ...overrides
});

/* A reopened Task Draft is a New Task session opened on the record (#469). */
const renderReopened = async (record, props = {}) => {
  const session = createNewTaskSession({
    owner: USER.id,
    request: async () => ({ item: record }),
    storage: window.localStorage
  });
  assert.equal(await session.reopen(record), "opened");
  return renderForm({ session, ...props });
};

test("a reopened Saved for Later task opens the create form with every field restored", async () => {
  const html = await renderReopened(reopened(FULL_FORM), { directory: DIRECTORY });
  assert.match(html, /aria-label="New task"/, "the create form, not edit mode");
  assert.match(html, /value="Baker - Pier 9"/, "folder name");
  assert.match(html, /<option value="FRAUD" selected="">/, "task type");
  assert.match(html, /<option value="ORANGE" selected="">/, "urgency");
  assert.match(html, />Borrower ID does not match<\/textarea>/, "notes");
  assert.match(html, /value="https:\/\/humperdink\.example\/Loans\/Details\/77"/, "Humperdink link");
  assert.equal([...html.matchAll(/aria-pressed="true">💩/g)].length, 4, "poop points");
  assert.match(html, /Missing appraisal[\s\S]*Unsigned 4506-C/, "outstanding items");
  assert.match(html, /<option value="user-2" selected="">Sam Checker<\/option>/, "who it goes to");
  assert.match(html, /value="Can you look first thing\?"/, "the note to them");

  const assign = await renderReopened(reopened({ ...FULL_FORM, taskType: "VALUE", pickerMode: "assign" }), { directory: DIRECTORY });
  assert.match(assign, /aria-pressed="true">Assign/, "share or assign");

  const ooo = await renderReopened(
    reopened({ ...FULL_FORM, taskType: "OOO", folderName: "Beach week", startDate: "2026-09-20", returnDate: "2026-09-27" })
  );
  assert.match(ooo, /value="2026-09-20"/, "start date");
  assert.match(ooo, /value="2026-09-27"/, "return date");
});

test("every field the form holds is one the reopen test above restores", async () => {
  const { draftFieldNames } = await import(pathToFileURL(join(REPO, "apps/web/src/create-form-draft.ts")).href);
  assert.deepEqual(Object.keys(FULL_FORM).sort(), draftFieldNames().sort());
});

test("a reopened form keeps the Save for later button, pressable straight away, and says nothing about the autosave", async () => {
  // Someone else's typing in the autosave must not leak into, or replace, the
  // record they asked to reopen.
  storage.set(draftKey(USER.id), serializeDraft({ ...FORM, notes: "an unrelated autosave" }, Date.now()));
  const html = await renderReopened(reopened(FULL_FORM), { directory: DIRECTORY });
  const [, disabled] = html.match(FOOT_ORDER);
  assert.equal(disabled, undefined, "saving it again needs no further typing");
  assert.doesNotMatch(html, /an unrelated autosave/);
  assert.doesNotMatch(html, /Start fresh/);
  assert.match(html, />Create Task<\/button>/);
});

/* Which record Save for later and Create act on, and that neither touches the
   Autosave, is driven through the session in reopened-task-session-sim-test. */
test("a reopened form is filed through the one payload every create form uses, and its session ends it", () => {
  assert.doesNotMatch(FORM_SOURCE, /browserDraftStorage/, "no storage seat of its own, so no ending can clear or overwrite an unrelated autosave");
  const body = FORM_SOURCE.match(/const saveForLater = async \(\): Promise<void> => \{([\s\S]*?)\n  \};/)?.[1];
  assert.match(body, /await session\.end\(\{ kind: "saveForLater" \}\);/, "Save for later goes through the session");
  const submit = FORM_SOURCE.match(/const handleSubmit = async \([\s\S]*?\n  \};/)?.[0];
  assert.match(submit, /await session\.end\(\{\s*kind: "create",/, "Create goes through the session, which removes the record once the task exists");
  assert.equal(
    (submit.match(/const payload: CreateTaskInput = \{/g) ?? []).length,
    1,
    "one payload for every create form: a reopened one is filed exactly as a new one, loan resolution included"
  );
});

test("App opens a reopened record through the New Task session", () => {
  /* Fetching the latest first, and leaving a form opened meanwhile alone, are
     driven in reopened-task-session-sim-test. */
  assert.match(APP_SOURCE, /<TaskDraftsPage[^>]*onOpen=\{newTask\.reopen\}/);
  const createMount = APP_SOURCE.match(/\{newTaskOpen && \(\s*<TaskForm([\s\S]*?)\/>/)?.[1];
  assert.doesNotMatch(createMount, /reopened/, "the create form is never handed a record");
});

/* ── Abandoned typing on a reopened form (#348) ─────────── */

test("a reopened record carrying unsaved typing opens on that typing, not on the earlier save", async () => {
  const html = await renderReopened(reopened(FULL_FORM, { unsaved: { ...FULL_FORM, notes: "typed after the save, tab closed" } }), {
    directory: DIRECTORY
  });
  assert.match(html, />typed after the save, tab closed<\/textarea>/, "the typing comes back");
  assert.doesNotMatch(html, /Borrower ID does not match/, "rather than the version it was saved at");
  assert.doesNotMatch(html, /role="alertdialog"/, "and nothing is asked on the way in");
});

/* ── Saying so (#475) ───────────────────────────────────── */

const UNSAVED_NOTE = "You have unsaved changes to this Task Draft. Picking up where you left off.";

test("a reopened record carrying unsaved typing says so on the form, in the Autosave note's style, with no Start fresh", async () => {
  const html = await renderReopened(reopened(FULL_FORM, { unsaved: { ...FULL_FORM, notes: "typed after the save" } }), {
    directory: DIRECTORY
  });
  const note = html.match(/<div class="task-form-restored">([\s\S]*?)<\/div>/)?.[1];
  assert.ok(note, "the note is up");
  assert.match(note, new RegExp(`<p class="task-form-locked task-form-restored-note">${UNSAVED_NOTE}</p>`));
  assert.doesNotMatch(note, /Start fresh|<button/, "no way back to the last save ships with it");
  assert.doesNotMatch(html, /Hot Task saved your progress/);
});

test("a reopened record with no unsaved typing opens with no note", async () => {
  const html = await renderReopened(reopened(FULL_FORM), { directory: DIRECTORY });
  assert.doesNotMatch(html, /task-form-restored/);
  assert.ok(!html.includes(UNSAVED_NOTE));
});

test("a Task Drafts row with unsaved typing carries an Unsaved changes marker; one without doesn't", () => {
  const html = renderSection([
    { ...item("a", 5, { folderName: "Typed since" }), unsaved: { ...FORM, notes: "more" } },
    item("b", 10, { folderName: "As saved" })
  ]);
  const [typed, clean] = rowsOf(html);
  assert.match(
    typed,
    /<time class="saved-row-when"[^>]*>saved 5m ago<\/time><span class="saved-row-unsaved">Unsaved changes<\/span><\/button>/,
    "inside the row's button, after when it was saved"
  );
  assert.doesNotMatch(clean, /saved-row-unsaved|Unsaved changes/);
});

test("the Autosaved row never carries the marker", () => {
  const html = renderSection([], { autosave: autosaveOf(5) });
  assert.doesNotMatch(html, /saved-row-unsaved/);
});

/* ── Cancel always asks when there is anything in it (#365) ── */

test("Cancel on an unchanged reopened Saved for Later task asks, with Save for later pressable in the prompt", async () => {
  /* That it asks with nothing changed is the session's, driven in
     reopened-task-session-sim-test. */
  // The prompt's Save for later is the footer's, pressable exactly when the
  // footer's is, and the footer's is pressable on an unchanged reopened form.
  const [, disabled] = (await renderReopened(reopened(FULL_FORM), { directory: DIRECTORY })).match(FOOT_ORDER);
  assert.equal(disabled, undefined, "so Save for later is an answer, and saving again restarts its saved N ago");
  const close = FORM_SOURCE.slice(FORM_SOURCE.indexOf("const requestClose"));
  assert.doesNotMatch(close.slice(0, close.indexOf("};")), /sendUnsaved|onClose\(\);[\s\S]*onClose\(\);/, "no silent way out for a reopened form");
});

/* Flipped by #388, then by #399: Discard from that prompt used to clear only
   the unsaved slot and leave the saved record as it was, and then asked a
   second question before deleting. Now Discard itself removes the record, by
   the row's own request. */
test("Discard from that prompt removes the saved record itself, with no second question, and a 404 counts as removed", async () => {
  const confirm = FORM_SOURCE.slice(FORM_SOURCE.indexOf("const confirmDiscard"));
  const body = confirm.slice(0, confirm.indexOf("\n  };"));
  assert.doesNotMatch(body, /setDeleteAsk|setDiscardAsk\(false\)/, "no second question: the prompt stays up while the delete is out");
  assert.doesNotMatch(body, /onDiscardUnsaved|onSaveForLater|onKeepUnsaved/, "nothing that clears only the slot or writes the save");
  assert.match(body, /await session\.end\(\{ kind: "discard" \}\)/, "the session deletes a reopened record: driven in reopened-task-session-sim-test");
  const server = fakeServer({ "DELETE /saved-for-later/saved-1": undefined });
  assert.equal(await removeSavedForLaterRequest(server.request, "saved-1"), true);
  assert.deepEqual(server.calls, ["DELETE /saved-for-later/saved-1"], "one request, to the record, not to its unsaved slot");
  assert.equal(await removeSavedForLaterRequest(fakeServer({ "DELETE /saved-for-later/saved-1": httpError(404) }).request, "saved-1"), true, "already gone on another device counts as deleted");
  assert.equal(await removeSavedForLaterRequest(fakeServer({ "DELETE /saved-for-later/saved-1": httpError(500) }).request, "saved-1"), false, "anything else is still there");
});

test("Cancel on a new task restored from the autosave and left untouched asks", async () => {
  const restored = { ...FORM, notes: "half a thought" };
  const autosave = { ownerId: USER.id, savedAt: new Date().toISOString(), form: restored };
  const kept = createNewTaskSession({ owner: USER.id, storage: null, request: async () => ({ item: autosave }) });
  await kept.open();
  assert.equal(await kept.end({ kind: "cancel" }), "asked");
  const empty = createNewTaskSession({ owner: USER.id, storage: null, request: async () => ({ item: null }) });
  await empty.open();
  assert.equal(await empty.end({ kind: "cancel" }), "closed", "a completely empty one still closes without a prompt");
});

test("App says out loud what the session reports, and the Task Drafts tab follows its records", () => {
  const deps = APP_SOURCE.match(/const newTask = useNewTaskSession\(\{([\s\S]*?)\n  \}\);/)?.[1];
  /* A session whose person has changed says nothing more: driven in
     new-task-session-sim-test. */
  assert.match(deps, /notify: \(message, variant\) => showToast\(message, \{ variant \}\)/);
  assert.match(deps, /onSavedForLaterGone: \(id\) => setSavedForLater\(\(current\) => current\.filter\(\(saved\) => saved\.id !== id\)\)/);
  assert.match(deps, /onSavedForLaterLatest: \(latest\) => setSavedForLater\(\(current\) => current\.map\(/);
  assert.match(deps, /item\.id !== saved\.id && item\.id !== replaced/, "a save replaces the record it was reopened from");
  assert.match(
    deps,
    /onSavedForLaterUnsaved: \(id, unsaved\) => setSavedForLater\(\(current\) => current\.map\(\(saved\) => \(saved\.id === id \? withUnsaved\(saved, unsaved\) : saved\)\)\)/,
    "unsaved typing that landed marks the row as it stands now (#475)"
  );
});

test("withUnsaved sets or clears only the unsaved typing, leaving the row's save as it is (#475)", () => {
  const row = item("a", 5, { folderName: "Saved elsewhere since" });
  const typed = { ...FORM, notes: "typed" };
  assert.deepEqual(withUnsaved(row, typed), { ...row, unsaved: typed });
  const cleared = withUnsaved({ ...row, unsaved: typed }, null);
  assert.deepEqual(cleared, row);
  assert.equal("unsaved" in cleared, false);
});

test("saving a reopened one again goes through the one request helper", () => {
  const session = readFileSync(join(REPO, "apps/web/src/new-task-session.ts"), "utf8");
  assert.match(session, /saveForLaterRequest\(request, form, id\)/);
});

/* The three requests, driven against a fake server. */
const fakeServer = (answers) => {
  const calls = [];
  const request = async (path, init) => {
    calls.push(`${init.method} ${path}`);
    const answer = answers[`${init.method} ${path}`];
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer(init) : answer;
  };
  return { calls, request };
};
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
const ITEM = reopened(FULL_FORM);

test("a new form saves for later as a new record", async () => {
  const server = fakeServer({ "POST /saved-for-later": { item: ITEM } });
  assert.deepEqual(await saveForLaterRequest(server.request, FULL_FORM), ITEM);
  assert.deepEqual(server.calls, ["POST /saved-for-later"]);
});

test("a reopened form saves for later onto its own record", async () => {
  const server = fakeServer({ "PUT /saved-for-later/saved-1": (init) => ({ item: { ...ITEM, form: JSON.parse(init.body).form } }) });
  const item = await saveForLaterRequest(server.request, { ...FULL_FORM, notes: "more" }, "saved-1");
  assert.equal(item.form.notes, "more");
  assert.deepEqual(server.calls, ["PUT /saved-for-later/saved-1"], "never a second record");
});

test("a reopened form whose record was created or removed elsewhere still keeps the typing, as a new record", async () => {
  const server = fakeServer({ "PUT /saved-for-later/saved-1": httpError(404), "POST /saved-for-later": { item: { ...ITEM, id: "saved-2" } } });
  const item = await saveForLaterRequest(server.request, FULL_FORM, "saved-1");
  assert.equal(item.id, "saved-2");
  assert.deepEqual(server.calls, ["PUT /saved-for-later/saved-1", "POST /saved-for-later"]);
});

test("any other failure saving a reopened one is a failure, and makes no copy", async () => {
  const server = fakeServer({ "PUT /saved-for-later/saved-1": httpError(500) });
  await assert.rejects(saveForLaterRequest(server.request, FULL_FORM, "saved-1"));
  assert.deepEqual(server.calls, ["PUT /saved-for-later/saved-1"]);
});

test("reopening reads the latest save; one that is gone opens nothing; an unreachable server opens the copy on screen", async () => {
  const newer = { ...ITEM, form: { ...FULL_FORM, notes: "saved from the phone" } };
  assert.deepEqual(await reopenSavedForLaterRequest(fakeServer({ "GET /saved-for-later/saved-1": { item: newer } }).request, ITEM), newer);
  assert.equal(await reopenSavedForLaterRequest(fakeServer({ "GET /saved-for-later/saved-1": httpError(404) }).request, ITEM), null);
  assert.deepEqual(await reopenSavedForLaterRequest(fakeServer({ "GET /saved-for-later/saved-1": new Error("offline") }).request, ITEM), ITEM);
});

test("removing one (created, or deleted from the board) takes it off the server; already gone counts as removed; anything else reports it is still there", async () => {
  const ok = fakeServer({ "DELETE /saved-for-later/saved-1": undefined });
  assert.equal(await removeSavedForLaterRequest(ok.request, "saved-1"), true);
  assert.deepEqual(ok.calls, ["DELETE /saved-for-later/saved-1"]);
  assert.equal(await removeSavedForLaterRequest(fakeServer({ "DELETE /saved-for-later/saved-1": httpError(404) }).request, "saved-1"), true);
  assert.equal(await removeSavedForLaterRequest(fakeServer({ "DELETE /saved-for-later/saved-1": httpError(500) }).request, "saved-1"), false);
  await assert.doesNotReject(removeSavedForLaterRequest(fakeServer({ "DELETE /saved-for-later/saved-1": new Error("offline") }).request, "saved-1"));
});

/* ── Typing nobody saved (#348, ADR-0011 rule 5) ─────────── */

test("typing on a reopened form is sent to that record's unsaved slot, never as a save and never as a new record", async () => {
  const server = fakeServer({ "PUT /saved-for-later/saved-1/unsaved": (init) => ({ item: { ...ITEM, unsaved: JSON.parse(init.body).form } }) });
  assert.equal(await keepUnsavedRequest(server.request, "saved-1", { ...FULL_FORM, notes: "typed" }), true);
  assert.deepEqual(server.calls, ["PUT /saved-for-later/saved-1/unsaved"]);
});

test("typing that could not be kept says so and never throws at someone mid-sentence, and a gone record is not recreated", async () => {
  const gone = fakeServer({ "PUT /saved-for-later/saved-1/unsaved": httpError(404) });
  assert.equal(await keepUnsavedRequest(gone.request, "saved-1", FULL_FORM), false);
  assert.deepEqual(gone.calls, ["PUT /saved-for-later/saved-1/unsaved"], "no POST: a created or deleted one stays gone");
  assert.equal(await keepUnsavedRequest(fakeServer({ "PUT /saved-for-later/saved-1/unsaved": new Error("offline") }).request, "saved-1", FULL_FORM), false);
});

test("discarding throws the unsaved typing away; one already gone counts as discarded; anything else reports it is still there", async () => {
  const ok = fakeServer({ "DELETE /saved-for-later/saved-1/unsaved": { item: ITEM } });
  assert.equal(await discardUnsavedRequest(ok.request, "saved-1"), true);
  assert.deepEqual(ok.calls, ["DELETE /saved-for-later/saved-1/unsaved"], "the unsaved slot only, never the record");
  assert.equal(await discardUnsavedRequest(fakeServer({ "DELETE /saved-for-later/saved-1/unsaved": httpError(404) }).request, "saved-1"), true);
  assert.equal(await discardUnsavedRequest(fakeServer({ "DELETE /saved-for-later/saved-1/unsaved": httpError(500) }).request, "saved-1"), false);
  await assert.doesNotReject(discardUnsavedRequest(fakeServer({ "DELETE /saved-for-later/saved-1/unsaved": new Error("offline") }).request, "saved-1"));
});

/* ── The autosave on the server (#371) ───────────────────── */

const AUTOSAVE = { ownerId: USER.id, savedAt: "2026-09-11T11:57:00.000Z", form: FULL_FORM };

test("a new form saved for later clears the autosave in the same request; a reopened one whose record went does not", async () => {
  const fresh = fakeServer({ "POST /saved-for-later": (init) => ({ item: { ...ITEM, body: JSON.parse(init.body) } }) });
  const saved = await saveForLaterRequest(fresh.request, FULL_FORM);
  assert.equal(saved.body.clearAutosave, true, "the new task form is putting its own autosaved typing aside");
  const gone = fakeServer({
    "PUT /saved-for-later/saved-1": httpError(404),
    "POST /saved-for-later": (init) => ({ item: { ...ITEM, body: JSON.parse(init.body) } })
  });
  const resaved = await saveForLaterRequest(gone.request, FULL_FORM, "saved-1");
  assert.equal(resaved.body.clearAutosave, undefined, "a reopened form's typing is not the autosave, so it is left alone");
});

test("loading the autosave answers the server's copy, none, or that the server could not be reached", async () => {
  assert.deepEqual(await loadAutosaveRequest(fakeServer({ "GET /autosave": { item: AUTOSAVE } }).request), { reached: true, item: AUTOSAVE });
  assert.deepEqual(await loadAutosaveRequest(fakeServer({ "GET /autosave": { item: null } }).request), { reached: true, item: null });
  assert.deepEqual(await loadAutosaveRequest(fakeServer({ "GET /autosave": new Error("offline") }).request), { reached: false, item: null });
  assert.deepEqual(await loadAutosaveRequest(fakeServer({ "GET /autosave": httpError(500) }).request), { reached: false, item: null });
});

test("a server that never answers does not hold New Task shut: the load gives up and says it was not reached", async () => {
  const hanging = async () => new Promise(() => {});
  const started = Date.now();
  assert.deepEqual(await loadAutosaveRequest(hanging, 20), { reached: false, item: null });
  assert.ok(Date.now() - started < 1000, "it gave up on its timeout");
});

test("typing is autosaved to the server, and a write that did not land says so without throwing mid-sentence", async () => {
  const ok = fakeServer({ "PUT /autosave": (init) => ({ item: { ...AUTOSAVE, form: JSON.parse(init.body).form } }) });
  const landed = async (server, form) => (await stampedKeepAutosaveRequest(server.request, form)).landed;
  assert.equal(await landed(ok, { ...FULL_FORM, notes: "typed" }), true);
  assert.deepEqual(ok.calls, ["PUT /autosave"]);
  assert.equal(await landed(fakeServer({ "PUT /autosave": new Error("offline") }), FULL_FORM), false);
  assert.equal(await landed(fakeServer({ "PUT /autosave": httpError(500) }), FULL_FORM), false);
});

test("forgetting the autosave takes it off the server, and a failure says so without throwing", async () => {
  const ok = fakeServer({ "DELETE /autosave": undefined });
  assert.equal(await forgetAutosaveRequest(ok.request), true);
  assert.deepEqual(ok.calls, ["DELETE /autosave"]);
  assert.equal(await forgetAutosaveRequest(fakeServer({ "DELETE /autosave": new Error("offline") }).request), false);
  assert.equal(await forgetAutosaveRequest(fakeServer({ "DELETE /autosave": httpError(500) }).request), false);
});

/* ── The board lists no drafts (#363) ────────────────────── */

const renderTaskListSource = () => {
  const source = APP_SOURCE.match(/const renderTaskList = \([\s\S]*?\n  \};/)?.[0];
  assert.ok(source, "renderTaskList exists");
  return source;
};

test("neither Grouped nor Flat view draws a Saved for Later section: the task list is handed tasks and nothing else", () => {
  const source = renderTaskListSource();
  assert.match(source, /^const renderTaskList = \(list: LoanTask\[\], emptyMessage: string\) =>/, "no third argument to smuggle drafts in");
  assert.doesNotMatch(source, /savedItems|savedSection|SavedForLater|TaskDrafts|savedForLater/, "no draft reaches either view");
  assert.match(APP_SOURCE, /renderTaskList\(boardTasks, "No tasks yet\."\)/, "the Tasks board passes its tasks only");
  assert.equal((APP_SOURCE.match(/<SavedForLaterSection\b/g) ?? []).length, 0, "the old section is gone");
  assert.doesNotMatch(SECTION_SOURCE, /export const SavedForLaterSection\b/);
});

/* ── The tab row (#363, three tabs since #390) ──────────── */

const renderTabs = (props) =>
  renderToStaticMarkup(
    createElement(BoardTabs, { tab: "all", onTabChange: () => {}, draftsCount: 2, ...props })
  );
const tabButtons = (html) => [...html.matchAll(/<button [^>]*role="tab"[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[0]);

/* 2026-09-14, the user's call: All and Mine carry no count, and Drafts shows
   its count only while there is a draft. The sections under the tabs already
   count their rows. */
test("the header's tab row is All, Mine, then Drafts, and only Drafts carries a count", () => {
  const html = renderTabs();
  assert.match(html, /^<div class="board-tabs" role="tablist" aria-label="Board">/);
  const [all, mine, drafts, extra] = tabButtons(html);
  assert.equal(extra, undefined, "three tabs");
  const label = (spoken, shown) =>
    `<span class="board-tab-label"><span class="sr-only">${spoken}</span><span aria-hidden="true">${shown}</span></span>`;
  assert.match(all, /id="board-tab-all"/);
  assert.ok(all.endsWith(`${label("All Tasks", "All")}</button>`), "All has no count");
  assert.match(mine, /id="board-tab-mine"/);
  assert.ok(mine.endsWith(`${label("My Tasks", "Mine")}</button>`), "Mine has no count");
  assert.match(drafts, /id="board-tab-drafts"/);
  assert.ok(drafts.endsWith(`${label("Task Drafts", "Drafts")}<span class="section-count">2</span></button>`), "Drafts counts its drafts");
});

test("the tabs read All, Mine and Drafts at every width, with no second set of names behind a breakpoint", () => {
  const CSS = readFileSync(join(REPO, "apps/web/src/styles.css"), "utf8");
  assert.doesNotMatch(CSS, /\.board-tab-short|\.board-tab-name/);
  const srOnly = CSS.match(/\n\.sr-only \{([\s\S]*?)\}/);
  assert.ok(srOnly, "the full names ride the app's one visually-hidden rule");
  assert.doesNotMatch(srOnly[1], /display: none|visibility: hidden/, "hidden from sight, not from a screen reader");
});

test("the selected tab is the one announced and the only one Tab lands on", () => {
  for (const [at, tab] of ["all", "mine", "drafts"].entries()) {
    const buttons = tabButtons(renderTabs({ tab }));
    buttons.forEach((button, i) => {
      if (i === at) {
        assert.match(button, /aria-selected="true"/, tab);
        assert.match(button, /tabindex="0"/, tab);
        assert.match(button, /class="tab-btn board-tab tab-active"/, "the app's one tab rule, with a modifier for the heading's type");
        assert.match(button, /aria-controls="board-panel"/, "the selected tab names the panel below it");
      } else {
        assert.match(button, /aria-selected="false"/, `${tab}: tab ${i}`);
        assert.match(button, /tabindex="-1"/, `${tab}: tab ${i}`);
        assert.match(button, /class="tab-btn board-tab"/);
        assert.doesNotMatch(button, /aria-controls/, "the panel it would name is not on the page");
      }
    });
  }
});

test("with no drafts the Task Drafts tab is still there, with no count beside it", () => {
  const [, , drafts] = tabButtons(renderTabs({ draftsCount: 0 }));
  assert.ok(
    drafts.endsWith(`<span class="sr-only">Task Drafts</span><span aria-hidden="true">Drafts</span></span></button>`),
    "the tab, and no chip reading 0"
  );
  assert.doesNotMatch(drafts, /section-count/);
});

test("while searching, All Tasks carries the loan's name at every width, its full name on hover, and My Tasks keeps its own", () => {
  const [loan, mine] = tabButtons(renderTabs({ allLabel: "Castillo - Harbor View", allTitle: "Castillo - Harbor View" }));
  assert.match(loan, /<span class="board-tab-label" title="Castillo - Harbor View">Castillo - Harbor View<\/span><\/button>/);
  assert.doesNotMatch(loan, /sr-only/, "a loan's name is read as shown");
  assert.match(mine, /<span class="sr-only">My Tasks<\/span><span aria-hidden="true">Mine<\/span><\/span><\/button>/);
});

test("pressing a tab, or an arrow key across the row, selects it, and the row cycles all three", () => {
  const TABS_SOURCE = readFileSync(join(REPO, "apps/web/src/board-tabs.tsx"), "utf8");
  assert.match(TABS_SOURCE, /onClick=\{\(\) => onTabChange\(value\)\}/);
  assert.match(TABS_SOURCE, /const ORDER: readonly BoardTab\[\] = \["all", "mine", "drafts"\];/);
  for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
    assert.match(TABS_SOURCE, new RegExp(`"${key}"`), `${key} moves along the row`);
  }
  assert.match(TABS_SOURCE, /\.focus\(\)/, "and focus follows the selection");
});

test("App opens on the stored All / My tab, stores only those two, and never stores Task Drafts", () => {
  assert.match(APP_SOURCE, /const \[boardTab, setBoardTab\] = useState<BoardTab>\(\(\) => tabForShow\(boardShow\)\);/);
  const storing = APP_SOURCE.split("\n").filter((line) => /boardTab|BoardTab/.test(line) && /localStorage|Storage|persist/i.test(line));
  assert.deepEqual(storing, [], "no line both names the tab and stores anything");
  const select = APP_SOURCE.match(/const selectBoardTab = useCallback\(\(tab: BoardTab\): void => \{([\s\S]*?)\}, \[\]\);/)?.[1];
  assert.ok(select, "one way to choose a tab");
  assert.match(select, /setBoardTab\(tab\);/);
  assert.match(select, /const show = showForTab\(tab\);\s*if \(show\) setBoardShow\(show\);/, "the stored half is written through showForTab, which has no value for Task Drafts");
});

const boardBlock = () => {
  const start = APP_SOURCE.indexOf(`{activeTab === "active" && (() => {`);
  const end = APP_SOURCE.indexOf(`{activeTab === "metrics" && isAdmin && (`);
  assert.ok(start >= 0 && end > start, "the Tasks board block exists");
  return APP_SOURCE.slice(start, end);
};

test("the tab row is always drawn on the Tasks board, so Mine and an empty search can never hide Task Drafts", () => {
  const block = boardBlock();
  const tabs = block.indexOf("<BoardTabs");
  const panel = block.indexOf(`role="tabpanel"`);
  assert.ok(tabs >= 0, "the Tasks board draws the tab row");
  assert.ok(panel > tabs, "above the panel");
  assert.doesNotMatch(block.slice(0, panel), /\? \(|&& \(\s*<div className="section-head/, "and not inside any condition, so no empty state stands in for the header");
  for (const empty of ["<LoanSearchEmpty", "Nothing of yours right now"]) {
    assert.ok(block.indexOf(empty) > panel, `${empty} is drawn inside the panel, under the tabs`);
  }
  const tabsProps = block.slice(tabs, block.indexOf("/>", tabs));
  assert.match(tabsProps, /draftsCount=\{taskDraftsCount\(savedForLater, autosave, now\)\}/, "counted from every draft the viewer has, not a filtered list");
  assert.doesNotMatch(tabsProps, /allCount|mineCount/, "All Tasks and My Tasks carry no count");
  assert.equal((APP_SOURCE.match(/<BoardTabs\b/g) ?? []).length, 1, "the Tasks board is the only list with a tab row");
});

test("both task tabs come from the one narrowing rule, and the open one is the list the board renders", () => {
  assert.match(APP_SOURCE, /const allBoardTasks = useMemo\(\(\) => visibleBoardTasks\(unifiedTasks, \{ show: "everyone",/);
  assert.match(APP_SOURCE, /const mineBoardTasks = useMemo\(\(\) => visibleBoardTasks\(unifiedTasks, \{ show: "mine",/);
  assert.match(APP_SOURCE, /const boardTasks = boardTab === "mine" \? mineBoardTasks : allBoardTasks;/);
  assert.match(boardBlock(), /expandedIds=\{boardTab === "drafts" \? \[\] : expandedIdsIn\(boardTasks\)\}/, "Collapse all acts on the list the open tab renders");
});

test("switching tabs swaps the body: the Task Drafts page lists every draft, never narrowed by Mine or the search", () => {
  const block = boardBlock();
  assert.match(block, /boardBody\(\{ loaded: [^,]+, tab: boardTab, searching: Boolean\(searchLoan\), shownCount: boardTasks\.length \}\)/);
  const page = block.match(/<TaskDraftsPage([\s\S]*?)\/>/)?.[1];
  assert.ok(page, "the drafts tab renders the Task Drafts page");
  assert.match(page, /items=\{savedForLater\}/, "straight from the list App loaded, which no search or Mine ever touches");
  assert.match(page, /onOpen=\{newTask\.reopen\}/, "reopen as before");
  assert.match(page, /onDelete=\{newTask\.deleteDraft\}/, "delete as before");
  assert.match(block, /role="tabpanel" id=\{BOARD_PANEL_ID\} aria-labelledby=\{boardTabId\(boardTab\)\}/);
  assert.equal((APP_SOURCE.match(/<TaskDraftsPage\b/g) ?? []).length, 1, "mounted in one place");
});

test("Clear search sits beside the tabs only while All Tasks is open, and the header has no Show everyone link (#390)", () => {
  const block = boardBlock();
  assert.match(
    block,
    /boardTab === "all" && searchLoan && <LoanSearchStatus loan=\{searchLoan\} onClear=\{clearSearch\} \/>/,
    "the search narrows All Tasks, so its way back sits beside that tab alone"
  );
  const header = block.slice(block.indexOf(`<div className="section-head task-grid-head">`), block.indexOf(`role="tabpanel"`));
  assert.doesNotMatch(header, /Show everyone|Show all tasks|board-show-everyone" onClick/, "no Show link in the header on any tab");
  assert.doesNotMatch(APP_SOURCE, /Show everyone/, "the old wording is gone");
});

test("an empty My Tasks offers Show all tasks, which opens All Tasks", () => {
  const block = boardBlock();
  const empty = block.slice(block.indexOf(`body === "mine-empty"`), block.indexOf(`renderTaskList(boardTasks`));
  assert.match(empty, /Nothing of yours right now\./);
  assert.match(empty, /<button type="button" className="board-show-everyone" onClick=\{\(\) => selectBoardTab\("all"\)\}>\s*Show all tasks\s*<\/button>/);
});

test("the app menu has no Show group", () => {
  const menu = APP_SOURCE.slice(APP_SOURCE.indexOf("const AppMenu = ("), APP_SOURCE.indexOf("const NewTaskButton = ("));
  assert.doesNotMatch(menu, /Which tasks to show|BOARD_SHOW_CHOICES|onShowChange|>Show</);
  assert.doesNotMatch(boardBlock(), /onShowChange|show=\{boardShow\}/);
  for (const group of ["List view", "How far back finished tasks go", "Appearance"]) {
    assert.match(menu, new RegExp(`aria-label="${group}"`), `${group} stays`);
  }
  assert.match(menu, /Collapse All Tasks/);
});

test("the app menu reads Collapse All Tasks, then View, Appearance and History", () => {
  const menu = APP_SOURCE.slice(APP_SOURCE.indexOf("const AppMenu = ("), APP_SOURCE.indexOf("const NewTaskButton = ("));
  const at = ["Collapse All Tasks", 'aria-label="List view"', 'aria-label="Appearance"', 'aria-label="How far back finished tasks go"'].map((marker) => menu.indexOf(marker));
  assert.ok(at.every((i) => i >= 0), "every block is in the menu");
  assert.deepEqual([...at].sort((a, b) => a - b), at, "in the user's order");
});

test("picking a loan opens All Tasks and remembers the tab it came from, without touching the stored choice", () => {
  const block = boardBlock();
  const pick = block.match(/const pickLoan = \(loan: Loan\): void => \{([\s\S]*?)\};/)?.[1];
  assert.ok(pick, "one pick handler");
  assert.match(pick, /if \(!searchLoanId\) setSearchReturnTab\(boardTab\);\s*setSearchLoanId\(loan\.id\);\s*setBoardTab\("all"\);/);
  assert.doesNotMatch(pick, /selectBoardTab|setBoardShow/, "the stored All / My value is never changed by a pick");
  assert.match(block, /<LoanSearch loans=\{loans\} myLoanIds=\{searchMyLoanIds\} onPick=\{pickLoan\} \/>/);
});

test("clearing the search goes back to the remembered tab", () => {
  const block = boardBlock();
  assert.match(block, /const clearSearch = \(\): void => \{\s*setSearchLoanId\(null\);\s*selectBoardTab\(searchReturnTab\);\s*\};/);
});

test("opening a card ends the search from any tab, as it always has (the user's call on #390)", () => {
  assert.match(APP_SOURCE, /if \(open && searchLoanIdRef\.current\) setFocusTaskId\(taskId\);/);
  assert.doesNotMatch(APP_SOURCE, /boardTabRef/, "no tab condition on it");
});

test("a link to a task opens a task tab, All Tasks when My Tasks would hide it", () => {
  const focus = APP_SOURCE.slice(APP_SOURCE.indexOf("/* Deep-link focus:"));
  const body = focus.slice(0, focus.indexOf("}, [focusTaskId, tasks]);"));
  assert.match(body, /setActiveTab\("active"\);/);
  assert.match(
    body,
    /selectBoardTab\(tabForLink\(\{ from: searchLoanId \? searchReturnTab : boardTab, show: boardShow, onMineBoard: linked \? isOnMineBoard\(linked, user\) : true \}\)\);/,
    "it starts from the open tab, or mid-search from the tab clearing would return to, so both ways out of a search agree"
  );
  assert.doesNotMatch(body, /setBoardTab\(|setBoardShow\(/, "the tab and its stored half move together, through selectBoardTab");
});

test("a linked card is scrolled into the room under the pinned header, not centred behind it (#390)", () => {
  const scroll = APP_SOURCE.slice(APP_SOURCE.indexOf("const target = scrollTaskId;"), APP_SOURCE.indexOf("}, [scrollTaskId, searchLoanId]);"));
  assert.match(scroll, /pinnedScrollTop\(\{ cardTop: box\.top, cardHeight: box\.height, headerHeight, viewportHeight: window\.innerHeight, scrollY: window\.scrollY \}\)/);
  assert.match(scroll, /document\.querySelector<HTMLElement>\("\.task-grid-head"\)\?\.offsetHeight/, "measured from the header that is pinned");
  assert.doesNotMatch(scroll, /scrollIntoView/, "centring in the whole viewport is what hid a tall card's top");
});

test("leaving a form changes no tab: opening, saving for later, creating and discarding never touch it", () => {
  const createMount = APP_SOURCE.match(/\{newTaskOpen && \(\s*<TaskForm([\s\S]*?)\/>/)?.[1];
  assert.ok(createMount);
  assert.doesNotMatch(createMount, /setBoardTab|selectBoardTab/, "closing the form, however it ends, leaves the tab alone");
  assert.equal(
    (APP_SOURCE.match(/setBoardTab\(/g) ?? []).length,
    2,
    "selectBoardTab and a loan pick are the only writers of the open tab"
  );
  assert.equal(
    (APP_SOURCE.match(/selectBoardTab\(/g) ?? []).length,
    3,
    "besides the tab row, only clearing a search, a link and the empty My Tasks state choose a tab, so no ending of the form can"
  );
});
