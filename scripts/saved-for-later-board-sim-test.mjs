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

import { AUTOSAVE_MAX_AGE_MS, TASK_TYPE_LABELS } from "@loan-tasks/shared";
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
    `export { TaskDraftsPage, SavedForLaterDeleteConfirm, taskDraftsCount } from ${JSON.stringify(join(REPO, "apps/web/src/saved-for-later.tsx"))};\n` +
    `export { BoardTabs } from ${JSON.stringify(join(REPO, "apps/web/src/board-tabs.tsx"))};\n` +
    `export { draftKey, serializeDraft, DRAFT_MAX_AGE_MS } from ${JSON.stringify(join(REPO, "apps/web/src/create-form-draft.ts"))};\n` +
    `export { saveForLaterRequest, reopenSavedForLaterRequest, removeSavedForLaterRequest, keepUnsavedRequest, discardUnsavedRequest, unsavedAction, loadAutosaveRequest, keepAutosaveRequest, forgetAutosaveRequest } from ${JSON.stringify(join(REPO, "apps/web/src/saved-for-later-requests.ts"))};\n`
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
  draftKey,
  serializeDraft,
  DRAFT_MAX_AGE_MS,
  saveForLaterRequest,
  reopenSavedForLaterRequest,
  removeSavedForLaterRequest,
  keepUnsavedRequest,
  discardUnsavedRequest,
  unsavedAction,
  loadAutosaveRequest,
  keepAutosaveRequest,
  forgetAutosaveRequest
} = await import(pathToFileURL(bundle).href);
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
  assert.match(handler, /saveForLaterRequest\(/, "the save itself is the request helper's, driven below against a fake server");
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

test("confirming removes it from the server, then from the section; a failure says so and leaves the row", () => {
  const handler = APP_SOURCE.match(/const deleteSavedForLater = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\);/)?.[0];
  assert.ok(handler, "App has a deleteSavedForLater handler");
  const removing = handler.indexOf("removeSavedForLaterRequest(savedForLaterRequestFor(user), item.id)");
  const refused = handler.indexOf("if (!removed)");
  const toasting = handler.indexOf("showToast(");
  const dropping = handler.indexOf("setSavedForLater(");
  assert.ok(removing >= 0, "it asks the server through the one removal helper");
  assert.ok(refused > removing && toasting > refused && dropping > toasting, "a refusal toasts and returns before the row is dropped");
  assert.match(handler, /return false;\s*\}\s*setSavedForLater\(\(current\) => current\.filter\(\(saved\) => saved\.id !== item\.id\)\);\s*return true;/);
  assert.match(handler, /if \(user\.id !== savedForLaterOwner\.current\) return false;/, "an answer for the previous person is dropped");
});

test("a row with no loan typed says No loan yet", () => {
  const html = renderSection([item("a", 5, { folderName: "   " })]);
  assert.match(html, /<span class="saved-row-name">No loan yet<\/span>/);
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
  assert.equal(DRAFT_MAX_AGE_MS, AUTOSAVE_MAX_AGE_MS);
});

test("tapping the Autosaved row opens New Task exactly as the New Task button does, on the latest autosave", () => {
  assert.match(APP_SOURCE, /<TaskDraftsPage[^>]*onOpenAutosave=\{openNewTask\}/);
  assert.match(APP_SOURCE, /<NewTaskButton open=\{formOpen\} onClick=\{[^}]*openNewTask\(\)/, "the button takes the same way in");
  const opener = APP_SOURCE.match(/const openNewTask = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\);/)?.[0];
  assert.ok(opener, "App has an openNewTask");
  assert.ok(opener.indexOf("setReopened(null)") >= 0, "a New Task, not a reopened record");
  assert.ok(opener.indexOf("await loadAutosave()") > opener.indexOf("setReopened(null)"), "asks the server for the latest autosave first");
  assert.ok(
    opener.indexOf("if (formOpenNow.current) return;") > opener.indexOf("await loadAutosave()") &&
      opener.indexOf("setFormOpen(true)") > opener.indexOf("if (formOpenNow.current) return;"),
    "and leaves a form opened meanwhile alone"
  );
  const createMount = APP_SOURCE.match(/\{formOpen && \(\s*<TaskForm([\s\S]*?)\/>/)?.[1];
  assert.match(createMount, /\{\.\.\.\(reopened \? \{ reopened \} : \{ autosave \}\)\}/, "a New Task gets the autosave; a reopened record never does");
  assert.match(createMount, /onKeepAutosave=\{onKeepAutosave\}/);
  assert.match(createMount, /onForgetAutosave=\{onForgetAutosave\}/);
});

test("App loads the autosave with the drafts, empties it on every identity change, and merges this browser's offline copy", () => {
  const identity = APP_SOURCE.slice(APP_SOURCE.indexOf("savedForLaterOwner.current = user.id;"));
  const block = identity.slice(0, identity.indexOf("}, [user.id]);"));
  assert.ok(block.indexOf("setAutosave(null)") >= 0 && block.indexOf("setAutosave(null)") < block.indexOf("if (!user.id) return;"), "emptied before anything loads");
  assert.match(block, /loadAutosave\(\)/, "and loaded with the drafts");
  const loader = APP_SOURCE.match(/const loadAutosave = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\);/)?.[0];
  assert.ok(loader, "App has a loadAutosave");
  assert.match(loader, /loadAutosaveRequest\(/);
  assert.match(loader, /if \(user\.id !== savedForLaterOwner\.current\) return;/, "an answer for the previous person is dropped");
  assert.match(loader, /readDraftCopy\(browserDraftStorage\(\), user\.id\)/, "this browser's offline copy is weighed too");
  assert.match(loader, /newerAutosave\(/);
});

test("App's autosave callbacks are silent: typing never toasts or re-renders the board", () => {
  const keep = APP_SOURCE.match(/const onKeepAutosave = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\);/)?.[0];
  assert.match(keep, /keepAutosaveRequest\(/);
  assert.doesNotMatch(keep, /showToast|setAutosave|setSavedForLater/);
  const forget = APP_SOURCE.match(/const onForgetAutosave = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\);/)?.[0];
  assert.match(forget, /forgetAutosaveRequest\(/);
  assert.match(forget, /setAutosave\(null\)/, "a form that ended takes the row with it");
  assert.doesNotMatch(forget, /showToast/);
});

test("deleting the Autosaved row forgets it on the server and in this browser; a failure says so and keeps the row", () => {
  const handler = APP_SOURCE.match(/const deleteAutosave = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\);/)?.[0];
  assert.ok(handler, "App has a deleteAutosave");
  assert.match(handler, /forgetAutosaveRequest\(/);
  assert.match(handler, /if \(user\.id !== savedForLaterOwner\.current\) return false;/);
  const refused = handler.indexOf("if (!removed)");
  const toast = handler.indexOf("showToast(");
  const local = handler.indexOf("clearDraft(browserDraftStorage(), user.id)");
  const dropped = handler.indexOf("setAutosave(null)");
  assert.ok(refused >= 0 && toast > refused && local > toast && dropped > toast, "refused: toast and keep; otherwise both copies go");
  assert.match(APP_SOURCE, /<TaskDraftsPage[^>]*onDeleteAutosave=\{deleteAutosave\}/);
});

test("saving a new form for later leaves one draft and no Autosaved row", () => {
  const handler = APP_SOURCE.match(/const onSaveForLater = async \([\s\S]*?\n  \};/)?.[0];
  assert.match(handler, /if \(!savedId\) setAutosave\(null\);/, "the row goes the moment the draft appears; the server cleared it in the same write");
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

test("a reopened Saved for Later task opens the create form with every field restored", () => {
  const html = renderForm({ reopened: reopened(FULL_FORM), directory: DIRECTORY });
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

  const assign = renderForm({ reopened: reopened({ ...FULL_FORM, taskType: "VALUE", pickerMode: "assign" }), directory: DIRECTORY });
  assert.match(assign, /aria-pressed="true">Assign/, "share or assign");

  const ooo = renderForm({
    reopened: reopened({ ...FULL_FORM, taskType: "OOO", folderName: "Beach week", startDate: "2026-09-20", returnDate: "2026-09-27" })
  });
  assert.match(ooo, /value="2026-09-20"/, "start date");
  assert.match(ooo, /value="2026-09-27"/, "return date");
});

test("every field the form holds is one the reopen test above restores", async () => {
  const { draftFieldNames } = await import(pathToFileURL(join(REPO, "apps/web/src/create-form-draft.ts")).href);
  assert.deepEqual(Object.keys(FULL_FORM).sort(), draftFieldNames().sort());
});

test("a reopened form keeps the Save for later button, pressable straight away, and says nothing about the autosave", () => {
  // Someone else's typing in the autosave must not leak into, or replace, the
  // record they asked to reopen.
  storage.set(draftKey(USER.id), serializeDraft({ ...FORM, notes: "an unrelated autosave" }, Date.now()));
  const html = renderForm({ reopened: reopened(FULL_FORM), directory: DIRECTORY });
  const [, disabled] = html.match(FOOT_ORDER);
  assert.equal(disabled, undefined, "saving it again needs no further typing");
  assert.doesNotMatch(html, /an unrelated autosave/);
  assert.doesNotMatch(html, /Start fresh/);
  assert.match(html, />Create Task<\/button>/);
});

test("a reopened form never reads or writes the autosave, and knows which record it came from", () => {
  assert.match(
    FORM_SOURCE,
    /storage: edit \|\| reopened \? null : browserDraftStorage\(\)/,
    "no storage seat, the way edit mode has none, so no ending can clear or overwrite an unrelated autosave"
  );
  const body = FORM_SOURCE.match(/const saveForLater = async \(\): Promise<void> => \{([\s\S]*?)\n  \};/)?.[1];
  assert.match(body, /await onSaveForLater\(values, reopened\?\.id\)/, "Save for later names the record, so App updates it");
  const submit = FORM_SOURCE.match(/const handleSubmit = async \([\s\S]*?\n  \};/)?.[0];
  assert.match(submit, /reopened\?\.id\s*\)/, "Create names the record, so App can clear it once the task exists");
  assert.equal(
    (submit.match(/const payload: CreateTaskInput = \{/g) ?? []).length,
    1,
    "one payload for every create form: a reopened one is filed exactly as a new one, loan resolution included"
  );
});

test("App opens the create form on the reopened record, one mount per record", () => {
  const createMount = APP_SOURCE.match(/\{formOpen && \(\s*<TaskForm([\s\S]*?)\/>/)?.[1];
  assert.match(createMount, /key=\{reopened\?\.id \?\? "new"\}/, "a different record remounts the form");
  assert.match(createMount, /\{\.\.\.\(reopened \? \{ reopened \} : \{ autosave \}\)\}/, "and hands it the record, when there is one");
  const opener = APP_SOURCE.match(/const openSavedForLater = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\);/)?.[0];
  assert.ok(opener, "App has an openSavedForLater handler");
  assert.match(opener, /reopenSavedForLaterRequest\(/, "it fetches the latest save before opening");
  assert.ok(
    opener.indexOf("if (formOpenNow.current) return;") >= 0 &&
      opener.indexOf("if (formOpenNow.current) return;") < opener.indexOf("setReopened(latest)"),
    "a form opened while the fetch was out is left alone when it lands"
  );
});

/* ── Abandoned typing on a reopened form (#348) ─────────── */

test("a reopened record carrying unsaved typing opens on that typing, not on the earlier save", () => {
  const html = renderForm({
    reopened: reopened(FULL_FORM, { unsaved: { ...FULL_FORM, notes: "typed after the save, tab closed" } }),
    directory: DIRECTORY
  });
  assert.match(html, />typed after the save, tab closed<\/textarea>/, "the typing comes back");
  assert.doesNotMatch(html, /Borrower ID does not match/, "rather than the version it was saved at");
  assert.doesNotMatch(html, /role="alertdialog"/, "and nothing is asked on the way in");
});

test("typing on a reopened form is sent to that record as it is typed, never to the browser autosave", () => {
  const effect = FORM_SOURCE.slice(FORM_SOURCE.indexOf("── Keeping unsaved typing on its record (#348)"));
  const body = effect.slice(0, effect.indexOf("}, [form,"));
  assert.ok(body.length > 0, "the form has an effect for it");
  assert.match(body, /if \(!reopened\) return;/, "reopened forms only; a fresh form keeps the autosave as it was");
  assert.match(body, /window\.setTimeout\(sendUnsaved, UNSAVED_SAVE_DEBOUNCE_MS\)/, "on a trailing debounce, like the autosave");
  assert.match(body, /if \(!reopened \|\| ending\.current\) return;/, "and never after an ending has begun");
  assert.match(body, /differsFromSave: formHasChanges\(reopened\.form, values\)/, "worth keeping means different from what was saved");
  assert.match(
    body,
    /differsFromSent: sent !== null && formHasChanges\(sent, values\)/,
    "measured against what was last sent, not what the form opened on"
  );
  assert.match(body, /sentExists: sent !== null/);
  assert.match(body, /onKeepUnsaved\(reopened\.id, values\)/, "written onto that record");
  assert.match(body, /onDiscardUnsaved\(reopened\.id\)/, "and cleared when the form is typed back to what was saved");
  assert.doesNotMatch(body, /writeDraft|clearDraft|draftSeat/, "the browser autosave is not touched");
  assert.match(
    FORM_SOURCE,
    /storage: edit \|\| reopened \? null : browserDraftStorage\(\)/,
    "and still has no seat, so the next New Task can never be offered this typing"
  );
});

test("the writes go out one at a time, and every ending waits for them before it acts", () => {
  assert.match(FORM_SOURCE, /const unsavedWrites = useRef<Promise<unknown>>\(Promise\.resolve\(\)\)/, "one queue per form");
  assert.match(FORM_SOURCE, /unsavedWrites\.current = unsavedWrites\.current\s*\.then\(/, "each write chains on the last");
  const settle = FORM_SOURCE.slice(FORM_SOURCE.indexOf("const settleUnsaved"));
  const settleBody = settle.slice(0, settle.indexOf("\n  };"));
  assert.match(settleBody, /ending\.current = true;/, "an ending stops further writes");
  assert.match(settleBody, /await unsavedWrites\.current;/, "and lets the one in flight land first");
  for (const [name, call] of [
    ["const saveForLater", "await onSaveForLater("],
    ["const handleSubmit", "await onCreate("],
    ["const confirmDiscard", "onClose();"]
  ]) {
    const fn = FORM_SOURCE.slice(FORM_SOURCE.indexOf(name));
    const fnBody = fn.slice(0, fn.indexOf("\n  };"));
    assert.ok(fnBody.indexOf("await settleUnsaved()") >= 0, `${name} settles the writes`);
    assert.ok(fnBody.indexOf("await settleUnsaved()") < fnBody.indexOf(call), `${name} settles them before it acts`);
  }
  for (const name of ["const saveForLater", "const handleSubmit"]) {
    const fn = FORM_SOURCE.slice(FORM_SOURCE.indexOf(name));
    const failed = fn.slice(fn.indexOf("} catch {") + "} catch {".length);
    assert.match(
      failed.slice(0, failed.indexOf("}")),
      /ending\.current = false;\s*sendUnsaved\(\);/,
      `${name}: a failure leaves the form open, keeping typing again, and sends what the stop held back`
    );
  }
});

test("what a reopened form sends is decided against its last send, as a truth table", () => {
  const cases = [
    [{ differsFromSave: false, differsFromSent: false, sentExists: false }, "keep", "the save, nothing sent: nothing to do"],
    [{ differsFromSave: false, differsFromSent: true, sentExists: true }, "clear", "typed back to the save after a send: clear it"],
    [{ differsFromSave: true, differsFromSent: false, sentExists: false }, "write", "new typing, nothing sent yet"],
    [{ differsFromSave: true, differsFromSent: true, sentExists: true }, "write", "more typing since the last send"],
    [{ differsFromSave: true, differsFromSent: false, sentExists: true }, "keep", "exactly what was last sent, including typing it opened on"]
  ];
  for (const [state, expected, why] of cases) assert.equal(unsavedAction(state), expected, why);
});

test("App sends a reopened form's typing to its record, and a Discard that did not land is said out loud", () => {
  const createMount = APP_SOURCE.match(/\{formOpen && \(\s*<TaskForm([\s\S]*?)\/>/)?.[1];
  assert.match(createMount, /onKeepUnsaved=\{onKeepUnsaved\}/);
  assert.match(createMount, /onDiscardUnsaved=\{onDiscardUnsaved\}/);
  const keep = APP_SOURCE.match(/const onKeepUnsaved = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\);/)?.[0];
  assert.match(keep, /keepUnsavedRequest\(/);
  assert.doesNotMatch(keep, /showToast|setSavedForLater/, "silent, and the board does not re-render as somebody types");
  const discard = APP_SOURCE.match(/const onDiscardUnsaved = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\);/)?.[0];
  assert.match(discard, /discardUnsavedRequest\(/);
  assert.doesNotMatch(discard, /showToast/, "silent in App, since a form typed back to its save uses it too");
  const confirm = FORM_SOURCE.slice(FORM_SOURCE.indexOf("const confirmDiscard"));
  assert.match(confirm.slice(0, confirm.indexOf("\n  };")), /showToast\(/, "the Discard itself says when it did not land");
});

test("Create clears the Saved for Later task only after the task was filed", () => {
  const handler = APP_SOURCE.match(/const onCreate = async \([\s\S]*?\n  \};/)?.[0];
  assert.ok(handler);
  const filing = handler.indexOf(`"/tasks", { method: "POST"`);
  const failedFiling = handler.indexOf("throw err;");
  const clearing = handler.indexOf("removeSavedForLaterRequest(");
  assert.ok(filing >= 0 && failedFiling > filing, "a failed filing rethrows");
  assert.ok(clearing > failedFiling, "and so never reaches the clear");
});

test("saving a reopened one again goes through the one request helper", () => {
  const handler = APP_SOURCE.match(/const onSaveForLater = async \([\s\S]*?\n  \};/)?.[0];
  assert.match(handler, /saveForLaterRequest\(/);
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
  assert.equal(await keepAutosaveRequest(ok.request, { ...FULL_FORM, notes: "typed" }), true);
  assert.deepEqual(ok.calls, ["PUT /autosave"]);
  assert.equal(await keepAutosaveRequest(fakeServer({ "PUT /autosave": new Error("offline") }).request, FULL_FORM), false);
  assert.equal(await keepAutosaveRequest(fakeServer({ "PUT /autosave": httpError(500) }).request, FULL_FORM), false);
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
  assert.match(APP_SOURCE, /renderTaskList\(allTasksAdmin, "No tasks yet\."\)/, "and admin All Tasks the same");
  assert.equal((APP_SOURCE.match(/<SavedForLaterSection\b/g) ?? []).length, 0, "the old section is gone");
  assert.doesNotMatch(SECTION_SOURCE, /export const SavedForLaterSection\b/);
});

/* ── The tab row (#363) ─────────────────────────────────── */

const renderTabs = (props) =>
  renderToStaticMarkup(
    createElement(BoardTabs, { tab: "tasks", onTabChange: () => {}, tasksLabel: "Tasks", tasksCount: 13, draftsCount: 2, ...props })
  );
const tabButtons = (html) => [...html.matchAll(/<button [^>]*role="tab"[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[0]);

test("the header's tab row is Tasks then Task Drafts, each with its count", () => {
  const html = renderTabs();
  assert.match(html, /^<div class="board-tabs" role="tablist" aria-label="Board">/);
  const [tasks, drafts, extra] = tabButtons(html);
  assert.equal(extra, undefined, "two tabs");
  assert.match(tasks, /<span class="board-tab-label">Tasks<\/span><span class="section-count">13<\/span><\/button>$/);
  assert.match(drafts, /<span class="board-tab-label">Task Drafts<\/span><span class="section-count">2<\/span><\/button>$/);
});

test("the selected tab is the one announced and the one Tab lands on", () => {
  const [tasks, drafts] = tabButtons(renderTabs({ tab: "tasks" }));
  assert.match(tasks, /id="board-tab-tasks"/);
  assert.match(tasks, /aria-selected="true"/);
  assert.match(tasks, /tabindex="0"/);
  assert.match(tasks, /class="tab-btn board-tab tab-active"/, "the app's one tab rule, with a modifier for the heading's type");
  assert.match(tasks, /aria-controls="board-panel"/, "the selected tab names the panel below it");
  assert.match(drafts, /aria-selected="false"/);
  assert.match(drafts, /tabindex="-1"/);
  assert.match(drafts, /class="tab-btn board-tab"/);
  assert.doesNotMatch(drafts, /aria-controls/, "the panel it would name is not on the page");

  const [tasks2, drafts2] = tabButtons(renderTabs({ tab: "drafts" }));
  assert.match(tasks2, /aria-selected="false"/);
  assert.match(drafts2, /id="board-tab-drafts"/);
  assert.match(drafts2, /aria-selected="true"[\s\S]*tabindex="0"/);
});

test("with no drafts the Task Drafts tab is still there, counting none", () => {
  const [, drafts] = tabButtons(renderTabs({ draftsCount: 0 }));
  assert.match(drafts, /Task Drafts<\/span><span class="section-count">0<\/span>/);
});

test("the Tasks tab carries whatever names the board, a searched loan's full name on hover", () => {
  const [mine] = tabButtons(renderTabs({ tasksLabel: "My tasks", tasksCount: 4 }));
  assert.match(mine, /<span class="board-tab-label">My tasks<\/span><span class="section-count">4<\/span>/);
  const [loan] = tabButtons(renderTabs({ tasksLabel: "Castillo - Harbor View", tasksTitle: "Castillo - Harbor View", tasksCount: 2 }));
  assert.match(loan, /<span class="board-tab-label" title="Castillo - Harbor View">Castillo - Harbor View<\/span>/);
});

test("pressing a tab, or an arrow key across the row, selects it", () => {
  const TABS_SOURCE = readFileSync(join(REPO, "apps/web/src/board-tabs.tsx"), "utf8");
  assert.match(TABS_SOURCE, /onClick=\{\(\) => onTabChange\(value\)\}/);
  for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
    assert.match(TABS_SOURCE, new RegExp(`"${key}"`), `${key} moves along the row`);
  }
  assert.match(TABS_SOURCE, /\.focus\(\)/, "and focus follows the selection");
});

test("App holds the tab in plain state that opens on Tasks and is never stored", () => {
  assert.match(APP_SOURCE, /const \[boardTab, setBoardTab\] = useState<BoardTab>\("tasks"\);/);
  const storing = APP_SOURCE.split("\n").filter((line) => /boardTab|BoardTab/.test(line) && /localStorage|Storage|persist/i.test(line));
  assert.deepEqual(storing, [], "no line both names the tab and stores anything");
});

const boardBlock = () => {
  const start = APP_SOURCE.indexOf(`{activeTab === "active" && (() => {`);
  const end = APP_SOURCE.indexOf(`{activeTab === "all" && isAdmin && (`);
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
  assert.match(tabsProps, /tasksCount=\{boardTasks\.length\}/, "the Tasks count is the board's own, as the heading's was");
  assert.equal((APP_SOURCE.match(/<BoardTabs\b/g) ?? []).length, 1, "admin All Tasks has no tab row");
});

test("switching tabs swaps the body: the Task Drafts page lists every draft, never narrowed by Mine or the search", () => {
  const block = boardBlock();
  assert.match(block, /boardBody\(\{ tab: boardTab, searching: Boolean\(searchLoan\), mine, shownCount: boardTasks\.length \}\)/);
  const page = block.match(/<TaskDraftsPage([\s\S]*?)\/>/)?.[1];
  assert.ok(page, "the drafts tab renders the Task Drafts page");
  assert.match(page, /items=\{savedForLater\}/, "straight from the list App loaded, which no search or Mine ever touches");
  assert.match(page, /onOpen=\{openSavedForLater\}/, "reopen as before");
  assert.match(page, /onDelete=\{deleteSavedForLater\}/, "delete as before");
  assert.match(block, /role="tabpanel" id=\{BOARD_PANEL_ID\} aria-labelledby=\{boardTabId\(boardTab\)\}/);
  assert.equal((APP_SOURCE.match(/<TaskDraftsPage\b/g) ?? []).length, 1, "mounted in one place");
});

test("search and Mine controls beside the tabs belong to the Tasks tab", () => {
  const block = boardBlock();
  assert.match(
    block,
    /boardTab === "tasks" && \(searchLoan \? <LoanSearchStatus loan=\{searchLoan\} onClear=\{clearSearch\} \/> : mine && showEveryone\)/,
    "Clear search and Show everyone describe the task list, so they only sit beside it"
  );
});

test("picking a loan to search shows the Tasks tab, since that is the list a search narrows", () => {
  const block = boardBlock();
  assert.match(block, /onPick=\{\(loan\) => \{ setSearchLoanId\(loan\.id\); setBoardTab\("tasks"\); \}\}/);
});

test("a link to a task shows the Tasks tab, so the card it opens is on the page", () => {
  const focus = APP_SOURCE.slice(APP_SOURCE.indexOf("/* Deep-link focus:"));
  const body = focus.slice(0, focus.indexOf("}, [focusTaskId, tasks]);"));
  assert.match(body, /setActiveTab\("active"\);\s*setBoardTab\("tasks"\);/);
});

test("leaving a form changes no tab: opening, saving for later, creating and discarding never touch it", () => {
  const createMount = APP_SOURCE.match(/\{formOpen && \(\s*<TaskForm([\s\S]*?)\/>/)?.[1];
  assert.doesNotMatch(createMount, /setBoardTab/, "closing the form, however it ends, leaves the tab alone");
  assert.equal(
    (APP_SOURCE.match(/setBoardTab\(/g) ?? []).length,
    2,
    "a loan pick and a link are the only things besides the tab row itself that switch tabs, so no ending of the form can"
  );
});
