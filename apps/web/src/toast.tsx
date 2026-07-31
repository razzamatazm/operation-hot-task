/* ── Toast host (React) ──────────────────────────────────────
   A minimal, app-wide toast host: mount <ToastProvider> once near the root,
   then call `useToast().showToast(message, { variant, durationMs })` from
   anywhere below it. Toasts auto-dismiss after their duration (or on click).

   Queue shaping lives in the framework-free `toast-store` so it stays testable;
   this layer only owns the timers and the rendered stack. Introduced in Wave 1
   for the Share "Shared" confirmation (#60); reusable by later waves (#56). */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { ReactNode } from "react";
import {
  DEFAULT_TOAST_MS,
  dismissToast,
  makeToast,
  pushToast,
  type Toast,
  type ToastOptions
} from "./toast-store";

interface ToastApi {
  /* Show a toast. Returns its id so a caller can dismiss it early if needed. */
  showToast: (message: string, options?: ToastOptions) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  /* id → pending auto-dismiss timer, so we can clear on manual dismiss/unmount. */
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    const handle = timers.current.get(id);
    if (handle) {
      clearTimeout(handle);
      timers.current.delete(id);
    }
    setToasts((list) => dismissToast(list, id));
  }, []);

  const showToast = useCallback(
    (message: string, options?: ToastOptions) => {
      const toast = makeToast(message, options);
      setToasts((list) => pushToast(list, toast));
      if (toast.durationMs > 0) {
        timers.current.set(toast.id, setTimeout(() => dismiss(toast.id), toast.durationMs));
      }
      return toast.id;
    },
    [dismiss]
  );

  /* Clear every pending timer if the provider unmounts. */
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((handle) => clearTimeout(handle));
      pending.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({ showToast, dismiss }), [showToast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* One polite live region on the host; children are plain nodes so a
          screen reader announces each toast once (not doubled by role=status). */}
      <div className="toast-host" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast toast-${toast.variant}`}
            onClick={() => dismiss(toast.id)}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = (): ToastApi => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
};

export { DEFAULT_TOAST_MS };
export type { ToastOptions, ToastVariant } from "./toast-store";
