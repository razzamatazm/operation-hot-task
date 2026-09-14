#!/usr/bin/env node
/* A Humperdink arrival fills the LOI Check from the clipboard, where Teams
   allows it (#415, ADR-0012).

   Send to Hot Task copies the loan and opens the Humperdink arrival link. On
   that arrival, and nowhere else, the tab asks Teams for the clipboard. If
   Teams says it can read one and what it holds is a Send to Hot Task payload,
   the new LOI Check runs its own paste import on it with no press, once the
   loans list has loaded. Anything else (no support, a refused read, something
   that isn't a payload) changes nothing and says nothing: focus is inside the
   form, so ⌘V imports.

   Three techniques, the arrangement the other arrival tests use:

   1. DRIVEN. The reader (`readArrivalClipboard`) is handed a fake Teams
      clipboard, and the step that decides when the text is applied
      (`arrivalPasteStep`) is a pure function.
   2. RENDERED. The form, through `react-dom/server`.
   3. READ OUT OF THE SOURCE. Effects don't run in a static render, so the
      form's and App's wiring is asserted against the source.

   Run: `node --test scripts/humperdink-arrival-clipboard-sim-test.mjs`. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const WEB = join(REPO, "apps/web/src");
const APP_SOURCE = readFileSync(join(WEB, "App.tsx"), "utf8");
const FORM_SOURCE = readFileSync(join(WEB, "task-form.tsx"), "utf8");
const ARRIVAL_SOURCE = readFileSync(join(WEB, "humperdink-arrival.ts"), "utf8");

const scratch = mkdtempSync(join(REPO, "node_modules", ".humperdink-arrival-clipboard-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const entry = join(scratch, "entry.tsx");
const src = (file) => JSON.stringify(join(WEB, file));
writeFileSync(
  entry,
  `export { readArrivalClipboard, arrivalPasteStep } from ${src("humperdink-arrival.ts")};\n` +
    `export { TaskForm } from ${src("task-form.tsx")};\n` +
    `export { ToastProvider } from ${src("toast.tsx")};\n`
);
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
const { readArrivalClipboard, arrivalPasteStep, TaskForm, ToastProvider } = await import(pathToFileURL(bundle).href);

const PAYLOAD = JSON.stringify({
  kind: "hot-task-humperdink",
  version: 1,
  loanName: "Adams - Harbor",
  loanUrl: "https://humperdink.loneoakfund.com/Loans/Details/335203"
});

/* A Teams clipboard as teams-js hands it over: `isSupported()` and a `read()`
   that resolves a Blob. Counts its reads, so "never read" is checkable. */
const fakeClipboard = ({ supported = true, blob, rejects = false, supportThrows = false, readThrows = false } = {}) => {
  const calls = { read: 0 };
  return {
    calls,
    isSupported: () => {
      if (supportThrows) throw new Error("SDK not initialized");
      return supported;
    },
    read: () => {
      calls.read += 1;
      if (readThrows) throw new Error("not supported on platform");
      return rejects ? Promise.reject(new Error("permission denied")) : Promise.resolve(blob);
    }
  };
};
const textBlob = (text, type = "text/plain") => new Blob([text], { type });

/* ── The reader ─────────────────────────────────────────── */

test("a supported clipboard holding a payload comes back as the payload's text", async () => {
  const clipboard = fakeClipboard({ blob: textBlob(PAYLOAD) });
  assert.equal(await readArrivalClipboard(clipboard), PAYLOAD);
  assert.equal(clipboard.calls.read, 1, "read once");
});

test("text/plain with a charset is still text/plain", async () => {
  assert.equal(await readArrivalClipboard(fakeClipboard({ blob: textBlob(PAYLOAD, "text/plain;charset=utf-8") })), PAYLOAD);
});

test("an unsupported clipboard is never read", async () => {
  const clipboard = fakeClipboard({ supported: false, blob: textBlob(PAYLOAD) });
  assert.equal(await readArrivalClipboard(clipboard), null);
  assert.equal(clipboard.calls.read, 0);
});

test("no clipboard at all is nothing", async () => {
  assert.equal(await readArrivalClipboard(null), null);
  assert.equal(await readArrivalClipboard(undefined), null);
});

test("asking for support before Teams is ready is nothing, not a throw", async () => {
  const clipboard = fakeClipboard({ supportThrows: true, blob: textBlob(PAYLOAD) });
  assert.equal(await readArrivalClipboard(clipboard), null);
  assert.equal(clipboard.calls.read, 0);
});

test("a refused read is nothing, whether it rejects or throws", async () => {
  assert.equal(await readArrivalClipboard(fakeClipboard({ rejects: true })), null);
  assert.equal(await readArrivalClipboard(fakeClipboard({ readThrows: true })), null);
});

test("a read that resolves nothing, or not a Blob, is nothing", async () => {
  assert.equal(await readArrivalClipboard(fakeClipboard({ blob: undefined })), null);
  assert.equal(await readArrivalClipboard(fakeClipboard({ blob: PAYLOAD })), null);
});

test("only the text/plain blob counts", async () => {
  assert.equal(await readArrivalClipboard(fakeClipboard({ blob: textBlob(PAYLOAD, "text/html") })), null);
  assert.equal(await readArrivalClipboard(fakeClipboard({ blob: textBlob(PAYLOAD, "image/png") })), null);
});

/* A clipboard holding something else is not an error on this arrival, and its
   contents are not kept: the reader hands back nothing, so they never reach the
   form's state. */
test("text that isn't a Send to Hot Task payload is nothing", async () => {
  for (const text of [
    "",
    "Adams - Harbor",
    "https://humperdink.loneoakfund.com/Loans/Details/335203",
    JSON.stringify({ kind: "something-else", version: 1 }),
    JSON.stringify({ kind: "hot-task-humperdink", version: 99, loanName: "Adams - Harbor", loanUrl: "https://humperdink.loneoakfund.com/Loans/Details/335203" })
  ]) {
    assert.equal(await readArrivalClipboard(fakeClipboard({ blob: textBlob(text) })), null, text);
  }
});

/* ── When the text is applied ───────────────────────────── */

test("a payload read before the loans list loads waits for it", () => {
  assert.equal(arrivalPasteStep({ paste: PAYLOAD, loansLoaded: false, untouched: true }), "wait");
  assert.equal(arrivalPasteStep({ paste: PAYLOAD, loansLoaded: true, untouched: true }), "apply");
});

test("nothing read is nothing to do, loaded or not", () => {
  assert.equal(arrivalPasteStep({ paste: null, loansLoaded: false, untouched: true }), "wait");
  assert.equal(arrivalPasteStep({ paste: null, loansLoaded: true, untouched: true }), "wait");
});

/* The fill is for a form nobody has started on. Somebody who already pasted or
   typed by the time the loans came back keeps what they did. */
test("a form somebody has already started on is left alone", () => {
  assert.equal(arrivalPasteStep({ paste: PAYLOAD, loansLoaded: true, untouched: false }), "drop");
  assert.equal(arrivalPasteStep({ paste: PAYLOAD, loansLoaded: false, untouched: false }), "wait", "still waits for the loans first");
});

/* ── The form (read out of the source) ──────────────────── */

const effectAfter = (source, needle) => {
  const at = source.indexOf(needle);
  if (at < 0) return "";
  const end = source.indexOf("\n  }, [", at);
  return source.slice(at, end);
};

test("the form reads the clipboard once, at open, and only on a Humperdink arrival", () => {
  const read = effectAfter(FORM_SOURCE, "if (!humperdinkArrival || editing || reopened || !readClipboard) return;");
  assert.ok(read, "a read gated on the arrival");
  assert.match(read, /readClipboard\(\)/);
  assert.match(FORM_SOURCE, /if \(!humperdinkArrival \|\| editing \|\| reopened \|\| !readClipboard\) return;[\s\S]*?\n  \}, \[\]\);/, "at mount only");
  assert.equal(FORM_SOURCE.match(/readClipboard\(\)/g)?.length, 1, "one read in the form");
  assert.match(read, /return \(\) => \{\s*open = false;\s*\};/, "a read that lands after the form closed is dropped");
});

test("the form applies it through its own paste import, once the loans have loaded", () => {
  const apply = FORM_SOURCE.match(/useEffect\(\(\) => \{\s*const step = arrivalPasteStep\(([\s\S]*?)\n  \}, \[arrivalPaste, loansLoaded\]\);/)?.[0];
  assert.ok(apply, "an effect keyed on the text and the loans");
  assert.match(apply, /loansLoaded/);
  assert.match(apply, /untouched: !imported && !formHasChanges\(openedWith\.current, formNow\.current\)/);
  assert.match(apply, /importFromHumperdink\(arrivalPaste\)/);
  assert.doesNotMatch(apply, /parseHumperdinkPayload|applyImportedLoan/, "not a second copy of the import");
  assert.doesNotMatch(apply, /onCreate|onSaveForLater|apiRequest/, "nothing is created until Create");
});

test("the arrival only hands the import a payload that parses, so a fill never toasts", () => {
  const body = FORM_SOURCE.match(/const importFromHumperdink = \(([\s\S]*?)\n  \};/)?.[0];
  assert.ok(body);
  assert.match(body, /if \(!result\.ours\) return false;/, "text that isn't an export leaves quietly");
  assert.match(ARRIVAL_SOURCE, /return parseHumperdinkPayload\(text\)\.ok \? text : null;/, "and the reader lets nothing else through");
  assert.doesNotMatch(body, /onCreate|onSaveForLater/);
});

test("a paste on the form is still the import", () => {
  assert.match(FORM_SOURCE, /onPaste=\{\(e\) => \{[\s\S]*?if \(importFromHumperdink\(e\.clipboardData\.getData\("text\/plain"\)\)\) e\.preventDefault\(\);/);
});

/* ── App (read out of the source) ───────────────────────── */

test("App hands the form a clipboard reader only on a Humperdink arrival", () => {
  const createMount = APP_SOURCE.match(/\{formOpen && \(\s*<TaskForm([\s\S]*?)\/>/)?.[1];
  assert.ok(createMount);
  assert.match(createMount, /readClipboard=\{humperdinkArrival \? readTeamsClipboard : undefined\}/);
  assert.match(createMount, /loansLoaded=\{loansLoaded\}/);
  assert.match(APP_SOURCE, /const readTeamsClipboard = \(\): Promise<string \| null> => readArrivalClipboard\(teamsClipboard\);/);
  assert.equal(APP_SOURCE.match(/readTeamsClipboard/g)?.length, 2, "defined once, handed over once");
  // The edit form never gets one.
  const mounts = APP_SOURCE.split("<TaskForm").slice(1).map((chunk) => chunk.slice(0, chunk.indexOf("/>")));
  const editMounts = mounts.filter((mount) => /\bedit=\{/.test(mount));
  assert.ok(editMounts.length > 0, "found the edit form");
  for (const mount of editMounts) assert.doesNotMatch(mount, /readClipboard/);
});

test("App knows when the loans list has loaded", () => {
  const load = APP_SOURCE.match(/const loadLoans = useCallback\(async \(\): Promise<void> => \{([\s\S]*?)\n  \}, \[user\]\);/)?.[1];
  assert.ok(load);
  assert.ok(load.indexOf("setLoans(data.loans)") < load.indexOf("setLoansLoaded(true)"), "set once the list is in");
});

/* Nothing in the web app reads the clipboard but the one reader, and the one
   reader is reached only through the arrival's form. */
test("no other clipboard read exists in the web app", () => {
  const files = readdirSync(WEB, { recursive: true }).filter((f) => /\.(ts|tsx)$/.test(f));
  for (const file of files) {
    const text = readFileSync(join(WEB, file), "utf8");
    assert.doesNotMatch(text, /navigator\.clipboard\.read/, file);
    if (file !== "humperdink-arrival.ts") assert.doesNotMatch(text, /\.read\(\)/, `${file} reads nothing`);
  }
  assert.match(ARRIVAL_SOURCE, /clipboard\.read\(\)/);
  assert.equal(APP_SOURCE.match(/readArrivalClipboard\(/g)?.length, 1);
  assert.doesNotMatch(FORM_SOURCE, /readArrivalClipboard|@microsoft\/teams-js/, "the form is handed its reader");
});

/* ── The form it opens (rendered) ───────────────────────── */

globalThis.window = { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } };

const USER = { id: "user-1", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] };
const render = (props) =>
  renderToStaticMarkup(
    createElement(ToastProvider, null, createElement(TaskForm, {
      loans: [],
      directory: [],
      user: USER,
      tasks: [],
      onClose: () => {},
      onCreate: async () => {},
      ...props
    }))
  );

test("until anything is read, the arrival is an empty LOI Check with no paste box and no toast", () => {
  const html = render({ humperdinkArrival: true, readClipboard: async () => PAYLOAD, loansLoaded: false });
  assert.match(html, /<option value="LOI" selected="">/);
  assert.doesNotMatch(html, /task-form-import|then paste here/);
  assert.doesNotMatch(html, /Adams - Harbor/);
  assert.doesNotMatch(html, /role="alert"|toast-error/);
});

/* ── Docs ───────────────────────────────────────────────── */

test("the ADR exists, and nothing still says Hot Task never reads the clipboard", () => {
  const adr = readdirSync(join(REPO, "docs/adr")).find((f) => f.startsWith("0012-"));
  assert.ok(adr && existsSync(join(REPO, "docs/adr", adr)), "ADR-0012");
  for (const file of [
    "tools/humperdink/README.md",
    "docs/product/integrations-hosting.md",
    "docs/product/target-direction.md",
    "docs/product/task-fields.md",
    "PRODUCT.md",
    "apps/web/CLAUDE.md",
    "apps/web/docs/task-form.md",
    "apps/web/src/App.tsx",
    "apps/web/src/task-form.tsx",
    "packages/shared/src/humperdink.ts",
    "tools/humperdink/send-to-hot-task.user.js"
  ]) {
    const text = readFileSync(join(REPO, file), "utf8");
    assert.doesNotMatch(text, /never reads (the|your) clipboard|works in dev and fails in production|reading the clipboard programmatically is deliberately not done|deliberately not used/i, file);
  }
});
