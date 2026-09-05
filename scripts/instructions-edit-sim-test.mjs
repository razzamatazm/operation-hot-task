#!/usr/bin/env node
/* Holding the Instructions box edits it in place (#303, ADR-0010 rule 4),
 * and since #318 the hold opens the editor rather than a menu with `Edit` in
 * it — settled on the real card against three variants, branch
 * `prototype/instructions-edit-gesture`.
 *
 * The box borrows the message editor's gesture (#287, #288, #297) and
 * deliberately disagrees with it about what happens once open. This file is
 * about both halves of that, and it is split the way `message-edit-sim-test`
 * is: what a person sees is asserted against real rendered markup, and what
 * they are allowed to do is asserted against the real `TaskService` over a real
 * (temp-file) `TaskStore` — never against the menu merely being absent.
 *
 * What is under test:
 *
 *   - **The box answers a hold only where the shared rule admits it.** The
 *     creator on all five box types, both parties on an LOI, the assignee on
 *     none of the other four, an observer on none at all, and nobody on a
 *     completed, cancelled or archived task. Reopening gives it back. The same
 *     matrix is then driven through the service, so a box that answers no hold
 *     is a box the route would refuse anyway.
 *   - **No permission logic is written in the web app.** `thread.tsx` asks
 *     `canAmendTask` and nothing else — asserted as an absence, which is the
 *     only way an absence can be asserted.
 *   - **There is no menu at all**, and no `Edit` button on the box in any
 *     state. The hold is the door, the whole panel is its target, and the panel
 *     opens at the height it already had.
 *   - **Enter is a newline.** The editor's key handler takes Escape and nothing
 *     else, which is the whole of the divergence from the message editor's
 *     Enter-to-save.
 *   - **Committing is a button, and an emptied box is refused with the route's
 *     own sentence** — one sentence for one rule, now shared.
 *   - **Cancelling a changed draft asks.** `instructionsEditState` is the
 *     decision, as a function, because "one stray keystroke does not bin a
 *     half-rewritten brief" is the promise this ticket exists for.
 *   - **Both doors produce the same result**, including the history entry: the
 *     box's save is `amendApi.setNotes`, which is the call the edit form's save
 *     reaches through `saveTaskEdit`.
 *   - **A Fraud Check still has no box at all** (#300 unchanged), and a
 *     read-only render is the section exactly as it was.
 *
 * What this file cannot assert, and nothing in this repo's harness can: the
 * gesture actually firing. There is no DOM here — `react-dom/server` renders
 * markup and stops — so the hold timer, the swallowed click, the right-click
 * and the measured height are asserted as the source
 * they are built from, exactly as `message-edit-sim-test` asserts the same
 * gesture on the bubbles. Those four want a person.
 *
 * Run: `node --test scripts/instructions-edit-sim-test.mjs`. */
import assert from "node:assert/strict";
import { promises as fsp, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path, { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { emptyRequestFieldRefusal, getNotesFieldLabel, requestFieldNoun } from "../packages/shared/dist/types.js";
import { amendRefusal, canAmendTask } from "../packages/shared/dist/workflow.js";
import { TaskStore } from "../apps/server/dist/store.js";
import { SseHub } from "../apps/server/dist/sse.js";
import { TaskService } from "../apps/server/dist/task-service.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/* Same arrangement as every other web sim test here: the thread is TSX with a
   relative import, so esbuild bundles it into something node can load. */
const scratch = mkdtempSync(join(REPO, "node_modules", ".instructions-edit-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const threadModule = join(scratch, "thread.mjs");
await build({
  entryPoints: [join(REPO, "apps/web/src/thread.tsx")],
  outfile: threadModule,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  external: ["react", "react/jsx-runtime", "@loan-tasks/shared"],
  logLevel: "silent"
});
const { InstructionsSection, InstructionsEditor, instructionsEditState } = await import(
  pathToFileURL(threadModule).href
);

const THREAD_SRC = readFileSync(join(REPO, "apps/web/src/thread.tsx"), "utf8");
const APP_SRC = readFileSync(join(REPO, "apps/web/src/App.tsx"), "utf8");

/* One component's own source, bounded at the next one. Unbounded, the editor's
   slice runs on into `MessageRow`, whose Enter-to-save is the exact thing this
   file asserts the box does not do. */
const sourceBetween = (from, to) => THREAD_SRC.slice(THREAD_SRC.indexOf(from), THREAD_SRC.indexOf(to));
const editorSource = () => sourceBetween("export const InstructionsEditor", "/* The rows inside `.msgs`");
const boxSource = () => sourceBetween("const InstructionsBox", "instructionsEditState =");

/* The five types that draw a box, and the one that does not (ADR-0010 rule 1).
   LOI is listed apart because it is the one whose amend rule admits both
   parties, which is the whole reason this file walks the types rather than
   testing one. */
const CREATOR_ONLY_TYPES = ["VALUE", "LOAN_DOCS", "BUDDY_CHAT", "OOO"];
const BOX_TYPES = ["LOI", ...CREATOR_ONLY_TYPES];

const CREATOR = { id: "creator-1", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] };
const ASSIGNEE = { id: "checker-1", displayName: "Casey Checker", roles: ["LOAN_OFFICER", "FILE_CHECKER"] };
const OBSERVER = { id: "observer-1", displayName: "Sam Bystander", roles: ["LOAN_OFFICER"] };
const ADMIN = { id: "admin-1", displayName: "Alex Admin", roles: ["ADMIN"] };

const CONFIG = {
  businessTimezone: "America/Los_Angeles",
  businessStartHour: 8,
  businessStartMinute: 30,
  businessEndHour: 17,
  businessEndMinute: 30,
  archiveRetentionDays: 90
};

const INSTRUCTIONS = "Rate 6.25%\nPoints 1.5\nContact: Jo at the title co.";

/* A rendered task, shaped as narrowly as the section reads it. */
const taskFixture = ({ taskType = "VALUE", status = "CLAIMED", assignee = ASSIGNEE, notes = INSTRUCTIONS } = {}) => ({
  taskType,
  notes,
  status,
  createdBy: { id: CREATOR.id, displayName: CREATOR.displayName },
  ...(assignee ? { assignee: { id: assignee.id, displayName: assignee.displayName } } : {})
});

const renderBox = (task, viewerId, { savable = true } = {}) =>
  renderToStaticMarkup(
    createElement(InstructionsSection, {
      task,
      ...(viewerId ? { viewerId } : {}),
      ...(savable ? { onSave: async () => {} } : {})
    })
  );

/* The one hook a box wears when it answers a hold — there is no trigger
   element to find, exactly as on a bubble since #297. */
const answersHold = (markup) => markup.includes('data-holdable="true"');

const isoDay = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

const setup = async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "instructions-edit-sim-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.init();
  const events = [];
  const service = new TaskService(
    store,
    { notify: async (event) => { events.push(event); }, canReachDm: async () => true },
    new SseHub(),
    CONFIG
  );
  return { service, store, events };
};

const makeTask = async (service, { taskType = "VALUE", claimed = true, notes = INSTRUCTIONS } = {}) => {
  const oooDates = taskType === "OOO" ? { startDate: isoDay(1), returnDate: isoDay(3) } : {};
  const task = await service.createTask(
    { folderName: "Instructions Sim", taskType, notes, ...(taskType === "OOO" ? {} : { urgency: "GREEN" }), ...oooDates },
    CREATOR
  );
  if (claimed) await service.claimTask(task.id, ASSIGNEE);
  await service.settleBackgroundWork();
  return task.id;
};

const rejects = (fn, pattern, label) =>
  assert.rejects(fn, (error) => {
    assert.match(error.message, pattern, `${label}: the refusal names the rule (got "${error.message}")`);
    return true;
  }, label);

/* ── Who the box answers ──────────────────────────────────────────────────── */

test("the creator's hold is answered on every box type", () => {
  for (const taskType of BOX_TYPES) {
    const markup = renderBox(taskFixture({ taskType }), CREATOR.id);
    assert.ok(answersHold(markup), `${taskType}: the creator's box answers a hold`);
  }
});

test("both parties can hold an LOI's terms box", () => {
  const task = taskFixture({ taskType: "LOI" });
  assert.ok(answersHold(renderBox(task, CREATOR.id)), "the person who filed the LOI");
  assert.ok(answersHold(renderBox(task, ASSIGNEE.id)), "the checker holding it");
});

test("the assignee's hold is not answered on the four creator-only types", () => {
  for (const taskType of CREATOR_ONLY_TYPES) {
    const markup = renderBox(taskFixture({ taskType }), ASSIGNEE.id);
    assert.ok(!answersHold(markup), `${taskType}: the box does not respond to the assignee`);
    /* Not an error message, and not a disabled control: nothing at all. */
    assert.ok(!markup.includes("msg-menu-panel"), `${taskType}: and offers no menu`);
    assert.ok(markup.includes("loi-terms-body"), `${taskType}: it is still a box, it just does not answer`);
  }
});

test("an observer's hold is not answered on any type, and neither is an admin's", () => {
  for (const taskType of BOX_TYPES) {
    assert.ok(!answersHold(renderBox(taskFixture({ taskType }), OBSERVER.id)), `${taskType}: observer`);
    assert.ok(!answersHold(renderBox(taskFixture({ taskType }), ADMIN.id)), `${taskType}: admin`);
  }
});

test("no box answers a hold on a completed, cancelled or archived task, and reopening restores it", () => {
  for (const taskType of BOX_TYPES) {
    for (const status of ["COMPLETED", "CANCELLED", "ARCHIVED"]) {
      const markup = renderBox(taskFixture({ taskType, status }), CREATOR.id);
      assert.ok(!answersHold(markup), `${taskType} ${status}: frozen`);
    }
    /* Reopening is a status change and nothing else — the box asks the same
       question of the same rule and gets a different answer. */
    for (const status of ["OPEN", "CLAIMED"]) {
      assert.ok(answersHold(renderBox(taskFixture({ taskType, status }), CREATOR.id)), `${taskType} ${status}: back`);
    }
  }
});

test("a read-only render is the section exactly as it was", () => {
  const markup = renderBox(taskFixture(), CREATOR.id, { savable: false });
  assert.ok(!answersHold(markup), "no hold affordance without something to save to");
  assert.ok(markup.includes("loi-terms-body"), "still the box");
  assert.ok(markup.includes(INSTRUCTIONS.split("\n")[0]), "still the instructions");
});

test("a Fraud Check still draws no box at all", () => {
  assert.equal(renderBox(taskFixture({ taskType: "FRAUD" }), CREATOR.id), "");
});

test("the box keeps its heading and its text", () => {
  for (const taskType of BOX_TYPES) {
    const markup = renderBox(taskFixture({ taskType }), CREATOR.id);
    assert.ok(markup.includes(getNotesFieldLabel(taskType)), `${taskType}: heading`);
    assert.ok(markup.includes("Rate 6.25%"), `${taskType}: body`);
  }
});

/* ── The rule is asked, never restated ────────────────────────────────────── */

test("the box's gate is the shared rule and the markup agrees with it", () => {
  for (const taskType of BOX_TYPES) {
    for (const viewer of [CREATOR, ASSIGNEE, OBSERVER, ADMIN]) {
      for (const status of ["OPEN", "CLAIMED", "COMPLETED", "CANCELLED", "ARCHIVED"]) {
        const task = taskFixture({ taskType, status });
        assert.equal(
          answersHold(renderBox(task, viewer.id)),
          canAmendTask(task, { id: viewer.id }),
          `${taskType}/${viewer.id}/${status}: the box answers exactly when the shared rule says it may`
        );
      }
    }
  }
});

test("thread.tsx writes no permission logic of its own", () => {
  assert.ok(THREAD_SRC.includes("canAmendTask(task, { id: viewerId })"), "it asks the shared rule");
  /* The shapes a hand-rolled copy of the rule would take. None of them is here,
     and the reason this is asserted rather than trusted is that the copy is
     always one convenient line away. */
  for (const shape of [/createdBy\.id\s*===\s*viewerId/, /assignee\?\.id\s*===\s*viewerId/, /taskType\s*===\s*"LOI"/]) {
    assert.ok(!shape.test(THREAD_SRC), `no local rule of the shape ${shape}`);
  }
  /* And the closed-task freeze is not re-listed here either — it rides inside
     `canAmendTask`, which is why reopening restores the box for free. */
  assert.ok(!THREAD_SRC.includes("CLOSED_STATUSES"), "the freeze is not restated");
});

/* ── No menu ──────────────────────────────────────────────────────────────── */

test("the box carries no menu and no Edit button, in any state", () => {
  /* #303 put a one-entry menu behind the hold, matching the bubbles. A bubble's
     menu earns its place by carrying `Edit` and `Delete`; this one could never
     have a second entry, because instructions cannot be emptied. So it was a
     step that existed to be dismissed, and #318 took it out. */
  const box = boxSource();
  assert.ok(!box.includes('role="menu"'), "no menu panel");
  assert.ok(!box.includes('role="menuitem"'), "no menu entry");
  assert.ok(!box.includes("msg-menu-panel"), "not even the shell");
  assert.ok(!/>\s*Edit\s*</.test(box), "and no Edit button");
});

test("the hold opens the editor itself", () => {
  const box = boxSource();
  assert.ok(box.includes("onOpen: startEditing"), "the gesture's end is the editor");
  assert.ok(box.includes("setEditing(true)"), "which is what startEditing does");
});

test("opening the editor closes any open message menu", () => {
  /* What survives of "one menu at a time across the card": the box has none of
     its own now, but a bubble's menu standing open while the box turns into an
     editor is two things claiming the card at once. */
  const start = boxSource().indexOf("const startEditing");
  const fn = boxSource().slice(start, boxSource().indexOf("};", start));
  assert.ok(fn.includes("scope.setOpenId(null)"), "the shared slot is cleared");
});

test("the whole panel answers the hold, not the sentence inside it", () => {
  const box = boxSource();
  /* The heading strip and the panel's own padding are inside the bordered box.
     A target the size of the text is a target people miss — which is what the
     prototype was told, in those words. */
  const section = box.slice(box.indexOf("<section"), box.indexOf("loi-terms-head"));
  assert.ok(section.includes("{...holdProps}"), "the gesture is on the section");
  assert.ok(
    section.includes('data-holdable={editable && !editing ? "true" : undefined}'),
    "and so is the marker, which stands down with the gesture rather than lying while the editor is open"
  );
  const body = box.slice(box.indexOf('className="loi-terms-body"'));
  assert.ok(!body.includes("{...holdProps}"), "the text does not carry it separately");
});

test("the panel grows to fit the editor rather than the words shrinking", () => {
  /* Opened at a fixed row count, the editor makes a full box's text collapse to
     make room for Save and Cancel, which reads as the panel caving in under the
     press. Measured first, the words stay put. */
  const box = boxSource();
  assert.ok(box.includes("bodyRef.current?.getBoundingClientRect().height"), "the read view is measured");
  assert.ok(
    box.indexOf("setStartHeight") < box.indexOf("setEditing(true)"),
    "and measured before the editor replaces it"
  );
  assert.ok(
    editorSource().includes("height: `${Math.max(startHeight, MIN_EDITOR_HEIGHT_PX)}px`"),
    "the editor opens at it, floored"
  );
});

test("the editor opens focused, with the caret at the end of the words", () => {
  /* In front of them it reads as the box having moved rather than as an
     invitation to type — which is what driving the prototype said, in those
     words. Source-assertable like the rest of the gesture: there is no DOM. */
  const editor = editorSource();
  assert.ok(editor.includes("autoFocus"), "focused on open");
  assert.ok(
    editor.includes("field.setSelectionRange(field.value.length, field.value.length)"),
    "with the caret at the end"
  );
});

test("the opening height is corrected for the field's own chrome", () => {
  /* The field is border-box, so the read view's height handed over untouched
     spends the field's padding and border on chrome and shows less text than
     the box did a moment ago. Read off the element, not restated from the
     stylesheet. */
  const editor = editorSource();
  assert.ok(editor.includes("field.offsetHeight - field.clientHeight"), "border and scrollbar");
  assert.ok(editor.includes("paddingHeight(field)"), "and the padding");
});

test("the press is visible while it is in flight", () => {
  /* Half a second with no menu at the end of it is half a second of nothing. */
  assert.ok(boxSource().includes("onPressChange: setPressing"), "the box hears the press");
  assert.ok(boxSource().includes("loi-terms-held"), "and rings itself while it lasts");
});

/* ── The gesture, as far as source can carry it ───────────────────────────── */

test("the box and the bubbles hold through one gesture, not two alike", () => {
  /* The threshold, the pointer events that cancel a press, the right-click and
     the swallowed click are one implementation. Written out twice — as they
     were first drafted — "the same threshold" is a thing a test has to check;
     written once it is a thing that is true. */
  assert.equal((THREAD_SRC.match(/^const LONG_PRESS_MS = /gm) ?? []).length, 1, "one threshold in the file");
  assert.equal((THREAD_SRC.match(/}, LONG_PRESS_MS\);/g) ?? []).length, 1, "used in one place");
  assert.equal((THREAD_SRC.match(/useHoldMenu\(\{/g) ?? []).length, 2, "and both surfaces call it");
  assert.ok(boxSource().includes("{...holdProps}"), "the box wears the gesture");
  assert.ok(THREAD_SRC.slice(THREAD_SRC.indexOf("const MessageRow")).includes("{...holdProps}"), "so does a bubble");
});

test("right-click opens the editor immediately and suppresses the OS menu", () => {
  const hook = sourceBetween("const useHoldMenu", "/* Small neutral avatar");
  assert.match(hook, /onContextMenu: \(event[\s\S]*?event\.preventDefault\(\);[\s\S]*?onOpen\(\);/);
  assert.ok(boxSource().includes("onOpen: startEditing"), "and what opens is the editor");
});

test("the click a completed hold delivers is swallowed", () => {
  const hook = sourceBetween("const useHoldMenu", "/* Small neutral avatar");
  assert.match(hook, /heldOpen\.current = true;/, "a completed hold is remembered");
  assert.match(hook, /onClickCapture: \(event[\s\S]*?event\.preventDefault\(\);\s*event\.stopPropagation\(\);/);
});

test("a hold on the box stands down while its editor is open", () => {
  assert.ok(boxSource().includes("enabled: editable && !editing"), "the box is the editor then, not a thing to hold");
});

test("the editor's own Escape stops there rather than collapsing the card", () => {
  /* This travelled with the menu's dismissal test, which #318 deleted along
     with the menu. The rule did not go with it: every row of a card is an
     expand toggle, so an Escape that keeps bubbling closes the card out from
     under an open editor. */
  const editor = editorSource();
  const handler = editor.slice(editor.indexOf("onKeyDown"), editor.indexOf("}}", editor.indexOf("onKeyDown")));
  assert.ok(handler.includes('if (e.key !== "Escape") return;'), "Escape and nothing else");
  assert.ok(handler.includes("e.stopPropagation();"), "and it stops there");
});

test("no outside-press or Escape listener sits over the box at all", () => {
  const box = boxSource();
  /* Both existed to dismiss the menu. With no menu there is nothing for them to
     close, and the editor deliberately does not answer either: an outside press
     is the commonest stray gesture there is, and a half-rewritten brief does not
     go anywhere because somebody clicked the card next to it (ADR-0010 rule 4).
     The editor's own Escape is the textarea's, which has focus by then. */
  assert.ok(!box.includes('document.addEventListener("pointerdown"'), "no outside-press listener");
  assert.ok(!box.includes('document.addEventListener("keydown"'), "no document-level Escape");
});

test("one menu is open at a time across the card, and the box can only close it", () => {
  /* One variable, one level above both surfaces. The box no longer puts
     anything in it — a hold on the box is the editor — so its only interest is
     clearing whatever the thread left open. */
  assert.equal((THREAD_SRC.match(/= useCardMenuScope\(\);/g) ?? []).length, 2, "one hook, read by both surfaces");
  assert.ok(THREAD_SRC.includes("isMessageMenu(scope.openId)"), "the thread reads the shared slot");
  assert.ok(!THREAD_SRC.includes("INSTRUCTIONS_MENU_ID"), "and the box's id is gone with its menu");
  assert.ok(THREAD_SRC.includes("`msg:${id}`"), "the messages' ids stay namespaced");
  assert.ok(APP_SRC.includes("<CardMenuScopeProvider>"), "and one scope per expanded card");
});

/* ── The editor ───────────────────────────────────────────────────────────── */

test("Enter is a newline: the editor's key handler takes Escape and nothing else", () => {
  const editor = editorSource();
  assert.ok(editor.includes('if (e.key !== "Escape") return;'), "Escape and then nothing");
  assert.ok(!editor.includes('e.key === "Enter"'), "Enter is not intercepted");
  assert.ok(!editor.includes("e.preventDefault()"), "and nothing preventDefaults a keystroke in the box");
});

test("the editor opens preloaded with the current text, and commits on a button", () => {
  const markup = renderToStaticMarkup(
    createElement(InstructionsEditor, {
      taskType: "VALUE",
      instructions: INSTRUCTIONS,
      onSave: async () => {},
      onClose: () => {}
    })
  );
  assert.ok(markup.includes("<textarea"), "a field");
  assert.ok(markup.includes("Rate 6.25%"), "preloaded with the current text");
  assert.ok(markup.includes(">Save<"), "an explicit save");
  assert.ok(markup.includes(">Cancel<"), "and a cancel");
  assert.ok(!markup.includes(">Delete<"), "and no delete");
  /* Nothing has changed yet, so there is nothing to commit. */
  assert.ok(/<button[^>]*disabled[^>]*>Save</.test(markup), "save is inert until something changes");
});

test("an emptied box is refused, with the route's own sentence", () => {
  for (const taskType of BOX_TYPES) {
    const markup = renderToStaticMarkup(
      createElement(InstructionsEditor, {
        taskType,
        instructions: "",
        onSave: async () => {},
        onClose: () => {}
      })
    );
    const sentence = emptyRequestFieldRefusal(taskType);
    assert.ok(markup.includes(sentence), `${taskType}: says "${sentence}"`);
    assert.ok(/<button[^>]*disabled[^>]*>Save</.test(markup), `${taskType}: and will not commit it`);
  }
  /* One sentence for one rule: the box says what the route throws, from the one
     definition both import. */
  assert.equal(emptyRequestFieldRefusal("LOI"), "The terms cannot be emptied");
  assert.equal(emptyRequestFieldRefusal("VALUE"), "The notes cannot be emptied");
  assert.equal(emptyRequestFieldRefusal("VALUE"), `The ${requestFieldNoun("VALUE")} cannot be emptied`);
});

test("cancelling a changed draft asks, and an untouched one does not", () => {
  const original = INSTRUCTIONS;
  assert.equal(instructionsEditState(original, original, "VALUE").cancelAsks, false, "nothing typed, nothing to lose");
  assert.equal(instructionsEditState(`${original} and one more thing`, original, "VALUE").cancelAsks, true);
  /* Untrimmed on purpose: a lone added blank line is still somebody's change. */
  assert.equal(instructionsEditState(`${original}\n`, original, "VALUE").cancelAsks, true, "even a blank line");
  /* And the confirmation is a real second step rather than a differently
     worded first one: the safe answer is the one that keeps the typing, and it
     is the one that takes focus. */
  const editor = editorSource();
  assert.ok(editor.includes("if (cancelAsks) setConfirmingCancel(true);"), "Cancel asks first");
  assert.ok(editor.includes("Discard your changes?"), "and says what it is asking");
  assert.ok(editor.includes("Keep editing"), "with a way back");
  assert.ok(editor.includes("if (confirmingCancel) keepRef.current?.focus();"), "focus on the answer that keeps it");
  /* Escape at the confirmation declines rather than confirming — the key that
     raised the question must not also answer it. */
  assert.ok(editor.includes("if (confirmingCancel) setConfirmingCancel(false);"), "Escape declines");
});

test("the draft is measured against the box as it opened, not as it now is", () => {
  /* `instructions` is a live prop — the card refetches after any save, and on
     an LOI the other party can correct the box mid-rewrite. Measured against
     the moving value, a remote edit matching the draft would make `changed`
     false and let the next Escape bin the typing without asking. */
  const editor = editorSource();
  assert.ok(editor.includes("const openedWith = useRef(instructions).current;"), "pinned at open");
  assert.ok(
    editor.includes("instructionsEditState(draft, openedWith, taskType)"),
    "and it is the pinned value the guard reads"
  );
  assert.ok(!editor.includes("instructionsEditState(draft, instructions"), "never the live prop");
});

test("save is refused while nothing has changed or the box is empty", () => {
  const original = INSTRUCTIONS;
  assert.equal(instructionsEditState(original, original, "VALUE").canSave, false, "unchanged");
  assert.equal(instructionsEditState("   \n ", original, "VALUE").canSave, false, "whitespace only");
  assert.equal(instructionsEditState("", original, "VALUE").canSave, false, "empty");
  assert.equal(instructionsEditState("A real correction", original, "VALUE").canSave, true);
  assert.equal(instructionsEditState("A real correction", original, "VALUE").refusal, undefined);
});

/* ── The two doors ────────────────────────────────────────────────────────── */

test("the box's save is the same call the edit form's save makes", () => {
  /* Not a second route, and not a task-shaped patch: `amendApi.setNotes` is
     what `saveTaskEdit` reaches for the form's notes field, and it is what the
     box reaches too. That is what makes "the same result from either door" a
     structural fact rather than a coincidence to be re-tested. */
  assert.match(APP_SRC, /const onSaveInstructions = useCallback\([\s\S]*?await amendApi\.setNotes\(taskId, text\);/);
  const saveEdit = readFileSync(join(REPO, "apps/web/src/save-task-edit.ts"), "utf8");
  assert.ok(saveEdit.includes("await write.setNotes(task.id, edit.notes)"), "the form's door");
  assert.ok(APP_SRC.includes('setNotes: (taskId, notes) => amend(taskId, "notes", { notes }, "notes")'), "one route");
  /* And the field is still in the form — two doors, deliberately (ADR-0010
     rule 4), which is only true while the first one is still there. */
  assert.ok(APP_SRC.includes("canAmendTask(task, user)"), "`Edit Task` still gated on the same rule");
});

test("either door writes the same task and the same history entry", async () => {
  const { service } = await setup();
  const id = await makeTask(service, { taskType: "VALUE" });
  const updated = await service.updateTaskNotes(id, "  Check the 2019 comps too.  ", CREATOR);
  assert.equal(updated.notes, "Check the 2019 comps too.", "trimmed and saved");

  const history = await service.getHistory(id);
  const amended = history.filter((e) => e.action === "TASK_NOTES_AMENDED");
  assert.equal(amended.length, 1, "one history entry");
  assert.ok(amended[0].detail.includes(INSTRUCTIONS), "carrying the old wording");
  assert.ok(amended[0].detail.includes("Check the 2019 comps too."), "and the new");
});

/* ── The rule, enforced rather than merely hidden ─────────────────────────── */

test("the service refuses everyone the box refuses to answer", async () => {
  const { service } = await setup();
  for (const taskType of CREATOR_ONLY_TYPES) {
    const id = await makeTask(service, { taskType });
    await rejects(() => service.updateTaskNotes(id, "rewritten", ASSIGNEE), /Only the task creator/, `${taskType} assignee`);
    await rejects(() => service.updateTaskNotes(id, "rewritten", OBSERVER), /Only the task creator/, `${taskType} observer`);
    await rejects(() => service.updateTaskNotes(id, "rewritten", ADMIN), /Only the task creator/, `${taskType} admin`);
    const ok = await service.updateTaskNotes(id, "rewritten by the creator", CREATOR);
    assert.equal(ok.notes, "rewritten by the creator", `${taskType}: the creator may`);
  }
});

test("both parties may correct an LOI's terms, and nobody else", async () => {
  const { service } = await setup();
  const id = await makeTask(service, { taskType: "LOI" });
  const byChecker = await service.updateTaskNotes(id, "Rate 6.5%", ASSIGNEE);
  assert.equal(byChecker.notes, "Rate 6.5%", "the checker holding it");
  const byCreator = await service.updateTaskNotes(id, "Rate 6.75%", CREATOR);
  assert.equal(byCreator.notes, "Rate 6.75%", "and the person who filed it");
  await rejects(() => service.updateTaskNotes(id, "Rate 0%", OBSERVER), /Only the person who filed this LOI/, "observer");
});

test("a closed task refuses the write, and reopening restores it", async () => {
  const { service } = await setup();
  for (const status of ["COMPLETED", "CANCELLED", "ARCHIVED"]) {
    const id = await makeTask(service, { taskType: "VALUE" });
    if (status === "ARCHIVED") {
      await service.transitionStatus(id, "COMPLETED", ASSIGNEE);
      await service.transitionStatus(id, "ARCHIVED", CREATOR);
    } else {
      await service.transitionStatus(id, status, status === "COMPLETED" ? ASSIGNEE : CREATOR);
    }
    await rejects(() => service.updateTaskNotes(id, "late correction", CREATOR), /closed task/i, status);

    /* A cancelled task has no route back — it is refiled, not reopened — so the
       restoring half of the rule is asserted on the two statuses that reopen. */
    if (status === "CANCELLED") continue;
    await service.transitionStatus(id, "OPEN", CREATOR);
    const reopened = await service.updateTaskNotes(id, "a genuine late correction", CREATOR);
    assert.equal(reopened.notes, "a genuine late correction", `${status}: reopening restores it`);
    assert.ok(canAmendTask(reopened, { id: CREATOR.id }), `${status}: and the box answers again`);
  }
});

test("the route refuses an emptied box with the sentence the editor shows", async () => {
  const { service } = await setup();
  for (const taskType of ["LOI", "VALUE"]) {
    const id = await makeTask(service, { taskType });
    await rejects(
      () => service.updateTaskNotes(id, "   \n  ", CREATOR),
      new RegExp(emptyRequestFieldRefusal(taskType)),
      `${taskType}: emptied`
    );
  }
});

test("the shared rule is the same one on both sides of the wire", () => {
  /* `amendRefusal` is what the service asks and `canAmendTask` is the same
     question with the sentence dropped, which is what the box asks. Asserted
     because "the box asks the shared rule" is only worth anything while the two
     remain one rule. */
  const task = taskFixture({ taskType: "VALUE" });
  assert.equal(canAmendTask(task, { id: ASSIGNEE.id }), amendRefusal(task, { id: ASSIGNEE.id }, "notes") === undefined);
  assert.equal(canAmendTask(task, { id: CREATOR.id }), amendRefusal(task, { id: CREATOR.id }, "notes") === undefined);
});
