/* Metrics and Admin move off the app bar and into the app menu (#438).
 *
 * Production has no app bar at all: no Tasks / Metrics / Admin tab row, no
 * signed-in name. An admin's app menu ends with an Admin section holding
 * Metrics and Admin side by side; a non-admin's menu is unchanged. Metrics and
 * Admin each open under a Back to Tasks link and carry no other header
 * controls. The dev build keeps its user picker, since that is the only way to
 * switch people locally, and the guard that sends a non-admin back to Tasks
 * stays.
 *
 * The section and the link are drawn for real from `app-pages.tsx`; how App
 * wires them is read off its source, as the board's other sims do. */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const APP_SOURCE = readFileSync(join(REPO, "apps/web/src/App.tsx"), "utf8");

const scratch = mkdtempSync(join(REPO, "node_modules", ".app-menu-pages-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const entry = join(scratch, "entry.tsx");
writeFileSync(entry, `export { AdminMenuSection, BackToTasks } from ${JSON.stringify(join(REPO, "apps/web/src/app-pages.tsx"))};\n`);
const bundle = join(scratch, "app-pages.mjs");
await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  external: ["react", "react/jsx-runtime"],
  logLevel: "silent"
});
const { AdminMenuSection, BackToTasks } = await import(pathToFileURL(bundle).href);

/* Every button in a rendered element tree, in order, so a press can be sent. */
const buttons = (node) => {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (typeof node.type === "function") return buttons(node.type(node.props));
  const own = node.type === "button" ? [node] : [];
  return [...own, ...buttons(node.props?.children)];
};
const text = (node) =>
  node == null || typeof node === "boolean" ? "" : typeof node !== "object" ? String(node) : Array.isArray(node) ? node.map(text).join("") : text(node.props?.children);

const menuSource = () => APP_SOURCE.slice(APP_SOURCE.indexOf("const AppMenu = ("), APP_SOURCE.indexOf("const NewTaskButton = ("));
const block = (start, end) => {
  const from = APP_SOURCE.indexOf(start);
  assert.ok(from >= 0, `${start} is in App`);
  const to = end ? APP_SOURCE.indexOf(end, from + start.length) : -1;
  return APP_SOURCE.slice(from, to > from ? to : undefined);
};

/* ── The menu's Admin section ─────────────────────────────── */

test("the Admin section is a labelled group with Metrics then Admin, dressed like Collapse All Tasks", () => {
  const html = renderToStaticMarkup(createElement(AdminMenuSection, { onOpenPage: () => {} }));
  assert.match(html, /^<div class="app-menu-group app-menu-admin" role="group" aria-label="Admin"><span class="app-menu-label">Admin<\/span>/);
  assert.match(
    html,
    /<div class="app-menu-admin-row"><button type="button" role="menuitem" class="app-menu-action">Metrics<\/button><button type="button" role="menuitem" class="app-menu-action">Admin<\/button><\/div>/,
    "one row, side by side, in the button dress the menu's one action already wears"
  );
});

test("pressing Metrics or Admin asks for that page", () => {
  const asked = [];
  const [metrics, admin] = buttons(AdminMenuSection({ onOpenPage: (page) => asked.push(page) }));
  metrics.props.onClick();
  admin.props.onClick();
  assert.deepEqual(asked, ["metrics", "admin"]);
});

test("the menu draws the Admin section for an admin only, after History and last in the panel", () => {
  const menu = menuSource();
  assert.match(menu, /isAdmin: boolean;/, "AppMenu is told whether the viewer is an admin");
  const history = menu.indexOf('aria-label="How far back finished tasks go"');
  const mount = "{isAdmin && <AdminMenuSection onOpenPage={openPage} />}";
  const section = menu.indexOf(mount);
  assert.ok(history >= 0 && section > history, "below History");
  assert.match(menu.slice(section + mount.length), /^\s*<\/div>\s*\)\}\s*<\/div>\s*\);\s*\};/, "and nothing after it in the panel");
  assert.equal((APP_SOURCE.match(/<AdminMenuSection\b/g) ?? []).length, 1, "drawn in the menu and nowhere else");
});

test("opening a page from the menu closes it, scrolls to the top, then opens the page", () => {
  const open = menuSource().match(/const openPage = \(page: AppPage\): void => \{([\s\S]*?)\};/)?.[1];
  assert.ok(open, "one handler for both buttons");
  assert.match(open, /setOpen\(false\);\s*window\.scrollTo\(\{ top: 0 \}\);\s*onOpenPage\(page\);/);
});

test("App hands the menu the viewer's admin test and the page state itself", () => {
  const mount = block("<AppMenu\n", "/>");
  assert.match(mount, /isAdmin=\{isAdmin\}/);
  assert.match(mount, /onOpenPage=\{setActiveTab\}/, "the menu sets the one state that picks the page");
  assert.match(APP_SOURCE, /const isAdmin = user\.roles\.includes\("ADMIN"\);/, "the same test the tab row used");
});

/* ── Metrics and Admin ─────────────────────────────────────── */

test("Back to Tasks is a link-voiced button that goes back", () => {
  let backs = 0;
  const html = renderToStaticMarkup(createElement(BackToTasks, { onBack: () => {} }));
  assert.match(html, /^<button type="button" class="back-to-tasks">/);
  const [link] = buttons(BackToTasks({ onBack: () => backs++ }));
  assert.equal(text(link).replace(/^\W+/, ""), "Back to Tasks");
  link.props.onClick();
  assert.equal(backs, 1);
});

for (const [page, panel] of [["metrics", "<MetricsPanel"], ["admin", "<AdminPanel"]]) {
  test(`${page} opens under a Back to Tasks link and carries no other header controls`, () => {
    const view = block(`{activeTab === "${page}" && isAdmin && (`, "\n      )}");
    const back = view.indexOf(`<BackToTasks onBack={() => setActiveTab("active")} />`);
    assert.ok(back >= 0, "the link returns to the board");
    assert.ok(view.indexOf(panel) > back, "above the page");
    assert.doesNotMatch(view, /<AppMenu|<LoanSearch|<NewTaskButton|<BoardTabs/, "no menu or other header control");
  });
}

test("a viewer who is not an admin on Metrics or Admin lands back on Tasks", () => {
  assert.match(APP_SOURCE, /if \(!isAdmin && \(activeTab === "metrics" \|\| activeTab === "admin"\)\) \{\s*setActiveTab\("active"\);/);
});

/* ── The app bar ───────────────────────────────────────────── */

test("the app bar exists only in a dev build, and holds only the user picker", () => {
  assert.equal((APP_SOURCE.match(/<header className="app-bar">/g) ?? []).length, 1);
  const bar = block(`{IS_DEV && (\n        <header className="app-bar">`, "</header>");
  assert.match(bar, /<label className="user-picker">/, "the picker is still reachable in dev");
  assert.doesNotMatch(bar, /user\.displayName\}|user-picker-static/, "production's name is gone, not just hidden");
});

test("the tab row and the open-task count it carried are gone, not moved", () => {
  assert.doesNotMatch(APP_SOURCE, /className="tab-bar"/);
  assert.doesNotMatch(APP_SOURCE, /activeCount/);
  assert.doesNotMatch(APP_SOURCE, /onClick=\{\(\) => setActiveTab\("(metrics|admin)"\)\}/, "the menu is the only way in");
});
