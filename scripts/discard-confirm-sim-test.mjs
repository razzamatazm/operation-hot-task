#!/usr/bin/env node
/* Issue #283 — closing the task form asks before it throws your typing away.
 *
 * The ticket makes three separate promises, and they are tested three ways.
 *
 * 1. WHEN it asks. That is `formHasChanges`, a plain function over the form's
 *    values, and it is tested where the rest of that value logic is tested, in
 *    `create-form-state-sim-test.mjs` — including the ticket's named case, a
 *    changed task type and nothing else.
 * 2. WHAT it says. The wording is the promise, so `discardConfirmCopy` is
 *    asserted literally, and the dialog is rendered through `react-dom/server`
 *    to check it is a real `alertdialog` carrying both answers.
 * 3. HOW it is wired. There is no DOM harness here and no way to type into the
 *    form, so which function each exit calls, and what each answer does, is read
 *    out of `task-form.tsx` — the same way `edit-task-form-sim-test.mjs` reads
 *    the routing decisions it cannot run.
 *
 * What is left for a person: pressing the keys. That the browser delivers
 * Escape to the overlay, that the capture listener beats it to the dialog, and
 * that focus actually lands on "Keep editing" are browser behaviours, not
 * assertions available here.
 *
 * Run: `node --test scripts/discard-confirm-sim-test.mjs`. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { cancelAsks, editFormValues, initialCreateForm } from "../apps/web/src/create-form-state.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));

const FORM_SOURCE = readFileSync(join(REPO, "apps/web/src/task-form.tsx"), "utf8");
const DIALOG_SOURCE = readFileSync(join(REPO, "apps/web/src/discard-confirm.tsx"), "utf8");

/* Both modules are TSX with relative imports, so esbuild bundles rather than
   transforms. The toast provider comes out of the same bundle as the form: it
   calls `useToast`, and a provider imported separately would be a different
   module instance holding a different context. */
const scratch = mkdtempSync(join(REPO, "node_modules", ".discard-confirm-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const entry = join(scratch, "entry.tsx");
writeFileSync(
  entry,
  `export * from ${JSON.stringify(join(REPO, "apps/web/src/discard-confirm.tsx"))};\n` +
    `export { TaskForm } from ${JSON.stringify(join(REPO, "apps/web/src/task-form.tsx"))};\n` +
    `export { ToastProvider } from ${JSON.stringify(join(REPO, "apps/web/src/toast.tsx"))};\n`
);
const bundle = join(scratch, "discard-confirm.mjs");
await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  external: ["react", "react/jsx-runtime", "@loan-tasks/shared"],
  logLevel: "silent"
});
const { DiscardConfirmDialog, TaskForm, ToastProvider, discardConfirmCopy } = await import(pathToFileURL(bundle).href);

/* ── What the person is asked ───────────────────────────── */

/* The ticket specifies this wording exactly, so it is asserted exactly. */
test("the prompt asks the ticket's question, in the ticket's words", () => {
  const copy = discardConfirmCopy();
  assert.equal(copy.title, "Discard this task?");
  assert.equal(copy.body, "Your progress won't be saved.");
});

test("both answers say what they do, rather than OK and Cancel", () => {
  const copy = discardConfirmCopy();
  assert.match(copy.confirm, /discard/i, "the yes throws the typing away");
  assert.match(copy.cancel, /keep editing/i, "the no puts them back where they were");
  assert.doesNotMatch(`${copy.confirm} ${copy.cancel}`, /^OK$|^Cancel$/i);
});

test("the prompt renders as an alert dialog carrying the question and both answers", () => {
  const html = renderToStaticMarkup(
    createElement(DiscardConfirmDialog, { onConfirm: () => {}, onCancel: () => {} })
  );
  assert.match(html, /role="alertdialog"/, "an alertdialog: it interrupts an exit the person already took");
  assert.match(html, /aria-modal="true"/, "and nothing behind it is answerable while it is up");
  assert.match(html, /Discard this task\?/, "the question is on screen");
  assert.match(html, /Your progress won&#x27;t be saved\./, "and so is what is at stake");
  assert.match(html, />Discard</, "the yes is there");
  assert.match(html, />Keep editing</, "and so is the no");
});

/* ── The three-way prompt (#348, ADR-0011) ──────────────── */

/* Once a create form can put the task aside, "your progress won't be saved" is
   no longer true of leaving it, so the create form asks a different question.
   Edit mode has nowhere to save for later and keeps the question above. */
test("a create form's prompt offers Save for later beside Discard and Keep editing, in words that are true", () => {
  const fresh = discardConfirmCopy({ saveForLater: true, reopened: false });
  assert.equal(fresh.title, "Leave this task?");
  assert.equal(fresh.body, "Save it for later to pick it back up from the board, or discard it.");
  assert.equal(fresh.save, "Save for later");
  assert.equal(fresh.confirm, "Discard");
  assert.equal(fresh.cancel, "Keep editing");

  const reopened = discardConfirmCopy({ saveForLater: true, reopened: true });
  assert.equal(reopened.title, "Leave this task?");
  assert.equal(
    reopened.body,
    "Save your changes for later, or discard them and delete this Task Draft.",
    "a reopened one says Discard deletes the Task Draft (#388)"
  );
  assert.doesNotMatch(reopened.body, /keep the version/, "and no longer promises to keep the earlier save");
  assert.equal(reopened.save, "Save for later");
  assert.doesNotMatch(`${fresh.body} ${reopened.body}`, /won.t be saved/, "nothing claims the progress is lost when it need not be");
});

test("the three-way prompt renders all three answers, safe first and destructive last", () => {
  const html = renderToStaticMarkup(
    createElement(DiscardConfirmDialog, { onConfirm: () => {}, onCancel: () => {}, onSaveForLater: () => {} })
  );
  assert.match(html, /role="alertdialog"/);
  assert.match(html, /Leave this task\?/);
  assert.match(
    html,
    /<button type="button" class="btn-sm btn-ghost">Keep editing<\/button><button type="button" class="btn-sm btn-ghost">Save for later<\/button><button type="button" class="btn-sm btn-danger">Discard<\/button>/,
    "Keep editing, then Save for later, then Discard in the danger style"
  );
});

test("a reopened form's prompt says its Discard deletes the Task Draft", () => {
  const html = renderToStaticMarkup(
    createElement(DiscardConfirmDialog, { onConfirm: () => {}, onCancel: () => {}, onSaveForLater: () => {}, reopened: true })
  );
  assert.match(html, /discard them and delete this Task Draft/);
  assert.doesNotMatch(html, /keep the version you saved before/);
});

/* ── Discard on a reopened Task Draft deletes it (#388, #399) ─── */

/* Pressing Discard on a draft you opened means you don't want the draft. The
   prompt's body already says Discard deletes it, so the prompt is the
   confirmation (#399): there is no second question. While the delete is out,
   Discard says so, so a slow delete does not look like a dead button. */
test("a reopened draft's Discard reads Deleting… while busy; every other Discard keeps its label", () => {
  const reopened = discardConfirmCopy({ saveForLater: true, reopened: true });
  assert.equal(reopened.confirm, "Discard", "at rest it is still Discard");
  assert.equal(reopened.busy, "Deleting…");
  assert.equal(discardConfirmCopy({ saveForLater: true, reopened: false }).busy, "Discard", "a new task's busy Discard is unchanged");
  assert.equal(discardConfirmCopy().busy, "Discard", "and so is edit mode's");
});

test("while a reopened draft's delete is out, all three answers are shut and Discard reads Deleting…", () => {
  const busy = renderToStaticMarkup(
    createElement(DiscardConfirmDialog, { onConfirm: () => {}, onCancel: () => {}, onSaveForLater: () => {}, reopened: true, busy: true })
  );
  assert.match(
    busy,
    /<button type="button" class="btn-sm btn-ghost" disabled="">Keep editing<\/button><button type="button" class="btn-sm btn-ghost" disabled="">Save for later<\/button><button type="button" class="btn-sm btn-danger" disabled="">Deleting…<\/button>/
  );
  const idle = renderToStaticMarkup(
    createElement(DiscardConfirmDialog, { onConfirm: () => {}, onCancel: () => {}, onSaveForLater: () => {}, reopened: true })
  );
  assert.match(idle, /<button type="button" class="btn-sm btn-danger">Discard<\/button>/, "at rest it reads Discard");
  const fresh = renderToStaticMarkup(
    createElement(DiscardConfirmDialog, { onConfirm: () => {}, onCancel: () => {}, onSaveForLater: () => {}, busy: true })
  );
  assert.match(fresh, /<button type="button" class="btn-sm btn-danger" disabled="">Discard<\/button>/, "a new task's busy Discard renders as before");
});

test("the second delete question is gone: the dialog module exports only the prompt and its copy", () => {
  assert.deepEqual(
    [...DIALOG_SOURCE.matchAll(/^export const (\w+)/gm)].map((m) => m[1]).sort(),
    ["DiscardConfirmDialog", "discardConfirmCopy"],
    "no second dialog and no copy for one"
  );
  assert.doesNotMatch(FORM_SOURCE, /deleteAsk|keepReopened|deleteReopened/, "and the form has no state or handler for one");
});

const fnBody = (name) => {
  const fn = FORM_SOURCE.slice(FORM_SOURCE.indexOf(name));
  return fn.slice(0, fn.indexOf("\n  };"));
};

test("Discard on a reopened form deletes the Task Draft at once: shut, settle, delete, say so if it did not land, close", () => {
  const body = fnBody("const confirmDiscard");
  const start = body.indexOf("if (reopened && onDeleteReopened) {");
  assert.ok(start >= 0, "a reopened form with somewhere to delete it");
  const branch = body.slice(start, body.indexOf("forgetDraft();"));
  const at = (s) => branch.indexOf(s);
  assert.match(branch, /if \(discarding\) return;/, "a second press does nothing");
  assert.ok(at("setDiscarding(true);") >= 0 && at("setDiscarding(true);") < at("await "), "answers shut before anything is awaited");
  assert.ok(at("await settleUnsaved();") >= 0, "a keystroke's write in flight lands first, and none follows");
  assert.ok(at("await settleUnsaved();") < at("await onDeleteReopened(reopened.id)"), "so it cannot bring the record back after the delete");
  assert.match(branch, /if \(!\(await onDeleteReopened\(reopened\.id\)\)\) \{\s*showToast\("Couldn't delete that Task Draft\. It's still on Task Drafts\.", \{ variant: "warn" \}\);/);
  assert.match(branch, /\}\s*onClose\(\);\s*return;/, "and the form closes either way");
  assert.doesNotMatch(branch, /setDiscardAsk|onDiscardUnsaved|onSaveForLater|onKeepUnsaved/, "the prompt stays up reading Deleting…, and nothing clears only the slot or writes the save");
});

test("App deletes a reopened Task Draft through the row's own removal, and drops it from the tab", () => {
  const APP_SOURCE = readFileSync(join(REPO, "apps/web/src/App.tsx"), "utf8");
  const createMount = APP_SOURCE.match(/\{formOpen && \(\s*<TaskForm([\s\S]*?)\/>/)?.[1];
  assert.match(createMount, /onDeleteReopened=\{onDeleteReopened\}/);
  const cb = APP_SOURCE.match(/const onDeleteReopened = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\);/)?.[0];
  assert.ok(cb, "App has the callback");
  assert.match(cb, /const removed = await removeSavedForLaterRequest\(savedForLaterRequestFor\(user\), savedId\);/, "the same removal the row's delete and Create use, which counts a 404 as gone");
  assert.match(cb, /if \(removed && user\.id === savedForLaterOwner\.current\) setSavedForLater\(\(current\) => current\.filter\(\(saved\) => saved\.id !== savedId\)\);/, "the row leaves the tab, and the count with it, only for the person it belongs to");
  assert.match(cb, /return removed;/);
  assert.doesNotMatch(cb, /showToast/, "the form says what went wrong, once");
});

test("a new task's Discard and edit mode's still close on the first answer, with no second question", () => {
  const body = fnBody("const confirmDiscard");
  assert.match(body, /\}\s*setDiscarding\(true\);\s*forgetDraft\(\);\s*await settleUnsaved\(\);\s*onClose\(\);\s*$/, "forget the autosave, settle, close, as before");
  assert.match(FORM_SOURCE, /\{discardAsk && <DiscardConfirmDialog onConfirm=\{confirmDiscard\}/, "the first prompt is unchanged");
});

test("Save for later in the prompt is unavailable exactly when the footer's is", () => {
  const html = renderToStaticMarkup(
    createElement(DiscardConfirmDialog, { onConfirm: () => {}, onCancel: () => {}, onSaveForLater: () => {}, saveForLaterDisabled: true })
  );
  assert.match(html, /<button type="button" class="btn-sm btn-ghost" disabled="">Save for later<\/button>/);
});

test("while a Discard is being carried out, every answer is shut and Escape does nothing", () => {
  const html = renderToStaticMarkup(
    createElement(DiscardConfirmDialog, { onConfirm: () => {}, onCancel: () => {}, onSaveForLater: () => {}, busy: true })
  );
  assert.equal([...html.matchAll(/<button type="button" class="btn-sm btn-[a-z]+" disabled="">/g)].length, 3, "all three answers");
  const key = DIALOG_SOURCE.slice(DIALOG_SOURCE.indexOf("const onKey"));
  assert.match(key.slice(0, key.indexOf("};")), /if \(!busy\) onCancel\(\);/);
  const confirm = FORM_SOURCE.slice(FORM_SOURCE.indexOf("const confirmDiscard"));
  const body = confirm.slice(0, confirm.indexOf("\n  };"));
  assert.ok(body.indexOf("setDiscarding(true);") >= 0 && body.indexOf("setDiscarding(true);") < body.indexOf("await "), "shut before anything is awaited");
  assert.match(FORM_SOURCE, /busy=\{discarding\} onCancel=\{\(\) => setDiscardAsk\(false\)\}/);
});

test("without Save for later the prompt is the two-way one, word for word", () => {
  const html = renderToStaticMarkup(createElement(DiscardConfirmDialog, { onConfirm: () => {}, onCancel: () => {} }));
  assert.doesNotMatch(html, /Save for later/);
  assert.match(html, /Discard this task\?/);
});

test("the form offers Save for later in the prompt on a create form only, and edit mode's prompt is unchanged", () => {
  const mount = FORM_SOURCE.slice(FORM_SOURCE.indexOf("{discardAsk &&"));
  const line = mount.slice(0, mount.indexOf("\n"));
  assert.match(
    line,
    /\{\.\.\.\(!editing && onSaveForLater \? \{ onSaveForLater: saveFromPrompt, saveForLaterDisabled: !worthSavingForLater, reopened: reopened !== undefined \} : \{\}\)\}/,
    "the three-way prompt is the create form's, with the footer button's own availability"
  );
  const fromPrompt = FORM_SOURCE.slice(FORM_SOURCE.indexOf("const saveFromPrompt"));
  const body = fromPrompt.slice(0, fromPrompt.indexOf("};"));
  assert.match(body, /setDiscardAsk\(false\);/, "the prompt comes down, so a failed save leaves the form in view");
  assert.match(body, /saveForLater\(\)/, "and it is the footer's own Save for later, not a second copy of it");
});

/* Flipped by #388, then by #399: this first asserted that Discard on a reopened
   form cleared only its unsaved typing and left the saved version as it was,
   then that a second question stood between Discard and the delete. The rule
   now is that Discard on the prompt deletes the Task Draft. */
test("Discard on a reopened form no longer keeps the save: it deletes the Task Draft, then closes", () => {
  const body = fnBody("const confirmDiscard");
  assert.doesNotMatch(body, /onDiscardUnsaved/, "the unsaved slot is not what Discard clears any more");
  assert.match(body, /await onDeleteReopened\(reopened\.id\)/, "the record itself goes");
  assert.match(body, /showToast\(/, "and a delete the server could not carry out is said, rather than coming back as a surprise");
  assert.ok(body.indexOf("await onDeleteReopened") < body.indexOf("onClose();"), "and only then does it close");
  assert.doesNotMatch(body, /onSaveForLater|onKeepUnsaved/, "nothing writes the save");
});

/* Built as the merge confirmation is (#265), because two dialogs that behave
   differently are two dialogs people have to read twice. */
test("the safe answer takes focus, and the backdrop answers nothing", () => {
  assert.match(DIALOG_SOURCE, /cancelRef\.current\?\.focus\(\)/, "focus lands on Keep editing, not on Discard");
  const overlay = DIALOG_SOURCE.slice(DIALOG_SOURCE.indexOf('className="discard-confirm-overlay"'));
  assert.doesNotMatch(overlay.slice(0, overlay.indexOf(">")), /onClick/, "the backdrop is inert, like the form's");
});

/* Escape opened this dialog by way of the form's overlay handler. Without the
   stop, the same keypress passes through and closes the form anyway — which is
   the precise thing being guarded against. */
test("Escape declines, and does not reach the form behind the dialog", () => {
  const key = DIALOG_SOURCE.slice(DIALOG_SOURCE.indexOf("const onKey"));
  assert.match(key, /e\.stopPropagation\(\)/, "the keypress stops here");
  assert.match(key, /onCancel\(\)/, "and the safe answer is the one Escape gives");
  assert.match(DIALOG_SOURCE, /addEventListener\("keydown", onKey, true\)/, "captured, so it runs first");
});

/* ── How the form is wired to it ────────────────────────── */

test("Cancel and Escape are the same door, so they cannot answer differently", () => {
  assert.match(
    FORM_SOURCE,
    /onKeyDown=\{\(e\) => \{ if \(e\.key === "Escape"\) requestClose\(\); \}\}/,
    "Escape asks to close"
  );
  assert.match(FORM_SOURCE, /className="btn-ghost" onClick=\{requestClose\}>Cancel</, "and so does Cancel");
  assert.equal(FORM_SOURCE.match(/requestClose\(?\)?[;}]/g).length, 2, "there are exactly those two exits");
});

/* When the exit asks (#365). Edit mode asks once something moved since the form
   opened, as it always has. A create form asks whenever there is anything in it:
   a reopened Saved for Later task always, and a new one whenever it differs from
   a blank form, which is the Save for later button's own test. Whether it
   changed since it opened no longer matters there, so a form restored from the
   autosave and left alone still asks. */
test("when Cancel asks, as a truth table over the three ways a form opens", () => {
  const BLANK = initialCreateForm();
  const TYPED = { ...BLANK, folderName: "Whitfield 4471", notes: "half a thought" };
  const SAVED = { ...BLANK, folderName: "Baker - Pier 9", taskType: "FRAUD", urgency: "ORANGE" };
  const TASK_VALUES = () => editFormValues(TASK);
  const EDITED = { ...TASK_VALUES(), notes: "Loan Amount: $2,400,000" };
  const cases = [
    [{ editing: false, reopened: false, opened: BLANK, fresh: BLANK, current: BLANK }, false, "a completely empty new task closes without a prompt"],
    [{ editing: false, reopened: false, opened: BLANK, fresh: BLANK, current: BLANK, pendingItemText: "   " }, false, "a seeder box holding only spaces is still empty"],
    [{ editing: false, reopened: false, opened: BLANK, fresh: BLANK, current: TYPED }, true, "a new task with typing in it asks"],
    [{ editing: false, reopened: false, opened: BLANK, fresh: BLANK, current: BLANK, pendingItemText: "Missing appraisal" }, true, "a half-typed outstanding item is something in it"],
    [{ editing: false, reopened: false, opened: TYPED, fresh: BLANK, current: TYPED }, true, "a new task restored from the autosave and left untouched asks"],
    [{ editing: false, reopened: false, opened: BLANK, fresh: BLANK, current: { ...BLANK, taskType: "VALUE" } }, true, "a changed task type on its own is something in it"],
    [{ editing: false, reopened: true, opened: SAVED, fresh: BLANK, current: SAVED }, true, "an unchanged reopened Saved for Later task asks"],
    [{ editing: false, reopened: true, opened: SAVED, fresh: BLANK, current: { ...SAVED, notes: "more" } }, true, "a changed reopened one asks, as before"],
    [{ editing: true, reopened: false, opened: TASK_VALUES(), fresh: TASK_VALUES(), current: TASK_VALUES() }, false, "edit mode, unchanged, closes silently as before"],
    [{ editing: true, reopened: false, opened: TASK_VALUES(), fresh: TASK_VALUES(), current: EDITED }, true, "edit mode, changed, asks as before"]
  ];
  for (const [state, expected, why] of cases) assert.equal(cancelAsks(state), expected, why);
});

test("the exit asks through that one rule, and closes on the spot when it says no", () => {
  const close = FORM_SOURCE.slice(FORM_SOURCE.indexOf("const requestClose"));
  const body = close.slice(0, close.indexOf("};"));
  assert.match(
    body,
    /cancelAsks\(\{ editing, reopened: reopened !== undefined, opened: openedWith\.current, fresh: opening\.fresh, current: form, pendingItemText: seedDraft \}\)/,
    "edit mode against the values it opened with, a create form against a blank one, the seeder's half-typed item counted in both"
  );
  assert.match(body, /setDiscardAsk\(true\)/, "a form with something to lose asks");
  assert.match(body, /return;\s*\}\s*onClose\(\);/, "anything else closes on the spot");
  assert.doesNotMatch(body, /sendUnsaved/, "a reopened form never takes the silent exit, so it has nothing to send on the way out");
  assert.match(FORM_SOURCE, /const openedWith = useRef\(form\)/, "the opening values are captured once, at open");
});

/* The yes was a bare `onClose` when this shipped, and #284 hung the saved
   draft's deliberate deletion on it — Cancel is the one exit that means "forget
   this task", which is why the prompt shipped first. `confirmDiscard` closes the
   form exactly as before and forgets the draft on the way; what it clears is
   asserted in `task-draft-form-sim-test.mjs`. */
test("saying yes closes the form, and is where the draft is deliberately forgotten", () => {
  const mount = FORM_SOURCE.slice(FORM_SOURCE.indexOf("{discardAsk &&"));
  const line = mount.slice(0, mount.indexOf("\n"));
  assert.match(line, /onConfirm=\{confirmDiscard\}/, "confirming goes through one named function");
  const confirm = FORM_SOURCE.slice(FORM_SOURCE.indexOf("const confirmDiscard"));
  assert.match(confirm.slice(0, confirm.indexOf("};")), /onClose\(\);/, "which still does what closing always did");
  assert.match(line, /onCancel=\{\(\) => setDiscardAsk\(false\)\}/, "declining only lowers the prompt");
  assert.doesNotMatch(
    line.slice(line.indexOf("onCancel")),
    /onClose/,
    "a decline never closes anything — the form stays exactly as it was"
  );
});

/* The dialog has to clear the form modal (z-index 50) and a toast (60), and a
   child of the overlay could not: the overlay's own z-index makes a stacking
   context its children are trapped inside. */
test("the prompt is mounted beside the form's overlay, above everything", () => {
  assert.ok(
    FORM_SOURCE.indexOf("{discardAsk &&") < FORM_SOURCE.indexOf('className="form-overlay"'),
    "it is a sibling of the overlay, not a child of it"
  );
  const css = readFileSync(join(REPO, "apps/web/src/styles.css"), "utf8");
  /* The selector where it is declared, not the earlier mention of it in the
     form modal's comment. */
  const overlay = css.slice(css.indexOf("\n.discard-confirm-overlay {"));
  assert.match(overlay.slice(0, overlay.indexOf("}")), /z-index: 70/, "above the form modal's 50 and a toast's 60");
});

/* The backdrop was made inert by #114 and stays inert: clicking it is still not
   an exit, and it does not raise the prompt either. */
test("the grey backdrop is still not a way out, and still asks nothing", () => {
  const overlay = FORM_SOURCE.slice(FORM_SOURCE.indexOf('className="form-overlay"'));
  const openingTag = overlay.slice(0, overlay.indexOf(">"));
  assert.doesNotMatch(openingTag, /onClick/, "nothing on the overlay listens for a click");
});

/* ── The form itself, rendered ──────────────────────────── */

const DIRECTORY = [{ id: "user-2", displayName: "Sam Checker", roles: ["FILE_CHECKER"] }];
const USER = { id: "user-1", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] };

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

const TASK = {
  taskType: "LOI",
  notes: "Loan Amount: $2,340,000",
  folderName: "Whitfield 4471",
  humperdinkLink: "https://h.example/whitfield-4471",
  urgency: "GREEN",
  points: 2,
  createdBy: { id: USER.id, displayName: USER.displayName }
};

/* A form's first paint is always the untouched one — it seeds itself and nobody
   has typed yet — so this is the "no prompt until there is something to lose"
   promise at the only moment this harness can see it. */
test("a freshly opened form shows no prompt, in either mode", () => {
  for (const [mode, html] of [
    ["new task", render()],
    ["edit", render({ edit: { task: TASK, onSave: async () => {} } })]
  ]) {
    assert.doesNotMatch(html, /role="alertdialog"/, `${mode}: nothing is being asked yet`);
    assert.doesNotMatch(html, /Discard this task\?/, `${mode}: and nothing says so`);
    assert.match(html, />Cancel</, `${mode}: the exit is still there`);
  }
});
