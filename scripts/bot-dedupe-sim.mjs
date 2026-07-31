#!/usr/bin/env node
/*
 * Unit checks for the DM/channel reference dedup helpers used by the proactive
 * send fan-out (apps/server/src/bot.ts). Regression coverage for #40, where a
 * user holding two "DM" references for the same 1:1 conversation (one keyed by
 * teamsId, one by aadObjectId — different keys, same conversation.id) received
 * the "Done and dusted" completion DM twice.
 *
 * Runs against the compiled dist, mirroring scheduler-sim-test.mjs.
 */
import assert from "node:assert/strict";

import { dedupeDmRefs } from "../apps/server/dist/bot.js";

const ref = (conversationId) => ({
  reference: conversationId === undefined ? {} : { conversation: { id: conversationId } }
});

const dmRef = (key, conversationId, userId, userAadObjectId) => ({
  key,
  scope: "DM",
  userId,
  userAadObjectId,
  reference: { conversation: { id: conversationId } }
});

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
};

check("collapses two references sharing one conversation id to a single entry", () => {
  /* The #40 shape: same 1:1 chat captured before and after Teams populated
     aadObjectId — two stored keys, one conversation. */
  const refs = [
    dmRef("dm:teams-123", "a:conv-1", "teams-123", undefined),
    dmRef("dm:aad-999", "a:conv-1", "teams-123", "aad-999")
  ];
  const result = dedupeDmRefs(refs);
  assert.equal(result.length, 1, "expected one reference per conversation");
});

check("keeps distinct conversations (creator + assignee) intact", () => {
  const refs = [dmRef("dm:aad-1", "a:conv-1", "u1", "aad-1"), dmRef("dm:aad-2", "a:conv-2", "u2", "aad-2")];
  const result = dedupeDmRefs(refs);
  assert.equal(result.length, 2, "distinct conversations must each survive");
  const ids = result.map((r) => r.reference.conversation?.id).sort();
  assert.deepEqual(ids, ["a:conv-1", "a:conv-2"]);
});

check("a single reference is passed through unchanged", () => {
  const refs = [dmRef("dm:aad-1", "a:conv-1", "u1", "aad-1")];
  assert.equal(dedupeDmRefs(refs).length, 1);
});

check("drops references with no conversation id", () => {
  const refs = [{ key: "dm:x", scope: "DM", ...ref(undefined) }, dmRef("dm:aad-1", "a:conv-1", "u1", "aad-1")];
  const result = dedupeDmRefs(refs);
  assert.equal(result.length, 1);
  assert.equal(result[0].reference.conversation?.id, "a:conv-1");
});

check("empty input yields empty output", () => {
  assert.deepEqual(dedupeDmRefs([]), []);
});

console.log(`\nAll ${passed} bot dedup checks passed.`);
