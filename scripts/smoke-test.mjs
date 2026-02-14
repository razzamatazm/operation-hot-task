#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const BASE_PORT = 4100;

const users = {
  creator: {
    id: "loan-officer-1",
    name: "Jamie Loan Officer",
    roles: "LOAN_OFFICER"
  },
  otherOfficer: {
    id: "loan-officer-2",
    name: "Alex Loan Officer",
    roles: "LOAN_OFFICER"
  },
  fileChecker: {
    id: "file-checker-1",
    name: "Taylor File Checker",
    roles: "LOAN_OFFICER,FILE_CHECKER"
  },
  admin: {
    id: "admin-1",
    name: "Morgan Admin",
    roles: "LOAN_OFFICER,ADMIN"
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

  const logs = [];
  const child = spawn(process.execPath, ["apps/server/dist/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_FILE: dataFile,
      BOT_REFERENCES_FILE: botRefs,
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
    pushPass("create LOI defaults applied");

    const greenDueMs = new Date(loiTask.dueAt).getTime() - new Date(loiTask.createdAt).getTime();
    assert.ok(greenDueMs > 0, "GREEN dueAt should be in the future");
    pushPass("default GREEN urgency computes a future backend due date");

    const createOrange = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: {
        loanName: "Smoke Orange",
        taskType: "VALUE",
        urgency: "ORANGE",
        notes: "smoke-orange"
      }
    });
    expectStatus(createOrange.status, 201, "create ORANGE task", createOrange.json);
    const orangeTask = createOrange.json.task;
    const orangeDueMs = new Date(orangeTask.dueAt).getTime() - new Date(orangeTask.createdAt).getTime();
    assert.ok(orangeDueMs >= 55 * 60 * 1000 && orangeDueMs <= 65 * 60 * 1000, `ORANGE due delta expected ~1h, got ${orangeDueMs}`);
    pushPass("ORANGE urgency default due is approximately 1 hour");

    const createRed = await request(server.baseUrl, "POST", "/tasks", {
      user: users.creator,
      body: {
        loanName: "Smoke Red",
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
        loanName: "Cancel Me",
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
        loanName: "Cancel By Admin",
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
        loanName: "Creator Review Permission",
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
        loanName: "Fraud Restricted",
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
        loanName: "Loan Docs Path",
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
        loanName: "Inbound disabled",
        taskType: "LOI",
        notes: "integration"
      }
    });
    expectStatus(integrationDisabled.status, 503, "integration endpoint disabled without key", integrationDisabled.json);
    pushPass("integration endpoint disabled by default");
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
        loanName: "Integration Unauthorized",
        taskType: "LOI",
        notes: "bad key"
      }
    });
    expectStatus(unauthorized.status, 401, "integration unauthorized key", unauthorized.json);

    const authorized = await request(integrationServer.baseUrl, "POST", "/integrations/tasks", {
      headers: { "x-api-key": "smoke-key" },
      body: {
        loanName: "Integration Authorized",
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
