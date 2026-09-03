#!/usr/bin/env node
/* Issue #247 / ADR-0007 rule 4 — the surfaces, not the shared function.

   `status-display-name-sim-test.mjs` next door asserts what
   `statusDisplayName` (packages/shared/src/labels.ts) returns. That is not the
   promise ADR-0007 rule 4 makes. The promise is about what a person sees, and
   a surface that never asks, or that writes a name back into itself, keeps
   that file green. It already happened once: the web rail drew a task in
   corrections on the claimed step and asked for the claimed step's name, so it
   rendered "In review" next to a "NEEDS CORRECTIONS" chip — the exact pairing
   the rule exists to stop. Review caught it; no test did (#246).

   So this file reads rendered output. The rail is rendered to markup through
   `react-dom/server`; the bot's DM confirm sentence is built by the same
   function the card-tap path calls. Both are asked for every task type ×
   status, and judged against the shared answer rather than against a spelling:

     - Where `statusDisplayName` has a name for the task's state, the surface
       shows that name, and shows none of the other names the shared module
       owns. That second half is the collision above.
     - No surface shows a retired name for the corrections state.

   The owned names are read off `statusDisplayName` itself, so a third one
   added there is covered here the day it lands, and renaming either of the two
   does not touch this file. What turns it red is a surface deciding for
   itself — hardcoding a status name into the rail or into the bot.

   Two checks at the end cover what rendering cannot reach: no `apps/web` or
   `apps/server` source spells one of these names out in code at all, which
   catches a surface this file has no way to render; and App.tsx still draws
   the rail, so the component being judged is the one a person sees.

   Adding a surface that puts a status into words means adding it to SURFACES.
   That is the whole shape of the file.

   Run: `node --test scripts/status-display-surface-sim-test.mjs`. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { transform } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { confirmLine } from "../apps/server/dist/bot.js";
import { statusDisplayName } from "../packages/shared/dist/labels.js";
import { TASK_STATUSES, TASK_TYPES } from "../packages/shared/dist/types.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/* ── The names the shared module owns ──────────────────── */
/* Read off the function rather than typed out here, so this file has no
   opinion on the spelling and picks up a third name on its own. */
const OWNED = [
  ...new Set(
    TASK_STATUSES.flatMap((status) => TASK_TYPES.map((taskType) => statusDisplayName(status, taskType))).filter(
      (name) => name !== undefined
    )
  )
];

/* The name #237 took off the corrections state. `statusDisplayName` cannot
   return it any more, so a surface showing it is showing one of its own. */
const RETIRED = /needs\s+review/i;

const shows = (rendered, name) => rendered.toLowerCase().includes(name.toLowerCase());

const taskFor = (status, taskType) => ({
  id: `t-${status}-${taskType}`,
  folderName: "Smith 1234",
  taskType,
  status,
  createdBy: { id: "u1", displayName: "Suzie", roles: ["LOAN_OFFICER"] },
  assignedTo: { id: "u2", displayName: "Alexa", roles: ["LOAN_OFFICER", "FILE_CHECKER"] },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  urgency: "TODAY",
  notes: [],
  history: []
});

/* The rail is TSX, which node will not strip on its own, so it is compiled
   here with esbuild — which is why the root declares it, along with the react
   pair this file renders through. The compiled file has to sit inside the repo
   for its bare imports (react, @loan-tasks/shared) to resolve. */
const scratch = mkdtempSync(join(REPO, "node_modules", ".status-surface-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const railSource = readFileSync(join(REPO, "apps/web/src/timeline.tsx"), "utf8");
const railModule = join(scratch, "timeline.mjs");
writeFileSync(railModule, (await transform(railSource, { loader: "tsx", jsx: "automatic", format: "esm" })).code);
const { Timeline } = await import(pathToFileURL(railModule).href);

/* ── The surfaces, as a person sees them ───────────────── */

const RAIL = {
  name: "the web timeline rail",
  render: (task) => renderToStaticMarkup(createElement(Timeline, { task }))
};

/* The rail says two different things about a status and #247 asks after both:
   the step's own name, and the chip on the step the task is standing on. Split
   out of the markup so one cannot cover for the other — a chip carrying the
   right name over a step label carrying nothing would pass a whole-markup
   substring check. */
const railParts = (task) => {
  const markup = RAIL.render(task);
  const collect = (pattern) => [...markup.matchAll(pattern)].map((match) => match[1]);
  return {
    markup,
    stepLabels: collect(/<b[^>]*>(.*?)<\/b>/g),
    chips: collect(/<span class="tag[^"]*"[^>]*>(.*?)<\/span>/g)
  };
};

const CONFIRM_LINE = {
  name: "the bot's DM confirm line",
  render: (task) => confirmLine(task)
};

const SURFACES = [RAIL, CONFIRM_LINE];

const matrix = TASK_STATUSES.flatMap((status) => TASK_TYPES.map((taskType) => [status, taskType]));

for (const surface of SURFACES) {
  test(`${surface.name} shows the shared name, and no other, in every state that has one`, () => {
    for (const [status, taskType] of matrix) {
      const expected = statusDisplayName(status, taskType);
      if (expected === undefined) continue;
      const rendered = surface.render(taskFor(status, taskType));
      const where = `${status} / ${taskType}: ${rendered}`;
      assert.ok(shows(rendered, expected), `${where} — expected to show "${expected}"`);
      for (const other of OWNED) {
        if (other === expected) continue;
        assert.ok(!shows(rendered, other), `${where} — must not also show "${other}"`);
      }
    }
  });

  test(`${surface.name} never shows a retired name for a status`, () => {
    for (const [status, taskType] of matrix) {
      const rendered = surface.render(taskFor(status, taskType));
      assert.ok(!RETIRED.test(rendered), `${status} / ${taskType}: ${rendered}`);
    }
  });
}

/* The rail draws every step of the flow, so a completed LOI legitimately still
   shows the claimed step under its shared name, and the rule above — judge the
   states the shared module names — is as far as it goes. The confirm line is
   one sentence about the state the task is in now, so it takes the stronger
   form of the same rule: no shared name at all where there is none to show. */

test(`${CONFIRM_LINE.name} keeps the shared names to the states that own them`, () => {
  for (const [status, taskType] of matrix) {
    if (statusDisplayName(status, taskType) !== undefined) continue;
    const rendered = CONFIRM_LINE.render(taskFor(status, taskType));
    for (const owned of OWNED) {
      assert.ok(!shows(rendered, owned), `${status} / ${taskType}: ${rendered} — must not show "${owned}"`);
    }
  }
});

/* ── The rail's two voices, held apart ─────────────────── */

test("the rail's step label takes the shared name where the shared module has one", () => {
  const underReview = statusDisplayName("CLAIMED", "LOI");
  const { stepLabels } = railParts(taskFor("CLAIMED", "LOI"));
  assert.ok(
    stepLabels.some((label) => label.toLowerCase() === underReview.toLowerCase()),
    `the claimed step should read "${underReview}": ${stepLabels.join(" | ")}`
  );
});

test("the rail's chip carries the shared name for the state the task is standing in", () => {
  for (const taskType of TASK_TYPES) {
    const corrections = statusDisplayName("NEEDS_REVIEW", taskType);
    const { chips } = railParts(taskFor("NEEDS_REVIEW", taskType));
    assert.ok(
      chips.some((chip) => chip.toLowerCase() === corrections.toLowerCase()),
      `${taskType}: a chip should read "${corrections}": ${chips.join(" | ")}`
    );
  }
});

/* ── The collision ADR-0007 rule 4 exists to stop ──────── */
/* Called out on its own because it is the one that shipped: an LOI in
   corrections is drawn on the claimed step, and a rail that asks for that
   step's name there puts "In review" beside the corrections chip. Judged on
   the label and the chip separately, because that pairing is two surfaces
   disagreeing inside one component. */

test("a task in corrections is named as such and nowhere reads as under review", () => {
  const underReview = statusDisplayName("CLAIMED", "LOI");
  for (const taskType of TASK_TYPES) {
    const corrections = statusDisplayName("NEEDS_REVIEW", taskType);
    assert.notEqual(corrections, undefined, "the corrections state is named by the shared module");
    const { stepLabels, chips, markup } = railParts(taskFor("NEEDS_REVIEW", taskType));
    for (const shown of [...stepLabels, ...chips]) {
      assert.ok(!shows(shown, underReview), `${taskType}: the rail shows "${shown}" — ${markup}`);
    }
    const line = CONFIRM_LINE.render(taskFor("NEEDS_REVIEW", taskType));
    assert.ok(shows(line, corrections), `${taskType}: ${line}`);
    assert.ok(!shows(line, underReview), `${taskType}: ${line}`);
  }
});

/* ── The names live in one module, and the tab draws the rail ── */
/* The rendered checks above only reach a surface the test can render. These
   two close the way round them: a status name written straight into any web or
   server source, and App.tsx quietly dropping the rail this file judges. */

const sourceFilesUnder = (relative) =>
  readdirSync(join(REPO, relative), { recursive: true })
    .filter((entry) => /\.tsx?$/.test(entry))
    .map((entry) => join(relative, entry));

/* Comments quote the names on purpose — that is where the reasoning lives. */
const codeOf = (relative) =>
  readFileSync(join(REPO, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("no web or server source spells a status name out for itself", () => {
  const sources = [...sourceFilesUnder("apps/web/src"), ...sourceFilesUnder("apps/server/src")];
  assert.ok(sources.length > 0, "found no sources to check");
  for (const relative of sources) {
    const code = codeOf(relative);
    for (const owned of OWNED) {
      assert.ok(!code.includes(owned), `${relative} spells out "${owned}" instead of asking the shared module`);
    }
    assert.ok(!RETIRED.test(code), `${relative} spells out a retired status name`);
  }
});

test("the tab still draws the rail this file judges", () => {
  assert.match(codeOf("apps/web/src/App.tsx"), /<Timeline\b/, "App.tsx no longer renders the timeline rail");
});
