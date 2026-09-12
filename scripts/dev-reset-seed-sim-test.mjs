#!/usr/bin/env node
/* Sim test for `npm run dev:reset` (scripts/reset-dev-data.mjs), run against a
   scratch --data-file so it never goes near a real dev store.

   #316: the seeded tasks each showed a Humperdink link that no loan record
   held, so nothing on fresh seed data could collide and the merge question
   (#265) was unreachable without building a collision by hand first. The
   seeder now writes the link onto the loan and names one pair that collides on
   purpose. The last block pins the rest of the seeder's contract, which that
   change must not disturb. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loanEditRefusal } from "../packages/shared/dist/loan-edit.js";
import { normalizeLinkKey } from "../packages/shared/dist/loan.js";
import { LoanLinkCollisionError, LoanService } from "../apps/server/dist/loan-service.js";
import { SseHub } from "../apps/server/dist/sse.js";
import { LoanStore, TaskStore } from "../apps/server/dist/store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const seeder = path.join(repoRoot, "scripts", "reset-dev-data.mjs");

const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const writeJson = (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");

const scratch = () => fs.mkdtemp(path.join(os.tmpdir(), "dev-reset-seed-"));

const seed = (dir, ...extra) =>
  execFileSync(process.execPath, [seeder, "--data-file", path.join(dir, "tasks.json"), ...extra], {
    cwd: repoRoot,
    encoding: "utf8"
  });

test("every seeded task's link is the link on its loan record", async () => {
  const dir = await scratch();
  seed(dir, "--no-backup");
  const { tasks } = await readJson(path.join(dir, "tasks.json"));
  const { loans } = await readJson(path.join(dir, "loans.json"));

  const onLoans = tasks.filter((task) => task.loanId);
  assert.ok(onLoans.length > 0, "the seed files tasks on loans");
  for (const task of onLoans) {
    const loan = loans.find((candidate) => candidate.id === task.loanId);
    assert.ok(loan, `${task.id} points at a loan that exists`);
    assert.ok(loan.humperdinkLink, `${loan.name} holds a link`);
    assert.equal(task.humperdinkLink, loan.humperdinkLink, `${task.id} shows its loan's link`);
  }

  // Distinct per loan, or two seeded loans would already be one loan.
  const keys = loans.map((loan) => normalizeLinkKey(loan.humperdinkLink));
  assert.equal(new Set(keys).size, loans.length, "no two seeded loans share a link");
});

test("the documented pair raises the merge question on the first paste", async () => {
  const dir = await scratch();
  const output = seed(dir, "--no-backup");
  const { tasks } = await readJson(path.join(dir, "tasks.json"));
  const { loans } = await readJson(path.join(dir, "loans.json"));

  /* The pair as the seeder documents it: Suzie, who filed both, opens her
     Castillo-3340 task and pastes Alvarez-2201's link into it. */
  const edited = tasks.find((task) => task.id === "seed-claimed");
  const other = tasks.find((task) => task.id === "seed-open-overdue");
  assert.equal(edited.folderName, "Castillo-3340");
  assert.equal(other.folderName, "Alvarez-2201");
  const alvarez = loans.find((loan) => loan.id === other.loanId);

  // The seeder says so where the person running it will read it.
  assert.match(output, /Castillo-3340/);
  assert.match(output, /Alvarez-2201/);
  assert.ok(output.includes(alvarez.humperdinkLink), "the hint carries the link to paste");

  // Both tasks are live on the board, and Suzie may edit the loan from hers.
  for (const task of [edited, other]) {
    assert.ok(!["COMPLETED", "CANCELLED", "ARCHIVED"].includes(task.status), `${task.id} is on the open board`);
  }
  assert.equal(loanEditRefusal(edited, { id: "loan-officer-1" }), undefined);

  // And the save is refused as a collision, naming the other loan.
  const service = new LoanService(
    new LoanStore(path.join(dir, "loans.json")),
    new TaskStore(path.join(dir, "tasks.json")),
    new SseHub()
  );
  await assert.rejects(
    service.update(edited.loanId, { humperdinkLink: alvarez.humperdinkLink }),
    (error) => {
      assert.ok(error instanceof LoanLinkCollisionError, `expected a collision, got ${error}`);
      assert.equal(error.collision.loanId, alvarez.id);
      return true;
    }
  );
});

test("a reset still backs up, clears card state, and leaves settings and people alone", async () => {
  const dir = await scratch();
  const previousTasks = { tasks: [{ id: "mine-1", folderName: "Mine" }], history: [] };
  const previousLoans = { loans: [{ id: "loan-mine", name: "Mine", humperdinkLink: "https://h.example.com/mine" }] };
  const settings = { notificationChannel: "somewhere" };
  const references = [{ userId: "someone" }];
  const users = { users: [{ id: "loan-officer-1", displayName: "Suzie", roles: ["ADMIN"], active: false }] };
  await writeJson(path.join(dir, "tasks.json"), previousTasks);
  await writeJson(path.join(dir, "loans.json"), previousLoans);
  await writeJson(path.join(dir, "admin-settings.json"), settings);
  await writeJson(path.join(dir, "bot-references.json"), references);
  await writeJson(path.join(dir, "bot-note-cards.json"), [{ taskId: "mine-1" }]);
  await writeJson(path.join(dir, "users.json"), users);

  seed(dir);

  const [stamp] = await fs.readdir(path.join(dir, "backups"));
  assert.deepEqual(await readJson(path.join(dir, "backups", stamp, "tasks.json")), previousTasks);
  assert.deepEqual(await readJson(path.join(dir, "backups", stamp, "loans.json")), previousLoans);

  const { tasks } = await readJson(path.join(dir, "tasks.json"));
  assert.ok(tasks.every((task) => task.id.startsWith("seed-")), "a plain reset replaces the tasks");
  assert.deepEqual(await readJson(path.join(dir, "bot-note-cards.json")), []);
  assert.deepEqual(await readJson(path.join(dir, "admin-settings.json")), settings);
  assert.deepEqual(await readJson(path.join(dir, "bot-references.json")), references);

  const after = await readJson(path.join(dir, "users.json"));
  assert.deepEqual(after.users[0], users.users[0], "an existing person is untouched");
  assert.equal(after.users.length, 4, "the missing cast is added");
});

/* #369: saved drafts belong to the data set, not to the people. After a reset
   they would name loans and tasks that no longer exist, so a plain reset backs
   them up with the tasks and empties the store; --keep leaves them where they
   are. Either way the summary says which. */
const drafts = {
  items: [
    { id: "draft-1", ownerId: "loan-officer-1", savedAt: "2026-09-01T00:00:00.000Z", form: { folderName: "Mine" } },
    { id: "draft-2", ownerId: "loan-officer-2", savedAt: "2026-09-02T00:00:00.000Z", form: { folderName: "Theirs" } }
  ]
};

test("a reset backs saved drafts up with the tasks and empties the store", async () => {
  const dir = await scratch();
  await writeJson(path.join(dir, "saved-for-later.json"), drafts);

  const output = seed(dir);

  const [stamp] = await fs.readdir(path.join(dir, "backups"));
  assert.deepEqual(await readJson(path.join(dir, "backups", stamp, "saved-for-later.json")), drafts);
  assert.deepEqual(await readJson(path.join(dir, "saved-for-later.json")), { items: [] });
  assert.match(output, /Cleared 2 Saved for Later tasks/);
});

test("a reset backs up an unreadable drafts file as it was, not as empty", async () => {
  const dir = await scratch();
  await fs.writeFile(path.join(dir, "saved-for-later.json"), "{ not json", "utf8");

  seed(dir);

  const [stamp] = await fs.readdir(path.join(dir, "backups"));
  assert.equal(await fs.readFile(path.join(dir, "backups", stamp, "saved-for-later.json"), "utf8"), "{ not json");
  assert.deepEqual(await readJson(path.join(dir, "saved-for-later.json")), { items: [] });
});

test("--keep leaves saved drafts in place and says so", async () => {
  const dir = await scratch();
  await writeJson(path.join(dir, "saved-for-later.json"), drafts);

  const output = seed(dir, "--no-backup", "--keep");

  assert.deepEqual(await readJson(path.join(dir, "saved-for-later.json")), drafts);
  assert.match(output, /Left 2 Saved for Later tasks in place/);
});

test("--keep re-seeds without clearing, and without doubling the cast", async () => {
  const dir = await scratch();
  seed(dir, "--no-backup");
  const { tasks: firstTasks } = await readJson(path.join(dir, "tasks.json"));
  const { loans: firstLoans } = await readJson(path.join(dir, "loans.json"));

  const tasksFile = await readJson(path.join(dir, "tasks.json"));
  tasksFile.tasks.push({ id: "mine-1", folderName: "Mine" });
  await writeJson(path.join(dir, "tasks.json"), tasksFile);
  const loansFile = await readJson(path.join(dir, "loans.json"));
  loansFile.loans.push({ id: "loan-mine", name: "Mine", humperdinkLink: "https://h.example.com/mine" });
  await writeJson(path.join(dir, "loans.json"), loansFile);
  await writeJson(path.join(dir, "bot-note-cards.json"), [{ taskId: "mine-1" }]);

  seed(dir, "--no-backup", "--keep");

  const { tasks } = await readJson(path.join(dir, "tasks.json"));
  const { loans } = await readJson(path.join(dir, "loans.json"));
  assert.ok(tasks.some((task) => task.id === "mine-1"), "your own task survives");
  assert.ok(loans.some((loan) => loan.id === "loan-mine"), "your own loan survives");
  assert.equal(tasks.length, firstTasks.length + 1);
  assert.equal(loans.length, firstLoans.length + 1);
  assert.deepEqual(await readJson(path.join(dir, "bot-note-cards.json")), [{ taskId: "mine-1" }]);

  for (const task of tasks.filter((candidate) => candidate.loanId)) {
    const loan = loans.find((candidate) => candidate.id === task.loanId);
    assert.equal(task.humperdinkLink, loan.humperdinkLink, `${task.id} still agrees with its loan`);
  }
});

/* A store seeded before #316 had no loan holding a seeded link, so filing a
   task by pasting one minted a loan of your own that holds it. --keep keeps
   that loan, and the re-seed then writes a second loan with the same link:
   the pair's merge question would name YOUR loan, not the one the hint says.
   The seeder can't pick which record is right, so it says so. */
test("--keep warns when a kept loan already holds a seeded link", async () => {
  const dir = await scratch();
  await writeJson(path.join(dir, "tasks.json"), { tasks: [], history: [] });
  await writeJson(path.join(dir, "loans.json"), {
    loans: [{ id: "loan-mine", name: "My Alvarez", humperdinkLink: "https://www.Humperdink.example.com/loans/seed-loan-alvarez/" }]
  });

  const output = seed(dir, "--no-backup", "--keep");
  assert.match(output, /My Alvarez/);
  assert.match(output, /Alvarez-2201/);

  const quiet = seed(await scratch(), "--no-backup", "--keep");
  assert.doesNotMatch(quiet, /already holds/);
});
