#!/usr/bin/env node
/* Sim test for the Loan entity (ADR-0001): the pure fuzzy-match/dedup helpers
   plus the file-backed LoanService (create/dedupe, edit propagation, canonical
   -link auto-merge, and the one-time migration). Mirrors the harness style of
   scheduler-sim-test.mjs — imports compiled dist, runs against temp files. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";

import {
  clusterLoanNames,
  findLoanForCreate,
  loanNameSimilarity,
  normalizeLinkKey,
  normalizeLoanName,
  searchLoans
} from "../packages/shared/dist/loan.js";
import { LoanStore, TaskStore } from "../apps/server/dist/store.js";
import { LoanService } from "../apps/server/dist/loan-service.js";
import { SseHub } from "../apps/server/dist/sse.js";

const results = [];
const pass = (m) => results.push(`PASS ${m}`);

const makeTask = (overrides = {}) => {
  const now = new Date().toISOString();
  return {
    id: uuid(),
    folderName: "Untitled",
    loanName: "Untitled",
    taskType: "LOI",
    dueAt: now,
    urgency: "GREEN",
    points: 1,
    notes: "n",
    status: "OPEN",
    createdAt: now,
    updatedAt: now,
    createdBy: { id: "u1", displayName: "Suzie" },
    ...overrides
  };
};

const withTempDir = async (fn) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loan-sim-"));
  const tasksFile = path.join(dir, "tasks.json");
  const loansFile = path.join(dir, "loans.json");
  const taskStore = new TaskStore(tasksFile);
  const loanStore = new LoanStore(loansFile);
  await taskStore.init();
  await loanStore.init();
  const service = new LoanService(loanStore, taskStore, new SseHub());
  return fn({ taskStore, loanStore, service, tasksFile, loansFile });
};

const run = async () => {
  // ── Pure helpers ─────────────────────────────────────────
  assert.equal(normalizeLoanName("Smith - 1042 (Rev)"), "smith 1042 rev");
  assert.ok(loanNameSimilarity("Smith 1042", "Smith  1042") === 1);
  assert.ok(loanNameSimilarity("Smith 1042", "Smyth 1042") > 0.82);
  assert.ok(loanNameSimilarity("Smith 1042", "Jones 9000") < 0.5);
  pass("normalizeLoanName + loanNameSimilarity behave");

  assert.equal(
    normalizeLinkKey("https://www.humperdink.example/loan/1/"),
    normalizeLinkKey("https://humperdink.example/loan/1")
  );
  pass("normalizeLinkKey collapses www + trailing slash");

  const clusters = clusterLoanNames([
    { name: "Smith 1042" },
    { name: "Smith  1042" },
    { name: "Smyth 1042" },
    { name: "Jones 9000" },
    { name: "Jones 9000", humperdinkLink: "https://h.example/j" }
  ]);
  assert.equal(clusters.length, 2, `expected 2 clusters, got ${clusters.length}`);
  const jones = clusters.find((c) => normalizeLoanName(c.name).startsWith("jones"));
  assert.equal(jones.humperdinkLink, "https://h.example/j");
  pass("clusterLoanNames fuzzy-dedups near-duplicate names into one loan");

  // ── searchLoans typeahead ranking ────────────────────────
  const now = new Date().toISOString();
  const loanList = [
    { id: "l1", name: "Smith 1042", createdAt: now, updatedAt: now },
    { id: "l2", name: "Smithson 88", createdAt: now, updatedAt: now },
    { id: "l3", name: "Jones 9000", createdAt: now, updatedAt: now }
  ];
  const hits = searchLoans("smith", loanList, 5);
  assert.ok(hits.length >= 2, "smith matches at least the two Smith loans");
  assert.equal(hits[0].loan.id, "l1", "closest match ranks first");
  assert.ok(!hits.some((h) => h.loan.id === "l3"), "unrelated loan excluded");
  pass("searchLoans surfaces fuzzy + substring matches, ranked");

  assert.ok(findLoanForCreate("smith 1042", undefined, loanList)?.id === "l1", "findLoanForCreate matches normalized name");

  // ── Create + dedupe ──────────────────────────────────────
  await withTempDir(async ({ service }) => {
    const a = await service.create({ name: "Acme Loan", humperdinkLink: "https://h.example/acme" });
    const b = await service.create({ name: "Acme Loan" }); // same normalized name → reuse
    assert.equal(a.id, b.id, "duplicate name folds into the existing loan");
    const c = await service.create({ name: "Totally Different", humperdinkLink: "https://h.example/acme" });
    assert.equal(c.id, a.id, "shared Humperdink link folds into the existing loan (canonical key)");
    pass("LoanService.create dedupes by normalized name and by link");
  });

  // ── Edit propagation to linked tasks (live reference) ────
  await withTempDir(async ({ service, taskStore }) => {
    const loan = await service.create({ name: "Original Name" });
    const task = makeTask({ loanId: loan.id, folderName: "Original Name", loanName: "Original Name" });
    await taskStore.upsertTask(task);
    await service.update(loan.id, { name: "Renamed Loan", humperdinkLink: "https://h.example/x" });
    const after = await taskStore.findTask(task.id);
    assert.equal(after.folderName, "Renamed Loan", "task folderName follows the loan rename");
    assert.equal(after.humperdinkLink, "https://h.example/x", "task link follows the loan link");
    pass("editing a loan propagates name + link to every linked task");
  });

  // ── Canonical-link auto-merge ────────────────────────────
  await withTempDir(async ({ service, taskStore, loanStore }) => {
    const older = await service.create({ name: "First Record", humperdinkLink: "https://h.example/dup" });
    // Force a distinct newer loan with no link yet, then give it the same link.
    const newer = await service.create({ name: "Second Record" });
    const t1 = makeTask({ loanId: older.id, folderName: "First Record" });
    const t2 = makeTask({ loanId: newer.id, folderName: "Second Record" });
    await taskStore.upsertTask(t1);
    await taskStore.upsertTask(t2);
    const res = await service.update(newer.id, { humperdinkLink: "https://h.example/dup" });
    assert.ok(res.merged, "update reports a merge notice");
    assert.equal(res.merged.intoLoanId, older.id, "newer merges into the older original");
    const remaining = await loanStore.all();
    assert.equal(remaining.length, 1, "only the surviving loan remains");
    assert.ok((remaining[0].aliases ?? []).includes("Second Record"), "merged name kept as an alias");
    const t2After = await taskStore.findTask(t2.id);
    assert.equal(t2After.loanId, older.id, "the duplicate's task repoints to the survivor");
    assert.equal(t2After.folderName, "First Record", "repointed task shows the survivor's name");
    pass("shared Humperdink link auto-merges loans and repoints tasks");
  });

  // ── One-time migration (+ idempotency) ───────────────────
  await withTempDir(async ({ service, taskStore, loanStore }) => {
    const preLinked = await service.create({ name: "Pre Linked" });
    await taskStore.upsertTask(makeTask({ folderName: "Smith 1042" }));
    await taskStore.upsertTask(makeTask({ folderName: "Smith  1042" })); // fuzzy dup
    await taskStore.upsertTask(makeTask({ folderName: "Jones 9000", humperdinkLink: "https://h.example/j" }));
    await taskStore.upsertTask(makeTask({ taskType: "OOO", folderName: "Vacation", startDate: "2099-01-01", returnDate: "2099-01-02" }));
    await taskStore.upsertTask(makeTask({ loanId: preLinked.id, folderName: "Pre Linked" }));

    const first = await service.migrateExistingTasks();
    // Smith x2 collapse to 1 loan + Jones = 2 new loans (OOO + already-linked skipped).
    assert.equal(first.loansCreated, 2, `expected 2 loans created, got ${first.loansCreated}`);
    assert.equal(first.tasksLinked, 3, `expected 3 tasks linked, got ${first.tasksLinked}`);

    const tasks = await taskStore.allTasks();
    const ooo = tasks.find((t) => t.taskType === "OOO");
    assert.equal(ooo.loanId, undefined, "OOO task is never linked to a loan");
    const nonOoo = tasks.filter((t) => t.taskType !== "OOO");
    assert.ok(nonOoo.every((t) => t.loanId), "every non-OOO task has a loanId after migration");

    const second = await service.migrateExistingTasks();
    assert.equal(second.loansCreated, 0, "re-running migration creates no new loans");
    assert.equal(second.tasksLinked, 0, "re-running migration links no more tasks");
    const loansTotal = (await loanStore.all()).length;
    assert.equal(loansTotal, 3, `expected 3 loans total (2 migrated + 1 pre-existing), got ${loansTotal}`);
    pass("migration backfills fuzzy-deduped loans, skips OOO/linked, and is idempotent");
  });

  for (const line of results) console.log(line);
  console.log(`SUMMARY total=${results.length} passed=${results.length} failed=0`);
};

run().catch((error) => {
  console.error(`FAIL ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
