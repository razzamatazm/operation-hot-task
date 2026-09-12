#!/usr/bin/env node
/* Issue #335 — one How Bad? rating on an open card, in exactly one place, and
 * never a control.
 *
 * #332 put a read-only rating back on the collapsed row of a task that is
 * unclaimed and out for the first time. The row does not unmount when the card
 * expands, and the expanded body still led with its own `How Bad?` line, so an
 * open pool task drew the same number twice a few pixels apart.
 *
 * The user's rule (#335):
 *
 *   - The rating is set and changed in the task form alone. Every rating the
 *     card draws is read-only, for every viewer, the creator included.
 *   - Fresh unclaimed task (`isFirstTimeInPool`): the read-only row track.
 *   - Every other state — dropped and re-offered, claimed, closed: a read-only
 *     rating in the task menu.
 *   - The open card body never shows a rating.
 *   - An unrated task shows nothing anywhere, for anyone.
 *
 * The rule lives in `apps/web/src/poop-rating.tsx`, and this file renders it
 * through `react-dom/server` and reads the markup back, the same arrangement as
 * `instructions-box-sim-test.mjs`. Source checks at the end hold App.tsx to
 * drawing these rather than a copy of its own, and styles.css to carrying no
 * rules for a rating block nothing emits.
 *
 * Run: `node --test scripts/rating-placement-sim-test.mjs`. */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const REPO = fileURLToPath(new URL("..", import.meta.url));

const scratch = mkdtempSync(join(REPO, "node_modules", ".rating-placement-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const ratingModule = join(scratch, "poop-rating.mjs");
await build({
  entryPoints: [join(REPO, "apps/web/src/poop-rating.tsx")],
  outfile: ratingModule,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  external: ["react", "react/jsx-runtime", "@loan-tasks/shared"],
  logLevel: "silent"
});
const { ratingBlock } = await import(pathToFileURL(ratingModule).href);

const CREATOR = { id: "creator-1", displayName: "Dana Requester" };
const ASSIGNEE = { id: "assignee-1", displayName: "Casey Checker" };

const FILED = "2026-09-01T10:00:00.000Z";
const LATER = "2026-09-02T10:00:00.000Z";

const task = (overrides = {}) => ({
  id: "task-1",
  folderName: "Smith-1042",
  taskType: "LOAN_DOCS",
  dueAt: LATER,
  urgency: "GREEN",
  points: 3,
  status: "OPEN",
  notes: "Docs",
  createdAt: FILED,
  updatedAt: FILED,
  createdBy: { ...CREATOR },
  reviewNotes: [],
  ...overrides
});

/* Every state the rule names, and the surface each one's rating belongs on. */
const STATES = {
  "unclaimed, never dropped": { make: (o) => task(o), surface: "row" },
  "unclaimed, pooledSince stamped equal to createdAt": { make: (o) => task({ pooledSince: FILED, ...o }), surface: "row" },
  "unclaimed, dropped and re-offered": { make: (o) => task({ pooledSince: LATER, ...o }), surface: "menu" },
  claimed: { make: (o) => task({ status: "CLAIMED", assignee: { ...ASSIGNEE }, ...o }), surface: "menu" },
  "fraud check released for any checker": {
    make: (o) => task({ taskType: "FRAUD", status: "PENDING_APPROVAL", pooledSince: LATER, ...o }),
    surface: "menu"
  },
  closed: { make: (o) => task({ status: "COMPLETED", assignee: { ...ASSIGNEE }, ...o }), surface: "menu" }
};

const SURFACES = ["row", "menu"];

const render = (surface, t) => {
  const el = ratingBlock(surface, t);
  return el === null ? "" : renderToStaticMarkup(createElement(Fragment, null, el));
};

test("a rated task draws its rating on exactly the surface its state names, and no other", () => {
  for (const [state, { make, surface }] of Object.entries(STATES)) {
    for (const points of [1, 3, 5]) {
      const t = make({ points });
      const drawn = SURFACES.filter((s) => render(s, t) !== "");
      assert.deepEqual(drawn, [surface], `${state}, ${points}: drew ${drawn.join(" and ") || "nothing"}`);
      const html = render(surface, t);
      assert.equal((html.match(/poop-slot-on/g) ?? []).length, points, `${state}: ${points} of five filled`);
      assert.equal((html.match(/class="poop-slot/g) ?? []).length, 5, `${state}: a fixed five-slot track`);
    }
  }
});

test("no surface on the card is a control, for any state", () => {
  for (const [state, { make, surface }] of Object.entries(STATES)) {
    const html = render(surface, make());
    assert.doesNotMatch(html, /<button/, `${state}: no buttons`);
    assert.doesNotMatch(html, /poop-track-editable|aria-pressed|tabindex/i, `${state}: no hover affordance, no pressed state, no tab stop`);
  }
});

test("the row copy is the bare track; the menu copy is a labelled group, not a menu item", () => {
  const row = render("row", STATES["unclaimed, never dropped"].make());
  assert.match(row, /^<span class="poop-track"/, "the row gets #332's track and nothing around it");
  const menu = render("menu", STATES.claimed.make());
  assert.match(menu, /class="task-card-menu-rating" role="group" aria-label="How Bad\?"/);
  assert.match(menu, /<b>How Bad\?<\/b>/);
  assert.doesNotMatch(menu, /role="menuitem/, "reference detail, not an arrow-key stop");
});

test("an unrated task draws nothing on any surface, whatever its state", () => {
  for (const [state, { make }] of Object.entries(STATES)) {
    for (const points of [0, undefined]) {
      const t = make({ points });
      for (const surface of SURFACES) {
        assert.equal(render(surface, t), "", `${state}, points ${points}: ${surface} drew something`);
      }
    }
  }
});

const APP = readFileSync(join(REPO, "apps/web/src/App.tsx"), "utf8");

test("App.tsx asks the module for the row and the menu, and nothing else draws a rating", () => {
  assert.match(APP, /from "\.\/poop-rating"/);
  assert.doesNotMatch(APP, /const PoopDisplay\s*=/, "no second rating component");
  assert.doesNotMatch(APP, /PoopDisplay/, "the card never draws the track directly");
  assert.match(APP, /ratingBlock\("row", task\)/, "the row asks the rule");
  assert.match(APP, /const menuRating = ratingBlock\("menu", task\);/, "the menu asks the rule");
  assert.equal((APP.match(/ratingBlock\(/g) ?? []).length, 2, "and those are the only two surfaces");
  const expanded = APP.slice(APP.indexOf("const renderExpanded = () =>"), APP.indexOf("const ownerName ="));
  assert.ok(expanded.length > 0, "the expanded body is where it was");
  assert.doesNotMatch(expanded, /ratingBlock|poop|How Bad\?</i, "the open card body draws no rating");
});

test("the menu folds the rating into its is-anything-worth-opening check, and hides it with the timestamps", () => {
  const hasContent = APP.match(/const menuHasContent = \[([\s\S]*?)\]\.some\(Boolean\)/);
  assert.ok(hasContent, "menuHasContent is still an is-any-block-non-empty list");
  assert.match(hasContent[1], /menuRating/, "the rating block is folded into it");
  assert.match(APP, /\{!pendingTerminal && menuRating\}\s*\{!pendingTerminal && menuTimestamps\}/, "drawn directly above the timestamps");
});

test("no rule in styles.css addresses a rating block nothing emits", () => {
  const css = readFileSync(join(REPO, "apps/web/src/styles.css"), "utf8");
  const tsx = readdirSync(join(REPO, "apps/web/src"))
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => readFileSync(join(REPO, "apps/web/src", f), "utf8"))
    .join("\n");
  for (const gone of ["task-card-poop-row", "task-card-poop-label", "poop-track-editable"]) {
    assert.doesNotMatch(css, new RegExp(`\\.${gone}\\b`), `${gone} has no rules left`);
    assert.doesNotMatch(tsx, new RegExp(gone), `${gone} is emitted nowhere`);
  }
  for (const kept of ["task-card-menu-rating", "poop-track", "poop-slot-on"]) {
    assert.match(css, new RegExp(`\\.${kept}\\b`), `${kept} is styled`);
    assert.match(readFileSync(join(REPO, "apps/web/src/poop-rating.tsx"), "utf8"), new RegExp(kept), `${kept} is emitted`);
  }
});
