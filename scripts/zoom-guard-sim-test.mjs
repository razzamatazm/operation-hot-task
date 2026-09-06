#!/usr/bin/env node
/* The app runs in the Teams mobile webview, where the browser's zoom gestures
   have no reset control — a stray pinch or double-tap strands the user in a
   magnified corner. Zoom is suppressed in three places, because no single one
   covers both platforms, and this test holds all three at once: the viewport
   meta (Android/Chromium), the `touch-action` and field-size rules in the
   stylesheet, and the gesture guard in apps/web/src/zoom-guard.ts (iOS, which
   ignores the other two).

   The decision logic in zoom-guard.ts is framework-free, so it runs here under
   node's TS type stripping, same arrangement as toast-store.ts. What no node
   test can reach is the webview itself; the static halves below are the seam
   that stops the three layers being silently dropped one at a time.
   Run: `node --test scripts/zoom-guard-sim-test.mjs`. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  DOUBLE_TAP_MS,
  DOUBLE_TAP_SLOP_PX,
  createTapTracker,
  installZoomGuard,
  isDoubleTap,
  isMultiTouch
} from "../apps/web/src/zoom-guard.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

/* ── Layer 1: the viewport meta ───────────────────────────── */

test("the viewport meta pins the scale and refuses user scaling", () => {
  const html = read("apps/web/index.html");
  const meta = html.match(/<meta\s[^>]*name="viewport"[^>]*>/s);
  assert.ok(meta, "index.html has no viewport meta at all");
  const content = meta[0].match(/content="([^"]+)"/s)[1].replace(/\s+/g, " ");
  assert.match(content, /width=device-width/);
  assert.match(content, /initial-scale=1(\.0)?/);
  assert.match(content, /maximum-scale=1(\.0)?/);
  assert.match(content, /user-scalable=no/);
});

/* ── Layer 2: the stylesheet ──────────────────────────────── */

test("html and body allow panning but not pinch- or double-tap-zoom", () => {
  const css = read("apps/web/src/styles.css");
  const block = css.match(/\bhtml,\s*body\s*\{([^}]*)\}/);
  assert.ok(block, "no `html, body` rule in styles.css");
  // `manipulation` would still permit pinch; only an explicit pan list is
  // narrow enough to take both gestures away.
  assert.match(block[1], /touch-action:\s*pan-x pan-y/);
  assert.match(block[1], /text-size-adjust:\s*100%/);
});

test("fields reach 16px on a touch device, so iOS doesn't zoom on focus", () => {
  const css = read("apps/web/src/styles.css");
  const query = css.match(/@media \(pointer: coarse\) \{([\s\S]*?)\n\}/);
  assert.ok(query, "no coarse-pointer block in styles.css");
  assert.match(query[1], /input, select, textarea/);
  assert.match(query[1], /font-size:\s*16px/);
});

test("the entry point installs the guard", () => {
  const main = read("apps/web/src/main.tsx");
  assert.match(main, /installZoomGuard\(document\)/);
});

/* ── Layer 3: the gesture guard ───────────────────────────── */

test("a lone tap is never a double-tap", () => {
  assert.equal(isDoubleTap(null, { x: 10, y: 10, t: 0 }), false);
});

test("two fast taps in the same spot are a double-tap", () => {
  const first = { x: 100, y: 100, t: 1000 };
  assert.equal(isDoubleTap(first, { x: 102, y: 98, t: 1120 }), true);
});

test("two taps outside the time window are two taps", () => {
  const first = { x: 100, y: 100, t: 1000 };
  assert.equal(
    isDoubleTap(first, { x: 100, y: 100, t: 1000 + DOUBLE_TAP_MS + 1 }),
    false
  );
});

test("two taps on different controls are two taps, however fast", () => {
  const first = { x: 100, y: 100, t: 1000 };
  assert.equal(
    isDoubleTap(first, { x: 100 + DOUBLE_TAP_SLOP_PX + 1, y: 100, t: 1010 }),
    false
  );
});

test("isMultiTouch fires from the second finger on", () => {
  assert.equal(isMultiTouch(0), false);
  assert.equal(isMultiTouch(1), false);
  assert.equal(isMultiTouch(2), true);
});

test("the tracker suppresses the second tap of a pair, not the first", () => {
  const tracker = createTapTracker();
  assert.equal(tracker.tap({ x: 50, y: 50, t: 0 }), false);
  assert.equal(tracker.tap({ x: 50, y: 50, t: 100 }), true);
});

test("a third fast tap starts a fresh pair rather than suppressing again", () => {
  // Otherwise a rapid run of taps on one control would be dead after the
  // first two, which is a worse bug than the zoom.
  const tracker = createTapTracker();
  tracker.tap({ x: 50, y: 50, t: 0 });
  tracker.tap({ x: 50, y: 50, t: 100 });
  assert.equal(tracker.tap({ x: 50, y: 50, t: 200 }), false);
});

/* A stand-in for `document` that records what was registered and lets a test
   fire an event at it. */
function fakeTarget() {
  const handlers = new Map();
  return {
    handlers,
    addEventListener(type, fn) {
      handlers.set(type, fn);
    },
    removeEventListener(type) {
      handlers.delete(type);
    },
    fire(type, event) {
      const e = { cancelable: true, prevented: false, ...event };
      e.preventDefault = () => {
        e.prevented = true;
      };
      handlers.get(type)?.(e);
      return e.prevented;
    }
  };
}

test("installZoomGuard blocks the iOS pinch gesture events", () => {
  const target = fakeTarget();
  installZoomGuard(target);
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    assert.equal(target.fire(type, {}), true, `${type} was not prevented`);
  }
});

test("a two-finger touchmove is blocked; a one-finger scroll is not", () => {
  const target = fakeTarget();
  installZoomGuard(target);
  assert.equal(target.fire("touchmove", { touches: { length: 2 } }), true);
  assert.equal(target.fire("touchmove", { touches: { length: 1 } }), false);
});

test("the second touchend of a double-tap is blocked, the first is not", () => {
  const target = fakeTarget();
  installZoomGuard(target);
  const tap = (t) =>
    target.fire("touchend", {
      timeStamp: t,
      changedTouches: [{ clientX: 200, clientY: 300 }]
    });
  assert.equal(tap(0), false);
  assert.equal(tap(150), true);
});

test("taps far apart in time both go through", () => {
  const target = fakeTarget();
  installZoomGuard(target);
  const tap = (t) =>
    target.fire("touchend", {
      timeStamp: t,
      changedTouches: [{ clientX: 200, clientY: 300 }]
    });
  assert.equal(tap(0), false);
  assert.equal(tap(5000), false);
});

test("uninstalling takes every listener back off", () => {
  const target = fakeTarget();
  const uninstall = installZoomGuard(target);
  assert.ok(target.handlers.size > 0);
  uninstall();
  assert.equal(target.handlers.size, 0);
});
