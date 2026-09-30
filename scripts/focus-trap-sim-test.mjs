#!/usr/bin/env node
/* The keyboard stays on whatever is open on top (#492), driven through the
   trap's own interface against a fake page: a board behind, a form over it,
   and a prompt over the form.

   Run: `node --test scripts/focus-trap-sim-test.mjs`. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createFocusTraps } from "../apps/web/src/focus-trap.ts";

/* ── A fake page ─────────────────────────────────────────── */

const page = () => {
  const nodes = new Map();
  let active = null;
  let traps;
  const node = (name, parent = null, tabbable = true) => {
    const n = { name, parent, tabbable, connected: true };
    nodes.set(name, n);
    return n;
  };
  const within = (container, n) => {
    for (let at = n; at !== null; at = at.parent) if (at === container) return true;
    return false;
  };
  const host = {
    activeElement: () => active,
    contains: within,
    isConnected: (n) => n.connected,
    tabbables: (container) => [...nodes.values()].filter((n) => n.tabbable && n.connected && n !== container && within(container, n)),
    focus: (n) => {
      active = n;
      traps.onFocusIn(n);
    }
  };
  traps = createFocusTraps(host);
  const root = node("root", null, false);
  return {
    traps,
    node: (name, parent = root, tabbable = true) => node(name, parent, tabbable),
    focus: (n) => host.focus(n),
    get active() {
      return active?.name ?? null;
    },
    /* Presses Tab and, when the trap doesn't take it, moves focus the way a
       browser would: to the next stop in page order, off the end to the top. */
    tab(shiftKey = false) {
      let prevented = false;
      traps.onKeyDown({ key: "Tab", shiftKey, preventDefault: () => (prevented = true) });
      if (prevented) return active.name;
      const order = [...nodes.values()];
      const isStop = (n) => n.tabbable && n.connected;
      const at = order.indexOf(active);
      const after = order.slice(at + 1).filter(isStop);
      const before = order.slice(0, Math.max(at, 0)).filter(isStop);
      const next = shiftKey ? (before.at(-1) ?? after.at(-1)) : (after[0] ?? before[0]);
      host.focus(next);
      return active.name;
    },
    unmount(container) {
      for (const n of nodes.values()) if (within(container, n)) n.connected = false;
    }
  };
};

/* The board, with New Task in its header, and a form with three stops. */
const boardWithForm = () => {
  const p = page();
  const newTask = p.node("new-task");
  p.node("card");
  p.node("card-menu");
  const form = p.node("form", undefined, false);
  p.node("loan", form);
  p.node("save", form);
  p.node("cancel", form);
  return { p, newTask, form };
};

const tabs = (p, count, shift = false) => Array.from({ length: count }, () => p.tab(shift));

/* ── Tab stays in the overlay ────────────────────────────── */

test("Tab past the form's last control comes back to its first, never onto the board", () => {
  const { p, newTask, form } = boardWithForm();
  p.focus(newTask);
  p.traps.open(form);
  assert.deepEqual(tabs(p, 7), ["loan", "save", "cancel", "loan", "save", "cancel", "loan"]);
});

test("Shift+Tab before the form's first control goes round to its last", () => {
  const { p, newTask, form } = boardWithForm();
  p.focus(newTask);
  p.traps.open(form);
  assert.deepEqual(tabs(p, 4, true), ["cancel", "save", "loan", "cancel"]);
});

test("focus that lands behind an open form is brought back into it", () => {
  const { p, newTask, form } = boardWithForm();
  p.focus(newTask);
  p.traps.open(form);
  p.focus(newTask);
  assert.equal(p.active, "loan");
});

test("an overlay with no controls holds focus on itself", () => {
  const p = page();
  const opener = p.node("opener");
  const empty = p.node("empty", undefined, false);
  p.focus(opener);
  p.traps.open(empty);
  assert.equal(p.tab(), "empty");
});

test("Shift+Tab from the form's own background goes to its last control, not the board", () => {
  const { p, newTask, form } = boardWithForm();
  p.focus(newTask);
  p.traps.open(form);
  p.focus(form);
  assert.equal(p.tab(true), "cancel");
});

/* ── A prompt over a form ────────────────────────────────── */

test("with a prompt over the form, Tab cycles the prompt and never reaches the form", () => {
  const { p, newTask, form } = boardWithForm();
  p.focus(newTask);
  p.traps.open(form);
  tabs(p, 3);
  const prompt = p.node("prompt", undefined, false);
  const keep = p.node("keep-editing", prompt);
  p.node("discard", prompt);
  p.traps.open(prompt);
  p.focus(keep);
  assert.deepEqual(tabs(p, 4), ["discard", "keep-editing", "discard", "keep-editing"]);
  assert.deepEqual(tabs(p, 3, true), ["discard", "keep-editing", "discard"]);
});

test("Keep editing puts focus back on the form control that raised the prompt", () => {
  const { p, newTask, form } = boardWithForm();
  p.focus(newTask);
  p.traps.open(form);
  tabs(p, 3);
  assert.equal(p.active, "cancel");
  const prompt = p.node("prompt", undefined, false);
  const keep = p.node("keep-editing", prompt);
  const closePrompt = p.traps.open(prompt);
  p.focus(keep);
  p.unmount(prompt);
  closePrompt();
  assert.equal(p.active, "cancel");
  assert.equal(p.tab(), "loan", "and the form's own trap is back in charge");
});

test("a prompt raised with nothing focused hands focus into the form when it closes", () => {
  const { p, newTask, form } = boardWithForm();
  p.focus(newTask);
  p.traps.open(form);
  const prompt = p.node("prompt", undefined, false);
  const keep = p.node("keep-editing", prompt);
  const closePrompt = p.traps.open(prompt);
  p.focus(keep);
  p.unmount(prompt);
  closePrompt();
  assert.equal(p.active, "loan");
});

/* ── Closing gives focus back ────────────────────────────── */

test("closing the form returns focus to New Task", () => {
  const { p, newTask, form } = boardWithForm();
  p.focus(newTask);
  const close = p.traps.open(form);
  p.tab();
  p.unmount(form);
  close();
  assert.equal(p.active, "new-task");
  assert.equal(p.tab(), "card", "and Tab walks the board again");
});

test("a form that focuses its own field before its trap opens still returns focus to what opened it", () => {
  const { p, newTask, form } = boardWithForm();
  p.focus(newTask);
  p.focus(p.node("notes", form));
  const close = p.traps.open(form);
  p.unmount(form);
  close();
  assert.equal(p.active, "new-task");
});

test("the form closing while its prompt is still up leaves nothing trapped", () => {
  const { p, newTask, form } = boardWithForm();
  p.focus(newTask);
  const closeForm = p.traps.open(form);
  const prompt = p.node("prompt", undefined, false);
  const closePrompt = p.traps.open(prompt);
  p.focus(p.node("discard", prompt));
  p.unmount(form);
  p.unmount(prompt);
  closeForm();
  closePrompt();
  assert.equal(p.active, "new-task");
  assert.equal(p.tab(), "card");
});

test("keys other than Tab pass straight through", () => {
  const { p, newTask, form } = boardWithForm();
  p.focus(newTask);
  p.traps.open(form);
  let prevented = false;
  p.traps.onKeyDown({ key: "Escape", shiftKey: false, preventDefault: () => (prevented = true) });
  assert.equal(prevented, false);
});

/* ── Every overlay holds a trap ──────────────────────────── */

const source = (file) => readFileSync(new URL(`../apps/web/src/${file}`, import.meta.url), "utf8");

for (const [file, cls] of [
  ["task-form.tsx", "form-overlay"],
  ["discard-confirm.tsx", "discard-confirm-panel"],
  ["loan-merge-confirm.tsx", "merge-confirm-panel"]
]) {
  test(`${file} traps the keyboard in its ${cls}`, () => {
    const src = source(file);
    const ref = src.match(/useFocusTrap\((\w+)\)/)?.[1];
    assert.ok(ref, "calls useFocusTrap");
    assert.match(src, new RegExp(`ref=\\{${ref}\\}\\s+tabIndex=\\{-1\\}\\s+className="${cls}"`));
  });
}

test("Edit Task hands focus to the row's menu button before the menu goes, so closing the form returns there", () => {
  assert.match(source("App.tsx"), /menuTriggerRef\.current\?\.focus\(\); closeMenu\(\); onEditTask\(task\.id\);/);
});
