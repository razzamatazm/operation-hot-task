/*
 * PROTOTYPE (throwaway) — branch `prototype/status-tracker`. Not for main.
 *
 * Question: the expanded card's status rail wraps to two lines on a phone
 * (five steps on a Fraud Check or Loan Docs never fit a 390px card body). What
 * should the tracker be instead, so it gives the same answer without the mess?
 *
 * Three variants on the real expanded card behind `?variant=A|B|C`, plus the
 * floating switcher, which also cycles through the shipped rail (no param) for
 * comparison. `&coarse=1` forces the phone type floor, because automation
 * reports a fine pointer and would otherwise show every label ~15% small.
 *
 *   A  Meter   — current step and the next one on a line, a segmented bar under
 *   B  One line — step pips, the current step, then the next one
 *   C  Window  — previous step, current step as a pill, next step
 *
 * All three say "Needs corrections" in place of the step name rather than
 * beside it, which is what lets the corrections state stay on one line.
 */
import { useEffect } from "react";

export type TrackerVariant = "A" | "B" | "C";

const VARIANTS: { key: TrackerVariant | null; name: string }[] = [
  { key: null, name: "Shipped rail" },
  { key: "A", name: "Meter" },
  { key: "B", name: "One line" },
  { key: "C", name: "Window" }
];

/* Everything a variant needs, computed by `Timeline` from the shipped rules so
   the words stay the shipped words. `idx` is the step the task sits on (-1 on a
   cancelled task, which the shipped rail draws with nothing done). */
export type TrackerModel = {
  labels: string[];
  idx: number;
  corrections: string | null;
  finished: boolean;
  cancelled: boolean;
};

export const trackerVariant = (): TrackerVariant | null => {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("variant");
  return raw === "A" || raw === "B" || raw === "C" ? raw : null;
};

type Tone = "live" | "corrections" | "finished" | "cancelled";

const view = (m: TrackerModel) => {
  const last = m.labels.length - 1;
  const idx = m.finished ? last : m.idx;
  const tone: Tone = m.cancelled ? "cancelled" : m.finished ? "finished" : m.corrections ? "corrections" : "live";
  const label = m.cancelled ? "Cancelled" : (m.corrections ?? m.labels[idx] ?? "");
  const moving = tone === "live" || tone === "corrections";
  const next = moving ? m.labels[idx + 1] : undefined;
  const prev = idx > 0 ? m.labels[idx - 1] : undefined;
  const spoken = `${label}${idx >= 0 ? `, step ${idx + 1} of ${m.labels.length}` : ""}${next ? `. Next: ${next}` : ""}`;
  return { idx, tone, label, next, prev, total: m.labels.length, spoken };
};

const Chevron = () => (
  <svg className="st-icon" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const Tick = () => (
  <svg className="st-icon" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2.5 6.25 5 8.5l4.5-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/* A — Meter. The words say where it is and where it goes; the bar says how far. */
const TrackerA = ({ m }: { m: TrackerModel }) => {
  const v = view(m);
  return (
    <div className={`st st-a st-tone-${v.tone}`}>
      <span className="sr-only">{v.spoken}</span>
      <div className="st-a-head" aria-hidden="true">
        <span className="st-now">{v.label}</span>
        {v.next && (
          <span className="st-a-next">
            <span className="st-label">Next</span>
            <span className="st-next-name">{v.next}</span>
          </span>
        )}
      </div>
      <div className="st-a-bar" aria-hidden="true">
        {m.labels.map((l, i) => (
          <span
            key={l}
            title={l}
            className={`st-a-seg${i <= v.idx ? " st-on" : ""}${i === v.idx ? " st-here" : ""}`}
          />
        ))}
      </div>
    </div>
  );
};

/* B — One line. Position as pips, then only the two names that matter. */
const TrackerB = ({ m }: { m: TrackerModel }) => {
  const v = view(m);
  return (
    <div className={`st st-b st-tone-${v.tone}`}>
      <span className="sr-only">{v.spoken}</span>
      <span className="st-b-pips" aria-hidden="true">
        {m.labels.map((l, i) => (
          <span key={l} className="st-b-step">
            {i > 0 && <span className={`st-b-link${i <= v.idx ? " st-on" : ""}`} />}
            <span
              title={l}
              className={`st-b-pip${i < v.idx || (i === v.idx && v.tone === "finished") ? " st-on" : ""}${
                i === v.idx && v.tone !== "finished" ? " st-here" : ""
              }`}
            />
          </span>
        ))}
      </span>
      <span className="st-now" aria-hidden="true">
        {v.label}
      </span>
      {v.next && (
        <span className="st-b-next" aria-hidden="true">
          <Chevron />
          <span className="st-next-name">{v.next}</span>
        </span>
      )}
    </div>
  );
};

/* C — Window. Where it came from, where it is, where it goes. */
const TrackerC = ({ m }: { m: TrackerModel }) => {
  const v = view(m);
  return (
    <div className={`st st-c st-tone-${v.tone}`}>
      <span className="sr-only">{v.spoken}</span>
      {/* The past as a count, not a name: a step name here was the first thing
          to ellipsize on a phone ("Outstan…", "Merg…"), and nobody reads back. */}
      <span className="st-c-side st-c-prev" aria-hidden="true">
        {v.idx > 0 && (
          <>
            <Tick />
            <span className="st-next-name">{v.idx} done</span>
          </>
        )}
      </span>
      <span className="st-c-now" aria-hidden="true">
        {v.label}
      </span>
      <span className="st-c-side st-c-next" aria-hidden="true">
        {v.next && <span className="st-next-name">{v.next}</span>}
      </span>
    </div>
  );
};

export const PrototypeTracker = ({ variant, model }: { variant: TrackerVariant; model: TrackerModel }) =>
  variant === "A" ? <TrackerA m={model} /> : variant === "B" ? <TrackerB m={model} /> : <TrackerC m={model} />;

/* ── The switcher ─────────────────────────────────────────────────────────
 * Fixed pill at the bottom of the screen. Arrows and ← / → cycle through the
 * shipped rail and the three variants. It reloads rather than re-rendering:
 * `TaskCard` is memoised, so a URL change alone never reaches the rail, and the
 * open cards survive a reload because expansion is stored. Dev builds only. */
export const PrototypeTrackerSwitcher = () => {
  const current = trackerVariant();
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

  useEffect(() => {
    const coarse = new URLSearchParams(window.location.search).get("coarse") === "1";
    document.documentElement.toggleAttribute("data-st-coarse", coarse);
  }, []);

  if (!import.meta.env?.DEV) return null;
  return (
    <div className="st-switcher">
      <button type="button" aria-label="Previous variant" onClick={() => go(-1)}>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M7.5 2.5 4 6l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <span className="st-switcher-label">
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

/* Styles live here rather than in `styles.css` so the prototype is one file to
   delete. Theme tokens only, so each variant can be judged in all three. */
export const PrototypeTrackerStyles = () => (
  <style>{`
.st { font-size: 0.8rem; line-height: 1.3; min-width: 0; }
.st-now { font-weight: 600; color: var(--ink); white-space: nowrap; }
.st-tone-corrections .st-now { color: var(--warn); }
.st-tone-finished .st-now { color: var(--good); }
.st-tone-cancelled .st-now { color: var(--muted); }
.st-label {
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 0.6rem; font-weight: 600; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--muted);
}
.st-next-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-icon { width: 12px; height: 12px; flex: none; }

/* A — Meter */
.st-a { display: flex; flex-direction: column; gap: 7px; max-width: 440px; }
.st-a-head { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
.st-a-next { margin-left: auto; display: flex; align-items: baseline; gap: 6px; min-width: 0; color: var(--ink-secondary); }
.st-a-bar { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 3px; }
.st-a-seg { height: 4px; border-radius: 2px; background: var(--line); }
.st-a-seg.st-on { background: var(--ink); }
.st-tone-corrections .st-a-seg.st-here { background: var(--warn); }
.st-tone-finished .st-a-seg.st-on { background: var(--good); }

/* B — One line */
.st-b { display: flex; align-items: center; gap: 10px; }
.st-b-pips { display: flex; align-items: center; flex: none; }
.st-b-step { display: flex; align-items: center; }
.st-b-link { width: 7px; height: 1.5px; background: var(--line); }
.st-b-link.st-on { background: var(--ink); }
.st-b-pip {
  box-sizing: border-box; width: 7px; height: 7px; border-radius: 50%;
  border: 1.5px solid var(--line); background: transparent;
}
.st-b-pip.st-on { background: var(--ink); border-color: var(--ink); }
.st-b-pip.st-here { width: 11px; height: 11px; background: var(--ink); border-color: var(--ink); }
.st-tone-corrections .st-b-pip.st-here { background: var(--warn); border-color: var(--warn); }
.st-tone-finished .st-b-pip.st-on,
.st-tone-finished .st-b-link.st-on { background: var(--good); border-color: var(--good); }
.st-b-next { display: flex; align-items: center; gap: 4px; min-width: 0; color: var(--muted); }

/* C — Window */
.st-c { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1.3fr); align-items: center; gap: 6px; }
.st-c-side { display: flex; align-items: center; gap: 5px; min-width: 0; }
.st-c-prev { color: var(--ink-secondary); }
.st-c-next { color: var(--muted); }
.st-c-prev::after, .st-c-next::before {
  content: ""; flex: 1 1 10px; min-width: 10px; height: 1px; background: var(--line);
}
.st-c-next::before { order: -1; }
.st-c-side:empty::after, .st-c-side:empty::before { display: none; }
.st-c-now {
  display: inline-flex; align-items: baseline; gap: 7px;
  padding: 3px 10px; border: 1px solid var(--ink); border-radius: 999px;
  font-weight: 600; color: var(--ink); background: var(--panel); white-space: nowrap;
}
.st-c-count {
  font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 0.62rem;
  font-weight: 500; color: var(--muted); font-variant-numeric: tabular-nums;
}
.st-tone-corrections .st-c-now { border-color: var(--warn); color: var(--warn); background: var(--warn-bg); }
.st-tone-finished .st-c-now { border-color: var(--good); color: var(--good); background: var(--good-bg); }
.st-tone-cancelled .st-c-now { border-color: var(--line); color: var(--muted); }

/* The phone floor, the same 12px / 11px the shipped touch floors use. */
@media (pointer: coarse) {
  .st { font-size: 12px; }
  .st-label, .st-c-count { font-size: 11px; }
}
[data-st-coarse] .st { font-size: 12px; }
[data-st-coarse] .st-label, [data-st-coarse] .st-c-count { font-size: 11px; }

/* Switcher */
.st-switcher {
  position: fixed; bottom: 14px; left: 50%; transform: translateX(-50%);
  z-index: 9999; display: flex; align-items: center; gap: 8px;
  padding: 6px 8px; border-radius: 999px;
  background: #111; color: #fff; box-shadow: 0 6px 24px rgba(0,0,0,0.35);
  font-family: "JetBrains Mono", monospace; font-size: 0.7rem; white-space: nowrap;
}
.st-switcher button {
  display: grid; place-items: center; border: 0; padding: 0;
  background: rgba(255,255,255,0.14); color: #fff;
  border-radius: 999px; width: 26px; height: 26px; cursor: pointer;
}
.st-switcher svg { width: 12px; height: 12px; }
.st-switcher-label { padding: 0 4px; letter-spacing: 0.04em; }
`}</style>
);
