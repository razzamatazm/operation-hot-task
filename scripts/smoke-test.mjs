#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";

/* 4100 is also the local dev server's port, so `npm run dev` and this suite
   can't both have it. It's a preference, not a requirement — createServer walks
   up to the first free port — and SMOKE_PORT overrides the starting point. */
const BASE_PORT = Number(process.env.SMOKE_PORT ?? 4100);

// Identities aligned with the local dev cast in scripts/reset-dev-data.mjs so
// any task that somehow leaks into dev data is at least tagged to a real
// current user. (The web app no longer keeps a copy of that cast — since #309
// its user switcher reads the server's active-user directory.) `otherOfficer`
// is a smoke-only synthetic identity — there is no second non-checker loan
// officer in the seed cast — and the prefix makes it obvious in any data file
// it appears in.
const users = {
  creator: {
    id: "loan-officer-1",
    name: "Suzie",
    roles: "LOAN_OFFICER"
  },
  otherOfficer: {
    id: "smoke-other-officer",
    name: "Smoke Other Officer",
    roles: "LOAN_OFFICER"
  },
  fileChecker: {
    id: "file-checker-1",
    name: "Alexa",
    roles: "LOAN_OFFICER,FILE_CHECKER"
  },
  admin: {
    id: "admin-1",
    name: "Johanna",
    roles: "LOAN_OFFICER,FILE_CHECKER,ADMIN"
  }
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseJson = async (response) => {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
};

const request = async (baseUrl, method, route, { user, body, headers } = {}) => {
  const finalHeaders = {
    ...(body ? { "content-type": "application/json" } : {}),
    ...(user
      ? {
          "x-user-id": user.id,
          "x-user-name": user.name,
          "x-user-roles": user.roles
        }
      : {}),
    ...(headers ?? {})
  };

  const response = await fetch(`${baseUrl}/api${route}`, {
    method,
    headers: finalHeaders,
    body: body ? JSON.stringify(body) : undefined
  });

  return {
    status: response.status,
    json: await parseJson(response)
  };
};

const expectStatus = (actual, expected, label, payload) => {
  try {
    assert.equal(actual, expected);
  } catch {
    throw new Error(`${label}: expected HTTP ${expected}, got ${actual}. Payload=${JSON.stringify(payload)}`);
  }
};

/* Is this port free for us to bind? A port already held by something else —
   `npm run dev` uses 4100, the same default this suite does — used to be
   invisible: our child died of EADDRINUSE while the health probe cheerfully got
   its 200 from the squatter, and the whole suite then exercised THAT server's
   code. Probing first (and the child-exit guard in createServer) closes it. */
const portIsFree = (port) =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });

/* First free port at or after `preferred`, so a running dev server just moves
   the suite along instead of breaking it. */
const freePortFrom = async (preferred) => {
  for (let port = preferred; port < preferred + 50; port += 1) {
    if (await portIsFree(port)) {
      return port;
    }
  }
  throw new Error(`No free port found near ${preferred}`);
};

const createServer = async (preferredPort, extraEnv = {}, { botReferences } = {}) => {
  const port = await freePortFrom(preferredPort);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loan-smoke-"));
  const dataFile = path.join(tempDir, "tasks.json");
  const botRefs = path.join(tempDir, "bot-references.json");
  const activityStateFile = path.join(tempDir, "activity-feed-state.json");
  /* Users and admin settings must be temp-scoped too. Left unset they fall back
     to the repo's committed data dir, which a local dev server also writes to —
     so anyone who had run `npm run dev` (and thereby registered an extra admin)
     would see the "cannot demote the last admin" case fail here for reasons
     that have nothing to do with the code under test. */
  const usersFile = path.join(tempDir, "users.json");
  const adminSettingsFile = path.join(tempDir, "admin-settings.json");

  // Optionally pre-seed stored bot DM references so the share flow can report
  // delivered=true for a "bot-onboarded" user (issue #41). Written before the
  // server starts so its reference-store init leaves the seed intact.
  if (botReferences) {
    await fs.writeFile(botRefs, JSON.stringify(botReferences), "utf8");
  }

  const logs = [];
  const child = spawn(process.execPath, ["apps/server/dist/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_FILE: dataFile,
      BOT_REFERENCES_FILE: botRefs,
      ACTIVITY_FEED_STATE_FILE: activityStateFile,
      USERS_FILE: usersFile,
      ADMIN_SETTINGS_FILE: adminSettingsFile,
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  /* If our child dies (EADDRINUSE is the usual reason — `npm run dev` already
     holds this port) the health probe below would happily get a 200 from the
     STRANGER that owns it, and the whole suite would then test that server's
     code instead of the build under test. Silent false passes, so: notice the
     exit and fail loudly. Set SMOKE_PORT to run alongside a dev server. */
  let childExited = false;
  child.once("exit", () => { childExited = true; });

  const baseUrl = `http://127.0.0.1:${port}`;

  let healthy = false;
  for (let i = 0; i < 12; i += 1) {
    if (childExited) {
      throw new Error(
        `Server exited before becoming healthy — port ${port} is probably already in use ` +
        `(set SMOKE_PORT to pick another). Logs:\n${logs.join("")}`
      );
    }
    try {
      const health = await fetch(`${baseUrl}/api/health`);
      if (health.status === 200) {
        healthy = true;
        break;
      }
    } catch {
      // not ready yet
    }
    await delay(500);
  }

  if (!healthy) {
    child.kill("SIGTERM");
    throw new Error(`Server failed to become healthy on ${baseUrl}. Logs:\n${logs.join("")}`);
  }

  const stop = async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      child.once("exit", resolve);
      setTimeout(resolve, 2000);
    });
  };

  return {
    baseUrl,
    stop,
    logs
  };
};

const run = async () => {
  const results = [];

  const pushPass = (message) => {
    results.push(`PASS ${message}`);
  };

  const pushFail = (message) => {
    results.push(`FAIL ${message}`);
  };

  let server;
  try {
    server = await createServer(BASE_PORT);

    const health = await request(server.baseUrl, "GET", "/health");
    expectStatus(health.status, 200, "health check", health.json);
    pushPass("health endpoint responds");

    const createLoi = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: {
        loanName: "Smoke LOI",
        taskType: "LOI",
        notes: "smoke-loi"
      }
    });
    expectStatus(createLoi.status, 201, "create LOI", createLoi.json);
    const loiTask = createLoi.json.task;
    assert.equal(loiTask.status, "OPEN");
    assert.equal(loiTask.urgency, "GREEN");
    assert.equal(loiTask.points, 0);
    assert.equal(loiTask.folderName, "Smoke LOI");
    assert.equal(loiTask.loanName, "Smoke LOI");
    pushPass("create LOI defaults applied");
    pushPass("tasks default Poops to 0 (unrated)");
    pushPass("legacy loanName payload maps to canonical folderName");

    const greenDueMs = new Date(loiTask.dueAt).getTime() - new Date(loiTask.createdAt).getTime();
    assert.ok(greenDueMs > 0, "GREEN dueAt should be in the future");
    pushPass("default GREEN urgency computes a future backend due date");

    const createBuddyChat = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: {
        folderName: "Smoke Buddy Chat",
        taskType: "BUDDY_CHAT",
        notes: "smoke-buddy-chat"
      }
    });
    expectStatus(createBuddyChat.status, 201, "create BUDDY_CHAT", createBuddyChat.json);
    assert.equal(createBuddyChat.json.task.taskType, "BUDDY_CHAT");
    pushPass("BUDDY_CHAT task type accepted by create validation");

    const createOrange = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: {
        folderName: "Smoke Orange",
        taskType: "VALUE",
        points: 5,
        urgency: "ORANGE",
        notes: "smoke-orange"
      }
    });
    expectStatus(createOrange.status, 201, "create ORANGE task", createOrange.json);
    const orangeTask = createOrange.json.task;
    assert.equal(orangeTask.points, 5);
    const orangeDueMs = new Date(orangeTask.dueAt).getTime() - new Date(orangeTask.createdAt).getTime();
    assert.ok(orangeDueMs >= 55 * 60 * 1000 && orangeDueMs <= 65 * 60 * 1000, `ORANGE due delta expected ~1h, got ${orangeDueMs}`);
    pushPass("ORANGE urgency default due is approximately 1 hour");
    pushPass("create accepts Poops in 1-5 range");

    const createRed = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: {
        folderName: "Smoke Red",
        taskType: "LOI",
        urgency: "RED",
        notes: "smoke-red"
      }
    });
    expectStatus(createRed.status, 201, "create RED task", createRed.json);
    const redTask = createRed.json.task;
    const redDueMs = new Date(redTask.dueAt).getTime() - new Date(redTask.createdAt).getTime();
    assert.ok(redDueMs >= -60 * 1000 && redDueMs <= 60 * 1000, `RED due delta expected immediate, got ${redDueMs}`);
    pushPass("RED urgency default due is immediate");

    const createOoo = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: {
        folderName: "OOO Coverage",
        taskType: "OOO",
        startDate: "2099-01-01",
        returnDate: "2099-01-02",
        notes: "cover while away"
      }
    });
    expectStatus(createOoo.status, 201, "create OOO task", createOoo.json);
    const oooTask = createOoo.json.task;
    assert.equal(oooTask.taskType, "OOO");
    assert.equal(oooTask.urgency, "GREEN");
    assert.equal(oooTask.startDate, "2099-01-01");
    assert.equal(oooTask.returnDate, "2099-01-02");
    const oooDue = new Date(oooTask.dueAt);
    const oooDuePt = oooDue.toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
    assert.ok(oooDuePt.includes("01/02/2099, 08:30"), `OOO due should map to 8:30am PT, got ${oooDuePt}`);
    pushPass("OOO task uses return date due at 8:30 AM PT and GREEN urgency");

    const createOooMissingReturnDate = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: {
        folderName: "OOO Missing Return Date",
        taskType: "OOO",
        startDate: "2099-01-01",
        notes: "missing return date"
      }
    });
    expectStatus(createOooMissingReturnDate.status, 400, "create OOO missing return date", createOooMissingReturnDate.json);
    pushPass("OOO task requires returnDate");

    const createOooMissingStartDate = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: {
        folderName: "OOO Missing Start Date",
        taskType: "OOO",
        returnDate: "2099-01-02",
        notes: "missing start date"
      }
    });
    expectStatus(createOooMissingStartDate.status, 400, "create OOO missing start date", createOooMissingStartDate.json);
    pushPass("OOO task requires startDate");

    const createOooWithUrgency = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: {
        folderName: "OOO With Urgency",
        taskType: "OOO",
        returnDate: "2099-01-03",
        urgency: "YELLOW",
        notes: "invalid urgency"
      }
    });
    expectStatus(createOooWithUrgency.status, 400, "create OOO with urgency", createOooWithUrgency.json);
    pushPass("OOO task rejects urgency");

    const createOooPastDate = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: {
        folderName: "OOO Past Date",
        taskType: "OOO",
        returnDate: "2020-01-01",
        notes: "past return date"
      }
    });
    expectStatus(createOooPastDate.status, 400, "create OOO past date", createOooPastDate.json);
    pushPass("OOO return date must be in the future");

    const createNonOooWithReturnDate = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: {
        folderName: "LOI With Return Date",
        taskType: "LOI",
        returnDate: "2099-01-03",
        notes: "invalid return date on non-OOO"
      }
    });
    expectStatus(createNonOooWithReturnDate.status, 400, "create non-OOO with returnDate", createNonOooWithReturnDate.json);
    pushPass("non-OOO task rejects returnDate");

    const createWithZeroPoints = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: {
        folderName: "Zero Poops",
        taskType: "LOI",
        points: 0,
        notes: "unrated"
      }
    });
    expectStatus(createWithZeroPoints.status, 201, "create with 0 points (unrated)", createWithZeroPoints.json);
    assert.equal(createWithZeroPoints.json.task.points, 0);

    const createWithSixPoints = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: {
        folderName: "Invalid Six Poops",
        taskType: "LOI",
        points: 6,
        notes: "invalid points"
      }
    });
    expectStatus(createWithSixPoints.status, 400, "create with 6 points", createWithSixPoints.json);

    const createWithFractionalPoints = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: {
        folderName: "Invalid Fractional Poops",
        taskType: "LOI",
        points: 2.5,
        notes: "invalid points"
      }
    });
    expectStatus(createWithFractionalPoints.status, 400, "create with non-integer points", createWithFractionalPoints.json);
    pushPass("create rejects out-of-range / non-integer Poops, allows 0 as unrated");

    const updatePointsDenied = await request(server.baseUrl, "POST", `/tasks/${loiTask.id}/points`, {
      user: users.otherOfficer,
      body: { points: 4 }
    });
    expectStatus(updatePointsDenied.status, 400, "post-create points update is blocked for non-creator", updatePointsDenied.json);
    pushPass("post-create Poops update blocked for non-creator");

    const updatePointsByCreator = await request(server.baseUrl, "POST", `/tasks/${loiTask.id}/points`, {
      user: users.creator,
      body: { points: 4 }
    });
    expectStatus(updatePointsByCreator.status, 200, "creator updates points after create", updatePointsByCreator.json);
    assert.equal(updatePointsByCreator.json.task.points, 4);

    const clearPointsByCreator = await request(server.baseUrl, "POST", `/tasks/${loiTask.id}/points`, {
      user: users.creator,
      body: { points: 0 }
    });
    expectStatus(clearPointsByCreator.status, 200, "creator clears points to 0", clearPointsByCreator.json);
    assert.equal(clearPointsByCreator.json.task.points, 0);
    pushPass("creator can update and clear Poops after create");

    const claimByOther = await request(server.baseUrl, "POST", `/tasks/${loiTask.id}/claim`, {
      user: users.otherOfficer
    });
    expectStatus(claimByOther.status, 200, "claim by other officer", claimByOther.json);
    assert.equal(claimByOther.json.task.assignee.id, users.otherOfficer.id);
    pushPass("first-come claim works");

    const unclaimDenied = await request(server.baseUrl, "POST", `/tasks/${loiTask.id}/unclaim`, {
      user: users.creator
    });
    expectStatus(unclaimDenied.status, 400, "unclaim denied for a non-assignee", unclaimDenied.json);
    pushPass("unclaim denied for unauthorized user");

    // ADR-0003: admin is back-end access only. This used to assert 200 — an
    // admin could take a task off whoever held it. Moving a stuck task is what
    // handoff is for, and handoff needs no admin.
    const unclaimByAdmin = await request(server.baseUrl, "POST", `/tasks/${loiTask.id}/unclaim`, {
      user: users.admin
    });
    expectStatus(unclaimByAdmin.status, 400, "unclaim refused for an admin bystander", unclaimByAdmin.json);
    pushPass("an admin cannot unclaim somebody else's task");

    const unclaimByAssignee = await request(server.baseUrl, "POST", `/tasks/${loiTask.id}/unclaim`, {
      user: users.otherOfficer
    });
    expectStatus(unclaimByAssignee.status, 200, "unclaim by assignee", unclaimByAssignee.json);
    assert.equal(unclaimByAssignee.json.task.status, "OPEN");
    pushPass("the assignee can unclaim");

    // ADR-0003: the creator is never the assignee. This used to assert 200 —
    // the API happily let a creator claim their own task and only the web row
    // said otherwise.
    const claimByCreator = await request(server.baseUrl, "POST", `/tasks/${loiTask.id}/claim`, {
      user: users.creator
    });
    expectStatus(claimByCreator.status, 400, "creator refused their own task", claimByCreator.json);
    assert.match(
      claimByCreator.json.error ?? "",
      /second pair of hands/,
      "the refusal says which rule refused"
    );
    pushPass("a creator cannot claim their own task");

    // Someone else takes it, so the rest of the lifecycle has a real assignee.
    const reclaimByOther = await request(server.baseUrl, "POST", `/tasks/${loiTask.id}/claim`, {
      user: users.otherOfficer
    });
    expectStatus(reclaimByOther.status, 200, "claim by other officer", reclaimByOther.json);

    const details = await request(server.baseUrl, "GET", `/tasks/${loiTask.id}`);
    expectStatus(details.status, 200, "task details", details.json);
    assert.ok(Array.isArray(details.json.allowedTransitions), "allowedTransitions must be returned");
    pushPass("task details returns allowed transitions");

    // The corrections state is the assignee's to enter and the creator's to
    // leave (ADR-0007).
    const needsReview = await request(server.baseUrl, "POST", `/tasks/${loiTask.id}/transition`, {
      user: users.otherOfficer,
      // A note is required to enter corrections (#231): the state means the
      // checker found something, so the finding has to be written down.
      body: { status: "NEEDS_REVIEW", reviewNotes: "borrower name is misspelt" }
    });
    expectStatus(needsReview.status, 200, "claimed->needs_review", needsReview.json);
    pushPass("claimed to needs_review transition works for the assignee");

    const backToClaimed = await request(server.baseUrl, "POST", `/tasks/${loiTask.id}/transition`, {
      user: users.creator,
      body: { status: "CLAIMED" }
    });
    expectStatus(backToClaimed.status, 200, "needs_review->claimed", backToClaimed.json);

    /* This task came back to its assignee by way of corrections, so their
       confirm closes AND archives it, over the wire, in this one request
       (#238, ADR-0007 rule 5) — nobody is left tidying away somebody else's
       request. The archival that used to follow here is gone with it; every
       other path still takes two steps, which the "only the assignee can
       complete" task below goes on to prove. */
    const completed = await request(server.baseUrl, "POST", `/tasks/${loiTask.id}/transition`, {
      user: users.otherOfficer,
      body: { status: "COMPLETED" }
    });
    expectStatus(completed.status, 200, "claimed->completed", completed.json);
    assert.equal(completed.json.task.status, "ARCHIVED", "a confirm after corrections archives in the same action");
    assert.ok(completed.json.task.completedAt, "and still records that the task was completed");
    assert.ok(completed.json.task.archivedAt, "and archived");
    pushPass("core LOI lifecycle works to archived");

    const updatePointsArchived = await request(server.baseUrl, "POST", `/tasks/${loiTask.id}/points`, {
      user: users.creator,
      body: { points: 5 }
    });
    expectStatus(updatePointsArchived.status, 400, "cannot update points after archive", updatePointsArchived.json);
    pushPass("Poops updates remain blocked for closed statuses");

    // Completion belongs to the assignee, not the creator. When someone else
    // claims a task, the creator must not be able to complete it.
    const completeRuleTask = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: { folderName: "Complete Rule", taskType: "LOI", notes: "who completes" }
    });
    const completeRuleId = completeRuleTask.json.task.id;
    await request(server.baseUrl, "POST", `/tasks/${completeRuleId}/claim`, { user: users.fileChecker });
    const creatorCompleteDenied = await request(server.baseUrl, "POST", `/tasks/${completeRuleId}/transition`, {
      user: users.creator,
      body: { status: "COMPLETED" }
    });
    expectStatus(creatorCompleteDenied.status, 400, "creator cannot complete another user's task", creatorCompleteDenied.json);
    const assigneeComplete = await request(server.baseUrl, "POST", `/tasks/${completeRuleId}/transition`, {
      user: users.fileChecker,
      body: { status: "COMPLETED" }
    });
    expectStatus(assigneeComplete.status, 200, "assignee can complete", assigneeComplete.json);
    pushPass("only the assignee can complete a task");

    const history = await request(server.baseUrl, "GET", `/tasks/${loiTask.id}/history`, {
      user: users.creator
    });
    expectStatus(history.status, 200, "task history", history.json);
    assert.ok(Array.isArray(history.json.history), "history list missing");
    assert.ok(history.json.history.length >= 6, `expected at least 6 history entries, got ${history.json.history.length}`);
    pushPass("history endpoint records lifecycle events");

    const cancelTask = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: {
        folderName: "Cancel Me",
        taskType: "VALUE",
        notes: "cancel test"
      }
    });
    const cancelId = cancelTask.json.task.id;

    const cancelDenied = await request(server.baseUrl, "POST", `/tasks/${cancelId}/transition`, {
      user: users.otherOfficer,
      body: { status: "CANCELLED" }
    });
    expectStatus(cancelDenied.status, 400, "cancel denied for non creator/non admin", cancelDenied.json);

    const cancelByCreator = await request(server.baseUrl, "POST", `/tasks/${cancelId}/transition`, {
      user: users.creator,
      body: { status: "CANCELLED" }
    });
    expectStatus(cancelByCreator.status, 200, "cancel by creator", cancelByCreator.json);
    pushPass("creator cancel permissions enforced");

    // ADR-0003: cancelling somebody else's task is exactly the second-identity
    // power admin no longer has. This used to assert 200.
    const cancelByAdminTask = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: {
        folderName: "Cancel By Admin",
        taskType: "VALUE",
        notes: "admin cancel test"
      }
    });
    const cancelByAdmin = await request(server.baseUrl, "POST", `/tasks/${cancelByAdminTask.json.task.id}/transition`, {
      user: users.admin,
      body: { status: "CANCELLED" }
    });
    expectStatus(cancelByAdmin.status, 400, "cancel refused for an admin bystander", cancelByAdmin.json);
    pushPass("cancel is the creator's move, not an admin's");

    // Restore: a reopened task offers a path back to the exact closed status it
    // held before the reopen, available to whoever reopened it (creator or
    // assignee) — NOT assignee-gated the way normal Complete is.
    const restoreTask = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: { folderName: "Restore To Completed", taskType: "LOI", notes: "restore completed" }
    });
    const restoreId = restoreTask.json.task.id;
    await request(server.baseUrl, "POST", `/tasks/${restoreId}/claim`, { user: users.otherOfficer });
    const restoreCompleted = await request(server.baseUrl, "POST", `/tasks/${restoreId}/transition`, {
      user: users.otherOfficer,
      body: { status: "COMPLETED" }
    });
    expectStatus(restoreCompleted.status, 200, "assignee completes restore task", restoreCompleted.json);
    // Creator reopens their own completed task — it returns to CLAIMED (assignee
    // retained) and remembers COMPLETED as the restore target.
    const reopened = await request(server.baseUrl, "POST", `/tasks/${restoreId}/transition`, {
      user: users.creator,
      body: { status: "OPEN" }
    });
    expectStatus(reopened.status, 200, "creator reopens completed task", reopened.json);
    assert.equal(reopened.json.task.status, "CLAIMED", "reopened task retains assignee as CLAIMED");
    assert.equal(reopened.json.task.reopenedFrom, "COMPLETED", "reopen remembers prior closed status");
    const reopenedDetails = await request(server.baseUrl, "GET", `/tasks/${restoreId}`);
    assert.ok(
      reopenedDetails.json.allowedTransitions.includes("COMPLETED"),
      "restore target is offered as an allowed transition"
    );
    // A third party (neither creator nor assignee) cannot restore.
    const restoreDenied = await request(server.baseUrl, "POST", `/tasks/${restoreId}/transition`, {
      user: users.fileChecker,
      body: { status: "COMPLETED" }
    });
    expectStatus(restoreDenied.status, 400, "restore denied for non creator/assignee", restoreDenied.json);
    // The creator who reopened can restore it back to COMPLETED without the
    // assignee having to act.
    const restored = await request(server.baseUrl, "POST", `/tasks/${restoreId}/transition`, {
      user: users.creator,
      body: { status: "COMPLETED" }
    });
    expectStatus(restored.status, 200, "creator restores to completed", restored.json);
    assert.equal(restored.json.task.status, "COMPLETED", "restore returns task to COMPLETED");
    assert.equal(restored.json.task.reopenedFrom, undefined, "restore breadcrumb cleared once closed");
    pushPass("reopened task can be restored to COMPLETED by whoever reopened it");

    // Restoring an ARCHIVED task returns it to ARCHIVED (not just COMPLETED).
    const restoreArchTask = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: { folderName: "Restore To Archived", taskType: "LOI", notes: "restore archived" }
    });
    const restoreArchId = restoreArchTask.json.task.id;
    await request(server.baseUrl, "POST", `/tasks/${restoreArchId}/claim`, { user: users.otherOfficer });
    await request(server.baseUrl, "POST", `/tasks/${restoreArchId}/transition`, {
      user: users.otherOfficer,
      body: { status: "COMPLETED" }
    });
    await request(server.baseUrl, "POST", `/tasks/${restoreArchId}/transition`, {
      user: users.creator,
      body: { status: "ARCHIVED" }
    });
    const reopenedArch = await request(server.baseUrl, "POST", `/tasks/${restoreArchId}/transition`, {
      user: users.creator,
      body: { status: "OPEN" }
    });
    expectStatus(reopenedArch.status, 200, "creator reopens archived task", reopenedArch.json);
    assert.equal(reopenedArch.json.task.reopenedFrom, "ARCHIVED", "reopen from archived remembers ARCHIVED");
    // ADR-0003: restore belongs to whoever could have reopened it — creator or
    // assignee. An admin who is neither is refused, where they used to be
    // allowed.
    const restoreArchByAdmin = await request(server.baseUrl, "POST", `/tasks/${restoreArchId}/transition`, {
      user: users.admin,
      body: { status: "ARCHIVED" }
    });
    expectStatus(restoreArchByAdmin.status, 400, "restore refused for an admin bystander", restoreArchByAdmin.json);
    const restoredArch = await request(server.baseUrl, "POST", `/tasks/${restoreArchId}/transition`, {
      user: users.creator,
      body: { status: "ARCHIVED" }
    });
    expectStatus(restoredArch.status, 200, "creator restores to archived", restoredArch.json);
    assert.equal(restoredArch.json.task.status, "ARCHIVED", "restore returns task to ARCHIVED");
    assert.equal(restoredArch.json.task.reopenedFrom, undefined, "restore breadcrumb cleared after re-archive");
    pushPass("reopened archived task restores to ARCHIVED, not COMPLETED");

    const creatorReviewTask = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: {
        folderName: "Creator Review Permission",
        taskType: "LOI",
        notes: "creator review permission"
      }
    });
    const creatorReviewId = creatorReviewTask.json.task.id;
    const creatorReviewClaim = await request(server.baseUrl, "POST", `/tasks/${creatorReviewId}/claim`, {
      user: users.otherOfficer
    });
    expectStatus(creatorReviewClaim.status, 200, "creator review claim", creatorReviewClaim.json);
    const creatorCannotReview = await request(server.baseUrl, "POST", `/tasks/${creatorReviewId}/transition`, {
      user: users.creator,
      body: { status: "NEEDS_REVIEW" }
    });
    expectStatus(creatorCannotReview.status, 400, "creator refused needs corrections on their own request", creatorCannotReview.json);
    assert.match(creatorCannotReview.json.error ?? "", /only the assignee/i, "the refusal names the rule");
    pushPass("a creator cannot send their own request to needs_review (ADR-0007)");

    const fraudTask = await request(server.baseUrl, "POST", "/tasks", {
      user: users.admin,
      body: {
        folderName: "Fraud Restricted",
        taskType: "FRAUD",
        notes: "fraud permission"
      }
    });
    const fraudId = fraudTask.json.task.id;

    const fraudClaimDenied = await request(server.baseUrl, "POST", `/tasks/${fraudId}/claim`, {
      user: users.creator
    });
    expectStatus(fraudClaimDenied.status, 400, "fraud claim denied for non-file-checker", fraudClaimDenied.json);

    const fraudClaimAllowed = await request(server.baseUrl, "POST", `/tasks/${fraudId}/claim`, {
      user: users.fileChecker
    });
    expectStatus(fraudClaimAllowed.status, 200, "fraud claim by file checker", fraudClaimAllowed.json);

    // FRAUD two-phase completion (#39): the checker sends outstanding items,
    // the requester (creator = admin here) submits them for approval, then the
    // checker approves to the terminal COMPLETED.
    // Hand-back cannot go out empty — AWAITING_ITEMS requires an outstanding-items note.
    const fraudSendItemsNoNote = await request(server.baseUrl, "POST", `/tasks/${fraudId}/transition`, {
      user: users.fileChecker,
      body: { status: "AWAITING_ITEMS" }
    });
    expectStatus(fraudSendItemsNoNote.status, 400, "fraud hand-back requires a note", fraudSendItemsNoNote.json);

    const fraudSendItems = await request(server.baseUrl, "POST", `/tasks/${fraudId}/transition`, {
      user: users.fileChecker,
      body: { status: "AWAITING_ITEMS", reviewNotes: "Need 2023 tax returns and a photo ID" }
    });
    expectStatus(fraudSendItems.status, 200, "fraud send outstanding items by file checker", fraudSendItems.json);
    assert.ok(
      (fraudSendItems.json.task.reviewNotes ?? []).some((note) => note.text === "Need 2023 tax returns and a photo ID"),
      "outstanding-items note is recorded on the task"
    );

    const fraudSubmitByChecker = await request(server.baseUrl, "POST", `/tasks/${fraudId}/transition`, {
      user: users.fileChecker,
      body: { status: "PENDING_APPROVAL" }
    });
    expectStatus(fraudSubmitByChecker.status, 400, "fraud submit-for-approval denied for checker", fraudSubmitByChecker.json);

    const fraudSubmitForApproval = await request(server.baseUrl, "POST", `/tasks/${fraudId}/transition`, {
      user: users.admin,
      body: { status: "PENDING_APPROVAL" }
    });
    expectStatus(fraudSubmitForApproval.status, 200, "fraud submit for approval by requester", fraudSubmitForApproval.json);

    const fraudCompleteAllowed = await request(server.baseUrl, "POST", `/tasks/${fraudId}/transition`, {
      user: users.fileChecker,
      body: { status: "COMPLETED" }
    });
    expectStatus(fraudCompleteAllowed.status, 200, "fraud approve by file checker", fraudCompleteAllowed.json);
    pushPass("fraud two-phase completion enforced and file checker path works");

    // FRAUD "Release for any fraud checker" (#39): a PENDING_APPROVAL task whose
    // original checker is OOO can be released to the pool by the creator, then
    // claimed + approved by any other FILE_CHECKER.
    const releaseFraud = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: { folderName: "Fraud Release", taskType: "FRAUD", notes: "release path" }
    });
    const releaseFraudId = releaseFraud.json.task.id;
    await request(server.baseUrl, "POST", `/tasks/${releaseFraudId}/claim`, { user: users.fileChecker });
    await request(server.baseUrl, "POST", `/tasks/${releaseFraudId}/transition`, {
      user: users.fileChecker,
      body: { status: "AWAITING_ITEMS", reviewNotes: "Need proof of funds" }
    });
    await request(server.baseUrl, "POST", `/tasks/${releaseFraudId}/transition`, {
      user: users.creator,
      body: { status: "PENDING_APPROVAL" }
    });

    // Release is a creator/admin action — the assignee alone cannot self-release.
    const releaseDenied = await request(server.baseUrl, "POST", `/tasks/${releaseFraudId}/release`, {
      user: users.fileChecker
    });
    expectStatus(releaseDenied.status, 400, "release denied for non creator/admin", releaseDenied.json);

    const released = await request(server.baseUrl, "POST", `/tasks/${releaseFraudId}/release`, {
      user: users.creator
    });
    expectStatus(released.status, 200, "creator releases for any fraud checker", released.json);
    assert.equal(released.json.task.status, "PENDING_APPROVAL", "released task stays in PENDING_APPROVAL");
    assert.equal(released.json.task.assignee, undefined, "release clears the assignee");

    // A different FILE_CHECKER (admin) claims the released task — status stays
    // PENDING_APPROVAL (not reopened) — and approves directly to COMPLETED.
    const reclaim = await request(server.baseUrl, "POST", `/tasks/${releaseFraudId}/claim`, {
      user: users.admin
    });
    expectStatus(reclaim.status, 200, "another file checker claims the released task", reclaim.json);
    assert.equal(reclaim.json.task.status, "PENDING_APPROVAL", "claiming a released task keeps PENDING_APPROVAL");
    assert.equal(reclaim.json.task.assignee.id, users.admin.id, "claimer becomes the new assignee");
    const reclaimApprove = await request(server.baseUrl, "POST", `/tasks/${releaseFraudId}/transition`, {
      user: users.admin,
      body: { status: "COMPLETED" }
    });
    expectStatus(reclaimApprove.status, 200, "new checker approves the released task", reclaimApprove.json);
    pushPass("fraud release-for-any-checker unassigns in place, then any checker claims + approves");

    const loanDocsTask = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: {
        folderName: "Loan Docs Path",
        taskType: "LOAN_DOCS",
        notes: "loan docs flow"
      }
    });
    const loanDocsId = loanDocsTask.json.task.id;

    /* ADR-0003: the creator can't claim their own task, so the merge chain runs
       with a real second party — which is what it was always modelling. The
       assignee does the merge and the completion; the creator approves it in
       between, exactly as the completion chain describes. */
    const loanDocsClaim = await request(server.baseUrl, "POST", `/tasks/${loanDocsId}/claim`, {
      user: users.otherOfficer
    });
    expectStatus(loanDocsClaim.status, 200, "loan docs claimed by a second user", loanDocsClaim.json);

    const invalidLoanDocsComplete = await request(server.baseUrl, "POST", `/tasks/${loanDocsId}/transition`, {
      user: users.creator,
      body: { status: "COMPLETED" }
    });
    expectStatus(invalidLoanDocsComplete.status, 400, "loan docs cannot skip merge steps", invalidLoanDocsComplete.json);

    const mergeDone = await request(server.baseUrl, "POST", `/tasks/${loanDocsId}/transition`, {
      user: users.otherOfficer,
      body: { status: "MERGE_DONE" }
    });
    expectStatus(mergeDone.status, 200, "loan docs merge_done", mergeDone.json);

    const mergeApproved = await request(server.baseUrl, "POST", `/tasks/${loanDocsId}/transition`, {
      user: users.creator,
      body: { status: "MERGE_APPROVED" }
    });
    expectStatus(mergeApproved.status, 200, "loan docs merge_approved", mergeApproved.json);

    const loanDocsComplete = await request(server.baseUrl, "POST", `/tasks/${loanDocsId}/transition`, {
      user: users.otherOfficer,
      body: { status: "COMPLETED" }
    });
    expectStatus(loanDocsComplete.status, 200, "loan docs completed", loanDocsComplete.json);

    const loanDocsArchive = await request(server.baseUrl, "POST", `/tasks/${loanDocsId}/transition`, {
      user: users.creator,
      body: { status: "ARCHIVED" }
    });
    expectStatus(loanDocsArchive.status, 200, "loan docs archived", loanDocsArchive.json);
    pushPass("loan docs flow enforces merge stages");

    // ── Share a task directly with a person (issue #41) ──────
    const shareTask = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: { folderName: "Share Me", taskType: "LOI", notes: "share test" }
    });
    const shareId = shareTask.json.task.id;

    // Any authenticated user can read the minimal people directory (not admin-
    // gated). It exposes id + displayName + roles only, and includes known
    // users. Roles arrived with the Handoff (ADR-0002) so the picker can filter
    // to people eligible to work the task; email/active stay admin-only.
    const directoryRead = await request(server.baseUrl, "GET", "/users/directory", {
      user: users.creator
    });
    expectStatus(directoryRead.status, 200, "non-admin can read people directory", directoryRead.json);
    assert.ok(Array.isArray(directoryRead.json.users), "directory returns a users array");
    assert.ok(
      directoryRead.json.users.some((u) => u.id === users.fileChecker.id),
      "directory includes a known user"
    );
    assert.ok(
      directoryRead.json.users.every((u) => Object.keys(u).sort().join(",") === "displayName,id,roles"),
      "directory entries expose only id + displayName + roles"
    );
    assert.ok(
      directoryRead.json.users.every((u) => Array.isArray(u.roles)),
      "every directory entry carries a roles array the picker can filter on"
    );
    pushPass("people directory is readable by any authenticated user, id + name + roles only");

    // The dev-only twin of that directory (#309). The local user switcher needs
    // the cast BEFORE it can be anybody, and every authenticated route
    // registers its caller — so asking through one would invent a placeholder
    // person and write them into the list being read. This route takes no
    // identity, and must answer exactly what the authenticated one does.
    const devRoster = await request(server.baseUrl, "GET", "/dev/users");
    expectStatus(devRoster.status, 200, "dev roster readable with no identity", devRoster.json);
    assert.deepEqual(
      devRoster.json,
      directoryRead.json,
      "the dev roster is the same active-people list the pickers read"
    );

    // The point of the unauthenticated route: it must not have created the
    // caller it had no name for. A header-less request falls back to
    // `local-user` in auth.ts, and a provisioning route would put that ghost in
    // the very roster the switcher offers.
    const rosterAfter = await request(server.baseUrl, "GET", "/users", { user: users.admin });
    expectStatus(rosterAfter.status, 200, "admin user list after dev roster read", rosterAfter.json);
    assert.ok(
      !rosterAfter.json.users.some((u) => u.id === "local-user"),
      "reading the dev roster registers nobody"
    );
    pushPass("dev roster reads the same active list with no identity, and registers nobody");

    const shareOk = await request(server.baseUrl, "POST", `/tasks/${shareId}/share`, {
      user: users.creator,
      body: { targetUserId: users.fileChecker.id }
    });
    expectStatus(shareOk.status, 200, "share task with a known user", shareOk.json);
    assert.equal(shareOk.json.ok, true, "share returns ok");
    // This server has no stored bot references, so the DM can't reach the
    // target — the share still succeeds but reports delivered=false so the UI
    // can tell the sharer to have them message the bot first (issue #41).
    assert.equal(shareOk.json.delivered, false, "share to a user with no bot reference reports not-delivered");
    pushPass("share reports delivered=false when the target has no bot reference");

    // Optional note is accepted (issue #41 = people-picker + optional note).
    const shareWithNote = await request(server.baseUrl, "POST", `/tasks/${shareId}/share`, {
      user: users.creator,
      body: { targetUserId: users.fileChecker.id, note: "take a look when you get a sec" }
    });
    expectStatus(shareWithNote.status, 200, "share with an optional note", shareWithNote.json);
    assert.equal(shareWithNote.json.ok, true, "share-with-note returns ok");
    pushPass("share accepts an optional note");

    const shareRecorded = await request(server.baseUrl, "GET", `/tasks/${shareId}/history`, {
      user: users.creator
    });
    assert.ok(
      shareRecorded.json.history.some((event) => event.action === "TASK_SHARED"),
      "share is recorded in task history"
    );
    pushPass("share is recorded in task history for audit");

    const shareNoTarget = await request(server.baseUrl, "POST", `/tasks/${shareId}/share`, {
      user: users.creator,
      body: {}
    });
    expectStatus(shareNoTarget.status, 400, "share without targetUserId is rejected", shareNoTarget.json);

    const shareUnknownUser = await request(server.baseUrl, "POST", `/tasks/${shareId}/share`, {
      user: users.creator,
      body: { targetUserId: "nobody-here" }
    });
    expectStatus(shareUnknownUser.status, 404, "share with unknown user is rejected", shareUnknownUser.json);

    const shareUnknownTask = await request(server.baseUrl, "POST", "/tasks/nonexistent-task/share", {
      user: users.creator,
      body: { targetUserId: users.fileChecker.id }
    });
    expectStatus(shareUnknownTask.status, 404, "share of unknown task is rejected", shareUnknownTask.json);
    pushPass("share validates target user and task existence");

    // ── Hand a task off to someone (ADR-0002) ────────────────
    // Unlike /share above, this one moves the task into the recipient's court.
    const handoffTask = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: { folderName: "Hand Me Over", taskType: "LOI", notes: "handoff test" }
    });
    const handoffId = handoffTask.json.task.id;

    // Anyone authenticated may hand off — this actor is neither creator nor
    // assignee — and an OPEN task lands CLAIMED on the recipient.
    const assigned = await request(server.baseUrl, "POST", `/tasks/${handoffId}/assign`, {
      user: users.otherOfficer,
      body: { assigneeUserId: users.fileChecker.id, note: "you know this file" }
    });
    expectStatus(assigned.status, 200, "handoff by an uninvolved user", assigned.json);
    assert.equal(assigned.json.task.status, "CLAIMED", "OPEN task is claimed by the handoff");
    assert.equal(assigned.json.task.assignee.id, users.fileChecker.id, "recipient becomes the assignee");
    pushPass("any authenticated user can hand off an OPEN task, which lands CLAIMED");

    /* ADR-0003: the invariant is a property of the TASK, not the actor, so a
       third party can't route the task back to its creator either. This used to
       be the reassign step itself. */
    const handBackToCreator = await request(server.baseUrl, "POST", `/tasks/${handoffId}/assign`, {
      user: users.admin,
      body: { assigneeUserId: users.creator.id }
    });
    expectStatus(handBackToCreator.status, 400, "third-party handoff back to the creator", handBackToCreator.json);
    assert.match(handBackToCreator.json.error ?? "", /second pair of hands/, "the refusal says which rule refused");
    pushPass("a third party cannot hand a task back to its creator");

    // Reassign in place: status untouched, and the audit trail names both ends.
    const reassigned = await request(server.baseUrl, "POST", `/tasks/${handoffId}/assign`, {
      user: users.admin,
      body: { assigneeUserId: users.otherOfficer.id }
    });
    expectStatus(reassigned.status, 200, "reassign an in-flight task", reassigned.json);
    assert.equal(reassigned.json.task.status, "CLAIMED", "status is untouched by a reassignment");
    assert.equal(reassigned.json.task.assignee.id, users.otherOfficer.id, "assignee swapped");

    const handoffHistory = await request(server.baseUrl, "GET", `/tasks/${handoffId}/history`, {
      user: users.creator
    });
    const assignRows = handoffHistory.json.history.filter((event) => event.action === "TASK_ASSIGNED");
    assert.equal(assignRows.length, 2, "each handoff is recorded");
    assert.ok(/^Assigned to /.test(assignRows[0].detail), "first handoff reads as an assignment");
    assert.ok(/^Reassigned from /.test(assignRows[1].detail), "second reads as a reassignment");
    pushPass("handoff swaps the assignee in place and is recorded in history");

    /* Handing it to whoever already holds it is refused (#208). It used to 200
       with the task unchanged, which reported success for a request that did
       nothing at all. */
    const alreadyTheirs = await request(server.baseUrl, "POST", `/tasks/${handoffId}/assign`, {
      user: users.admin,
      body: { assigneeUserId: users.otherOfficer.id }
    });
    expectStatus(alreadyTheirs.status, 400, "handoff to the current assignee is refused", alreadyTheirs.json);
    assert.match(alreadyTheirs.json.error, /already has this task/i, "and says why in the target's own terms");

    const untouched = await request(server.baseUrl, "GET", `/tasks/${handoffId}`, { user: users.creator });
    assert.equal(untouched.json.task.updatedAt, reassigned.json.task.updatedAt, "the refused handoff changed nothing");

    // Eligibility is enforced on the RECIPIENT: a fraud check only goes to a
    // file checker, even when a file checker is the one handing it over.
    const fraudHandoff = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: { folderName: "Fraud Handoff", taskType: "FRAUD", notes: "needs a checker" }
    });
    const fraudHandoffId = fraudHandoff.json.task.id;
    const ineligible = await request(server.baseUrl, "POST", `/tasks/${fraudHandoffId}/assign`, {
      user: users.fileChecker,
      body: { assigneeUserId: users.otherOfficer.id }
    });
    expectStatus(ineligible.status, 400, "fraud handoff to a non-checker is rejected", ineligible.json);
    assert.match(ineligible.json.error, /file checker/i, "the refusal names the fix");
    const stillOpen = await request(server.baseUrl, "GET", `/tasks/${fraudHandoffId}`, { user: users.creator });
    assert.equal(stillOpen.json.task.status, "OPEN", "the refused handoff changed nothing");

    // A creator can't route around the claim rule by handing the task to
    // themselves — the same door, differently shaped.
    const selfHandoffByCreator = await request(server.baseUrl, "POST", `/tasks/${fraudHandoffId}/assign`, {
      user: users.creator,
      body: { assigneeUserId: users.creator.id }
    });
    expectStatus(selfHandoffByCreator.status, 400, "creator self-handoff", selfHandoffByCreator.json);
    assert.match(selfHandoffByCreator.json.error ?? "", /second pair of hands/, "the refusal says which rule refused");
    pushPass("a creator cannot hand their own task to themselves");

    const eligible = await request(server.baseUrl, "POST", `/tasks/${fraudHandoffId}/assign`, {
      user: users.creator,
      body: { assigneeUserId: users.fileChecker.id }
    });
    expectStatus(eligible.status, 200, "fraud handoff to a file checker is allowed", eligible.json);
    pushPass("handoff eligibility is enforced on the recipient, not the actor");

    /* Self-handoff is gone for everyone (#208), not just the creator. Taking
       work off a colleague who is stuck or away used to happen this way; it is
       now the creator's move, made in the open with "Back to the pool". */
    const selfHandoffByOther = await request(server.baseUrl, "POST", `/tasks/${fraudHandoffId}/assign`, {
      user: users.admin,
      body: { assigneeUserId: users.admin.id }
    });
    expectStatus(selfHandoffByOther.status, 400, "non-creator self-handoff is refused", selfHandoffByOther.json);
    assert.match(selfHandoffByOther.json.error ?? "", /hand a task to yourself/, "and points at the move that replaced it");
    pushPass("nobody can hand a task to themselves, creator or not");

    /* The replacement route end to end: the creator frees a claimed task, and
       somebody else picks it up from the pool through the front door. */
    const poolTask = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: { folderName: "Stalled Task", taskType: "VALUE", notes: "nobody is moving on this" }
    });
    const poolTaskId = poolTask.json.task.id;
    await request(server.baseUrl, "POST", `/tasks/${poolTaskId}/claim`, { user: users.otherOfficer });

    const notCreator = await request(server.baseUrl, "POST", `/tasks/${poolTaskId}/return-to-pool`, {
      user: users.admin
    });
    expectStatus(notCreator.status, 400, "only the creator may free a task", notCreator.json);

    const freed = await request(server.baseUrl, "POST", `/tasks/${poolTaskId}/return-to-pool`, {
      user: users.creator
    });
    expectStatus(freed.status, 200, "the creator puts a stalled task back in the pool", freed.json);
    assert.equal(freed.json.task.status, "OPEN", "back where a task starts");
    assert.equal(freed.json.task.assignee, undefined, "with the seat clear");

    const retaken = await request(server.baseUrl, "POST", `/tasks/${poolTaskId}/claim`, { user: users.admin });
    expectStatus(retaken.status, 200, "and anyone may claim it from there", retaken.json);
    assert.equal(retaken.json.task.assignee.id, users.admin.id);
    pushPass("the creator can put a stalled task back in the pool for someone else to claim");

    // A closed task is out of play. Completion belongs to the assignee.
    const closeHandoffTask = await request(server.baseUrl, "POST", `/tasks/${handoffId}/transition`, {
      user: users.otherOfficer,
      body: { status: "COMPLETED" }
    });
    expectStatus(closeHandoffTask.status, 200, "assignee completes the handoff task", closeHandoffTask.json);
    const closedHandoff = await request(server.baseUrl, "POST", `/tasks/${handoffId}/assign`, {
      user: users.admin,
      body: { assigneeUserId: users.fileChecker.id }
    });
    expectStatus(closedHandoff.status, 400, "handoff of a closed task is rejected", closedHandoff.json);
    assert.match(closedHandoff.json.error, /closed/i, "the refusal says why");

    const assignNoTarget = await request(server.baseUrl, "POST", `/tasks/${fraudHandoffId}/assign`, {
      user: users.creator,
      body: {}
    });
    expectStatus(assignNoTarget.status, 400, "handoff without assigneeUserId is rejected", assignNoTarget.json);

    const assignUnknownUser = await request(server.baseUrl, "POST", `/tasks/${fraudHandoffId}/assign`, {
      user: users.creator,
      body: { assigneeUserId: "nobody-here" }
    });
    expectStatus(assignUnknownUser.status, 404, "handoff to an unknown user is rejected", assignUnknownUser.json);

    const assignUnknownTask = await request(server.baseUrl, "POST", "/tasks/nonexistent-task/assign", {
      user: users.creator,
      body: { assigneeUserId: users.fileChecker.id }
    });
    expectStatus(assignUnknownTask.status, 404, "handoff of an unknown task is rejected", assignUnknownTask.json);
    pushPass("handoff refuses closed tasks and validates its target and task");

    // Born assigned: `assigneeUserId` on the create payload, one operation.
    const bornAssigned = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: {
        folderName: "Born Assigned",
        taskType: "LOI",
        notes: "already yours",
        assigneeUserId: users.fileChecker.id,
        assigneeNote: "all yours"
      }
    });
    expectStatus(bornAssigned.status, 201, "create with an assignee", bornAssigned.json);
    assert.equal(bornAssigned.json.task.status, "CLAIMED", "a task born assigned is CLAIMED, never OPEN");
    assert.equal(bornAssigned.json.task.assignee.id, users.fileChecker.id, "assigned to the chosen person");

    const bornIneligible = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: {
        folderName: "Born Wrong",
        taskType: "FRAUD",
        notes: "no",
        assigneeUserId: users.otherOfficer.id
      }
    });
    expectStatus(bornIneligible.status, 400, "create assigning a fraud check to a non-checker", bornIneligible.json);
    pushPass("a task can be created already handed off, with the same eligibility rule");

    const integrationDisabled = await request(server.baseUrl, "POST", "/integrations/tasks", {
      body: {
        folderName: "Inbound disabled",
        taskType: "LOI",
        notes: "integration"
      }
    });
    expectStatus(integrationDisabled.status, 503, "integration endpoint disabled without key", integrationDisabled.json);
    pushPass("integration endpoint disabled by default");

    // ── Admin user management (Phase 2.5) ────────────────────
    const usersDenied = await request(server.baseUrl, "GET", "/users", { user: users.creator });
    expectStatus(usersDenied.status, 403, "non-admin cannot list users", usersDenied.json);

    const usersList = await request(server.baseUrl, "GET", "/users", { user: users.admin });
    expectStatus(usersList.status, 200, "admin lists users", usersList.json);
    assert.ok(Array.isArray(usersList.json.users), "users array returned");
    assert.ok(usersList.json.users.some((u) => u.id === users.otherOfficer.id), "known user present");
    pushPass("admin can list users, non-admin is blocked");

    const promote = await request(server.baseUrl, "PUT", `/users/${users.otherOfficer.id}/roles`, {
      user: users.admin,
      body: { roles: ["LOAN_OFFICER", "FILE_CHECKER"] }
    });
    expectStatus(promote.status, 200, "admin updates roles", promote.json);
    assert.deepEqual(promote.json.user.roles.sort(), ["FILE_CHECKER", "LOAN_OFFICER"]);
    pushPass("admin can update roles");

    /* Demotion auto-releases (#145): the checker seat needs a live
       FILE_CHECKER role, so taking it away has to hand the tasks back rather
       than strand them. Wiring only — the semantics live in
       scripts/fraud-service-sim-test.mjs. */
    const checkerFraud = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: { folderName: "Demotion Release", taskType: "FRAUD", notes: "check it" }
    });
    const checkerFraudId = checkerFraud.json.task.id;
    const claimedByChecker = await request(server.baseUrl, "POST", `/tasks/${checkerFraudId}/claim`, {
      user: { ...users.otherOfficer, roles: "LOAN_OFFICER,FILE_CHECKER" }
    });
    expectStatus(claimedByChecker.status, 200, "newly promoted checker claims a fraud check", claimedByChecker.json);

    const preview = await request(server.baseUrl, "GET", `/users/${users.otherOfficer.id}/fraud-checks`, {
      user: users.admin
    });
    expectStatus(preview.status, 200, "admin previews what a demotion would release", preview.json);
    assert.ok(
      preview.json.tasks.some((t) => t.id === checkerFraudId),
      "the panel can warn about this task before the change"
    );

    const demote = await request(server.baseUrl, "PUT", `/users/${users.otherOfficer.id}/roles`, {
      user: users.admin,
      body: { roles: ["LOAN_OFFICER"] }
    });
    expectStatus(demote.status, 200, "admin removes FILE_CHECKER", demote.json);
    assert.equal(demote.json.releasedFraudChecks, 1, "the response says how many checks it released");
    const afterDemotion = await request(server.baseUrl, "GET", `/tasks/${checkerFraudId}`, { user: users.creator });
    assert.equal(afterDemotion.json.task.assignee, undefined, "the demoted checker is off the task");
    assert.equal(afterDemotion.json.task.status, "CLAIMED", "and its status is untouched");
    pushPass("removing FILE_CHECKER releases that user's live fraud checks");

    /* Deactivation strands the same way a demotion does — a blocked account
       can't act on the task either — so it takes the same release. Put them
       back in the checker seat first, holding a live check, or the assertion
       below passes vacuously. */
    const repromote = await request(server.baseUrl, "PUT", `/users/${users.otherOfficer.id}/roles`, {
      user: users.admin,
      body: { roles: ["LOAN_OFFICER", "FILE_CHECKER"] }
    });
    expectStatus(repromote.status, 200, "admin restores FILE_CHECKER", repromote.json);
    const deactivationFraud = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: { folderName: "Deactivation Release", taskType: "FRAUD", notes: "check it" }
    });
    const deactivationFraudId = deactivationFraud.json.task.id;
    await request(server.baseUrl, "POST", `/tasks/${deactivationFraudId}/claim`, {
      user: { ...users.otherOfficer, roles: "LOAN_OFFICER,FILE_CHECKER" }
    });

    const deactivate = await request(server.baseUrl, "PATCH", `/users/${users.otherOfficer.id}`, {
      user: users.admin,
      body: { active: false }
    });
    expectStatus(deactivate.status, 200, "admin deactivates user", deactivate.json);
    assert.equal(deactivate.json.releasedFraudChecks, 1, "deactivation reports the checks it released");
    const afterDeactivation = await request(server.baseUrl, "GET", `/tasks/${deactivationFraudId}`, { user: users.creator });
    assert.equal(afterDeactivation.json.task.assignee, undefined, "the deactivated checker is off the task");
    assert.equal(afterDeactivation.json.task.status, "CLAIMED", "and its status is untouched");
    pushPass("deactivating a checker releases their live fraud checks too");
    const deactivatedMe = await request(server.baseUrl, "GET", "/me", { user: users.otherOfficer });
    expectStatus(deactivatedMe.status, 403, "deactivated user is blocked", deactivatedMe.json);
    const reactivate = await request(server.baseUrl, "PATCH", `/users/${users.otherOfficer.id}`, {
      user: users.admin,
      body: { active: true }
    });
    expectStatus(reactivate.status, 200, "admin reactivates user", reactivate.json);
    const reactivatedMe = await request(server.baseUrl, "GET", "/me", { user: users.otherOfficer });
    expectStatus(reactivatedMe.status, 200, "reactivated user is allowed", reactivatedMe.json);
    pushPass("deactivate blocks access, reactivate restores it");

    const selfDeactivate = await request(server.baseUrl, "PATCH", `/users/${users.admin.id}`, {
      user: users.admin,
      body: { active: false }
    });
    expectStatus(selfDeactivate.status, 400, "admin cannot deactivate self", selfDeactivate.json);

    const dropLastAdmin = await request(server.baseUrl, "PUT", `/users/${users.admin.id}/roles`, {
      user: users.admin,
      body: { roles: ["LOAN_OFFICER"] }
    });
    expectStatus(dropLastAdmin.status, 403, "cannot demote the last admin", dropLastAdmin.json);
    pushPass("self-deactivate and last-admin demotion are blocked");

    /* Deleting a checker strands their live checks harder than demoting one:
       there is no record left to release them from later. Same release. */
    const removalFraud = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: { folderName: "Removal Release", taskType: "FRAUD", notes: "check it" }
    });
    const removalFraudId = removalFraud.json.task.id;
    await request(server.baseUrl, "PUT", `/users/${users.otherOfficer.id}/roles`, {
      user: users.admin,
      body: { roles: ["LOAN_OFFICER", "FILE_CHECKER"] }
    });
    await request(server.baseUrl, "POST", `/tasks/${removalFraudId}/claim`, {
      user: { ...users.otherOfficer, roles: "LOAN_OFFICER,FILE_CHECKER" }
    });

    const removeUser = await request(server.baseUrl, "DELETE", `/users/${users.otherOfficer.id}`, {
      user: users.admin
    });
    expectStatus(removeUser.status, 200, "admin removes a user", removeUser.json);
    assert.equal(removeUser.json.releasedFraudChecks, 1, "removal releases the checks they were holding");
    const afterRemoval = await request(server.baseUrl, "GET", `/tasks/${removalFraudId}`, { user: users.creator });
    assert.equal(afterRemoval.json.task.assignee, undefined, "no task is left pointing at a deleted user");
    const afterRemove = await request(server.baseUrl, "GET", "/users", { user: users.admin });
    assert.ok(!afterRemove.json.users.some((u) => u.id === users.otherOfficer.id), "removed user is gone");
    pushPass("admin can remove a user");

    const addWithoutGraph = await request(server.baseUrl, "POST", "/users", {
      user: users.admin,
      body: { email: "newhire@loneoakfund.com", roles: ["LOAN_OFFICER"] }
    });
    expectStatus(addWithoutGraph.status, 400, "add user fails without Graph configured", addWithoutGraph.json);
    pushPass("add-user surfaces a clear error when Graph is not configured");

    const statusDenied = await request(server.baseUrl, "GET", "/status", { user: users.creator });
    expectStatus(statusDenied.status, 403, "non-admin cannot read status", statusDenied.json);
    const statusOk = await request(server.baseUrl, "GET", "/status", { user: users.admin });
    expectStatus(statusOk.status, 200, "admin reads status", statusOk.json);
    assert.equal(statusOk.json.bot.enabled, false, "bot reports disabled without creds");
    assert.ok(typeof statusOk.json.bot.dmCount === "number", "bot status includes counts");
    pushPass("admin status endpoint reports bot connectivity");
  } catch (error) {
    pushFail(error instanceof Error ? error.message : String(error));
  } finally {
    if (server) {
      await server.stop();
    }
  }

  let integrationServer;
  try {
    integrationServer = await createServer(BASE_PORT + 1, { INBOUND_API_KEY: "smoke-key" });

    const unauthorized = await request(integrationServer.baseUrl, "POST", "/integrations/tasks", {
      headers: { "x-api-key": "wrong-key" },
      body: {
        folderName: "Integration Unauthorized",
        taskType: "LOI",
        notes: "bad key"
      }
    });
    expectStatus(unauthorized.status, 401, "integration unauthorized key", unauthorized.json);

    const authorized = await request(integrationServer.baseUrl, "POST", "/integrations/tasks", {
      headers: { "x-api-key": "smoke-key" },
      body: {
        folderName: "Integration Authorized",
        taskType: "VALUE",
        notes: "good key"
      }
    });
    expectStatus(authorized.status, 201, "integration authorized create", authorized.json);
    assert.equal(authorized.json.task.createdBy.id, "integration");
    pushPass("integration endpoint auth works when enabled");
  } catch (error) {
    pushFail(error instanceof Error ? error.message : String(error));
  } finally {
    if (integrationServer) {
      await integrationServer.stop();
    }
  }

  // The dev-only roster route (#309) must not exist on a deployed instance.
  // It is registered on the same condition that turns on the `x-user-*` header
  // fallback it serves — no SSO — so an SSO-configured server has no such
  // route and cannot be asked for the staff list without a token.
  let ssoServer;
  try {
    ssoServer = await createServer(BASE_PORT + 5, {
      AAD_TENANT_ID: "00000000-0000-0000-0000-000000000000",
      SSO_CLIENT_ID: "11111111-1111-1111-1111-111111111111"
    });
    const devRosterOnSso = await request(ssoServer.baseUrl, "GET", "/dev/users");
    expectStatus(devRosterOnSso.status, 404, "dev roster absent with SSO configured", devRosterOnSso.json);

    // And the authenticated directory it twins is still there, still refusing
    // an unauthenticated caller — the route disappearing is the only change.
    const directoryOnSso = await request(ssoServer.baseUrl, "GET", "/users/directory");
    expectStatus(directoryOnSso.status, 401, "directory needs a token with SSO configured", directoryOnSso.json);
    pushPass("the dev roster route does not exist once SSO is configured");
  } catch (error) {
    pushFail(error instanceof Error ? error.message : String(error));
  } finally {
    if (ssoServer) {
      await ssoServer.stop();
    }
  }

  // /status reports the EFFECTIVE activity-feed state: flag on but Graph
  // creds missing => the client is disabled => status must report false.
  let partialServer;
  try {
    partialServer = await createServer(BASE_PORT + 2, { ENABLE_ACTIVITY_FEED_NOTIFICATIONS: "true" });
    const partialStatus = await request(partialServer.baseUrl, "GET", "/status", { user: users.admin });
    expectStatus(partialStatus.status, 200, "status with partial activity-feed config", partialStatus.json);
    assert.equal(partialStatus.json.activityFeed, false, "activity feed reports effective (disabled) state without Graph creds");
    pushPass("status reflects effective activity-feed state, not just the raw flag");
  } catch (error) {
    pushFail(error instanceof Error ? error.message : String(error));
  } finally {
    if (partialServer) {
      await partialServer.stop();
    }
  }

  // Share reports delivered=true when the target has a stored bot DM reference
  // (issue #41). Seed a reference for the target before the server starts.
  let deliveredServer;
  try {
    deliveredServer = await createServer(
      BASE_PORT + 3,
      {},
      {
        botReferences: [
          {
            key: `dm:${users.fileChecker.id}`,
            scope: "DM",
            userAadObjectId: users.fileChecker.id,
            reference: {}
          }
        ]
      }
    );
    // The share target has to be a known user. This server has its own isolated
    // user store, so introduce the file checker with one authenticated request
    // (/me resolves and upserts the caller) rather than relying on whatever happens
    // to be sitting in the repo's shared data dir.
    await request(deliveredServer.baseUrl, "GET", "/me", { user: users.fileChecker });
    const created = await request(deliveredServer.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: { folderName: "Delivered Share", taskType: "LOI", notes: "delivered test" }
    });
    const deliveredShare = await request(deliveredServer.baseUrl, "POST", `/tasks/${created.json.task.id}/share`, {
      user: users.creator,
      body: { targetUserId: users.fileChecker.id, note: "eyes on this please" }
    });
    expectStatus(deliveredShare.status, 200, "share to a bot-onboarded user", deliveredShare.json);
    assert.equal(deliveredShare.json.delivered, true, "share to a user with a bot reference reports delivered");
    pushPass("share reports delivered=true when the target has a bot reference");
  } catch (error) {
    pushFail(error instanceof Error ? error.message : String(error));
  } finally {
    if (deliveredServer) {
      await deliveredServer.stop();
    }
  }

  const failed = results.filter((line) => line.startsWith("FAIL"));
  for (const line of results) {
    console.log(line);
  }

  console.log(`SUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length}`);

  if (failed.length > 0) {
    process.exit(1);
  }
};

run();
