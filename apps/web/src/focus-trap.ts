/* The keyboard stays on whatever is open on top (#492). Every overlay opens a
   trap; the last one opened is on top, and only it holds Tab and focus. When a
   trap closes, focus goes back to what opened it. The core takes its DOM
   through `FocusHost` so node can drive it without a browser. */
import { type RefObject, useEffect } from "react";

export interface FocusHost<N> {
  activeElement(): N | null;
  contains(container: N, node: N): boolean;
  isConnected(node: N): boolean;
  /* The container's Tab stops, in order. */
  tabbables(container: N): N[];
  focus(node: N): void;
}

export interface TabKey {
  key: string;
  shiftKey: boolean;
  preventDefault(): void;
}

const RECENT_FOCUS_KEPT = 8;

interface Trap<N> {
  container: N;
  opener: N | null;
}

export const createFocusTraps = <N>(host: FocusHost<N>) => {
  const stack: Trap<N>[] = [];
  /* Recent focus, newest last. An overlay that focuses its own field before
     its trap opens has already moved focus off the control that opened it. */
  const recent: N[] = [];
  const top = (): Trap<N> | undefined => stack[stack.length - 1];
  const inside = (trap: Trap<N>, node: N | null): boolean => node !== null && host.contains(trap.container, node);
  const enter = (trap: Trap<N>): void => {
    host.focus(host.tabbables(trap.container)[0] ?? trap.container);
  };

  return {
    open(container: N): () => void {
      const candidates = [...recent, host.activeElement()].reverse();
      const opener = candidates.find((n): n is N => n !== null && !host.contains(container, n)) ?? null;
      const trap: Trap<N> = { container, opener };
      stack.push(trap);
      return () => {
        const at = stack.indexOf(trap);
        if (at === -1) return;
        stack.splice(at, 1);
        /* Only the trap on top hands focus back. One closing under a prompt
           that was opened from inside it passes its own opener up, since the
           prompt's is going with it. */
        if (at !== stack.length) {
          const above = stack[at];
          if (above !== undefined && above.opener !== null && host.contains(container, above.opener)) above.opener = trap.opener;
          return;
        }
        const below = top();
        const opener = trap.opener;
        if (opener !== null && host.isConnected(opener) && (below === undefined || inside(below, opener))) {
          host.focus(opener);
        } else if (below !== undefined) {
          enter(below);
        }
      };
    },

    onKeyDown(e: TabKey): void {
      const trap = top();
      if (trap === undefined || e.key !== "Tab") return;
      const active = host.activeElement();
      const stops = host.tabbables(trap.container);
      const first = stops[0];
      const last = stops[stops.length - 1];
      let target: N | undefined;
      if (!inside(trap, active) || active === trap.container || first === undefined) target = e.shiftKey ? last : first;
      else if (e.shiftKey && active === first) target = last;
      else if (!e.shiftKey && active === last) target = first;
      else return;
      e.preventDefault();
      host.focus(target ?? trap.container);
    },

    /* Focus that got behind the top overlay some other way (a click on a
       toast, a script) goes back to where it was in the overlay. */
    onFocusIn(target: N): void {
      const trap = top();
      if (trap !== undefined && !inside(trap, target)) {
        const was = [...recent].reverse().find((n) => inside(trap, n) && host.isConnected(n));
        if (was === undefined) enter(trap);
        else host.focus(was);
        return;
      }
      recent.push(target);
      if (recent.length > RECENT_FOCUS_KEPT) recent.shift();
    }
  };
};

const TABBABLE =
  "a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex], [contenteditable=true]";

/* A radio group is one Tab stop: its checked radio, or its first when none is. */
const isTabStop = (el: HTMLElement, seen: Set<string>): boolean => {
  if (el.tabIndex < 0 || el.getClientRects().length === 0) return false;
  if (!(el instanceof HTMLInputElement) || el.type !== "radio" || el.name === "") return true;
  const key = el.form === null ? el.name : `${el.name}\u0000${el.form.id}`;
  if (seen.has(key)) return false;
  const scope = el.form ?? el.ownerDocument;
  const checked = scope.querySelector<HTMLInputElement>(`input[type=radio][name="${CSS.escape(el.name)}"]:checked`);
  if (checked !== null && checked !== el) return false;
  seen.add(key);
  return true;
};

const domHost: FocusHost<HTMLElement> = {
  activeElement: () => (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null),
  contains: (container, node) => container.contains(node),
  isConnected: (node) => node.isConnected,
  tabbables: (container) => {
    const seen = new Set<string>();
    return [...container.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => isTabStop(el, seen));
  },
  focus: (node) => node.focus()
};

const domTraps = typeof document === "undefined" ? undefined : createFocusTraps(domHost);
if (domTraps !== undefined) {
  window.addEventListener("keydown", (e) => domTraps.onKeyDown(e), true);
  document.addEventListener("focusin", (e) => { if (e.target instanceof HTMLElement) domTraps.onFocusIn(e.target); });
}

/* Holds the keyboard inside `ref` while the calling component is mounted. The
   container needs `tabIndex={-1}` so it can take focus when it has no stops. */
export const useFocusTrap = (ref: RefObject<HTMLElement | null>): void => {
  useEffect(() => {
    const el = ref.current;
    if (el === null || domTraps === undefined) return;
    return domTraps.open(el);
  }, [ref]);
};
