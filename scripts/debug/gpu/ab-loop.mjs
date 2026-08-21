#!/usr/bin/env node
// Startup-immune A/B GPU loop.
// One warm Chrome; arms are alternated across N cycles and the first cycle is
// discarded, so Chrome launch transients cannot be attributed to any arm.
// Usage: node ab-loop.mjs [cycles] [sampleSec]
//   Arms are declared in ARMS below (label -> url).

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CYCLES = Number(process.argv[2] ?? 4);
const SAMPLE = Number(process.argv[3] ?? 6);
const SETTLE = Number(process.env.SETTLE ?? 4);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.PORT_CDP ?? 9336);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ARMS = JSON.parse(
  process.env.ARMS ??
    JSON.stringify([
      ["blank", "about:blank"],
      ["app", "http://localhost:5183/"],
    ]),
);

function gpuUtil() {
  const out = execFileSync("ioreg", ["-r", "-d", "1", "-w", "0", "-c", "AGXAccelerator"], { encoding: "utf8" });
  const m = out.match(/"Device Utilization %"=(\d+)/);
  return m ? +m[1] : -1;
}

async function cdp(ws, method, params = {}) {
  const id = (cdp.id = (cdp.id ?? 0) + 1);
  return new Promise((resolve, reject) => {
    const onMsg = (e) => {
      const d = JSON.parse(e.data);
      if (d.id === id) {
        ws.removeEventListener("message", onMsg);
        d.error ? reject(new Error(method + ": " + d.error.message)) : resolve(d.result);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => reject(new Error("timeout " + method)), 25000);
  });
}

const PROBE = `
  (() => {
    window.__raf = 0;
    const o = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => o((t) => { window.__raf++; return cb(t); });
    window.__mut = 0;
    const start = () => new MutationObserver((r) => { window.__mut += r.length; })
      .observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    if (document.documentElement) start(); else document.addEventListener("readystatechange", start, { once: true });
  })();
`;

const profile = mkdtempSync(join(tmpdir(), "ab-loop-"));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--window-size=1440,900", "about:blank",
], { stdio: "ignore" });
const cleanup = () => { try { chrome.kill("SIGKILL"); } catch {} };
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(1); });

const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : +((s[m - 1] + s[m]) / 2).toFixed(1); };

async function main() {
  let list;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); list = await r.json(); if (list.length) break; } catch {}
    await sleep(250);
  }
  const page = list.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  await cdp(ws, "Page.enable");
  await cdp(ws, "Runtime.enable");
  await cdp(ws, "Performance.enable").catch(() => {});
  await cdp(ws, "Page.addScriptToEvaluateOnNewDocument", { source: PROBE });

  const metrics = async () => {
    const r = await cdp(ws, "Performance.getMetrics").catch(() => ({ metrics: [] }));
    return Object.fromEntries(r.metrics.map((m) => [m.name, m.value]));
  };

  const measure = async (url) => {
    await cdp(ws, "Page.navigate", { url });
    await sleep(SETTLE * 1000);
    await cdp(ws, "Runtime.evaluate", { expression: "window.__raf=0; window.__mut=0" });
    const m0 = await metrics();
    const g = [];
    const t0 = Date.now();
    while (Date.now() - t0 < SAMPLE * 1000) { g.push(gpuUtil()); await sleep(250); }
    const m1 = await metrics();
    const { result } = await cdp(ws, "Runtime.evaluate", {
      expression: "({raf: window.__raf, mut: window.__mut, anims: document.getAnimations().filter(a=>a.playState==='running').length, nodes: document.querySelectorAll('*').length})",
      returnByValue: true,
    });
    return {
      gpu: median(g), gpuMax: Math.max(...g),
      rafPerSec: +(result.value.raf / SAMPLE).toFixed(1),
      mutPerSec: +(result.value.mut / SAMPLE).toFixed(1),
      runningAnims: result.value.anims,
      nodes: result.value.nodes,
      recalc: (m1.RecalcStyleCount ?? 0) - (m0.RecalcStyleCount ?? 0),
      layouts: (m1.LayoutCount ?? 0) - (m0.LayoutCount ?? 0),
      scriptMs: +(((m1.ScriptDuration ?? 0) - (m0.ScriptDuration ?? 0)) * 1000).toFixed(0),
    };
  };

  const acc = Object.fromEntries(ARMS.map(([l]) => [l, []]));
  for (let c = 0; c < CYCLES; c++) {
    for (const [label, url] of ARMS) {
      const r = await measure(url);
      if (c > 0) acc[label].push(r); // discard warm-up cycle
      console.error(`cycle ${c} ${label.padEnd(22)} gpu=${String(r.gpu).padStart(4)}% raf/s=${String(r.rafPerSec).padStart(5)} mut/s=${String(r.mutPerSec).padStart(6)} anims=${r.runningAnims} recalc=${r.recalc} layouts=${r.layouts} scriptMs=${r.scriptMs}${c === 0 ? "  (discarded)" : ""}`);
    }
  }

  console.log("\n" + "=".repeat(88));
  const summary = {};
  for (const [label] of ARMS) {
    const rs = acc[label];
    summary[label] = {
      gpuMedian: median(rs.map((r) => r.gpu)),
      gpuRuns: rs.map((r) => r.gpu),
      rafPerSec: median(rs.map((r) => r.rafPerSec)),
      mutPerSec: median(rs.map((r) => r.mutPerSec)),
      runningAnims: median(rs.map((r) => r.runningAnims)),
      recalc: median(rs.map((r) => r.recalc)),
      layouts: median(rs.map((r) => r.layouts)),
      scriptMs: median(rs.map((r) => r.scriptMs)),
      nodes: rs[0]?.nodes,
    };
    const s = summary[label];
    console.log(
      `${label.padEnd(24)} gpuMedian=${String(s.gpuMedian).padStart(5)}%  runs=[${s.gpuRuns.join(",")}]  raf/s=${String(s.rafPerSec).padStart(5)}  mut/s=${String(s.mutPerSec).padStart(6)}  anims=${s.runningAnims}  recalc=${s.recalc}  layouts=${s.layouts}  scriptMs=${s.scriptMs}  nodes=${s.nodes}`,
    );
  }
  console.log("=".repeat(88));
  const base = summary[ARMS[0][0]].gpuMedian;
  for (const [label] of ARMS.slice(1))
    console.log(`DELTA ${label} - ${ARMS[0][0]}: ${+(summary[label].gpuMedian - base).toFixed(1)} pp`);
  writeFileSync(process.env.OUT ?? "/tmp/ab-loop.json", JSON.stringify(summary, null, 2));
  ws.close(); cleanup(); process.exit(0);
}
main().catch((e) => { console.error("ERR", e.message); cleanup(); process.exit(2); });
