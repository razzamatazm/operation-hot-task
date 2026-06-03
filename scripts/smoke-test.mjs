#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const BASE_PORT = 4100;

// Identities aligned with the DEV_USERS list in apps/web/src/App.tsx so any
// task that somehow leaks into dev data is at least tagged to a real current
// user. `otherOfficer` is a smoke-only synthetic identity (no second
// non-checker loan officer exists in DEV_USERS); the prefix makes it obvious
// in any data file it appears in.
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

const createServer = async (port, extraEnv = {}) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loan-smoke-"));
  const dataFile = path.join(tempDir, "tasks.json");
  const botRefs = path.join(tempDir, "bot-references.json");
  const activityStateFile = path.join(tempDir, "activity-feed-state.json");

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
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  const baseUrl = `http://127.0.0.1:${port}`;

  let healthy = false;
  for (let i = 0; i < 12; i += 1) {
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
        returnDate: "2099-01-02",
        notes: "cover while away"
      }
    });
    expectStatus(createOoo.status, 201, "create OOO task", createOoo.json);
    const oooTask = createOoo.json.task;
    assert.equal(oooTask.taskType, "OOO");
    assert.equal(oooTask.urgency, "GREEN");
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
        notes: "missing return date"
      }
    });
    expectStatus(createOooMissingReturnDate.status, 400, "create OOO missing return date", createOooMissingReturnDate.json);
    pushPass("OOO task requires returnDate");

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
    expectStatus(unclaimDenied.status, 400, "unclaim denied for non-assignee/non-admin", unclaimDenied.json);
    pushPass("unclaim denied for unauthorized user");

    const unclaimByAdmin = await request(server.baseUrl, "POST", `/tasks/${loiTask.id}/unclaim`, {
      user: users.admin
    });
    expectStatus(unclaimByAdmin.status, 200, "unclaim by admin", unclaimByAdmin.json);
    assert.equal(unclaimByAdmin.json.task.status, "OPEN");
    pushPass("admin can unclaim");

    const claimByCreator = await request(server.baseUrl, "POST", `/tasks/${loiTask.id}/claim`, {
      user: users.creator
    });
    expectStatus(claimByCreator.status, 200, "claim by creator", claimByCreator.json);

    const details = await request(server.baseUrl, "GET", `/tasks/${loiTask.id}`);
    expectStatus(details.status, 200, "task details", details.json);
    assert.ok(Array.isArray(details.json.allowedTransitions), "allowedTransitions must be returned");
    pushPass("task details returns allowed transitions");

    const needsReview = await request(server.baseUrl, "POST", `/tasks/${loiTask.id}/transition`, {
      user: users.creator,
      body: { status: "NEEDS_REVIEW" }
    });
    expectStatus(needsReview.status, 200, "claimed->needs_review", needsReview.json);
    pushPass("claimed to needs_review transition works for creator/assignee");

    const backToClaimed = await request(server.baseUrl, "POST", `/tasks/${loiTask.id}/transition`, {
      user: users.creator,
      body: { status: "CLAIMED" }
    });
    expectStatus(backToClaimed.status, 200, "needs_review->claimed", backToClaimed.json);

    const completed = await request(server.baseUrl, "POST", `/tasks/${loiTask.id}/transition`, {
      user: users.creator,
      body: { status: "COMPLETED" }
    });
    expectStatus(completed.status, 200, "claimed->completed", completed.json);

    const archived = await request(server.baseUrl, "POST", `/tasks/${loiTask.id}/transition`, {
      user: users.creator,
      body: { status: "ARCHIVED" }
    });
    expectStatus(archived.status, 200, "completed->archived", archived.json);
    pushPass("core LOI lifecycle works to archived");

    const updatePointsArchived = await request(server.baseUrl, "POST", `/tasks/${loiTask.id}/points`, {
      user: users.creator,
      body: { points: 5 }
    });
    expectStatus(updatePointsArchived.status, 400, "cannot update points after archive", updatePointsArchived.json);
    pushPass("Poops updates remain blocked for closed statuses");

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
    expectStatus(cancelByAdmin.status, 200, "cancel by admin", cancelByAdmin.json);
    pushPass("admin cancel permissions enforced");

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
    const creatorCanReview = await request(server.baseUrl, "POST", `/tasks/${creatorReviewId}/transition`, {
      user: users.creator,
      body: { status: "NEEDS_REVIEW" }
    });
    expectStatus(creatorCanReview.status, 200, "creator marks needs review while not assignee", creatorCanReview.json);
    pushPass("creator can mark claimed task as needs_review even when not assignee");

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

    const fraudCompleteAllowed = await request(server.baseUrl, "POST", `/tasks/${fraudId}/transition`, {
      user: users.fileChecker,
      body: { status: "COMPLETED" }
    });
    expectStatus(fraudCompleteAllowed.status, 200, "fraud complete by file checker", fraudCompleteAllowed.json);
    pushPass("fraud permissions enforced and file checker path works");

    const loanDocsTask = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: {
        folderName: "Loan Docs Path",
        taskType: "LOAN_DOCS",
        notes: "loan docs flow"
      }
    });
    const loanDocsId = loanDocsTask.json.task.id;

    await request(server.baseUrl, "POST", `/tasks/${loanDocsId}/claim`, { user: users.creator });

    const invalidLoanDocsComplete = await request(server.baseUrl, "POST", `/tasks/${loanDocsId}/transition`, {
      user: users.creator,
      body: { status: "COMPLETED" }
    });
    expectStatus(invalidLoanDocsComplete.status, 400, "loan docs cannot skip merge steps", invalidLoanDocsComplete.json);

    const mergeDone = await request(server.baseUrl, "POST", `/tasks/${loanDocsId}/transition`, {
      user: users.creator,
      body: { status: "MERGE_DONE" }
    });
    expectStatus(mergeDone.status, 200, "loan docs merge_done", mergeDone.json);

    const mergeApproved = await request(server.baseUrl, "POST", `/tasks/${loanDocsId}/transition`, {
      user: users.creator,
      body: { status: "MERGE_APPROVED" }
    });
    expectStatus(mergeApproved.status, 200, "loan docs merge_approved", mergeApproved.json);

    const loanDocsComplete = await request(server.baseUrl, "POST", `/tasks/${loanDocsId}/transition`, {
      user: users.creator,
      body: { status: "COMPLETED" }
    });
    expectStatus(loanDocsComplete.status, 200, "loan docs completed", loanDocsComplete.json);

    const loanDocsArchive = await request(server.baseUrl, "POST", `/tasks/${loanDocsId}/transition`, {
      user: users.creator,
      body: { status: "ARCHIVED" }
    });
    expectStatus(loanDocsArchive.status, 200, "loan docs archived", loanDocsArchive.json);
    pushPass("loan docs flow enforces merge stages");

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

    const deactivate = await request(server.baseUrl, "PATCH", `/users/${users.otherOfficer.id}`, {
      user: users.admin,
      body: { active: false }
    });
    expectStatus(deactivate.status, 200, "admin deactivates user", deactivate.json);
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

    const removeUser = await request(server.baseUrl, "DELETE", `/users/${users.otherOfficer.id}`, {
      user: users.admin
    });
    expectStatus(removeUser.status, 200, "admin removes a user", removeUser.json);
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
