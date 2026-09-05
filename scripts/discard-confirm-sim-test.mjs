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

test("the exit asks only when there is something to lose, measured from the opening form", () => {
  const close = FORM_SOURCE.slice(FORM_SOURCE.indexOf("const requestClose"));
  const body = close.slice(0, close.indexOf("};"));
  assert.match(
    body,
    /formHasChanges\(openedWith\.current, form, seedDraft\)/,
    "against the values the form opened with, plus the seeder's half-typed item"
  );
  assert.match(body, /setDiscardAsk\(true\)/, "a touched form asks");
  assert.match(body, /else onClose\(\)/, "an untouched one closes on the spot, as it always did");
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
