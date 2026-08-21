#!/usr/bin/env node
/*
 * The sim tests import the compiled `packages/shared/dist` and
 * `apps/server/dist`, not source — deliberately, so they exercise exactly what
 * ships. The cost is that editing a source file and running one test silently
 * exercises the previous build, and a green run means nothing.
 *
 * `test:all` rebuilds first (`pretest:all`) so the gate can't lie. Individual
 * `test:*` runs stay fast instead, and get this guard: compare the newest
 * source mtime against the oldest emitted file per workspace, and refuse to run
 * against a stale build rather than passing against one. Costs milliseconds,
 * and inside the `test:all` chain it always passes because the rebuild just
 * ran.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const WORKSPACES = [
  { name: "@loan-tasks/shared", src: "packages/shared/src", dist: "packages/shared/dist" },
  { name: "@loan-tasks/server", src: "apps/server/src", dist: "apps/server/dist" }
];

/* Newest mtime under `dir`, or null if the directory has no files at all.
   Compiled output is compared at its *oldest* file, source at its newest: a
   partial build is stale even if some of it is newer than every source file. */
const mtimes = (dir) => {
  const stack = [dir];
  const out = [];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else out.push(fs.statSync(full).mtimeMs);
    }
  }
  return out.length ? out : null;
};

const stale = [];
for (const workspace of WORKSPACES) {
  const src = mtimes(path.join(root, workspace.src));
  const dist = mtimes(path.join(root, workspace.dist));
  if (!src) continue;
  if (!dist) {
    stale.push(`${workspace.name}: never built (${workspace.dist} is missing or empty)`);
    continue;
  }
  if (Math.max(...src) > Math.min(...dist)) {
    stale.push(`${workspace.name}: ${workspace.src} is newer than ${workspace.dist}`);
  }
}

if (stale.length) {
  console.error("Stale build — the sim tests read dist, so this run would test the previous build:\n");
  for (const line of stale) console.error(`  - ${line}`);
  console.error("\nRun `npm run build:sim` (or `npm run test:all`, which builds first).");
  process.exit(1);
}
