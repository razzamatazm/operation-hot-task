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
 *   - Every task that is not closed — up for grabs, re-offered, claimed, in
 *     flight: the read-only row track (2026-09-14, the user's call, reversing
 *     the 2026-09-10 first-time-in-pool narrowing). A teammate reads the
 *     ratings on in-flight work to judge who is already buried.
 *   - A closed task: a read-only rating in the task menu.
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
  "unclaimed, dropped and re-offered": { make: (o) => task({ pooledSince: LATER, ...o }), surface: "row" },
  claimed: { make: (o) => task({ status: "CLAIMED", assignee: { ...ASSIGNEE }, ...o }), surface: "row" },
  "loan docs mid-merge": {
    make: (o) => task({ status: "MERGE_DONE", assignee: { ...ASSIGNEE }, ...o }),
    surface: "row"
  },
  "loan docs merge approved": {
    make: (o) => task({ status: "MERGE_APPROVED", assignee: { ...ASSIGNEE }, ...o }),
    surface: "row"
  },
  "fraud check awaiting items": {
    make: (o) => task({ taskType: "FRAUD", status: "AWAITING_ITEMS", assignee: { ...ASSIGNEE }, ...o }),
    surface: "row"
  },
  "loi in review": {
    make: (o) => task({ taskType: "LOI", status: "NEEDS_REVIEW", assignee: { ...ASSIGNEE }, ...o }),
    surface: "row"
  },
  "out of office, unclaimed": { make: (o) => task({ taskType: "OOO", ...o }), surface: "row" },
  "fraud check released for any checker": {
    make: (o) => task({ taskType: "FRAUD", status: "PENDING_APPROVAL", pooledSince: LATER, ...o }),
    surface: "row"
  },
  completed: { make: (o) => task({ status: "COMPLETED", assignee: { ...ASSIGNEE }, ...o }), surface: "menu" },
  cancelled: { make: (o) => task({ status: "CANCELLED", ...o }), surface: "menu" },
  archived: { make: (o) => task({ status: "ARCHIVED", assignee: { ...ASSIGNEE }, ...o }), surface: "menu" }
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
  const menu = render("menu", STATES.completed.make());
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

/* 2026-09-14, the user's call: one layout for an active row at every width.
   Loan name, then the type with its rating right beside it (the rating
   describes the type), then the step, then the names. It used to share the
   step's line, beside the type on a wide screen and under the step on a phone,
   so the poops moved around from one width to the next. */
test("the rating sits beside the type, and the step takes its own line, at every width", () => {
  const css = readFileSync(join(REPO, "apps/web/src/styles.css"), "utf8");
  assert.match(
    APP,
    /<span className="task-card-collapsed-type-text">\{TASK_TYPE_LABELS\[task\.taskType\]\}<\/span>\s*\{!mini && ratingBlock\("row", task\)\}\s*\{!mini && \(\s*<span className="task-card-collapsed-stage">/,
    "the row draws the type, then its rating, then the step"
  );
  assert.match(
    css,
    /\.task-card-grouped:not\(\.task-card-grouped-mini\) \.task-card-collapsed-type > \.poop-track \{\s*flex: 0 0 auto;/,
    "the rating is a fixed item on the type's line"
  );
  assert.match(
    css,
    /\.task-card-grouped:not\(\.task-card-grouped-mini\) \.task-card-collapsed-stage \{[^}]*flex: 0 0 100%;[^}]*white-space: nowrap;/,
    "the step takes a whole line of its own, and never breaks mid-phrase"
  );
  /* The unread dot rides the loan name's line (2026-09-14, the user's call), so
     the type's line holds the type and its rating and nothing else. */
  assert.match(
    APP,
    /<span className="task-card-collapsed-name-line">\s*<span className="task-card-collapsed-folder">[\s\S]*?<\/span>\s*\{hasUnreadNote && \(\s*<span className="task-card-unread-dot"/,
    "the dot sits beside the loan name"
  );
  const typeCell = APP.slice(APP.indexOf("task-card-collapsed-type task-type-"), APP.indexOf("task-card-grouped-due"));
  assert.ok(typeCell.length > 0, "the type cell is where it was");
  assert.doesNotMatch(typeCell, /task-card-unread-dot/, "and not at the end of the type");
  assert.equal((APP.match(/className="task-card-unread-dot"/g) ?? []).length, 1, "one dot on the row");
  assert.match(
    css,
    /\.task-card-collapsed-name-line \{[^}]*flex: 0 1 auto;[^}]*min-width: 0;/,
    "the name's line lets the name give, so the dot is never cut"
  );
  assert.doesNotMatch(css, /@media \(max-width: 900px\)/, "no breakpoint rearranges the active row's title");
  assert.doesNotMatch(css, /\.poop-track \{[^}]*flex-basis: 100%/, "no rule drops the rating onto a line of its own");
  assert.doesNotMatch(APP + css, /task-card-collapsed-status|task-card-collapsed-stage-join/, "the shared step-and-rating box is gone");
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
