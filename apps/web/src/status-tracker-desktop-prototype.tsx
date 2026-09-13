/*
 * PROTOTYPE (throwaway) — branch `prototype/status-tracker-desktop`. Not for main.
 *
 * Question: the one-line status tracker (#421) is right on a phone but looks
 * awkwardly small on a desktop card: a 440px strip of 0.85rem text and a 4px
 * bar in the corner of a ~1250px body. What should it look like on a desktop,
 * without giving up the phone's "never wraps" behaviour?
 *
 * Three variants on the real expanded card behind `?variant=A|B|C`, plus the
 * floating switcher, which also cycles back to the shipped tracker (no param).
 * Every variant draws the SHIPPED tracker under 720px, untouched, and its own
 * layout from 720px up. So the phone answer is the same in all four; only the
 * desktop differs.
 *
 *   A  Labeled rail — full-width bar, each step's name under its own segment
 *   B  Inline strip — big current step left, bar across the middle, next right
 *   C  Track        — the steps as one connected track, the current one filled
 */
import { useEffect, type ReactNode } from "react";

export type DesktopVariant = "A" | "B" | "C";

const VARIANTS: { key: DesktopVariant | null; name: string }[] = [
  { key: null, name: "Shipped" },
  { key: "A", name: "Labeled rail" },
  { key: "B", name: "Inline strip" },
  { key: "C", name: "Track" }
];

/* Computed by `Timeline` from its own rules, so the words stay the shipped
   words. `idx` is -1 on a status in no flow (CANCELLED). */
export type DesktopModel = {
  labels: string[];
  idx: number;
  tone: "live" | "corrections" | "finished" | "off";
  now: string;
  next?: string | undefined;
};

export const desktopVariant = (): DesktopVariant | null => {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("variant");
  return raw === "A" || raw === "B" || raw === "C" ? raw : null;
};

const stepState = (m: DesktopModel, i: number): "done" | "here" | "todo" =>
  m.idx < 0 ? "todo" : i < m.idx || (i === m.idx && m.tone === "finished") ? "done" : i === m.idx ? "here" : "todo";

const Tick = () => (
  <svg className="dt-tick" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2.5 6.25 5 8.5l4.5-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/* A — Labeled rail. On a desktop there is room to name every step, so it does. */
const DesktopA = ({ m }: { m: DesktopModel }) => (
  <div className="dt-a">
    {m.idx < 0 && <div className="dt-a-off">{m.now}</div>}
    <div className="dt-a-rail" style={{ gridTemplateColumns: `repeat(${m.labels.length}, minmax(0, 1fr))` }}>
      {m.labels.map((l, i) => {
        const s = stepState(m, i);
        const finishedHere = m.tone === "finished" && i === m.labels.length - 1;
        return (
          <div key={l} className={`dt-a-step dt-${s}${finishedHere ? " dt-a-final" : ""}`}>
            <span className="dt-a-seg" />
            <span className="dt-a-name">{s === "here" ? m.now : l}</span>
          </div>
        );
      })}
    </div>
  </div>
);

/* B — Inline strip. The words get display size; the bar takes the width. */
const DesktopB = ({ m }: { m: DesktopModel }) => (
  <div className="dt-b">
    <div className="dt-b-now">
      <span className="dt-cap">{m.idx < 0 ? "Status" : `Step ${m.idx + 1} of ${m.labels.length}`}</span>
      <span className="dt-b-now-name">{m.now}</span>
    </div>
    <div className="dt-b-bar" style={{ gridTemplateColumns: `repeat(${m.labels.length}, minmax(0, 1fr))` }}>
      {m.labels.map((l, i) => (
        <span key={l} title={l} className={`dt-b-seg dt-${stepState(m, i)}`} />
      ))}
    </div>
    <div className="dt-b-next">
      {m.next ? (
        <>
          <span className="dt-cap">Next</span>
          <span className="dt-b-next-name">{m.next}</span>
        </>
      ) : (
        <span className="dt-cap">{m.tone === "finished" ? "All steps done" : ""}</span>
      )}
    </div>
  </div>
);

/* C — Track. The app menu's hollow track with the chosen half filled, one
   stop per step. */
const DesktopC = ({ m }: { m: DesktopModel }) => (
  <div className="dt-c" style={{ gridTemplateColumns: `repeat(${m.labels.length}, minmax(0, 1fr))` }}>
    {m.labels.map((l, i) => {
      const s = stepState(m, i);
      return (
        <div key={l} className={`dt-c-stop dt-${s}`}>
          {s === "done" ? <Tick /> : <span className="dt-c-num">{i + 1}</span>}
          <span className="dt-c-name">{s === "here" ? m.now : l}</span>
        </div>
      );
    })}
  </div>
);

export const DesktopTracker = ({
  variant,
  model,
  children
}: {
  variant: DesktopVariant;
  model: DesktopModel;
  children: ReactNode;
}) => (
  <div className={`dt dt-tone-${model.tone}`}>
    {/* The shipped tracker, shown under 720px only. */}
    <div className="dt-phone">{children}</div>
    <div className="dt-desk" aria-hidden="true">
      {variant === "A" ? <DesktopA m={model} /> : variant === "B" ? <DesktopB m={model} /> : <DesktopC m={model} />}
    </div>
  </div>
);

/* ── The switcher ─────────────────────────────────────────────────────────
 * Arrows and ← / → cycle through the shipped tracker and the three variants.
 * It reloads rather than re-rendering: `TaskCard` is memoised, so a URL change
 * alone never reaches the tracker, and open cards survive because expansion is
 * stored. Dev builds only. */
export const DesktopTrackerSwitcher = () => {
  const current = desktopVariant();
  const at = Math.max(0, VARIANTS.findIndex((v) => v.key === current));

  const go = (step: number): void => {
    const next = VARIANTS[(at + step + VARIANTS.length) % VARIANTS.length]?.key ?? null;
    const url = new URL(window.location.href);
    if (next === null) url.searchParams.delete("variant");
    else url.searchParams.set("variant", next);
    window.location.replace(url.toString());
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable);
      if (typing || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      go(e.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!import.meta.env?.DEV) return null;
  return (
    <div className="dt-switcher">
      <button type="button" aria-label="Previous variant" onClick={() => go(-1)}>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M7.5 2.5 4 6l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <span className="dt-switcher-label">
        {current ?? "—"} · {VARIANTS[at]?.name}
      </span>
      <button type="button" aria-label="Next variant" onClick={() => go(1)}>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
};

/* Styles live here so the prototype is one file to delete. Theme tokens only. */
export const DesktopTrackerStyles = () => (
  <style>{`
.dt-desk { display: none; }
@media (min-width: 720px) {
  .dt-phone { display: none; }
  .dt-desk { display: block; }
}
.dt-cap {
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 0.62rem; font-weight: 600; letter-spacing: 0.07em;
  text-transform: uppercase; color: var(--muted); white-space: nowrap;
}
.dt-tick { width: 13px; height: 13px; flex: none; }

/* A — Labeled rail */
.dt-a { display: flex; flex-direction: column; gap: 8px; padding: 2px 0 4px; }
.dt-a-off { font-weight: 600; color: var(--muted); font-size: 0.95rem; }
.dt-a-rail { display: grid; column-gap: 6px; }
.dt-a-step { display: flex; flex-direction: column; gap: 9px; min-width: 0; }
.dt-a-seg { height: 6px; border-radius: 999px; background: var(--line); }
.dt-a-name {
  font-size: 0.88rem; line-height: 1.25; color: var(--muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dt-a-step.dt-done .dt-a-seg, .dt-a-step.dt-here .dt-a-seg { background: var(--ink); }
.dt-a-step.dt-done .dt-a-name { color: var(--ink-secondary); }
.dt-a-step.dt-here .dt-a-name { color: var(--ink); font-weight: 600; }
.dt-tone-corrections .dt-a-step.dt-here .dt-a-seg { background: var(--warn); }
.dt-tone-corrections .dt-a-step.dt-here .dt-a-name { color: var(--warn); }
.dt-tone-finished .dt-a-step.dt-done .dt-a-seg { background: var(--good); }
.dt-a-step.dt-a-final .dt-a-name { color: var(--good); font-weight: 600; }

/* B — Inline strip */
.dt-b {
  display: grid; grid-template-columns: minmax(150px, auto) minmax(160px, 1fr) minmax(150px, auto);
  align-items: center; column-gap: 28px; padding: 4px 0;
}
.dt-b-now, .dt-b-next { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dt-b-next { align-items: flex-end; text-align: right; }
.dt-b-now-name {
  font-family: "Bricolage Grotesque", sans-serif; font-weight: 700;
  font-size: 1.2rem; line-height: 1.15; color: var(--ink); white-space: nowrap;
}
.dt-b-next-name {
  font-size: 0.95rem; color: var(--ink-secondary); max-width: 220px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dt-b-bar { display: grid; column-gap: 5px; align-self: center; }
.dt-b-seg { height: 8px; border-radius: 999px; background: var(--line); }
.dt-b-seg.dt-done, .dt-b-seg.dt-here { background: var(--ink); }
.dt-tone-corrections .dt-b-now-name { color: var(--warn); }
.dt-tone-corrections .dt-b-seg.dt-here { background: var(--warn); }
.dt-tone-finished .dt-b-now-name { color: var(--good); }
.dt-tone-finished .dt-b-seg.dt-done { background: var(--good); }
.dt-tone-off .dt-b-now-name { color: var(--muted); }

/* C — Track */
.dt-c {
  display: grid; border: 1px solid var(--line); border-radius: 8px;
  overflow: hidden; background: var(--panel);
}
.dt-c-stop {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  min-width: 0; padding: 9px 12px; font-size: 0.88rem; color: var(--muted);
}
.dt-c-stop + .dt-c-stop { border-left: 1px solid var(--line); }
.dt-c-num {
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 0.7rem; font-weight: 600; flex: none;
}
.dt-c-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dt-c-stop.dt-done { color: var(--ink-secondary); }
.dt-c-stop.dt-here { background: var(--brand); color: var(--on-accent); font-weight: 600; border-left-color: transparent; }
.dt-c-stop.dt-here + .dt-c-stop { border-left-color: transparent; }
.dt-tone-corrections .dt-c-stop.dt-here { background: var(--warn); }
.dt-tone-finished .dt-c-stop.dt-done { color: var(--good); }
.dt-tone-off .dt-c { opacity: 0.6; }

/* Switcher */
.dt-switcher {
  position: fixed; bottom: 14px; left: 50%; transform: translateX(-50%);
  z-index: 9999; display: flex; align-items: center; gap: 8px;
  padding: 6px 8px; border-radius: 999px;
  background: #111; color: #fff; box-shadow: 0 6px 24px rgba(0,0,0,0.35);
  font-family: "JetBrains Mono", monospace; font-size: 0.7rem; white-space: nowrap;
}
.dt-switcher button {
  display: grid; place-items: center; border: 0; padding: 0;
  background: rgba(255,255,255,0.14); color: #fff;
  border-radius: 999px; width: 26px; height: 26px; cursor: pointer;
}
.dt-switcher svg { width: 12px; height: 12px; }
.dt-switcher-label { padding: 0 4px; letter-spacing: 0.04em; }
`}</style>
);
