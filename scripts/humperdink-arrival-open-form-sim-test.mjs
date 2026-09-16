#!/usr/bin/env node
/* A Humperdink arrival never costs someone a new task form they opened while
   Hot Task was still loading (#420).

   Pressing Send to Hot Task reloads the tab. Someone who opens New Task after
   that reload but before the arrival is recognised used to lose the arrival
   entirely: the form stayed, no LOI Check opened, and the clipboard was never
   read. Now the open form is put away first — saved to Task Drafts through the
   form's own Save for later, the same write that clears the autosave slot, so
   it is listed once and not also as Autosaved — and then the arrival goes on as
   usual.

   An untouched form is nothing to keep, so it just closes. A save that fails is
   the one outcome that must lose nothing: the form stays open exactly as it
   was, and the arrival is dropped as it was before.

   Two techniques, the arrangement the sibling arrival tests use:

   1. DRIVEN. The rule (`putFormAside`) is framework-free and handed the save and
      the close, so it runs against fakes.
   2. READ OUT OF THE SOURCE. Effects don't run in a static render, so App's
      wiring and the form's registration are asserted against the source.

   Run: `node --test scripts/humperdink-arrival-open-form-sim-test.mjs`. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const APP_SOURCE = readFileSync(join(REPO, "apps/web/src/App.tsx"), "utf8");
const FORM_SOURCE = readFileSync(join(REPO, "apps/web/src/task-form.tsx"), "utf8");

const scratch = mkdtempSync(join(REPO, "node_modules", ".humperdink-arrival-open-form-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const entry = join(scratch, "entry.tsx");
const src = (file) => JSON.stringify(join(REPO, "apps/web/src", file));
writeFileSync(entry, `export { putFormAside } from ${src("humperdink-arrival.ts")};\n`);
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
const { putFormAside } = await import(pathToFileURL(bundle).href);

/* The form's own Save for later and its close, as fakes that record the press. */
const openForm = ({ worthKeeping = true, saves = true } = {}) => {
  const calls = [];
  return {
    calls,
    put: () =>
      putFormAside({
        worthKeeping,
        saveForLater: async () => {
          calls.push("saveForLater");
          return saves;
        },
        close: () => calls.push("close")
      })
  };
};

/* ── Putting the open form away ─────────────────────────── */

test("a form with typing in it is saved through the form's own Save for later", async () => {
  const form = openForm({ worthKeeping: true });
  assert.equal(await form.put(), "saved");
  assert.deepEqual(form.calls, ["saveForLater"]);
});

test("an untouched form is nothing to keep, so it closes and no draft is made", async () => {
  const form = openForm({ worthKeeping: false });
  assert.equal(await form.put(), "closed");
  assert.deepEqual(form.calls, ["close"]);
});

test("a save that didn't land leaves the form open: nothing typed is thrown away", async () => {
  const form = openForm({ worthKeeping: true, saves: false });
  assert.equal(await form.put(), "failed");
  assert.deepEqual(form.calls, ["saveForLater"]);
});

/* ── The wiring ─────────────────────────────────────────── */

test("the arrival puts an open form away before it moves the autosave", () => {
  const effect = APP_SOURCE.slice(APP_SOURCE.indexOf("arrivalMove.current = (async () => {"));
  const put = effect.indexOf("formSaveAside.current");
  const move = effect.indexOf("moveAutosaveAside");
  assert.ok(put > -1, "the arrival asks the open form to put itself away");
  assert.ok(put < move, "it does that before the autosave move, not after");
});

test("a put that failed drops the arrival, and opens no LOI Check over the form", () => {
  const effect = APP_SOURCE.slice(APP_SOURCE.indexOf("arrivalMove.current = (async () => {"));
  const dropped = effect.indexOf('if (asideOutcome === "failed") return;');
  const opens = effect.indexOf("setFormOpen(true)");
  assert.ok(dropped > -1, "a failed put returns rather than going on");
  assert.ok(dropped < opens, "and it returns before the form is opened");
});

test("App hands its Save for later handle to the create form, and never to the edit form", () => {
  assert.match(APP_SOURCE, /arrivalAside=\{formSaveAside\}/);
  const editForm = APP_SOURCE.slice(APP_SOURCE.indexOf("{editingTask && ("));
  assert.ok(!editForm.includes("arrivalAside"), "an edit form is never put away by an arrival");
});

test("a reopened Task Draft is left alone, the way an edit form is", () => {
  /* Neither can be open in this window: a draft is only reachable from the
     drafts list and a task only from the board, and both load behind sign-in,
     which is the very thing still out here. If one ever could be, it is left
     where it is and the arrival is dropped — the form registers nothing, so
     App finds no handle to press and drops the arrival on its own. */
  assert.match(FORM_SOURCE, /if \(!arrivalAside \|\| editing \|\| reopened\) return;/);
});

test("the form registers its own Save for later, through the one rule", () => {
  assert.match(FORM_SOURCE, /putFormAside\(/);
  assert.match(FORM_SOURCE, /worthKeeping: worthSavingForLater/);
  assert.ok(
    FORM_SOURCE.includes("arrivalAside.current = null"),
    "and takes the handle back when it unmounts, so a closed form is never pressed"
  );
});

test("Save for later says whether it landed, which is what the arrival waits on", () => {
  const handler = FORM_SOURCE.slice(FORM_SOURCE.indexOf("const saveForLater = async ()"));
  assert.match(handler.slice(0, handler.indexOf("};")), /return true;[\s\S]*return false;/);
});
