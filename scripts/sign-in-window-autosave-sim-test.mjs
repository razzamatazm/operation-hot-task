#!/usr/bin/env node
/* A New Task form opened while Teams sign-in is out (#478). App's session then
   has no owner yet, but once the sign-in token is stored its requests go out as
   the real person. Such a form never loaded the person's Autosave, so it must
   not write, clear or replace it, and nothing is kept under an empty person id.
   Its own typing carries into the person's session once they are known.

   Run: `node --test scripts/sign-in-window-autosave-sim-test.mjs`. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(REPO, "node_modules", ".sign-in-window-autosave-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const entry = join(scratch, "entry.ts");
const src = (file) => JSON.stringify(join(REPO, "apps/web/src", file));
writeFileSync(
  entry,
  `export * from ${src("new-task-session.ts")};\n` +
    `export { BLANK_CREATE_FORM } from ${src("create-form-state.ts")};\n` +
    `export { DRAFT_KEY_PREFIX, draftKey, serializeDraft } from ${src("create-form-draft.ts")};\n`
);
const bundle = join(scratch, "sign-in-window-autosave.mjs");
await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  format: "esm",
  external: ["react", "@loan-tasks/shared"],
  logLevel: "silent"
});
const { createNewTaskSession, carrySignInForm, BLANK_CREATE_FORM, DRAFT_KEY_PREFIX, draftKey, serializeDraft } = await import(
  pathToFileURL(bundle).href
);

/* ── Fakes ──────────────────────────────────────────────── */

const START = Date.parse("2026-09-29T15:00:00Z");

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const fakeClock = () => {
  let now = START;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (run, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
        await settle();
      }
      now = until;
      await settle();
    }
  };
};

const values = (over = {}) => ({ ...BLANK_CREATE_FORM, initialItems: [], ...over });
/* Typed before the reload, and never saved anywhere else. */
const BEFORE_RELOAD = values({ folderName: "Castillo - Ridge", taskType: "FRAUD", notes: "typed before the reload" });

/* One server holding Dana's Autosave. Before the token is stored a request
   with no identity is refused (401); after, every request is Dana's, whichever
   session sent it, as App's global token cache makes it. */
const fakeServer = () => {
  let seq = 0;
  const server = {
    signedIn: false,
    autosave: { ownerId: "user-1", savedAt: new Date(START - 60_000).toISOString(), form: BEFORE_RELOAD },
    drafts: [],
    calls: [],
    request: (path, init) => {
      const call = { method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined, signedIn: server.signedIn };
      server.calls.push(call);
      if (!server.signedIn) return Promise.reject(Object.assign(new Error("Authentication required"), { status: 401 }));
      if (path === "/autosave" && init.method === "GET") return Promise.resolve({ item: server.autosave });
      if (path === "/autosave" && init.method === "PUT") {
        server.autosave = { ownerId: "user-1", savedAt: new Date(START).toISOString(), form: call.body.form };
        return Promise.resolve({ item: server.autosave });
      }
      if (path === "/autosave" && init.method === "DELETE") {
        server.autosave = null;
        return Promise.resolve(undefined);
      }
      if (path === "/saved-for-later" && init.method === "POST") {
        if (call.body.clearAutosave) server.autosave = null;
        seq += 1;
        const item = { id: `sfl-${seq}`, ownerId: "user-1", savedAt: new Date(START).toISOString(), form: call.body.form };
        server.drafts.push(item);
        return Promise.resolve({ item });
      }
      return Promise.resolve({});
    },
    /* Where Dana's typing from before the reload is now, if anywhere. */
    keepsBeforeReload: () =>
      JSON.stringify(server.autosave?.form) === JSON.stringify(BEFORE_RELOAD) ||
      server.drafts.some((draft) => JSON.stringify(draft.form) === JSON.stringify(BEFORE_RELOAD))
  };
  return server;
};

const fakeStorage = () => {
  const items = new Map();
  return {
    items,
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, value),
    removeItem: (key) => items.delete(key)
  };
};

/* App during a Teams arrival: the tab reloads with nobody known, New Task can
   be pressed at once, the token is stored, then /me answers and the person's
   own session takes over and runs the arrival. */
const setup = () => {
  const clock = fakeClock();
  const server = fakeServer();
  const storage = fakeStorage();
  const loads = [];
  const make = (owner) => createNewTaskSession({ owner, request: server.request, storage, clock });
  const signingIn = make("");
  const signIn = async ({ arrival = true } = {}) => {
    const dana = make("user-1");
    carrySignInForm(signingIn, dana);
    signingIn.close();
    if (arrival) await dana.arrive({ load: () => loads.push(dana.getState().phase) });
    await clock.advance(5000);
    return dana;
  };
  const emptyIdKeys = () => [...storage.items.keys()].filter((key) => key === DRAFT_KEY_PREFIX);
  return { clock, server, storage, signingIn, signIn, emptyIdKeys, loads };
};

const WINDOW_TYPING = values({ folderName: "Alvarez", notes: "typed while signing in" });

/* ── The reported sequence ──────────────────────────────── */

test("a form typed into while signing in doesn't write over the Autosave from before the reload", async () => {
  const ctx = setup();
  assert.equal(await ctx.signingIn.open(), true);
  assert.equal(ctx.signingIn.getState().values.folderName, "", "it never loaded the Autosave");

  ctx.signingIn.edit(WINDOW_TYPING);
  ctx.server.signedIn = true;
  await ctx.clock.advance(1000);

  assert.deepEqual(
    ctx.server.calls.filter((call) => call.signedIn && call.method !== "GET").map((call) => [call.method, call.path]),
    [],
    "nothing goes out as the person before they are known"
  );
  assert.ok(ctx.server.keepsBeforeReload(), "the Autosave from before the reload is still there");
  assert.deepEqual(ctx.emptyIdKeys(), [], "nothing kept under an empty person id");

  await ctx.signIn();
  assert.ok(ctx.server.keepsBeforeReload(), "the arrival moved the real Autosave, not the sign-in form's typing");
  assert.ok(
    ctx.server.drafts.some((draft) => draft.form.notes === "typed while signing in"),
    "and the typing from the sign-in window is on Task Drafts too"
  );
  assert.deepEqual(ctx.emptyIdKeys(), []);
});

test("typing before the token is stored keeps no offline copy under an empty person id", async () => {
  const ctx = setup();
  await ctx.signingIn.open();
  ctx.signingIn.edit(WINDOW_TYPING);
  await ctx.clock.advance(1000);
  assert.deepEqual(ctx.emptyIdKeys(), []);
});

for (const [name, ending] of [
  ["Discard", { kind: "discard" }],
  ["Start fresh", { kind: "startFresh" }],
  ["Create", { kind: "create", file: async () => {} }]
]) {
  test(`${name} on a form opened while signing in doesn't clear the Autosave it never loaded`, async () => {
    const ctx = setup();
    await ctx.signingIn.open();
    ctx.signingIn.edit(WINDOW_TYPING);
    ctx.server.signedIn = true;
    await ctx.signingIn.end(ending);
    await ctx.clock.advance(1000);
    assert.ok(ctx.server.keepsBeforeReload());
    assert.deepEqual(ctx.emptyIdKeys(), []);
  });
}

test("Save for later on a form opened while signing in keeps it without clearing the Autosave", async () => {
  const ctx = setup();
  await ctx.signingIn.open();
  ctx.signingIn.edit(WINDOW_TYPING);
  ctx.server.signedIn = true;
  const saved = await ctx.signingIn.end({ kind: "saveForLater" });
  assert.equal(saved.form.notes, "typed while signing in");
  assert.equal(ctx.server.calls.at(-1).body.clearAutosave, undefined);
  assert.ok(ctx.server.keepsBeforeReload());
});

/* ── Once the person is known ───────────────────────────── */

test("with no arrival, the sign-in form's typing stays on screen in the person's session and leaves the Autosave alone", async () => {
  const ctx = setup();
  await ctx.signingIn.open();
  ctx.signingIn.edit(WINDOW_TYPING);
  ctx.server.signedIn = true;
  const dana = await ctx.signIn({ arrival: false });

  const state = dana.getState();
  assert.equal(state.phase, "open");
  assert.deepEqual(state.mode, { kind: "fresh" });
  assert.deepEqual(state.values, WINDOW_TYPING);
  assert.equal(dana.untouched(), false, "Cancel still asks");

  dana.edit({ ...WINDOW_TYPING, notes: "and more" });
  await ctx.clock.advance(5000);
  await dana.end({ kind: "discard" });
  await settle();
  assert.ok(ctx.server.keepsBeforeReload(), "the carried form never writes or clears the Autosave");
});

test("an untouched sign-in form isn't carried, and the person's own New Task opens on their Autosave", async () => {
  const ctx = setup();
  await ctx.signingIn.open();
  ctx.server.signedIn = true;
  const dana = await ctx.signIn({ arrival: false });
  assert.equal(dana.getState().phase, "closed");
  assert.equal(await dana.open(), true);
  assert.deepEqual(dana.getState().values, BEFORE_RELOAD);
  assert.equal(dana.getState().restored, true);
});

test("a known person's session hands nothing on when the dev picker switches person", async () => {
  const clock = fakeClock();
  const server = fakeServer();
  server.signedIn = true;
  const storage = fakeStorage();
  const first = createNewTaskSession({ owner: "user-1", request: server.request, storage, clock });
  await first.open();
  first.edit(WINDOW_TYPING);
  const second = createNewTaskSession({ owner: "user-2", request: server.request, storage, clock });
  carrySignInForm(first, second);
  assert.equal(second.getState().phase, "closed");
});

test("an arrival with nobody known moves nothing", async () => {
  const ctx = setup();
  ctx.server.signedIn = true;
  ctx.storage.setItem(draftKey(""), serializeDraft(values({ notes: "stray" }), START));
  await ctx.signingIn.arrive({ load: () => {} });
  assert.deepEqual(
    ctx.server.calls.map((call) => [call.method, call.path]),
    [],
    "no Autosave read or move under an empty person id"
  );
  assert.ok(ctx.server.keepsBeforeReload());
});
