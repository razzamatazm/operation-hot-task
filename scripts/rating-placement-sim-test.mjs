#!/usr/bin/env node
/* Issue #335 — one How Bad? control on an open card, in exactly one place.
 *
 * #332 put a read-only rating back on the collapsed row of a task that is
 * unclaimed and out for the first time. The row does not unmount when the card
 * expands, and the expanded body still led with its own `How Bad?` line, so an
 * open pool task drew the same number twice a few pixels apart. On a claimed
 * task the body led with the rating above the work the card was opened for.
 *
 * The rule now lives in `apps/web/src/poop-rating.tsx` and every surface asks
 * it, so the three placements cannot overlap:
 *
 *   - row  — unclaimed, never dropped, rated (read-only, #332's track)
 *   - body — any other unclaimed task (a dropped one, or an unrated first
 *            timer whose creator still needs somewhere to set it)
 *   - menu — everything else: claimed, in flight, closed
 *
 * and on every surface an unrated task draws nothing unless the viewer may set
 * it. That is a promise about what a person sees, so this file renders the
 * module through `react-dom/server` and reads the markup back, the same
 * arrangement as `instructions-box-sim-test.mjs`. A source check at the end
 * holds App.tsx to drawing these rather than a copy of its own.
 *
 * Run: `node --test scripts/rating-placement-sim-test.mjs`. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const OBSERVER = { id: "observer-1", displayName: "Sam Bystander" };

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

/* The four task states the ticket names. */
const STATES = {
  "unclaimed, never dropped": (o) => task(o),
  "unclaimed, dropped and re-offered": (o) => task({ pooledSince: LATER, ...o }),
  claimed: (o) => task({ status: "CLAIMED", assignee: { ...ASSIGNEE }, ...o }),
  closed: (o) => task({ status: "COMPLETED", assignee: { ...ASSIGNEE }, ...o })
};

const SURFACES = ["row", "body", "menu"];

const render = (surface, t, viewerId, onChange) => {
  const el = ratingBlock(surface, t, viewerId, onChange);
  return el === null ? "" : renderToStaticMarkup(createElement(Fragment, null, el));
};
const buttons = (html) => (html.match(/<button/g) ?? []).length;

test("an open pool task on its first time out shows the rating once, on the row", () => {
  const t = STATES["unclaimed, never dropped"]();
  for (const viewer of [CREATOR, OBSERVER]) {
    const row = render("row", t, viewer.id, () => {});
    assert.match(row, /poop-track/, "the row carries #332's track");
    assert.equal(buttons(row), 0, "and it is read-only, even for the creator");
    assert.equal(render("body", t, viewer.id, () => {}), "", "the expanded body draws no second copy");
    assert.equal(render("menu", t, viewer.id, () => {}), "", "nor does the menu");
  }
});

test("a dropped pool task shows the rating once, in the body, settable by its creator", () => {
  const t = STATES["unclaimed, dropped and re-offered"]();
  assert.equal(render("row", t, CREATOR.id), "", "no row track once it has been dropped");
  const body = render("body", t, CREATOR.id, () => {});
  assert.match(body, /How Bad\?/);
  assert.equal(buttons(body), 5, "five slots the creator can press");
  assert.equal(render("menu", t, CREATOR.id, () => {}), "");
});

test("a claimed task draws no rating in the body; the menu carries it as five icons", () => {
  const t = STATES.claimed();
  assert.equal(render("row", t, CREATOR.id), "");
  assert.equal(render("body", t, CREATOR.id, () => {}), "", "the body leads with the timeline, not the rating");
  const menu = render("menu", t, CREATOR.id, () => {});
  assert.match(menu, /role="group"/, "a labelled group, an owned role of menu");
  assert.match(menu, /aria-label="How Bad\?"/);
  assert.doesNotMatch(menu, /role="menuitem/, "reference detail, not an arrow-key stop");
  assert.equal(buttons(menu), 5, "the same five clickable icons, not a 3/5 count");
  for (let n = 1; n <= 5; n += 1) {
    assert.match(menu, new RegExp(`aria-label="Set How Bad\\? to ${n}" aria-pressed="${n <= 3}"`), `slot ${n} keeps its label and pressed state`);
  }
});

test("pressing a slot in the menu hands the new value to the caller's handler", () => {
  const seen = [];
  const el = ratingBlock("menu", STATES.claimed(), CREATOR.id, (n) => seen.push(n));
  /* Walk the element tree to the fourth slot's button and press it. */
  const find = (node, pred) => {
    if (!node || typeof node !== "object") return undefined;
    if (Array.isArray(node)) { for (const c of node) { const hit = find(c, pred); if (hit) return hit; } return undefined; }
    if (pred(node)) return node;
    if (typeof node.type === "function") return find(node.type(node.props), pred);
    return find(node.props?.children, pred);
  };
  const slot = find(el, (n) => n.type === "button" && n.props?.["aria-label"] === "Set How Bad? to 4");
  assert.ok(slot, "the fourth slot is a button");
  slot.props.onClick({ stopPropagation() {} });
  assert.deepEqual(seen, [4]);
});

test("anyone but the creator reads the menu's rating without buttons or hover affordance", () => {
  for (const viewer of [ASSIGNEE, OBSERVER]) {
    const menu = render("menu", STATES.claimed(), viewer.id, () => {});
    assert.match(menu, /aria-label="How Bad\?"/, "still readable");
    assert.equal(buttons(menu), 0, "no buttons");
    assert.doesNotMatch(menu, /poop-track-editable/, "no hover affordance");
  }
});

test("a closed task's rating is readable and not editable in the menu, creator included", () => {
  const menu = render("menu", STATES.closed(), CREATOR.id, () => {});
  assert.match(menu, /poop-slot-on/);
  assert.equal(buttons(menu), 0);
  assert.doesNotMatch(menu, /poop-track-editable/);
});

test("an unrated task draws nothing anywhere, except one settable control for the creator of an open task", () => {
  for (const [state, make] of Object.entries(STATES)) {
    const t = make({ points: 0 });
    for (const viewer of [CREATOR, ASSIGNEE, OBSERVER]) {
      const drawn = SURFACES.filter((s) => render(s, t, viewer.id, () => {}) !== "");
      const creatorOfOpen = viewer === CREATOR && state !== "closed";
      assert.equal(drawn.length, creatorOfOpen ? 1 : 0, `${state}, ${viewer.displayName}: drew ${drawn.join(", ") || "nothing"}`);
      for (const s of drawn) assert.equal(buttons(render(s, t, viewer.id, () => {})), 5, `${state}: the one control is settable`);
    }
  }
});

test("every state, viewer and rating draws the control in at most one place", () => {
  for (const [state, make] of Object.entries(STATES)) {
    for (const points of [0, 1, 5]) {
      for (const viewer of [CREATOR, ASSIGNEE, OBSERVER]) {
        const drawn = SURFACES.filter((s) => render(s, make({ points }), viewer.id, () => {}) !== "");
        assert.ok(drawn.length <= 1, `${state}, ${points}, ${viewer.displayName}: drew ${drawn.join(" and ")}`);
        if (points > 0) assert.equal(drawn.length, 1, `${state}, ${points}, ${viewer.displayName}: a rated task shows it somewhere`);
      }
    }
  }
});

test("App.tsx draws the shared module on all three surfaces and keeps no copy of its own", () => {
  const app = readFileSync(join(REPO, "apps/web/src/App.tsx"), "utf8");
  assert.match(app, /from "\.\/poop-rating"/);
  assert.doesNotMatch(app, /const PoopDisplay\s*=/, "no second rating component");
  for (const surface of SURFACES) {
    assert.match(app, new RegExp(`ratingBlock\\("${surface}"`), `the ${surface} asks the rule`);
  }
  const hasContent = app.match(/const menuHasContent = \[([\s\S]*?)\]\.some\(Boolean\)/);
  assert.ok(hasContent, "menuHasContent is still an is-any-block-non-empty list");
  assert.match(hasContent[1], /menuRating/, "the rating block is folded into it");
  assert.match(app, /!pendingTerminal && menuRating/, "the panel draws it with the rest of the reference foot");
});

test("the menu block has a rule to sit in, and the body line's rules are still emitted", () => {
  const css = readFileSync(join(REPO, "apps/web/src/styles.css"), "utf8");
  const module = readFileSync(join(REPO, "apps/web/src/poop-rating.tsx"), "utf8");
  for (const cls of ["task-card-menu-rating", "task-card-poop-row", "task-card-poop-label"]) {
    assert.match(css, new RegExp(`\\.${cls}\\b`), `${cls} is styled`);
    assert.match(module, new RegExp(`"${cls}"`), `${cls} is emitted`);
  }
});
