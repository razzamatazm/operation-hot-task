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
const { DiscardConfirmDialog, TaskForm, ToastProvider, discardConfirmCopy } = await import(
  pathToFileURL(bundle).href
);

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
    "Save your changes for later, or discard them and keep the version you saved before.",
    "a reopened one says Discard throws away the changes, not the saved task"
  );
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

test("a reopened form's prompt says its Discard keeps the earlier save", () => {
  const html = renderToStaticMarkup(
    createElement(DiscardConfirmDialog, { onConfirm: () => {}, onCancel: () => {}, onSaveForLater: () => {}, reopened: true })
  );
  assert.match(html, /keep the version you saved before/);
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

test("Discard on a reopened form throws away only its unsaved typing, then closes", () => {
  const confirm = FORM_SOURCE.slice(FORM_SOURCE.indexOf("const confirmDiscard"));
  const body = confirm.slice(0, confirm.indexOf("\n  };"));
  assert.match(body, /if \(reopened && onDiscardUnsaved\b/, "only a reopened form has unsaved typing on the server");
  assert.match(body, /showToast\(/, "and a Discard the server could not carry out is said, rather than coming back as a surprise");
  assert.match(body, /await onDiscardUnsaved\(reopened\.id\)/, "the unsaved slot, never the record");
  assert.ok(body.indexOf("await onDiscardUnsaved") < body.lastIndexOf("onClose();"), "and only then does it close");
  assert.doesNotMatch(body, /onSaveForLater|removeSavedForLater/, "the saved version is left as it was");
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
