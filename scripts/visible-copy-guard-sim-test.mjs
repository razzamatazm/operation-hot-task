/*
 * Retired wording stays off the screen (#384).
 *
 * The web app's visible text must not use a phrase in RETIRED_COPY. Today that
 * is "Saved for Later", which the screen calls a Task Draft since the Task
 * Drafts tab (#363). Comments may keep it: in code the domain term is still
 * Saved for Later task (CONTEXT.md, ADR-0011).
 *
 * The fixtures below pin the guard itself, so it is known to catch a string or
 * JSX text and to ignore a comment. New retired phrases go in RETIRED_COPY in
 * scripts/visible-copy-guard.mjs; the real-tree check here picks them up.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { RETIRED_COPY, retiredCopyIn, retiredCopyUnder } from "./visible-copy-guard.mjs";

const webSource = path.resolve(import.meta.dirname, "..", "apps/web/src");

test("no visible text in apps/web/src uses a retired phrase", () => {
  const hits = retiredCopyUnder(webSource);
  assert.deepEqual(
    hits,
    [],
    "retired wording on screen:\n" +
      hits.map((hit) => `  ${hit.file}:${hit.line} ${JSON.stringify(hit.text)} -> say "${hit.use}"`).join("\n")
  );
});

test("a string literal with Saved for Later is caught, whatever its case", () => {
  const source = [
    'showToast("That Saved for Later task is gone.");',
    "const label = 'saved FOR later';"
  ].join("\n");
  assert.deepEqual(
    retiredCopyIn(source, "fixture.ts").map((hit) => hit.line),
    [1, 2]
  );
});

test("a template literal with Saved for Later is caught, in any piece of it", () => {
  const source = [
    "const plain = `Saved for Later`;",
    "const head = `Saved for Later: ${name}`;",
    "const tail = `${count} Saved for Later tasks`;"
  ].join("\n");
  assert.deepEqual(
    retiredCopyIn(source, "fixture.ts").map((hit) => hit.line),
    [1, 2, 3]
  );
});

test("JSX text and a JSX attribute with Saved for Later are caught", () => {
  const source = [
    "export const Row = () => (",
    '  <p title="Saved for Later">',
    "    Your Saved for Later tasks",
    "  </p>",
    ");"
  ].join("\n");
  assert.deepEqual(
    retiredCopyIn(source, "fixture.tsx").map((hit) => hit.line),
    [2, 3]
  );
});

test("JSX text a formatter wrapped mid-phrase is still caught, as the screen collapses the break", () => {
  const source = [
    "export const Empty = () => (",
    "  <p>",
    "    Nothing in your Saved for",
    "    Later list yet",
    "  </p>",
    ");"
  ].join("\n");
  assert.equal(retiredCopyIn(source, "fixture.tsx").length, 1);
});

test("comments with Saved for Later are not caught", () => {
  const source = [
    "// Removes the Saved for Later task once the create landed.",
    "/* A Saved for Later task, reopened (#344). */",
    "export const Row = () => (",
    "  <p>",
    "    {/* the Saved for Later row */}",
    "    Task Drafts",
    "  </p>",
    ");"
  ].join("\n");
  assert.deepEqual(retiredCopyIn(source, "fixture.tsx"), []);
});

test("identifiers, and the Save for later button's own words, are not caught", () => {
  const source = [
    'import { removeSavedForLaterRequest } from "./saved-for-later-requests";',
    "const savedForLater = [];",
    "export const Button = () => <button>Save for later</button>;",
    'const answer = "Save for later";'
  ].join("\n");
  assert.deepEqual(retiredCopyIn(source, "fixture.tsx"), []);
});

test("a hit names the wording to use instead", () => {
  const [hit] = retiredCopyIn('showToast("Couldn\'t delete that Saved for Later task.");', "fixture.ts");
  assert.equal(hit.use, "Task Draft");
});

test("every retired phrase says what to use and why", () => {
  for (const rule of RETIRED_COPY) {
    assert.ok(rule.phrase instanceof RegExp, "phrase is a RegExp");
    assert.ok(!rule.phrase.global && !rule.phrase.sticky, "a g or y flag makes .test() stateful");
    assert.ok(rule.use.trim(), `${rule.phrase} names its replacement`);
    assert.ok(rule.why.trim(), `${rule.phrase} says why`);
  }
});
