#!/usr/bin/env node
/* #368: under `npm run dev` the API port used to serve whatever web build was
   last made, so http://localhost:4100 showed a stale board with no sign it was
   stale. The server's dev script now sets SERVER_DEV_MODE=true, and in that mode
   page requests are redirected to the live Vite page on WEB_PORT instead.
   Started the production way (no signal) it serves the build exactly as before.

   Each server here runs on a free port well away from 4100/5173 with its own
   temp data dir, so a dev server already running on this machine is untouched. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

const BASE_PORT = Number(process.env.DEV_REDIRECT_PORT ?? 4760);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const portIsFree = (port) =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });

let nextPort = BASE_PORT;
const freePort = async () => {
  for (let tries = 0; tries < 100; tries += 1) {
    const port = nextPort;
    nextPort += 1;
    if (await portIsFree(port)) {
      return port;
    }
  }
  throw new Error(`No free port found near ${BASE_PORT}`);
};

/* A stand-in web build: the real apps/web/dist may or may not exist, and its
   presence is exactly what must NOT decide the mode. */
const makeFrontendDist = async (tempDir) => {
  const dist = path.join(tempDir, "web-dist");
  await fs.mkdir(dist, { recursive: true });
  await fs.writeFile(path.join(dist, "index.html"), "<!doctype html><title>built-board-marker</title>", "utf8");
  return dist;
};

const startServer = async (label, extraEnv) => {
  const port = await freePort();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loan-dev-redirect-"));
  const env = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    API_PORT: String(port),
    DATA_FILE: path.join(tempDir, "tasks.json"),
    BOT_REFERENCES_FILE: path.join(tempDir, "bot-references.json"),
    ACTIVITY_FEED_STATE_FILE: path.join(tempDir, "activity-feed-state.json"),
    USERS_FILE: path.join(tempDir, "users.json"),
    ADMIN_SETTINGS_FILE: path.join(tempDir, "admin-settings.json"),
    SAVED_FOR_LATER_FILE: path.join(tempDir, "saved-for-later.json"),
    FRONTEND_DIST: await makeFrontendDist(tempDir)
  };
  // Whatever the calling shell has, each case decides these for itself.
  delete env.SERVER_DEV_MODE;
  delete env.WEB_PORT;
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  const logs = [];
  const child = spawn(process.execPath, ["apps/server/dist/index.js"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 40; i += 1) {
    if (exited) {
      throw new Error(`${label}: server exited before becoming healthy. Logs:\n${logs.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok && logs.join("").includes("running at")) {
        break;
      }
    } catch {
      // not up yet
    }
    if (i === 39) {
      child.kill("SIGTERM");
      throw new Error(`${label}: server never became healthy. Logs:\n${logs.join("")}`);
    }
    await delay(250);
  }

  return {
    baseUrl,
    port,
    tempDir,
    logs: () => logs.join(""),
    stop: async () => {
      if (!exited) {
        const done = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        await Promise.race([done, delay(3000)]);
        if (!exited) {
          child.kill("SIGKILL");
        }
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  };
};

const get = (url) => fetch(url, { redirect: "manual" });

/* The /api surface must answer the same way in both modes: same status and
   content type for a real route, and the same miss for an unknown one. */
const apiFingerprint = async (baseUrl) => {
  const health = await get(`${baseUrl}/api/health`);
  const missing = await get(`${baseUrl}/api/definitely-not-a-route`);
  const missingPost = await fetch(`${baseUrl}/api/definitely-not-a-route`, { method: "POST", redirect: "manual" });
  return {
    healthStatus: health.status,
    healthType: health.headers.get("content-type"),
    healthLocation: health.headers.get("location"),
    missingStatus: missing.status,
    missingLocation: missing.headers.get("location"),
    missingPostStatus: missingPost.status
  };
};

const servers = [];
const run = async () => {
  // Dev mode, explicit web port: page requests go to that instance's own Vite page.
  const webPort = String(await freePort());
  const dev = await startServer("dev", { SERVER_DEV_MODE: "true", WEB_PORT: webPort });
  servers.push(dev);

  const root = await get(`${dev.baseUrl}/`);
  assert.ok([302, 307].includes(root.status), `dev GET / should redirect, got ${root.status}`);
  assert.equal(root.headers.get("location"), `http://127.0.0.1:${webPort}/`);

  const deep = await get(`${dev.baseUrl}/some/route?task=abc`);
  assert.ok([302, 307].includes(deep.status), `dev GET deep path should redirect, got ${deep.status}`);
  assert.equal(deep.headers.get("location"), `http://127.0.0.1:${webPort}/some/route?task=abc`);

  // A file that exists in the build is still not served from the build in dev.
  const asset = await get(`${dev.baseUrl}/index.html`);
  assert.ok([302, 307].includes(asset.status), `dev GET /index.html should redirect, got ${asset.status}`);
  assert.equal(asset.headers.get("location"), `http://127.0.0.1:${webPort}/index.html`);

  assert.match(dev.logs(), /serving_frontend=false/);
  assert.match(dev.logs(), new RegExp(`dev_mode=true redirect_web_port=${webPort}`));
  assert.doesNotMatch(dev.logs(), /serving_frontend=true/);

  // Dev mode with no WEB_PORT falls back to Vite's own default, 5173.
  const devDefault = await startServer("dev-default-web-port", { SERVER_DEV_MODE: "true", WEB_PORT: undefined });
  servers.push(devDefault);
  const defaultRoot = await get(`${devDefault.baseUrl}/`);
  assert.ok([302, 307].includes(defaultRoot.status));
  assert.equal(defaultRoot.headers.get("location"), "http://127.0.0.1:5173/");

  // Production mode (no signal), build present: serves index.html as before.
  const prod = await startServer("prod", { SERVER_DEV_MODE: undefined, WEB_PORT: webPort });
  servers.push(prod);
  const prodRoot = await get(`${prod.baseUrl}/`);
  assert.equal(prodRoot.status, 200);
  assert.match(await prodRoot.text(), /built-board-marker/);
  const prodDeep = await get(`${prod.baseUrl}/some/route`);
  assert.equal(prodDeep.status, 200);
  assert.match(await prodDeep.text(), /built-board-marker/);
  assert.match(prod.logs(), /serving_frontend=true path=/);
  assert.doesNotMatch(prod.logs(), /dev_mode=true/);

  // Anything other than exactly "true" is not dev mode.
  const notDev = await startServer("prod-false-signal", { SERVER_DEV_MODE: "false" });
  servers.push(notDev);
  const notDevRoot = await get(`${notDev.baseUrl}/`);
  assert.equal(notDevRoot.status, 200);

  // /api answers identically in both modes.
  assert.deepEqual(await apiFingerprint(dev.baseUrl), await apiFingerprint(prod.baseUrl));
  const fingerprint = await apiFingerprint(dev.baseUrl);
  assert.equal(fingerprint.healthStatus, 200);
  assert.equal(fingerprint.healthLocation, null);
  assert.equal(fingerprint.missingLocation, null);

  // Production mode, build missing: logs the miss and serves no page.
  const missingDist = path.join(os.tmpdir(), `loan-dev-redirect-no-dist-${process.pid}`);
  const prodMissing = await startServer("prod-missing-build", { FRONTEND_DIST: missingDist });
  servers.push(prodMissing);
  assert.match(prodMissing.logs(), new RegExp(`serving_frontend=false missing=${path.join(missingDist, "index.html").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const missingRoot = await get(`${prodMissing.baseUrl}/`);
  assert.equal(missingRoot.status, 404);
  assert.equal(missingRoot.headers.get("location"), null);

  console.log("dev-frontend-redirect sim test passed");
};

try {
  await run();
} finally {
  for (const server of servers) {
    await server.stop();
  }
}
