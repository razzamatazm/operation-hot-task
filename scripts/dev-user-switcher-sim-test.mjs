#!/usr/bin/env node
/* The local user switcher's roster (apps/web/src/dev-users.ts), issue #309.

   The switcher used to carry its cast as a literal in App.tsx — Suzie, Alexa,
   Johanna — and the seeder grew a fourth person, Heather Finn, who filed two of
   the seeded tasks. A `npm run dev:reset` therefore produced tasks belonging to
   somebody you could not become, and their creator-only paths were unreachable
   locally. The roster now comes from the server's active-user directory, so it
   cannot drift again.

   Two things had to be got right, and they are what this file is about:

   - **Nothing is requested as a placeholder.** The app starts as nobody (empty
     id) in both builds now, every fetch is gated on a non-empty id, and an
     absent or broken roster leaves it as nobody rather than inventing a
     stand-in. The roster fetch itself is the only request made without an
     identity, which is why it goes to an unauthenticated dev-only route
     instead of one that would register the stand-in as a real person.
   - **The selected person survives the roster arriving.** Whoever is selected
     when a roster lands stays selected, refreshed from that roster.

   Pure value-in/value-out, so it runs under node's TS type stripping with no
   build. Run: `node --test scripts/dev-user-switcher-sim-test.mjs`. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEV_USERS_PATH, chooseDevUser, fetchDevUsers, loadDevUsers } from "../apps/web/src/dev-users.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP_SOURCE = readFileSync(join(REPO, "apps/web/src/App.tsx"), "utf8");
const ROUTES_SOURCE = readFileSync(join(REPO, "apps/server/src/routes.ts"), "utf8");

const SUZIE = { id: "loan-officer-1", displayName: "Suzie", roles: ["LOAN_OFFICER"] };
const ALEXA = { id: "file-checker-1", displayName: "Alexa", roles: ["LOAN_OFFICER", "FILE_CHECKER"] };
const HEATHER = { id: "new-1", displayName: "Heather Finn", roles: ["LOAN_OFFICER"] };
const ROSTER = [SUZIE, ALEXA, HEATHER];

/* A fetch that answers one canned response, and records what it was asked for. */
const stubFetch = (response) => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (response instanceof Error) {
      throw response;
    }
    return response;
  };
  impl.calls = calls;
  return impl;
};

const jsonResponse = (body, ok = true) => ({ ok, json: async () => body });

/* ── Choosing who to be ─────────────────────────────────── */

test("with no one selected, the first person on the roster is taken", () => {
  assert.deepEqual(chooseDevUser(ROSTER, ""), SUZIE);
});

/* The crux of #309's "don't lose the selected person". The roster arrives after
   the app has been usable for a moment, and a second fetch can land after a
   switch. Either way the id in hand wins over the head of the list. */
test("a selected person survives the roster arriving", () => {
  assert.deepEqual(chooseDevUser(ROSTER, HEATHER.id), HEATHER);
  assert.deepEqual(chooseDevUser(ROSTER, ALEXA.id), ALEXA);
});

/* The record comes off the roster, not out of the caller's hand, so a rename or
   a role change on the server is picked up rather than pinned to whatever the
   app happened to be holding — the roles ride the `x-user-roles` header and
   decide what the app lets you do. */
test("the selected person is refreshed from the roster, not kept as held", () => {
  const promoted = { ...HEATHER, displayName: "Heather Finn-Rowe", roles: ["LOAN_OFFICER", "FILE_CHECKER"] };
  const chosen = chooseDevUser([SUZIE, promoted], HEATHER.id);
  assert.equal(chosen.displayName, "Heather Finn-Rowe");
  assert.deepEqual(chosen.roles, ["LOAN_OFFICER", "FILE_CHECKER"]);
});

/* The directory is active people only, so a person who has just been
   deactivated simply stops appearing. Keeping them selected would leave the app
   acting as somebody the server now refuses at auth. */
test("a selected person the roster no longer carries falls back to its head", () => {
  assert.deepEqual(chooseDevUser([SUZIE, ALEXA], HEATHER.id), SUZIE);
});

/* The whole point of the placeholder gate: an empty roster must not resolve to
   an identity. Null means "stay as nobody", and every fetch in App is held
   behind a non-empty id. */
test("an empty roster picks nobody", () => {
  assert.equal(chooseDevUser([], ""), null);
  assert.equal(chooseDevUser([], SUZIE.id), null, "even with an id in hand");
});

/* ── Reading the roster ─────────────────────────────────── */

test("the roster is read from the dev-only route, unauthenticated", async () => {
  const impl = stubFetch(jsonResponse({ users: ROSTER }));
  assert.deepEqual(await fetchDevUsers("/api", impl), ROSTER);
  assert.equal(impl.calls.length, 1);
  assert.equal(impl.calls[0].url, `/api${DEV_USERS_PATH}`);
  assert.equal(
    impl.calls[0].init,
    undefined,
    "no headers: sending an x-user-id here is exactly the placeholder request #309 forbids"
  );
});

/* A prod server does not register the route at all, so this is the shape of a
   dev bundle pointed at a real deployment. It must degrade to "no roster", not
   to an exception nobody catches. */
test("a 404 answers an empty roster", async () => {
  assert.deepEqual(await fetchDevUsers("/api", stubFetch(jsonResponse({}, false))), []);
});

test("an unreachable server answers an empty roster", async () => {
  assert.deepEqual(await fetchDevUsers("/api", stubFetch(new Error("ECONNREFUSED"))), []);
});

test("a body that is not a roster answers an empty roster", async () => {
  assert.deepEqual(await fetchDevUsers("/api", stubFetch(jsonResponse({ users: "nope" }))), []);
  assert.deepEqual(await fetchDevUsers("/api", stubFetch(jsonResponse({}))), []);
});

test("entries that are not people are dropped", async () => {
  const impl = stubFetch(jsonResponse({ users: [SUZIE, null, { id: "" }, { displayName: "No id" }] }));
  assert.deepEqual(await fetchDevUsers("/api", impl), [SUZIE]);
});

/* ── Surviving a server that isn't up yet ───────────────── */

/* `npm run dev` starts vite and the API together and vite usually wins, so the
   first read can beat the server to the port. That cost nothing while the app
   started as a hardcoded person; now an empty roster is an app that is nobody,
   with no way back but a reload. */
test("a roster that is empty at first is retried until it isn't", async () => {
  let call = 0;
  const impl = async () => {
    call += 1;
    return call < 3 ? { ok: false, json: async () => ({}) } : jsonResponse({ users: ROSTER });
  };
  const slept = [];
  const roster = await loadDevUsers("/api", { fetchImpl: impl, sleep: async (ms) => void slept.push(ms) });
  assert.deepEqual(roster, ROSTER);
  assert.equal(call, 3, "gave up on neither of the first two answers");
  assert.equal(slept.length, 2, "waited between attempts, not after the last one");
});

test("a roster that never arrives gives up, and gives up empty", async () => {
  const impl = stubFetch(new Error("ECONNREFUSED"));
  const roster = await loadDevUsers("/api", { fetchImpl: impl, sleep: async () => {}, attempts: 4 });
  assert.deepEqual(roster, [], "still nobody, never a made-up somebody");
  assert.equal(impl.calls.length, 4, "bounded — it does not retry forever");
});

/* A server that is up with an empty users file reads the same as one that is
   down, so it is retried the same way and lands on the same empty roster —
   which the switcher renders as the one command that fixes it. */
test("an up server with no people in it lands on an empty roster too", async () => {
  const impl = stubFetch(jsonResponse({ users: [] }));
  assert.deepEqual(await loadDevUsers("/api", { fetchImpl: impl, sleep: async () => {}, attempts: 2 }), []);
  assert.ok(
    APP_SOURCE.includes("No people — run npm run dev:reset"),
    "the empty switcher names the command that seeds the cast"
  );
});

/* ── What App must not go back to ───────────────────────── */

/* The failure #309 fixes was a literal cast in App.tsx. Nothing type-checks that
   away, so assert on the source: no hardcoded list, and the roster fetch is the
   one the module above provides. */
test("App carries no hardcoded cast", () => {
  assert.ok(!/DEV_USERS\s*:/.test(APP_SOURCE), "no DEV_USERS literal");
  for (const name of ["Suzie", "Alexa", "Johanna", "Heather"]) {
    assert.ok(!APP_SOURCE.includes(`"${name}`), `${name} is not named in App.tsx`);
  }
  assert.ok(APP_SOURCE.includes("loadDevUsers"), "the roster is fetched");
  assert.ok(APP_SOURCE.includes("chooseDevUser"), "the selection rule is the shared one");
});

/* Both the roster fetch and the selector sit behind IS_DEV, which vite replaces
   with a literal false in a prod build, so the whole switcher leaves the
   bundle. The server route is behind the same condition that turns on the
   `x-user-*` header path it rides — no SSO. */
test("the switcher stays out of a production build, and off a deployed server", () => {
  assert.ok(APP_SOURCE.includes("if (!IS_DEV) return;"), "the roster fetch is dev-gated");
  assert.ok(APP_SOURCE.includes("{IS_DEV ? ("), "the selector is dev-gated");
  assert.ok(
    /if \(!ssoConfigured\(\)\) \{\s*router\.get\("\/dev\/users"/.test(ROUTES_SOURCE),
    "the dev route is registered only when SSO is unconfigured"
  );
});

/* Every request is gated on a real identity now, in both builds — the old
   `!IS_DEV && !user.id` let dev fire immediately because it started as a
   hardcoded person, and there is no hardcoded person any more. */
test("no fetch is gated on the build instead of on an identity", () => {
  assert.ok(!APP_SOURCE.includes("!IS_DEV && !user.id"), "no build-conditional identity gate remains");
  assert.equal(
    (APP_SOURCE.match(/if \(!user\.id\) return;/g) ?? []).length,
    2,
    "the task/loan fetch and the directory fetch both hold for an identity"
  );
  assert.ok(APP_SOURCE.includes("if (!claimOnArrivalId || !user.id) {"), "claim-on-arrival holds too");
});
