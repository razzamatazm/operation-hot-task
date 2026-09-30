#!/usr/bin/env node
/* Where keyboard focus lands after a confirmed Complete / Approve / End /
   Cancel moves a task (#506). The card that was answered is thrown away when
   its task changes section, so the board remembers where the task stood and,
   once the action settles, picks the target from the board as it is now.
   Run: `node --test scripts/move-focus-sim-test.mjs`. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { focusTargetAfterMove, placeOf } from "../apps/web/src/move-focus.ts";

const board = (sections) => Object.entries(sections).map(([key, ids]) => ({ key, ids }));

test("a task still on the board keeps focus on its own card, wherever it moved", () => {
  const before = board({ you: ["a", "b"], them: ["c"], done: ["z"] });
  const place = placeOf(before, "b");
  const after = board({ you: ["a"], them: ["c"], done: ["b", "z"] });
  assert.deepEqual(focusTargetAfterMove(place, after), { kind: "card", taskId: "b" });
});

test("a failed action leaves the task where it was, and focus goes back to its card", () => {
  const before = board({ you: ["a", "b"] });
  assert.deepEqual(focusTargetAfterMove(placeOf(before, "b"), before), { kind: "card", taskId: "b" });
});

test("a task that left the view hands focus to the card now in its old slot", () => {
  const before = board({ you: ["a", "b", "c"], done: ["z"] });
  const after = board({ you: ["a", "c"], done: ["z"] });
  assert.deepEqual(focusTargetAfterMove(placeOf(before, "b"), after), { kind: "card", taskId: "c" });
});

test("the last card in a section that left the view hands focus to the card above it", () => {
  const before = board({ you: ["a", "b"] });
  const after = board({ you: ["a"] });
  assert.deepEqual(focusTargetAfterMove(placeOf(before, "b"), after), { kind: "card", taskId: "a" });
});

test("a section emptied by the move hands focus to the heading of the section below it", () => {
  const before = board({ you: ["b"], pool: ["p"], done: ["z"] });
  const after = board({ pool: ["p"], done: ["z"] });
  assert.deepEqual(focusTargetAfterMove(placeOf(before, "b"), after), { kind: "section", key: "pool" });
});

test("an emptied last section hands focus to the nearest heading above it", () => {
  const before = board({ you: ["a"], done: ["b"] });
  const after = board({ you: ["a"] });
  assert.deepEqual(focusTargetAfterMove(placeOf(before, "b"), after), { kind: "section", key: "you" });
});

test("an emptied board hands focus to the board itself, never the top of the page", () => {
  const before = board({ you: ["b"] });
  assert.deepEqual(focusTargetAfterMove(placeOf(before, "b"), []), { kind: "board" });
});

test("a task the board never showed gives no place to come back to", () => {
  assert.equal(placeOf(board({ you: ["a"] }), "missing"), null);
});

/* The wiring the pure rule can't see: the two confirm answers hand the board
   a keyboard Yes, by the same detail-0 test #504 uses, and the board's
   headings and panel can take focus. Loose on purpose; it pins the seam, not
   the formatting. */
test("the confirms hand keyboard Yes presses to the board", () => {
  const app = readFileSync(new URL("../apps/web/src/App.tsx", import.meta.url), "utf8");
  const yesCalls = app.match(/if \(e\.detail === 0\) onFollowFocus\?\.\(task\.id/g) ?? [];
  assert.equal(yesCalls.length, 2, "both Yes, cancel and the terminal Yes report a keyboard press");
  assert.match(app, /onFollowFocus: followTaskFocus/, "the board passes its follower to every card");
  assert.match(app, /data-court-heading/, "court headings are addressable focus targets");
});
