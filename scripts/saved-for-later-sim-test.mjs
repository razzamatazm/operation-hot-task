#!/usr/bin/env node
/*
 * Saved for Later tasks on the server (#343, ADR-0011).
 *
 * A Saved for Later task is someone's scratch work: a new task put aside before
 * it was filed. ADR-0011 makes three promises about where it lives, and this
 * file checks each one in the way it can actually be broken.
 *
 *   1. It belongs to one person. The store never answers for anyone else: a
 *      list is that owner's list, a lookup by id is refused for anyone but its
 *      owner, and the list comes back newest saved first.
 *   2. It is kept apart from tasks (rule 3). It has its own file, and saving one
 *      writes nothing to the task store. Structurally, only the server's
 *      start-up, the router and the Saved for Later routes can reach the store
 *      at all, the first two only pass it along to the third (the router's one
 *      other use is clearing a removed person's, rule 6), and those routes
 *      can reach nothing that notifies, broadcasts,
 *      counts or touches tasks and loans. So maintenance, pool nags, signals,
 *      channel posts, loan rename and merge, and GET /tasks cannot see one by
 *      accident: none of them has a way to it.
 *   3. It stores the whole form. The server's shape for it is exactly the new
 *      task form's fields, held to the autosave's own field list, so a field
 *      added to the form without being added here fails this suite instead of
 *      being silently dropped on save.
 *
 * The HTTP side (another user and an admin get nothing, a deactivated user is
 * refused, the task list and loans never show one) is in scripts/smoke-test.mjs,
 * against a real server with its own isolated data files.
 *
 * Run: `node --test scripts/saved-for-later-sim-test.mjs`.
 */
import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

import { SavedForLaterStore } from "../apps/server/dist/saved-for-later-store.js";
import { TaskStore } from "../apps/server/dist/store.js";
import { savedForLaterFormSchema } from "../apps/server/dist/validation.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const root = mkdtempSync(path.join(os.tmpdir(), "saved-for-later-sim-"));
after(() => rmSync(root, { recursive: true, force: true }));
let dirs = 0;
const dirFor = () => {
  dirs += 1;
  const dir = path.join(root, String(dirs));
  fs.mkdirSync(dir);
  return dir;
};

const DANA = "creator-1";
const SAM = "officer-2";

const form = (overrides = {}) => ({
  folderName: "Smith-1042",
  loanId: "",
  taskType: "LOI",
  urgency: "GREEN",
  startDate: "",
  returnDate: "",
  notes: "Loan Amount: $2,340,000",
  humperdinkLink: "",
  points: 0,
  initialItems: [],
  pickerMode: "share",
  recipientUserId: "",
  recipientNote: "",
  ...overrides
});

const freshStore = async () => {
  const dir = dirFor();
  const file = path.join(dir, "saved-for-later.json");
  const store = new SavedForLaterStore(file);
  await store.init();
  return { dir, file, store };
};

// --- 1. One owner ----------------------------------------------------------

test("saving keeps the whole form under its owner", async () => {
  const { store } = await freshStore();
  const filled = form({ taskType: "FRAUD", initialItems: ["Missing appraisal"], points: 3, urgency: "RED" });
  const saved = await store.create(DANA, filled, "2026-09-11T12:00:00.000Z");

  assert.equal(saved.ownerId, DANA);
  assert.equal(saved.savedAt, "2026-09-11T12:00:00.000Z");
  assert.ok(saved.id, "it gets an id of its own");
  assert.deepEqual(saved.form, filled, "every field comes back as it was saved");
  assert.deepEqual(await store.find(DANA, saved.id), saved);
});

test("a list is only ever its owner's, and a lookup for anyone else finds nothing", async () => {
  const { store } = await freshStore();
  const danas = await store.create(DANA, form({ folderName: "Dana's loan" }));
  const sams = await store.create(SAM, form({ folderName: "Sam's loan" }));

  assert.deepEqual((await store.list(DANA)).map((item) => item.id), [danas.id]);
  assert.deepEqual((await store.list(SAM)).map((item) => item.id), [sams.id]);
  assert.equal(await store.find(SAM, danas.id), undefined, "Sam cannot fetch Dana's by id");
  assert.equal(await store.find(DANA, sams.id), undefined, "nor Dana Sam's");
  assert.deepEqual(await store.list("admin-1"), [], "someone with none has an empty list, whatever their role");
});

test("the list is newest saved first, and two saved in the same instant list the later one first", async () => {
  const { store } = await freshStore();
  const monday = await store.create(DANA, form({ folderName: "Monday" }), "2026-09-07T09:00:00.000Z");
  const wednesday = await store.create(DANA, form({ folderName: "Wednesday" }), "2026-09-09T09:00:00.000Z");
  const tuesday = await store.create(DANA, form({ folderName: "Tuesday" }), "2026-09-08T09:00:00.000Z");
  const tuesdayAgain = await store.create(DANA, form({ folderName: "Tuesday again" }), "2026-09-08T09:00:00.000Z");

  assert.deepEqual(
    (await store.list(DANA)).map((item) => item.form.folderName),
    [wednesday, tuesdayAgain, tuesday, monday].map((item) => item.form.folderName)
  );
});

/* Rule 6: it goes when its owner goes. Removing a person clears every one they
   held and nobody else's; the route that calls this is in the smoke test. */
test("removing an owner's clears all of theirs, and only theirs", async () => {
  const { file, store } = await freshStore();
  await store.create(DANA, form({ folderName: "Dana's first" }));
  const sams = await store.create(SAM, form({ folderName: "Sam's loan" }));
  await store.create(DANA, form({ folderName: "Dana's second" }));

  assert.equal(await store.removeAllFor(DANA), 2, "it says how many it removed");
  assert.deepEqual(await store.list(DANA), []);
  assert.deepEqual(await store.list(SAM), [sams], "Sam's is untouched");
  assert.ok(!fs.readFileSync(file, "utf8").includes(DANA), "nothing of Dana's is left in the file");
});

test("removing someone with none saved writes nothing", async () => {
  const { file, store } = await freshStore();
  await store.create(SAM, form());
  const before = fs.readFileSync(file, "utf8");

  assert.equal(await store.removeAllFor(DANA), 0);
  assert.equal(fs.readFileSync(file, "utf8"), before, "the file is byte for byte what it was");
});

test("there is no cap: every save is kept", async () => {
  const { store } = await freshStore();
  await Promise.all(Array.from({ length: 60 }, (_, n) => store.create(DANA, form({ folderName: `Loan ${n}` }))));
  assert.equal((await store.list(DANA)).length, 60);
});

// --- Reopening one (#344) ----------------------------------------------------

test("saving a reopened one again updates that same record, never a copy", async () => {
  const { store } = await freshStore();
  const first = await store.create(DANA, form({ notes: "half" }), "2026-09-11T12:00:00.000Z");
  const other = await store.create(DANA, form({ folderName: "Other" }), "2026-09-11T12:01:00.000Z");

  const updated = await store.update(DANA, first.id, form({ notes: "finished the thought", points: 4 }), "2026-09-11T13:00:00.000Z");

  assert.equal(updated.id, first.id, "same record");
  assert.equal(updated.ownerId, DANA);
  assert.equal(updated.savedAt, "2026-09-11T13:00:00.000Z", "saved N ago starts again");
  assert.deepEqual(updated.form, form({ notes: "finished the thought", points: 4 }), "every field is the new save");
  assert.deepEqual(
    (await store.list(DANA)).map((item) => item.id),
    [first.id, other.id],
    "the list does not grow, and the record just saved comes first"
  );
});

test("two saves of the same one keep whichever came last, with no refusal", async () => {
  const { store } = await freshStore();
  const saved = await store.create(DANA, form());
  await store.update(DANA, saved.id, form({ notes: "from the desktop" }));
  await store.update(DANA, saved.id, form({ notes: "from the phone" }));
  assert.equal((await store.find(DANA, saved.id)).form.notes, "from the phone");
  assert.equal((await store.list(DANA)).length, 1);
});

test("nobody can update or remove someone else's, and trying leaves it untouched", async () => {
  const { store } = await freshStore();
  const danas = await store.create(DANA, form({ notes: "Dana's" }), "2026-09-11T12:00:00.000Z");

  assert.equal(await store.update(SAM, danas.id, form({ notes: "Sam was here" })), undefined);
  assert.equal(await store.remove(SAM, danas.id), false);
  assert.deepEqual(await store.find(DANA, danas.id), danas, "exactly as Dana saved it");
  assert.equal(await store.update(DANA, "no-such-id", form()), undefined, "an id that never existed finds nothing");
  assert.equal(await store.remove(DANA, "no-such-id"), false);
});

test("removing one takes that one and only that one", async () => {
  const { store } = await freshStore();
  const filed = await store.create(DANA, form({ folderName: "Filed" }));
  const kept = await store.create(DANA, form({ folderName: "Kept" }));
  const sams = await store.create(SAM, form({ folderName: "Sam's" }));

  assert.equal(await store.remove(DANA, filed.id), true);
  assert.equal(await store.find(DANA, filed.id), undefined, "gone for good");
  assert.deepEqual((await store.list(DANA)).map((item) => item.id), [kept.id]);
  assert.deepEqual((await store.list(SAM)).map((item) => item.id), [sams.id]);
  assert.equal(await store.remove(DANA, filed.id), false, "a second remove finds nothing");
});

// --- Typing nobody saved (#348, ADR-0011 rule 5) ----------------------------

test("typing on a reopened one is kept on that record, beside the save, and changes nothing about the save", async () => {
  const { store } = await freshStore();
  const saved = await store.create(DANA, form({ notes: "as saved" }), "2026-09-11T12:00:00.000Z");
  const later = await store.create(DANA, form({ folderName: "Later" }), "2026-09-11T12:05:00.000Z");

  const kept = await store.keepUnsaved(DANA, saved.id, form({ notes: "as saved, and then some" }));

  assert.equal(kept.id, saved.id, "the same record, never a copy");
  assert.deepEqual(kept.unsaved, form({ notes: "as saved, and then some" }), "the typing is on it");
  assert.deepEqual(kept.form, saved.form, "the save itself is untouched");
  assert.equal(kept.savedAt, saved.savedAt, "and so is saved N ago");
  assert.deepEqual(
    (await store.list(DANA)).map((item) => item.id),
    [later.id, saved.id],
    "unsaved typing does not move it up the list or add a row"
  );
  assert.deepEqual(await store.find(DANA, saved.id), kept);
});

test("clearing the typing (a form typed back to its save) leaves the record exactly as it was last saved", async () => {
  const { store } = await freshStore();
  const saved = await store.create(DANA, form({ notes: "as saved" }), "2026-09-11T12:00:00.000Z");
  await store.keepUnsaved(DANA, saved.id, form({ notes: "abandoned" }));

  const cleared = await store.clearUnsaved(DANA, saved.id);

  assert.deepEqual(cleared, saved, "byte for byte the save, with nothing unsaved left on it");
  assert.equal("unsaved" in (await store.find(DANA, saved.id)), false);
  assert.deepEqual(await store.clearUnsaved(DANA, saved.id), saved, "clearing when there is nothing to clear is not an error");
});

test("saving it again takes the typing into the save, so nothing unsaved is left behind", async () => {
  const { store } = await freshStore();
  const saved = await store.create(DANA, form(), "2026-09-11T12:00:00.000Z");
  await store.keepUnsaved(DANA, saved.id, form({ notes: "typed, then saved" }));

  const updated = await store.update(DANA, saved.id, form({ notes: "typed, then saved" }), "2026-09-11T13:00:00.000Z");

  assert.equal("unsaved" in updated, false);
  assert.equal("unsaved" in (await store.find(DANA, saved.id)), false);
});

test("nobody can keep or clear typing on someone else's, or on one that is gone", async () => {
  const { store } = await freshStore();
  const danas = await store.create(DANA, form({ notes: "Dana's" }));

  assert.equal(await store.keepUnsaved(SAM, danas.id, form({ notes: "Sam was here" })), undefined);
  assert.equal(await store.clearUnsaved(SAM, danas.id), undefined);
  assert.deepEqual(await store.find(DANA, danas.id), danas, "exactly as Dana saved it");
  assert.equal(await store.keepUnsaved(DANA, "no-such-id", form()), undefined, "a created or deleted one is not brought back");
  assert.equal(await store.clearUnsaved(DANA, "no-such-id"), undefined);
  assert.deepEqual(await store.list(DANA), [danas]);
});

// --- The autosave (#371) -----------------------------------------------------
/* The new task form's accidental safety net, moved off the browser onto the
   server so it follows its owner the way a Saved for Later task does. One per
   person, private under the same rules, and gone seven days after it was last
   written. Kept in this same store and file, so everything above about who can
   reach it holds for it without a second set of guards. */

const DAY = 24 * 60 * 60 * 1000;

test("an autosave is one per person: writing again replaces it, never adds a second", async () => {
  const { store } = await freshStore();
  const first = await store.keepAutosave(DANA, form({ notes: "half a thought" }), "2026-09-11T12:00:00.000Z");
  assert.deepEqual(first, { ownerId: DANA, savedAt: "2026-09-11T12:00:00.000Z", form: form({ notes: "half a thought" }) });

  await store.keepAutosave(DANA, form({ notes: "the whole thought" }), "2026-09-11T12:01:00.000Z");
  const now = Date.parse("2026-09-11T12:02:00.000Z");
  assert.deepEqual(await store.getAutosave(DANA, now), {
    ownerId: DANA,
    savedAt: "2026-09-11T12:01:00.000Z",
    form: form({ notes: "the whole thought" })
  });
});

test("an autosave is its owner's alone, and is not a Saved for Later task", async () => {
  const { store } = await freshStore();
  const now = Date.parse("2026-09-11T12:00:00.000Z");
  await store.keepAutosave(DANA, form({ notes: "Dana's typing" }), new Date(now).toISOString());

  assert.equal(await store.getAutosave(SAM, now), undefined, "Sam gets nothing");
  assert.equal(await store.getAutosave("admin-1", now), undefined, "nor does anyone else, whatever their role");
  assert.deepEqual(await store.list(DANA), [], "and it is never listed as a Saved for Later task");
  assert.equal(await store.clearAutosave(SAM), false, "nobody else can clear it");
  assert.equal((await store.getAutosave(DANA, now)).form.notes, "Dana's typing", "so it is still there");
});

test("an autosave last written seven days ago is gone, and reading it prunes it", async () => {
  const { file, store } = await freshStore();
  const written = Date.parse("2026-09-04T12:00:00.000Z");
  await store.keepAutosave(DANA, form({ notes: "stale" }), new Date(written).toISOString());

  assert.ok(await store.getAutosave(DANA, written + 7 * DAY - 1), "a moment inside seven days it is still there");
  assert.equal(await store.getAutosave(DANA, written + 7 * DAY), undefined, "at seven days it is gone");
  assert.ok(!fs.readFileSync(file, "utf8").includes("stale"), "and the file no longer holds it");
});

test("writing again restarts the seven days", async () => {
  const { store } = await freshStore();
  const monday = Date.parse("2026-09-07T12:00:00.000Z");
  await store.keepAutosave(DANA, form(), new Date(monday).toISOString());
  await store.keepAutosave(DANA, form({ notes: "came back to it" }), new Date(monday + 6 * DAY).toISOString());
  assert.ok(await store.getAutosave(DANA, monday + 8 * DAY), "measured from the last write, not the first");
});

test("any autosave write clears everyone's that has aged out, so nothing stale sits in the file", async () => {
  const { file, store } = await freshStore();
  const long = Date.now() - 30 * DAY;
  await store.keepAutosave(SAM, form({ notes: "Sam's forgotten one" }), new Date(long).toISOString());
  await store.keepAutosave(DANA, form({ notes: "Dana's today" }));
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes("Sam's forgotten one"), "Sam's month-old autosave went with Dana's write");
  assert.ok(raw.includes("Dana's today"));
});

test("clearing an autosave takes it away; clearing when there is none is not an error", async () => {
  const { store } = await freshStore();
  await store.keepAutosave(DANA, form());
  assert.equal(await store.clearAutosave(DANA), true);
  assert.equal(await store.getAutosave(DANA), undefined);
  assert.equal(await store.clearAutosave(DANA), false, "nothing left to clear");
});

test("saving a new task for later can clear the autosave in the same write, so it never shows twice", async () => {
  const { store } = await freshStore();
  await store.keepAutosave(DANA, form({ notes: "typed" }));
  await store.keepAutosave(SAM, form({ notes: "Sam's own" }));

  const saved = await store.create(DANA, form({ notes: "typed" }), undefined, { clearAutosave: true });

  assert.deepEqual((await store.list(DANA)).map((item) => item.id), [saved.id], "one Saved for Later task");
  assert.equal(await store.getAutosave(DANA), undefined, "and no autosave beside it");
  assert.ok(await store.getAutosave(SAM), "Sam's is untouched");
});

test("saving for later without asking leaves the autosave alone", async () => {
  const { store } = await freshStore();
  await store.keepAutosave(DANA, form({ notes: "an unrelated new form" }));
  await store.create(DANA, form({ notes: "a reopened one whose record had gone" }));
  assert.equal((await store.getAutosave(DANA)).form.notes, "an unrelated new form");
});

test("removing a person takes their autosave with their Saved for Later tasks", async () => {
  const { file, store } = await freshStore();
  await store.keepAutosave(DANA, form({ notes: "Dana's autosave" }));
  await store.keepAutosave(SAM, form({ notes: "Sam's autosave" }));

  await store.removeAllFor(DANA);

  assert.equal(await store.getAutosave(DANA), undefined);
  assert.ok(await store.getAutosave(SAM), "Sam's is untouched");
  assert.ok(!fs.readFileSync(file, "utf8").includes(DANA), "nothing of Dana's is left in the file");
});

test("a Saved for Later file written before the autosave moved to the server still reads", async () => {
  const { file } = await freshStore();
  const legacy = { items: [{ id: "old-1", ownerId: DANA, savedAt: "2026-09-10T12:00:00.000Z", form: form() }] };
  fs.writeFileSync(file, JSON.stringify(legacy));
  const store = new SavedForLaterStore(file);
  await store.init();
  assert.equal((await store.list(DANA)).length, 1);
  assert.equal(await store.getAutosave(DANA), undefined);
  await store.keepAutosave(DANA, form({ notes: "first autosave" }));
  assert.equal((await store.list(DANA)).length, 1, "writing one keeps the saved tasks");
});

// --- 2. Apart from tasks -----------------------------------------------------

test("saving one, or autosaving, writes nothing to the task store", async () => {
  const { dir, store } = await freshStore();
  const tasksFile = path.join(dir, "tasks.json");
  const tasks = new TaskStore(tasksFile);
  await tasks.init();
  const before = fs.readFileSync(tasksFile, "utf8");

  await store.create(DANA, form());
  await store.keepAutosave(DANA, form({ notes: "typing" }));

  assert.equal(fs.readFileSync(tasksFile, "utf8"), before, "tasks.json is byte for byte what it was");
  assert.deepEqual(await tasks.allTasks(), []);
});

/* Every relative import a module makes, type-only ones included: a type import
   is still a module that knows the store exists. */
const importsOf = (source) =>
  [...source.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map(
    (match) => match[1] ?? match[2]
  );

const serverModules = () => {
  const src = path.join(repoRoot, "apps/server/src");
  return fs
    .readdirSync(src, { recursive: true })
    .filter((name) => /\.(ts|tsx|mts|cts)$/.test(name))
    .map((name) => ({ name, source: fs.readFileSync(path.join(src, name), "utf8") }));
};

test("only start-up, the router and the Saved for Later routes can reach the store", () => {
  const reaching = serverModules()
    .filter(({ source }) => importsOf(source).some((specifier) => /saved-for-later-store(\.js)?$/.test(specifier)))
    .map(({ name }) => name)
    .sort();
  assert.deepEqual(
    reaching,
    ["index.ts", "routes.ts", "saved-for-later-routes.ts"],
    "a new module reading Saved for Later tasks has to be a deliberate decision about ADR-0011, not an import"
  );
});

/* The two modules above hold every service, the bot and the notifier, so being
   allowed to import the store is not enough on its own: either could hand it on.
   Each may only pass it along. Start-up builds it, starts it and gives it to the
   router; the router gives it to the Saved for Later routes, and does one thing
   itself: removing a person clears theirs (rule 6, #347), which is the only
   thing it does with the store that is not handing it over.
   Counted as the identifier, so any other use anywhere in either file fails. */
test("start-up and the router only pass the store along, except that removing a person clears theirs", () => {
  const modules = serverModules();
  const sourceOf = (name) => modules.find((module) => module.name === name).source;
  const uses = (source) => source.match(/\bsavedForLater\b/g)?.length ?? 0;

  const index = sourceOf("index.ts");
  assert.match(index, /const savedForLater = new SavedForLaterStore\(/);
  assert.match(index, /await savedForLater\.init\(\);/);
  assert.match(index, /buildRouter\([^;]*\bsavedForLater\)\);/);
  assert.equal(uses(index), 3, "start-up builds it, starts it, and hands it to the router, and does nothing else with it");

  const routes = sourceOf("routes.ts");
  assert.match(routes, /savedForLater: SavedForLaterStore\): Router =>/);
  assert.match(routes, /savedForLaterRoutes\(router, getActor, savedForLater\);/);
  assert.match(routes, /await savedForLater\.removeAllFor\(req\.params\.id\);/);
  assert.equal(
    uses(routes),
    3,
    "the router receives it, passes it to the Saved for Later routes, and clears a removed person's, and does nothing else with it"
  );
});

test("the Saved for Later routes can reach nothing that notifies, broadcasts, counts or touches tasks", () => {
  const routes = serverModules().find(({ name }) => name === "saved-for-later-routes.ts");
  assert.ok(routes, "the routes module exists");
  assert.deepEqual(
    [...new Set(importsOf(routes.source))].sort(),
    ["./auth.js", "./saved-for-later-store.js", "./validation.js", "@loan-tasks/shared", "express", "zod"],
    "no task service, loan service, SSE hub, bot, notifier or activity feed"
  );
});

// --- 3. The whole form ------------------------------------------------------

test("the server's shape for a saved form is exactly the new task form's fields", async () => {
  const { draftFieldNames } = await import(
    pathToFileURL(path.join(repoRoot, "apps/web/src/create-form-draft.ts")).href
  );
  assert.deepEqual(Object.keys(savedForLaterFormSchema.shape).sort(), draftFieldNames().sort());
});

test("nothing on the form is required: an all-blank form is a valid save", () => {
  assert.equal(savedForLaterFormSchema.safeParse(form({ folderName: "", notes: "" })).success, true);
});

test("a form that is not the form's shape is refused", () => {
  assert.equal(savedForLaterFormSchema.safeParse({ ...form(), taskType: "LUNCH" }).success, false, "an unknown type");
  assert.equal(savedForLaterFormSchema.safeParse({ ...form(), points: 9 }).success, false, "points out of range");
  assert.equal(savedForLaterFormSchema.safeParse({ ...form(), isAdmin: true }).success, false, "a stray field");
  const { notes, ...missing } = form();
  assert.equal(savedForLaterFormSchema.safeParse(missing).success, false, "a missing field");
});
