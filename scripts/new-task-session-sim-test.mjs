#!/usr/bin/env node
/* The New Task session (#467): one fresh New Task form's life, from opening on
   the newer Autosave to the way it ends, driven through the session's own
   interface against a fake server, a fake storage and a fake clock.

   Run: `node --test scripts/new-task-session-sim-test.mjs`. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(REPO, "node_modules", ".new-task-session-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const entry = join(scratch, "entry.ts");
const src = (file) => JSON.stringify(join(REPO, "apps/web/src", file));
writeFileSync(
  entry,
  `export * from ${src("new-task-session.ts")};\n` +
    `export { draftKey, serializeDraft } from ${src("create-form-draft.ts")};\n` +
    `export { AUTOSAVE_MAX_AGE_MS } from "@loan-tasks/shared";\n` +
    `export { BLANK_CREATE_FORM } from ${src("create-form-state.ts")};\n`
);
const bundle = join(scratch, "new-task-session.mjs");
await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  format: "esm",
  external: ["react", "@loan-tasks/shared"],
  logLevel: "silent"
});
const { createNewTaskSession, handOver, draftKey, serializeDraft, AUTOSAVE_MAX_AGE_MS, BLANK_CREATE_FORM } = await import(
  pathToFileURL(bundle).href
);

/* ── Fakes ──────────────────────────────────────────────── */

const START = Date.parse("2026-09-29T15:00:00Z");

/* Time moves only when a test says so; due timers fire in order, and the
   promises they start are given the chance to settle between them. */
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

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/* A server that answers GET /autosave from `autosave`, and everything else from
   `answer` (landed by default). `hold` parks matching requests until released,
   so ordering can be watched. Every call is recorded with whose it was. */
const fakeServer = ({ owner = "user-1", autosave = null, reach = true } = {}) => {
  const calls = [];
  const held = [];
  const server = {
    calls,
    held,
    autosave,
    reach,
    answer: () => ({}),
    hold: null,
    request: (path, init) => {
      const call = { owner, method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined };
      calls.push(call);
      if (init.method === "GET" && path === "/autosave") {
        if (!server.reach) return new Promise(() => {});
        return Promise.resolve({ item: server.autosave });
      }
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
    writes: () => calls.filter((call) => !(call.method === "GET" && call.path === "/autosave"))
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
const serverCopy = (form, ageMs) => ({ ownerId: "user-1", savedAt: new Date(START - ageMs).toISOString(), form });

const setup = ({ owner = "user-1", autosave = null, reach = true, offline } = {}) => {
  const clock = fakeClock();
  const server = fakeServer({ owner, autosave, reach });
  const storage = fakeStorage();
  if (offline) storage.setItem(draftKey(owner), serializeDraft(offline.values, START - offline.ageMs));
  const events = { autosave: [], savedForLater: [] };
  const session = createNewTaskSession({
    owner,
    request: server.request,
    storage,
    clock,
    onAutosave: (item) => events.autosave.push(item),
    onSavedForLater: (item) => events.savedForLater.push(item)
  });
  return { clock, server, storage, session, events, key: draftKey(owner) };
};

const openState = (session) => {
  const state = session.getState();
  assert.equal(state.phase, "open");
  return state;
};

/* ── Opening ────────────────────────────────────────────── */

test("opens blank, with no restored note, when there is no Autosave anywhere", async () => {
  const { session } = setup();
  assert.equal(session.getState().phase, "closed");
  assert.equal(await session.open(), true);
  const state = openState(session);
  assert.deepEqual(state.values, BLANK_CREATE_FORM);
  assert.equal(state.restored, false);
  assert.equal(state.asking, false);
});

test("opens on the server Autosave when it is the newer copy", async () => {
  const server = values({ folderName: "Castillo from the server" });
  const offline = values({ folderName: "Castillo offline" });
  const { session, events } = setup({ autosave: serverCopy(server, 60_000), offline: { values: offline, ageMs: 10 * 60_000 } });
  await session.open();
  assert.equal(openState(session).values.folderName, "Castillo from the server");
  assert.equal(openState(session).restored, true);
  assert.equal(events.autosave.at(-1).form.folderName, "Castillo from the server");
});

test("opens on this browser's offline copy when it is the newer one", async () => {
  const server = values({ folderName: "older on the server" });
  const offline = values({ folderName: "newer offline" });
  const { session } = setup({ autosave: serverCopy(server, 10 * 60_000), offline: { values: offline, ageMs: 60_000 } });
  await session.open();
  assert.equal(openState(session).values.folderName, "newer offline");
  assert.equal(openState(session).restored, true);
});

test("a tie goes to the server's copy", async () => {
  const { session } = setup({
    autosave: serverCopy(values({ notes: "server" }), 60_000),
    offline: { values: values({ notes: "offline" }), ageMs: 60_000 }
  });
  await session.open();
  assert.equal(openState(session).values.notes, "server");
});

test("a server that does not answer in time opens on the Autosave already held, weighed against the offline copy", async () => {
  const { session, server, clock } = setup({
    autosave: serverCopy(values({ notes: "held since sign-in" }), 60_000),
    offline: { values: values({ notes: "offline" }), ageMs: 10 * 60_000 }
  });
  await session.refreshAutosave();
  server.reach = false;
  const opening = session.open();
  await settle();
  assert.equal(session.getState().phase, "opening");
  await clock.advance(2000);
  assert.equal(await opening, true);
  assert.equal(openState(session).values.notes, "held since sign-in");
});

test("7-day expiry: a copy seven days old from either side opens blank, and the offline one is removed", async () => {
  const week = AUTOSAVE_MAX_AGE_MS;
  const { session, storage, key } = setup({
    autosave: serverCopy(values({ notes: "a week on the server" }), week),
    offline: { values: values({ notes: "a week offline" }), ageMs: week }
  });
  await session.open();
  assert.deepEqual(openState(session).values, BLANK_CREATE_FORM);
  assert.equal(openState(session).restored, false);
  assert.equal(storage.getItem(key), null);
});

test("7-day expiry: a copy a minute short of seven days still comes back", async () => {
  const { session } = setup({ autosave: serverCopy(values({ notes: "six days and change" }), AUTOSAVE_MAX_AGE_MS - 60_000) });
  await session.open();
  assert.equal(openState(session).values.notes, "six days and change");
});

test("opening a restored form doesn't restart its clock: nothing is written while it is left alone", async () => {
  const { session, server, clock } = setup({ autosave: serverCopy(values({ notes: "restored" }), 60_000) });
  await session.open();
  await clock.advance(10_000);
  assert.deepEqual(server.writes(), []);
});

test("a close while the Autosave is loading leaves the form shut", async () => {
  const { session, clock } = setup({ reach: false });
  const opening = session.open();
  session.close();
  await clock.advance(2000);
  assert.equal(await opening, false);
  assert.equal(session.getState().phase, "closed");
});

/* ── The Task Drafts tab's Autosaved row ────────────────── */

test("refreshAutosave reports the newer of the server's copy and the offline one", async () => {
  const { session, events } = setup({
    autosave: serverCopy(values({ notes: "older on the server" }), 10 * 60_000),
    offline: { values: values({ notes: "newer offline" }), ageMs: 60_000 }
  });
  await session.refreshAutosave();
  assert.equal(events.autosave.at(-1).form.notes, "newer offline");
});

test("refreshAutosave with the server unreachable keeps what it last learned, weighed against the offline copy", async () => {
  const { session, server, clock, events } = setup({ autosave: serverCopy(values({ notes: "from the server" }), 60_000) });
  await session.refreshAutosave();
  server.reach = false;
  const refreshing = session.refreshAutosave();
  await clock.advance(2000);
  await refreshing;
  assert.equal(events.autosave.at(-1).form.notes, "from the server");
});

test("refreshAutosave reports nothing for a filed task whose forget is still owed", async () => {
  const { session, server, storage, events } = setup({ autosave: serverCopy(values({ notes: "the filed task" }), 60_000) });
  storage.setItem("loan-tasks:autosave-filed:user-1", "1");
  await session.refreshAutosave();
  assert.equal(events.autosave.at(-1), null);
  assert.equal(server.autosave.form.notes, "the filed task", "a refresh doesn't send the forget");
});

test("deleteAutosave forgets the server copy and this browser's, and reports the row gone", async () => {
  const { session, server, storage, key, events } = setup({ offline: { values: values({ notes: "offline" }), ageMs: 60_000 } });
  storage.setItem("loan-tasks:autosave-filed:user-1", "1");
  assert.equal(await session.deleteAutosave(), true);
  assert.deepEqual(server.writes().map((call) => [call.method, call.path]), [["DELETE", "/autosave"]]);
  assert.equal(storage.getItem(key), null);
  assert.equal(storage.getItem("loan-tasks:autosave-filed:user-1"), null, "nothing is owed any more");
  assert.equal(events.autosave.at(-1), null);
});

test("a deleteAutosave that fails leaves both copies and says so", async () => {
  const notices = [];
  const env = setup({ offline: { values: values({ notes: "offline" }), ageMs: 60_000 } });
  const session = createNewTaskSession({
    owner: "user-1",
    request: env.server.request,
    storage: env.storage,
    clock: env.clock,
    notify: (message, variant) => notices.push([variant, message])
  });
  env.server.answer = () => {
    throw Object.assign(new Error("offline"), { status: 0 });
  };
  assert.equal(await session.deleteAutosave(), false);
  assert.notEqual(env.storage.getItem(env.key), null);
  assert.deepEqual(notices, [["error", "Couldn't delete the autosaved task. Try again."]]);
});

test("deleteDraft takes a Task Draft off the server, drops its offline typing, and reports it gone", async () => {
  const gone = [];
  const env = setup();
  const session = createNewTaskSession({ owner: "user-1", request: env.server.request, storage: env.storage, clock: env.clock, onSavedForLaterGone: (id) => gone.push(id) });
  env.storage.setItem("loan-tasks:unsaved-copy:user-1:sfl-1", "{}");
  assert.equal(await session.deleteDraft({ id: "sfl-1" }), true);
  assert.deepEqual(env.server.writes().map((call) => [call.method, call.path]), [["DELETE", "/saved-for-later/sfl-1"]]);
  assert.equal(env.storage.getItem("loan-tasks:unsaved-copy:user-1:sfl-1"), null);
  assert.deepEqual(gone, ["sfl-1"]);
});

test("a deleteDraft that fails keeps the row and says so", async () => {
  const gone = [];
  const notices = [];
  const env = setup();
  const session = createNewTaskSession({
    owner: "user-1",
    request: env.server.request,
    storage: env.storage,
    clock: env.clock,
    onSavedForLaterGone: (id) => gone.push(id),
    notify: (message, variant) => notices.push([variant, message])
  });
  env.server.answer = () => {
    throw Object.assign(new Error("offline"), { status: 0 });
  };
  assert.equal(await session.deleteDraft({ id: "sfl-1" }), false);
  assert.deepEqual(gone, []);
  assert.deepEqual(notices, [["error", "Couldn't delete that Task Draft. Try again."]]);
});

test("a retired session reports nothing more to App, whatever is still out", async () => {
  const { session, server, clock, events } = setup();
  await session.open();
  server.hold = (call) => call.method === "DELETE";
  session.edit(values({ notes: "typed" }));
  await clock.advance(1000);
  const before = events.autosave.length;
  const deleting = session.deleteAutosave();
  session.retire();
  server.held.shift().release();
  await deleting;
  await settle();
  assert.equal(events.autosave.length, before);
});

/* #470: the server stamps its Autosave with its own clock, the offline copy is
   stamped with this computer's, and the two can disagree by an hour. */
const HOUR = 60 * 60_000;
const skewedServer = (serverAheadBy) => {
  const env = setup();
  const { server, clock } = env;
  env.online = () => {
    server.answer = (call) => {
      if (call.method !== "PUT") return {};
      server.autosave = { ownerId: "user-1", savedAt: new Date(clock.now() + serverAheadBy).toISOString(), form: call.body.form };
      return { item: server.autosave };
    };
  };
  env.offline = () => {
    server.answer = () => {
      throw Object.assign(new Error("offline"), { status: 0 });
    };
  };
  env.type = async (notes) => {
    env.session.edit(values({ notes }));
    await clock.advance(1000);
  };
  env.online();
  return env;
};

test("clock behind the server: typing kept offline after the last server write is what comes back", async () => {
  const { session, type, online, offline } = skewedServer(HOUR);
  await session.open();
  await type("reached the server");
  offline();
  await type("typed offline after it");
  session.close();
  online();
  await session.open();
  assert.equal(openState(session).values.notes, "typed offline after it");

  offline();
  await type("typed offline after it, and more");
  session.close();
  online();
  await session.open();
  assert.equal(openState(session).values.notes, "typed offline after it, and more", "still over the same server copy");
});

test("clock ahead of the server: a newer server Autosave typed on another device beats the stale offline copy", async () => {
  const { session, server, clock, type, online, offline } = skewedServer(-HOUR);
  await session.open();
  await type("reached the server");
  offline();
  await type("typed offline, then left");
  session.close();
  await clock.advance(60_000);
  server.autosave = { ownerId: "user-1", savedAt: new Date(clock.now() - HOUR).toISOString(), form: values({ notes: "typed on another device" }) };
  online();
  await session.open();
  assert.equal(openState(session).values.notes, "typed on another device");
});

test("clock behind the server: two offline spells in a row, the second across an open that couldn't reach it, still come back", async () => {
  const { session, server, clock, type, online, offline } = skewedServer(HOUR);
  await session.open();
  await type("reached the server");
  offline();
  await type("first spell offline");
  session.close();
  server.reach = false;
  const opening = session.open();
  await settle();
  await clock.advance(5000);
  await opening;
  assert.equal(openState(session).values.notes, "first spell offline");
  await type("second spell offline");
  session.close();
  server.reach = true;
  online();
  await session.open();
  assert.equal(openState(session).values.notes, "second spell offline");
});

test("an open that can't reach the server weighs the copy App held by clock, so newer offline typing beats it", async () => {
  const { session, server, clock, type, online, offline } = skewedServer(0);
  const held = { ...server.autosave, ownerId: "user-1", savedAt: new Date(START - 60_000).toISOString(), form: values({ notes: "held by App" }) };
  server.autosave = held;
  await session.open();
  await type("reached the server");
  offline();
  await type("typed offline");
  session.close();
  server.reach = false;
  const opening = session.open();
  await settle();
  await clock.advance(5000);
  await opening;
  assert.equal(openState(session).values.notes, "typed offline");
  online();
});

/* ── Typing ─────────────────────────────────────────────── */

test("one second after typing stops, the form writes to the server Autosave", async () => {
  const { session, server, clock } = setup();
  await session.open();
  session.edit(values({ notes: "a" }));
  await clock.advance(500);
  session.edit(values({ notes: "ab" }));
  await clock.advance(999);
  assert.deepEqual(server.writes(), []);
  await clock.advance(1);
  assert.deepEqual(server.writes().map((call) => [call.method, call.path, call.body.form.notes]), [["PUT", "/autosave", "ab"]]);
  assert.equal(openState(session).values.notes, "ab");
});

test("changing only the task type is typing worth keeping", async () => {
  const { session, server, clock } = setup();
  await session.open();
  session.edit(values({ taskType: "OOO" }));
  await clock.advance(1000);
  assert.deepEqual(server.writes().map((call) => [call.method, call.body.form.taskType]), [["PUT", "OOO"]]);
});

test("writes run one at a time: a newer write waits for the one still out", async () => {
  const { session, server, clock } = setup();
  await session.open();
  server.hold = (call) => call.method === "PUT";
  session.edit(values({ notes: "first" }));
  await clock.advance(1000);
  session.edit(values({ notes: "second" }));
  await clock.advance(1000);
  assert.deepEqual(server.writes().map((call) => call.body.form.notes), ["first"]);
  server.held.shift().release();
  await settle();
  assert.deepEqual(server.writes().map((call) => call.body.form.notes), ["first", "second"]);
  server.held.shift().release();
  await settle();
});

test("offline fallback: a failed write keeps a copy in this browser, and a write that lands removes it", async () => {
  const { session, server, storage, clock, key } = setup();
  await session.open();
  server.answer = () => {
    throw Object.assign(new Error("offline"), { status: 0 });
  };
  session.edit(values({ notes: "typed offline" }));
  await clock.advance(1000);
  const kept = JSON.parse(storage.getItem(key));
  assert.equal(kept.values.notes, "typed offline");
  assert.equal(kept.savedAt, START + 1000);
  server.answer = () => ({});
  session.edit(values({ notes: "back online" }));
  await clock.advance(1000);
  assert.equal(storage.getItem(key), null);
});

test("the offline copy is never written while server writes land", async () => {
  const { session, storage, clock, key } = setup();
  await session.open();
  session.edit(values({ notes: "online" }));
  await clock.advance(1000);
  assert.equal(storage.getItem(key), null);
});

test("typing a restored form back to blank clears both copies", async () => {
  const { session, server, storage, clock, key, events } = setup({
    offline: { values: values({ notes: "restored" }), ageMs: 60_000 }
  });
  await session.open();
  session.edit(values());
  await clock.advance(1000);
  assert.equal(storage.getItem(key), null);
  assert.deepEqual(server.writes().map((call) => [call.method, call.path]), [["DELETE", "/autosave"]]);
  assert.equal(events.autosave.at(-1), null);
});

test("typing a restored form away and back again writes the restored values back over the typing", async () => {
  const { session, server, clock } = setup({ autosave: serverCopy(values({ notes: "restored" }), 60_000) });
  await session.open();
  session.edit(values({ notes: "restored, then more" }));
  await clock.advance(1000);
  session.edit(values({ notes: "restored" }));
  await clock.advance(1000);
  assert.deepEqual(server.writes().map((call) => call.body.form.notes), ["restored, then more", "restored"]);
});

test("an untouched blank form never clears anything", async () => {
  const { session, server, clock } = setup();
  await session.open();
  session.edit(values());
  await clock.advance(5000);
  assert.deepEqual(server.writes(), []);
});

/* ── Ending ─────────────────────────────────────────────── */

test("Create forgets both copies once the task is filed, after any write still out", async () => {
  const { session, server, storage, clock, key } = setup({ offline: { values: values({ notes: "restored" }), ageMs: 60_000 } });
  await session.open();
  server.hold = (call) => call.method === "PUT";
  session.edit(values({ notes: "restored, then more" }));
  await clock.advance(1000);
  const filed = [];
  const ending = session.end({ kind: "create", file: async () => filed.push("task") });
  await settle();
  assert.deepEqual(filed, [], "the create waits for the write still out");
  server.held.shift().release();
  await ending;
  await settle();
  assert.deepEqual(filed, ["task"]);
  assert.deepEqual(server.writes().map((call) => [call.method, call.path]), [["PUT", "/autosave"], ["DELETE", "/autosave"]]);
  assert.equal(storage.getItem(key), null);
  assert.equal(session.getState().phase, "closed");
});

test("a Create that fails keeps the form open with both copies, and typing is saved again", async () => {
  const { session, server, clock } = setup();
  await session.open();
  session.edit(values({ notes: "keep me" }));
  await clock.advance(1000);
  await assert.rejects(session.end({ kind: "create", file: async () => { throw new Error("refused"); } }), /refused/);
  assert.equal(openState(session).values.notes, "keep me");
  assert.equal(openState(session).ending, null);
  assert.deepEqual(server.writes().map((call) => call.method), ["PUT"]);
  session.edit(values({ notes: "keep me, fixed" }));
  await clock.advance(1000);
  assert.deepEqual(server.writes().map((call) => call.method), ["PUT", "PUT"]);
});

/* #472: a Create whose forget never reached the server. The server still holds
   the filed task as its Autosave. */
const fileWithForgetFailing = async ({ owner = "user-1" } = {}) => {
  const env = setup({ owner });
  const { session, server, clock } = env;
  const filedForm = values({ folderName: "Castillo", notes: "filed" });
  server.answer = (call) => {
    if (call.method === "DELETE") throw new Error("offline");
    if (call.method === "PUT") server.autosave = { ownerId: owner, savedAt: new Date(clock.now()).toISOString(), form: call.body.form };
    return {};
  };
  await session.open();
  session.edit(filedForm);
  await clock.advance(1000);
  await session.end({ kind: "create", file: async () => {} });
  await settle();
  assert.equal(server.autosave.form.notes, "filed", "the forget failed, so the server still holds the filed task");
  return env;
};

test("a Create whose forget fails: the next New Task opens blank, not on the filed task", async () => {
  const { session, events, server } = await fileWithForgetFailing();
  const gets = () => server.calls.filter((call) => call.method === "GET").length;
  const getsBefore = gets();
  assert.equal(await session.open(), true);
  assert.equal(gets(), getsBefore, "no point asking for a copy that is the filed task");
  assert.deepEqual(openState(session).values, BLANK_CREATE_FORM);
  assert.equal(openState(session).restored, false);
  assert.equal(events.autosave.at(-1), null);
});

test("a Create whose forget fails still opens blank after a reload, reached or not", async () => {
  const { server, storage, clock } = await fileWithForgetFailing();
  const reloaded = createNewTaskSession({ owner: "user-1", request: server.request, storage, clock });
  await reloaded.open();
  assert.deepEqual(openState(reloaded).values, BLANK_CREATE_FORM);
  assert.equal(openState(reloaded).restored, false);

  const unreached = fakeServer({ autosave: server.autosave, reach: false });
  unreached.answer = server.answer;
  const offline = createNewTaskSession({ owner: "user-1", request: unreached.request, storage, clock });
  const opening = offline.open();
  await clock.advance(5000);
  assert.equal(await opening, true);
  assert.deepEqual(openState(offline).values, BLANK_CREATE_FORM);
});

test("the filed task's server Autosave is forgotten once the server is reachable again, and only once", async () => {
  const { server, storage, clock } = await fileWithForgetFailing();
  server.answer = (call) => {
    if (call.method === "DELETE") server.autosave = null;
    return {};
  };
  const reloaded = createNewTaskSession({ owner: "user-1", request: server.request, storage, clock });
  await reloaded.open();
  assert.equal(server.autosave, null, "the owed forget went out on the way in");
  assert.deepEqual(openState(reloaded).values, BLANK_CREATE_FORM);
  reloaded.close();

  server.autosave = serverCopy(values({ notes: "typed on another device later" }), 0);
  const deletesBefore = server.writes().filter((call) => call.method === "DELETE").length;
  await reloaded.open();
  assert.equal(server.writes().filter((call) => call.method === "DELETE").length, deletesBefore, "nothing more is owed");
  assert.equal(openState(reloaded).values.notes, "typed on another device later");
});

test("a retried forget that never answers doesn't hold up later typing: it is kept offline, not raced against the forget", async () => {
  const { server, storage, clock, key } = await fileWithForgetFailing();
  server.hold = (call) => call.method === "DELETE";
  const reloaded = createNewTaskSession({ owner: "user-1", request: server.request, storage, clock });
  const opening = reloaded.open();
  await clock.advance(2000);
  assert.equal(await opening, true);
  const putsBefore = server.writes().filter((call) => call.method === "PUT").length;
  reloaded.edit(values({ notes: "the next task" }));
  await clock.advance(1000);
  assert.equal(JSON.parse(storage.getItem(key)).values.notes, "the next task");
  assert.equal(server.writes().filter((call) => call.method === "PUT").length, putsBefore, "no write races the forget still out");

  server.hold = null;
  server.held.shift().release();
  await settle();
  reloaded.edit(values({ notes: "the next task, more" }));
  await clock.advance(1000);
  assert.equal(server.writes().filter((call) => call.method === "PUT").length, putsBefore + 1, "once it answers, typing goes to the server again");
});

test("two retried forgets out at once: the first answering doesn't let typing reach the server before the second lands", async () => {
  const { server, storage, clock, key } = await fileWithForgetFailing();
  server.hold = (call) => call.method === "DELETE";
  const reloaded = createNewTaskSession({ owner: "user-1", request: server.request, storage, clock });
  const first = reloaded.open();
  await clock.advance(2000);
  assert.equal(await first, true);
  reloaded.close();
  const second = reloaded.open();
  await clock.advance(2000);
  assert.equal(await second, true);
  assert.equal(server.held.length, 2, "both forgets are still out");
  const putsBefore = server.writes().filter((call) => call.method === "PUT").length;

  server.held.shift().release();
  await settle();
  reloaded.edit(values({ notes: "the next task" }));
  await clock.advance(1000);
  assert.equal(server.writes().filter((call) => call.method === "PUT").length, putsBefore, "no write races the forget still out");
  assert.equal(JSON.parse(storage.getItem(key)).values.notes, "the next task");

  server.hold = null;
  server.held.shift().release();
  await settle();
  assert.equal(JSON.parse(storage.getItem(key)).values.notes, "the next task", "the late forget leaves the offline copy alone");
  reloaded.edit(values({ notes: "the next task, more" }));
  await clock.advance(1000);
  assert.equal(server.writes().filter((call) => call.method === "PUT").length, putsBefore + 1, "once both answer, typing goes to the server again");
});

test("typing after a filed task whose forget failed is still kept and restored", async () => {
  const { session, server, clock } = await fileWithForgetFailing();
  await session.open();
  session.edit(values({ notes: "the next task" }));
  await clock.advance(1000);
  assert.equal(server.autosave.form.notes, "the next task");
  session.close();
  const deletesBefore = server.writes().filter((call) => call.method === "DELETE").length;
  await session.open();
  assert.equal(openState(session).values.notes, "the next task");
  assert.equal(openState(session).restored, true);
  assert.equal(server.writes().filter((call) => call.method === "DELETE").length, deletesBefore, "the write replaced the filed copy");
});

test("typing after a filed task, kept only offline, is still restored while the forget is owed", async () => {
  const { session, server, clock } = await fileWithForgetFailing();
  server.answer = () => {
    throw new Error("offline");
  };
  await session.open();
  session.edit(values({ notes: "the next task, offline" }));
  await clock.advance(1000);
  session.close();
  await clock.advance(60_000);
  await session.open();
  assert.equal(openState(session).values.notes, "the next task, offline");
});

test("Save for later goes out as one request that also clears the Autosave", async () => {
  const saved = { id: "sfl-1", ownerId: "user-1", savedAt: new Date(START).toISOString(), form: values({ notes: "later" }) };
  const { session, server, storage, key, events } = setup({ offline: { values: values({ notes: "later" }), ageMs: 60_000 } });
  await session.open();
  server.answer = (call) => (call.path === "/saved-for-later" ? { item: saved } : {});
  const item = await session.end({ kind: "saveForLater" });
  await settle();
  assert.equal(item, saved);
  assert.deepEqual(server.writes().map((call) => [call.method, call.path, call.body]), [
    ["POST", "/saved-for-later", { form: values({ notes: "later" }), clearAutosave: true }]
  ]);
  assert.equal(storage.getItem(key), null);
  assert.deepEqual(events.savedForLater, [saved]);
  assert.equal(events.autosave.at(-1), null);
  assert.equal(session.getState().phase, "closed");
});

test("a Save for later that fails keeps the form open and rejects", async () => {
  const { session, server, storage, key } = setup({ offline: { values: values({ notes: "later" }), ageMs: 60_000 } });
  await session.open();
  server.answer = () => {
    throw new Error("Failed to save for later");
  };
  await assert.rejects(session.end({ kind: "saveForLater" }), /Failed to save/);
  assert.equal(openState(session).values.notes, "later");
  assert.notEqual(storage.getItem(key), null);
});

test("Discard forgets both copies, after the write still out, and closes", async () => {
  const { session, server, storage, clock, key, events } = setup({ offline: { values: values({ notes: "x" }), ageMs: 60_000 } });
  await session.open();
  server.hold = (call) => call.method === "PUT";
  session.edit(values({ notes: "xy" }));
  await clock.advance(1000);
  session.end({ kind: "cancel" });
  assert.equal(openState(session).asking, true);
  const ending = session.end({ kind: "discard" });
  assert.equal(openState(session).ending, "discard");
  assert.equal(storage.getItem(key), null);
  server.held.shift().release();
  await ending;
  assert.deepEqual(server.writes().map((call) => [call.method, call.path]), [["PUT", "/autosave"], ["DELETE", "/autosave"]]);
  assert.equal(storage.getItem(key), null, "the write that landed late did not put a copy back");
  assert.equal(events.autosave.at(-1), null);
  assert.equal(session.getState().phase, "closed");
});

test("Start fresh blanks the form, forgets both copies, and stays open without writing the blank back", async () => {
  const { session, server, storage, clock, key } = setup({ offline: { values: values({ notes: "not this one" }), ageMs: 60_000 } });
  await session.open();
  await session.end({ kind: "startFresh" });
  const state = openState(session);
  assert.deepEqual(state.values, BLANK_CREATE_FORM);
  assert.equal(state.restored, false);
  assert.equal(storage.getItem(key), null);
  await clock.advance(5000);
  assert.deepEqual(server.writes().map((call) => [call.method, call.path]), [["DELETE", "/autosave"]]);
  session.edit(values({ notes: "a new one" }));
  await clock.advance(1000);
  assert.deepEqual(server.writes().map((call) => call.method), ["DELETE", "PUT"]);
});

test("Cancel on a blank form closes silently", async () => {
  const { session, server, clock } = setup();
  await session.open();
  assert.equal(await session.end({ kind: "cancel" }), "closed");
  assert.equal(session.getState().phase, "closed");
  await clock.advance(5000);
  assert.deepEqual(server.writes(), []);
});

test("Cancel on a form that differs from blank asks, and Keep editing takes the question down", async () => {
  const { session } = setup();
  await session.open();
  session.edit(values({ taskType: "FRAUD" }));
  assert.equal(await session.end({ kind: "cancel" }), "asked");
  assert.equal(openState(session).asking, true);
  session.resume();
  assert.equal(openState(session).asking, false);
});

test("Cancel asks on a restored form left untouched, and on a half-typed outstanding item", async () => {
  const restored = setup({ offline: { values: values({ notes: "restored" }), ageMs: 60_000 } });
  await restored.session.open();
  assert.equal(await restored.session.end({ kind: "cancel" }), "asked");

  const pending = setup();
  await pending.session.open();
  pending.session.notePendingItem("  ");
  assert.equal(await pending.session.end({ kind: "cancel" }), "closed", "a box holding only spaces holds nothing");
  await pending.session.open();
  pending.session.notePendingItem("W-2");
  assert.equal(await pending.session.end({ kind: "cancel" }), "asked");
});

test("hasTyping is the yardstick Save for later is offered on", async () => {
  const { session } = setup();
  await session.open();
  assert.equal(session.hasTyping(), false);
  session.notePendingItem("W-2");
  assert.equal(session.hasTyping(), true);
  session.notePendingItem("");
  session.edit(values({ urgency: "RED" }));
  assert.equal(session.hasTyping(), true);
});

test("the half-typed item lives in the session: it is on the state, Start fresh empties it, and a new open starts without it", async () => {
  const { session } = setup({ offline: { values: values({ taskType: "FRAUD" }), ageMs: 60_000 } });
  await session.open();
  assert.equal(openState(session).pendingItem, "");
  session.notePendingItem("Missing W-2");
  assert.equal(openState(session).pendingItem, "Missing W-2");
  await session.end({ kind: "startFresh" });
  assert.equal(openState(session).pendingItem, "");
  session.notePendingItem("Missing W-2");
  session.close();
  await session.open();
  assert.equal(openState(session).pendingItem, "");
});

test("Save for later folds a Fraud Check's half-typed item into its list", async () => {
  const { session, server } = setup();
  await session.open();
  server.answer = (call) => ({ item: { id: "sfl-1", ownerId: "user-1", savedAt: new Date(START).toISOString(), form: call.body.form } });
  session.edit(values({ taskType: "FRAUD", initialItems: ["Bank statement"] }));
  session.notePendingItem("  Missing W-2 ");
  const saved = await session.end({ kind: "saveForLater" });
  assert.deepEqual(saved.form.initialItems, ["Bank statement", "Missing W-2"]);
});

test("subscribers hear every change of state", async () => {
  const { session } = setup();
  const phases = [];
  const stop = session.subscribe(() => phases.push(session.getState().phase));
  await session.open();
  session.edit(values({ notes: "a" }));
  stop();
  session.edit(values({ notes: "ab" }));
  assert.deepEqual(phases, ["opening", "open", "open"]);
});

/* ── Discarded typing stays discarded (#471) ───────────── */

/* The server as it really is: PUT keeps the Autosave, DELETE forgets it, and
   while unreachable nothing lands and the load never answers. */
const realServer = (server, clock) => {
  server.answer = (call) => {
    if (!server.reach) throw Object.assign(new Error("offline"), { status: 0 });
    if (call.method === "PUT") server.autosave = serverCopy(call.body.form, START - clock.now());
    if (call.method === "DELETE") server.autosave = null;
    return {};
  };
};

const openWithin = async (session, clock) => {
  const opening = session.open();
  await settle();
  await clock.advance(5000);
  assert.equal(await opening, true);
  return openState(session);
};

/* Typing kept on the server, then more typing whose write is still out when
   the server drops. */
const typedThenOffline = async () => {
  const env = setup();
  const { session, server, clock } = env;
  realServer(server, clock);
  await session.open();
  session.edit(values({ notes: "throw this away" }));
  await clock.advance(1000);
  assert.equal(server.autosave.form.notes, "throw this away");
  server.hold = (call) => call.method === "PUT";
  session.edit(values({ notes: "throw this away too" }));
  await clock.advance(1000);
  server.hold = null;
  server.reach = false;
  return env;
};

test("Discard with the server unreachable: the next New Task opens blank", async () => {
  const { session, server, storage, clock, key } = await typedThenOffline();
  const ending = session.end({ kind: "discard" });
  server.held.shift().release();
  await ending;
  await settle();
  assert.equal(storage.getItem(key), null, "the write that failed after the discard did not put a copy back");
  assert.equal(server.autosave.form.notes, "throw this away", "nothing reached the server");
  const state = await openWithin(session, clock);
  assert.deepEqual(state.values, BLANK_CREATE_FORM);
  assert.equal(state.restored, false);

  const reloaded = createNewTaskSession({ owner: "user-1", request: server.request, storage, clock });
  assert.deepEqual((await openWithin(reloaded, clock)).values, BLANK_CREATE_FORM);
});

test("Start fresh with the server unreachable: the next New Task opens blank", async () => {
  const { session, server, storage, clock, key } = await typedThenOffline();
  await session.end({ kind: "startFresh" });
  server.held.shift().release();
  await settle();
  await clock.advance(5000);
  assert.equal(storage.getItem(key), null);
  assert.deepEqual(openState(session).values, BLANK_CREATE_FORM);
  session.close();
  const state = await openWithin(session, clock);
  assert.deepEqual(state.values, BLANK_CREATE_FORM);
  assert.equal(state.restored, false);
});

test("Start fresh offline, then new typing kept offline: that typing is what comes back", async () => {
  const { session, server, clock } = await typedThenOffline();
  await session.end({ kind: "startFresh" });
  server.held.shift().release();
  await settle();
  session.edit(values({ notes: "the one I want" }));
  await clock.advance(1000);
  session.close();
  await clock.advance(60_000);
  assert.equal((await openWithin(session, clock)).values.notes, "the one I want");
});

test("emptying a restored form and pressing Cancel within the second: the next New Task opens blank", async () => {
  const { session, server, storage, clock, key, events } = setup({
    offline: { values: values({ notes: "restored" }), ageMs: 60_000 }
  });
  realServer(server, clock);
  server.autosave = serverCopy(values({ notes: "restored" }), 60_000);
  await session.open();
  assert.equal(openState(session).restored, true);
  session.edit(values());
  await clock.advance(300);
  assert.equal(await session.end({ kind: "cancel" }), "closed");
  await settle();
  assert.equal(storage.getItem(key), null);
  assert.equal(server.autosave, null);
  assert.equal(events.autosave.at(-1), null);
  assert.deepEqual((await openWithin(session, clock)).values, BLANK_CREATE_FORM);
});

test("emptying a restored form and pressing Cancel within the second, offline: the next New Task opens blank", async () => {
  const { session, server, storage, clock, key } = setup({
    offline: { values: values({ notes: "restored" }), ageMs: 60_000 }
  });
  realServer(server, clock);
  server.autosave = serverCopy(values({ notes: "restored" }), 60_000);
  await session.open();
  server.reach = false;
  session.edit(values());
  assert.equal(await session.end({ kind: "cancel" }), "closed");
  await settle();
  assert.equal(storage.getItem(key), null);
  assert.deepEqual((await openWithin(session, clock)).values, BLANK_CREATE_FORM);
});

test("emptying a restored form and closing it from the header within the second, offline: the next New Task opens blank", async () => {
  const { session, server, storage, clock, key } = setup({
    offline: { values: values({ notes: "restored" }), ageMs: 60_000 }
  });
  realServer(server, clock);
  server.autosave = serverCopy(values({ notes: "restored" }), 60_000);
  await session.open();
  server.reach = false;
  session.edit(values());
  session.close();
  await settle();
  assert.equal(storage.getItem(key), null);
  assert.deepEqual((await openWithin(session, clock)).values, BLANK_CREATE_FORM);
});

test("closing a restored form that still has typing forgets nothing", async () => {
  const { session, server, clock } = setup({ offline: { values: values({ notes: "restored" }), ageMs: 60_000 } });
  await session.open();
  session.edit(values({ notes: "restored, and more" }));
  session.close();
  await clock.advance(5000);
  assert.deepEqual(server.writes(), []);
  assert.equal((await openWithin(session, clock)).values.notes, "restored");
});

test("an earlier forget that lands doesn't settle a later one that fails", async () => {
  const { session, server, storage, clock } = setup({ offline: { values: values({ notes: "old" }), ageMs: 60_000 } });
  realServer(server, clock);
  await session.open();
  server.hold = () => true;
  await session.end({ kind: "startFresh" });
  session.edit(values({ notes: "replacement" }));
  await clock.advance(1000);
  const ending = session.end({ kind: "discard" });
  server.held.shift().release();
  await settle();
  server.held.shift().release();
  await settle();
  assert.equal(server.autosave.form.notes, "replacement");
  server.hold = null;
  server.reach = false;
  server.held.shift().release();
  await ending;
  await settle();
  const reloaded = createNewTaskSession({ owner: "user-1", request: server.request, storage, clock });
  assert.deepEqual((await openWithin(reloaded, clock)).values, BLANK_CREATE_FORM);
});

test("a blank form never restored, cancelled within the second, forgets nothing", async () => {
  const { session, server, clock } = setup();
  await session.open();
  session.edit(values({ notes: "a" }));
  session.edit(values());
  assert.equal(await session.end({ kind: "cancel" }), "closed");
  await clock.advance(5000);
  assert.deepEqual(server.writes(), []);
});

test("when the server comes back, its stale Autosave of the discarded typing is forgotten, not restored", async () => {
  const { session, server, storage, clock } = await typedThenOffline();
  const ending = session.end({ kind: "discard" });
  server.held.shift().release();
  await ending;
  await settle();
  server.reach = true;
  assert.equal(server.autosave.form.notes, "throw this away");
  const reloaded = createNewTaskSession({ owner: "user-1", request: server.request, storage, clock });
  const state = await openWithin(reloaded, clock);
  assert.deepEqual(state.values, BLANK_CREATE_FORM);
  assert.equal(server.autosave, null, "the owed forget went out on the way in");
  reloaded.close();
  const deletesBefore = server.writes().filter((call) => call.method === "DELETE").length;
  await openWithin(reloaded, clock);
  assert.equal(server.writes().filter((call) => call.method === "DELETE").length, deletesBefore, "nothing more is owed");
});

test("a write that lands after Discard, whose forget then fails, doesn't cancel the owed forget", async () => {
  const { session, server, storage, clock } = setup();
  realServer(server, clock);
  await session.open();
  server.hold = () => true;
  session.edit(values({ notes: "throw this away" }));
  await clock.advance(1000);
  const ending = session.end({ kind: "discard" });
  server.held.shift().release();
  await settle();
  server.hold = null;
  server.reach = false;
  server.held.shift().release();
  await ending;
  await settle();
  assert.equal(server.autosave.form.notes, "throw this away", "the write landed, the forget didn't");
  const reloaded = createNewTaskSession({ owner: "user-1", request: server.request, storage, clock });
  assert.deepEqual((await openWithin(reloaded, clock)).values, BLANK_CREATE_FORM);
});

/* ── Ownership ──────────────────────────────────────────── */

test("changing the selected person closes the form, and no write goes out for the other person", async () => {
  const clock = fakeClock();
  const storage = fakeStorage();
  const dana = fakeServer({ owner: "user-1" });
  const sam = fakeServer({ owner: "user-2" });
  const make = (owner, server) => createNewTaskSession({ owner, request: server.request, storage, clock });

  const first = make("user-1", dana);
  await first.open();
  first.edit(values({ notes: "Dana's half-typed task" }));
  /* The picker switches to Sam before the debounce fires: App drops Dana's
     session, which closes it, and starts Sam's, closed. */
  first.close();
  const second = make("user-2", sam);
  assert.equal(first.getState().phase, "closed");
  assert.equal(second.getState().phase, "closed");
  await clock.advance(10_000);

  assert.deepEqual(dana.writes(), [], "the typing is not written after the switch, not even as Dana");
  assert.deepEqual(sam.calls, [], "nothing goes out as Sam");
  assert.equal(storage.getItem(draftKey("user-2")), null, "nothing lands in Sam's copy");
  assert.equal(storage.getItem(draftKey("user-1")), null);

  /* Typing that reaches Dana's closed session later goes nowhere either. */
  first.edit(values({ notes: "late keystroke" }));
  await clock.advance(10_000);
  assert.deepEqual(dana.writes(), []);
});

test("a write already out when the person changes lands as, and on, the person who typed it", async () => {
  const clock = fakeClock();
  const storage = fakeStorage();
  const dana = fakeServer({ owner: "user-1" });
  const sam = fakeServer({ owner: "user-2" });
  const first = createNewTaskSession({ owner: "user-1", request: dana.request, storage, clock });
  await first.open();
  dana.hold = (call) => call.method === "PUT";
  dana.answer = () => {
    throw new Error("offline");
  };
  first.edit(values({ notes: "Dana's typing" }));
  await clock.advance(1000);
  first.close();
  const second = createNewTaskSession({ owner: "user-2", request: sam.request, storage, clock });
  dana.held.shift().release();
  await settle();
  assert.deepEqual(dana.writes().map((call) => call.owner), ["user-1"]);
  assert.deepEqual(sam.calls, []);
  assert.equal(JSON.parse(storage.getItem(draftKey("user-1"))).values.notes, "Dana's typing", "the offline copy is Dana's");
  assert.equal(storage.getItem(draftKey("user-2")), null);
  assert.equal(second.getState().phase, "closed");
});

/* #474: the keyboard reaches New Task and the Autosaved row behind an open form. */
test("New Task pressed again while the form is open leaves it open, and its typing is still written", async () => {
  const { session, server, clock } = setup();
  await session.open();
  session.edit(values({ notes: "half typed" }));
  await clock.advance(500);
  const gets = server.calls.filter((call) => call.method === "GET").length;
  assert.equal(await session.open(), false);
  assert.equal(server.calls.filter((call) => call.method === "GET").length, gets, "nothing is fetched for a form already up");
  assert.equal(openState(session).values.notes, "half typed");
  await clock.advance(500);
  assert.deepEqual(server.writes().map((call) => [call.method, call.path, call.body.form.notes]), [["PUT", "/autosave", "half typed"]]);
});

test("App's New Task button and Autosaved row only ever open, never close or swap a form already up", () => {
  const app = readFileSync(join(REPO, "apps/web/src/App.tsx"), "utf8");
  const button = app.match(/<NewTaskButton open=\{newTaskOpen\} onClick=\{([^\n]*)\} \/>/);
  assert.ok(button, "the button is wired in App");
  assert.doesNotMatch(button[1], /close|setFormOpen/, "the button never shuts a form");
  assert.match(button[1], /newTask\.open\(\)/, "it opens through the session");
  assert.match(app, /className="form-toggle" aria-haspopup="dialog" aria-disabled=\{open\}/, "it says it does nothing while a form is up, not that it collapses one");
  assert.match(app, /<TaskDraftsPage[^>]*onOpenAutosave=\{newTask\.open\}/, "the Autosaved row is the same way in");
});

test("a person's change hands over: the old session closes and reports nothing more", async () => {
  const first = setup();
  await first.session.open();
  first.session.edit(values({ notes: "Dana's typing" }));
  const second = setup({ owner: "user-2" });
  handOver(first.session, second.session);
  assert.equal(first.session.getState().phase, "closed");
  assert.equal(second.session.getState().phase, "closed", "a known person's typing isn't carried to the next one");
  const before = first.events.autosave.length;
  await first.session.refreshAutosave();
  assert.equal(first.events.autosave.length, before);
});

/* The hook's effects can't run in a static render, so App's wiring of the
   ownership rule is read out of the source. */
test("App keeps one session per person, and the hook closes the old one when the person changes", () => {
  const app = readFileSync(join(REPO, "apps/web/src/App.tsx"), "utf8");
  const session = readFileSync(join(REPO, "apps/web/src/new-task-session.ts"), "utf8");
  assert.match(app, /useNewTaskSession\(\{\s*owner: user\.id,\s*request: savedForLaterRequestFor\(user\),/);
  assert.match(session, /useMemo\(\(\) => createNewTaskSession\(deps\), \[deps\.owner\]\)/);
  assert.match(session, /if \(previous\.current && previous\.current !== session\) handOver\(previous\.current, session\);/, "the old person's session is handed over from once the new one is in");
  assert.match(app, /\{newTaskOpen && \(\s*<TaskForm\s*key=\{`new:\$\{newTask\.owner\}[^`]*`\}/, "the form is the session's, so a new person's closed session unmounts it");
});
