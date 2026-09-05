#!/usr/bin/env node
/* Issue #300 / ADR-0010 rule 1 — every task type but a Fraud Check draws its
 * request field as an Instructions box above the conversation.
 *
 * Grown out of `loi-terms-section-sim-test.mjs` (#258, ADR-0008 rules 1–3),
 * which made the same promise about one type. The decision is still about
 * where one existing field is drawn: `notes` has always held the requester's
 * ask on every type, always required, always written at creation — which is
 * why every existing task's first thread row is already that ask. Nothing is
 * added and nothing migrates. What changes is which types draw it as their own
 * bordered section rather than as message number one, and that answer moves
 * from *LOI only* to *anything but a Fraud Check*.
 *
 * A Fraud Check is the one type that does not move (ADR-0010 rule 1): its
 * standing ask is the outstanding-items list at the top of its card, and a
 * prose box above that list would ask a filer to say the same thing twice.
 *
 * That is a promise about what a person sees, so this file reads rendered
 * markup rather than asking a predicate. `apps/web/src/thread.tsx` holds the
 * two components — lifted out of App.tsx for this reason, the same reason
 * `timeline.tsx` was — and they are compiled with esbuild and rendered through
 * `react-dom/server`, one assertion per acceptance criterion:
 *
 *   - the field renders in its own bordered section on the five box types,
 *   - a Fraud Check draws no section and keeps its note as thread row one,
 *   - an LOI's heading, placement and body face are exactly as they were,
 *   - line breaks survive and the box caps its height and scrolls,
 *   - the five open on an empty conversation and say so,
 *   - the field is never an unread message and never a counted reply, on any
 *     type, and the bot's reply cards quote replies alone,
 *   - the box/thread question is answered in one place, no longer named terms,
 *   - an existing task needs nothing but the field it already carries.
 *
 * The blast-radius half is the point of this ticket rather than a follow-up
 * (ADR-0010 Consequences): ADR-0008 flagged "anything assuming the thread's
 * first row is the originating note" on one type, and it is now five. The
 * unread walk passes for a reason worth stating — `unreadNoteFor` walks
 * `reviewNotes` alone and never looked at `notes`, so the originating field
 * could never read as unread at anybody. Reply counts and the bot's reply
 * cards are asserted here for the same reason: cheap to check, and assuming is
 * how a flagged consequence goes unchecked.
 *
 * Two source checks at the end cover what rendering cannot: App.tsx draws these
 * components (so the thing under test is the thing a person sees), and it no
 * longer paints `task.notes` into the message list itself.
 *
 * Run: `node --test scripts/instructions-box-sim-test.mjs`. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { getNotesFieldLabel, TASK_TYPES } from "../packages/shared/dist/types.js";
import { hasUnreadNoteForViewer, standingInstructionsFor, unreadNoteFor } from "../packages/shared/dist/notes.js";
import { recentNoteThread } from "../apps/server/dist/bot.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/* The components are TSX with a relative import, so esbuild bundles rather
   than transforms. The bundle lands inside the repo so its externals (react,
   @loan-tasks/shared) resolve the way they do everywhere else. */
const scratch = mkdtempSync(join(REPO, "node_modules", ".instructions-box-"));
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
const { InstructionsSection, ThreadMessages, threadHeadLabel } = await import(pathToFileURL(threadModule).href);

const CREATOR = { id: "creator-1", displayName: "Dana Requester" };
const ASSIGNEE = { id: "assignee-1", displayName: "Casey Checker" };
const OBSERVER = { id: "observer-1", displayName: "Sam Bystander" };

const T1 = "2026-08-20T10:00:00.000Z";
const T2 = "2026-08-20T11:00:00.000Z";
const T3 = "2026-08-20T12:00:00.000Z";

/* Multi-line, the way an officer types a brief. Deliberately plain ASCII so the
   assertions are about line breaks and not about HTML escaping. */
const INSTRUCTIONS = "Loan Amount: $2,340,000\nRate: 9.75%\nBroker: Dana Whitfield";

const note = (by, at, text) => ({ by: { ...by }, at, text });

const task = (overrides = {}) => ({
  id: "task-1",
  folderName: "Folder 1",
  taskType: "LOI",
  dueAt: T2,
  urgency: "GREEN",
  points: 1,
  status: "CLAIMED",
  notes: INSTRUCTIONS,
  createdAt: T1,
  updatedAt: T2,
  createdBy: { ...CREATOR },
  assignee: { ...ASSIGNEE },
  reviewNotes: [],
  ...overrides
});

const section = (t) => renderToStaticMarkup(createElement(InstructionsSection, { task: t }));
const messages = (t, viewerId = ASSIGNEE.id, canReply = true) =>
  renderToStaticMarkup(createElement(ThreadMessages, { task: t, viewerId, canReply }));

/* The split ADR-0010 rule 1 draws, and the only list in this file that has to
   be maintained by hand: five types carry a box, one keeps its note in the
   thread. Derived from `TASK_TYPES` so a seventh type shows up here as a
   failure rather than as silence. */
const BOX_TYPES = TASK_TYPES.filter((type) => type !== "FRAUD");
assert.deepEqual(BOX_TYPES, ["LOI", "BUDDY_CHAT", "VALUE", "LOAN_DOCS", "OOO"]);

const CSS = readFileSync(join(REPO, "apps/web/src/styles.css"), "utf8");
const cssRule = (selector) => CSS.split(`${selector} {`)[1].split("}")[0];

/* ── The five box types draw a bordered section ───────────── */

test("five of the six types render their instructions in their own bordered section", () => {
  for (const taskType of BOX_TYPES) {
    const markup = section(task({ taskType }));
    assert.match(markup, /class="loi-terms"/, `${taskType}'s instructions sit in the bordered panel`);
    assert.match(markup, /class="loi-terms-body"/, `${taskType} puts the free text in its own body element`);
    assert.ok(markup.includes(INSTRUCTIONS), `${taskType}'s panel shows the field the task carries`);
    assert.ok(
      markup.includes(getNotesFieldLabel(taskType)),
      `${taskType}'s box is headed by the field's own label, which came with it out of the thread`
    );
  }
});

test("a Fraud Check renders no box at all", () => {
  /* ADR-0010 rule 1: the outstanding-items list already sits where the box
     would go, so there is no section to draw. */
  assert.equal(section(task({ taskType: "FRAUD" })), "");
});

test("an LOI's box is exactly the one ADR-0008 built", () => {
  const markup = section(task());
  assert.ok(markup.includes("Loan Terms and Contacts"), "same heading");
  assert.match(markup, /^<section class="loi-terms">/, "same bordered section, same class");
  assert.ok(markup.includes(INSTRUCTIONS), "same free text, unparsed");
});

test("the section is drawn from the field the task already carries", () => {
  /* No new field, no migration: everything the section needs is a taskType and
     the `notes` an existing task has had since the day it was created. */
  for (const taskType of BOX_TYPES) {
    const existing = { taskType, notes: INSTRUCTIONS };
    assert.equal(standingInstructionsFor(existing), INSTRUCTIONS);
    assert.ok(section(existing).includes(INSTRUCTIONS), `${taskType} renders from the bare stored task`);
  }
  assert.equal(standingInstructionsFor({ taskType: "FRAUD", notes: "anything" }), undefined);
});

/* ── The box's face: line breaks, cap, body font ──────────── */

test("line breaks in the box are preserved on every type that has one", () => {
  for (const taskType of BOX_TYPES) {
    const body = section(task({ taskType })).split('class="loi-terms-body"')[1];
    assert.equal(
      (body.match(/\n/g) ?? []).length,
      2,
      `${taskType}'s typed newlines reach the markup rather than being collapsed or split into elements`
    );
  }
  assert.match(cssRule(".loi-terms-body"), /white-space:\s*pre-wrap/, ".loi-terms-body renders those newlines as breaks");
});

test("the box caps its height and scrolls inside itself", () => {
  const rule = cssRule(".loi-terms-body");
  assert.match(rule, /max-height:\s*\d+px/, "a long brief cannot push the conversation off the card");
  assert.match(rule, /overflow-y:\s*auto/, "it scrolls within the box instead");
});

test("the four new boxes render in the body face, not the fixed-width one", () => {
  /* The mono exception is the LOI's *term sheet input* and nothing else
     (`apps/web/CLAUDE.md`): tabular matter whose columns only line up in a
     fixed-width font. The card's box has always been body-face for everybody,
     and widening it to five types must not drag the exception along. */
  assert.ok(
    !/font-family/.test(cssRule(".loi-terms-body")),
    ".loi-terms-body sets no face of its own, so it inherits the body font"
  );
  const form = readFileSync(join(REPO, "apps/web/src/task-form.tsx"), "utf8");
  assert.match(
    form,
    /taskType === "LOI" \? "task-form-terms task-form-terms-mono"/,
    "and the one mono surface is still gated on LOI alone"
  );
});

/* ── The field is not echoed as a message ─────────────────── */

test("a task with no replies shows an empty conversation on all five box types", () => {
  for (const taskType of BOX_TYPES) {
    const markup = messages(task({ taskType }));
    assert.match(markup, /class="msgs-empty"/, `${taskType}'s conversation says it is empty`);
    assert.match(markup, /No messages yet/);
    assert.ok(!markup.includes(INSTRUCTIONS), `${taskType}'s instructions are nowhere in it`);
    assert.ok(!markup.includes("msg-bubble"), `${taskType} has no message row at all`);
  }
});

test("the empty state only invites a reply from someone who has a reply box", () => {
  assert.match(messages(task(), ASSIGNEE.id, true), /start the conversation below/);
  const noComposer = messages(task(), OBSERVER.id, false);
  assert.match(noComposer, /No messages yet/, "an Observer is still told the conversation is empty");
  assert.ok(
    !noComposer.includes("start the conversation"),
    "but not pointed at a composer that is not there"
  );
});

test("a box type's conversation is its replies and only its replies", () => {
  for (const taskType of BOX_TYPES) {
    const markup = messages(task({ taskType, reviewNotes: [note(CREATOR, T2, "One reply")] }));
    assert.ok(markup.includes("One reply"), `${taskType} shows the reply`);
    assert.ok(!markup.includes(INSTRUCTIONS), `${taskType} does not repeat its instructions above it`);
    assert.equal((markup.match(/class="msg[ "]/g) ?? []).length, 1, `${taskType} renders exactly one row`);
    assert.ok(!markup.includes("msgs-empty"), `${taskType} drops the empty state once something has been said`);
  }
});

test("the conversation heading stops naming the box next door", () => {
  for (const taskType of BOX_TYPES) {
    assert.equal(threadHeadLabel(task({ taskType })), "Conversation");
  }
  assert.equal(
    threadHeadLabel(task({ taskType: "FRAUD" })),
    getNotesFieldLabel("FRAUD"),
    "a Fraud Check's thread still heads with its own field label"
  );
});

/* ── A Fraud Check is untouched ───────────────────────────── */

test("a Fraud Check still opens its thread with its request field", () => {
  const request = "Check the appraisal date";
  const markup = messages(
    task({ taskType: "FRAUD", notes: request, reviewNotes: [note(ASSIGNEE, T2, "A reply")] })
  );
  assert.ok(markup.includes(request), "the field is still in the thread");
  assert.ok(markup.indexOf(request) < markup.indexOf("A reply"), "and is still the first row, above the replies");
  assert.ok(!markup.includes("msgs-empty"), "so the empty state never renders");
  assert.equal((markup.match(/class="msg[ "]/g) ?? []).length, 2, "the field row plus the reply");
});

test("a reply-less Fraud Check is not empty — it has the field", () => {
  const markup = messages(task({ taskType: "FRAUD", notes: "The request" }));
  assert.ok(markup.includes("The request"));
  assert.ok(!markup.includes("msgs-empty"), "it has something in its thread by definition");
});

/* ── Blast radius: unread, reply counts, reply cards ──────── */

test("the instructions field never counts as an unread message on any type", () => {
  for (const taskType of TASK_TYPES) {
    const bare = task({ taskType });
    for (const viewer of [CREATOR, ASSIGNEE]) {
      assert.equal(
        unreadNoteFor(bare, viewer, undefined),
        undefined,
        `${taskType}'s instructions are not a message from anyone`
      );
      assert.equal(hasUnreadNoteForViewer(bare, viewer, undefined), false);
    }
  }
});

test("a real reply still lights the signal on every type", () => {
  for (const taskType of TASK_TYPES) {
    const replied = task({ taskType, reviewNotes: [note(CREATOR, T2, "Rate looks wrong")] });
    assert.equal(unreadNoteFor(replied, ASSIGNEE, undefined), T2, `${taskType}'s checker has something to read`);
    assert.equal(unreadNoteFor(replied, CREATOR, undefined), undefined, "your own reply is not unread at you");
    assert.equal(unreadNoteFor(replied, OBSERVER, undefined), undefined, "and an Observer is still told nothing");
    assert.equal(unreadNoteFor(replied, ASSIGNEE, T2), undefined, "acknowledging clears it");
  }
});

test("the split moved nothing: every type answers the unread question identically", () => {
  /* Same reviewNotes, different taskType. If the field leaving the thread had
     reached the unread calculation at all, these would disagree. */
  const replies = [note(CREATOR, T2, "Take a look")];
  for (const taskType of TASK_TYPES) {
    for (const viewer of [CREATOR, ASSIGNEE, OBSERVER]) {
      for (const seen of [undefined, T1, T2]) {
        assert.equal(
          unreadNoteFor(task({ taskType, reviewNotes: replies }), viewer, seen),
          unreadNoteFor(task({ taskType: "FRAUD", reviewNotes: replies }), viewer, seen),
          `${taskType} and FRAUD agree for ${viewer.id} having seen ${seen}`
        );
      }
    }
  }
});

test("reply counts are the replies, with the field out of the thread", () => {
  /* The collapsed row counts `task.reviewNotes`, and so does the thread it
     opens onto. On the five box types those two are now the same number as the
     rows a person sees; on a Fraud Check the thread draws one row more, and
     that row is the field rather than a reply. */
  const replies = [note(CREATOR, T2, "First"), note(ASSIGNEE, T3, "Second")];
  for (const count of [0, 1, 2]) {
    const reviewNotes = replies.slice(0, count);
    for (const taskType of BOX_TYPES) {
      const rows = (messages(task({ taskType, reviewNotes })).match(/class="msg[ "]/g) ?? []).length;
      assert.equal(rows, count, `${taskType} draws one row per reply and nothing else`);
    }
    const fraudRows = (
      messages(task({ taskType: "FRAUD", reviewNotes })).match(/class="msg[ "]/g) ?? []
    ).length;
    assert.equal(fraudRows, count + 1, "a Fraud Check draws its field row on top of its replies");
  }

  const app = readFileSync(join(REPO, "apps/web/src/App.tsx"), "utf8");
  assert.match(
    app,
    /task\.reviewNotes\?\.length \?\? 0/,
    "and the card counts the stored replies rather than deriving a count from the thread's rows"
  );
});

test("the bot's reply cards quote replies alone on every type", () => {
  /* `recentNoteThread` is the window every card-sending path shares. It has
     always walked `reviewNotes`, so the field has never been on the wire as a
     thread member — which is why widening the box changes nothing here, and
     why that is asserted rather than assumed. */
  for (const taskType of TASK_TYPES) {
    assert.deepEqual(recentNoteThread(task({ taskType })), [], `${taskType} with no replies quotes nothing`);
    const quoted = recentNoteThread(
      task({ taskType, reviewNotes: [note(CREATOR, T2, "First"), note(ASSIGNEE, T3, "Second")] })
    );
    assert.deepEqual(
      quoted,
      [
        { author: CREATOR.displayName, text: "First" },
        { author: ASSIGNEE.displayName, text: "Second" }
      ],
      `${taskType}'s card quotes the replies in order and never the instructions`
    );
  }
});

/* ── One place answers the box/thread question ────────────── */

test("the box/thread question is answered once, and no longer under the name terms", () => {
  const sources = {
    "packages/shared/src/notes.ts": readFileSync(join(REPO, "packages/shared/src/notes.ts"), "utf8"),
    "apps/web/src/thread.tsx": readFileSync(join(REPO, "apps/web/src/thread.tsx"), "utf8"),
    "apps/web/src/App.tsx": readFileSync(join(REPO, "apps/web/src/App.tsx"), "utf8")
  };
  for (const [path, source] of Object.entries(sources)) {
    assert.ok(!source.includes("standingTermsFor"), `${path} no longer names the rule after terms`);
  }
  /* The rule itself — which types keep the field in the thread — is a task-type
     test, and it belongs to `standingInstructionsFor` alone. A renderer that
     grew its own would be the two halves disagreeing, which is the whole reason
     this is one function. */
  assert.equal(
    (sources["packages/shared/src/notes.ts"].match(/taskType !== "FRAUD"/g) ?? []).length,
    1,
    "notes.ts states the rule exactly once"
  );
  assert.ok(
    !/taskType !== "FRAUD"|taskType === "FRAUD"/.test(sources["apps/web/src/thread.tsx"]),
    "and the thread restates none of it — it reads the answer"
  );
  for (const path of ["apps/web/src/thread.tsx", "apps/web/src/App.tsx"]) {
    assert.match(sources[path], /standingInstructionsFor/, `${path} asks the one function`);
  }
});

/* ── The rendered components are the ones App.tsx draws ───── */

test("App.tsx draws these components and paints no notes row of its own", () => {
  const app = readFileSync(join(REPO, "apps/web/src/App.tsx"), "utf8");
  assert.match(app, /<InstructionsSection\b/, "the card renders the instructions section");
  assert.match(app, /<ThreadMessages\b/, "and the message list under test");
  assert.ok(
    !/msg-bubble/.test(app),
    "App.tsx no longer builds message rows itself — a second copy could echo the field again"
  );
});
