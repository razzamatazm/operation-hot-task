#!/usr/bin/env node
/*
 * Fails when `packages/shared` grows a *value-level* import cycle.
 *
 * Two prior tickets (#205, #227) cleared cycles out of that package by hand.
 * Nothing held the ground they took, and the failure mode when one comes back
 * is quiet: a module-scope `const` that reads across a cycle throws at import
 * time, on a line that looks innocent, and bundlers resolve it silently until
 * they don't.
 *
 * Why this is hand-rolled rather than `madge --circular`:
 *
 *  - madge counts `import type` edges. `types.ts` type-imports `ChecklistItem`
 *    from `checklist.ts`, which closes a loop that erases at compile time and
 *    cannot crash, so madge reports 1 on a clean tree. Stripping type-only
 *    edges before looking for loops is better than allow-listing that one loop:
 *    it stays correct if the loop is refactored away, and it fires the moment
 *    that import loses its `type` keyword, which is exactly the hazard the
 *    standing comment there warns about.
 *  - madge dedupes overlapping cycles, so its number is not a signal. #205
 *    shipped believing it had fixed the package because the count didn't move.
 *    This enumerates *simple* cycles, so a pass means zero and a failure names
 *    every distinct loop.
 *
 * The edges come from the TypeScript parser (already a pinned devDependency),
 * so `import type`, `export type`, and per-specifier `type` markers are read
 * the way the compiler reads them rather than by regex. Only static imports
 * count; a `import()` is evaluated later and can't deadlock module init.
 *
 * Usage: `node scripts/assert-no-import-cycles.mjs [dir ...]`
 * Default target is `packages/shared/src`. Passing a directory is how the
 * apps get audited without the guard being switched on for them.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "build", ".git"]);

/* Every source file under `dir`, as absolute paths. */
const sourceFiles = (dir) => {
  const found = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) stack.push(path.join(current, entry.name));
      } else if (SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
        found.push(path.join(current, entry.name));
      }
    }
  }
  return found.sort();
};

/* This repo writes ESM specifiers, so `./checklist.js` names `checklist.ts`.
   Try the literal path, then the TS source behind a JS extension, then bare
   extensions, then a directory index. Anything unresolved is outside the tree
   (a package, a node builtin) and carries no edge worth tracking. */
const resolveSpecifier = (fromFile, specifier, known) => {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base];
  const ext = path.extname(base);
  if (ext) {
    const withoutExt = base.slice(0, -ext.length);
    const swaps = { ".js": [".ts", ".tsx"], ".mjs": [".mts"], ".cjs": [".cts"], ".jsx": [".tsx"] };
    for (const swap of swaps[ext] ?? []) candidates.push(withoutExt + swap);
  }
  for (const candidate of SOURCE_EXTENSIONS) candidates.push(base + candidate);
  for (const candidate of SOURCE_EXTENSIONS) candidates.push(path.join(base, "index" + candidate));
  return candidates.find((candidate) => known.has(candidate)) ?? null;
};

/* True when the whole declaration erases at compile time.
   `import type { X }`, `export type { X }`, and the per-specifier form
   `import { type X, type Y }` all do; one value specifier is enough not to. */
const isTypeOnly = (node) => {
  const clause = ts.isImportDeclaration(node) ? node.importClause : node;
  if (!clause) return false; /* `import "./side-effect.js"` runs at runtime. */
  if (clause.isTypeOnly) return true;
  const bindings = ts.isImportDeclaration(node) ? clause.namedBindings : clause.exportClause;
  if (!bindings) return false; /* `export *`, or a default/namespace import. */
  if (!ts.isNamedImports(bindings) && !ts.isNamedExports(bindings)) return false;
  return bindings.elements.every((element) => element.isTypeOnly);
};

/* Value-level static import edges out of one file. */
const valueEdges = (file, known) => {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    file.endsWith("x") ? ts.ScriptKind.TSX : undefined
  );
  const edges = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier)) continue;
    if (isTypeOnly(statement)) continue;
    const target = resolveSpecifier(file, specifier.text, known);
    if (target) edges.add(target);
  }
  return [...edges];
};

/* Every simple cycle, Johnson-style: search from each node using only nodes at
   or after it in a fixed order, so each cycle surfaces once, at its lowest
   member, rather than once per rotation. Overlapping loops stay distinct. */
const simpleCycles = (nodes, edgesOf, limit) => {
  const rank = new Map(nodes.map((node, index) => [node, index]));
  const cycles = [];
  for (const start of nodes) {
    const floor = rank.get(start);
    const path = [];
    const onPath = new Set();
    const walk = (node) => {
      if (cycles.length >= limit) return;
      path.push(node);
      onPath.add(node);
      for (const next of edgesOf(node)) {
        if (rank.get(next) < floor) continue;
        if (next === start) cycles.push([...path]);
        else if (!onPath.has(next)) walk(next);
        if (cycles.length >= limit) break;
      }
      path.pop();
      onPath.delete(node);
    };
    walk(start);
    if (cycles.length >= limit) break;
  }
  return cycles;
};

/* Cap the search: a badly tangled tree can hold combinatorially many simple
   cycles, and a guard that hangs is worse than one that reports the first
   hundred. Reaching the cap still fails; it just under-reports. */
export const CYCLE_LIMIT = 100;

/*
 * Value-level import cycles under `dir`, each as module paths relative to
 * `dir` in the order the imports run. A one-element result is a self-import.
 */
export const findValueCycles = (dir) => {
  const root = path.resolve(dir);
  const files = sourceFiles(root);
  const known = new Set(files);
  const graph = new Map(files.map((file) => [file, valueEdges(file, known)]));
  const cycles = simpleCycles(files, (file) => graph.get(file) ?? [], CYCLE_LIMIT);
  return cycles.map((cycle) => cycle.map((file) => path.relative(root, file)));
};

const DEFAULT_TARGETS = ["packages/shared/src"];

const main = () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const targets = process.argv.slice(2);
  const dirs = (targets.length ? targets : DEFAULT_TARGETS).map((dir) => path.resolve(repoRoot, dir));

  let failed = false;
  for (const dir of dirs) {
    const label = path.relative(repoRoot, dir) || dir;
    if (!fs.existsSync(dir)) {
      console.error(`No such directory: ${label}`);
      failed = true;
      continue;
    }
    const cycles = findValueCycles(dir);
    if (!cycles.length) {
      console.log(`No value-level import cycles in ${label}.`);
      continue;
    }
    failed = true;
    const capped = cycles.length >= CYCLE_LIMIT ? ` (stopped at ${CYCLE_LIMIT})` : "";
    console.error(`\nValue-level import cycles in ${label}${capped}:\n`);
    for (const cycle of cycles) {
      console.error(`  ${[...cycle, cycle[0]].join(" -> ")}`);
    }
  }

  if (failed) {
    console.error(
      "\nA value cycle throws at import time from whichever module happens to load first," +
        "\nso break one edge in each loop above — often by making an import type-only." +
        "\nType-only imports are already ignored here; they erase at compile time.\n"
    );
    process.exit(1);
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main();
