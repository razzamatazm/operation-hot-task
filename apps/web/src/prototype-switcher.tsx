/* PROTOTYPE for #438, throwaway. Three ways to put Metrics and Admin in the
   app menu, switched by ?variant=A|B|C and the floating bar at the bottom.
   Dev builds only. Do not merge this file. */
import { useEffect, useState } from "react";

export const MENU_VARIANTS = [
  { key: "A", name: "List rows at the top" },
  { key: "B", name: "Admin section at the bottom" },
  { key: "C", name: "Page track at the top" }
] as const;

export type MenuVariant = (typeof MENU_VARIANTS)[number]["key"];

const CHANGE_EVENT = "prototype-variant-change";

const readVariant = (): MenuVariant => {
  const raw = new URLSearchParams(window.location.search).get("variant");
  return MENU_VARIANTS.find((v) => v.key === raw)?.key ?? "A";
};

export const usePrototypeVariant = (): MenuVariant => {
  const [variant, setVariant] = useState<MenuVariant>(readVariant);
  useEffect(() => {
    const onChange = (): void => setVariant(readVariant());
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener("popstate", onChange);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener("popstate", onChange);
    };
  }, []);
  return variant;
};

const goTo = (key: MenuVariant): void => {
  const url = new URL(window.location.href);
  url.searchParams.set("variant", key);
  window.history.replaceState(null, "", url);
  window.dispatchEvent(new Event(CHANGE_EVENT));
};

export const PrototypeSwitcher = () => {
  const current = usePrototypeVariant();
  const index = MENU_VARIANTS.findIndex((v) => v.key === current);
  const step = (delta: number): void => {
    const n = MENU_VARIANTS.length;
    goTo(MENU_VARIANTS[(index + delta + n) % n]?.key ?? "A");
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.matches("input, textarea, select") || el.isContentEditable)) return;
      step(e.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!import.meta.env.DEV) return null;

  return (
    <div className="proto-switcher" role="toolbar" aria-label="Prototype variants">
      <button type="button" className="proto-switcher-arrow" aria-label="Previous variant" onClick={() => step(-1)}>
        ←
      </button>
      <span className="proto-switcher-label">
        {current} — {MENU_VARIANTS[index]?.name}
      </span>
      <button type="button" className="proto-switcher-arrow" aria-label="Next variant" onClick={() => step(1)}>
        →
      </button>
    </div>
  );
};
