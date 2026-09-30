#!/usr/bin/env node
/* Issue #284 — the new task form remembers your progress, wired into the form.
 *
 * The rules themselves (what is stored, when it expires, whose it is) are
 * `apps/web/src/create-form-draft.ts` and are tested against a fake storage in
 * `create-form-draft-sim-test.mjs`, with no form in sight. This file is the
 * other half: that the form actually asks.
 *
 * Two techniques, for two different kinds of claim.
 *
 * 1. RENDERED. The form is bundled and rendered through `react-dom/server` with
 *    a `window.localStorage` made of a Map. A first paint is enough to prove the
 *    restore half of the ticket outright — every field comes back, an expired or
 *    corrupt draft does not, one person never gets another's, edit mode ignores
 *    the whole thing — because restoring happens in the state initializer.
 * 2. READ OUT OF THE SOURCE. `renderToStaticMarkup` runs no effects and fires no
 *    events, so that each ending goes to the session is asserted against
 *    `task-form.tsx` itself. The saving, forgetting and restoring those endings
 *    do are the New Task session's, driven in `new-task-session-sim-test.mjs`.
 *
 * What is left for a person: typing into a real browser and watching the draft
 * appear, closing the tab, and coming back. Named in the PR report.
 *
 * Run: `node --test scripts/task-draft-form-sim-test.mjs`. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const FORM_SOURCE = readFileSync(join(REPO, "apps/web/src/task-form.tsx"), "utf8");
const SESSION_SOURCE = readFileSync(join(REPO, "apps/web/src/new-task-session.ts"), "utf8");

const scratch = mkdtempSync(join(REPO, "node_modules", ".task-draft-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const entry = join(scratch, "entry.tsx");
writeFileSync(
  entry,
  `export { TaskForm } from ${JSON.stringify(join(REPO, "apps/web/src/task-form.tsx"))};\n` +
    `export { ToastProvider } from ${JSON.stringify(join(REPO, "apps/web/src/toast.tsx"))};\n` +
    `export * from ${JSON.stringify(join(REPO, "apps/web/src/create-form-draft.ts"))};\n` +
    `export { createNewTaskSession } from ${JSON.stringify(join(REPO, "apps/web/src/new-task-session.ts"))};\n`
);
const bundle = join(scratch, "task-draft.mjs");
await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  external: ["react", "react/jsx-runtime", "@loan-tasks/shared"],
  logLevel: "silent"
});
const { TaskForm, ToastProvider, DRAFT_VERSION, draftKey, restoredDraftCopy, serializeDraft, browserDraftStorage, createNewTaskSession } =
  await import(pathToFileURL(bundle).href);
/* Straight from source, no bundle: both modules import their types type-only,
   so node strips them as they stand. Only the form needs building. */
const { BLANK_CREATE_FORM } = await import(
  pathToFileURL(join(REPO, "apps/web/src/create-form-state.ts")).href
);

/* ── A browser, as far as this module is concerned ──────── */

const storage = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key)
  }
};

const USER = { id: "user-1", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] };
const DIRECTORY = [
  { id: "user-3", displayName: "Sam Checker", roles: ["FILE_CHECKER"] },
  { id: "user-4", displayName: "Ada Officer", roles: ["LOAN_OFFICER"] }
];

/* A fresh New Task form opens through its session (#467), the way App opens
   it: this browser's storage, and a server whose Autosave is `autosave`. An
   edit form renders as it is handed. */
const render = async ({ autosave = null, ...props } = {}) => {
  const fresh = !props.edit;
  let session;
  if (fresh) {
    session = createNewTaskSession({
      owner: (props.user ?? USER).id,
      storage: browserDraftStorage(),
      request: async () => ({ item: autosave })
    });
    await session.open();
  }
  return renderToStaticMarkup(
    createElement(ToastProvider, null, createElement(TaskForm, {
      loans: [],
      directory: DIRECTORY,
      user: USER,
      tasks: [],
      onClose: () => {},
      onCreate: async () => {},
      ...props,
      ...(session ? { session } : {})
    }))
  );
};

const FILLED = {
  folderName: "Adams - Harbor",
  loanId: "loan-9",
  taskType: "FRAUD",
  urgency: "RED",
  startDate: "",
  returnDate: "",
  notes: "Second TD needs confirming",
  humperdinkLink: "https://humperdink.loneoakfund.com/Loans/Details/335203",
  points: 3,
  initialItems: ["Missing appraisal", "No W-2"],
  pickerMode: "assign",
  recipientUserId: "user-3",
  recipientNote: "yours if you can take it today"
};

const OOO = {
  ...FILLED,
  taskType: "OOO",
  folderName: "Dana out — dentist then jury duty",
  startDate: "2026-09-07",
  returnDate: "2026-09-14",
  initialItems: [],
  recipientUserId: "",
  recipientNote: ""
};

const DAY = 24 * 60 * 60 * 1000;

const saveDraft = (userId, values, ageMs = 0) => {
  storage.set(draftKey(userId), serializeDraft(values, Date.now() - ageMs));
};

const TASK = {
  taskType: "LOI",
  notes: "Loan Amount: $2,340,000",
  folderName: "Whitfield 4471",
  humperdinkLink: "https://h.example/whitfield-4471",
  urgency: "GREEN",
  points: 2,
  createdBy: { id: USER.id, displayName: USER.displayName }
};

test.beforeEach(() => storage.clear());

/* ── Opening New Task on a saved draft ──────────────────── */

test("a saved draft comes back in the form, field for field", async () => {
  saveDraft(USER.id, FILLED);
  const html = await render();
  assert.match(html, /value="Adams - Harbor"/, "the loan");
  assert.match(html, /Second TD needs confirming/, "the request text");
  assert.match(html, /value="https:\/\/humperdink\.loneoakfund\.com\/Loans\/Details\/335203"/, "the link");
});

/* The four the criterion names, by name. */
test("the task type, the fraud items and the share-or-assign pick with its note all come back", async () => {
  saveDraft(USER.id, FILLED);
  const html = await render();
  assert.match(html, /<option value="FRAUD" selected/, "the type it was left on");
  assert.match(html, /Missing appraisal/, "the outstanding items the creator seeded");
  assert.match(html, /No W-2/);
  assert.match(html, /aria-pressed="true"[^>]*>Assign</, "assign rather than share");
  assert.match(html, /<option value="user-3" selected/, "the person it was going to");
  assert.match(html, /yours if you can take it today/, "and the note to them");
});

test("an out-of-office draft comes back with both its dates", async () => {
  saveDraft(USER.id, OOO);
  const html = await render();
  assert.match(html, /<option value="OOO" selected/);
  assert.match(html, /value="2026-09-07"/, "the day they go");
  assert.match(html, /value="2026-09-14"/, "and the day they are back");
});

test("with no draft the form opens exactly as it always has", async () => {
  const html = await render();
  assert.match(html, /<option value="LOI" selected/, "the default type");
  assert.doesNotMatch(html, /Adams - Harbor/);
  assert.doesNotMatch(html, /Second TD needs confirming/);
});

/* ── The autosave on the server (#371) ──────────────────── */

/* Since #371 App hands the form the server's autosave, and this browser only
   holds what the server never got. The form opens on whichever was written
   last, and says so the same way either way. */
const serverAutosave = (values, ageMs = 0) => ({
  ownerId: USER.id,
  savedAt: new Date(Date.now() - ageMs).toISOString(),
  form: values
});

test("an autosave kept on the server comes back in the form, field for field, with the restored line and Start fresh", async () => {
  const html = await render({ autosave: serverAutosave(FILLED, 60000) });
  assert.match(html, /value="Adams - Harbor"/, "the loan");
  assert.match(html, /Second TD needs confirming/, "the request text");
  assert.match(html, /<option value="FRAUD" selected/, "the type");
  assert.match(html, /Missing appraisal/, "the outstanding items");
  assert.ok(html.includes(restoredDraftCopy().note), "the line saying where it came from");
  assert.match(html, />Start fresh</, "and the way out");
  assert.equal(storage.size, 0, "nothing from this browser was needed");
});

test("typing that only reached this browser comes back over an older autosave on the server", async () => {
  saveDraft(USER.id, { ...FILLED, notes: "typed while the server was down" }, 1000);
  const html = await render({ autosave: serverAutosave({ ...FILLED, notes: "the last write the server got" }, 60000) });
  assert.match(html, /typed while the server was down/);
  assert.doesNotMatch(html, /the last write the server got/);
});

test("a newer autosave on the server, typed on another device, comes back over an older copy in this browser", async () => {
  saveDraft(USER.id, { ...FILLED, notes: "an old offline copy" }, 60 * 60000);
  const html = await render({ autosave: serverAutosave({ ...FILLED, notes: "typed on the phone" }, 60000) });
  assert.match(html, /typed on the phone/);
  assert.doesNotMatch(html, /an old offline copy/);
});

test("a server autosave seven days old does not come back", async () => {
  const html = await render({ autosave: serverAutosave(FILLED, 8 * DAY) });
  assert.doesNotMatch(html, /Adams - Harbor/);
  assert.ok(!html.includes(restoredDraftCopy().note), "and nothing is said about one");
});

test("an edit form ignores the server autosave", async () => {
  const editing = await render({ autosave: serverAutosave(FILLED), edit: { task: TASK, onSave: async () => {} } });
  assert.doesNotMatch(editing, /Second TD needs confirming/);
});

/* A restored draft is the first thing that can put a person in the recipient
   picker before anyone has touched the form, and the effect that drops an
   ineligible pick runs on the first render. Handed an empty directory — the
   moment before it has loaded — it would drop the restored person and the note
   written to them, so it now waits for a directory before deciding anything.
   Asserted on the source as well as rendered: the render proves the pick is on
   screen, the source proves why it survives. */
test("a restored recipient is not dropped by a directory that has not loaded yet", async () => {
  saveDraft(USER.id, FILLED);
  const html = await render({ directory: [] });
  assert.match(html, /Second TD needs confirming/, "the draft is restored");
  /* The picker itself isn't drawn without a directory to pick from, so the
     person and their note are not on screen to assert — the point is that they
     are still in the form's state when the directory lands, which is what the
     guard below is. Rendered with a directory (above) they are both there. */
  const effect = FORM_SOURCE.slice(FORM_SOURCE.indexOf("Switching to Assign"));
  assert.match(
    effect.slice(0, effect.indexOf("});")),
    /if \(directory\.length === 0\) return;/,
    "eligibility is not decided on a list that is not there"
  );
});

/* ── The drafts that must not come back ─────────────────── */

test("a draft older than seven days does not come back, and the form opens blank", async () => {
  saveDraft(USER.id, FILLED, 8 * DAY);
  const html = await render();
  assert.doesNotMatch(html, /Adams - Harbor/, "nothing restored");
  assert.match(html, /<option value="LOI" selected/, "a blank form, not a half-restored one");
  assert.equal(storage.size, 0, "and the stale record is pruned rather than re-read forever");
});

test("a garbled draft is no draft", async () => {
  storage.set(draftKey(USER.id), "{ this is not a draft");
  const html = await render();
  assert.doesNotMatch(html, /Adams - Harbor/);
  assert.match(html, /<option value="LOI" selected/);
});

test("a draft from a version that no longer exists is no draft", async () => {
  storage.set(
    draftKey(USER.id),
    JSON.stringify({ version: DRAFT_VERSION + 1, savedAt: Date.now(), values: FILLED })
  );
  assert.doesNotMatch(await render(), /Adams - Harbor/);
});

/* ── Whose draft it is ──────────────────────────────────── */

test("two people signed in on the same machine never see each other's draft", async () => {
  saveDraft("user-2", { ...FILLED, notes: "Sam's half-written task" });
  const dana = await render();
  assert.doesNotMatch(dana, /Sam's half-written task/, "Dana sees nothing of Sam's");
  assert.doesNotMatch(dana, /Adams - Harbor/);

  saveDraft(USER.id, { ...FILLED, notes: "Dana's half-written task" });
  assert.match(await render(), /Dana&#x27;s half-written task/, "and her own comes back");
  const sam = await render({ user: { ...USER, id: "user-2", displayName: "Sam Checker" } });
  assert.match(sam, /Sam&#x27;s half-written task/, "while Sam still gets his");
  assert.doesNotMatch(sam, /Dana&#x27;s half-written task/);
});

/* ── Edit mode is out of scope ──────────────────────────── */

test("the form opened on an existing task restores no draft", async () => {
  saveDraft(USER.id, FILLED);
  const html = await render({ edit: { task: TASK, onSave: async () => {} } });
  assert.match(html, /value="Whitfield 4471"/, "it shows the task's own values");
  assert.doesNotMatch(html, /Adams - Harbor/, "and none of the draft's");
  assert.doesNotMatch(html, /Second TD needs confirming/);
});

test("the form keeps no copy of its own: only a New Task session saves one", () => {
  assert.doesNotMatch(FORM_SOURCE, /browserDraftStorage|writeDraft|clearDraft|readDraft/, "no browser copy");
  assert.doesNotMatch(FORM_SOURCE, /onKeepAutosave|onForgetAutosave|keepAutosave|forgetAutosave/, "and no server one");
});

test("an edit form leaves an existing draft alone rather than clearing it", async () => {
  saveDraft(USER.id, FILLED);
  await render({ edit: { task: TASK, onSave: async () => {} } });
  assert.equal(storage.size, 1, "still there after an edit form has been and gone");
});

/* ── With no storage at all ─────────────────────────────── */

test("a browser that will not store anything renders the form exactly as today", async () => {
  const saved = globalThis.window;
  /* No `window` at all is the same shape of failure as a locked-down Teams
     profile, where reading the property throws. */
  delete globalThis.window;
  try {
    const html = await render();
    assert.match(html, /<option value="LOI" selected/, "a normal blank form");
    assert.match(html, />Create Task</, "with its normal button");
    assert.doesNotMatch(html, /storage/i, "and nothing said about storage anywhere");
  } finally {
    globalThis.window = saved;
  }
});

test("a storage that throws on every call still renders the form", async () => {
  const saved = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("QuotaExceededError"); },
      removeItem: () => { throw new Error("blocked"); }
    }
  };
  try {
    assert.match(await render(), /<option value="LOI" selected/);
  } finally {
    globalThis.window = saved;
  }
});

/* ── How the saving is wired ────────────────────────────── */

/* The ticket is explicit: the failure being survived is the one where nothing
   runs on the way out, so the draft cannot depend on an exit path. */
test("the draft is written as the person types, on a timer, not on the way out", () => {
  /* The timer is the session's, driven in new-task-session-sim-test. */
  for (const source of [FORM_SOURCE, SESSION_SOURCE]) {
    assert.doesNotMatch(
      source.replace(/\/\*[\s\S]*?\*\//g, ""),
      /addEventListener\(\s*"(beforeunload|pagehide|visibilitychange)"/,
      "nothing hangs off leaving the page — that is the event this ticket assumes never arrives"
    );
  }
});

/* ── How the forgetting is wired ────────────────────────── */

/* What each ending forgets, and only on success, is driven in
   new-task-session-sim-test. */
test("every ending of a New Task form goes to its session", () => {
  for (const kind of ["create", "discard", "saveForLater", "startFresh", "cancel"]) {
    assert.match(FORM_SOURCE, new RegExp(`session\\??\\.end\\(\\{\\s*kind: "${kind}"`), kind);
  }
});

test("confirming the discard prompt clears the draft; declining leaves it", () => {
  const mount = FORM_SOURCE.slice(FORM_SOURCE.indexOf("{discardAsk &&"));
  const line = mount.slice(0, mount.indexOf("\n"));
  assert.match(line, /onConfirm=\{confirmDiscard\}/, "the yes is the deliberate forget");
  assert.match(line, /onCancel=\{dismissAsk\}/, "the no only lowers the prompt");
  assert.doesNotMatch(line.slice(line.indexOf("onCancel")), /session\.end|onClose/, "it clears and closes nothing");
  const confirm = FORM_SOURCE.slice(FORM_SOURCE.indexOf("const confirmDiscard"));
  const body = confirm.slice(0, confirm.indexOf("};"));
  assert.match(body, /session\.end\(\{ kind: "discard" \}\)/, "the session forgets it and closes");
});

/* ── Saying so, and the way out (#285) ──────────────────── */

const NOTE = restoredDraftCopy().note;

test("a form restored from a draft says where the values came from", async () => {
  saveDraft(USER.id, FILLED);
  const html = await render();
  assert.ok(html.includes(NOTE), "the line is on screen");
  assert.match(html, />Start fresh</, "with the way out beside it");
});

test("a form that opened blank says nothing", async () => {
  const html = await render();
  assert.ok(!html.includes(NOTE), "nothing was restored, so there is nothing to explain");
  assert.doesNotMatch(html, />Start fresh</);
});

/* Three more forms that did not open on a draft, and so say nothing either. An
   expired or garbled record is no draft at all — the form opens blank, and a
   line claiming otherwise would be the mystery this ticket exists to remove. */
test("a form that fell back to blank says nothing about a draft", async () => {
  saveDraft(USER.id, FILLED, 8 * DAY);
  assert.ok(!(await render()).includes(NOTE), "an expired draft");
  storage.set(draftKey(USER.id), "{ this is not a draft");
  assert.ok(!(await render()).includes(NOTE), "a garbled one");
});

test("edit mode says nothing, having restored nothing", async () => {
  saveDraft(USER.id, FILLED);
  assert.ok(!(await render({ edit: { task: TASK, onSave: async () => {} } })).includes(NOTE));
});

/* Quiet, per the last criterion: the muted register `.task-form-locked` already
   carries elsewhere on this form, and a secondary ghost button. Never an alert
   role, a warning tint or a dialog — nothing has gone wrong, the app did
   something helpful and is saying so. */
test("the line and its button are quiet, not an alert", async () => {
  saveDraft(USER.id, FILLED);
  const html = await render();
  const strip = html.slice(html.indexOf("task-form-restored"), html.indexOf(NOTE) + NOTE.length + 200);
  assert.match(strip, /task-form-locked/, "the form's existing muted prose register");
  assert.match(strip, /class="btn-sm btn-ghost"/, "a secondary button, not a filled one");
  assert.doesNotMatch(strip, /role="alert"|task-form-warning/, "nothing has gone wrong");
});

/* The criterion is that the line stays for as long as the form is open, edits
   included — it is where the button lives, and the person most likely to want
   it is a few seconds in. Rendering proves the first paint; what proves it does
   not vanish on a keystroke is that the condition cannot see `form` at all. It
   is a mount-time flag, moved only by Start fresh. */
test("the line is keyed to how the form opened, not to what is in it now", () => {
  const mount = FORM_SOURCE.slice(FORM_SOURCE.indexOf("{restoredNote &&"));
  const block = mount.slice(0, mount.indexOf("</div>"));
  assert.doesNotMatch(block, /\bform\.[a-z]/i, "no field of the current values is consulted");
  assert.match(FORM_SOURCE, /const restoredNote = live\?\.restored \?\? false;/, "read from the New Task session");
});

test("only a New Task opened on an Autosave has the line, it survives typing, and only Start fresh takes it down", async () => {
  const RECORD = { id: "sfl-1", ownerId: USER.id, savedAt: new Date().toISOString(), form: FILLED };
  const make = () =>
    createNewTaskSession({
      owner: USER.id,
      storage: null,
      request: async (path) => (path === "/autosave" ? { item: serverAutosave(FILLED, 60000) } : { item: RECORD })
    });
  const restored = (session) => session.getState().restored;

  const fresh = make();
  await fresh.open();
  assert.equal(restored(fresh), true, "set from how the form opened");
  fresh.edit({ ...FILLED, notes: "and more" });
  assert.equal(restored(fresh), true, "typing leaves it up");
  await fresh.end({ kind: "startFresh" });
  assert.equal(restored(fresh), false, "Start fresh takes it down");

  const reopened = make();
  await reopened.reopen(RECORD);
  assert.equal(restored(reopened), false, "a reopened Task Draft never has the line");

  const arrival = make();
  await arrival.arrive({ load: () => {} });
  assert.equal(restored(arrival), false, "nor does an arrival's LOI Check");

  const carried = make();
  carried.adopt(FILLED);
  assert.equal(restored(carried), false, "nor does a form carried over from sign-in");
});

test("Start fresh empties the form, forgets the draft, and asks nothing first", () => {
  const fresh = FORM_SOURCE.slice(FORM_SOURCE.indexOf("const startFresh"));
  const body = fresh.slice(0, fresh.indexOf("\n  };"));
  /* Blanking the values, forgetting both copies and taking the line down are the
     session's Start fresh, driven in new-task-session-sim-test. */
  assert.match(body, /session\?\.end\(\{ kind: "startFresh" \}\)/, "every field and the outstanding-items box go back to blank, and the saved copy is deleted");
  /* Every field, per the criterion — including what is not in the values
     object: what a Humperdink import left. */
  assert.match(body, /setImported\(false\)/, "the import's announcement is taken back");
  assert.match(body, /setImportedNote\(""\)/, "with nothing left of the note it wrote");
  assert.doesNotMatch(body, /setEditAsk|DiscardConfirm/, "no confirmation — one press is the whole thing");
});

/* The button removes itself: the line has nothing to say over an empty form, so
   the element that was clicked unmounts and focus would fall to the document
   body — outside the dialog, where the overlay's Escape handler never sees it.
   Focus goes to the first field, which is where a new task starts anyway, and
   it goes there before the clears run because that box's own `onFocus` reads
   the value it can still see. */
test("Start fresh leaves focus inside the form, on the field a new task starts in", () => {
  const fresh = FORM_SOURCE.slice(FORM_SOURCE.indexOf("const startFresh"));
  const body = fresh.slice(0, fresh.indexOf("\n  };"));
  assert.match(body, /folderNameRef\.current\?\.focus\(\)/, "focus stays in the dialog");
  assert.ok(
    body.indexOf("folderNameRef.current?.focus()") < body.indexOf("setLoanQuery"),
    "moved before the typeahead is cleared, so the field's own onFocus cannot undo it"
  );
  /* And the box it focuses actually carries the ref while filing — it used to
     be attached only in edit mode, where the plain text input stands in for the
     typeahead. */
  const typeahead = FORM_SOURCE.slice(FORM_SOURCE.indexOf('<span className="loan-typeahead">'));
  assert.match(typeahead.slice(0, typeahead.indexOf("/>")), /ref=\{folderNameRef\}/);
});
