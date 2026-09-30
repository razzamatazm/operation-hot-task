#!/usr/bin/env node
/* A Humperdink arrival through the New Task session (#473): putting aside a
   form opened while Hot Task was loading, moving the Autosave to Task Drafts,
   loading, and opening the LOI Check, driven through the session's interface
   against a fake server and a fake clock.

   Run: `node --test scripts/arrival-task-session-sim-test.mjs`. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(REPO, "node_modules", ".arrival-task-session-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const entry = join(scratch, "entry.ts");
const src = (file) => JSON.stringify(join(REPO, "apps/web/src", file));
writeFileSync(
  entry,
  `export * from ${src("new-task-session.ts")};\n` +
    `export { BLANK_CREATE_FORM } from ${src("create-form-state.ts")};\n` +
    `export { draftKey, serializeDraft } from ${src("create-form-draft.ts")};\n`
);
const bundle = join(scratch, "arrival-task-session.mjs");
await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  format: "esm",
  external: ["react", "@loan-tasks/shared"],
  logLevel: "silent"
});
const { createNewTaskSession, BLANK_CREATE_FORM, draftKey, serializeDraft } = await import(pathToFileURL(bundle).href);

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

const unreachable = () => new Error("Failed to fetch");

/* Every request is recorded. `autosave` is the server's slot; `answer` can
   override any call, and `hold` parks matching requests until released. */
const fakeServer = () => {
  const calls = [];
  const held = [];
  let seq = 0;
  const server = {
    calls,
    held,
    autosave: null,
    answer: null,
    hold: null,
    request: (path, init) => {
      const call = { method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined };
      calls.push(call);
      const respond = () => {
        try {
          if (server.answer) {
            const answered = server.answer(call);
            if (answered !== undefined) return Promise.resolve(answered);
          }
          if (call.path === "/autosave" && call.method === "GET") return Promise.resolve({ item: server.autosave });
          if (call.path === "/autosave" && call.method === "DELETE") {
            server.autosave = null;
            return Promise.resolve(undefined);
          }
          if (call.path === "/autosave" && call.method === "PUT") return Promise.resolve({ item: {} });
          if (call.path === "/saved-for-later" && call.method === "POST") {
            if (call.body.clearAutosave) server.autosave = null;
            seq += 1;
            return Promise.resolve({ item: { id: `sfl-${seq}`, ownerId: "user-1", savedAt: new Date(START).toISOString(), form: call.body.form } });
          }
          return Promise.resolve({});
        } catch (error) {
          return Promise.reject(error);
        }
      };
      if (server.hold && server.hold(call)) {
        return new Promise((resolve, reject) => held.push({ call, release: () => respond().then(resolve, reject) }));
      }
      return respond();
    },
    writes: () => calls.filter((call) => call.method !== "GET").map((call) => [call.method, call.path])
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

const values = (over = {}) => ({ ...BLANK_CREATE_FORM, initialItems: [], ...over });
const OLD_TASK = values({ folderName: "Castillo - Ridge", taskType: "FRAUD", notes: "last Tuesday's task" });
const serverAutosave = (form) => ({ ownerId: "user-1", savedAt: new Date(START - 60_000).toISOString(), form });

const setup = () => {
  const clock = fakeClock();
  const server = fakeServer();
  const storage = fakeStorage();
  const events = { autosave: [], savedForLater: [], notices: [], loads: [] };
  const session = createNewTaskSession({
    owner: "user-1",
    request: server.request,
    storage,
    clock,
    onAutosave: (item) => events.autosave.push(item),
    onSavedForLater: (item) => events.savedForLater.push(item),
    notify: (message, variant) => events.notices.push([variant, message])
  });
  /* What the arrival's load sees when it runs: the phase then, and the calls
     made so far, so a test can say what came before it. */
  const load = () => events.loads.push({ phase: session.getState().phase, calls: server.calls.length });
  return { clock, server, storage, session, events, load };
};

const openState = (session) => {
  const state = session.getState();
  assert.equal(state.phase, "open");
  return state;
};

const paths = (server) => server.calls.map((call) => [call.method, call.path]);

/* ── No form open ───────────────────────────────────────── */

test("an arrival moves an Autosave worth keeping to Task Drafts, loads, then opens a blank LOI Check", async () => {
  const ctx = setup();
  ctx.server.autosave = serverAutosave(OLD_TASK);
  ctx.storage.setItem(draftKey("user-1"), serializeDraft(values({ notes: "an older offline copy" }), START - 120_000));

  assert.equal(await ctx.session.arrive({ load: ctx.load }), "opened");

  assert.deepEqual(paths(ctx.server), [["GET", "/autosave"], ["POST", "/saved-for-later"]]);
  const post = ctx.server.calls[1];
  assert.deepEqual(post.body.form, OLD_TASK, "the Autosave itself, not the older offline copy");
  assert.equal(post.body.clearAutosave, true, "the same write clears the server's slot");
  assert.equal(ctx.storage.items.has(draftKey("user-1")), false, "and the offline copy goes too");
  assert.deepEqual(ctx.events.notices, [], "nobody is told");

  assert.deepEqual(ctx.events.loads, [{ phase: "closed", calls: 2 }], "loads once, after the move and before the form opens");
  const state = openState(ctx.session);
  assert.deepEqual(state.mode, { kind: "arrival", held: false });
  assert.equal(state.values.taskType, "LOI");
  assert.equal(state.values.folderName, "", "never opens on the Autosave");
  assert.equal(state.restored, false);
});

test("an arrival's LOI Check writes its own typing to the Autosave, as a New Task form does", async () => {
  const ctx = setup();
  await ctx.session.arrive({ load: ctx.load });
  ctx.session.edit({ ...openState(ctx.session).values, notes: "the arrival's typing" });
  await ctx.clock.advance(1000);
  assert.deepEqual(ctx.server.writes(), [["PUT", "/autosave"]]);
  assert.equal(ctx.server.calls.at(-1).body.form.notes, "the arrival's typing");
});

test("an Autosave not worth keeping moves nowhere, and the LOI Check still opens", async () => {
  const ctx = setup();
  ctx.server.autosave = serverAutosave(values());
  assert.equal(await ctx.session.arrive({ load: ctx.load }), "opened");
  assert.deepEqual(paths(ctx.server), [["GET", "/autosave"]]);
  assert.deepEqual(openState(ctx.session).mode, { kind: "arrival", held: false });
});

test("a move that is held leaves the old Autosave where it is, and the LOI Check keeps no copy of its own typing", async () => {
  const ctx = setup();
  ctx.server.answer = (call) => {
    if (call.path === "/autosave" && call.method === "GET") throw unreachable();
    return undefined;
  };
  const offline = serializeDraft(OLD_TASK, START - 60_000);
  ctx.storage.setItem(draftKey("user-1"), offline);

  assert.equal(await ctx.session.arrive({ load: ctx.load }), "opened");
  assert.deepEqual(openState(ctx.session).mode, { kind: "arrival", held: true });
  assert.equal(ctx.events.loads.length, 1);
  ctx.server.answer = null;

  ctx.session.edit({ ...openState(ctx.session).values, notes: "typed into the held LOI Check" });
  await ctx.clock.advance(5000);
  assert.deepEqual(ctx.server.writes(), [], "no Autosave write");
  assert.equal(ctx.storage.getItem(draftKey("user-1")), offline, "the old offline copy is untouched");

  const saved = await ctx.session.end({ kind: "saveForLater" });
  assert.equal(saved.form.notes, "typed into the held LOI Check");
  assert.deepEqual(ctx.server.writes(), [["POST", "/saved-for-later"]]);
  assert.equal(ctx.server.calls.at(-1).body.clearAutosave, undefined, "its save clears no slot");
  assert.equal(ctx.storage.getItem(draftKey("user-1")), offline);
  assert.deepEqual(ctx.events.autosave, [], "the Autosaved row stays");
});

test("a held move's LOI Check forgets nothing on Create or Discard either", async () => {
  for (const ending of [{ kind: "create", file: async () => {} }, { kind: "discard" }]) {
    const ctx = setup();
    ctx.server.answer = (call) => {
      if (call.method === "GET") throw unreachable();
      return undefined;
    };
    ctx.storage.setItem(draftKey("user-1"), serializeDraft(OLD_TASK, START - 60_000));
    await ctx.session.arrive({ load: ctx.load });
    ctx.session.edit({ ...openState(ctx.session).values, notes: "typed" });
    await ctx.session.end(ending);
    await settle();
    assert.equal(ctx.session.getState().phase, "closed");
    assert.deepEqual(ctx.server.writes(), [], ending.kind);
    assert.ok(ctx.storage.items.has(draftKey("user-1")), ending.kind);
    assert.deepEqual(ctx.events.autosave, [], ending.kind);
  }
});

test("a move whose save doesn't answer in time is held", async () => {
  const ctx = setup();
  ctx.server.autosave = serverAutosave(OLD_TASK);
  ctx.server.hold = (call) => call.method === "POST";
  const arriving = ctx.session.arrive({ load: ctx.load });
  await settle();
  await ctx.clock.advance(2000);
  assert.equal(await arriving, "opened");
  assert.deepEqual(openState(ctx.session).mode, { kind: "arrival", held: true });
});

/* ── A form opened while Hot Task was loading (#420) ────── */

test("a typed New Task form is put aside through Save for later, and the arrival goes on", async () => {
  const ctx = setup();
  await ctx.session.open();
  ctx.session.edit(values({ folderName: "Alvarez", taskType: "FRAUD" }));
  ctx.session.notePendingItem("No W-2");

  assert.equal(await ctx.session.arrive({ load: ctx.load }), "opened");

  assert.deepEqual(paths(ctx.server), [["GET", "/autosave"], ["POST", "/saved-for-later"], ["GET", "/autosave"]]);
  const post = ctx.server.calls[1];
  assert.equal(post.body.form.folderName, "Alvarez");
  assert.deepEqual(post.body.form.initialItems, ["No W-2"], "the half-typed item goes with it");
  assert.equal(post.body.clearAutosave, true);
  assert.deepEqual(ctx.events.savedForLater.map((item) => item.form.folderName), ["Alvarez"], "it lands on Task Drafts");
  assert.deepEqual(ctx.events.notices, [], "silently");
  assert.deepEqual(ctx.events.loads, [{ phase: "closed", calls: 3 }]);
  assert.deepEqual(openState(ctx.session).mode, { kind: "arrival", held: false });
});

test("a typed form whose save fails stays open exactly as it was, and the arrival is dropped", async () => {
  const ctx = setup();
  await ctx.session.open();
  const typed = values({ folderName: "Alvarez", notes: "mine" });
  ctx.session.edit(typed);
  ctx.server.answer = (call) => {
    if (call.method === "POST") throw new Error("Server said no");
    return undefined;
  };

  assert.equal(await ctx.session.arrive({ load: ctx.load }), "dropped");

  const state = openState(ctx.session);
  assert.deepEqual(state.mode, { kind: "fresh" });
  assert.deepEqual(state.values, typed);
  assert.equal(state.ending, null);
  assert.deepEqual(
    ctx.events.notices,
    [["error", "Couldn't open the Humperdink task. Your form is still here."]],
    "says the arrival didn't open, not that Save for later failed (#479)"
  );
  assert.equal(ctx.server.calls.filter((call) => call.method === "GET").length, 1, "no move after a failed save");
  assert.equal(ctx.events.loads.length, 1, "the drafts still load");

  ctx.server.answer = null;
  ctx.session.edit({ ...typed, notes: "mine, still" });
  await ctx.clock.advance(1000);
  assert.deepEqual(ctx.server.writes().at(-1), ["PUT", "/autosave"], "and it goes on autosaving");
});

test("an untouched form just closes, with nothing saved, and the LOI Check opens", async () => {
  const ctx = setup();
  await ctx.session.open();
  assert.equal(await ctx.session.arrive({ load: ctx.load }), "opened");
  assert.deepEqual(ctx.server.writes(), []);
  assert.deepEqual(ctx.events.savedForLater, []);
  assert.deepEqual(openState(ctx.session).mode, { kind: "arrival", held: false });
});

test("a reopened Task Draft is left where it is, and the arrival is dropped", async () => {
  const ctx = setup();
  const record = { id: "sfl-9", ownerId: "user-1", savedAt: new Date(START).toISOString(), form: values({ notes: "a draft" }) };
  ctx.server.answer = (call) => (call.path === "/saved-for-later/sfl-9" ? { item: record } : undefined);
  await ctx.session.reopen(record);
  assert.equal(await ctx.session.arrive({ load: ctx.load }), "dropped");
  assert.equal(openState(ctx.session).mode.kind, "reopened");
  assert.deepEqual(ctx.server.writes(), []);
});

test("a form already ending (a Create out) is left to finish, and the arrival is dropped", async () => {
  const ctx = setup();
  await ctx.session.open();
  ctx.session.edit(values({ folderName: "Alvarez" }));
  let file;
  const filing = ctx.session.end({ kind: "create", file: () => new Promise((resolve) => (file = resolve)) });
  await settle();
  assert.equal(await ctx.session.arrive({ load: ctx.load }), "dropped");
  assert.deepEqual(ctx.server.writes(), [], "no Task Draft beside the task");
  file();
  await filing;
  assert.equal(ctx.session.getState().phase, "closed");
});

test("a New Task still loading when the arrival starts gives way to the LOI Check", async () => {
  const ctx = setup();
  ctx.server.hold = (call) => call.method === "GET" && ctx.server.calls.filter((c) => c.method === "GET").length === 1;
  const opening = ctx.session.open();
  await settle();
  ctx.server.hold = null;
  const arriving = ctx.session.arrive({ load: ctx.load });
  assert.equal(await arriving, "opened");
  ctx.server.held[0].release();
  assert.equal(await opening, false);
  assert.deepEqual(openState(ctx.session).mode, { kind: "arrival", held: false });
});

test("an arrival for a person who has since left opens nothing", async () => {
  const ctx = setup();
  ctx.server.hold = (call) => call.method === "GET";
  const arriving = ctx.session.arrive({ load: ctx.load });
  await settle();
  ctx.session.retire();
  ctx.server.held[0].release();
  assert.equal(await arriving, "skipped");
  assert.equal(ctx.session.getState().phase, "closed");
  assert.deepEqual(ctx.events.loads, []);
});

/* ── Ordering ───────────────────────────────────────────── */

test("New Task pressed while the move is out waits for it, then leaves the LOI Check alone", async () => {
  const ctx = setup();
  ctx.server.autosave = serverAutosave(OLD_TASK);
  ctx.server.hold = (call) => call.method === "POST";
  const arriving = ctx.session.arrive({ load: ctx.load });
  await settle();
  const pressed = ctx.session.open();
  await settle();
  assert.equal(ctx.server.calls.filter((call) => call.method === "GET").length, 1, "the press asks for nothing while the move is out");
  assert.equal(ctx.session.getState().phase, "closed");

  ctx.server.held[0].release();
  assert.equal(await arriving, "opened");
  assert.equal(await pressed, false);
  assert.deepEqual(openState(ctx.session).mode, { kind: "arrival", held: false });
  assert.equal(ctx.server.calls.filter((call) => call.method === "GET").length, 1, "and never opens on the Autosave it cleared");
});

test("New Task pressed after the arrival settled opens as usual once the LOI Check is closed", async () => {
  const ctx = setup();
  await ctx.session.arrive({ load: ctx.load });
  ctx.session.close();
  assert.equal(await ctx.session.open(), true);
  assert.deepEqual(openState(ctx.session).mode, { kind: "fresh" });
});

/* ── The clipboard fill (#415, ADR-0012) ────────────────── */

test("the LOI Check fills from the clipboard only while nobody has touched it", async () => {
  const ctx = setup();
  await ctx.session.arrive({ load: ctx.load });
  assert.equal(ctx.session.untouched(), true, "a fill applies");

  ctx.session.edit({ ...openState(ctx.session).values, notes: "typed first" });
  assert.equal(ctx.session.untouched(), false, "typing that got there first is kept");

  ctx.session.edit({ ...openState(ctx.session).values, notes: "" });
  assert.equal(ctx.session.untouched(), true, "back to how it opened");
});

test("a closed session is never untouched", () => {
  const ctx = setup();
  assert.equal(ctx.session.untouched(), false);
});
