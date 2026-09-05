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
 *    events, so the save timer, the clear-on-create and the clear-on-discard
 *    cannot be executed here. Which function each path calls is asserted against
 *    `task-form.tsx` itself, the way `edit-task-form-sim-test.mjs` and
 *    `discard-confirm-sim-test.mjs` assert routing they cannot run.
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

const scratch = mkdtempSync(join(REPO, "node_modules", ".task-draft-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const entry = join(scratch, "entry.tsx");
writeFileSync(
  entry,
  `export { TaskForm } from ${JSON.stringify(join(REPO, "apps/web/src/task-form.tsx"))};\n` +
    `export { ToastProvider } from ${JSON.stringify(join(REPO, "apps/web/src/toast.tsx"))};\n` +
    `export * from ${JSON.stringify(join(REPO, "apps/web/src/create-form-draft.ts"))};\n`
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
const { TaskForm, ToastProvider, DRAFT_VERSION, draftKey, serializeDraft } = await import(
  pathToFileURL(bundle).href
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

test("a saved draft comes back in the form, field for field", () => {
  saveDraft(USER.id, FILLED);
  const html = render();
  assert.match(html, /value="Adams - Harbor"/, "the loan");
  assert.match(html, /Second TD needs confirming/, "the request text");
  assert.match(html, /value="https:\/\/humperdink\.loneoakfund\.com\/Loans\/Details\/335203"/, "the link");
});

/* The four the criterion names, by name. */
test("the task type, the fraud items and the share-or-assign pick with its note all come back", () => {
  saveDraft(USER.id, FILLED);
  const html = render();
  assert.match(html, /<option value="FRAUD" selected/, "the type it was left on");
  assert.match(html, /Missing appraisal/, "the outstanding items the creator seeded");
  assert.match(html, /No W-2/);
  assert.match(html, /aria-pressed="true"[^>]*>Assign</, "assign rather than share");
  assert.match(html, /<option value="user-3" selected/, "the person it was going to");
  assert.match(html, /yours if you can take it today/, "and the note to them");
});

test("an out-of-office draft comes back with both its dates", () => {
  saveDraft(USER.id, OOO);
  const html = render();
  assert.match(html, /<option value="OOO" selected/);
  assert.match(html, /value="2026-09-07"/, "the day they go");
  assert.match(html, /value="2026-09-14"/, "and the day they are back");
});

test("with no draft the form opens exactly as it always has", () => {
  const html = render();
  assert.match(html, /<option value="LOI" selected/, "the default type");
  assert.doesNotMatch(html, /Adams - Harbor/);
  assert.doesNotMatch(html, /Second TD needs confirming/);
});

/* A restored draft is the first thing that can put a person in the recipient
   picker before anyone has touched the form, and the effect that drops an
   ineligible pick runs on the first render. Handed an empty directory — the
   moment before it has loaded — it would drop the restored person and the note
   written to them, so it now waits for a directory before deciding anything.
   Asserted on the source as well as rendered: the render proves the pick is on
   screen, the source proves why it survives. */
test("a restored recipient is not dropped by a directory that has not loaded yet", () => {
  saveDraft(USER.id, FILLED);
  const html = render({ directory: [] });
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

test("a draft older than seven days does not come back, and the form opens blank", () => {
  saveDraft(USER.id, FILLED, 8 * DAY);
  const html = render();
  assert.doesNotMatch(html, /Adams - Harbor/, "nothing restored");
  assert.match(html, /<option value="LOI" selected/, "a blank form, not a half-restored one");
  assert.equal(storage.size, 0, "and the stale record is pruned rather than re-read forever");
});

test("a garbled draft is no draft", () => {
  storage.set(draftKey(USER.id), "{ this is not a draft");
  const html = render();
  assert.doesNotMatch(html, /Adams - Harbor/);
  assert.match(html, /<option value="LOI" selected/);
});

test("a draft from a version that no longer exists is no draft", () => {
  storage.set(
    draftKey(USER.id),
    JSON.stringify({ version: DRAFT_VERSION + 1, savedAt: Date.now(), values: FILLED })
  );
  assert.doesNotMatch(render(), /Adams - Harbor/);
});

/* ── Whose draft it is ──────────────────────────────────── */

test("two people signed in on the same machine never see each other's draft", () => {
  saveDraft("user-2", { ...FILLED, notes: "Sam's half-written task" });
  const dana = render();
  assert.doesNotMatch(dana, /Sam's half-written task/, "Dana sees nothing of Sam's");
  assert.doesNotMatch(dana, /Adams - Harbor/);

  saveDraft(USER.id, { ...FILLED, notes: "Dana's half-written task" });
  assert.match(render(), /Dana&#x27;s half-written task/, "and her own comes back");
  const sam = render({ user: { ...USER, id: "user-2", displayName: "Sam Checker" } });
  assert.match(sam, /Sam&#x27;s half-written task/, "while Sam still gets his");
  assert.doesNotMatch(sam, /Dana&#x27;s half-written task/);
});

/* ── Edit mode is out of scope ──────────────────────────── */

test("the form opened on an existing task restores no draft", () => {
  saveDraft(USER.id, FILLED);
  const html = render({ edit: { task: TASK, onSave: async () => {} } });
  assert.match(html, /value="Whitfield 4471"/, "it shows the task's own values");
  assert.doesNotMatch(html, /Adams - Harbor/, "and none of the draft's");
  assert.doesNotMatch(html, /Second TD needs confirming/);
});

test("edit mode has nowhere to save a draft to, rather than a rule not to", () => {
  const seat = FORM_SOURCE.slice(FORM_SOURCE.indexOf("const [draftSeat]"));
  assert.match(
    seat.slice(0, seat.indexOf("}));")),
    /storage: edit \? null : browserDraftStorage\(\)/,
    "edit mode's storage is null, so every draft call is already a no-op"
  );
  assert.match(FORM_SOURCE, /if \(editing\) return;/, "and the save effect leaves immediately too");
});

test("an edit form leaves an existing draft alone rather than clearing it", () => {
  saveDraft(USER.id, FILLED);
  render({ edit: { task: TASK, onSave: async () => {} } });
  assert.equal(storage.size, 1, "still there after an edit form has been and gone");
});

/* ── With no storage at all ─────────────────────────────── */

test("a browser that will not store anything renders the form exactly as today", () => {
  const saved = globalThis.window;
  /* No `window` at all is the same shape of failure as a locked-down Teams
     profile, where reading the property throws. */
  delete globalThis.window;
  try {
    const html = render();
    assert.match(html, /<option value="LOI" selected/, "a normal blank form");
    assert.match(html, />Create Task</, "with its normal button");
    assert.doesNotMatch(html, /storage/i, "and nothing said about storage anywhere");
  } finally {
    globalThis.window = saved;
  }
});

test("a storage that throws on every call still renders the form", () => {
  const saved = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("QuotaExceededError"); },
      removeItem: () => { throw new Error("blocked"); }
    }
  };
  try {
    assert.match(render(), /<option value="LOI" selected/);
  } finally {
    globalThis.window = saved;
  }
});

/* ── How the saving is wired ────────────────────────────── */

/* The ticket is explicit: the failure being survived is the one where nothing
   runs on the way out, so the draft cannot depend on an exit path. */
test("the draft is written as the person types, on a timer, not on the way out", () => {
  const effect = FORM_SOURCE.slice(FORM_SOURCE.indexOf("── Keeping the draft (#284)"));
  const body = effect.slice(0, effect.indexOf("}, [form,"));
  assert.match(body, /window\.setTimeout\(/, "a trailing debounce");
  assert.match(body, /DRAFT_SAVE_DEBOUNCE_MS/, "settling shortly after the typing stops");
  assert.match(body, /writeDraft\(draftSeat\.storage, draftSeat\.userId, form\)/, "saving the whole form");
  assert.match(
    effect.slice(0, effect.indexOf("]);") + 3),
    /\}, \[form, editing, opening\.fresh, draftSeat\]\);/,
    "keyed on the values, so every change restarts the timer"
  );
  assert.doesNotMatch(
    FORM_SOURCE.replace(/\/\*[\s\S]*?\*\//g, ""),
    /addEventListener\(\s*"(beforeunload|pagehide|visibilitychange)"/,
    "nothing hangs off leaving the page — that is the event this ticket assumes never arrives"
  );
});

/* `formHasChanges` is #283's predicate and the ticket says to reuse it — one
   answer to "has anything been done here", so the prompt and the draft can
   never disagree. Measured against a blank-slate open, which is what makes a
   changed task type on its own enough. */
/* The write/keep/clear rule itself is `draftAction`, tested as a truth table in
   `create-form-draft-sim-test.mjs`; what is asserted here is that the effect
   asks it, and with which two yardsticks. Both are `formHasChanges` — #283's
   predicate, which the ticket says to reuse — so the prompt and the draft can
   never disagree about what "untouched" means. */
test("worth saving is the discard prompt's own check, against a blank-slate open", () => {
  const effect = FORM_SOURCE.slice(FORM_SOURCE.indexOf("── Keeping the draft (#284)"));
  const body = effect.slice(0, effect.indexOf("}, [form,"));
  assert.match(body, /changedFromBlank: formHasChanges\(opening\.fresh, form\)/, "different from a form opened fresh");
  assert.match(body, /movedSinceOpen: formHasChanges\(openedWith\.current, form\)/, "and something moved since");
  assert.match(body, /onDisk: draftStored\.current/, "and whether there is a copy out there already");
  assert.match(body, /draftStored\.current = writeDraft\(/, "a write records whether it actually landed");
  assert.match(body, /clearDraft\(draftSeat\.storage, draftSeat\.userId\)/, "a form emptied back out clears it");
});

/* Not asked for by the ticket, which never contemplates opening New Task
   prefilled; it is the answer to a case the code can reach. A form opened with
   values is someone asking for a task about a particular loan, and answering
   that with last Tuesday's half-written task about a different one would be the
   wrong form. Their draft is left alone rather than restored or destroyed, so a
   plain New Task still gets it back. */
test("a form opened prefilled shows the prefill, and leaves the draft where it is", () => {
  saveDraft(USER.id, FILLED);
  const html = render({ initialValues: { folderName: "Whitfield 4471" } });
  assert.match(html, /value="Whitfield 4471"/, "what the caller asked for");
  assert.doesNotMatch(html, /Adams - Harbor/, "not the draft");
  assert.doesNotMatch(html, /Second TD needs confirming/);
  assert.equal(storage.size, 1, "which is still there for the next plain New Task");
  assert.match(render(), /Second TD needs confirming/, "and comes back on one");
});

/* The saved copy is keyed to whoever opened the form, not to whoever is signed
   in when the timer fires — the mock user picker can change that mid-form, and
   writing Dana's typing under Sam's name is the one thing the per-user key
   exists to prevent. */
test("the draft's owner is pinned at open, not read live", () => {
  const seat = FORM_SOURCE.slice(FORM_SOURCE.indexOf("const [draftSeat]"));
  assert.match(seat.slice(0, seat.indexOf("}));")), /userId: user\.id/);
  const after = FORM_SOURCE.slice(FORM_SOURCE.indexOf("}));", FORM_SOURCE.indexOf("const [draftSeat]")));
  assert.doesNotMatch(after, /(read|write|clear)Draft\([^)]*user\.id/, "no draft call reads the live user");
});

/* ── How the forgetting is wired ────────────────────────── */

test("there is one way to forget a draft, and both endings go through it", () => {
  assert.match(FORM_SOURCE, /const forgetDraft = \(\): void => \{/, "one named thing");
  assert.equal(FORM_SOURCE.match(/forgetDraft\(\);/g).length, 2, "used by exactly the two endings");
});

test("creating the task clears the draft, and only on success", () => {
  const submit = FORM_SOURCE.slice(FORM_SOURCE.indexOf("await onCreate("));
  const untilCatch = submit.slice(0, submit.indexOf("} catch {"));
  assert.match(untilCatch, /forgetDraft\(\);/, "the draft goes once the task exists");
  assert.ok(
    untilCatch.indexOf("forgetDraft();") < untilCatch.indexOf("onClose();"),
    "before the form closes, while it still has its seat"
  );
  const failed = submit.slice(submit.indexOf("} catch {"));
  assert.doesNotMatch(failed.slice(0, failed.indexOf("}")), /forgetDraft/, "a failed create keeps it for the retry");
});

test("confirming the discard prompt clears the draft; declining leaves it", () => {
  const mount = FORM_SOURCE.slice(FORM_SOURCE.indexOf("{discardAsk &&"));
  const line = mount.slice(0, mount.indexOf("\n"));
  assert.match(line, /onConfirm=\{confirmDiscard\}/, "the yes is the deliberate forget");
  assert.match(line, /onCancel=\{\(\) => setDiscardAsk\(false\)\}/, "the no only lowers the prompt");
  assert.doesNotMatch(line.slice(line.indexOf("onCancel")), /forgetDraft|onClose/, "it clears and closes nothing");
  const confirm = FORM_SOURCE.slice(FORM_SOURCE.indexOf("const confirmDiscard"));
  const body = confirm.slice(0, confirm.indexOf("};"));
  assert.match(body, /forgetDraft\(\);/);
  assert.match(body, /onClose\(\);/, "and then closes, as Cancel always has");
});
