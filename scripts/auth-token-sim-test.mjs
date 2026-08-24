#!/usr/bin/env node
/* Unit test for the Teams SSO token cache (apps/web/src/auth-token.ts).

   Issue #175: the token was acquired once at mount and held forever, so after
   about an hour every request 401'd with `"exp" claim timestamp check failed`
   while Teams itself was still signed in. The cache is framework-free and
   takes its acquire/clock as arguments, so it runs here under node's TS type
   stripping (node >= 24). Run: `node --test scripts/auth-token-sim-test.mjs`. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  TOKEN_EXPIRY_SKEW_MS,
  createTokenCache,
  tokenExpiryMs
} from "../apps/web/src/auth-token.ts";

/* Build a token whose `exp` is `secondsFromEpoch`. Signature is never checked
   on this side — the server does the real verification. */
const tokenExpiringAt = (secondsFromEpoch, label = "t") => {
  const body = Buffer.from(JSON.stringify({ exp: secondsFromEpoch, label }))
    .toString("base64url");
  return `header.${body}.signature`;
};

/* A clock the test moves by hand, plus an acquirer that counts its calls and
   hands back a token good for an hour from "now". */
const harness = (startMs = 1_700_000_000_000) => {
  const state = { now: startMs, acquires: 0 };
  const acquire = async () => {
    state.acquires += 1;
    return tokenExpiringAt(Math.floor(state.now / 1000) + 3600, `t${state.acquires}`);
  };
  const cache = createTokenCache(acquire, () => state.now);
  return { state, cache, advance: (ms) => { state.now += ms; } };
};

test("tokenExpiryMs reads exp; unreadable tokens count as already stale", () => {
  assert.equal(tokenExpiryMs(tokenExpiringAt(1_700_000_000)), 1_700_000_000_000);
  assert.equal(tokenExpiryMs("not-a-jwt"), 0);
  assert.equal(tokenExpiryMs("header.!!!not-base64!!!.sig"), 0);
  /* A well-formed token with no exp claim gets 0, not a trusted forever. */
  assert.equal(tokenExpiryMs(`header.${Buffer.from("{}").toString("base64url")}.sig`), 0);
});

test("no Teams host: get() returns null and never calls Teams", async () => {
  const { state, cache } = harness();
  cache.seed(null);
  assert.equal(cache.ssoEnabled(), false);
  assert.equal(await cache.get(), null);
  assert.equal(await cache.get(true), null);
  assert.equal(state.acquires, 0);
});

test("a fresh seeded token is reused without re-acquiring", async () => {
  const { state, cache } = harness();
  cache.seed(tokenExpiringAt(1_700_003_600, "seed"));
  assert.equal(cache.ssoEnabled(), true);
  const first = await cache.get();
  assert.equal(await cache.get(), first);
  assert.equal(state.acquires, 0);
});

test("the original bug: past its exp, the cache re-acquires instead of resending", async () => {
  const { state, cache, advance } = harness();
  cache.seed(tokenExpiringAt(1_700_003_600, "seed"));
  const stale = await cache.get();

  advance(90 * 60_000); /* an hour and a half at the desk */

  const refreshed = await cache.get();
  assert.equal(state.acquires, 1);
  assert.notEqual(refreshed, stale);
});

test("refresh happens inside the skew window, before the token actually dies", async () => {
  const { state, cache, advance } = harness();
  cache.seed(tokenExpiringAt(1_700_003_600, "seed"));
  await cache.get();

  /* One minute short of the skew window: still fresh. */
  advance(3600_000 - TOKEN_EXPIRY_SKEW_MS - 60_000);
  await cache.get();
  assert.equal(state.acquires, 0);

  /* Two minutes later we are inside it, and the token is replaced early. */
  advance(120_000);
  await cache.get();
  assert.equal(state.acquires, 1);
});

test("force discards the current token — the 401 retry path", async () => {
  const { state, cache } = harness();
  cache.seed(tokenExpiringAt(1_700_003_600, "seed"));
  const rejected = await cache.get();

  const retry = await cache.get(true);
  assert.equal(state.acquires, 1);
  assert.notEqual(retry, rejected);
  /* And the replacement is what subsequent requests use. */
  assert.equal(await cache.get(), retry);
  assert.equal(state.acquires, 1);
});

test("concurrent gets share one round trip", async () => {
  const { state, cache } = harness();
  cache.seed(tokenExpiringAt(1_700_003_600, "seed"));
  await cache.get(true);
  assert.equal(state.acquires, 1);

  /* The board fires several requests at once when it wakes up. */
  const [a, b, c] = await Promise.all([cache.get(true), cache.get(true), cache.get(true)]);
  assert.equal(state.acquires, 2);
  assert.equal(a, b);
  assert.equal(b, c);
});

test("a failed acquire propagates and does not wedge the cache", async () => {
  const state = { now: 1_700_000_000_000, fail: true, acquires: 0 };
  const cache = createTokenCache(
    async () => {
      state.acquires += 1;
      if (state.fail) throw new Error("consent required");
      return tokenExpiringAt(Math.floor(state.now / 1000) + 3600, "recovered");
    },
    () => state.now
  );
  cache.seed(tokenExpiringAt(1_700_000_000, "expired"));

  await assert.rejects(cache.get(), /consent required/);

  /* The in-flight guard must have cleared, or every later request hangs on a
     promise that already rejected. */
  state.fail = false;
  assert.ok(await cache.get());
  assert.equal(state.acquires, 2);
});
