#!/usr/bin/env node
/* Sim test for the Loan entity (ADR-0001): the pure fuzzy-match/dedup helpers
   plus the file-backed LoanService (create/dedupe, edit propagation, the
   canonical-link merge and the refusal that now guards it, and the one-time
   migration). Mirrors the harness style of scheduler-sim-test.mjs — imports
   compiled dist, runs against temp files.

   Since #262 / ADR-0008 rule 7 a link edit that would fold this loan into
   another one is REFUSED rather than done, with neither record changing;
   merging is still built and still fires at task creation, and the edit path
   reaches it only with an explicit confirmation, which is #265's flow. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { v4 as uuid } from "uuid";

import {
  LOAN_MATCH_THRESHOLD,
  clusterLoanNames,
  deriveMyLoanIds,
  findLoanForCreate,
  loanNameSimilarity,
  loanTypeaheadSuggestions,
  nextHighlightIndex,
  normalizeLinkKey,
  normalizeLoanName,
  searchLoans
} from "../packages/shared/dist/loan.js";
import { parseHumperdinkPayload } from "../packages/shared/dist/humperdink.js";
import { applyImportedLoan, initialCreateForm } from "../apps/web/src/create-form-state.ts";
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

  // Numbered/serial variants must NOT fuzzy-merge: the digit run is loan
  // identity, so names that differ only by file/serial number stay distinct —
  // even though their string similarity is well above LOAN_MATCH_THRESHOLD.
  const numbered = clusterLoanNames([
    { name: "ABC Corp 1001" },
    { name: "ABC Corp 1002" },
    { name: "Loan 1001" },
    { name: "Loan 1002" },
    { name: "Smith Ln 12" },
    { name: "Smith Ln 13" },
    { name: "Johnson-4821" },
    { name: "Johnson-4827" }
  ]);
  assert.equal(numbered.length, 8, `numbered variants stay distinct, got ${numbered.length} clusters`);
  assert.ok(loanNameSimilarity("ABC Corp 1001", "ABC Corp 1002") >= LOAN_MATCH_THRESHOLD, "sanity: the pair is above threshold, so only the digit guard keeps them apart");
  pass("clusterLoanNames never fuzzy-merges names whose serial/file numbers differ");

  // A pure typo/spacing variant (identical digits, or none) still merges.
  const typos = clusterLoanNames([
    { name: "Acme  Corp" },
    { name: "Acme Corp" },
    { name: "ABC Corp 1001" },
    { name: "ABC  Corp 1001" }
  ]);
  assert.equal(typos.length, 2, `typo variants merge (same digit signature), got ${typos.length} clusters`);
  pass("clusterLoanNames still merges typo/spacing variants when digit signatures match");

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

  // ── "My loans" derivation (issue #55) ────────────────────
  const mineTasks = [
    { loanId: "l1", createdBy: { id: "me" } },   // mine
    { loanId: "l2", createdBy: { id: "other" } },// someone else's
    { loanId: "l3", createdBy: { id: "me" } },   // mine
    { loanId: "l1", createdBy: { id: "other" } },// still mine via the l1 task above
    { createdBy: { id: "me" } }                  // OOO / no loanId → ignored
  ];
  const mineIds = deriveMyLoanIds(mineTasks, "me");
  assert.deepEqual([...mineIds].sort(), ["l1", "l3"], "my loans = loans linked by tasks I created");
  pass("deriveMyLoanIds scopes loans to tasks the current user created");

  // ── Typeahead: empty query = my MRU shortlist; typing = global ─
  const older = "2026-01-01T00:00:00.000Z";
  const newer = "2026-06-01T00:00:00.000Z";
  const suggestLoans = [
    { id: "l1", name: "Smith 1042", createdAt: older, updatedAt: older },
    { id: "l2", name: "Smithson 88", createdAt: newer, updatedAt: newer },
    { id: "l3", name: "Jones 9000", createdAt: newer, updatedAt: newer }
  ];
  const emptyShortlist = loanTypeaheadSuggestions("", suggestLoans, mineIds, 8);
  assert.deepEqual(emptyShortlist.map((m) => m.loan.id), ["l3", "l1"], "empty query = only my loans, MRU (updatedAt desc)");
  const typed = loanTypeaheadSuggestions("smith", suggestLoans, mineIds, 8);
  assert.ok(typed.some((m) => m.loan.id === "l2"), "typing searches ALL loans, incl. ones not mine (l2)");
  assert.ok(!typed.some((m) => m.loan.id === "l3"), "typed search still filters by match score");
  const noneMine = loanTypeaheadSuggestions("", suggestLoans, new Set(), 8);
  assert.equal(noneMine.length, 0, "empty query with no loans of mine yields an empty shortlist");
  pass("loanTypeaheadSuggestions branches empty→my-MRU vs typed→global search");

  // ── Keyboard highlight wrap (issue #55) ──────────────────
  assert.equal(nextHighlightIndex(-1, 1, 3), 0, "ArrowDown from none → first");
  assert.equal(nextHighlightIndex(-1, -1, 3), 2, "ArrowUp from none → last");
  assert.equal(nextHighlightIndex(0, 1, 3), 1, "ArrowDown advances");
  assert.equal(nextHighlightIndex(2, 1, 3), 0, "ArrowDown wraps past the end");
  assert.equal(nextHighlightIndex(0, -1, 3), 2, "ArrowUp wraps past the start");
  assert.equal(nextHighlightIndex(1, 1, 0), -1, "empty list → none");
  pass("nextHighlightIndex wraps highlight across the suggestion list");

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

  /* #262 / ADR-0008 rule 7: the whole reason the edit form offers these two
     fields is that a name wrong on one task is wrong on all of them. "Every
     task" includes the finished ones — the muted line in the form says so — and
     it stops at the tasks on some OTHER loan. */
  await withTempDir(async ({ service, taskStore }) => {
    const loan = await service.create({ name: "Wrong Name" });
    const other = await service.create({ name: "Somebody Else's Loan" });
    const open = makeTask({ loanId: loan.id, folderName: "Wrong Name", loanName: "Wrong Name" });
    const archived = makeTask({ loanId: loan.id, folderName: "Wrong Name", loanName: "Wrong Name", status: "ARCHIVED" });
    const unrelated = makeTask({ loanId: other.id, folderName: "Somebody Else's Loan" });
    await taskStore.upsertTask(open);
    await taskStore.upsertTask(archived);
    await taskStore.upsertTask(unrelated);

    await service.update(loan.id, { name: "Right Name", humperdinkLink: "https://h.example/right" });

    for (const id of [open.id, archived.id]) {
      const after = await taskStore.findTask(id);
      assert.equal(after.folderName, "Right Name", `task ${id} shows the corrected name`);
      assert.equal(after.loanName, "Right Name", `task ${id} keeps its alias field in step`);
      assert.equal(after.humperdinkLink, "https://h.example/right", `task ${id} shows the corrected link`);
    }
    const untouched = await taskStore.findTask(unrelated.id);
    assert.equal(untouched.folderName, "Somebody Else's Loan", "another loan's task is untouched");
    pass("one loan edit corrects every task on that loan, finished ones included");
  });

  /* ADR-0008 rule 9, extended to these two fields: every applied edit is in the
     task's history with both values. A loan edit reaches many tasks, so each of
     them earns the row — it is the only place that records who renamed the loan
     under them and what it used to say. */
  await withTempDir(async ({ service, taskStore }) => {
    const actor = { id: "u-editor", displayName: "Casey Checker" };
    const loan = await service.create({ name: "Wrong Name", humperdinkLink: "https://h.example/old" });
    const a = makeTask({ loanId: loan.id, folderName: "Wrong Name" });
    const b = makeTask({ loanId: loan.id, folderName: "Wrong Name" });
    await taskStore.upsertTask(a);
    await taskStore.upsertTask(b);

    await service.update(loan.id, { name: "Right Name", humperdinkLink: "https://h.example/new" }, { actor });

    for (const id of [a.id, b.id]) {
      const history = await taskStore.allHistoryForTask(id);
      const renamed = history.find((e) => e.action === "TASK_LOAN_NAME_AMENDED");
      assert.ok(renamed, `task ${id} records the rename`);
      assert.ok(renamed.detail.includes("Wrong Name") && renamed.detail.includes("Right Name"), "with both values");
      assert.equal(renamed.by.id, actor.id, "and who did it");
      const relinked = history.find((e) => e.action === "TASK_LOAN_LINK_AMENDED");
      assert.ok(relinked, `task ${id} records the link change`);
      assert.ok(relinked.detail.includes("h.example/old") && relinked.detail.includes("h.example/new"), "with both values");
    }

    // A field that did not move earns no row, and neither does a save that
    // changed nothing at all.
    await service.update(loan.id, { name: "Right Name" }, { actor });
    const after = await taskStore.allHistoryForTask(a.id);
    assert.equal(after.filter((e) => e.action === "TASK_LOAN_NAME_AMENDED").length, 1, "a no-op rename writes nothing");
    assert.equal(after.filter((e) => e.action === "TASK_LOAN_LINK_AMENDED").length, 1, "and touches no other field");
    pass("a loan edit lands in every affected task's history with both values");
  });

  // ── A link edit onto another loan's link is refused (#262) ─
  await withTempDir(async ({ service, taskStore, loanStore }) => {
    const older = await service.create({ name: "First Record", humperdinkLink: "https://h.example/dup" });
    const newer = await service.create({ name: "Second Record" });
    const t2 = makeTask({ loanId: newer.id, folderName: "Second Record" });
    await taskStore.upsertTask(t2);

    await assert.rejects(
      () => service.update(newer.id, { name: "Renamed Too", humperdinkLink: "https://h.example/dup" }),
      (err) => {
        assert.equal(err.name, "LoanLinkCollisionError", "refused with the collision error");
        assert.equal(err.collision.loanId, older.id, "and it names the loan in the way");
        assert.ok(err.message.includes("First Record"), "by name, in the sentence the user reads");
        return true;
      }
    );

    const loans = await loanStore.all();
    assert.equal(loans.length, 2, "neither record was absorbed");
    const stillNewer = await loanStore.find(newer.id);
    assert.equal(stillNewer.name, "Second Record", "the refused rename did not land");
    assert.equal(stillNewer.humperdinkLink, undefined, "and neither did the refused link");
    const stillOlder = await loanStore.find(older.id);
    assert.equal(stillOlder.humperdinkLink, "https://h.example/dup", "the other loan is untouched");
    const task = await taskStore.findTask(t2.id);
    assert.equal(task.loanId, newer.id, "the task did not repoint");
    assert.equal(task.folderName, "Second Record", "and shows no half-applied rename");
    pass("a link edit that would merge two loans is refused, and nothing changes");
  });

  /* The refusal is about a link that MOVES onto another loan's. Renaming, or
     re-saving the link the loan already has, must still go through. */
  await withTempDir(async ({ service }) => {
    await service.create({ name: "First Record", humperdinkLink: "https://h.example/dup" });
    const mine = await service.create({ name: "Mine", humperdinkLink: "https://h.example/mine" });
    const renamed = await service.update(mine.id, { name: "Mine, Corrected" });
    assert.equal(renamed.loan.name, "Mine, Corrected", "a rename with no link change is never refused");
    const resaved = await service.update(mine.id, { name: "Mine Again", humperdinkLink: "https://h.example/mine" });
    assert.equal(resaved.loan.name, "Mine Again", "re-saving a loan's own link is not a collision with itself");
    pass("only a link edit that lands on ANOTHER loan's link is refused");
  });

  // ── Canonical-link merge, once it is confirmed (#262) ────
  await withTempDir(async ({ service, taskStore, loanStore }) => {
    const older = await service.create({ name: "First Record", humperdinkLink: "https://h.example/dup" });
    // Force a distinct newer loan with no link yet, then give it the same link.
    const newer = await service.create({ name: "Second Record" });
    const t1 = makeTask({ loanId: older.id, folderName: "First Record" });
    const t2 = makeTask({ loanId: newer.id, folderName: "Second Record" });
    await taskStore.upsertTask(t1);
    await taskStore.upsertTask(t2);
    const res = await service.update(newer.id, { humperdinkLink: "https://h.example/dup" }, { confirmMerge: true });
    assert.ok(res.merged, "update reports a merge notice");
    assert.equal(res.merged.intoLoanId, older.id, "newer merges into the older original");
    const remaining = await loanStore.all();
    assert.equal(remaining.length, 1, "only the surviving loan remains");
    assert.ok((remaining[0].aliases ?? []).includes("Second Record"), "merged name kept as an alias");
    const t2After = await taskStore.findTask(t2.id);
    assert.equal(t2After.loanId, older.id, "the duplicate's task repoints to the survivor");
    assert.equal(t2After.folderName, "First Record", "repointed task shows the survivor's name");
    pass("a confirmed merge folds the loans together and repoints tasks");
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

  // ── Migration keeps numbered loans separate end-to-end ───
  await withTempDir(async ({ service, taskStore, loanStore }) => {
    const t1 = makeTask({ folderName: "ABC Corp 1001" });
    const t2 = makeTask({ folderName: "ABC Corp 1002" });
    const t3 = makeTask({ folderName: "Loan 1001" });
    const t4 = makeTask({ folderName: "Loan 1002" });
    const t5 = makeTask({ folderName: "Acme  Corp" }); // typo variant of t6
    const t6 = makeTask({ folderName: "Acme Corp" });
    for (const t of [t1, t2, t3, t4, t5, t6]) await taskStore.upsertTask(t);

    const res = await service.migrateExistingTasks();
    // ABC 1001, ABC 1002, Loan 1001, Loan 1002 = 4 distinct; Acme pair = 1.
    assert.equal(res.loansCreated, 5, `expected 5 loans, got ${res.loansCreated}`);

    const idOf = async (id) => (await taskStore.findTask(id)).loanId;
    assert.notEqual(await idOf(t1.id), await idOf(t2.id), "ABC Corp 1001/1002 migrate to separate loans");
    assert.notEqual(await idOf(t3.id), await idOf(t4.id), "Loan 1001/1002 migrate to separate loans");
    assert.equal(await idOf(t5.id), await idOf(t6.id), "Acme Corp typo variant still merges");
    assert.equal((await loanStore.all()).length, 5, "five distinct loans persisted");
    pass("migration keeps serial-numbered loans distinct while merging true typo variants");
  });

  /* ── A Humperdink import lands on the existing loan (#194) ─

     The whole point of shipping the link with the name: the URL is the
     canonical key (ADR-0001), so a task filed from an imported payload joins
     the loan that URL already names instead of minting a second one. Runs the
     real parser and the real create-form reducer into the real service, so a
     change on any of the three that broke the join would show up here. */
  await withTempDir(async ({ service, loanStore }) => {
    const loanUrl = "https://humperdink.loneoakfund.com/Loans/Details/335203";
    // The loan already exists in Hot Task, filed by hand some weeks ago and
    // spelled differently by whoever typed it.
    const existing = await service.create({ name: "adams harbor", humperdinkLink: loanUrl });

    const pasted = JSON.stringify({
      kind: "hot-task-humperdink",
      version: 1,
      loanName: "Adams - Harbor",
      loanUrl
    });
    const parsed = parseHumperdinkPayload(pasted);
    assert.equal(parsed.ok, true, "the pasted payload parses");
    const form = applyImportedLoan(initialCreateForm(), parsed.payload);
    assert.equal(form.folderName, "Adams - Harbor", "Folder Name filled from the payload");
    assert.equal(form.humperdinkLink, loanUrl, "Humperdink Link filled from the payload");
    assert.equal(form.loanId, "", "no loan is pre-selected — the link resolves it");

    const linked = await service.resolveForTask({
      loanId: form.loanId || undefined,
      name: form.folderName,
      humperdinkLink: form.humperdinkLink
    });
    assert.equal(linked.id, existing.id, "the imported task links to the existing loan for that URL");
    assert.equal((await loanStore.all()).length, 1, "no duplicate loan was created");
    pass("a task created from an imported Humperdink payload joins the existing loan for that URL");
  });

  /* Same page, second visit: the URL Humperdink hands back can differ in case
     or a trailing slash, which normalizeLinkKey already folds. Pinned here
     because the import is the first thing feeding it machine-produced URLs. */
  await withTempDir(async ({ service, loanStore }) => {
    const first = await service.create({
      name: "Adams - Harbor",
      humperdinkLink: "https://humperdink.loneoakfund.com/Loans/Details/335203"
    });
    const again = await service.resolveForTask({
      name: "Adams - Harbor (rush)",
      humperdinkLink: "https://Humperdink.LoneOakFund.com/Loans/Details/335203/"
    });
    assert.equal(again.id, first.id, "a case/slash variant of the same page is the same loan");
    assert.equal((await loanStore.all()).length, 1, "still one loan");
    pass("importing the same loan page twice never mints a second loan");
  });

  for (const line of results) console.log(line);
  console.log(`SUMMARY total=${results.length} passed=${results.length} failed=0`);
};

run().catch((error) => {
  console.error(`FAIL ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
