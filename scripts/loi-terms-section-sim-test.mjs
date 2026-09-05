#!/usr/bin/env node
/* Issue #258 / ADR-0008 rules 1–3 — an LOI's terms are a field, not a message.
 *
 * The decision is about where one existing field is drawn. On an LOI the
 * `notes` field has always held the terms ("Loan Terms and Contacts"), always
 * required, always written by the creator at creation — which is exactly why
 * every existing LOI's first thread row is already its terms. Nothing is added
 * and nothing migrates. What changes is that the field now renders as its own
 * bordered section above the conversation, and stops being message number one.
 *
 * That is a promise about what a person sees, so this file reads rendered
 * markup rather than asking a predicate. `apps/web/src/thread.tsx` holds the
 * two components — lifted out of App.tsx for this reason, the same reason
 * `timeline.tsx` was — and they are compiled with esbuild and rendered through
 * `react-dom/server`, one assertion per acceptance criterion:
 *
 *   - the terms render in their own bordered section (LOI only),
 *   - they are not echoed as a message, and an LOI with no replies gets an
 *     empty-conversation state,
 *   - line breaks survive,
 *   - the other five types are untouched, field still first in the thread,
 *   - an existing LOI needs nothing but the field it already carries,
 *   - the unread signal still behaves now that the thread's first row is gone.
 *
 * The last one is the one ADR-0008's Consequences section flagged. It passes
 * for a reason worth stating: `unreadNoteFor` walks `reviewNotes` alone and
 * never looked at `notes`, so the originating field could never read as unread
 * at anybody, and taking it out of the thread changes nothing. Asserting it is
 * cheap; assuming it is how a flagged consequence goes unchecked.
 *
 * Two source checks at the end cover what rendering cannot: App.tsx draws these
 * components (so the thing under test is the thing a person sees), and it no
 * longer paints `task.notes` into the message list itself.
 *
 * Run: `node --test scripts/loi-terms-section-sim-test.mjs`. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { getNotesFieldLabel, TASK_TYPES } from "../packages/shared/dist/types.js";
import { hasUnreadNoteForViewer, standingTermsFor, unreadNoteFor } from "../packages/shared/dist/notes.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/* The components are TSX with a relative import, so esbuild bundles rather
   than transforms. The bundle lands inside the repo so its externals (react,
   @loan-tasks/shared) resolve the way they do everywhere else. */
const scratch = mkdtempSync(join(REPO, "node_modules", ".loi-terms-"));
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
const { TermsSection, ThreadMessages, threadHeadLabel } = await import(pathToFileURL(threadModule).href);

const CREATOR = { id: "creator-1", displayName: "Dana Requester" };
const ASSIGNEE = { id: "assignee-1", displayName: "Casey Checker" };
const OBSERVER = { id: "observer-1", displayName: "Sam Bystander" };

const T1 = "2026-08-20T10:00:00.000Z";
const T2 = "2026-08-20T11:00:00.000Z";

/* Multi-line, the way an officer types terms. Deliberately plain ASCII so the
   assertions are about line breaks and not about HTML escaping. */
const TERMS = "Loan Amount: $2,340,000\nRate: 9.75%\nBroker: Dana Whitfield";

const note = (by, at, text) => ({ by: { ...by }, at, text });

const task = (overrides = {}) => ({
  id: "task-1",
  folderName: "Folder 1",
  taskType: "LOI",
  dueAt: T2,
  urgency: "GREEN",
  points: 1,
  status: "CLAIMED",
  notes: TERMS,
  createdAt: T1,
  updatedAt: T2,
  createdBy: { ...CREATOR },
  assignee: { ...ASSIGNEE },
  reviewNotes: [],
  ...overrides
});

const section = (t) => renderToStaticMarkup(createElement(TermsSection, { task: t }));
const messages = (t, viewerId = ASSIGNEE.id, canReply = true) =>
  renderToStaticMarkup(createElement(ThreadMessages, { task: t, viewerId, canReply }));

const OTHER_TYPES = TASK_TYPES.filter((type) => type !== "LOI");

/* ── The terms get their own bordered section ─────────────── */

test("an LOI's terms render in their own bordered section", () => {
  const markup = section(task());
  assert.match(markup, /class="loi-terms"/, "the terms sit in the bordered .loi-terms panel");
  assert.match(markup, /class="loi-terms-body"/, "with the free text in its own body element");
  assert.ok(markup.includes(TERMS), "and the panel shows the terms the task carries");
  assert.ok(
    markup.includes(getNotesFieldLabel("LOI")),
    "headed by the field's own label, which came with it out of the thread"
  );
});

test("the other five types render no terms section at all", () => {
  for (const taskType of OTHER_TYPES) {
    assert.equal(
      section(task({ taskType })),
      "",
      `${taskType} keeps one blended field, so there is no section to draw`
    );
  }
});

test("the section is drawn from the field the task already carries", () => {
  /* No new field, no migration: everything the section needs is a taskType and
     the `notes` an existing LOI has had since the day it was created. */
  const existing = { taskType: "LOI", notes: TERMS };
  assert.equal(standingTermsFor(existing), TERMS);
  assert.ok(section(existing).includes(TERMS));
  for (const taskType of OTHER_TYPES) {
    assert.equal(standingTermsFor({ taskType, notes: "anything" }), undefined);
  }
});

/* ── Line breaks survive ──────────────────────────────────── */

test("line breaks in the terms are preserved", () => {
  const body = section(task()).split('class="loi-terms-body"')[1];
  assert.equal(
    (body.match(/\n/g) ?? []).length,
    2,
    "both typed newlines reach the markup rather than being collapsed or split into elements"
  );
  const css = readFileSync(join(REPO, "apps/web/src/styles.css"), "utf8");
  const rule = css.split(".loi-terms-body {")[1].split("}")[0];
  assert.match(rule, /white-space:\s*pre-wrap/, ".loi-terms-body renders those newlines as breaks");
});

/* ── The terms are not echoed as a message ────────────────── */

test("an LOI with no replies shows an empty conversation, not its terms", () => {
  const markup = messages(task());
  assert.match(markup, /class="msgs-empty"/, "the conversation says it is empty");
  assert.match(markup, /No messages yet/);
  assert.ok(!markup.includes(TERMS), "and the terms are nowhere in it");
  assert.ok(!markup.includes("msg-bubble"), "there is no message row at all");
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

test("an LOI's conversation is its replies and only its replies", () => {
  const markup = messages(task({ reviewNotes: [note(CREATOR, T2, "One reply")] }));
  assert.ok(markup.includes("One reply"), "the reply is there");
  assert.ok(!markup.includes(TERMS), "the terms are not repeated above it");
  assert.equal((markup.match(/class="msg[ "]/g) ?? []).length, 1, "exactly one row, the reply");
  assert.ok(!markup.includes("msgs-empty"), "and no empty state once something has been said");
});

test("the conversation heading stops naming the box next door", () => {
  assert.equal(threadHeadLabel(task()), "Conversation");
  for (const taskType of OTHER_TYPES) {
    assert.equal(
      threadHeadLabel(task({ taskType })),
      getNotesFieldLabel(taskType),
      `${taskType}'s thread still heads with its own field label`
    );
  }
});

/* ── The other five types are untouched ───────────────────── */

test("the other five types still open the thread with their request field", () => {
  for (const taskType of OTHER_TYPES) {
    const request = `What ${taskType} is asking`;
    const markup = messages(task({ taskType, notes: request, reviewNotes: [note(ASSIGNEE, T2, "A reply")] }));
    assert.ok(markup.includes(request), `${taskType} still shows its field in the thread`);
    assert.ok(
      markup.indexOf(request) < markup.indexOf("A reply"),
      `${taskType}'s field is still the first row, above the replies`
    );
    assert.ok(!markup.includes("msgs-empty"), `${taskType} never renders the empty state`);
    assert.equal(
      (markup.match(/class="msg[ "]/g) ?? []).length,
      2,
      `${taskType} renders the field row plus the reply`
    );
  }
});

test("a reply-less task of the other five types is not empty — it has the field", () => {
  for (const taskType of OTHER_TYPES) {
    const markup = messages(task({ taskType, notes: "The request" }));
    assert.ok(markup.includes("The request"));
    assert.ok(!markup.includes("msgs-empty"), `${taskType} has something in its thread by definition`);
  }
});

/* ── The unread signal, with the first row gone ───────────── */

test("terms alone never read as an unread message at either party", () => {
  const bare = task();
  for (const viewer of [CREATOR, ASSIGNEE]) {
    assert.equal(unreadNoteFor(bare, viewer, undefined), undefined, "terms are not a message from anyone");
    assert.equal(hasUnreadNoteForViewer(bare, viewer, undefined), false);
  }
});

test("a real reply still lights the signal on an LOI", () => {
  const replied = task({ reviewNotes: [note(CREATOR, T2, "Rate looks wrong")] });
  assert.equal(unreadNoteFor(replied, ASSIGNEE, undefined), T2, "the checker has something to read");
  assert.equal(unreadNoteFor(replied, CREATOR, undefined), undefined, "your own reply is not unread at you");
  assert.equal(unreadNoteFor(replied, OBSERVER, undefined), undefined, "and an Observer is still told nothing");
  assert.equal(unreadNoteFor(replied, ASSIGNEE, T2), undefined, "acknowledging clears it");
});

test("the split moved nothing: an LOI and a Value Check answer identically", () => {
  /* Same reviewNotes, different taskType. If the terms leaving the thread had
     reached the unread calculation at all, these two would disagree. */
  const replies = [note(CREATOR, T2, "Take a look")];
  for (const viewer of [CREATOR, ASSIGNEE, OBSERVER]) {
    for (const seen of [undefined, T1, T2]) {
      assert.equal(
        unreadNoteFor(task({ taskType: "LOI", reviewNotes: replies }), viewer, seen),
        unreadNoteFor(task({ taskType: "VALUE", reviewNotes: replies }), viewer, seen),
        `same answer for ${viewer.id} having seen ${seen}`
      );
    }
  }
});

/* ── The rendered components are the ones App.tsx draws ───── */

test("App.tsx draws these components and paints no notes row of its own", () => {
  const app = readFileSync(join(REPO, "apps/web/src/App.tsx"), "utf8");
  assert.match(app, /<TermsSection\b/, "the card renders the terms section");
  assert.match(app, /<ThreadMessages\b/, "and the message list under test");
  assert.ok(
    !/msg-bubble/.test(app),
    "App.tsx no longer builds message rows itself — a second copy could echo the terms again"
  );
});
