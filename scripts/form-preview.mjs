#!/usr/bin/env node
/* Renders the task form in its states to a single self-contained HTML page, so
 * the redesign can be looked at without running the app. Not a test and not
 * part of any gate — a throwaway eyeballing aid. Writes to the path given as
 * the first argument, or /tmp/hot-task-form-preview.html.
 *
 * The forms are rendered by `react-dom/server`, so nothing here is interactive:
 * the typeahead never opens and the poop tray doesn't fill. The shared-record
 * line cannot be shown at all — the form seeds itself from the task, so its
 * first paint is always the unchanged one and `touchesSharedLoan` is always
 * false. Its slot is the same one the loan refusal fills, which is shown.
 *
 * Run: `node scripts/form-preview.mjs [out.html]` */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const OUT = process.argv[2] ?? "/tmp/hot-task-form-preview.html";

const scratch = mkdtempSync(join(REPO, "node_modules", ".form-preview-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const entry = join(scratch, "entry.tsx");
writeFileSync(
  entry,
  `export { TaskForm } from ${JSON.stringify(join(REPO, "apps/web/src/task-form.tsx"))};\n` +
    `export { ToastProvider } from ${JSON.stringify(join(REPO, "apps/web/src/toast.tsx"))};\n`
);
const bundle = join(scratch, "task-form.mjs");
await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  external: ["react", "react/jsx-runtime", "@loan-tasks/shared"],
  logLevel: "silent"
});
const { TaskForm, ToastProvider } = await import(pathToFileURL(bundle).href);

const TERMS = `Loan Amount: $2,340,000
Term: 24 months + two 6-month extensions
Rate: 9.75% mos 1-12, 10.50% mos 13-24
Origination: 2.00 pts, due at close
Broker: Dana Whitfield, Crossbeam Commercial
Borrower: Elena Vasquez, Wexford Holdings LLC

Borrower wants the terms confirmed before the 10am call.`;

const CREATOR = { id: "u-creator", displayName: "Tyler Hereford" };
const CHECKER = { id: "u-checker", displayName: "Suzie Alvarez" };
const USER = { ...CREATOR, roles: ["LOAN_OFFICER"] };
const DIRECTORY = [
  { id: CHECKER.id, displayName: CHECKER.displayName, roles: ["FILE_CHECKER"] },
  { id: "u-other", displayName: "Johanna Reyes", roles: ["LOAN_OFFICER"] }
];

const loiTask = (over = {}) => ({
  id: "task-1",
  taskType: "LOI",
  notes: TERMS,
  loanId: "loan-1",
  folderName: "Alvarez-2201",
  humperdinkLink: "https://humperdink.example.com/loans/seed-loan-alvarez-2201",
  urgency: "ORANGE",
  points: 2,
  createdBy: CREATOR,
  ...over
});

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

const panels = [
  ["New Task — filing", "The four-across top row, terms, link, share row. The Humperdink paste box and its Import button are in the footer beside Cancel and Create Task.", render({})],
  ["Edit Task — the filer", "Same row, type locked to a padlocked chip. Tall monospace terms box. Urgency and the poop tray are drawn because this viewer filed the task.", render({ edit: { task: loiTask(), onSave: async () => {} } })],
  ["Edit Task — a checker correcting the terms", "Not the filer, so no urgency and no poop tray: neither is theirs to move.", render({ user: { ...CHECKER, roles: ["FILE_CHECKER"] }, edit: { task: loiTask(), onSave: async () => {} } })],
  ["Edit Task — someone who may not touch the loan", "Both loan boxes read-only, and the footer carries the reason instead of the shared-record line.", render({ edit: { task: loiTask(), onSave: async () => {}, loanRefusal: "Only the person who requested this task or the person working it can change its loan's name or link" } })],
  ["Edit Task — an out-of-office task", "No loan, so no link and nothing about a shared record; the two dates take the timing slot.", render({ edit: { task: { id: "t-ooo", taskType: "OOO", notes: "Back on the 9th, Suzie is covering.", folderName: "Two weeks in Lisbon", startDate: "2026-09-14", returnDate: "2026-09-28", urgency: "GREEN", points: 1, createdBy: CREATOR }, onSave: async () => {} } })],
  ["New Task — a Fraud Check", "The outstanding-items seeder, filing only.", render({ initialValues: { taskType: "FRAUD" } })]
];

const css = readFileSync(join(REPO, "apps/web/src/styles.css"), "utf8");

/* The real overlay is `position: fixed` and covers the viewport, which would
   stack all seven panels on top of each other. Unpinning it here is the only
   thing this page changes about the app's own CSS. */
const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Hot Task — task form preview</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
${css}
.form-overlay { position: static; inset: auto; padding: 0; animation: none; background: none; overflow: visible; }
.form-panel { animation: none; }
.toast-host { display: none; }
body { padding: 28px 20px 60px; }
.preview-head { max-width: 760px; margin: 0 auto 10px; }
.preview-head h2 { margin: 0 0 4px; font-family: "Bricolage Grotesque", "DM Sans", sans-serif; font-size: 1rem; }
.preview-head p { margin: 0; font-size: 0.82rem; color: var(--ink-secondary); line-height: 1.4; }
.preview-panel { margin: 0 0 40px; }
.preview-switch { max-width: 760px; margin: 0 auto 26px; display: flex; gap: 8px; }
</style></head>
<body>
<div class="preview-switch">
  <button type="button" class="btn-sm" onclick="document.documentElement.dataset.theme='light'">Light</button>
  <button type="button" class="btn-sm btn-ghost" onclick="document.documentElement.dataset.theme='dark'">Dark</button>
  <button type="button" class="btn-sm btn-ghost" onclick="document.documentElement.dataset.theme='contrast'">Contrast</button>
</div>
${panels.map(([title, note, html]) => `<section class="preview-panel"><div class="preview-head"><h2>${title}</h2><p>${note}</p></div>${html}</section>`).join("\n")}
</body></html>`;

writeFileSync(OUT, page);
console.log(OUT);
