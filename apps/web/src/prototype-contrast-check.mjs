/* PROTOTYPE — throwaway. Checks each candidate dark palette against the
   legibility floors the shipping dark theme fought for: ink/ink-secondary/
   muted vs panel at 4.5:1 (AA text), line/line-soft vs panel at 3:1 (UI
   component), and on-accent vs each filled accent at 4.5:1.
   Run: node apps/web/src/prototype-contrast-check.mjs */
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./prototype-dark-palettes.css", import.meta.url), "utf8");

const lum = (hex) => {
  const n = hex.replace("#", "");
  const full = n.length === 3 ? n.split("").map((c) => c + c).join("") : n;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(full.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const blocks = [...css.matchAll(/\[data-palette="([\w-]+)"\]\s*\{([^}]*)\}/g)];
const SHIPPING = {
  key: "current", panel: "#1e2129", bg: "#111318", ink: "#e8e6e1", "ink-secondary": "#a09b91",
  muted: "#b3b5ba", line: "#989ca4", "line-soft": "#75787f", brand: "#c9903f", "on-accent": "#14171c",
  good: "#5ec97e", warn: "#e0b44a", hot: "#e8944a", bad: "#e66b6b",
  "avatar-ink": "#14171c", "avatar-1": "#e0b44a", "avatar-2": "#6da3e0", "avatar-3": "#4fc4b0",
  "avatar-4": "#b083c9", "avatar-5": "#e0805a", "avatar-6": "#9ac25a", "avatar-7": "#8fa3c9", "avatar-8": "#d97fb0",
};

const parsed = blocks.map(([, key, body]) => {
  const vars = Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{3,8})\s*;/gi)].map((m) => [m[1], m[2]])
  );
  return { key, ...vars };
});

let worst = [];
for (const p of [SHIPPING, ...parsed]) {
  const checks = [
    ["ink vs panel", ratio(p.ink, p.panel), 4.5],
    ["ink vs bg", ratio(p.ink, p.bg), 4.5],
    ["ink-secondary vs panel", ratio(p["ink-secondary"], p.panel), 4.5],
    ["muted vs panel", ratio(p.muted, p.panel), 4.5],
    ["line vs panel", ratio(p.line, p.panel), 3],
    ["line-soft vs panel", ratio(p["line-soft"], p.panel), 3],
    ["brand vs panel", ratio(p.brand, p.panel), 4.5],
    ["on-accent vs brand", ratio(p["on-accent"], p.brand), 4.5],
    ["good vs panel", ratio(p.good, p.panel), 4.5],
    ["warn vs panel", ratio(p.warn, p.panel), 4.5],
    ["hot vs panel", ratio(p.hot, p.panel), 4.5],
    ["bad vs panel", ratio(p.bad, p.panel), 4.5],
    /* Initials sit on the chip, so every avatar slot has to carry the one
       --avatar-ink. Reported as the worst of the eight. */
    ["avatar-ink vs chips", Math.min(...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ratio(p["avatar-ink"], p[`avatar-${n}`]))), 4.5],
  ];
  console.log(`\n── palette ${p.key} ──`);
  for (const [label, value, floor] of checks) {
    const ok = value >= floor;
    if (!ok) worst.push(`${p.key}: ${label} = ${value.toFixed(2)} (needs ${floor})`);
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(24)} ${value.toFixed(2)}`);
  }
}
console.log(worst.length ? `\n${worst.length} FAILURES:\n  ${worst.join("\n  ")}` : "\nAll palettes clear the floors.");
