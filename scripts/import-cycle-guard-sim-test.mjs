/*
 * Covers the import-cycle guard itself: the thing that stops `packages/shared`
 * growing a value-level cycle again (#244).
 *
 * The cases that matter are the ones the off-the-shelf tools get wrong. A
 * type-only edge erases at compile time and cannot crash, so it must not count.
 * A value edge must, including the moment a `import type` loses its `type`
 * keyword. And the guard has to enumerate *simple* cycles rather than report a
 * deduplicated count, because a count that doesn't move is how #205 shipped
 * believing it had cleaned the package.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { findValueCycles } from "./assert-no-import-cycles.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

/* Writes { "a.ts": "...source..." } into a throwaway directory and analyses it. */
const analyse = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cycle-guard-"));
  try {
    for (const [name, source] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), source);
    }
    return findValueCycles(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/* Cycles are rotation-independent, so compare them as a canonical rotation. */
const canonical = (cycle) => {
  const at = cycle.indexOf([...cycle].sort()[0]);
  return [...cycle.slice(at), ...cycle.slice(0, at)].join(" -> ");
};
const canonicalAll = (cycles) => cycles.map(canonical).sort();

test("the real packages/shared is clean today", () => {
  const cycles = findValueCycles(path.join(repoRoot, "packages/shared/src"));
  assert.deepEqual(cycles, [], `unexpected value cycles: ${JSON.stringify(cycles)}`);
});

test("a type-only loop is not a cycle", () => {
  const cycles = analyse({
    "a.ts": 'import type { B } from "./b.js";\nexport const a = (b: B) => b;\n',
    "b.ts": 'import { a } from "./a.js";\nexport type B = { n: number };\nexport const b = () => a;\n'
  });
  assert.deepEqual(cycles, []);
});

test("a type-only loop turns into a cycle the moment the `type` keyword goes", () => {
  const cycles = analyse({
    "a.ts": 'import { B } from "./b.js";\nexport const a = () => B;\n',
    "b.ts": 'import { a } from "./a.js";\nexport const B = 1;\nexport const b = () => a;\n'
  });
  assert.deepEqual(canonicalAll(cycles), ["a.ts -> b.ts"]);
});

test("per-specifier `type` markers are honoured, and one value specifier is enough", () => {
  const typeOnly = analyse({
    "a.ts": 'import { type B, type C } from "./b.js";\nexport const a = (x: B, y: C) => [x, y];\n',
    "b.ts": 'import { a } from "./a.js";\nexport type B = 1;\nexport type C = 2;\nexport const b = () => a;\n'
  });
  assert.deepEqual(typeOnly, []);

  const mixed = analyse({
    "a.ts": 'import { type B, v } from "./b.js";\nexport const a = (x: B) => [x, v];\n',
    "b.ts": 'import { a } from "./a.js";\nexport type B = 1;\nexport const v = 2;\nexport const b = () => a;\n'
  });
  assert.deepEqual(canonicalAll(mixed), ["a.ts -> b.ts"]);
});

test("a fresh two-module value cycle is caught, with the modules named in order", () => {
  const cycles = analyse({
    "one.ts": 'import { two } from "./two.js";\nexport const one = () => two();\n',
    "two.ts": 'import { one } from "./one.js";\nexport const two = () => one;\n'
  });
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0], ["one.ts", "two.ts"]);
});

test("a longer cycle is reported as a walkable path", () => {
  const cycles = analyse({
    "a.ts": 'import { b } from "./b.js";\nexport const a = () => b;\n',
    "b.ts": 'import { c } from "./c.js";\nexport const b = () => c;\n',
    "c.ts": 'import { a } from "./a.js";\nexport const c = () => a;\n'
  });
  assert.deepEqual(canonicalAll(cycles), ["a.ts -> b.ts -> c.ts"]);
});

test("overlapping loops are enumerated separately, not collapsed into one count", () => {
  /* a->b->a and a->b->c->a share the a->b edge. Tools that dedupe report one. */
  const cycles = analyse({
    "a.ts": 'import { b } from "./b.js";\nexport const a = () => b;\n',
    "b.ts": 'import { a } from "./a.js";\nimport { c } from "./c.js";\nexport const b = () => [a, c];\n',
    "c.ts": 'import { a } from "./a.js";\nexport const c = () => a;\n'
  });
  assert.deepEqual(canonicalAll(cycles), ["a.ts -> b.ts", "a.ts -> b.ts -> c.ts"]);
});

test("a barrel's `export *` fan-out is not a cycle", () => {
  const cycles = analyse({
    "index.ts": 'export * from "./a.js";\nexport * from "./b.js";\n',
    "a.ts": "export const a = 1;\n",
    "b.ts": "export const b = 2;\n"
  });
  assert.deepEqual(cycles, []);
});

test("a re-export that closes a loop is a value cycle, but `export type` is not", () => {
  const value = analyse({
    "a.ts": 'export * from "./b.js";\nexport const a = 1;\n',
    "b.ts": 'import { a } from "./a.js";\nexport const b = () => a;\n'
  });
  assert.deepEqual(canonicalAll(value), ["a.ts -> b.ts"]);

  const typeOnly = analyse({
    "a.ts": 'export type { B } from "./b.js";\nexport const a = 1;\n',
    "b.ts": 'import { a } from "./a.js";\nexport type B = 1;\nexport const b = () => a;\n'
  });
  assert.deepEqual(typeOnly, []);
});

test("a self-import is a cycle of one", () => {
  const cycles = analyse({ "solo.ts": 'import { x } from "./solo.js";\nexport const x = 1;\n' });
  assert.deepEqual(cycles, [["solo.ts"]]);
});

test("imports that leave the analysed tree are ignored", () => {
  const cycles = analyse({
    "a.ts": 'import fs from "node:fs";\nimport { z } from "@loan-tasks/shared";\nexport const a = () => [fs, z];\n'
  });
  assert.deepEqual(cycles, []);
});
