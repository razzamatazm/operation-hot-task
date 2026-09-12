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
  canonicalHumperdinkLink,
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
import { backupStores } from "../apps/server/dist/data-backup.js";
import { updateLoanSchema } from "../apps/server/dist/validation.js";
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

  /* #370: a Humperdink loan has a page per tab, and every one of them is the
     same loan. The link is stored and compared as the Details page. */
  {
    const DETAILS = "https://humperdink.loneoakfund.com/Loans/Details/329366-SL";
    const pages = ["Details", "Docs", "DueDiligence", "Funding"].map(
      (page) => `https://humperdink.loneoakfund.com/Loans/${page}/329366-SL`
    );
    for (const page of pages) {
      assert.equal(canonicalHumperdinkLink(page), DETAILS, `${page} collapses to the Details page`);
      assert.equal(normalizeLinkKey(page), normalizeLinkKey(DETAILS), `${page} keys as the Details page`);
    }
    const spellings = [
      "  https://humperdink.loneoakfund.com/Loans/Docs/329366-SL  ",
      "https://WWW.Humperdink.LoneOakFund.com/Loans/Docs/329366-SL",
      "https://humperdink.loneoakfund.com/loans/funding/329366-sl/",
      "http://humperdink.loneoakfund.com/Loans/DueDiligence/329366-SL",
      "https://humperdink.loneoakfund.com/Loans/Funding/329366-SL?tab=wire#top",
      "https://humperdink.loneoakfund.com/Loans/Details/329366-SL/#notes"
    ];
    for (const spelling of spellings) {
      assert.equal(canonicalHumperdinkLink(spelling), DETAILS, `tolerated: ${JSON.stringify(spelling)}`);
    }
    const leftAlone = [
      "https://humperdink.example.com/loans/seed-loan-alvarez",
      "https://humperdink.loneoakfund.com/Loans/Details/335203",
      "https://humperdink.loneoakfund.com/Loans/Docs/329366-SL/Attachments",
      "https://humperdink.loneoakfund.com/Borrowers/Docs/329366-SL",
      "https://elsewhere.example/Loans/Docs/329366-SL",
      "not a url at all"
    ];
    for (const link of leftAlone) {
      assert.equal(canonicalHumperdinkLink(link), link, `left as it is: ${link}`);
    }
    assert.equal(canonicalHumperdinkLink("  https://h.example/x  "), "https://h.example/x", "a non-matching link is only trimmed");
    assert.equal(canonicalHumperdinkLink(""), "", "empty stays empty");
    assert.equal(canonicalHumperdinkLink(undefined), "", "absent reads as empty");
    assert.notEqual(
      normalizeLinkKey("https://humperdink.loneoakfund.com/Loans/Docs/329366-SL"),
      normalizeLinkKey("https://humperdink.loneoakfund.com/Loans/Docs/329367-SL"),
      "a different loan number is a different loan"
    );
    pass("every page of a Humperdink loan collapses to its Details URL, and nothing else is rewritten");
  }

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
        /* Which way the merge would go, so the confirm can say it (#265). The
           OLDER record survives, which here is the OTHER loan — the one being
           edited is the one that would disappear, and a dialog that assumed the
           opposite would promise the reverse of what happens. The rename
           travelling with the link change is the name it reports, because that is
           what the person just typed and what they would see. */
        assert.equal(err.collision.survivingName, "First Record", "the older record survives");
        assert.equal(err.collision.absorbedName, "Renamed Too", "and the edited one is what gets absorbed");
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

  /* The other direction, so the reported survivor is derived and not assumed:
     edit the OLDER loan onto a newer one's link and the edited record is the one
     that survives. Same refusal, opposite names in it. */
  await withTempDir(async ({ service }) => {
    const older = await service.create({ name: "First Record" });
    // Distinct createdAt: the survivor is decided by age, so they must differ.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await service.create({ name: "Second Record", humperdinkLink: "https://h.example/dup" });
    assert.ok(newer.createdAt > older.createdAt, "the second record really is newer");
    await assert.rejects(
      () => service.update(older.id, { humperdinkLink: "https://h.example/dup" }),
      (err) => {
        assert.equal(err.collision.survivingName, "First Record", "the loan being edited survives, being older");
        assert.equal(err.collision.absorbedName, "Second Record", "and the other one is what gets absorbed");
        return true;
      }
    );
    pass("the refusal reports which record would survive, in either direction");
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

  /* ── #370: links are stored, and collide, as the Details page ── */
  const hdLink = (page, id) => `https://humperdink.loneoakfund.com/Loans/${page}/${id}`;

  await withTempDir(async ({ service, taskStore }) => {
    const actor = { id: "u-editor", displayName: "Casey Checker" };
    const made = await service.create({ name: "Beacon", humperdinkLink: `  ${hdLink("Funding", "329366-SL")}?tab=wire ` });
    assert.equal(made.humperdinkLink, hdLink("Details", "329366-SL"), "a new loan stores the Details page");
    const joined = await service.resolveForTask({ name: "Beacon (rush)", humperdinkLink: hdLink("Docs", "329366-SL") });
    assert.equal(joined.id, made.id, "filing from another page of the same loan joins it");

    const bare = await service.create({ name: "Lighthouse" });
    const task = makeTask({ loanId: bare.id, folderName: "Lighthouse" });
    await taskStore.upsertTask(task);
    const filled = await service.resolveForTask({ loanId: bare.id, name: "Lighthouse", humperdinkLink: hdLink("Docs", "329370-ab") });
    assert.equal(filled.humperdinkLink, hdLink("Details", "329370-AB"), "a link filled in at filing is stored as the Details page");
    assert.equal((await taskStore.findTask(task.id)).humperdinkLink, hdLink("Details", "329370-AB"), "and so is the task's copy");

    await service.update(bare.id, { humperdinkLink: hdLink("Funding", "329370-AB") }, { actor });
    const history = await taskStore.allHistoryForTask(task.id);
    assert.equal(
      history.filter((e) => e.action === "TASK_LOAN_LINK_AMENDED").length,
      0,
      "pasting another page of the same loan moves nothing and records nothing"
    );

    const moved = await service.update(bare.id, { humperdinkLink: hdLink("DueDiligence", "329371-CD") }, { actor });
    assert.equal(moved.loan.humperdinkLink, hdLink("Details", "329371-CD"), "an edited link is stored as the Details page");
    assert.equal((await taskStore.findTask(task.id)).humperdinkLink, hdLink("Details", "329371-CD"), "on every task too");
    pass("filing, joining and editing store a Humperdink link as its Details page");
  });

  await withTempDir(async ({ service, loanStore }) => {
    const holder = await service.create({ name: "Alvarez", humperdinkLink: hdLink("Details", "329366-SL") });
    const other = await service.create({ name: "Castillo" });
    await assert.rejects(
      () => service.update(other.id, { humperdinkLink: hdLink("Docs", "329366-SL") }),
      (err) => {
        assert.equal(err.name, "LoanLinkCollisionError", "the Docs page of a held loan raises the merge question");
        assert.equal(err.collision.loanId, holder.id, "naming the loan that holds its Details page");
        return true;
      }
    );
    assert.equal((await loanStore.find(other.id)).humperdinkLink, undefined, "on the first try, with nothing written");
    const res = await service.update(other.id, { humperdinkLink: hdLink("Docs", "329366-SL") }, { confirmMerge: true });
    assert.equal(res.merged?.intoLoanId, holder.id, "a yes merges them");
    assert.equal(res.loan.humperdinkLink, hdLink("Details", "329366-SL"), "onto the Details page");
    pass("pasting a loan's Docs URL where another loan holds its Details URL raises the merge question");
  });

  /* After the start-up rewrite two records can hold the SAME Details link. They
     are not merged there; the merge question handles it the next time a link is
     saved onto either record. In the app that is a paste from another tab (the
     edit form sends only a link whose text changed); the service also asks when
     an API caller re-sends the link the record already has. */
  await withTempDir(async ({ service, loanStore }) => {
    const details = hdLink("Details", "401122-AB");
    await loanStore.replaceAll([
      { id: "loan-a", name: "Castillo", humperdinkLink: details, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "loan-b", name: "Castillo Docs", humperdinkLink: details, createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" }
    ]);
    await assert.rejects(
      () => service.update("loan-b", { humperdinkLink: hdLink("Docs", "401122-AB") }),
      (err) => err.name === "LoanLinkCollisionError" && err.collision.loanId === "loan-a",
      "saving the newer record's link asks about the older one"
    );
    await assert.rejects(
      () => service.update("loan-a", { humperdinkLink: details }),
      (err) => err.name === "LoanLinkCollisionError" && err.collision.loanId === "loan-b",
      "and saving the older record's own link asks about the newer one"
    );
    const renamed = await service.update("loan-a", { name: "Castillo Ranch" });
    assert.equal(renamed.loan.name, "Castillo Ranch", "a rename alone is still never refused");
    assert.equal((await loanStore.all()).length, 2, "nothing merged without a yes");
    pass("two records left holding one link raise the merge question when either link is saved");
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

  /* ── #370: stored links are rewritten once, at start-up ────
     Backed up first. Records that land on one link are NOT merged; each
     collision is reported, and the merge question handles it on the next save
     of either link (tested above). */
  await withTempDir(async ({ service, taskStore, loanStore, tasksFile, loansFile }) => {
    const seedLink = "https://humperdink.example.com/loans/seed-loan-alvarez";
    const at = (day) => `2026-0${day}-01T00:00:00.000Z`;
    await loanStore.replaceAll([
      { id: "loan-docs", name: "Castillo", humperdinkLink: hdLink("Docs", "329366-SL"), createdAt: at(1), updatedAt: at(1) },
      { id: "loan-details", name: "Castillo Ranch", humperdinkLink: hdLink("Details", "329366-SL"), createdAt: at(2), updatedAt: at(2) },
      { id: "loan-funding", name: "Beacon", humperdinkLink: `${hdLink("Funding", "500100-xy")}?tab=wire`, createdAt: at(3), updatedAt: at(3) },
      { id: "loan-seed", name: "Alvarez", humperdinkLink: seedLink, createdAt: at(4), updatedAt: at(4) }
    ]);
    const onDocs = makeTask({ loanId: "loan-docs", folderName: "Castillo", humperdinkLink: hdLink("Docs", "329366-SL") });
    const onSeed = makeTask({ loanId: "loan-seed", folderName: "Alvarez", humperdinkLink: seedLink });
    await taskStore.upsertTask(onDocs);
    await taskStore.upsertTask(onSeed);
    const tasksBefore = await fs.readFile(tasksFile, "utf8");
    const loansBefore = await fs.readFile(loansFile, "utf8");

    const backupsDir = path.join(path.dirname(tasksFile), "backups");
    let backupsTaken = 0;
    const backup = async () => {
      backupsTaken += 1;
      // Nothing may be rewritten before the copy exists.
      assert.equal(await fs.readFile(loansFile, "utf8"), loansBefore, "the backup is taken before anything is written");
      return backupStores([taskStore, loanStore], backupsDir);
    };

    const first = await service.canonicalizeStoredLinks({ backup });
    assert.equal(backupsTaken, 1, "one backup, taken first");
    const [stamp, ...extra] = await fs.readdir(backupsDir);
    assert.equal(extra.length, 0, "into one folder");
    assert.equal(await fs.readFile(path.join(backupsDir, stamp, "tasks.json"), "utf8"), tasksBefore, "holding the tasks as they were");
    assert.equal(await fs.readFile(path.join(backupsDir, stamp, "loans.json"), "utf8"), loansBefore, "and the loans as they were");
    assert.equal(first.backupDir, path.join(backupsDir, stamp), "and says where it went");

    assert.equal(first.loansRewritten, 2, "the Docs and Funding loans are rewritten");
    assert.equal(first.tasksRewritten, 1, "and the task that copied a Docs link");
    const loans = await loanStore.all();
    assert.equal(loans.length, 4, "no record is merged or dropped");
    const linkOf = (id) => loans.find((l) => l.id === id).humperdinkLink;
    assert.equal(linkOf("loan-docs"), hdLink("Details", "329366-SL"));
    assert.equal(linkOf("loan-funding"), hdLink("Details", "500100-XY"));
    assert.equal(linkOf("loan-seed"), seedLink, "a link of another shape is left alone");
    const docsTask = await taskStore.findTask(onDocs.id);
    assert.equal(docsTask.humperdinkLink, hdLink("Details", "329366-SL"), "the task's copy follows");
    assert.equal(docsTask.updatedAt, onDocs.updatedAt, "without dragging the task up the list");
    assert.equal((await taskStore.allHistoryForTask(onDocs.id)).length, 0, "and without a history row: nobody acted on it");
    assert.equal((await taskStore.findTask(onSeed.id)).humperdinkLink, seedLink);

    assert.deepEqual(
      first.collisions,
      [
        {
          link: hdLink("Details", "329366-SL"),
          loans: [
            { id: "loan-docs", name: "Castillo" },
            { id: "loan-details", name: "Castillo Ranch" }
          ]
        }
      ],
      "the two records now on one link are reported, not merged"
    );

    const second = await service.canonicalizeStoredLinks({ backup });
    assert.equal(backupsTaken, 1, "a second start-up finds nothing, so takes no backup");
    assert.equal(second.loansRewritten + second.tasksRewritten, 0, "and rewrites nothing");
    assert.equal(second.backupDir, undefined);
    assert.deepEqual(second.collisions, first.collisions, "but reports the unmerged pair again, every start-up it lasts");
    pass("start-up rewrites stored links to Details pages after a backup, reports collisions, merges nothing, and is idempotent");
  });

  {
    const boot = await fs.readFile(new URL("../apps/server/src/index.ts", import.meta.url), "utf8");
    const rewrite = boot.indexOf("loanService.canonicalizeStoredLinks(");
    assert.ok(rewrite > 0, "the server runs the link rewrite at start-up");
    assert.ok(rewrite < boot.indexOf("loanService.migrateExistingTasks("), "before the loan backfill clusters on links");
    assert.match(boot.slice(rewrite, rewrite + 400), /backupStores\(\[store, loanStore\]/, "and hands it the backup of both files");
    assert.ok(rewrite < boot.indexOf("app.listen("), "before the server takes a request");
    pass("the link rewrite is wired into start-up, with its backup, ahead of everything that reads links");
  }

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

  /* ── #265: the confirmation is the ONLY thing that changed ──
     The merge itself, and the refusal that guards it, are #262's and are tested
     above. What this ticket adds is a way to answer the refusal, so what is
     pinned here is the shape of that answer: the flag is accepted on the wire,
     it means nothing on its own, and the route hands it to the service. */
  {
    const yes = updateLoanSchema.parse({ humperdinkLink: "https://h.example/dup", confirmMerge: true });
    assert.equal(yes.confirmMerge, true, "the wire carries a merge confirmation");
    const plain = updateLoanSchema.parse({ humperdinkLink: "https://h.example/dup" });
    assert.equal(plain.confirmMerge, undefined, "and a first save carries none, so it is refused");
    assert.throws(
      () => updateLoanSchema.parse({ confirmMerge: true }),
      /name and\/or humperdinkLink/,
      "confirming nothing is not an edit — the flag is an answer, not a field"
    );
    pass("a loan edit can carry a merge confirmation, which on its own edits nothing");
  }

  {
    const routes = await fs.readFile(new URL("../apps/server/src/routes.ts", import.meta.url), "utf8");
    const from = routes.indexOf('router.patch("/loans/:loanId"');
    assert.ok(from > 0, "PATCH /loans/:loanId still exists");
    const handler = routes.slice(from, routes.indexOf("\n  router.", from + 1));
    assert.match(
      handler.replace(/\s+/g, " "),
      /\.\.\.\(input\.confirmMerge \? \{ confirmMerge: true \} : \{\}\)/,
      "the route sets the flag only when the caller sent one — never unconditionally"
    );
    pass("the loan route forwards the confirmation rather than assuming one");
  }

  /* Merging at task CREATION is a different door and this ticket must not have
     touched it: `create`/`resolveForTask` fold a new record into an existing one
     by link, with nothing to confirm, because nobody's tasks are absorbed —
     there is no second record yet. */
  await withTempDir(async ({ service, loanStore }) => {
    const first = await service.create({ name: "Harbor 41", humperdinkLink: "https://h.example/harbor" });
    const second = await service.create({ name: "Harbor Forty One", humperdinkLink: "https://h.example/harbor" });
    assert.equal(second.id, first.id, "creating with a taken link joins that loan, unasked");
    const viaTask = await service.resolveForTask({ name: "Harbor 41 (rush)", humperdinkLink: "https://h.example/harbor" });
    assert.equal(viaTask.id, first.id, "and so does filing a task against it");
    assert.equal((await loanStore.all()).length, 1, "still one loan, no confirmation anywhere");
    pass("merges at task creation need no confirmation and are unchanged by #265");
  });

  /* ── #266: the service is not the gate, and must not become one ──
     Who may edit a loan is a question about a TASK — its creator, its assignee,
     its status — and `LoanService` knows about none of those. The rule therefore
     lives on the route, which is where the actor and the task both are, and the
     service keeps taking any edit handed to it. That is deliberate rather than
     an oversight: the create path calls straight into the same service, and a
     permission check buried in `update` would either have to be bypassed there
     or would start refusing people filing tasks. What is pinned here is that the
     route really does the checking, and does it before anything is written. */
  {
    const routes = await fs.readFile(new URL("../apps/server/src/routes.ts", import.meta.url), "utf8");
    const from = routes.indexOf('router.patch("/loans/:loanId"');
    const handler = routes.slice(from, routes.indexOf("\n  router.", from + 1));
    const flat = handler.replace(/\s+/g, " ");

    assert.match(flat, /if \(!input\.taskId\) \{ throw new Error\(LOAN_EDIT_NEEDS_TASK\); \}/,
      "a loan edit with no task behind it is refused, in words");
    assert.match(flat, /const editedFrom = await service\.getTask\(input\.taskId\)/,
      "the named task is loaded");
    assert.match(flat, /if \(editedFrom\.loanId !== req\.params\.loanId\)/,
      "and has to actually be on this loan");
    assert.match(flat, /const refusal = loanEditRefusal\(editedFrom, actor\)/,
      "the shared rule decides, not a second copy of it here");
    assert.match(flat, /if \(refusal\) \{ res\.status\(403\)\.json\(\{ error: refusal \}\); return; \}/,
      "and the refusal that comes back IS what the caller is told");

    /* Order matters as much as presence. Every check sits ahead of the call that
       writes, so a refused edit never reaches the service — and the merge branch
       is downstream of all of it, which is what stops a confirmed re-send from
       being a way in. */
    assert.ok(
      flat.indexOf("const refusal = loanEditRefusal") < flat.indexOf("await loanService.update"),
      "the rule runs before anything is written"
    );
    assert.ok(
      flat.indexOf("const refusal = loanEditRefusal") < flat.indexOf("input.confirmMerge"),
      "including on the confirmed re-send — no refusal is reachable only after a dialog"
    );

    /* ADR-0003: back-end access confers nothing over other people's work. */
    assert.ok(!/isAdmin|ADMIN/.test(handler), "no admin bypass anywhere in the handler");
    pass("the loan route checks the task and its parties before it writes anything");
  }

  /* Creation is a different door and this ticket does not touch it (#266). The
     service still mints, joins and completes a loan for anyone filing a task —
     the rule is about CHANGING an existing loan's name or link. Proved here at
     the service, and again over real HTTP in loan-edit-permission-sim-test. */
  await withTempDir(async ({ service, loanStore }) => {
    const made = await service.create({ name: "Filed by anybody" });
    assert.ok(made.id, "create takes no actor and asks no permission");
    const joined = await service.resolveForTask({ name: "Filed by anybody" });
    assert.equal(joined.id, made.id, "and so does resolving one for a new task");
    const filled = await service.resolveForTask({
      name: "Filed by anybody",
      humperdinkLink: "https://h.example/filed"
    });
    assert.equal(filled.id, made.id, "still the same loan");
    assert.equal(filled.humperdinkLink, "https://h.example/filed", "with its missing link filled in");
    assert.equal((await loanStore.all()).length, 1);
    pass("creating and joining a loan is untouched — the rule is about changing one");
  });

  for (const line of results) console.log(line);
  console.log(`SUMMARY total=${results.length} passed=${results.length} failed=0`);
};

run().catch((error) => {
  console.error(`FAIL ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
