#!/usr/bin/env node
// Differential scroll-cost loop.
// Scrolls the app identically under several CSS overrides and reports the
// rendering work each arm costs. Whichever override collapses the cost
// implicates that property.
// Usage: node scroll.mjs [cycles]

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_ARG = process.env.URL ?? "http://localhost:5183/";
const CYCLES = Number(process.argv[2] ?? 3);
const SCROLL_SEC = Number(process.env.SCROLL_SEC ?? 6);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.PORT_CDP ?? 9338);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ARMS = [
  ["baseline", ""],
  ["no-box-shadow", "* { box-shadow: none !important; }"],
  ["no-transition", "* { transition: none !important; animation: none !important; }"],
  ["no-filter", "* { filter: none !important; backdrop-filter: none !important; }"],
  ["no-border-radius", "* { border-radius: 0 !important; }"],
];

function mkCdp(ws) {
  const pending = new Map();
  const listeners = [];
  ws.addEventListener("message", (e) => {
    const d = JSON.parse(e.data);
    if (d.id && pending.has(d.id)) {
      const { resolve, reject } = pending.get(d.id);
      pending.delete(d.id);
      d.error ? reject(new Error(d.error.message)) : resolve(d.result);
    } else if (d.method) listeners.forEach((f) => f(d.method, d.params));
  });
  let id = 0;
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error("timeout " + method)); } }, 40000);
    });
  return { send, on: (f) => listeners.push(f) };
}

const profile = mkdtempSync(join(tmpdir(), "scroll-"));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--window-size=1440,900", "about:blank",
], { stdio: "ignore" });
const cleanup = () => { try { chrome.kill("SIGKILL"); } catch {} };
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(1); });

const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : +((s[m - 1] + s[m]) / 2).toFixed(1)) : 0; };

async function main() {
  let list;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); list = await r.json(); if (list.length) break; } catch {}
    await sleep(250);
  }
  const page = list.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  const { send, on } = mkCdp(ws);
  await send("Page.enable");
  await send("Runtime.enable");

  let traceEvents = [];
  on((method, params) => { if (method === "Tracing.dataCollected") traceEvents.push(...params.value); });

  await send("Page.navigate", { url: URL_ARG });
  await sleep(6000);

  const measure = async (label, css) => {
    // apply this arm's override
    await send("Runtime.evaluate", {
      expression: `(() => {
        let el = document.getElementById('__arm_css');
        if (!el) { el = document.createElement('style'); el.id='__arm_css'; document.head.appendChild(el); }
        el.textContent = ${JSON.stringify(css)};
        window.scrollTo(0,0);
        return document.documentElement.scrollHeight;
      })()`,
      returnByValue: true,
    });
    await sleep(800);
    traceEvents = [];
    await send("Tracing.start", {
      traceConfig: {
        recordMode: "recordContinuously",
        includedCategories: ["disabled-by-default-devtools.timeline.frame", "disabled-by-default-devtools.timeline", "blink", "cc"],
      },
      transferMode: "ReportEvents",
    });

    // Drive a steady scroll with real input events so the compositor path is
    // exercised the way a user's trackpad would.
    const t0 = Date.now();
    let y = 0, dir = 1;
    while (Date.now() - t0 < SCROLL_SEC * 1000) {
      y += dir * 120;
      await send("Input.dispatchMouseEvent", {
        type: "mouseWheel", x: 700, y: 450, deltaX: 0, deltaY: dir * 120,
      }).catch(() => {});
      if (y > 3000) dir = -1;
      if (y < 0) dir = 1;
      await sleep(30);
    }
    const elapsed = (Date.now() - t0) / 1000;
    const done = new Promise((r) => on((m) => { if (m === "Tracing.tracingComplete") r(); }));
    await send("Tracing.end");
    await done;

    const sum = {}, cnt = {};
    for (const e of traceEvents) {
      cnt[e.name] = (cnt[e.name] || 0) + 1;
      if (typeof e.dur === "number") sum[e.name] = (sum[e.name] || 0) + e.dur;
    }
    const ms = (n) => +(((sum[n] ?? 0) / 1000) / elapsed).toFixed(1); // ms of work per second
    return {
      label,
      drawPerSec: +((cnt["DrawFrame"] ?? 0) / elapsed).toFixed(1),
      rasterMsPerSec: ms("RasterTask"),
      paintMsPerSec: ms("Paint"),
      layoutMsPerSec: ms("Layout"),
      recalcMsPerSec: ms("UpdateLayoutTree"),
      commitMsPerSec: ms("Commit"),
      rasterCount: +((cnt["RasterTask"] ?? 0) / elapsed).toFixed(1),
    };
  };

  const acc = {};
  for (let c = 0; c < CYCLES; c++) {
    for (const [label, css] of ARMS) {
      const r = await measure(label, css);
      (acc[label] ??= []).push(r);
      console.error(`cycle ${c} ${label.padEnd(18)} draw/s=${String(r.drawPerSec).padStart(5)} raster=${String(r.rasterMsPerSec).padStart(6)}ms/s paint=${String(r.paintMsPerSec).padStart(6)}ms/s layout=${String(r.layoutMsPerSec).padStart(5)}ms/s recalc=${String(r.recalcMsPerSec).padStart(5)}ms/s`);
    }
  }

  console.log("\n" + "=".repeat(96));
  const summary = {};
  for (const [label] of ARMS) {
    const rs = acc[label];
    summary[label] = {
      drawPerSec: median(rs.map((r) => r.drawPerSec)),
      rasterMsPerSec: median(rs.map((r) => r.rasterMsPerSec)),
      paintMsPerSec: median(rs.map((r) => r.paintMsPerSec)),
      layoutMsPerSec: median(rs.map((r) => r.layoutMsPerSec)),
      recalcMsPerSec: median(rs.map((r) => r.recalcMsPerSec)),
      commitMsPerSec: median(rs.map((r) => r.commitMsPerSec)),
    };
    const s = summary[label];
    console.log(`${label.padEnd(18)} draw/s=${String(s.drawPerSec).padStart(5)}  raster=${String(s.rasterMsPerSec).padStart(6)}ms/s  paint=${String(s.paintMsPerSec).padStart(6)}ms/s  layout=${String(s.layoutMsPerSec).padStart(5)}ms/s  recalc=${String(s.recalcMsPerSec).padStart(5)}ms/s  commit=${String(s.commitMsPerSec).padStart(5)}ms/s`);
  }
  console.log("=".repeat(96));
  const b = summary["baseline"];
  for (const [label] of ARMS.slice(1)) {
    const s = summary[label];
    const drop = +(b.rasterMsPerSec + b.paintMsPerSec - s.rasterMsPerSec - s.paintMsPerSec).toFixed(1);
    console.log(`${label.padEnd(18)} raster+paint saved vs baseline: ${drop} ms/s`);
  }
  writeFileSync(process.env.OUT ?? "/tmp/scroll.json", JSON.stringify(summary, null, 2));
  ws.close(); cleanup(); process.exit(0);
}
main().catch((e) => { console.error("ERR", e.message); cleanup(); process.exit(2); });
