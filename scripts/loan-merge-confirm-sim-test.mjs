#!/usr/bin/env node
/* Issue #265 / ADR-0008 rule 7 — a link edit that would fold two loans together
 * asks first, and names the other loan.
 *
 * The server half of this ticket lives in `loan-sim-test.mjs`: the refusal, the
 * confirmed merge, and the fact that merging at task creation still needs no
 * confirmation. What is left is the asking, which is three separate promises and
 * is tested three ways.
 *
 * 1. Recognising the question. The save has to tell "another loan holds this
 *    link" apart from every other way a request can fail — the first is a
 *    question, everything else is an error. `linkCollisionIn` is that rule as a
 *    pure function.
 * 2. The words. The ticket's promise is that the other loan is NAMED, so the
 *    person is making a decision rather than clearing a dialog. `mergeConfirmCopy`
 *    is asserted directly, and the dialog is rendered through `react-dom/server`
 *    to check it is a real `alertdialog` with both answers on it.
 * 3. The round trip. Whether a decline sends nothing and a confirm re-sends with
 *    the flag lives in `App.tsx`, which cannot be imported here — no DOM, and it
 *    boots Teams on load. That is read out of the source, the same way
 *    `edit-task-form-sim-test.mjs` reads the routing decisions it can't run.
 *
 * Run: `node --test scripts/loan-merge-confirm-sim-test.mjs`. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/* The module is TSX, so esbuild bundles it the way the edit-form test bundles
   the form. React stays external so the render below uses this process's copy. */
const scratch = mkdtempSync(join(REPO, "node_modules", ".merge-confirm-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const entry = join(scratch, "entry.tsx");
writeFileSync(entry, `export * from ${JSON.stringify(join(REPO, "apps/web/src/loan-merge-confirm.tsx"))};\n`);
const bundle = join(scratch, "loan-merge-confirm.mjs");
await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  external: ["react", "react/jsx-runtime"],
  logLevel: "silent"
});
const { MergeConfirmDialog, MergeDeclined, linkCollisionIn, mergeConfirmCopy } = await import(
  pathToFileURL(bundle).href
);

const APP = readFileSync(join(REPO, "apps/web/src/App.tsx"), "utf8");

/* ── Telling a question from an error ───────────────────── */

const COLLISION = {
  loanId: "loan-9",
  loanName: "Harbor 41",
  /* The survivor is the OLDER record, which is usually the loan already there —
     so the record that disappears is often the one being edited. The server says
     which way round it goes; the dialog must not assume. */
  survivingName: "Harbor 41",
  absorbedName: "Harbour 41 (new)"
};

test("a 409 naming another loan is read as a merge question", () => {
  assert.deepEqual(
    linkCollisionIn({ status: 409, body: { error: "…already on \"Harbor 41\"…", collision: COLLISION } }),
    COLLISION
  );
});

test("every other failure stays an error, and is never turned into a dialog", () => {
  assert.equal(linkCollisionIn(new Error("Network down")), undefined, "a plain failure is not a question");
  assert.equal(linkCollisionIn({ status: 400, body: { error: "Loan name is required" } }), undefined, "nor is a bad request");
  assert.equal(linkCollisionIn({ status: 404, body: { error: "Loan not found" } }), undefined, "nor a missing loan");
  assert.equal(linkCollisionIn(undefined), undefined, "nor nothing at all");
});

/* A dialog that asks "merge with …?" and cannot fill in the blank is worse than
   the plain error it replaced — the person would be agreeing to something
   unnamed. So a malformed collision falls back to the error path. */
test("a collision the server did not name is not asked about", () => {
  assert.equal(linkCollisionIn({ status: 409, body: { error: "conflict" } }), undefined, "no collision at all");
  assert.equal(linkCollisionIn({ status: 409, body: { collision: { loanId: "l" } } }), undefined, "no name");
  assert.equal(
    linkCollisionIn({ status: 409, body: { collision: { ...COLLISION, loanName: "  " } } }),
    undefined,
    "a blank name"
  );
  /* Without the direction there is no honest sentence to write — which record
     survives is half of what is being agreed to. */
  assert.equal(
    linkCollisionIn({ status: 409, body: { collision: { loanId: "l", loanName: "Harbor 41" } } }),
    undefined,
    "and no way to say which way the merge would go"
  );
});

/* ── What the person is asked ───────────────────────────── */

test("the confirmation names the other loan and says what merging costs", () => {
  const copy = mergeConfirmCopy(COLLISION);
  assert.match(copy.title, /Harbor 41/, "the other loan is named in the question itself");
  assert.match(copy.body, /Harbor 41/, "and in the explanation");
  assert.match(copy.body, /every task/i, "the tasks moving over is stated, not implied");
  assert.match(copy.body, /old name/i, "so is the name surviving only as an alias");
  assert.match(copy.body, /goes away/i, "and the record disappearing");
  assert.doesNotMatch(copy.body, /loanId|humperdinkLink|409|merge_/i, "in plain words, with no identifiers in them");
});

/* The thing this dialog is FOR: someone fixing a URL on a record they filed
   recently, pointing it at a loan that has been open for months. The older
   record survives, so it is THEIR loan that is absorbed — and a dialog that said
   otherwise would be telling them the opposite of what is about to happen. */
test("it says which of the two survives, in whichever direction the merge goes", () => {
  const absorbedIsMine = mergeConfirmCopy({
    loanName: "Harbor 41",
    survivingName: "Harbor 41",
    absorbedName: "Harbour 41 (new)"
  });
  assert.match(absorbedIsMine.body, /kept under the older name, "Harbor 41"/, "the survivor is named as the survivor");
  assert.match(absorbedIsMine.body, /Every task on "Harbour 41 \(new\)" moves onto it/, "and the absorbed one as absorbed");

  const absorbedIsTheirs = mergeConfirmCopy({
    loanName: "Harbour 41 (new)",
    survivingName: "Harbor 41",
    absorbedName: "Harbour 41 (new)"
  });
  assert.match(absorbedIsTheirs.title, /Harbour 41 \(new\)/, "the question still names the loan in the way");
  assert.match(absorbedIsTheirs.body, /kept under the older name, "Harbor 41"/, "and the direction does not follow it");
});

test("both answers are offered as decisions, not as OK and Cancel", () => {
  const copy = mergeConfirmCopy(COLLISION);
  assert.match(copy.confirm, /merge/i, "the yes says what it does");
  assert.match(copy.cancel, /separate/i, "and so does the no");
});

test("the dialog renders as an alert dialog carrying the question and both answers", () => {
  const html = renderToStaticMarkup(
    createElement(MergeConfirmDialog, { collision: COLLISION, onConfirm: () => {}, onCancel: () => {} })
  );
  assert.match(html, /role="alertdialog"/, "an alertdialog: it interrupts a save the person already started");
  assert.match(html, /aria-modal="true"/, "and nothing behind it is answerable while it is up");
  assert.match(html, /Harbor 41/, "the other loan is named on screen");
  assert.match(html, /Merge the loans/, "the yes is there");
  assert.match(html, /Keep them separate/, "and so is the no");
});

test("a merge in flight disables both answers rather than letting them be pressed twice", () => {
  const html = renderToStaticMarkup(
    createElement(MergeConfirmDialog, { collision: COLLISION, busy: true, onConfirm: () => {}, onCancel: () => {} })
  );
  assert.equal(html.match(/disabled/g)?.length, 2, "both buttons are disabled while the merge runs");
  assert.match(html, /Merging…/, "and the dialog stays up saying so");
});

/* ── The round trip, read out of App.tsx ────────────────── */

test("both loan-edit surfaces save through the one path that asks", () => {
  assert.match(APP, /const patchLoan = useCallback/, "there is a single loan-save path");
  const header = APP.slice(APP.indexOf("const onSaveLoan"), APP.indexOf("const onUpdatePoints"));
  const form = APP.slice(APP.indexOf("const saveLoanFields"), APP.indexOf("const onEditTask"));
  for (const [what, source] of [["the loan header", header], ["the edit form", form]]) {
    assert.match(source, /await patchLoan\(/, `${what} saves through patchLoan`);
    assert.doesNotMatch(source, /apiRequest[\s\S]*?\/loans\//, `${what} does not PATCH the loan itself`);
  }
});

test("the flag rides only on the re-send, after a yes", () => {
  const patch = APP.slice(APP.indexOf("const patchLoan = useCallback"), APP.indexOf("/* Edit a Loan's name/link"));
  assert.match(patch, /return await send\(\);/, "the first save carries nothing extra, so a collision is refused");
  assert.match(patch, /if \(!confirmed\)[\s\S]*?throw new MergeDeclined\(\)/, "a no sends nothing and rejects");
  const afterDecline = patch.slice(patch.indexOf("if (!confirmed)"));
  assert.match(afterDecline, /send\(\{ confirmMerge: true \}\)/, "only past the decline does the flag go up");
  assert.equal(patch.match(/confirmMerge: true/g).length, 1, "and it is set in exactly one place");
});

test("declining is silent, and every other refusal still speaks", () => {
  for (const surface of ["const onSaveLoan", "const saveLoanFields"]) {
    const end = APP.indexOf(surface === "const onSaveLoan" ? "const onUpdatePoints" : "const onEditTask");
    const source = APP.slice(APP.indexOf(surface), end);
    assert.match(source, /MergeDeclined/, `${surface} treats a decline as its own case`);
    const declineBranch = source.slice(source.indexOf("MergeDeclined"));
    assert.doesNotMatch(
      declineBranch.slice(0, declineBranch.indexOf("\n") + 1),
      /showToast/,
      "nothing was sent, so nothing is announced"
    );
  }
});

test("a confirmed merge still shows the notice it always did, said once", () => {
  const notices = APP.match(/Merged with "\$\{result\.merged\.intoLoanName\}"/g) ?? [];
  assert.equal(notices.length, 1, "the notice belongs to the step that merged, not to each caller");
  const patch = APP.slice(APP.indexOf("const patchLoan = useCallback"), APP.indexOf("/* Edit a Loan's name/link"));
  assert.match(patch, /Merged with/, "so any surface that saves a loan inherits it");
  assert.match(patch, /variant: "info"/, "as the same transient toast (ADR-0001 addendum 2026-07-31)");
});

test("the dialog is mounted above everything, including the edit form", () => {
  const render = APP.slice(APP.indexOf("{mergeAsk && ("));
  assert.match(render, /<MergeConfirmDialog/, "App renders it");
  assert.ok(APP.indexOf("{mergeAsk && (") > APP.indexOf("<TaskForm"), "after the edit form in the tree");
  const css = readFileSync(join(REPO, "apps/web/src/styles.css"), "utf8");
  const overlay = css.slice(css.indexOf(".merge-confirm-overlay"));
  assert.match(overlay.slice(0, overlay.indexOf("}")), /z-index: 70/, "and above the form modal's 50 and a toast's 60");
});

/* The decline path is a rejection, so it must be a distinct type — a caller
   that cannot tell it from a failure will toast "Merge declined" at someone who
   just chose to decline. */
test("a decline is its own error type, not a message anyone matches on", () => {
  const declined = new MergeDeclined();
  assert.ok(declined instanceof Error, "it still rejects, so the form stays open with the typing in it");
  assert.equal(declined.name, "MergeDeclined");
});
