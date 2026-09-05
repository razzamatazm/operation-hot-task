/* PROTOTYPE — throwaway. Floating bar that swaps the dark-theme palette
   without touching any layout. Six stops: the palette shipping today,
   then five candidates (see prototype-dark-palettes.css).

   Forces data-theme="dark" while it's mounted, since the real applyTheme()
   takes its cue from Teams (or prefers-color-scheme outside Teams) and
   would otherwise drop us back to light mid-comparison.

   Dev-only: import.meta.env.DEV is statically false in a prod build, so
   this whole component tree-shakes out if the branch is ever merged. */
import { useCallback, useEffect, useState } from "react";
import "./prototype-dark-palettes.css";

type Stop = { key: string; name: string; swatches: string[] };

const STOPS: Stop[] = [
  { key: "current", name: "Shipping today — deep navy + gold", swatches: ["#111318", "#1e2129", "#989ca4", "#c9903f", "#e8e6e1"] },
  { key: "a", name: "A — Indigo Ledger (your palette)", swatches: ["#14143a", "#1a1a40", "#7070a3", "#d3d3e6", "#f5f5ff"] },
  { key: "b", name: "B — Warm Ink", swatches: ["#14120f", "#23201b", "#918879", "#e0a94f", "#f2ede4"] },
  { key: "c", name: "C — Graphite", swatches: ["#131517", "#24272a", "#8d9399", "#ff7d5c", "#edeff1"] },
  { key: "d", name: "D — Deep Teal", swatches: ["#0e1a1a", "#1a2e2c", "#7f9c97", "#f0c46e", "#e9f2ef"] },
  { key: "e", name: "E — Plum Noir", swatches: ["#110f16", "#221e2c", "#8f86a2", "#e58ac9", "#f3eff8"] },
];

const readKey = (): string => {
  const raw = new URLSearchParams(window.location.search).get("palette");
  return STOPS.some((s) => s.key === raw) ? raw! : "current";
};

const writeKey = (key: string): void => {
  const url = new URL(window.location.href);
  url.searchParams.set("palette", key);
  window.history.replaceState(null, "", url.toString());
};

export function PrototypePaletteSwitcher() {
  const [key, setKey] = useState(readKey);
  const index = STOPS.findIndex((s) => s.key === key);
  const stop = STOPS[index] ?? STOPS[0]!;

  const go = useCallback((delta: number) => {
    setKey((current) => {
      const at = STOPS.findIndex((s) => s.key === current);
      const next = STOPS[(at + delta + STOPS.length) % STOPS.length]!.key;
      writeKey(next);
      return next;
    });
  }, []);

  /* Pin the document to dark + the chosen palette, and put it back if
     applyTheme() (Teams theme change, or the initial context load) stomps
     on data-theme underneath us. */
  useEffect(() => {
    const root = document.documentElement;
    const pin = () => {
      if (root.getAttribute("data-theme") !== "dark") root.setAttribute("data-theme", "dark");
      const want = key === "current" ? null : key;
      if (root.getAttribute("data-palette") !== want) {
        if (want) root.setAttribute("data-palette", want);
        else root.removeAttribute("data-palette");
      }
    };
    pin();
    const observer = new MutationObserver(pin);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-palette"] });
    return () => observer.disconnect();
  }, [key]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      go(event.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  return (
    <div className="proto-palette-bar">
      <button type="button" onClick={() => go(-1)} aria-label="Previous palette">←</button>
      <span className="proto-palette-swatches">
        {stop.swatches.map((color) => (
          <span key={color} className="proto-palette-swatch" style={{ background: color }} />
        ))}
      </span>
      <span className="proto-palette-label">{stop.name}</span>
      <button type="button" onClick={() => go(1)} aria-label="Next palette">→</button>
    </div>
  );
}
