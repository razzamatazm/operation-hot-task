#!/usr/bin/env node
/* Issue #333: find a loan from the Tasks list header and see only its tasks.

   Which tasks survive a picked loan is `visibleBoardTasks`, and that rule is
   tested beside the Mine filter in `board-filter-sim-test.mjs`. This file holds
   the header control:

   1. WHAT it suggests. `loanSearchResults` is the whole rule, and it is the
      create form's ranking (`loanTypeaheadSuggestions`) rather than a second
      one, so the order is asserted against that function directly. A pasted
      Humperdink link is the one thing the ranking cannot find, because it only
      reads names; that lookup is shared `findLoanForCreate`'s link half and nothing else.
   2. WHAT it draws. The trigger, the open box, the no-match line, the narrowed
      header line and the empty board are rendered through `react-dom/server`.
   3. WHERE it sits and HOW it is wired. `App.tsx` cannot be imported into a
      node script, so the header order and the two App-side promises (the board
      list carries the loan, opening a task ends the search) are read out of the
      source, the way `discard-confirm-sim-test.mjs` reads its wiring.

   Left for a person: pressing the keys, and measuring the box at 390px.

   Run: `node --test scripts/loan-search-sim-test.mjs`. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loanTypeaheadSuggestions } from "@loan-tasks/shared";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const APP_SOURCE = readFileSync(join(REPO, "apps/web/src/App.tsx"), "utf8");

const scratch = mkdtempSync(join(REPO, "node_modules", ".loan-search-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const bundle = join(scratch, "loan-search.mjs");
await build({
  entryPoints: [join(REPO, "apps/web/src/loan-search.tsx")],
  outfile: bundle,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  external: ["react", "react/jsx-runtime", "@loan-tasks/shared"],
  logLevel: "silent"
});
const { LOAN_SEARCH_LIMIT, LoanSearch, LoanSearchEmpty, LoanSearchStatus, loanSearchResults } = await import(
  pathToFileURL(bundle).href
);

const loan = (id, name, updatedAt, fields = {}) => ({
  id,
  name,
  createdAt: "2026-08-01T12:00:00.000Z",
  updatedAt,
  ...fields
});

const loans = [
  loan("loan-hendricks", "Hendricks 2231", "2026-09-01T12:00:00.000Z", {
    humperdinkLink: "https://app.humperdink.com/loans/2231"
  }),
  loan("loan-henderson", "Henderson Refi", "2026-09-05T12:00:00.000Z"),
  loan("loan-smith", "Smith 1042", "2026-09-09T12:00:00.000Z"),
  loan("loan-acme", "Acme Corp", "2026-09-10T12:00:00.000Z", {
    humperdinkLink: "https://app.humperdink.com/loans/77"
  }),
  loan("loan-zed", "Zed Holdings", "2026-09-08T12:00:00.000Z")
];
const myLoanIds = new Set(["loan-smith", "loan-hendricks"]);
const ids = (result) => (result.kind === "suggestions" ? result.matches.map((m) => m.loan.id) : []);

/* ── What it suggests ───────────────────────────────────── */

test("a partial name suggests the loan, in the create form's order", () => {
  const result = loanSearchResults("hend", loans, myLoanIds);
  assert.equal(result.kind, "suggestions");
  assert.ok(ids(result).includes("loan-hendricks"));
  assert.deepEqual(ids(result), loanTypeaheadSuggestions("hend", loans, myLoanIds, LOAN_SEARCH_LIMIT).map((m) => m.loan.id));
});

test("a misspelt name suggests the loan, in the create form's order", () => {
  const result = loanSearchResults("Hendriks 2231", loans, myLoanIds);
  assert.equal(ids(result)[0], "loan-hendricks", "a typo still finds it, first");
  assert.deepEqual(
    ids(result),
    loanTypeaheadSuggestions("Hendriks 2231", loans, myLoanIds, LOAN_SEARCH_LIMIT).map((m) => m.loan.id)
  );
});

test("the create form's limit is the search's limit", () => {
  const formSource = readFileSync(join(REPO, "apps/web/src/task-form.tsx"), "utf8");
  const limit = formSource.match(/loanTypeaheadSuggestions\(loanQuery, loans, myLoanIds, (\d+)\)/);
  assert.ok(limit, "the create form still calls the shared ranking");
  assert.equal(Number(limit[1]), LOAN_SEARCH_LIMIT, "the same cut, so the same list");
});

test("the create form and the search draw one suggestion list, lifted rather than copied", () => {
  const formSource = readFileSync(join(REPO, "apps/web/src/task-form.tsx"), "utf8");
  const searchSource = readFileSync(join(REPO, "apps/web/src/loan-search.tsx"), "utf8");
  for (const [name, source] of [["task-form.tsx", formSource], ["loan-search.tsx", searchSource]]) {
    assert.match(source, /<LoanSuggestionList/, `${name} renders the shared list`);
    assert.doesNotMatch(source, /role="option"/, `${name} draws no options of its own`);
  }
});

test("with the box empty, the viewer's own loans come first", () => {
  const result = loanSearchResults("", loans, myLoanIds);
  assert.deepEqual(ids(result), ["loan-smith", "loan-hendricks"], "mine, most recently used first");
});

test("with the box empty and no loans of the viewer's, nothing is offered and nothing is refused", () => {
  assert.equal(loanSearchResults("   ", loans, new Set()).kind, "empty");
});

test("a pasted Humperdink link suggests the loan carrying it", () => {
  const spellings = [
    "https://app.humperdink.com/loans/2231",
    "https://app.humperdink.com/loans/2231/",
    "https://APP.Humperdink.com/loans/2231",
    "https://www.app.humperdink.com/loans/2231",
    "  https://app.humperdink.com/loans/2231  "
  ];
  for (const pasted of spellings) {
    assert.deepEqual(ids(loanSearchResults(pasted, loans, myLoanIds)), ["loan-hendricks"], pasted);
  }
});

test("a loan is found by any of its Humperdink page URLs (#370)", () => {
  const paged = [
    loan("loan-castillo", "Castillo Ranch", "2026-09-01T12:00:00.000Z", {
      humperdinkLink: "https://humperdink.loneoakfund.com/Loans/Details/329366-SL"
    }),
    /* A record written before #370's start-up rewrite, still on its Docs page. */
    loan("loan-alvarez", "Alvarez", "2026-09-02T12:00:00.000Z", {
      humperdinkLink: "https://humperdink.loneoakfund.com/Loans/Docs/401122-AB"
    })
  ];
  for (const page of ["Details", "Docs", "DueDiligence", "Funding"]) {
    assert.deepEqual(
      ids(loanSearchResults(`https://humperdink.loneoakfund.com/Loans/${page}/329366-SL`, paged, new Set())),
      ["loan-castillo"],
      page
    );
    assert.deepEqual(
      ids(loanSearchResults(`https://humperdink.loneoakfund.com/Loans/${page}/401122-AB?tab=1`, paged, new Set())),
      ["loan-alvarez"],
      `${page} finds a record still holding another page`
    );
  }
});

test("a link no loan carries is a no-match, not a fuzzy guess", () => {
  assert.equal(loanSearchResults("https://app.humperdink.com/loans/9999", loans, myLoanIds).kind, "no-match");
});

test("a name that matches no loan is a no-match", () => {
  assert.equal(loanSearchResults("qqxxzzvv", loans, myLoanIds).kind, "no-match");
});

/* ── What it draws ──────────────────────────────────────── */

const render = (props) =>
  renderToStaticMarkup(createElement(LoanSearch, { loans, myLoanIds, onPick: () => {}, ...props }));

test("closed, the control is one labelled trigger and no box", () => {
  const html = render({});
  assert.match(html, /<button[^>]*aria-label="Search for a loan"/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /<input/);
});

test("open with a partial name, the box lists the matching loans as options", () => {
  const html = render({ initialOpen: true, initialQuery: "hend" });
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /<input[^>]*role="combobox"/);
  assert.match(html, /role="listbox"/);
  assert.match(html, /role="option"[^>]*>.*Hendricks 2231/);
});

test("open with a name that matches nothing, the box says so", () => {
  const html = render({ initialOpen: true, initialQuery: "qqxxzzvv" });
  assert.match(html, /No loan matches that/);
  assert.doesNotMatch(html, /role="option"/);
});

test("narrowed, the header names the loan and offers a way back", () => {
  const html = renderToStaticMarkup(createElement(LoanSearchStatus, { loan: loans[0], onClear: () => {} }));
  assert.match(html, /Hendricks 2231/);
  assert.match(html, /<button[^>]*>Clear search<\/button>/);
});

test("a picked loan with nothing on the board says so plainly", () => {
  const html = renderToStaticMarkup(createElement(LoanSearchEmpty, { loan: loans[0], onClear: () => {} }));
  assert.match(html, /No tasks for Hendricks 2231 on the board\./);
  assert.match(html, /Clear search/);
});

/* ── Where it sits, and how App wires it ────────────────── */

const tasksHeader = APP_SOURCE.slice(APP_SOURCE.indexOf("── Unified task grid"), APP_SOURCE.indexOf("── All Tasks (admin)"));

test("the Tasks header puts the search left of the app menu, and New Task stays last", () => {
  const search = tasksHeader.indexOf("<LoanSearch");
  const menu = tasksHeader.indexOf("<AppMenu");
  const newTask = tasksHeader.indexOf("<NewTaskButton");
  assert.ok(search > 0, "the Tasks header renders the search");
  assert.ok(search < menu && menu < newTask, "search, then the menu, then New Task");
});

test("the admin All Tasks header carries no search", () => {
  const admin = APP_SOURCE.slice(APP_SOURCE.indexOf("── All Tasks (admin)"), APP_SOURCE.indexOf("── Metrics tab content"));
  assert.doesNotMatch(admin, /<LoanSearch/);
});

test("the board list is narrowed by the picked loan in the one derivation", () => {
  assert.match(APP_SOURCE, /visibleBoardTasks\(unifiedTasks, \{[^}]*loanId:/);
});

test("the deep-link focus path ends the search", () => {
  const effect = APP_SOURCE.slice(APP_SOURCE.indexOf("Deep-link focus:"), APP_SOURCE.indexOf("No effect clears a manual expand"));
  assert.match(effect, /setSearchLoanId\(null\)/);
});
