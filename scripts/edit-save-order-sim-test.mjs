#!/usr/bin/env node
/* Issue #281 — a save that asks the merge question writes nothing until the
 * question is answered, so backing out of the merge backs out of the save.
 *
 * The bug this file exists for: the edit form used to write the task's own
 * fields first and the loan's name and link last, and the loan call is the only
 * one that can raise a question. Someone fixing the terms AND pasting a
 * corrected link therefore had the terms committed — with a history row, and a
 * DM already sent to the person holding the task — before the "fold these two
 * loans together?" dialog went up. Declining is the right answer to that
 * question and is deliberately silent, so nothing on screen ever said the terms
 * had landed.
 *
 * The promise is an ABSENCE: after a decline, no task field was written. An
 * absence cannot be checked by looking at one field afterwards — the field
 * could be unchanged because the write failed, or because it was never sent, or
 * because the person typed the same thing back. It has to be checked by driving
 * a save and watching what gets called. That is why the dispatch lives in
 * `save-task-edit.ts` rather than inside <App>: <App> boots Teams on import and
 * cannot be run here, so anything left in it can only be asserted as a regex
 * over its source, which proves an ordering rather than the promise.
 *
 * The writer is injected, so this file records calls instead of making them.
 * What each of those calls does on the server is somebody else's test:
 * `loan-sim-test.mjs` for the refusal being write-free on both loan records,
 * `amend-task-sim-test.mjs` for a field write's history row and its DM.
 *
 * Run: `node --test scripts/edit-save-order-sim-test.mjs`. No `pretest` guard,
 * unlike its neighbours: nothing here imports a compiled `dist`. The module
 * under test type-strips from source and its only shared import is type-only,
 * and the one thing esbuild bundles has no import but React. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

import { NoLoanToCorrect, saveTaskEdit } from "../apps/web/src/save-task-edit.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/* The decline is a real rejection with a dedicated type, and this file uses the
   real one — a save that swallowed a `MergeDeclined` or turned it into an
   ordinary failure would pass against a stand-in. It lives in a TSX module, so
   it comes through esbuild the way `loan-merge-confirm-sim-test.mjs` takes it. */
const scratch = mkdtempSync(join(REPO, "node_modules", ".edit-save-order-"));
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
const { MergeDeclined } = await import(pathToFileURL(bundle).href);

const APP = readFileSync(join(REPO, "apps/web/src/App.tsx"), "utf8");

const loiTask = (over = {}) => ({ id: "task-1", taskType: "LOI", loanId: "loan-1", ...over });
const oooTask = (over = {}) => ({ id: "task-ooo", taskType: "OOO", ...over });

/* Records every write a save attempts, in order, and lets a named one reject —
   which is how the merge decline is staged: the loan call is the one that
   asks, so the loan call is the one that rejects. */
const recorder = ({ rejects, error, once = false } = {}) => {
  const calls = [];
  let rejected = false;
  const step = (name) => async (...args) => {
    calls.push({ name, args });
    if (name === rejects && !(once && rejected)) {
      rejected = true;
      throw error ?? new Error("refused");
    }
  };
  return {
    calls,
    names: () => calls.map((c) => c.name),
    write: {
      setNotes: step("setNotes"),
      setUrgency: step("setUrgency"),
      setPoints: step("setPoints"),
      setFolderName: step("setFolderName"),
      setDates: step("setDates"),
      saveLoanFields: step("saveLoanFields")
    }
  };
};

/* ── The decline writes nothing ─────────────────────────── */

/* The exact save from the ticket: the terms corrected and the link repointed at
   a loan that turns out to be somebody else's. */
test("declining the merge leaves every other field unwritten", async () => {
  const rec = recorder({ rejects: "saveLoanFields", error: new MergeDeclined() });
  await assert.rejects(
    saveTaskEdit(
      loiTask(),
      {
        notes: "Loan Amount: $2,340,000\nRate: 9.75%",
        folderName: "Harbour 41 (new)",
        humperdinkLink: "https://h.example/harbor-41",
        urgency: "RED",
        points: 4
      },
      rec.write
    ),
    (err) => err instanceof MergeDeclined,
    "the decline still rejects, which is what keeps the form open with the typing in it"
  );

  assert.deepEqual(
    rec.names(),
    ["saveLoanFields"],
    "the question was asked first, so nothing else was even attempted"
  );
  /* Spelled out one by one, because each of these is a consequence the person
     would have been left with: a changed request field, a history row against
     it, and a DM to whoever is holding the task. */
  assert.ok(!rec.names().includes("setNotes"), "the terms were not written, so no history row and no DM");
  assert.ok(!rec.names().includes("setUrgency"), "nor the urgency");
  assert.ok(!rec.names().includes("setPoints"), "nor the poops");
  assert.ok(!rec.names().includes("setDates"), "nor any dates");
  assert.ok(!rec.names().includes("setFolderName"), "and nothing went to the task's own folder-name route");
});

/* A rename with no link change cannot collide, but it goes through the same
   call, so it is asked about in the same place and stops the same way. */
test("a refusal on the loan call stops the save whatever raised it", async () => {
  const rec = recorder({ rejects: "saveLoanFields", error: new Error("Loan name is required") });
  await assert.rejects(saveTaskEdit(loiTask(), { notes: "new terms", folderName: "Harbor 41" }, rec.write));
  assert.deepEqual(rec.names(), ["saveLoanFields"], "the terms behind it never went");
});

/* ── The confirmed save still applies everything ────────── */

test("a save that goes through applies every field, with the loan first", async () => {
  const rec = recorder();
  await saveTaskEdit(
    loiTask(),
    { notes: "new terms", folderName: "Harbor 41", humperdinkLink: "https://h.example/harbor-41", urgency: "RED", points: 4 },
    rec.write
  );
  assert.deepEqual(
    rec.names(),
    ["saveLoanFields", "setUrgency", "setPoints", "setNotes"],
    "the loan is asked about first; the task's own fields follow in the order the form reads"
  );
  assert.deepEqual(rec.calls[0].args, [
    "loan-1",
    "task-1",
    { name: "Harbor 41", humperdinkLink: "https://h.example/harbor-41" }
  ], "and the name and link still travel as one call to one record");
});

/* ── A save with no collision is unaffected ─────────────── */

test("only the fields that actually moved are sent", async () => {
  const rec = recorder();
  await saveTaskEdit(loiTask(), { notes: "new terms" }, rec.write);
  assert.deepEqual(rec.names(), ["setNotes"], "a request-only edit never touches the loan");
});

test("a link cleared on its own still goes, and alone", async () => {
  const rec = recorder();
  await saveTaskEdit(loiTask(), { humperdinkLink: "" }, rec.write);
  assert.deepEqual(rec.names(), ["saveLoanFields"]);
  assert.deepEqual(rec.calls[0].args[2], { humperdinkLink: "" }, "the name is absent rather than sent as itself");
});

test("an empty edit writes nothing", async () => {
  const rec = recorder();
  await saveTaskEdit(loiTask(), {}, rec.write);
  assert.deepEqual(rec.names(), []);
});

/* The old order's one virtue, kept: a field that is refused stops the fields
   behind it rather than leaving the form guessing which of them landed. */
test("a refused task field stops the ones behind it", async () => {
  const rec = recorder({ rejects: "setUrgency" });
  await assert.rejects(saveTaskEdit(loiTask(), { urgency: "RED", points: 4, notes: "new terms" }, rec.write));
  assert.deepEqual(rec.names(), ["setUrgency"], "the poops and the terms behind it never went");
});

/* ── Out of office, which has no loan ───────────────────── */

test("an out-of-office save never reaches the loan call", async () => {
  const rec = recorder();
  await saveTaskEdit(
    oooTask(),
    { folderName: "Two weeks in Lisbon", notes: "back on the 4th", dates: { startDate: "2026-03-02", returnDate: "2026-03-09" }, points: 1 },
    rec.write
  );
  assert.deepEqual(
    rec.names(),
    ["setDates", "setPoints", "setNotes", "setFolderName"],
    "its description is its own words on its own task, so it goes to the task's route"
  );
  assert.ok(!rec.names().includes("saveLoanFields"), "there is no loan behind it to ask about");
});

/* ── A task with no loan yet ────────────────────────────── */

/* Not a merge question, but the same promise: the refusal happens before any
   write, so a save that cannot land its name does not land half of itself
   either. */
test("a loan-less task is refused before anything is written", async () => {
  const rec = recorder();
  await assert.rejects(
    saveTaskEdit(loiTask({ loanId: undefined }), { folderName: "Harbor 41", notes: "new terms" }, rec.write),
    (err) => err instanceof NoLoanToCorrect,
    "its own type, so the shell can say so without matching on the words"
  );
  assert.deepEqual(rec.names(), [], "and the terms were not written on the way to finding out");
});

test("a loan-less task whose loan fields did not move still saves", async () => {
  const rec = recorder();
  await saveTaskEdit(loiTask({ loanId: undefined }), { notes: "new terms" }, rec.write);
  assert.deepEqual(rec.names(), ["setNotes"], "nothing asks for a loan that nothing is writing to");
});

/* ── A link another loan record also holds (#383) ───────── */

/* The #370 start-up rewrite can leave two loan records on one canonical link,
   and it does not merge them. The only place that asks is a save that sends the
   link, and Edit Task never sent an unchanged one, so a pair was only ever asked
   about by somebody pasting the URL from another Humperdink tab. A save on either
   task now carries the loan's own link along with whatever else moved, so the
   server's existing check asks. What is new is the No: the person never touched
   the link, so declining it cannot cost them the rest of their edit. */

const SHARED = "https://h.example/loans/41/details";
const shared = { sharedLink: SHARED };

test("a notes-only save on a shared link sends the link first, marked as untouched", async () => {
  const rec = recorder();
  await saveTaskEdit(loiTask(), { notes: "new terms" }, rec.write, shared);
  assert.deepEqual(rec.names(), ["saveLoanFields", "setNotes"], "the question goes first, the notes follow");
  assert.deepEqual(
    rec.calls[0].args,
    ["loan-1", "task-1", { humperdinkLink: SHARED }, { linkUntouched: true }],
    "the loan's own link, and the dialog is told the person did not move it"
  );
});

test("a rename rides the same loan call as the shared link", async () => {
  const rec = recorder();
  await saveTaskEdit(loiTask(), { folderName: "Harbor 41", notes: "new terms" }, rec.write, shared);
  assert.deepEqual(rec.names(), ["saveLoanFields", "setNotes"], "still one loan call, not two");
  assert.deepEqual(rec.calls[0].args.slice(2), [{ name: "Harbor 41", humperdinkLink: SHARED }, { linkUntouched: true }]);
});

test("No on an untouched link still saves everything else, and quietly", async () => {
  const rec = recorder({ rejects: "saveLoanFields", error: new MergeDeclined() });
  await saveTaskEdit(loiTask(), { notes: "new terms", urgency: "RED" }, rec.write, shared);
  assert.deepEqual(
    rec.names(),
    ["saveLoanFields", "setUrgency", "setNotes"],
    "resolves, so the form closes like any save; with no rename there is no second loan call"
  );
});

test("No with a rename re-sends the rename alone, then the task's fields", async () => {
  const rec = recorder({ rejects: "saveLoanFields", error: new MergeDeclined(), once: true });
  await saveTaskEdit(loiTask(), { folderName: "Harbor 41", notes: "new terms" }, rec.write, shared);
  assert.deepEqual(rec.names(), ["saveLoanFields", "saveLoanFields", "setNotes"]);
  assert.deepEqual(
    rec.calls[1].args,
    ["loan-1", "task-1", { name: "Harbor 41" }],
    "the link is left off, so both records keep what they had and only the name lands"
  );
});

test("every save on a shared link asks again; there is no remembering a No", async () => {
  const rec = recorder({ rejects: "saveLoanFields", error: new MergeDeclined() });
  await saveTaskEdit(loiTask(), { notes: "first" }, rec.write, shared);
  await saveTaskEdit(loiTask(), { notes: "second" }, rec.write, shared);
  assert.deepEqual(rec.names(), ["saveLoanFields", "setNotes", "saveLoanFields", "setNotes"]);
  assert.deepEqual(rec.calls[2].args[2], { humperdinkLink: SHARED }, "the second save carried the link too");
});

test("any other refusal on the shared-link call still stops the save", async () => {
  const rec = recorder({ rejects: "saveLoanFields", error: new Error("Loan not found") });
  await assert.rejects(saveTaskEdit(loiTask(), { notes: "new terms" }, rec.write, shared));
  assert.deepEqual(rec.names(), ["saveLoanFields"], "only a No is allowed through");
});

test("a link the person changed still cancels the whole save on No, shared or not", async () => {
  const rec = recorder({ rejects: "saveLoanFields", error: new MergeDeclined() });
  await assert.rejects(
    saveTaskEdit(loiTask(), { humperdinkLink: "https://h.example/loans/9/details", notes: "new terms" }, rec.write, shared),
    (err) => err instanceof MergeDeclined
  );
  assert.deepEqual(rec.names(), ["saveLoanFields"], "the form stays open, nothing else went");
  assert.deepEqual(rec.calls[0].args.length, 3, "and it is asked as a changed link, not an untouched one");
});

test("a link nobody else holds is never sent on its own account", async () => {
  const rec = recorder();
  await saveTaskEdit(loiTask(), { notes: "new terms" }, rec.write, {});
  assert.deepEqual(rec.names(), ["setNotes"]);
});

test("loan fields locked for this person: no link, no question", async () => {
  const rec = recorder();
  await saveTaskEdit(loiTask(), { notes: "new terms" }, rec.write, { ...shared, loanLocked: true });
  assert.deepEqual(rec.names(), ["setNotes"]);
});

test("an out-of-office task and an empty save never reach the shared link", async () => {
  const ooo = recorder();
  await saveTaskEdit(oooTask(), { notes: "back on the 4th" }, ooo.write, shared);
  assert.deepEqual(ooo.names(), ["setNotes"], "OOO has no loan behind it");

  const empty = recorder();
  await saveTaskEdit(loiTask(), {}, empty.write, shared);
  assert.deepEqual(empty.names(), [], "nothing changed, so nothing is sent and nothing is asked");
});

test("a loan-less task with a shared link in hand still just saves its fields", async () => {
  const rec = recorder();
  await saveTaskEdit(loiTask({ loanId: undefined }), { notes: "new terms" }, rec.write, shared);
  assert.deepEqual(rec.names(), ["setNotes"]);
});

/* ── What is left in <App> ──────────────────────────────── */

/* The shell keeps the parts that are the shell's: the api calls themselves, the
   one refetch at the end of a save however many writes ran, and the toast for
   the one refusal this level raises rather than receives. */
test("the shell dispatches through the one ordered save and refreshes once", () => {
  const dispatch = /const onSaveEdit = useCallback\([\s\S]*?\n  \}, \[amendApi[^\]]*\]\);/.exec(APP);
  assert.ok(dispatch, "onSaveEdit is still where a save starts");
  assert.match(dispatch[0], /await saveTaskEdit\(task, edit, \{ \.\.\.amendApi, saveLoanFields \}, \{/, "and it goes through the ordered save");
  assert.match(dispatch[0], /sharedLink: sharedLinkOf\(task\.loanId, loans\)/, "telling it when another loan record holds the link (#383)");
  assert.match(dispatch[0], /loanLocked: Boolean\(loanEditRefusal\(task, user\)\)/, "and when the loan fields are shut to this person");
  assert.equal((dispatch[0].match(/refresh\(\)/g) ?? []).length, 1, "one refetch for the whole save");
  assert.match(dispatch[0], /NoLoanToCorrect/, "the loan-less refusal is the one it says out loud");
  /* A decline is not a failure and gets no toast — the only `showToast` in here
     is the loan-less one, inside its own `instanceof` branch. */
  assert.equal((dispatch[0].match(/showToast\(/g) ?? []).length, 1, "and it is the only thing announced here");
});
