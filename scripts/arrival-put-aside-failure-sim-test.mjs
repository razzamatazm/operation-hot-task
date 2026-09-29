#!/usr/bin/env node
/* An arrival that can't put aside a typed New Task form (#479): the form
   stays, the arrival is dropped, and the person is told what happened rather
   than shown a Save for later error for a button they never pressed.

   Run: `node --test scripts/arrival-put-aside-failure-sim-test.mjs`. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(REPO, "node_modules", ".arrival-put-aside-failure-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const entry = join(scratch, "entry.ts");
const src = (file) => JSON.stringify(join(REPO, "apps/web/src", file));
writeFileSync(
  entry,
  `export * from ${src("new-task-session.ts")};\n` + `export { BLANK_CREATE_FORM } from ${src("create-form-state.ts")};\n`
);
const bundle = join(scratch, "arrival-put-aside-failure.mjs");
await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  format: "esm",
  external: ["react", "@loan-tasks/shared"],
  logLevel: "silent"
});
const { createNewTaskSession, BLANK_CREATE_FORM } = await import(pathToFileURL(bundle).href);

const DROPPED = "Couldn't open the Humperdink task. Your form is still here.";

const fakeClock = () => ({
  now: () => Date.parse("2026-09-29T15:00:00Z"),
  setTimeout: () => 0,
  clearTimeout: () => {}
});

const setup = (saveFailure) => {
  const calls = [];
  const request = (path, init) => {
    calls.push([init.method, path]);
    if (path === "/saved-for-later" && init.method === "POST") return Promise.reject(saveFailure);
    if (path === "/autosave" && init.method === "GET") return Promise.resolve({ item: null });
    return Promise.resolve({ item: {} });
  };
  const storage = new Map();
  const notices = [];
  const loads = [];
  const session = createNewTaskSession({
    owner: "user-1",
    request,
    storage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key)
    },
    clock: fakeClock(),
    notify: (message, variant) => notices.push([variant, message])
  });
  return { calls, session, notices, load: () => loads.push(session.getState().phase), loads };
};

const typed = { ...BLANK_CREATE_FORM, initialItems: [], folderName: "Alvarez", notes: "mine" };

for (const [why, failure] of [
  ["the server refuses it", new Error("Server said no")],
  ["the server can't be reached", new Error("Failed to fetch")],
  ["the failure isn't even an Error", "boom"]
]) {
  test(`a failed put-aside says the Humperdink task didn't open, not that Save for later failed (${why})`, async () => {
    const ctx = setup(failure);
    await ctx.session.open();
    ctx.session.edit(typed);

    assert.equal(await ctx.session.arrive({ load: ctx.load }), "dropped");

    assert.deepEqual(ctx.notices, [["error", DROPPED]], "one message, and it names what happened");
    const state = ctx.session.getState();
    assert.equal(state.phase, "open");
    assert.deepEqual(state.mode, { kind: "fresh" });
    assert.deepEqual(state.values, typed, "the form is untouched");
    assert.deepEqual(ctx.loads, ["open"], "the drafts still load");
  });
}

test("a Save for later the person pressed still fails with its own error, and the session adds no message", async () => {
  const ctx = setup(new Error("Server said no"));
  await ctx.session.open();
  ctx.session.edit(typed);

  await assert.rejects(ctx.session.end({ kind: "saveForLater" }), /Server said no/);
  assert.deepEqual(ctx.notices, []);
  assert.equal(ctx.session.getState().phase, "open");

  const form = readFileSync(join(REPO, "apps/web/src/task-form.tsx"), "utf8");
  assert.match(
    form,
    /showToast\(err instanceof Error \? err\.message : "Failed to save for later", \{ variant: "error" \}\)/,
    "the form's Save for later button shows its own failure"
  );
});
