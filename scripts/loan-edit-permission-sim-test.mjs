#!/usr/bin/env node
/*
 * Only a task's two parties may change its loan (#266, ADR-0008 rule 5).
 *
 * This one runs against a REAL server over HTTP rather than against the
 * predicate or the source text, because the promise being kept is "refused on
 * the server as well as in the UI". ADR-0001 opened `PATCH /loans/:loanId` to
 * any authenticated user; a test that only asked the shared rule would have
 * gone on passing while the route ignored it.
 *
 * The rule itself is asked directly too, in the first section — it is a pure
 * function and the matrix of seats is cheap to sweep — but every one of those
 * answers is then made to happen over the wire.
 *
 * The server is spawned exactly the way `smoke-test.mjs` spawns it, with every
 * data file in a temp dir. The port starts well away from 4100 (the local dev
 * server) and walks up to the first free one.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

import {
  LOAN_EDIT_NEEDS_TASK,
  LOAN_EDIT_WRONG_LOAN,
  canEditLoanFrom,
  loanEditRefusal
} from "../packages/shared/dist/loan-edit.js";

const BASE_PORT = Number(process.env.LOAN_EDIT_PORT ?? 4310);

const CREATOR = { id: "loan-officer-1", name: "Suzie", roles: "LOAN_OFFICER" };
const CHECKER = { id: "file-checker-1", name: "Alexa", roles: "LOAN_OFFICER,FILE_CHECKER" };
const ADMIN = { id: "admin-1", name: "Johanna", roles: "LOAN_OFFICER,FILE_CHECKER,ADMIN" };
const OBSERVER = { id: "observer-officer", name: "Otto Observer", roles: "LOAN_OFFICER" };

const results = [];
const pass = (m) => results.push(`PASS ${m}`);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const identity = (u) => ({ id: u.id, displayName: u.name });

/* ── 1. The rule, asked directly ──────────────────────────────
   Cheap to sweep, and it is the definition both halves of the app import. What
   the sections below add is that the server actually consults it. */
{
  const task = (over = {}) => ({
    createdBy: identity(CREATOR),
    assignee: identity(CHECKER),
    status: "CLAIMED",
    ...over
  });

  assert.equal(loanEditRefusal(task(), identity(CREATOR)), undefined, "the creator may");
  assert.equal(loanEditRefusal(task(), identity(CHECKER)), undefined, "the assignee may");
  assert.ok(loanEditRefusal(task(), identity(OBSERVER)), "an observer may not");
  assert.ok(loanEditRefusal(task(), identity(ADMIN)), "an admin may not");
  /* ADR-0003: back-end access confers nothing over other people's work, so the
     admin refusal is the SAME sentence an observer gets. An admin is not a
     special case being turned down, they are simply not a party. */
  assert.equal(
    loanEditRefusal(task(), identity(ADMIN)),
    loanEditRefusal(task(), identity(OBSERVER)),
    "an admin is refused as an observer, not as an admin"
  );
  /* An unclaimed task has one party. A file checker who has not claimed it is
     an observer like anybody else — claiming is what makes them the second. */
  assert.ok(
    loanEditRefusal(task({ assignee: undefined, status: "OPEN" }), identity(CHECKER)),
    "an unclaimed file checker is refused"
  );
  assert.equal(
    loanEditRefusal(task({ assignee: undefined, status: "OPEN" }), identity(CREATOR)),
    undefined,
    "the creator of an unclaimed task may still correct its loan"
  );

  for (const status of ["COMPLETED", "CANCELLED", "ARCHIVED"]) {
    const frozen = loanEditRefusal(task({ status }), identity(CREATOR));
    assert.ok(frozen, `a party is refused on a ${status} task`);
    assert.match(frozen, /closed task/, "and told it is because the task is closed");
    /* Deliberately a different sentence from the party refusal: "you're not one
       of the two people" and "the two people can't either, any more" are
       different facts, and a party who reads the first would go looking for a
       permission problem that isn't there. */
    assert.notEqual(frozen, loanEditRefusal(task(), identity(OBSERVER)), "a distinct reason");
  }

  assert.equal(canEditLoanFrom(task(), identity(CREATOR)), true, "canEditLoanFrom agrees");
  assert.equal(canEditLoanFrom(task(), identity(ADMIN)), false, "…in both directions");
  pass("the rule admits the two parties, refuses everyone else, and freezes closed tasks");
}

/* ── The server ─────────────────────────────────────────────── */
const portIsFree = (port) =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });

const freePortFrom = async (preferred) => {
  for (let port = preferred; port < preferred + 50; port += 1) {
    if (await portIsFree(port)) return port;
  }
  throw new Error(`No free port near ${preferred}`);
};

const createServer = async () => {
  const port = await freePortFrom(BASE_PORT);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loan-edit-perm-"));
  const logs = [];
  const child = spawn(process.execPath, ["apps/server/dist/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_FILE: path.join(dir, "tasks.json"),
      LOANS_FILE: path.join(dir, "loans.json"),
      BOT_REFERENCES_FILE: path.join(dir, "bot-references.json"),
      ACTIVITY_FEED_STATE_FILE: path.join(dir, "activity-feed-state.json"),
      USERS_FILE: path.join(dir, "users.json"),
      ADMIN_SETTINGS_FILE: path.join(dir, "admin-settings.json")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (c) => logs.push(String(c)));
  child.stderr.on("data", (c) => logs.push(String(c)));

  let exited = false;
  child.once("exit", () => { exited = true; });

  const baseUrl = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let i = 0; i < 12; i += 1) {
    if (exited) throw new Error(`Server exited early. Logs:\n${logs.join("")}`);
    try {
      const health = await fetch(`${baseUrl}/api/health`);
      if (health.status === 200) { healthy = true; break; }
    } catch { /* not up yet */ }
    await delay(500);
  }
  if (!healthy) {
    child.kill("SIGTERM");
    throw new Error(`Server never became healthy on ${baseUrl}. Logs:\n${logs.join("")}`);
  }

  const stop = async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => { child.once("exit", resolve); setTimeout(resolve, 2000); });
  };
  return { baseUrl, stop };
};

const run = async () => {
  const server = await createServer();
  const call = async (method, route, { user, body } = {}) => {
    const response = await fetch(`${server.baseUrl}/api${route}`, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(user ? { "x-user-id": user.id, "x-user-name": user.name, "x-user-roles": user.roles } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : {} };
  };

  /* One LOI, filed by the creator and claimed by the checker: the everyday
     shape, with both seats filled and a loan behind it. */
  const file = async (over = {}) => {
    const created = await call("POST", "/tasks", {
      user: CREATOR,
      body: {
        taskType: "LOI",
        folderName: `Harbor ${Math.random().toString(36).slice(2, 8)}`,
        notes: "Amount 1.2M, 12 months, 9.5%",
        urgency: "GREEN",
        ...over
      }
    });
    assert.equal(created.status, 201, `filing failed: ${JSON.stringify(created.json)}`);
    return created.json.task;
  };

  const claim = async (task, user) => {
    const res = await call("POST", `/tasks/${task.id}/claim`, { user });
    assert.equal(res.status, 200, `claim failed: ${JSON.stringify(res.json)}`);
    return res.json.task;
  };

  try {
    /* ── 2. Both parties may, over the wire ───────────────────── */
    {
      const task = await claim(await file(), CHECKER);
      const asCreator = await call("PATCH", `/loans/${task.loanId}`, {
        user: CREATOR,
        body: { taskId: task.id, name: "Harbor - renamed by the requester" }
      });
      assert.equal(asCreator.status, 200, JSON.stringify(asCreator.json));
      assert.equal(asCreator.json.loan.name, "Harbor - renamed by the requester");

      const asChecker = await call("PATCH", `/loans/${task.loanId}`, {
        user: CHECKER,
        body: { taskId: task.id, name: "Harbor - renamed by the checker" }
      });
      assert.equal(asChecker.status, 200, JSON.stringify(asChecker.json));
      assert.equal(asChecker.json.loan.name, "Harbor - renamed by the checker");
      pass("the creator and the assignee can both correct the loan through their task");
    }

    /* ── 3. Everybody else is refused, by the server ──────────── */
    {
      const task = await claim(await file(), CHECKER);
      const before = (await call("GET", `/loans/${task.loanId}`, { user: CREATOR })).json.loan;

      for (const [who, user] of [["an observer", OBSERVER], ["an admin", ADMIN]]) {
        const res = await call("PATCH", `/loans/${task.loanId}`, {
          user,
          body: { taskId: task.id, name: "Rewritten by somebody with no stake" }
        });
        assert.equal(res.status, 403, `${who} was not refused: ${JSON.stringify(res.json)}`);
        /* The refusal names the rule rather than saying "forbidden": the person
           reading it has to be able to tell "I'm not allowed" from "I'm not one
           of the two people this belongs to". */
        assert.match(res.json.error, /requested this task|working it/, `${who} got a bare refusal`);
      }

      const after = (await call("GET", `/loans/${task.loanId}`, { user: CREATOR })).json.loan;
      assert.deepEqual(after, before, "a refused edit writes nothing at all");
      pass("an observer and an admin are refused on the server, and the record is untouched");
    }

    /* An unclaimed task's file checker is an observer until they claim it —
       exactly the person ADR-0008 rule 5 names. */
    {
      const task = await file();
      const res = await call("PATCH", `/loans/${task.loanId}`, {
        user: CHECKER,
        body: { taskId: task.id, name: "Renamed before claiming" }
      });
      assert.equal(res.status, 403, JSON.stringify(res.json));

      const claimed = await claim(task, CHECKER);
      const now = await call("PATCH", `/loans/${claimed.loanId}`, {
        user: CHECKER,
        body: { taskId: claimed.id, name: "Renamed after claiming" }
      });
      assert.equal(now.status, 200, JSON.stringify(now.json));
      pass("an unclaimed file checker is refused, and the same person may once they claim it");
    }

    /* ── 4. The request has to name a task, and the right one ── */
    {
      const task = await claim(await file(), CHECKER);
      const bare = await call("PATCH", `/loans/${task.loanId}`, {
        user: CREATOR,
        body: { name: "Renamed with no task behind it" }
      });
      assert.equal(bare.status, 400, JSON.stringify(bare.json));
      assert.equal(bare.json.error, LOAN_EDIT_NEEDS_TASK, "and it says why");

      /* A second loan, with a task the same person IS a party to. Being a party
         to that one confers nothing here — otherwise anybody who has ever filed
         a task could edit every loan in the system. */
      const elsewhere = await file();
      const crossed = await call("PATCH", `/loans/${task.loanId}`, {
        user: CREATOR,
        body: { taskId: elsewhere.id, name: "Renamed via somebody else's loan" }
      });
      /* 403, like the party refusal it is: the body is fine, the caller simply
         has no standing over this loan. A 400 here would let someone read
         "I typed it wrong" where the answer is "this isn't yours". */
      assert.equal(crossed.status, 403, JSON.stringify(crossed.json));
      assert.equal(crossed.json.error, LOAN_EDIT_WRONG_LOAN);

      const missing = await call("PATCH", `/loans/${task.loanId}`, {
        user: CREATOR,
        body: { taskId: "no-such-task", name: "Renamed via a task that isn't there" }
      });
      assert.equal(missing.status, 404, JSON.stringify(missing.json));
      pass("a loan edit naming no task, the wrong task, or no real task is refused");
    }

    /* ── 5. A closed task is frozen (ADR-0008 rule 6) ────────── */
    {
      const task = await claim(await file(), CHECKER);
      const done = await call("POST", `/tasks/${task.id}/transition`, {
        user: CHECKER,
        body: { status: "COMPLETED" }
      });
      assert.equal(done.status, 200, JSON.stringify(done.json));

      for (const user of [CREATOR, CHECKER]) {
        const res = await call("PATCH", `/loans/${task.loanId}`, {
          user,
          body: { taskId: task.id, name: "Corrected long after the fact" }
        });
        assert.equal(res.status, 403, `a party edited a closed task: ${JSON.stringify(res.json)}`);
        assert.match(res.json.error, /closed task/);
      }
      pass("neither party can edit a loan through a task they have closed");
    }

    /* ── 6. The merge confirm re-send is checked too (#265) ──── */
    {
      /* Two loans, each with its own claimed task, and the second's link is the
         one the first is about to be pointed at. */
      const held = await claim(await file(), CHECKER);
      const linked = await call("PATCH", `/loans/${held.loanId}`, {
        user: CREATOR,
        body: { taskId: held.id, humperdinkLink: "https://humperdink.example/Loans/Details/900001" }
      });
      assert.equal(linked.status, 200, JSON.stringify(linked.json));

      const mine = await claim(await file(), CHECKER);

      /* A party gets the 409 that asks the question. */
      const asks = await call("PATCH", `/loans/${mine.loanId}`, {
        user: CREATOR,
        body: { taskId: mine.id, humperdinkLink: "https://humperdink.example/Loans/Details/900001" }
      });
      assert.equal(asks.status, 409, JSON.stringify(asks.json));
      assert.ok(asks.json.collision, "and it names the other loan");

      /* An observer never gets that far. The refusal is 403 on the FIRST
         request, so there is no dialog to answer — a rule you only discover
         after saying yes to a merge is a rule that arrives too late. */
      const observerFirst = await call("PATCH", `/loans/${mine.loanId}`, {
        user: OBSERVER,
        body: { taskId: mine.id, humperdinkLink: "https://humperdink.example/Loans/Details/900001" }
      });
      assert.equal(observerFirst.status, 403, JSON.stringify(observerFirst.json));

      /* And the confirmed re-send — the identical body plus the flag — is
         judged by the same rule rather than trusted because it carries one. */
      const observerConfirmed = await call("PATCH", `/loans/${mine.loanId}`, {
        user: OBSERVER,
        body: {
          taskId: mine.id,
          humperdinkLink: "https://humperdink.example/Loans/Details/900001",
          confirmMerge: true
        }
      });
      assert.equal(observerConfirmed.status, 403, JSON.stringify(observerConfirmed.json));
      const loans = (await call("GET", "/loans", { user: CREATOR })).json.loans;
      assert.ok(loans.some((l) => l.id === mine.loanId), "and no merge happened behind the refusal");
      pass("the confirm re-send takes the same permission check as the save that asked");
    }

    /* ── 7. Creation is untouched (ticket design call 5) ─────── */
    {
      /* Filing still mints a loan for anyone who may file a task, including the
         observer who cannot edit one. This rule is about CHANGING an existing
         loan's name or link, and it must not have crept into `POST /loans` or
         into the resolve-on-create path. */
      const filed = await call("POST", "/tasks", {
        user: OBSERVER,
        body: {
          taskType: "LOI",
          folderName: "Observer's own new file",
          notes: "Amount 800k, 6 months",
          urgency: "GREEN"
        }
      });
      assert.equal(filed.status, 201, JSON.stringify(filed.json));
      assert.ok(filed.json.task.loanId, "filing minted or joined a loan with no task-party check");

      /* And filing against an existing loan with a link the loan lacks still
         fills it in — the create path's own dedupe, not an edit. */
      const bare = await call("POST", "/tasks", {
        user: CREATOR,
        body: { taskType: "LOI", folderName: "Linkless Loan", notes: "n", urgency: "GREEN" }
      });
      assert.equal(bare.status, 201, JSON.stringify(bare.json));
      const second = await call("POST", "/tasks", {
        user: OBSERVER,
        body: {
          taskType: "LOI",
          folderName: "Linkless Loan",
          notes: "n",
          urgency: "GREEN",
          humperdinkLink: "https://humperdink.example/Loans/Details/900777"
        }
      });
      assert.equal(second.status, 201, JSON.stringify(second.json));
      assert.equal(second.json.task.loanId, bare.json.task.loanId, "same loan, joined not minted");
      const filledIn = (await call("GET", `/loans/${bare.json.task.loanId}`, { user: CREATOR })).json.loan;
      assert.equal(
        filledIn.humperdinkLink,
        "https://humperdink.example/Loans/Details/900777",
        "a missing link is still filled at filing time, by a non-party"
      );
      pass("filing a task still creates, joins and completes a loan — the rule is about changing one");
    }
  } finally {
    await server.stop();
  }
};

run()
  .then(() => {
    for (const line of results) console.log(line);
    console.log(`SUMMARY total=${results.length} passed=${results.length} failed=0`);
  })
  .catch((error) => {
    for (const line of results) console.log(line);
    console.error(error);
    process.exit(1);
  });
