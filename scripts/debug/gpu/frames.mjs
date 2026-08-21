#!/usr/bin/env node
// Contamination-free GPU-spin signal: count frames Chrome actually draws for
// the page while it sits idle. A quiet page draws ~0 frames/sec; a page that
// spins the GPU draws ~60/sec. Immune to other apps' GPU load.
// Usage: node frames.mjs <url> [idleSec]

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_ARG = process.argv[2] ?? "http://localhost:5183/";
const IDLE = Number(process.argv[3] ?? 8);
const SCROLL = process.env.SCROLL === "1";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.PORT_CDP ?? 9337);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error("timeout " + method)); } }, 30000);
    });
  return { send, on: (f) => listeners.push(f) };
}

const profile = mkdtempSync(join(tmpdir(), "frames-"));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--window-size=1440,900", "about:blank",
], { stdio: "ignore" });
const cleanup = () => { try { chrome.kill("SIGKILL"); } catch {} };
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(1); });

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

  const traceEvents = [];
  on((method, params) => {
    if (method === "Tracing.dataCollected") traceEvents.push(...params.value);
  });

  await send("Page.navigate", { url: URL_ARG });
  await sleep(5000); // boot + settle

  if (SCROLL) await send("Runtime.evaluate", { expression: "window.scrollTo(0, 400)" });
  await sleep(500);

  await send("Tracing.start", {
    traceConfig: {
      recordMode: "recordContinuously",
      includedCategories: [
        "disabled-by-default-devtools.timeline.frame",
        "disabled-by-default-devtools.timeline",
        "benchmark",
        "viz",
      ],
    },
    transferMode: "ReportEvents",
  });

  const t0 = Date.now();
  await sleep(IDLE * 1000);
  const elapsed = (Date.now() - t0) / 1000;

  const done = new Promise((r) => on((m) => { if (m === "Tracing.tracingComplete") r(); }));
  await send("Tracing.end");
  await done;

  const byName = {};
  for (const e of traceEvents) byName[e.name] = (byName[e.name] || 0) + 1;

  const draw = byName["DrawFrame"] ?? 0;
  const commit = byName["Commit"] ?? 0;
  const paint = byName["Paint"] ?? 0;
  const recalc = byName["UpdateLayoutTree"] ?? 0;
  const layout = byName["Layout"] ?? 0;
  const rasterTask = byName["RasterTask"] ?? 0;
  const pipeline = byName["PipelineReporter"] ?? 0;

  const { result } = await send("Runtime.evaluate", {
    expression: `({
      running: document.getAnimations().filter(a=>a.playState==='running').map(a=>{
        const t=a.effect&&a.effect.getTiming(); const el=a.effect&&a.effect.target;
        return {name:a.animationName||a.constructor.name, iters:t&&t.iterations, dur:t&&t.duration,
                cls: el?(el.getAttribute('class')||'').slice(0,80):null, tag: el?el.tagName.toLowerCase():null};
      }),
      nodes: document.querySelectorAll('*').length,
      title: document.title
    })`,
    returnByValue: true,
  });

  const per = (n) => +(n / elapsed).toFixed(1);
  const out = {
    url: URL_ARG, idleSec: +elapsed.toFixed(1), scrolled: SCROLL,
    perSec: { DrawFrame: per(draw), Commit: per(commit), Paint: per(paint), RasterTask: per(rasterTask), UpdateLayoutTree: per(recalc), Layout: per(layout), PipelineReporter: per(pipeline) },
    totals: { draw, commit, paint, rasterTask, recalc, layout, pipeline },
    page: result.value,
    topTraceEvents: Object.entries(byName).sort((a, b) => b[1] - a[1]).slice(0, 25),
  };

  console.log(`URL: ${URL_ARG}   idle=${out.idleSec}s   scrolled=${SCROLL}`);
  console.log("frames/sec ->", JSON.stringify(out.perSec, null, 2));
  console.log("running animations:", JSON.stringify(out.page.running, null, 2));
  console.log("nodes:", out.page.nodes);
  console.log("top trace events:", JSON.stringify(out.topTraceEvents));
  const VERDICT = out.perSec.DrawFrame > 5 || out.perSec.Commit > 5;
  console.log("\nVERDICT:", VERDICT ? "RED — page keeps drawing frames while idle" : "GREEN — page draws essentially no frames while idle");
  writeFileSync(process.env.OUT ?? "/tmp/frames.json", JSON.stringify(out, null, 2));
  ws.close(); cleanup(); process.exit(VERDICT ? 1 : 0);
}
main().catch((e) => { console.error("ERR", e.message); cleanup(); process.exit(2); });
