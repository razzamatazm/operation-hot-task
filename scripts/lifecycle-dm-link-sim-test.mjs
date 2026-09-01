#!/usr/bin/env node
/*
 * Issue #174 — plain lifecycle DMs had no way back to the task.
 *
 * The fix is one composition step, `formatLifecycleDmText` in
 * `packages/shared/src/types.ts`, which every plain-`DM` notification goes
 * through. These checks pin the two message shapes (folder named inline vs.
 * folder appended parenthetically), the no-app-id fallback (the common case
 * locally, where the message must send byte-for-byte as it did before), and
 * that the URL is the same one every other surface uses.
 *
 * Runs against the compiled dist, mirroring bot-dedupe-sim.mjs.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { formatLifecycleDmText, teamsTaskDeepLink } from "../packages/shared/dist/index.js";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const TASK_ID = "task-abc";
const FOLDER = "2021 Broadway RWC LLC - Adams";

const link = (folder = FOLDER) => teamsTaskDeepLink(APP_ID, TASK_ID, { label: folder });

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
};

check("links the folder where the message already names it", () => {
  const url = link();
  const text = formatLifecycleDmText({
    typeLabel: "LOI Check",
    message: `Suzie claimed ${FOLDER}`,
    folderName: FOLDER,
    url
  });
  assert.equal(text, `LOI Check - Suzie claimed [${FOLDER}](${url})`);
});

check("links the appended folder where the message doesn't name it", () => {
  const url = link();
  const text = formatLifecycleDmText({
    typeLabel: "LOI Check",
    message: "Done and dusted 🎉",
    folderName: FOLDER,
    url
  });
  assert.equal(text, `LOI Check - Done and dusted 🎉 ([${FOLDER}](${url}))`);
});

check("links only the first occurrence of the folder", () => {
  const url = link();
  const text = formatLifecycleDmText({
    typeLabel: "Loan Docs",
    message: `${FOLDER} passed ${FOLDER}`,
    folderName: FOLDER,
    url
  });
  assert.equal(text, `Loan Docs - [${FOLDER}](${url}) passed ${FOLDER}`);
});

check("without an app id the text is exactly what it was before the link", () => {
  const url = teamsTaskDeepLink(undefined, TASK_ID, { label: FOLDER });
  assert.equal(url, undefined);
  assert.equal(
    formatLifecycleDmText({ typeLabel: "LOI Check", message: `Suzie claimed ${FOLDER}`, folderName: FOLDER, url }),
    `LOI Check - Suzie claimed ${FOLDER}`
  );
  assert.equal(
    formatLifecycleDmText({ typeLabel: "LOI Check", message: "Done and dusted 🎉", folderName: FOLDER, url }),
    `LOI Check - Done and dusted 🎉 (${FOLDER})`
  );
});

check("no folder name means no anchor, and no dangling parentheses", () => {
  const url = link("");
  assert.equal(
    formatLifecycleDmText({ typeLabel: "Out of Office", message: "Auto-completed while you were out", folderName: "", url }),
    "Out of Office - Auto-completed while you were out"
  );
  assert.equal(
    formatLifecycleDmText({ typeLabel: "Out of Office", message: "Auto-completed while you were out", url }),
    "Out of Office - Auto-completed while you were out"
  );
});

check("a folder name carrying square brackets is left unlinked rather than emitting broken Markdown", () => {
  const folder = "Smith [rush]";
  const url = link(folder);
  assert.equal(
    formatLifecycleDmText({ typeLabel: "Loan Docs", message: "Merge done — almost home", folderName: folder, url }),
    `Loan Docs - Merge done — almost home (${folder})`
  );
});

check("an unbalanced parenthesis in the folder name can't end the link destination early", () => {
  /* CommonMark counts parens in a link destination, and the folder name rides
     the URL as `label=` — which encodeURIComponent leaves parens in. Escaped,
     the destination holds none to miscount. */
  const folder = "Smith (rush";
  const url = link(folder);
  assert.ok(url.includes("("), "the raw deep link really does carry the paren");
  // Folder named inline, so the only parens in play are the link's own.
  const text = formatLifecycleDmText({ typeLabel: "Loan Docs", message: `${folder} is merged`, folderName: folder, url });
  const href = /\]\((?<url>\S+)\) /u.exec(text)?.groups?.url;
  assert.ok(href, "the link is still parseable as a Markdown link");
  assert.ok(!href.includes("(") && !href.includes(")"), "no bare parens survive in the destination");
  assert.equal(decodeURIComponent(href), decodeURIComponent(url), "and it still points where the builder said");
});

check("a folder name's stray whitespace is left exactly as it was", () => {
  // The pre-link text used the folder raw; trimming here would silently
  // reword the message.
  const folder = "  Adams  ";
  assert.equal(
    formatLifecycleDmText({ typeLabel: "LOI Check", message: "Done and dusted 🎉", folderName: folder }),
    `LOI Check - Done and dusted 🎉 (${folder})`
  );
});

check("the link is the shared builder's task link, focused on the task", () => {
  const url = link();
  const text = formatLifecycleDmText({ typeLabel: "LOI Check", message: "Got the green light", folderName: FOLDER, url });
  const href = /\]\((?<url>[^)]+)\)/u.exec(text)?.groups?.url;
  assert.equal(href, teamsTaskDeepLink(APP_ID, TASK_ID, { label: FOLDER }));
  assert.ok(href.includes(encodeURIComponent(JSON.stringify({ subEntityId: TASK_ID }))));
});

/* The checks above pin the composition rule; these two pin that the notifier's
   plain-`DM` branch actually goes through it — the AC is about what the eight
   lifecycle events send, not about a pure function nobody calls. Each runs in
   its own process because `config` reads TEAMS_APP_ID once, at import. */
const dmTextFrom = async (env) => {
  const source = `
    const { TeamsNotificationProvider } = await import("${new URL("../apps/server/dist/notifications.js", import.meta.url).href}");
    const sent = [];
    const provider = new TeamsNotificationProvider(
      { sendToDmUsers: async (ids, text) => sent.push(text), sendToDms: async (text) => sent.push(text) },
      { isEnabled: () => false, sendToUsers: async () => {} },
      { getNotificationChannelId: async () => undefined },
      async (id) => ({ id, displayName: "", roles: [] })
    );
    await provider.notify({
      type: "TASK_STATUS_CHANGED",
      task: { id: "task-abc", folderName: ${JSON.stringify(FOLDER)}, taskType: "LOI", points: 0, urgency: "RED", status: "COMPLETED", createdBy: { id: "c", displayName: "Dana" } },
      actor: { id: "s", displayName: "System" },
      message: "Done and dusted 🎉",
      target: "DM",
      recipientUserIds: ["creator-1"]
    });
    process.stdout.write(JSON.stringify(sent));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", source], {
    env: { ...process.env, ...env }
  });
  return JSON.parse(stdout);
};

const withAppId = await dmTextFrom({ TEAMS_APP_ID: APP_ID, APP_BASE_URL: "" });
check("the completion DM the notifier actually sends carries the link", () => {
  assert.deepEqual(withAppId, [`LOI Check - Done and dusted 🎉 ([${FOLDER}](${link()}))`]);
});

const withoutAppId = await dmTextFrom({ TEAMS_APP_ID: "", APP_BASE_URL: "" });
check("and with no app id configured it sends the pre-link text unchanged", () => {
  assert.deepEqual(withoutAppId, [`LOI Check - Done and dusted 🎉 (${FOLDER})`]);
});

console.log(`\n${passed} checks passed`);
