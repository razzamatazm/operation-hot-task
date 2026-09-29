#!/usr/bin/env node
/* A web request the server never answers gives up after REQUEST_TIMEOUT_MS
   and fails the way an unreachable server does (#468).
   Run: `node --test scripts/request-timeout-sim-test.mjs`. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { REQUEST_TIMEOUT_MS, withRequestTimeout } from "../apps/web/src/request-timeout.ts";
import { keepAutosaveRequest } from "../apps/web/src/saved-for-later-requests.ts";

const never = () => new Promise(() => {});

test("the timeout is about ten seconds", () => {
  assert.equal(REQUEST_TIMEOUT_MS, 10_000);
});

test("a request that never resolves rejects like an unreachable server, and is aborted", async () => {
  let seen;
  const started = Date.now();
  await assert.rejects(
    withRequestTimeout((signal) => {
      seen = signal;
      return never();
    }, 30),
    (error) => error instanceof TypeError && error.message === "Failed to fetch"
  );
  assert.ok(Date.now() - started >= 25, "it waited for the timeout");
  assert.equal(seen.aborted, true, "the hung fetch is aborted so it stops holding a connection");
});

test("a request that answers in time keeps its answer and its signal is left alone", async () => {
  let seen;
  const value = await withRequestTimeout(async (signal) => {
    seen = signal;
    return { ok: 1 };
  }, 60_000);
  assert.deepEqual(value, { ok: 1 });
  assert.equal(seen.aborted, false);
});

test("a request that fails on its own keeps its own error", async () => {
  const refusal = Object.assign(new Error("Only the creator can do that"), { status: 403 });
  await assert.rejects(withRequestTimeout(() => Promise.reject(refusal), 60_000), (error) => error === refusal);
});

test("a hung autosave write reports not landed, and the next write in the queue still runs", async () => {
  let calls = 0;
  const request = (path, init) =>
    withRequestTimeout(() => {
      calls += 1;
      return calls === 1 ? never() : Promise.resolve({ item: { path, method: init.method } });
    }, 30);
  const results = [];
  let queue = Promise.resolve();
  for (let i = 0; i < 2; i++) {
    queue = queue.then(async () => {
      results.push(await keepAutosaveRequest(request, {}));
    });
  }
  await queue;
  assert.deepEqual(results, [false, true], "the hung write falls back; the one behind it lands");
});

test("every apiRequest goes through the timeout, with its signal on each fetch", () => {
  const app = readFileSync(new URL("../apps/web/src/App.tsx", import.meta.url), "utf8");
  const start = app.indexOf("const apiRequest = ");
  assert.ok(start >= 0, "apiRequest is in App.tsx");
  const body = app.slice(start, app.indexOf("\n  });\n", start));
  assert.match(body, /withRequestTimeout\(/, "apiRequest runs inside the timeout");
  assert.match(body, /fetch\([^)]*\{[\s\S]*?signal/, "each fetch carries the timeout's signal");
});
