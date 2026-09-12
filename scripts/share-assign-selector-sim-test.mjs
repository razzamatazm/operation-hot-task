#!/usr/bin/env node
/* Issue #364 — the create form's Share / Assign selector lost its selected state.
 *
 * #326 deleted every `.seg` rule from styles.css while taking the board's
 * Grouped/Flat segment away. The create form still emitted `seg` and `seg-on`,
 * so the selector fell back to the base filled button: two solid buttons side
 * by side and nothing saying which one was on. Nothing failed, because a class
 * with no rule behind it is not an error anywhere — it renders, it typechecks,
 * and it looks like a different design.
 *
 * So this renders the form in both states and reads the selector back:
 *
 *   - every class the selector emits has a rule in styles.css (comments
 *     stripped, so a class named only in prose does not count);
 *   - exactly one half is pressed, and the pressed half carries a class the
 *     other does not, whose rule changes the fill;
 *   - the pressed state follows the form's own `pickerMode`, which is what makes
 *     a press move it on the next render;
 *   - no rule on the control declares a box-shadow or an outline outside
 *     `:focus-visible`, so the base ring is left standing on both halves, and a
 *     `:focus-visible` rule on it still draws `--focus-ring`.
 *
 * What is left for a person: how it looks in light, dark and contrast, and
 * tabbing onto it. Named in the PR.
 *
 * Run: `node --test scripts/share-assign-selector-sim-test.mjs`. */
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
const CSS = readFileSync(join(REPO, "apps/web/src/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const scratch = mkdtempSync(join(REPO, "node_modules", ".share-assign-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const entry = join(scratch, "entry.tsx");
writeFileSync(
  entry,
  `export { TaskForm } from ${JSON.stringify(join(REPO, "apps/web/src/task-form.tsx"))};\n` +
    `export { ToastProvider } from ${JSON.stringify(join(REPO, "apps/web/src/toast.tsx"))};\n` +
    `export * from ${JSON.stringify(join(REPO, "apps/web/src/create-form-draft.ts"))};\n`
);
const bundle = join(scratch, "share-assign.mjs");
await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  external: ["react", "react/jsx-runtime", "@loan-tasks/shared"],
  logLevel: "silent"
});
const { TaskForm, ToastProvider, draftKey, serializeDraft } = await import(pathToFileURL(bundle).href);
const { BLANK_CREATE_FORM } = await import(pathToFileURL(join(REPO, "apps/web/src/create-form-state.ts")).href);

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

/* The mode is only reachable through state, so the Assign render opens on a
   restored draft that chose it — the one way a first paint can hold it. */
const renderIn = (pickerMode) => {
  storage.clear();
  if (pickerMode !== BLANK_CREATE_FORM.pickerMode) {
    storage.set(
      draftKey(USER.id),
      serializeDraft({ ...BLANK_CREATE_FORM, folderName: "Adams - Harbor", pickerMode }, Date.now())
    );
  }
  return renderToStaticMarkup(
    createElement(ToastProvider, null, createElement(TaskForm, {
      loans: [],
      directory: DIRECTORY,
      user: USER,
      tasks: [],
      onClose: () => {},
      onCreate: async () => {}
    }))
  );
};

const classesOf = (attrs) => (attrs.match(/\bclass="([^"]*)"/)?.[1] ?? "").split(/\s+/).filter(Boolean);

const selector = (html) => {
  const open = html.match(/<div([^>]*)aria-label="Share or assign"([^>]*)>/);
  assert.ok(open, "the create form draws the Share / Assign selector");
  const attrs = open[1] + open[2];
  assert.match(attrs, /role="group"/, "the selector keeps role=group");
  const body = html.slice(open.index + open[0].length, html.indexOf("</div>", open.index));
  const buttons = [...body.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map(([, a, label]) => ({
    label,
    classes: classesOf(a),
    pressed: a.match(/aria-pressed="(true|false)"/)?.[1]
  }));
  return { classes: classesOf(attrs), buttons };
};

const ruleFor = (cls) => new RegExp(`\\.${cls.replace(/[-]/g, "\\-")}(?![\\w-])`);
const blocksFor = (cls) =>
  [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, sel]) => ruleFor(cls).test(sel))
    .map(([, , decls]) => decls);

const STATES = { share: selector(renderIn("share")), assign: selector(renderIn("assign")) };

test("every class the selector emits has a rule in styles.css", () => {
  for (const [mode, { classes, buttons }] of Object.entries(STATES)) {
    assert.ok(classes.length > 0, `${mode}: the group carries a class`);
    for (const b of buttons) assert.ok(b.classes.length > 0, `${mode}: "${b.label}" carries a class, not the bare filled button`);
    for (const cls of [...classes, ...buttons.flatMap((b) => b.classes)]) {
      assert.match(CSS, ruleFor(cls), `${mode}: .${cls} is emitted with no rule behind it`);
    }
  }
});

test("exactly one half is pressed, and it is the one the form's mode names", () => {
  for (const [mode, { buttons }] of Object.entries(STATES)) {
    assert.equal(buttons.length, 2, `${mode}: two halves`);
    const pressed = buttons.filter((b) => b.pressed === "true");
    assert.equal(pressed.length, 1, `${mode}: one half is pressed`);
    assert.equal(buttons.filter((b) => b.pressed === "false").length, 1, `${mode}: the other says so`);
    assert.equal(pressed[0].label.toLowerCase(), mode, `${mode}: the pressed half is ${mode}`);
  }
});

test("the pressed half carries a selected class whose rule changes the fill", () => {
  for (const [mode, { buttons }] of Object.entries(STATES)) {
    const on = buttons.find((b) => b.pressed === "true");
    const off = buttons.find((b) => b.pressed === "false");
    const only = on.classes.filter((c) => !off.classes.includes(c));
    assert.equal(only.length, 1, `${mode}: one class marks the selected half`);
    const decls = blocksFor(only[0]).join("\n");
    assert.match(decls, /--btn-bg\s*:|background\s*:/, `${mode}: .${only[0]} changes the fill`);
  }
  assert.deepEqual(
    STATES.share.buttons.map((b) => b.classes),
    [...STATES.assign.buttons.map((b) => b.classes)].reverse(),
    "pressing the other half swaps the classes rather than restyling either"
  );
});

test("a press sets the mode the pressed state is read from", () => {
  for (const mode of ["share", "assign"]) {
    assert.match(
      FORM_SOURCE,
      new RegExp(`aria-pressed=\\{form\\.pickerMode === "${mode}"\\}\\s*onClick=\\{\\(\\) => setForm\\(\\(c\\) => \\(\\{ \\.\\.\\.c, pickerMode: "${mode}" \\}\\)\\)\\}`),
      `the ${mode} half is pressed by, and sets, form.pickerMode`
    );
  }
});

test("the control keeps a focus ring on both halves and does not bring back the board's segment", () => {
  const { classes, buttons } = STATES.share;
  const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, decls]) => ({ sel: sel.trim(), decls }));
  for (const cls of new Set([...classes, ...buttons.flatMap((b) => b.classes), ...STATES.assign.buttons.flatMap((b) => b.classes)])) {
    for (const { sel, decls } of rules.filter((r) => ruleFor(cls).test(r.sel))) {
      if (/:focus-visible/.test(sel)) {
        assert.match(decls, /box-shadow\s*:[^;]*var\(--focus-ring\)/, `${sel} still draws --focus-ring`);
        assert.doesNotMatch(decls, /outline\s*:/, `${sel} does not swap the ring for an outline`);
      } else {
        assert.doesNotMatch(decls, /box-shadow\s*:|outline\s*:/, `${sel} would cover button:focus-visible's ring`);
      }
    }
  }
  assert.doesNotMatch(CSS, /\.seg(?:-on)?(?![\w-])/, "no generic .seg or .seg-on rule is back");
});
