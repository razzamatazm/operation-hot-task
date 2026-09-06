#!/usr/bin/env node
/* The app runs in the Teams mobile webview, where the browser's zoom gestures
   have no reset control — a stray pinch strands the user in a magnified corner.
   Zoom is suppressed in three places, because no single one covers every
   gesture, and this test holds all three at once: the viewport meta
   (Android/Chromium), the `touch-action` and field-size rules in the
   stylesheet, and the pinch guard in apps/web/src/zoom-guard.ts (iOS, which
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

import { installZoomGuard, isMultiTouch } from "../apps/web/src/zoom-guard.ts";

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
  // narrow enough to take both gestures away. This rule is also what takes
  // double-tap on iOS, which is why the JS guard doesn't.
  assert.match(block[1], /touch-action:\s*pan-x pan-y/);
  assert.match(block[1], /text-size-adjust:\s*100%/);
});

test("the hold-to-edit gestures still narrow touch-action to pan-y", () => {
  // touch-action intersects down the ancestor chain rather than being
  // overridden, so these only keep working while `pan-y` stays a subset of the
  // base rule above. If someone narrows the base, this is the pair that breaks.
  const css = read("apps/web/src/styles.css");
  for (const sel of [".loi-terms.loi-terms-holdable", ".msg-bubble-holdable"]) {
    const at = css.indexOf(sel);
    assert.notEqual(at, -1, `no rule for ${sel}`);
    const body = css.slice(at, css.indexOf("}", at));
    assert.match(body, /touch-action:\s*pan-y/, `${sel} lost its pan-y`);
  }
});

const COARSE = /@media \(pointer: coarse\) \{([\s\S]*?)\n\}/;

test("fields reach 16px on a touch device, so iOS doesn't zoom on focus", () => {
  const css = read("apps/web/src/styles.css");
  const query = css.match(COARSE);
  assert.ok(query, "no coarse-pointer block in styles.css");
  assert.match(query[1], /input, select, textarea/);
  assert.match(query[1], /font-size:\s*16px !important/);
});

test("no control rule can outrank the 16px floor", () => {
  /* The floor is a bare element selector, which loses to every class-scoped
     field in the app — that is the whole reason it carries `!important`, and
     the only thing that can beat it now is another `!important`. This is the
     test that would have caught the first version of the fix, where
     `.composer textarea` at 0.85rem quietly kept the focus zoom. */
  const css = read("apps/web/src/styles.css");
  const coarse = css.match(COARSE)[0];
  const rest = css.replace(coarse, "");
  const offenders = [];
  // Walk every rule outside the coarse block; flag any that both targets a
  // form control and forces a font-size.
  for (const [, selector, body] of rest.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/\b(input|select|textarea)\b/.test(selector)) continue;
    if (/font-size:[^;]*!important/.test(body)) {
      offenders.push(selector.trim().replace(/\s+/g, " "));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these outrank the touch-device 16px floor and will re-introduce the ` +
      `iOS focus zoom: ${offenders.join(", ")}`
  );
});

test("the entry point installs the guard", () => {
  const main = read("apps/web/src/main.tsx");
  assert.match(main, /installZoomGuard\(document\)/);
});

/* ── Layer 3: the pinch guard ─────────────────────────────── */

test("isMultiTouch fires from the second finger on", () => {
  assert.equal(isMultiTouch(0), false);
  assert.equal(isMultiTouch(1), false);
  assert.equal(isMultiTouch(2), true);
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

test("the guard never touches touchend, so it cannot swallow a tap", () => {
  /* Cancelling a touchend cancels the synthesized click and focus after it.
     A JS double-tap blocker lived here briefly and did exactly that: the
     second of two quick taps — two checks down a checklist, or a tap into a
     field beside the control just pressed — lost its press. Double-tap zoom is
     the stylesheet's job, and the stylesheet takes it without touching the
     click. Don't add a touchend handler back. */
  const target = fakeTarget();
  installZoomGuard(target);
  assert.equal(target.handlers.has("touchend"), false);
  assert.equal(target.handlers.has("touchstart"), false);
  assert.equal(target.handlers.has("click"), false);
});

test("uninstalling takes every listener back off", () => {
  const target = fakeTarget();
  const uninstall = installZoomGuard(target);
  assert.ok(target.handlers.size > 0);
  uninstall();
  assert.equal(target.handlers.size, 0);
});
