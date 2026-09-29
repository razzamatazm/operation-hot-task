#!/usr/bin/env node
/* A reopened Task Draft through the New Task session (#469): opening on the
   record's latest copy, keeping its unsaved typing on the record, and every way
   it ends, driven through the session's interface against a fake server and a
   fake clock.

   Run: `node --test scripts/reopened-task-session-sim-test.mjs`. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(REPO, "node_modules", ".reopened-task-session-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const entry = join(scratch, "entry.ts");
const src = (file) => JSON.stringify(join(REPO, "apps/web/src", file));
writeFileSync(
  entry,
  `export * from ${src("new-task-session.ts")};\n` + `export { BLANK_CREATE_FORM } from ${src("create-form-state.ts")};\n`
);
const bundle = join(scratch, "reopened-task-session.mjs");
await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  format: "esm",
  external: ["react", "@loan-tasks/shared"],
  logLevel: "silent"
});
const { createNewTaskSession, BLANK_CREATE_FORM } = await import(pathToFileURL(bundle).href);

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

const gone = () => Object.assign(new Error("Not found"), { status: 404 });
const unreachable = () => new Error("Failed to fetch");

/* Every request is recorded; `answer` decides what comes back (landed by
   default) and `hold` parks matching requests until released. */
const fakeServer = () => {
  const calls = [];
  const held = [];
  const server = {
    calls,
    held,
    answer: () => ({}),
    hold: null,
    request: (path, init) => {
      const call = { method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined };
      calls.push(call);
      const respond = () => {
        try {
          return Promise.resolve(server.answer(call));
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
const record = (over = {}) => ({
  id: "sfl-1",
  ownerId: "user-1",
  savedAt: new Date(START - 60 * 60_000).toISOString(),
  form: values({ folderName: "Castillo", notes: "the save" }),
  ...over
});

/* `storage` carries a browser across a reload: a new session on the old one. */
const setup = ({ owner = "user-1", storage = fakeStorage() } = {}) => {
  const clock = fakeClock();
  const server = fakeServer();
  const events = { autosave: [], savedForLater: [], latest: [], unsaved: [], gone: [], notices: [] };
  const session = createNewTaskSession({
    owner,
    request: server.request,
    storage,
    clock,
    onAutosave: (item) => events.autosave.push(item),
    onSavedForLater: (item, replaced) => events.savedForLater.push([item.id, replaced]),
    onSavedForLaterLatest: (item) => events.latest.push(item),
    onSavedForLaterUnsaved: (id, unsaved) => events.unsaved.push([id, unsaved]),
    onSavedForLaterGone: (id) => events.gone.push(id),
    notify: (message, variant) => events.notices.push([variant, message])
  });
  return { clock, server, storage, session, events };
};

/* Open on `latest` as the server's copy of the record. */
const reopen = async (ctx, latest = record(), over = {}) => {
  ctx.server.answer = (call) => (call.method === "GET" ? { item: latest } : {});
  const outcome = await ctx.session.reopen(over.item ?? latest);
  ctx.server.answer = () => ({});
  return outcome;
};

const openState = (session) => {
  const state = session.getState();
  assert.equal(state.phase, "open");
  return state;
};

/* ── Opening ────────────────────────────────────────────── */

test("reopening fetches the latest copy first and opens on its last save when there is no unsaved typing", async () => {
  const ctx = setup();
  const onScreen = record({ form: values({ notes: "the list's older copy" }) });
  const latest = record({ form: values({ notes: "saved again on another device" }) });
  assert.equal(await reopen(ctx, latest, { item: onScreen }), "opened");
  assert.deepEqual(ctx.server.calls.map((call) => [call.method, call.path]), [["GET", "/saved-for-later/sfl-1"]]);
  const state = openState(ctx.session);
  assert.equal(state.values.notes, "saved again on another device");
  assert.deepEqual(state.mode, { kind: "reopened", record: latest });
  assert.equal(state.restored, false);
  assert.deepEqual(ctx.events.latest, [latest], "the row takes the latest copy");
});

test("reopening opens on the record's unsaved typing when there is some", async () => {
  const ctx = setup();
  await reopen(ctx, record({ unsaved: values({ folderName: "Castillo", notes: "typed, never saved" }) }));
  assert.equal(openState(ctx.session).values.notes, "typed, never saved");
});

test("a record that has gone (404) opens nothing: the row goes and the person is told", async () => {
  const ctx = setup();
  ctx.server.answer = () => {
    throw gone();
  };
  assert.equal(await ctx.session.reopen(record()), "gone");
  assert.equal(ctx.session.getState().phase, "closed");
  assert.deepEqual(ctx.events.gone, ["sfl-1"]);
  assert.deepEqual(ctx.events.notices, [["warn", "That Task Draft is gone. It was created or removed somewhere else."]]);
});

test("a server that can't be reached opens on the copy already on screen", async () => {
  const ctx = setup();
  ctx.server.answer = () => {
    throw unreachable();
  };
  const onScreen = record({ unsaved: values({ notes: "what I last saw" }) });
  assert.equal(await ctx.session.reopen(onScreen), "opened");
  assert.equal(openState(ctx.session).values.notes, "what I last saw");
  assert.deepEqual(ctx.events.notices, []);
});

test("a reopened record has no Autosave seat, and no browser copy once its send lands", async () => {
  const ctx = setup();
  await reopen(ctx);
  ctx.session.edit(values({ notes: "typing" }));
  await ctx.clock.advance(1000);
  assert.ok(!ctx.server.calls.some((call) => call.path === "/autosave"));
  assert.equal(ctx.storage.items.size, 0);
  assert.deepEqual(ctx.events.autosave, []);
});

test("a form already up when the fetch lands keeps the screen", async () => {
  const ctx = setup();
  ctx.server.answer = () => ({ item: record() });
  assert.equal(await ctx.session.reopen(record(), { unless: () => true }), "skipped");
  assert.equal(ctx.session.getState().phase, "closed");
  assert.deepEqual(ctx.events.latest, [record()], "the row still takes the latest copy");
});

test("a close while the record is loading leaves the form shut, so a person switch never opens it", async () => {
  const ctx = setup();
  ctx.server.hold = () => true;
  const reopening = ctx.session.reopen(record());
  await settle();
  ctx.session.close();
  ctx.server.answer = () => ({ item: record() });
  ctx.server.held.shift().release();
  assert.equal(await reopening, "skipped");
  assert.equal(ctx.session.getState().phase, "closed");
});

test("the first to land wins: a record that lands while New Task is still loading opens, and New Task stays shut", async () => {
  const ctx = setup();
  ctx.server.hold = (call) => call.path === "/autosave";
  const opening = ctx.session.open();
  await settle();
  assert.equal(ctx.session.getState().phase, "opening");
  ctx.server.hold = null;
  assert.equal(await reopen(ctx), "opened");
  ctx.server.answer = () => ({ item: null });
  ctx.server.held.shift().release();
  assert.equal(await opening, false);
  assert.equal(openState(ctx.session).mode.kind, "reopened");
});

/* ── Typing ─────────────────────────────────────────────── */

test("one second after typing stops, the typing goes to the record's unsaved slot, never over its save", async () => {
  const ctx = setup();
  await reopen(ctx);
  ctx.session.edit(values({ folderName: "Castillo", notes: "the save, and more" }));
  await ctx.clock.advance(999);
  assert.deepEqual(ctx.server.writes(), []);
  await ctx.clock.advance(1);
  assert.deepEqual(ctx.server.writes(), [["PUT", "/saved-for-later/sfl-1/unsaved"]]);
  assert.equal(ctx.server.calls.at(-1).body.form.notes, "the save, and more");
  await ctx.clock.advance(5000);
  assert.equal(ctx.server.writes().length, 1, "nothing new to send");
});

test("typing back to exactly the save clears the unsaved slot", async () => {
  const ctx = setup();
  await reopen(ctx, record({ unsaved: values({ folderName: "Castillo", notes: "unsaved" }) }));
  ctx.session.edit(record().form);
  await ctx.clock.advance(1000);
  assert.deepEqual(ctx.server.writes(), [["DELETE", "/saved-for-later/sfl-1/unsaved"]]);
});

test("the row learns of unsaved typing once it lands, and of it clearing once typed back to the save (#475)", async () => {
  const ctx = setup();
  await reopen(ctx);
  ctx.session.edit(values({ folderName: "Castillo", notes: "the save, and more" }));
  await ctx.clock.advance(1000);
  assert.deepEqual(ctx.events.unsaved, [["sfl-1", values({ folderName: "Castillo", notes: "the save, and more" })]]);
  ctx.session.edit(record().form);
  await ctx.clock.advance(1000);
  assert.deepEqual(ctx.events.unsaved.at(-1), ["sfl-1", null], "and none once the form matches the save again");
  assert.equal(ctx.events.latest.length, 1, "the record fetched on the way in is the only whole record reported");
});

test("a send that fails leaves the row as it was (#475)", async () => {
  const ctx = setup();
  await reopen(ctx);
  ctx.server.answer = () => {
    throw unreachable();
  };
  ctx.session.edit(values({ notes: "try me" }));
  await ctx.clock.advance(1000);
  assert.deepEqual(ctx.events.unsaved, []);
});

test("an untouched reopened form sends nothing", async () => {
  const ctx = setup();
  await reopen(ctx, record({ unsaved: values({ notes: "unsaved" }) }));
  ctx.session.edit(values({ notes: "unsaved" }));
  await ctx.clock.advance(1000);
  assert.deepEqual(ctx.server.writes(), []);
});

test("a failed send is kept in the browser, and the next keystroke retries and removes it (#476)", async () => {
  const ctx = setup();
  await reopen(ctx);
  ctx.server.answer = () => {
    throw unreachable();
  };
  ctx.session.edit(values({ notes: "try me" }));
  await ctx.clock.advance(1000);
  assert.equal(ctx.storage.items.size, 1);
  ctx.server.answer = () => ({});
  ctx.session.edit(values({ notes: "try me" }));
  await ctx.clock.advance(1000);
  assert.deepEqual(ctx.server.writes(), [["PUT", "/saved-for-later/sfl-1/unsaved"], ["PUT", "/saved-for-later/sfl-1/unsaved"]]);
  assert.equal(ctx.storage.items.size, 0);
});

/* ── The browser copy while the server is down (#476) ───── */

const down = (ctx) => {
  ctx.server.answer = () => {
    throw unreachable();
  };
};

/* Type into a reopened record with the server down: a browser copy is left. */
const typeWhileDown = async (ctx, typed, latest = record()) => {
  await reopen(ctx, latest);
  down(ctx);
  ctx.session.edit(typed);
  await ctx.clock.advance(1000);
  assert.equal(ctx.storage.items.size, 1);
};

test("typing while the server is down survives a reload, reopened with the server still down", async () => {
  const before = setup();
  await typeWhileDown(before, values({ folderName: "Castillo", notes: "typed offline" }));
  const after = setup({ storage: before.storage });
  down(after);
  assert.equal(await after.session.reopen(record()), "opened");
  const state = openState(after.session);
  assert.equal(state.values.notes, "typed offline");
  assert.equal(state.mode.record.unsaved.notes, "typed offline", "the unsaved changes note shows");
  assert.equal(after.storage.items.size, 1, "still the only copy");
});

test("once the server is back, reopening sends the copy to the unsaved slot and removes it", async () => {
  const before = setup();
  await typeWhileDown(before, values({ folderName: "Castillo", notes: "typed offline" }));
  const after = setup({ storage: before.storage });
  await reopen(after);
  assert.equal(openState(after.session).values.notes, "typed offline");
  await settle();
  assert.deepEqual(after.server.writes(), [["PUT", "/saved-for-later/sfl-1/unsaved"]]);
  assert.equal(after.server.calls.at(-1).body.form.notes, "typed offline");
  assert.deepEqual(after.events.unsaved, [["sfl-1", values({ folderName: "Castillo", notes: "typed offline" })]]);
  assert.equal(after.storage.items.size, 0);
});

test("the next send that lands in the same open removes the copy", async () => {
  const ctx = setup();
  await typeWhileDown(ctx, values({ notes: "offline" }));
  ctx.server.answer = () => ({});
  ctx.session.edit(values({ notes: "online again" }));
  await ctx.clock.advance(1000);
  assert.equal(ctx.storage.items.size, 0);
});

test("typing back to what the server holds after a failed send removes the copy", async () => {
  const ctx = setup();
  await typeWhileDown(ctx, values({ notes: "offline" }));
  ctx.server.answer = () => ({});
  ctx.session.edit(record().form);
  await ctx.clock.advance(1000);
  assert.deepEqual(ctx.server.writes(), [["PUT", "/saved-for-later/sfl-1/unsaved"]], "nothing to send");
  assert.equal(ctx.storage.items.size, 0);
});

test("a record saved again elsewhere since the copy was written wins over the copy", async () => {
  const before = setup();
  await typeWhileDown(before, values({ notes: "offline" }));
  const after = setup({ storage: before.storage });
  await reopen(after, record({ savedAt: new Date(START).toISOString(), form: values({ notes: "saved on the laptop" }) }));
  assert.equal(openState(after.session).values.notes, "saved on the laptop");
  await settle();
  assert.deepEqual(after.server.writes(), []);
});

test("unsaved typing that reached the server from elsewhere since the copy wins over the copy", async () => {
  const before = setup();
  await typeWhileDown(before, values({ notes: "offline" }));
  const after = setup({ storage: before.storage });
  await reopen(after, record({ unsaved: values({ notes: "typed on the laptop" }) }));
  assert.equal(openState(after.session).values.notes, "typed on the laptop");
});

test("the copy remembers unsaved typing that had landed before the server went down", async () => {
  const ctx = setup();
  await reopen(ctx);
  ctx.session.edit(values({ notes: "landed" }));
  await ctx.clock.advance(1000);
  down(ctx);
  ctx.session.edit(values({ notes: "landed, then offline" }));
  await ctx.clock.advance(1000);
  const after = setup({ storage: ctx.storage });
  await reopen(after, record({ unsaved: values({ notes: "landed" }) }));
  assert.equal(openState(after.session).values.notes, "landed, then offline");
});

test("another person's copy is never shown", async () => {
  const before = setup();
  await typeWhileDown(before, values({ notes: "user-1's typing" }));
  const other = setup({ owner: "user-2", storage: before.storage });
  await reopen(other, record({ ownerId: "user-2" }));
  assert.equal(openState(other.session).values.notes, "the save");
  await settle();
  assert.deepEqual(other.server.writes(), []);
  assert.equal(other.storage.items.size, 1, "user-1's copy is left for user-1");
});

test("Create removes the copy", async () => {
  const ctx = setup();
  await typeWhileDown(ctx, values({ notes: "offline" }));
  ctx.server.answer = () => ({});
  await ctx.session.end({ kind: "create", file: async () => {} });
  assert.equal(ctx.storage.items.size, 0);
});

test("Save for later removes the copy", async () => {
  const ctx = setup();
  await typeWhileDown(ctx, values({ notes: "offline" }));
  ctx.server.answer = () => ({ item: record({ savedAt: new Date(START).toISOString() }) });
  await ctx.session.end({ kind: "saveForLater" });
  assert.equal(ctx.storage.items.size, 0);
});

test("Discard removes the copy, even when the delete fails", async () => {
  const ctx = setup();
  await typeWhileDown(ctx, values({ notes: "offline" }));
  await ctx.session.end({ kind: "discard" });
  assert.equal(ctx.storage.items.size, 0);
});

test("a record found gone on reopen takes its copy with it", async () => {
  const before = setup();
  await typeWhileDown(before, values({ notes: "offline" }));
  const after = setup({ storage: before.storage });
  after.server.answer = () => {
    throw gone();
  };
  assert.equal(await after.session.reopen(record()), "gone");
  assert.equal(after.storage.items.size, 0);
});

test("deleting a Task Draft from the board removes its copy", () => {
  const app = readFileSync(join(REPO, "apps/web/src/App.tsx"), "utf8");
  assert.match(app, /removeSavedForLaterRequest\(savedForLaterRequestFor\(user\), item\.id\);[\s\S]{0,400}clearUnsavedCopy\(browserDraftStorage\(\), user\.id, item\.id\)/);
});

/* ── Ending ─────────────────────────────────────────────── */

test("Create files the task after the send still out, then deletes the record", async () => {
  const ctx = setup();
  await reopen(ctx);
  ctx.server.hold = (call) => call.path.endsWith("/unsaved");
  ctx.session.edit(values({ notes: "more" }));
  await ctx.clock.advance(1000);
  const filed = [];
  const ending = ctx.session.end({ kind: "create", file: async () => filed.push("task") });
  await settle();
  assert.deepEqual(filed, [], "the create waits for the send still out");
  ctx.server.held.shift().release();
  await ending;
  assert.deepEqual(filed, ["task"]);
  assert.deepEqual(ctx.server.writes(), [["PUT", "/saved-for-later/sfl-1/unsaved"], ["DELETE", "/saved-for-later/sfl-1"]]);
  assert.deepEqual(ctx.events.gone, ["sfl-1"]);
  assert.deepEqual(ctx.events.notices, []);
  assert.equal(ctx.session.getState().phase, "closed");
});

test("a Create still out when another draft is reopened deletes its own record and leaves the new form open", async () => {
  const ctx = setup();
  await reopen(ctx, record({ id: "sfl-A" }));
  let file;
  const ending = ctx.session.end({ kind: "create", file: () => new Promise((resolve) => (file = resolve)) });
  await settle();
  await ctx.session.end({ kind: "cancel" });
  await ctx.session.end({ kind: "discard" });
  assert.equal(await reopen(ctx, record({ id: "sfl-B" })), "opened");
  ctx.server.calls.length = 0;
  file();
  await ending;
  assert.deepEqual(ctx.server.writes(), [["DELETE", "/saved-for-later/sfl-A"]], "A's record goes, never B's");
  assert.equal(openState(ctx.session).mode.record.id, "sfl-B", "and B's form stays open");
});

test("a Create whose record delete fails still closes, and says the Task Draft is still there", async () => {
  const ctx = setup();
  await reopen(ctx);
  ctx.server.answer = (call) => {
    if (call.method === "DELETE") throw unreachable();
    return {};
  };
  await ctx.session.end({ kind: "create", file: async () => {} });
  assert.deepEqual(ctx.events.gone, []);
  assert.deepEqual(ctx.events.notices, [["warn", "Task created, but its Task Draft couldn't be removed."]]);
  assert.equal(ctx.session.getState().phase, "closed");
});

test("a record already gone when Create deletes it counts as removed", async () => {
  const ctx = setup();
  await reopen(ctx);
  ctx.server.answer = () => {
    throw gone();
  };
  await ctx.session.end({ kind: "create", file: async () => {} });
  assert.deepEqual(ctx.events.gone, ["sfl-1"]);
  assert.deepEqual(ctx.events.notices, []);
});

test("a Create that fails keeps the form and the record, and typing is sent again", async () => {
  const ctx = setup();
  await reopen(ctx);
  await assert.rejects(ctx.session.end({ kind: "create", file: async () => { throw new Error("refused"); } }), /refused/);
  assert.equal(openState(ctx.session).ending, null);
  assert.deepEqual(ctx.server.writes(), []);
  ctx.session.edit(values({ notes: "fixed" }));
  await ctx.clock.advance(1000);
  assert.deepEqual(ctx.server.writes(), [["PUT", "/saved-for-later/sfl-1/unsaved"]]);
});

test("Save for later writes onto the same record, leaving the Autosave alone", async () => {
  const ctx = setup();
  await reopen(ctx, record({ unsaved: values({ notes: "unsaved" }) }));
  const saved = record({ savedAt: new Date(START).toISOString(), form: values({ notes: "saved now" }) });
  ctx.server.answer = (call) => (call.method === "PUT" ? { item: saved } : {});
  const item = await ctx.session.end({ kind: "saveForLater", values: values({ notes: "saved now" }) });
  assert.equal(item, saved);
  assert.deepEqual(ctx.server.writes(), [["PUT", "/saved-for-later/sfl-1"]]);
  assert.deepEqual(ctx.server.calls.at(-1).body, { form: values({ notes: "saved now" }) });
  assert.deepEqual(ctx.events.savedForLater, [["sfl-1", "sfl-1"]]);
  assert.deepEqual(ctx.events.autosave, []);
  assert.equal(ctx.session.getState().phase, "closed");
});

test("Save for later on a record that has gone saves a new one in its place", async () => {
  const ctx = setup();
  await reopen(ctx);
  const fresh = record({ id: "sfl-2", savedAt: new Date(START).toISOString() });
  ctx.server.answer = (call) => {
    if (call.method === "PUT") throw gone();
    return { item: fresh };
  };
  const item = await ctx.session.end({ kind: "saveForLater" });
  assert.equal(item, fresh);
  assert.deepEqual(ctx.server.writes(), [["PUT", "/saved-for-later/sfl-1"], ["POST", "/saved-for-later"]]);
  assert.equal(ctx.server.calls.at(-1).body.clearAutosave, undefined, "a reopened form never had the Autosave");
  assert.deepEqual(ctx.events.savedForLater, [["sfl-2", "sfl-1"]]);
});

test("Cancel on a reopened task always asks, even untouched", async () => {
  const ctx = setup();
  await reopen(ctx);
  assert.equal(await ctx.session.end({ kind: "cancel" }), "asked");
  assert.equal(openState(ctx.session).asking, true);
  ctx.session.resume();
  assert.equal(openState(ctx.session).asking, false);
});

test("Discard deletes the record for good, after the send still out, and closes", async () => {
  const ctx = setup();
  await reopen(ctx);
  ctx.server.hold = (call) => call.path.endsWith("/unsaved");
  ctx.session.edit(values({ notes: "more" }));
  await ctx.clock.advance(1000);
  await ctx.session.end({ kind: "cancel" });
  const ending = ctx.session.end({ kind: "discard" });
  assert.equal(openState(ctx.session).ending, "discard");
  await settle();
  assert.deepEqual(ctx.server.writes(), [["PUT", "/saved-for-later/sfl-1/unsaved"]], "the delete waits for the send");
  ctx.server.held.shift().release();
  await ending;
  assert.deepEqual(ctx.server.writes(), [["PUT", "/saved-for-later/sfl-1/unsaved"], ["DELETE", "/saved-for-later/sfl-1"]]);
  assert.deepEqual(ctx.events.gone, ["sfl-1"]);
  assert.deepEqual(ctx.events.notices, []);
  assert.equal(ctx.session.getState().phase, "closed");
});

test("a Discard whose delete fails still closes, with a warning that the Task Draft is still there", async () => {
  const ctx = setup();
  await reopen(ctx);
  ctx.server.answer = () => {
    throw unreachable();
  };
  await ctx.session.end({ kind: "discard" });
  assert.deepEqual(ctx.events.gone, []);
  assert.deepEqual(ctx.events.notices, [["warn", "Couldn't delete that Task Draft. It's still on Task Drafts."]]);
  assert.equal(ctx.session.getState().phase, "closed");
});

test("a fresh form's mode is the fresh variant", async () => {
  const ctx = setup();
  ctx.server.answer = () => ({ item: null });
  await ctx.session.open();
  assert.deepEqual(openState(ctx.session).mode, { kind: "fresh" });
});

test("the Autosaved row pressed while a reopened task is up leaves it open, and its typing is still sent (#474)", async () => {
  const ctx = setup();
  await reopen(ctx);
  ctx.session.edit(values({ folderName: "Castillo", notes: "half typed" }));
  await ctx.clock.advance(500);
  assert.equal(await ctx.session.open(), false);
  const state = openState(ctx.session);
  assert.equal(state.mode.kind, "reopened");
  assert.equal(state.values.notes, "half typed");
  await ctx.clock.advance(500);
  assert.deepEqual(ctx.server.writes(), [["PUT", "/saved-for-later/sfl-1/unsaved"]]);
  assert.equal(ctx.server.calls.at(-1).body.form.notes, "half typed");
});

/* App's wiring, read out of the source like the other session suites. */
test("App reopens a Task Draft through the session, and has no second form for it", () => {
  const app = readFileSync(join(REPO, "apps/web/src/App.tsx"), "utf8");
  assert.match(app, /newTask\.reopen\(item, \{ unless: \(\) => formOpenNow\.current \}\)/);
  assert.doesNotMatch(app, /reopenSavedForLaterRequest|setReopened|onDeleteReopened|onKeepUnsaved/);
});
