#!/usr/bin/env node
/* A Teams link that says "somebody just sent a loan from Humperdink" (#412).

   Pressing Send to Hot Task in Humperdink puts the loan on the clipboard. The
   link that follows carries no data at all: Teams writes every deep link it
   receives into its local log, so borrower details must never travel in the
   URL. All it says is which of Hot Task's arrivals this is, and it says it with
   a fixed value in `subEntityId`, the one context field proven to reach the tab
   on Teams desktop (2026-09-13). The separate create-form context field from
   #198 never was, and is gone.

   Three things under test:

   - The sentinel link builder emits the `msteams:` form, whose context is
     exactly `{"subEntityId":"<sentinel>"}`.
   - Every link the rest of the app builds (Copy link, bot cards, activity feed,
     Claim & Open) is byte-for-byte what it was, and none carries the sentinel.
   - `readTeamsArrival` tells the tab which arrival it got. The sentinel never
     comes back as a task to focus, and a claim intent riding on it is ignored.

   The shared half is pure and type-strips straight in. The web half bundles the
   create form and renders it, and reads the Teams init out of App.tsx, which
   can't be imported into node. Run: `node --test scripts/humperdink-arrival-sim-test.mjs`. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  HOT_TASK_ENTITY_ID,
  HUMPERDINK_ARRIVAL_ID,
  humperdinkArrivalLink,
  isHumperdinkArrival,
  readClaimIntent,
  readTeamsArrival,
  teamsTaskDeepLink,
  withClaimIntent
} from "../packages/shared/src/deep-link.ts";

const APP_ID = "bca6db0b-b2b7-423f-8c22-f4348f3a0340";
const TASK_ID = "3f2b9c1e-7d4a-4e8b-9a1c-5d6e7f8a9b0c";
const BASE = `https://teams.microsoft.com/l/entity/${APP_ID}/${HOT_TASK_ENTITY_ID}`;

/* The context JSON of a link, decoded. `URL` won't parse the query of an
   `msteams:/…` URL the way it does an https one, so this splits by hand. */
const contextOf = (url) => {
  const query = url.split("?", 2)[1] ?? "";
  const pair = query.split("&").find((p) => p.startsWith("context="));
  return pair === undefined ? null : JSON.parse(decodeURIComponent(pair.slice("context=".length)));
};

/* ── The sentinel ───────────────────────────────────────── */

test("the sentinel is a fixed value that can never be mistaken for a task id", () => {
  assert.equal(HUMPERDINK_ARRIVAL_ID, "new:humperdink");
  // Task ids are UUIDs; the colon alone keeps the sentinel out of that shape.
  assert.doesNotMatch(HUMPERDINK_ARRIVAL_ID, /^[0-9a-f-]{36}$/i);
});

/* ── The arrival link ───────────────────────────────────── */

test("the arrival link is the proven msteams: shape, byte for byte", () => {
  assert.equal(
    humperdinkArrivalLink(APP_ID),
    `msteams:/l/entity/${APP_ID}/loan-tasks-home?context=%7B%22subEntityId%22%3A%22new%3Ahumperdink%22%7D`
  );
});

test("its context is exactly the sentinel in subEntityId, and nothing else rides along", () => {
  const url = humperdinkArrivalLink(APP_ID);
  assert.deepEqual(contextOf(url), { subEntityId: HUMPERDINK_ARRIVAL_ID });
  const query = url.split("?", 2)[1];
  assert.deepEqual(query.split("&").map((p) => p.split("=")[0]), ["context"], "no label, no webUrl, no other params");
});

test("it opens Teams desktop directly, never through Microsoft's launcher page", () => {
  const url = humperdinkArrivalLink(APP_ID);
  assert.ok(url.startsWith("msteams:/l/entity/"));
  assert.doesNotMatch(url, /teams\.microsoft\.com/);
});

test("no app id means no arrival link", () => {
  assert.equal(humperdinkArrivalLink(undefined), undefined);
  assert.equal(humperdinkArrivalLink(null), undefined);
  assert.equal(humperdinkArrivalLink("   "), undefined);
});

test("a padded app id is trimmed, the way the task link trims it", () => {
  assert.equal(humperdinkArrivalLink(`  ${APP_ID} `), humperdinkArrivalLink(APP_ID));
});

/* Teams desktop ignores a deep link identical to the page it is showing, so the
   userscript tags every press and two presses are two links. */
test("a press tag goes after the sentinel, and different tags make different links", () => {
  assert.deepEqual(contextOf(humperdinkArrivalLink(APP_ID, "mf3k9x2a")), { subEntityId: "new:humperdink:mf3k9x2a" });
  assert.notEqual(humperdinkArrivalLink(APP_ID, "a1"), humperdinkArrivalLink(APP_ID, "a2"));
});

test("a tag that isn't letters and digits is left off, so nothing else can ride in the link", () => {
  for (const tag of ["", "   ", "Adams - Harbor", "a:b", "x&label=y", "%7B"]) {
    assert.equal(humperdinkArrivalLink(APP_ID, tag), humperdinkArrivalLink(APP_ID), JSON.stringify(tag));
  }
});

test("the sentinel with or without a tag is an arrival, and nothing else is", () => {
  assert.equal(isHumperdinkArrival(HUMPERDINK_ARRIVAL_ID), true);
  assert.equal(isHumperdinkArrival("new:humperdink:mf3k9x2a"), true);
  for (const value of ["new:humperdinkx", "new:humperdink-1", "new:", TASK_ID, "", undefined, null, 7]) {
    assert.equal(isHumperdinkArrival(value), false, String(value));
  }
});

/* ── Every other link stays exactly as it was ───────────── */

test("a task link is unchanged", () => {
  assert.equal(
    teamsTaskDeepLink(APP_ID, TASK_ID),
    `${BASE}?context=${encodeURIComponent(JSON.stringify({ subEntityId: TASK_ID }))}`
  );
});

test("a task link with a label and a web url is unchanged", () => {
  assert.equal(
    teamsTaskDeepLink(APP_ID, TASK_ID, { label: "Adams - Harbor", webUrl: "https://hot.example.com" }),
    `${BASE}?context=${encodeURIComponent(JSON.stringify({ subEntityId: TASK_ID }))}` +
      `&label=${encodeURIComponent("Adams - Harbor")}` +
      `&webUrl=${encodeURIComponent("https://hot.example.com")}`
  );
});

test("the plain tab link is still the bare entity url", () => {
  assert.equal(teamsTaskDeepLink(APP_ID), BASE);
});

test("a Claim & Open link is unchanged", () => {
  const url = teamsTaskDeepLink(APP_ID, TASK_ID, { label: "Adams - Harbor", claim: true });
  assert.equal(
    url,
    `${BASE}?context=${encodeURIComponent(JSON.stringify({ subEntityId: TASK_ID, claimOnOpen: true }))}` +
      `&label=${encodeURIComponent("Adams - Harbor")}`
  );
  assert.equal(withClaimIntent(teamsTaskDeepLink(APP_ID, TASK_ID, { label: "Adams - Harbor" })), url);
});

test("no link the rest of the app builds carries the sentinel", () => {
  const links = [
    teamsTaskDeepLink(APP_ID),
    teamsTaskDeepLink(APP_ID, TASK_ID),
    teamsTaskDeepLink(APP_ID, TASK_ID, { label: "Adams - Harbor" }),
    teamsTaskDeepLink(APP_ID, TASK_ID, { label: "Adams - Harbor", webUrl: "https://hot.example.com" }),
    teamsTaskDeepLink(APP_ID, TASK_ID, { claim: true }),
    teamsTaskDeepLink(APP_ID, undefined, { claim: true, webUrl: "https://hot.example.com" }),
    withClaimIntent(teamsTaskDeepLink(APP_ID, TASK_ID, { label: "Adams - Harbor" }))
  ];
  for (const url of links) {
    assert.ok(url, "every one of these builds");
    assert.ok(!decodeURIComponent(url).includes(HUMPERDINK_ARRIVAL_ID), url);
    assert.ok(!url.includes(encodeURIComponent(HUMPERDINK_ARRIVAL_ID)), url);
  }
});

/* The builder is handed task ids by its callers and nothing stops a caller
   handing it this one. It refuses to turn a task link into an arrival link
   rather than trusting every caller not to. */
test("the task link builder won't emit the sentinel even when handed it as a task id", () => {
  for (const taskId of [HUMPERDINK_ARRIVAL_ID, "new:humperdink:mf3k9x2a"]) {
    const url = teamsTaskDeepLink(APP_ID, taskId, { label: "x", claim: true });
    assert.ok(!decodeURIComponent(url).includes(HUMPERDINK_ARRIVAL_ID), taskId);
  }
});

test("the claim twin of an arrival link is no link at all", () => {
  for (const subEntityId of [HUMPERDINK_ARRIVAL_ID, "new:humperdink:mf3k9x2a"]) {
    assert.equal(withClaimIntent(`${BASE}?context=${encodeURIComponent(JSON.stringify({ subEntityId }))}`), undefined, subEntityId);
  }
});

/* ── Reading the arrival back ───────────────────────────── */

test("the sentinel reads back as a Humperdink arrival off the v2 context shape", () => {
  assert.deepEqual(readTeamsArrival({ page: { subPageId: HUMPERDINK_ARRIVAL_ID } }), { kind: "humperdink" });
});

test("the sentinel reads back off the flat v1 context shape", () => {
  assert.deepEqual(readTeamsArrival({ subEntityId: HUMPERDINK_ARRIVAL_ID }), { kind: "humperdink" });
});

test("a tagged press reads back as a Humperdink arrival off both context shapes", () => {
  assert.deepEqual(readTeamsArrival({ page: { subPageId: "new:humperdink:mf3k9x2a" } }), { kind: "humperdink" });
  assert.deepEqual(readTeamsArrival({ subEntityId: "new:humperdink:mf3k9x2a" }), { kind: "humperdink" });
});

test("a Humperdink arrival never focuses a task and never claims one, even with a claim intent on it", () => {
  for (const context of [
    { page: { subPageId: HUMPERDINK_ARRIVAL_ID, claimOnOpen: true } },
    { subEntityId: HUMPERDINK_ARRIVAL_ID, claimOnOpen: true },
    { page: { subPageId: HUMPERDINK_ARRIVAL_ID }, claimOnOpen: true },
    { page: { subPageId: "new:humperdink:mf3k9x2a", claimOnOpen: true } }
  ]) {
    const arrival = readTeamsArrival(context);
    assert.deepEqual(arrival, { kind: "humperdink" });
    assert.equal("taskId" in arrival, false);
    assert.equal("claim" in arrival, false);
  }
});

test("a task link reads back as that task, view-only", () => {
  assert.deepEqual(readTeamsArrival({ page: { subPageId: TASK_ID } }), { kind: "task", taskId: TASK_ID, claim: false });
  assert.deepEqual(readTeamsArrival({ subEntityId: TASK_ID }), { kind: "task", taskId: TASK_ID, claim: false });
});

test("a Claim & Open link reads back as that task with the claim", () => {
  assert.deepEqual(readTeamsArrival({ page: { subPageId: TASK_ID, claimOnOpen: true } }), { kind: "task", taskId: TASK_ID, claim: true });
  // The claim reader it defers to is unchanged.
  assert.equal(readClaimIntent({ page: { subPageId: TASK_ID, claimOnOpen: true } }), true);
});

test("the v2 shape wins over the v1 one, as the tab always read it", () => {
  assert.deepEqual(readTeamsArrival({ page: { subPageId: TASK_ID }, subEntityId: HUMPERDINK_ARRIVAL_ID }), {
    kind: "task",
    taskId: TASK_ID,
    claim: false
  });
});

test("every other way into Hot Task is no arrival", () => {
  for (const context of [{ page: {} }, {}, { app: { theme: "dark" } }, undefined, null, "new:humperdink", { page: { subPageId: "" } }]) {
    assert.deepEqual(readTeamsArrival(context), { kind: "none" }, JSON.stringify(context));
  }
});

/* Only `subEntityId` counts. A context field beside it, #198's or anybody's,
   opens nothing on its own. */
test("a context field other than subEntityId is no arrival", () => {
  assert.deepEqual(readTeamsArrival({ page: { newTask: true } }), { kind: "none" });
  assert.deepEqual(readTeamsArrival({ claimOnOpen: true }), { kind: "none" });
});

/* ── The tab (App.tsx, read out of the source) ──────────── */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const APP_SOURCE = readFileSync(join(REPO, "apps/web/src/App.tsx"), "utf8");
const FORM_SOURCE = readFileSync(join(REPO, "apps/web/src/task-form.tsx"), "utf8");

/* The Teams init effect: from `teamsApp.initialize()` to its catch. */
const teamsInit = APP_SOURCE.match(/teamsApp\s*\.initialize\(\)([\s\S]*?)\.catch\(/)?.[1] ?? "";

test("the Teams init reads one arrival, and only a task arrival reaches focus and claim", () => {
  assert.ok(teamsInit, "found the Teams init");
  assert.match(teamsInit, /readTeamsArrival\(context\)/);
  assert.doesNotMatch(teamsInit, /subPageId\s*\?\?/, "no second reading of the raw context");
  const taskBranch = teamsInit.match(/arrival\.kind === "task"\)\s*\{([\s\S]*?)\n        \}/)?.[1];
  assert.ok(taskBranch, "a task branch");
  assert.match(taskBranch, /setFocusTaskId\(arrival\.taskId\)/);
  assert.match(taskBranch, /if \(arrival\.claim\)\s*\{?\s*setClaimOnArrivalId\(arrival\.taskId\)/);
  // Nothing else in the init focuses or claims.
  assert.equal(teamsInit.match(/setFocusTaskId\(/g)?.length, 1);
  assert.equal(teamsInit.match(/setClaimOnArrivalId\(/g)?.length, 1);
});

/* Since #413 the init only marks the arrival; an effect keyed on the person
   moves any autosave aside and then opens the form. What the move does is
   `humperdink-arrival-autosave-sim-test.mjs`. */
test("a Humperdink arrival opens the create form as that arrival, once the person is known, and creates nothing", () => {
  const branch = teamsInit.match(/arrival\.kind === "humperdink"\)\s*(\{[\s\S]*?\}|[^\n]*;)/)?.[1];
  assert.ok(branch, "a humperdink branch");
  assert.match(branch, /setArrivalPending\(true\)/);
  assert.doesNotMatch(branch, /onCreate|apiRequest|saveForLater|setFocusTaskId|setClaimOnArrivalId/);
  assert.ok(teamsInit.indexOf("setArrivalPending(true)") < teamsInit.indexOf("setUser(me)"), "set with /me, so the form's seat is the real person's");
  const effect = APP_SOURCE.match(/useEffect\(\(\) => \{\s*if \(!arrivalPending \|\| !user\.id\) return;([\s\S]*?)\n  \}, \[arrivalPending, user\.id\]\);/)?.[1];
  assert.ok(effect, "an effect that waits for the person");
  assert.match(effect, /setHumperdinkArrival\(true\)/);
  assert.match(effect, /setFormOpen\(true\)/);
  assert.ok(
    effect.indexOf("formOpenNow.current") >= 0 && effect.indexOf("formOpenNow.current") < effect.indexOf("setReopened(null)"),
    "a form already open (opened during a slow sign-in) is left alone"
  );
  assert.doesNotMatch(effect, /onCreate|apiRequest|setFocusTaskId|setClaimOnArrivalId/);
});

test("App hands the create form the arrival, and every other way in clears it", () => {
  const createMount = APP_SOURCE.match(/\{formOpen && \(\s*<TaskForm([\s\S]*?)\/>/)?.[1];
  assert.ok(createMount);
  assert.match(createMount, /humperdinkArrival=\{humperdinkArrival\}/);
  const onClose = createMount.match(/onClose=\{\(\) => \{([\s\S]*?)\}\}/)?.[1];
  assert.match(onClose, /setHumperdinkArrival\(false\)/, "closing the form ends the arrival");
  const openNewTask = APP_SOURCE.match(/const openNewTask = useCallback\(async \(\): Promise<void> => \{([\s\S]*?)\n  \}/)?.[1];
  assert.match(openNewTask, /setHumperdinkArrival\(false\)/, "New Task is never an arrival");
  const openSaved = APP_SOURCE.match(/const openSavedForLater = useCallback\(([\s\S]*?)\n  \}, \[/)?.[1];
  assert.match(openSaved, /setHumperdinkArrival\(false\)/, "reopening a draft is never an arrival");
});

/* #198's create-form intent is gone whole: the field, its reader and the
   builder option. Pinned as the module's exact export list, so neither the
   old reader nor a second arrival reader can come back unnoticed. */
test("the deep link module exports the arrival and nothing of the old create-form intent", async () => {
  const deepLink = await import("../packages/shared/src/deep-link.ts");
  assert.deepEqual(Object.keys(deepLink).sort(), [
    "CLAIM_INTENT_FIELD",
    "HOT_TASK_ENTITY_ID",
    "HUMPERDINK_ARRIVAL_ID",
    "humperdinkArrivalLink",
    "isHumperdinkArrival",
    "readClaimIntent",
    "readTeamsArrival",
    "teamsTaskDeepLink",
    "withClaimIntent"
  ]);
  for (const [name, source] of [["App.tsx", APP_SOURCE], ["task-form.tsx", FORM_SOURCE]]) {
    assert.doesNotMatch(source, /CreateFormIntent|CREATE_FORM_INTENT/, name);
  }
});

/* ── The form it opens (rendered) ───────────────────────── */

const scratch = mkdtempSync(join(REPO, "node_modules", ".humperdink-arrival-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const entry = join(scratch, "entry.tsx");
writeFileSync(
  entry,
  `export { TaskForm } from ${JSON.stringify(join(REPO, "apps/web/src/task-form.tsx"))};\n` +
    `export { ToastProvider } from ${JSON.stringify(join(REPO, "apps/web/src/toast.tsx"))};\n`
);
const bundle = join(scratch, "humperdink-arrival.mjs");
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

const selectedType = (html) => html.match(/<option value="([A-Z_]+)" selected="">/)?.[1];

test("an arrival opens the create form as an LOI Check", () => {
  const html = render({ humperdinkArrival: true });
  assert.equal(selectedType(html), "LOI");
  assert.match(html, /Create Task/);
});

/* An arrival is about a loan on the clipboard, so an unfinished Fraud Check in
   the autosave must not come back in its place, where a Humperdink paste does
   nothing. What happens to that autosave is #413's; here it is only not
   restored. */
test("an arrival opens on an LOI Check, not on the autosave", () => {
  const autosave = {
    form: {
      folderName: "Castillo - Ridge",
      loanId: "",
      taskType: "FRAUD",
      urgency: "RED",
      startDate: "",
      returnDate: "",
      notes: "half written",
      humperdinkLink: "",
      points: 2,
      initialItems: ["No W-2"],
      pickerMode: "share",
      recipientUserId: "",
      recipientNote: ""
    },
    savedAt: new Date().toISOString()
  };
  assert.match(render({ autosave }), /Castillo - Ridge/, "the control: New Task does restore it");
  const html = render({ humperdinkArrival: true, autosave });
  assert.doesNotMatch(html, /Castillo - Ridge/);
  assert.equal(selectedType(html), "LOI");
});

test("the request field takes focus on an arrival, and on no other opening, so ⌘V lands inside the form", () => {
  const effect = FORM_SOURCE.match(/useEffect\(\(\) => \{\s*if \(!humperdinkArrival\) return;([\s\S]*?)\}, \[\]\);/)?.[1];
  assert.ok(effect, "a mount effect gated on the arrival");
  assert.match(effect, /notesRef\.current\?\.focus\(\)/);
});

/* Teams won't let the tab read the clipboard, so the arrival's request field
   says which key to press, and no other opening says it. */
test("an arrival's request field says to press CTRL-V, and a plain New Task's doesn't", () => {
  const prompt = /placeholder="Press CTRL-V now to import from Humperdink"/;
  assert.match(render({ humperdinkArrival: true }), prompt);
  assert.doesNotMatch(render({}), prompt);
  assert.doesNotMatch(render({ humperdinkArrival: false }), prompt);
  // Edit mode and a reopened draft never say it, and a landed import takes it
  // away even when the loan had no terms to fill the box with (#436 review).
  assert.match(
    FORM_SOURCE,
    /placeholder=\{humperdinkArrival && !editing && !reopened && !imported \? "Press CTRL-V now to import from Humperdink" : undefined\}/
  );
});

test("the arrival's ⌘V goes through the form's own paste import", () => {
  assert.match(FORM_SOURCE, /onPaste=\{\(e\) => \{[\s\S]*?importFromHumperdink\(e\.clipboardData\.getData\("text\/plain"\)\)/);
});
