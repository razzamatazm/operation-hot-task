#!/usr/bin/env node
/*
 * Portaled panels stay on the screen (#231's visual pass, over #113/#122).
 *
 * A panel anchored to a row near the bottom of a long list ran off the bottom
 * of the viewport. The arithmetic was right whenever it was handed the panel's
 * real height; the failure was that a not-yet-measured panel reports a height
 * of ZERO, and a zero-height panel "fits" below every anchor. So it always
 * chose downward, and then clamped against a height of nothing — which is to
 * say, not at all. The panel was then laid out downward from a top chosen as
 * if it took no space.
 *
 * That is a pure function over a rect and a viewport, so it is tested as one
 * (the pattern `expand-state.ts` and `toast-store.ts` already set: the web
 * app's framework-free logic lives in its own module precisely so node can
 * drive it without a browser).
 *
 * The property that matters is not "does it flip up" — that is a means. It is
 * that the box it returns is inside the viewport, for every anchor position,
 * every panel height, and both alignments. So that is what is asserted, over a
 * sweep, rather than a handful of hand-picked cases.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PANEL_GAP, PANEL_MARGIN, maxPanelHeight, placePanel } from "../apps/web/src/panel-placement.ts";

const VIEWPORT = { width: 1280, height: 800 };

const anchorAt = (top, height = 30, left = 1100, width = 116) => ({
  top,
  bottom: top + height,
  left,
  right: left + width
});

/* The one rule, stated once: whatever comes back must sit inside the viewport
   with its margin intact, given the height the panel will actually draw. */
const assertOnScreen = (box, height, viewport, what) => {
  const drawn = Math.min(Math.max(height, 0), maxPanelHeight(viewport));
  assert.ok(box.top >= PANEL_MARGIN, `${what}: top ${box.top} is above the margin`);
  assert.ok(box.left >= PANEL_MARGIN, `${what}: left ${box.left} is left of the margin`);
  assert.ok(
    box.top + drawn <= viewport.height - PANEL_MARGIN + 0.001,
    `${what}: bottom ${box.top + drawn} runs past the viewport (${viewport.height})`
  );
};

test("every anchor and every height lands a panel fully on screen", () => {
  for (let top = 0; top <= VIEWPORT.height; top += 10) {
    for (const height of [0, 40, 110, 260, 500, 780, 900, 2000]) {
      for (const align of ["left", "right"]) {
        const anchor = anchorAt(top);
        const box = placePanel(anchor, 232, height, align, VIEWPORT);
        assertOnScreen(box, height, VIEWPORT, `anchor top ${top}, height ${height}, align ${align}`);
      }
    }
  }
});

test("a row near the bottom opens upward rather than off the edge", () => {
  // The Checked panel's note stage, on the last row of a full list.
  const anchor = anchorAt(VIEWPORT.height - 60);
  const box = placePanel(anchor, 232, 260, "right", VIEWPORT);
  assert.ok(box.top + 260 <= VIEWPORT.height - PANEL_MARGIN, "stays on screen");
  assert.ok(box.top < anchor.top, "and sits above the trigger, not below it");
});

test("a row near the top still opens downward", () => {
  const anchor = anchorAt(40);
  const box = placePanel(anchor, 232, 260, "right", VIEWPORT);
  assert.equal(box.top, anchor.bottom + PANEL_GAP, "hangs off the bottom of the trigger");
});

test("an unmeasured panel does not claim it fits below", () => {
  /* The regression, at the anchor that exposes it. A height of 0 satisfies
     `roomBelow >= height` wherever there is ANY room below, so an unmeasured
     panel used to commit to opening downward — and then clamp against a height
     of nothing, i.e. not at all. Here there are 156px below and 586px above:
     plenty of room below for a panel of no height, nowhere near enough for the
     260px it is about to become. With nothing to measure, the honest answer is
     whichever side has more room. */
  const lowRow = anchorAt(600);
  const unmeasured = placePanel(lowRow, 232, 0, "right", VIEWPORT);
  assert.ok(unmeasured.top <= lowRow.top, "opens upward when below is the tighter side");

  const nearTop = anchorAt(30);
  assert.equal(
    placePanel(nearTop, 232, 0, "right", VIEWPORT).top,
    nearTop.bottom + PANEL_GAP,
    "and still downward from a top row, where below is the roomier side"
  );
});

test("the measure-then-replace sequence lands on screen", () => {
  /* What actually happens in the browser: the panel is placed once before it
     can be measured (height 0), then re-placed when the ResizeObserver reports
     its real box. The second placement is the one that has to be right, and it
     has to be right from wherever the first one put it. */
  for (let top = 0; top <= VIEWPORT.height; top += 10) {
    for (const height of [110, 260, 420]) {
      const anchor = anchorAt(top);
      placePanel(anchor, 232, 0, "right", VIEWPORT);
      const settled = placePanel(anchor, 232, height, "right", VIEWPORT);
      assertOnScreen(settled, height, VIEWPORT, `anchor top ${top}, settles at height ${height}`);
    }
  }
});

test("a panel taller than the viewport is capped rather than overflowing", () => {
  const short = { width: 1280, height: 300 };
  const box = placePanel(anchorAt(150), 232, 900, "right", short);
  assert.equal(maxPanelHeight(short), 300 - PANEL_MARGIN * 2, "the cap is the viewport less both margins");
  assertOnScreen(box, 900, short, "oversized panel in a short viewport");
});

test("both alignments stay inside the left and right edges", () => {
  // Right-aligned against a trigger at the far right — the quick-action slot.
  const farRight = anchorAt(300, 30, VIEWPORT.width - 130, 116);
  const right = placePanel(farRight, 232, 110, "right", VIEWPORT);
  assert.ok(right.left + 232 <= VIEWPORT.width - PANEL_MARGIN, "right-aligned panel clears the right edge");

  // Left-aligned against a trigger at the far left.
  const farLeft = anchorAt(300, 30, 2, 116);
  const left = placePanel(farLeft, 232, 110, "left", VIEWPORT);
  assert.ok(left.left >= PANEL_MARGIN, "left-aligned panel clears the left edge");
});

test("a viewport narrower than the panel still returns a placed box", () => {
  const narrow = { width: 200, height: 800 };
  const box = placePanel(anchorAt(300, 30, 10, 116), 232, 110, "right", narrow);
  assert.equal(box.left, PANEL_MARGIN, "pinned to the margin rather than pushed off-screen");
});
