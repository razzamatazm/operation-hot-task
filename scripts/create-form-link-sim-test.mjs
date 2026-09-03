#!/usr/bin/env node
/* A deep link that says "open the create form", and nothing else (issue #198).

   Pressing **Send to Hot Task** in Humperdink already puts the loan on the
   clipboard. What it could not do was take you anywhere: you switched to Teams
   yourself, found Hot Task, and opened New Task before you could paste. This is
   the link that closes that gap.

   The link carries **no data**. The payload is on the clipboard and stays
   there; all the URL has to say is "open the create form", which rides the same
   `context` JSON that already carries `subEntityId` to focus one task. So the
   two things under test here are:

   - `teamsTaskDeepLink` grew an opt-in `createForm` flag, and every existing
     caller's URL is byte-for-byte what it was.
   - `readCreateFormIntent` reads the flag back off whatever the Teams host
     hands the tab, in either of the two shapes hosts use.

   The intent is its own field beside `subEntityId`, never a sentinel value in
   it: every surface shares this builder, including the web app's "Copy link",
   and a link pasted into a chat must not open a create form for whoever clicks
   it. It also has to sit alongside the claim intent (#180) without either one
   knowing about the other.

   Pure value-in/value-out, so it runs under node's TS type stripping with no
   build. Run: `node --test scripts/create-form-link-sim-test.mjs`. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CREATE_FORM_INTENT_FIELD,
  HOT_TASK_ENTITY_ID,
  readCreateFormIntent,
  teamsTaskDeepLink
} from "../packages/shared/src/deep-link.ts";

const APP_ID = "6a1b2c3d-0000-4444-8888-abcdefabcdef";
const BASE = `https://teams.microsoft.com/l/entity/${APP_ID}/${HOT_TASK_ENTITY_ID}`;

/* The context JSON of a link, decoded. */
const contextOf = (url) => {
  const param = new URL(url).searchParams.get("context");
  return param === null ? null : JSON.parse(param);
};

/* ── Existing links must not move a byte ────────────────── */

test("a task link is unchanged — no new field, no reordering", () => {
  assert.equal(
    teamsTaskDeepLink(APP_ID, "task-1"),
    `${BASE}?context=${encodeURIComponent(JSON.stringify({ subEntityId: "task-1" }))}`
  );
});

test("a task link with a label and a web url is unchanged", () => {
  assert.equal(
    teamsTaskDeepLink(APP_ID, "task-1", { label: "Adams - Harbor", webUrl: "https://hot.example.com" }),
    `${BASE}?context=${encodeURIComponent(JSON.stringify({ subEntityId: "task-1" }))}` +
      `&label=${encodeURIComponent("Adams - Harbor")}` +
      `&webUrl=${encodeURIComponent("https://hot.example.com")}`
  );
});

test("the plain tab link is still the bare entity url", () => {
  assert.equal(teamsTaskDeepLink(APP_ID), BASE);
});

test("no app id still means no link, create form or not", () => {
  assert.equal(teamsTaskDeepLink(undefined, undefined, { createForm: true }), undefined);
  assert.equal(teamsTaskDeepLink("   ", undefined, { createForm: true }), undefined);
});

/* ── The create-form link ───────────────────────────────── */

test("the create-form link names no task and carries only the intent", () => {
  const url = teamsTaskDeepLink(APP_ID, undefined, { createForm: true });
  assert.equal(url, `${BASE}?context=${encodeURIComponent(JSON.stringify({ [CREATE_FORM_INTENT_FIELD]: true }))}`);
  assert.deepEqual(contextOf(url), { openCreateForm: true });
});

test("the intent is its own field, never a value smuggled into subEntityId", () => {
  const context = contextOf(teamsTaskDeepLink(APP_ID, undefined, { createForm: true }));
  assert.equal(context.subEntityId, undefined);
  assert.equal(CREATE_FORM_INTENT_FIELD, "openCreateForm");
});

test("the create-form link still takes a web url for someone with no Teams client", () => {
  const url = teamsTaskDeepLink(APP_ID, undefined, { createForm: true, webUrl: "https://hot.example.com" });
  assert.deepEqual(contextOf(url), { openCreateForm: true });
  assert.equal(new URL(url).searchParams.get("webUrl"), "https://hot.example.com");
});

/* Nobody builds this today — the create-form link names no task. It is here
   because the two intents are independent optional fields, and a builder that
   silently dropped one when asked for both would be a trap for the next
   caller. */
test("a task id and the create-form intent can ride together", () => {
  assert.deepEqual(contextOf(teamsTaskDeepLink(APP_ID, "task-1", { createForm: true })), {
    subEntityId: "task-1",
    openCreateForm: true
  });
});

/* ── Reading the intent back ────────────────────────────── */

test("the intent reads back off the v2 context shape", () => {
  assert.equal(readCreateFormIntent({ page: { openCreateForm: true } }), true);
});

test("the intent reads back off the flat v1 context shape", () => {
  assert.equal(readCreateFormIntent({ openCreateForm: true }), true);
});

test("every other route into Hot Task reads as no intent", () => {
  assert.equal(readCreateFormIntent({ page: { subPageId: "task-1" } }), false);
  assert.equal(readCreateFormIntent({ subEntityId: "task-1" }), false);
  assert.equal(readCreateFormIntent({ page: {} }), false);
  assert.equal(readCreateFormIntent({}), false);
  assert.equal(readCreateFormIntent(undefined), false);
  assert.equal(readCreateFormIntent(null), false);
  assert.equal(readCreateFormIntent("openCreateForm"), false);
});

/* A host that hands the flag through as a string, or a link somebody
   hand-edited, must not open the form. Only the boolean the builder writes
   counts — anything else is the safe default. */
test("only a real boolean true counts as the intent", () => {
  assert.equal(readCreateFormIntent({ page: { openCreateForm: "true" } }), false);
  assert.equal(readCreateFormIntent({ openCreateForm: 1 }), false);
  assert.equal(readCreateFormIntent({ openCreateForm: false }), false);
});

/* ── Cold tab or warm tab, one arrival ──────────────────── */

/* Hot Task does not opt into Teams tab caching (no `supportsCaching` in the
   manifest, no `app.notifySuccess`), so Teams loads the tab's content frame
   fresh for every deep link tap — whether or not the tab was already open. Both
   cases therefore arrive at the same place: the mount-time `app.getContext()`.
   These two assert that the reader gives the same answer for the context a
   cold boot sees and the one a re-delivery to an already-open tab would carry,
   so the app has one path to get right rather than two. */
test("the same context read twice gives the same answer", () => {
  const context = { page: { openCreateForm: true }, app: { theme: "dark" } };
  assert.equal(readCreateFormIntent(context), true);
  assert.equal(readCreateFormIntent(context), true);
});

test("a reload with no intent lands on the board, not the create form", () => {
  assert.equal(readCreateFormIntent({ app: { theme: "dark" } }), false);
});

/* ── Alongside the claim intent (#180), not instead of it ─ */

/* #180 puts `claimOnOpen` in this same context JSON. The two are independent
   optional fields: reading one must never be affected by the other, or the
   first link to carry both would misfire. */
test("a claim-intent link does not open the create form", () => {
  assert.equal(readCreateFormIntent({ page: { subPageId: "task-1", claimOnOpen: true } }), false);
});

test("a create-form link is not mistaken for a claim", () => {
  const context = contextOf(teamsTaskDeepLink(APP_ID, undefined, { createForm: true }));
  assert.equal(context.claimOnOpen, undefined);
});

test("both intents in one context read independently", () => {
  const context = { page: { subPageId: "task-1", claimOnOpen: true, openCreateForm: true } };
  assert.equal(readCreateFormIntent(context), true);
});
