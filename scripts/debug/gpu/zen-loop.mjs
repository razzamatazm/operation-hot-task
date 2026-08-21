#!/usr/bin/env node
// Attribution loop for Zen (Firefox/WebRender) on macOS.
// Question: does the GPU spin because of THIS APP, or does Zen spin on anything?
// Launches Zen with a throwaway profile (never touches the real one), parks it
// on each arm, and samples real GPU utilization. Arms alternate across cycles
// and cycle 0 is discarded so launch transients aren't blamed on an arm.
//
// Usage: node zen-loop.mjs [cycles] [sampleSec]

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CYCLES = Number(process.argv[2] ?? 3);
const SAMPLE = Number(process.argv[3] ?? 12);
const SETTLE = Number(process.env.SETTLE ?? 10);
const ZEN = "/Applications/Zen.app/Contents/MacOS/zen";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ARMS = JSON.parse(
  process.env.ARMS ??
    JSON.stringify([
      ["blank", "about:blank"],
      ["static-control", "http://localhost:4120/"],
      ["app", "http://localhost:5183/"],
    ]),
);

function gpu() {
  const out = execFileSync("ioreg", ["-r", "-d", "1", "-w", "0", "-c", "AGXAccelerator"], { encoding: "utf8" });
  const g = (k) => { const m = out.match(new RegExp(`"${k}"=(\\d+)`)); return m ? +m[1] : -1; };
  return { device: g("Device Utilization %"), renderer: g("Renderer Utilization %") };
}

// CPU of just this throwaway Zen instance, split out by process type.
function zenCpu(profileDir) {
  try {
    const out = execFileSync("ps", ["-Ao", "pid,pcpu,command"], { encoding: "utf8" });
    const rows = out.split("\n").filter((l) => l.includes(profileDir));
    const sum = (rows) => +rows.reduce((s, l) => s + parseFloat(l.trim().split(/\s+/)[1] || 0), 0).toFixed(1);
    return {
      total: sum(rows),
      gpuProc: sum(rows.filter((l) => l.includes("gpu") || l.includes("GPU"))),
      count: rows.length,
    };
  } catch { return { total: -1, gpuProc: -1, count: 0 }; }
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : +((s[m - 1] + s[m]) / 2).toFixed(1)) : 0; };

async function measure(label, url) {
  const profile = mkdtempSync(join(tmpdir(), "zenprobe-"));
  const proc = spawn(ZEN, ["--profile", profile, "--no-remote", "--new-instance", url], { stdio: "ignore" });
  const kill = () => { try { process.kill(-proc.pid, "SIGKILL"); } catch {} try { proc.kill("SIGKILL"); } catch {} };
  try {
    await sleep(SETTLE * 1000);
    const dev = [], ren = [], cpu = [], gproc = [];
    const t0 = Date.now();
    while (Date.now() - t0 < SAMPLE * 1000) {
      const g = gpu();
      dev.push(g.device); ren.push(g.renderer);
      const c = zenCpu(profile);
      cpu.push(c.total); gproc.push(c.gpuProc);
      await sleep(300);
    }
    return {
      label, url,
      gpuMedian: median(dev), gpuMax: Math.max(...dev), gpuMin: Math.min(...dev),
      rendererMedian: median(ren),
      zenCpuMedian: median(cpu), zenGpuProcCpuMedian: median(gproc),
      procs: zenCpu(profile).count,
    };
  } finally {
    kill();
    try { execFileSync("pkill", ["-f", profile]); } catch { /* pkill exits 1 when nothing matched */ }
    await sleep(2500); // let the GPU settle before the next arm
  }
}

async function main() {
  const acc = {};
  for (let c = 0; c < CYCLES; c++) {
    for (const [label, url] of ARMS) {
      let r;
      try { r = await measure(label, url); }
      catch (e) { console.error("arm failed", label, e.message); continue; }
      if (c > 0) (acc[label] ??= []).push(r);
      console.error(
        `cycle ${c} ${label.padEnd(16)} gpu=${String(r.gpuMedian).padStart(5)}% (min ${r.gpuMin} max ${r.gpuMax})  zenCPU=${String(r.zenCpuMedian).padStart(6)}%  gpuProcCPU=${String(r.zenGpuProcCpuMedian).padStart(5)}%  procs=${r.procs}${c === 0 ? "  (discarded)" : ""}`,
      );
    }
  }

  console.log("\n" + "=".repeat(92));
  const summary = {};
  for (const [label] of ARMS) {
    const rs = acc[label] ?? [];
    if (!rs.length) continue;
    summary[label] = {
      gpuMedian: median(rs.map((r) => r.gpuMedian)),
      gpuRuns: rs.map((r) => r.gpuMedian),
      zenCpuMedian: median(rs.map((r) => r.zenCpuMedian)),
      gpuProcCpu: median(rs.map((r) => r.zenGpuProcCpuMedian)),
    };
    const s = summary[label];
    console.log(`${label.padEnd(16)} gpuMedian=${String(s.gpuMedian).padStart(5)}%  runs=[${s.gpuRuns.join(",")}]  zenCPU=${String(s.zenCpuMedian).padStart(6)}%  gpuProcCPU=${String(s.gpuProcCpu).padStart(5)}%`);
  }
  console.log("=".repeat(92));
  if (summary.blank) {
    for (const [label] of ARMS.slice(1))
      if (summary[label])
        console.log(`DELTA ${label} - blank: ${+(summary[label].gpuMedian - summary.blank.gpuMedian).toFixed(1)} pp GPU, ${+(summary[label].zenCpuMedian - summary.blank.zenCpuMedian).toFixed(1)} pp Zen CPU`);
  }
  writeFileSync(process.env.OUT ?? "/tmp/zen-loop.json", JSON.stringify(summary, null, 2));
}
main().catch((e) => { console.error("ERR", e.message); process.exit(2); });
