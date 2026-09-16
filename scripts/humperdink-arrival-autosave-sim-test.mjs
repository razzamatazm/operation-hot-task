#!/usr/bin/env node
/* Arriving from Humperdink never costs someone their unfinished new task (#413).

   Each person has one autosave slot for an unfinished new task form (ADR-0011
   rule 5), and typing into any new task form writes over it. A Humperdink
   arrival opens a new LOI Check about a different loan, so an autosave worth
   keeping is first turned into a Saved for Later task, through the same write
   Save for later uses, which clears the slot in that write. The LOI Check never
   opens on it.

   If that move fails, the old autosave must survive whatever the new form is
   typed into. Built as: the arrival's form opens with no seat on the autosave
   at all, neither the server's slot nor this browser's offline copy, so no
   keystroke, Save for later, Create or Discard on it can write or clear either.
   Silently: nothing is toasted.

   Three techniques, the arrangement the other form tests use:

   1. DRIVEN. The move (`moveAutosaveAside`) is framework-free and handed its
      request function and storage, so it runs against a fake server that keeps
      state the way the real routes do.
   2. RENDERED. The form and the Task Drafts page, through `react-dom/server`.
   3. READ OUT OF THE SOURCE. Effects don't run in a static render, so App's
      wiring and the form's seat are asserted against the source.

   Run: `node --test scripts/humperdink-arrival-autosave-sim-test.mjs`. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const APP_SOURCE = readFileSync(join(REPO, "apps/web/src/App.tsx"), "utf8");
const FORM_SOURCE = readFileSync(join(REPO, "apps/web/src/task-form.tsx"), "utf8");
const MOVE_SOURCE = readFileSync(join(REPO, "apps/web/src/humperdink-arrival.ts"), "utf8");

const scratch = mkdtempSync(join(REPO, "node_modules", ".humperdink-arrival-autosave-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const entry = join(scratch, "entry.tsx");
const src = (file) => JSON.stringify(join(REPO, "apps/web/src", file));
writeFileSync(
  entry,
  `export { moveAutosaveAside } from ${src("humperdink-arrival.ts")};\n` +
    `export { TaskForm } from ${src("task-form.tsx")};\n` +
    `export { ToastProvider } from ${src("toast.tsx")};\n` +
    `export { TaskDraftsPage, taskDraftsCount } from ${src("saved-for-later.tsx")};\n` +
    `export { draftKey, serializeDraft } from ${src("create-form-draft.ts")};\n` +
    `export { saveForLaterRequest, keepAutosaveRequest } from ${src("saved-for-later-requests.ts")};\n`
);
const bundle = join(scratch, "bundle.mjs");
await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  external: ["react", "react/jsx-runtime", "@loan-tasks/shared"],
  logLevel: "silent"
});
const { moveAutosaveAside, TaskForm, ToastProvider, TaskDraftsPage, taskDraftsCount, draftKey, serializeDraft, saveForLaterRequest, keepAutosaveRequest } =
  await import(pathToFileURL(bundle).href);

const USER = { id: "user-1", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] };
const NOW = Date.parse("2026-09-13T12:00:00.000Z");
const minutesAgo = (m) => NOW - m * 60000;

const BLANK = {
  folderName: "",
  loanId: "",
  taskType: "LOI",
  urgency: "GREEN",
  startDate: "",
  returnDate: "",
  notes: "",
  humperdinkLink: "",
  points: 0,
  initialItems: [],
  pickerMode: "share",
  recipientUserId: "",
  recipientNote: ""
};
const OLD_TASK = { ...BLANK, folderName: "Castillo - Ridge", taskType: "FRAUD", urgency: "RED", notes: "half written", points: 2, initialItems: ["No W-2"] };
const NEW_TYPING = { ...BLANK, folderName: "Alvarez - Bayview", notes: "Rate 6.5%" };

/* Browser storage, as three methods over a Map. */
const memoryStorage = () => {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key)
  };
};

const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

/* The autosave and Saved for Later routes, keeping state the way the store
   does: POST with `clearAutosave` makes the record and empties the slot in the
   one write. */
const modelServer = ({ autosave = null, failSave = false, unreachable = false, hangSave = false } = {}) => {
  const state = { autosave, items: [], calls: [] };
  const request = async (path, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.calls.push({ call: `${init.method} ${path}`, body });
    if (unreachable) throw new Error("offline");
    switch (`${init.method} ${path}`) {
      case "GET /autosave":
        return { item: state.autosave };
      case "PUT /autosave":
        state.autosave = { ownerId: USER.id, savedAt: new Date(NOW).toISOString(), form: body.form };
        return { item: state.autosave };
      case "POST /saved-for-later": {
        if (hangSave) return new Promise(() => {});
        if (failSave) throw httpError(500);
        const item = { id: `saved-${state.items.length + 1}`, ownerId: USER.id, savedAt: new Date(NOW).toISOString(), form: body.form };
        state.items.unshift(item);
        if (body.clearAutosave === true) state.autosave = null;
        return { item };
      }
      default:
        throw httpError(404);
    }
  };
  return { state, request };
};

const serverAutosave = (form, at = minutesAgo(30)) => ({ ownerId: USER.id, savedAt: new Date(at).toISOString(), form });
const move = (server, storage, options = {}) => moveAutosaveAside(server.request, storage, USER.id, { now: NOW, ...options });

/* ── The move ───────────────────────────────────────────── */

test("an autosave worth keeping becomes a Saved for Later task with the same values, through Save for later's one write", async () => {
  const server = modelServer({ autosave: serverAutosave(OLD_TASK) });
  const outcome = await move(server, memoryStorage());
  assert.equal(outcome.kind, "moved");
  assert.deepEqual(outcome.saved.form, OLD_TASK, "every field, as it was");
  assert.deepEqual(server.state.items.map((item) => item.form), [OLD_TASK]);
  assert.equal(server.state.autosave, null, "the slot is cleared in that same write");
  assert.deepEqual(
    server.state.calls.map((c) => c.call),
    ["GET /autosave", "POST /saved-for-later"],
    "the existing Save for later route, and no separate clear"
  );
  assert.equal(server.state.calls[1].body.clearAutosave, true);
});

test("afterwards the Task Drafts tab lists it once, as a Task Draft and not also as Autosaved", async () => {
  const server = modelServer({ autosave: serverAutosave(OLD_TASK) });
  await move(server, memoryStorage());
  const html = renderToStaticMarkup(
    createElement(TaskDraftsPage, { items: server.state.items, autosave: server.state.autosave, now: NOW, onOpen: () => {}, onDelete: async () => true })
  );
  assert.equal(html.match(/class="saved-row-open"/g)?.length, 1, "one row");
  assert.match(html, /<span class="saved-row-name">Castillo - Ridge<\/span>/);
  assert.doesNotMatch(html, /Autosaved/);
  assert.equal(taskDraftsCount(server.state.items, server.state.autosave, NOW), 1);
});

test("after the move, the autosave slot holds only the new LOI Check's typing", async () => {
  const server = modelServer({ autosave: serverAutosave(OLD_TASK) });
  await move(server, memoryStorage());
  // The new form's first write lands on an empty slot.
  assert.equal(await keepAutosaveRequest(server.request, NEW_TYPING), true);
  assert.deepEqual(server.state.autosave.form, NEW_TYPING);
  assert.deepEqual(server.state.items[0].form, OLD_TASK, "and the old task is untouched on Task Drafts");
});

test("a changed task type on its own is typing worth keeping, the autosave's own yardstick", async () => {
  const server = modelServer({ autosave: serverAutosave({ ...BLANK, taskType: "VALUE" }) });
  assert.equal((await move(server, memoryStorage())).kind, "moved");
});

test("with no autosave, an arrival creates no Saved for Later task", async () => {
  const server = modelServer();
  assert.deepEqual(await move(server, memoryStorage()), { kind: "none" });
  assert.deepEqual(server.state.items, []);
  assert.deepEqual(server.state.calls.map((c) => c.call), ["GET /autosave"]);
});

test("with an empty autosave, or one past its seven days, an arrival creates no Saved for Later task", async () => {
  for (const autosave of [serverAutosave(BLANK), serverAutosave(OLD_TASK, NOW - 8 * 24 * 60 * 60 * 1000)]) {
    const server = modelServer({ autosave });
    const storage = memoryStorage();
    storage.setItem(draftKey(USER.id), serializeDraft(BLANK, minutesAgo(1)));
    assert.deepEqual(await move(server, storage), { kind: "none" });
    assert.deepEqual(server.state.items, []);
    assert.ok(!server.state.calls.some((c) => c.call === "POST /saved-for-later"));
  }
});

test("a browser-only offline copy newer than the server's is the one that gets moved, and both copies are gone after", async () => {
  const offlineTyping = { ...OLD_TASK, notes: "typed while the server was down" };
  const server = modelServer({ autosave: serverAutosave(OLD_TASK, minutesAgo(30)) });
  const storage = memoryStorage();
  storage.setItem(draftKey(USER.id), serializeDraft(offlineTyping, minutesAgo(2)));
  const outcome = await move(server, storage);
  assert.equal(outcome.kind, "moved");
  assert.deepEqual(server.state.calls[1].body.form, offlineTyping, "the typing the server never got");
  assert.equal(server.state.autosave, null);
  assert.equal(storage.getItem(draftKey(USER.id)), null, "the offline copy can't come back as an Autosaved row");
});

test("an offline copy with nothing on the server is moved too", async () => {
  const server = modelServer();
  const storage = memoryStorage();
  storage.setItem(draftKey(USER.id), serializeDraft(OLD_TASK, minutesAgo(2)));
  assert.equal((await move(server, storage)).kind, "moved");
  assert.deepEqual(server.state.items[0].form, OLD_TASK);
  assert.equal(storage.getItem(draftKey(USER.id)), null);
});

test("an offline copy older than the server's loses to it, the way New Task weighs them", async () => {
  const server = modelServer({ autosave: serverAutosave(OLD_TASK, minutesAgo(2)) });
  const storage = memoryStorage();
  storage.setItem(draftKey(USER.id), serializeDraft({ ...OLD_TASK, notes: "older" }, minutesAgo(30)));
  await move(server, storage);
  assert.deepEqual(server.state.items[0].form, OLD_TASK);
  assert.equal(storage.getItem(draftKey(USER.id)), null);
});

/* ── When the move fails ────────────────────────────────── */

test("a failed move holds the seat and leaves the old autosave where it was, on the server and in this browser", async () => {
  const server = modelServer({ autosave: serverAutosave(OLD_TASK, minutesAgo(30)), failSave: true });
  const storage = memoryStorage();
  const offline = serializeDraft({ ...OLD_TASK, notes: "newer, offline" }, minutesAgo(2));
  storage.setItem(draftKey(USER.id), offline);
  assert.deepEqual(await move(server, storage), { kind: "held" });
  assert.deepEqual(server.state.autosave.form, OLD_TASK);
  assert.equal(storage.getItem(draftKey(USER.id)), offline);
  assert.deepEqual(server.state.items, []);
});

test("a server that can't be asked holds the seat and posts nothing, since there may be an autosave out there", async () => {
  const server = modelServer({ unreachable: true });
  assert.deepEqual(await move(server, memoryStorage()), { kind: "held" });
  assert.deepEqual(server.state.calls.map((c) => c.call), ["GET /autosave"]);
});

test("a save that doesn't answer in time holds the seat rather than holding the form shut", async () => {
  const server = modelServer({ autosave: serverAutosave(OLD_TASK), hangSave: true });
  const storage = memoryStorage();
  storage.setItem(draftKey(USER.id), serializeDraft(OLD_TASK, minutesAgo(40)));
  assert.deepEqual(await move(server, storage, { timeoutMs: 20 }), { kind: "held" });
  assert.notEqual(storage.getItem(draftKey(USER.id)), null, "nothing is cleared on a save nobody saw land");
});

test("a save that lands after the arrival gave up on it takes the offline copy with it, so the task isn't listed twice", async () => {
  let land;
  const landed = new Promise((resolve) => (land = resolve));
  const server = modelServer({ autosave: serverAutosave(OLD_TASK, minutesAgo(40)) });
  const slow = async (path, init) => {
    if (init.method === "POST") await landed;
    return server.request(path, init);
  };
  const storage = memoryStorage();
  storage.setItem(draftKey(USER.id), serializeDraft(OLD_TASK, minutesAgo(30)));
  assert.deepEqual(await moveAutosaveAside(slow, storage, USER.id, { now: NOW, timeoutMs: 20 }), { kind: "held" });
  assert.notEqual(storage.getItem(draftKey(USER.id)), null);
  land();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(server.state.items[0].form, OLD_TASK);
  assert.equal(server.state.autosave, null);
  assert.equal(storage.getItem(draftKey(USER.id)), null);
});

test("New Task pressed while the move is out waits for it, so it can't open on an autosave the move is about to clear", () => {
  const openNewTask = APP_SOURCE.match(/const openNewTask = useCallback\(async \(\): Promise<void> => \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(openNewTask.indexOf("await arrivalMove.current") >= 0 && openNewTask.indexOf("await arrivalMove.current") < openNewTask.indexOf("await loadAutosave()"));
  assert.match(arrivalEffect(), /arrivalMove\.current = /);
});

test("the move never toasts: a failed one is nothing the person has to act on", () => {
  assert.doesNotMatch(MOVE_SOURCE, /showToast|useToast|from "\.\/toast/);
  const effect = arrivalEffect();
  assert.doesNotMatch(effect, /showToast/);
});

/* ── The form a held arrival opens ──────────────────────── */

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

globalThis.window = { localStorage: memoryStorage() };

test("a held arrival still opens a new LOI Check, not the old autosave", () => {
  const html = renderForm({ humperdinkArrival: true, leaveAutosaveAlone: true, autosave: serverAutosave(OLD_TASK, Date.now() - 60000) });
  assert.doesNotMatch(html, /Castillo - Ridge/);
  assert.match(html, /<option value="LOI" selected="">/);
});

test("a held form has no seat on either copy of the autosave, so typing into it can't write over the old one", () => {
  const seat = FORM_SOURCE.slice(FORM_SOURCE.indexOf("const [draftSeat]"));
  assert.match(seat.slice(0, seat.indexOf("}));")), /storage: edit \|\| reopened \|\| leaveAutosaveAlone \? null : browserDraftStorage\(\)/, "no browser copy to write");
  assert.match(FORM_SOURCE, /const autosaveSeat = !edit && !reopened && !leaveAutosaveAlone;/, "no server slot to write or forget");
  const effect = FORM_SOURCE.match(/useEffect\(\(\) => \{\s*if \(!autosaveSeat\) return;\s*const timer[\s\S]*?\}, \[form, autosaveSeat, opening\.fresh\]\);/)?.[0];
  assert.ok(effect, "the typing timer leaves before it writes anything");
  const forget = FORM_SOURCE.match(/const forgetDraft = \(\): void => \{([\s\S]*?)\n  \};/)?.[1];
  assert.match(forget, /if \(!autosaveSeat\) return;/, "Create and Discard can't clear it either");
});

test("Save for later on a held form keeps the old autosave: it doesn't ask the server to clear the slot", async () => {
  const body = FORM_SOURCE.match(/const saveForLater = async \(\): Promise<boolean> => \{([\s\S]*?)\n  \};/)?.[1];
  assert.match(body, /await onSaveForLater\(values, reopened\?\.id, autosaveSeat\)/);
  const handler = APP_SOURCE.match(/const onSaveForLater = async \([\s\S]*?\n  \};/)?.[0];
  assert.match(handler, /saveForLaterRequest\(savedForLaterRequestFor\(user\), form, savedId, clearAutosave\)/);
  assert.match(handler, /if \(!savedId && clearAutosave\) setAutosave\(null\)/, "the Autosaved row stays when the slot wasn't cleared");

  const server = modelServer({ autosave: serverAutosave(OLD_TASK) });
  await saveForLaterRequest(server.request, NEW_TYPING, undefined, false);
  assert.equal(server.state.calls[0].body.clearAutosave, undefined);
  assert.deepEqual(server.state.autosave.form, OLD_TASK);
  await saveForLaterRequest(server.request, NEW_TYPING);
  assert.equal(server.state.autosave, null, "an ordinary new form still clears its own autosave");
});

/* ── App ────────────────────────────────────────────────── */

function arrivalEffect() {
  return APP_SOURCE.match(/useEffect\(\(\) => \{\s*if \(!arrivalPending \|\| !user\.id\) return;([\s\S]*?)\n  \}, \[arrivalPending, user\.id\]\);/)?.[1] ?? "";
}
const teamsInit = APP_SOURCE.match(/teamsApp\s*\.initialize\(\)([\s\S]*?)\.catch\(/)?.[1] ?? "";

test("the Teams init only marks the arrival pending, alongside the person, and opens nothing itself", () => {
  const branch = teamsInit.match(/arrival\.kind === "humperdink"\)\s*(\{[\s\S]*?\}|[^\n]*;)/)?.[1];
  assert.ok(branch, "a humperdink branch");
  assert.match(branch, /setArrivalPending\(true\)/);
  assert.ok(teamsInit.indexOf("setArrivalPending(true)") < teamsInit.indexOf("setUser(me)"), "set with the person, so the first load for them sees it");
  assert.doesNotMatch(teamsInit, /setFormOpen\(|setHumperdinkArrival\(/);
});

test("the first drafts load for the person waits for the move, so no load can race it", () => {
  const identity = APP_SOURCE.match(/savedForLaterOwner\.current = user\.id;([\s\S]*?)\}, \[user\.id\]\);/)?.[1];
  assert.ok(identity);
  assert.match(identity, /if \(!arrivalPending\) \{\s*loadSavedForLater\(\)\.catch\(\(\) => \{\}\);\s*loadAutosave\(\)\.catch\(\(\) => \{\}\);\s*\}/);
});

test("App moves the autosave, then loads the drafts, then opens the LOI Check, holding the seat only when the move didn't land", () => {
  const effect = arrivalEffect();
  assert.ok(effect, "an arrival effect");
  const order = [
    "setArrivalPending(false)",
    "formOpenNow.current",
    "moveAutosaveAside(savedForLaterRequestFor(user), browserDraftStorage(), user.id)",
    "user.id !== savedForLaterOwner.current",
    "loadSavedForLater()",
    "loadAutosave()",
    "setReopened(null)",
    'setLeaveAutosaveAlone(outcome.kind === "held")',
    "setHumperdinkArrival(true)",
    "setFormOpen(true)"
  ].map((needle) => [needle, effect.indexOf(needle)]);
  for (const [needle, at] of order) assert.ok(at >= 0, `the effect has ${needle}`);
  for (let i = 1; i < order.length; i += 1) assert.ok(order[i - 1][1] < order[i][1], `${order[i - 1][0]} before ${order[i][0]}`);
});

test("App hands the form the hold, and every other way in drops it", () => {
  const createMount = APP_SOURCE.match(/\{formOpen && \(\s*<TaskForm([\s\S]*?)\/>/)?.[1];
  assert.match(createMount, /leaveAutosaveAlone=\{leaveAutosaveAlone\}/);
  const onClose = createMount.match(/onClose=\{\(\) => \{([\s\S]*?)\}\}/)?.[1];
  assert.match(onClose, /setLeaveAutosaveAlone\(false\)/);
  const openNewTask = APP_SOURCE.match(/const openNewTask = useCallback\(async \(\): Promise<void> => \{([\s\S]*?)\n  \}/)?.[1];
  assert.match(openNewTask, /setLeaveAutosaveAlone\(false\)/, "New Task always has its seat");
  const openSaved = APP_SOURCE.match(/const openSavedForLater = useCallback\(([\s\S]*?)\n  \}, \[/)?.[1];
  assert.match(openSaved, /setLeaveAutosaveAlone\(false\)/);
});

test("opening New Task normally still restores the autosave exactly as before", () => {
  const html = renderForm({ autosave: serverAutosave(OLD_TASK, Date.now() - 60000) });
  assert.match(html, /Castillo - Ridge/);
  assert.match(html, /<option value="FRAUD" selected="">/);
  assert.match(html, /Hot Task saved your progress/);
});
