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
const { TaskForm, ToastProvider, DRAFT_VERSION, draftAction, draftKey, restoredDraftCopy, serializeDraft } =
  await import(pathToFileURL(bundle).href);
/* Straight from source, no bundle: both modules import their types type-only,
   so node strips them as they stand. Only the form needs building. */
const { BLANK_CREATE_FORM, formHasChanges } = await import(
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

test("there is one way to forget a draft, and every ending goes through it", () => {
  assert.match(FORM_SOURCE, /const forgetDraft = \(\): void => \{/, "one named thing");
  assert.equal(
    FORM_SOURCE.match(/forgetDraft\(\);/g).length,
    3,
    "used by exactly the three endings: a create, the discard prompt, and Start fresh (#285)"
  );
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

/* ── Saying so, and the way out (#285) ──────────────────── */

const NOTE = restoredDraftCopy().note;

test("a form restored from a draft says where the values came from", () => {
  saveDraft(USER.id, FILLED);
  const html = render();
  assert.ok(html.includes(NOTE), "the line is on screen");
  assert.match(html, />Start fresh</, "with the way out beside it");
});

test("a form that opened blank says nothing", () => {
  const html = render();
  assert.ok(!html.includes(NOTE), "nothing was restored, so there is nothing to explain");
  assert.doesNotMatch(html, />Start fresh</);
});

/* Three more forms that did not open on a draft, and so say nothing either. An
   expired or garbled record is no draft at all — the form opens blank, and a
   line claiming otherwise would be the mystery this ticket exists to remove. */
test("a form that fell back to blank says nothing about a draft", () => {
  saveDraft(USER.id, FILLED, 8 * DAY);
  assert.ok(!render().includes(NOTE), "an expired draft");
  storage.set(draftKey(USER.id), "{ this is not a draft");
  assert.ok(!render().includes(NOTE), "a garbled one");
});

test("a prefilled form says nothing — it took the caller's values, not the draft", () => {
  saveDraft(USER.id, FILLED);
  assert.ok(!render({ initialValues: { folderName: "Whitfield 4471" } }).includes(NOTE));
});

test("edit mode says nothing, having restored nothing", () => {
  saveDraft(USER.id, FILLED);
  assert.ok(!render({ edit: { task: TASK, onSave: async () => {} } }).includes(NOTE));
});

/* Quiet, per the last criterion: the muted register `.task-form-locked` already
   carries elsewhere on this form, and a secondary ghost button. Never an alert
   role, a warning tint or a dialog — nothing has gone wrong, the app did
   something helpful and is saying so. */
test("the line and its button are quiet, not an alert", () => {
  saveDraft(USER.id, FILLED);
  const html = render();
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
  assert.match(
    FORM_SOURCE,
    /useState\(opening\.fromDraft\)/,
    "set once from how the form opened"
  );
  const setters = FORM_SOURCE.match(/setRestoredNote\(/g) ?? [];
  assert.equal(setters.length, 1, "and moved by exactly one thing: Start fresh");
});

test("Start fresh empties the form, forgets the draft, and asks nothing first", () => {
  const fresh = FORM_SOURCE.slice(FORM_SOURCE.indexOf("const startFresh"));
  const body = fresh.slice(0, fresh.indexOf("\n  };"));
  assert.match(body, /setForm\(blank\)/, "every field goes back to the blank form");
  assert.match(body, /openedWith\.current = blank/, "which is now what a Cancel measures against");
  assert.match(body, /setSeedDraft\(""\)/, "the outstanding-items box too");
  /* Every field, per the criterion — including the two that are not in the
     values object: the FRAUD seeder's box above, and the Humperdink paste box,
     which sits on every LOI form and a blank one is an LOI. */
  assert.match(body, /setImportText\(""\)/, "and the Humperdink paste box");
  assert.match(body, /setImported\(false\)/, "whose button stops saying Imported");
  assert.match(body, /setImportedNote\(""\)/, "with nothing left of the note it wrote");
  assert.match(body, /forgetDraft\(\);/, "and the saved copy is deleted");
  assert.match(body, /setRestoredNote\(false\)/, "the line has nothing left to describe");
  assert.doesNotMatch(body, /setDiscardAsk|DiscardConfirm/, "no confirmation — one press is the whole thing");
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

/* After Start fresh the form is blank and there is no draft on disk, so the
   effect must read "keep" — nothing to write, nothing to clear — and the first
   keystroke after it must read "write". Both fall out of the two yardsticks
   being re-pointed at the blank form, which is why `openedWith` moves with it;
   left pointing at the restored values, an untouched blank form would look
   changed and immediately re-save the thing that was just thrown away. */
test("typing after Start fresh starts a new draft, and a straight Cancel asks nothing", () => {
  const blank = { ...BLANK_CREATE_FORM, initialItems: [] };
  assert.equal(
    draftAction({
      changedFromBlank: formHasChanges(blank, blank),
      movedSinceOpen: formHasChanges(blank, blank),
      onDisk: false
    }),
    "keep",
    "a form just emptied writes nothing and clears nothing"
  );
  assert.equal(formHasChanges(blank, blank), false, "so Cancel closes without a prompt");
  const typed = { ...blank, notes: "a brand new task" };
  assert.equal(
    draftAction({
      changedFromBlank: formHasChanges(blank, typed),
      movedSinceOpen: formHasChanges(blank, typed),
      onDisk: false
    }),
    "write",
    "and the next keystroke starts a new draft as normal"
  );
});
