/* ── Toast store (pure) ──────────────────────────────────────
   Framework-free queue logic for the toast host (`toast.tsx`). Kept free of
   React and JSX so it can be unit-tested directly under `node --test`
   (`scripts/toast-host-sim-test.mjs`). The React layer owns the timers; this
   module only shapes toasts and manages the visible list.

   Introduced in Wave 1 for the "Shared" confirmation (#60); Wave 2 (#56) reuses
   the same host for the "Linked to an existing loan" confirmation. */

export type ToastVariant = "info" | "success" | "warn" | "error";

export interface ToastOptions {
  /* Signal color. Defaults to "info" (neutral). */
  variant?: ToastVariant;
  /* Auto-dismiss delay in ms. 0 keeps it until dismissed by hand. */
  durationMs?: number;
}

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
  durationMs: number;
}

/* Long enough to read a short confirmation, short enough to stay out of the way. */
export const DEFAULT_TOAST_MS = 2600;
/* Cap the stack so a burst of toasts can't blanket the screen. Oldest drop first. */
export const MAX_TOASTS = 3;

let seq = 0;

/* Build a toast, filling defaults and clamping the duration. Each call gets a
   unique id (monotonic counter + time suffix) so list keys stay stable. */
export const makeToast = (message: string, options: ToastOptions = {}): Toast => ({
  id: `toast-${++seq}-${Date.now().toString(36)}`,
  message,
  variant: options.variant ?? "info",
  durationMs: Math.max(0, options.durationMs ?? DEFAULT_TOAST_MS)
});

/* Append a toast, trimming the oldest entries past MAX_TOASTS. */
export const pushToast = (list: readonly Toast[], toast: Toast): Toast[] => {
  const next = [...list, toast];
  return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
};

/* Remove a toast by id. Unknown ids are a no-op (returns an equal-content list). */
export const dismissToast = (list: readonly Toast[], id: string): Toast[] =>
  list.filter((t) => t.id !== id);
