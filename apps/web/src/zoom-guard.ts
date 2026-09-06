/* Zoom suppression for the mobile webview.
 *
 * Teams on a phone hosts the app in a system webview, and the webview brings
 * the browser's own zoom gestures with it: pinch, double-tap, and (on iOS) the
 * automatic zoom that fires when a field smaller than 16px takes focus. None of
 * them belong in a task board — a stray double-tap on a card leaves the user
 * scrolled into a magnified corner with no obvious way back, because the
 * webview has no address bar and no reset control.
 *
 * Three layers are needed because no single one covers both platforms:
 *   1. the viewport meta in index.html  — Android/Chromium honours it
 *   2. `touch-action` in styles.css     — Chromium's declarative route
 *   3. this file                        — iOS/WKWebView, which ignores both
 *
 * The decision logic below is framework-free and side-effect-free so it can be
 * tested under `node --test`; `installZoomGuard` is the only part that touches
 * the DOM. */

/** How close together two taps must land, in time, to read as a double-tap.
 *  Mobile Safari's own threshold is ~300ms; the extra margin catches the slow
 *  end of a real double-tap without swallowing two deliberate separate taps. */
export const DOUBLE_TAP_MS = 320;

/** How close together two taps must land, in space. A user tapping two
 *  different buttons in quick succession is not double-tapping, and their taps
 *  will be further apart than a thumb wobble. */
export const DOUBLE_TAP_SLOP_PX = 40;

export type TapPoint = { x: number; y: number; t: number };

/** True when `next` is the second half of a double-tap started by `prev` —
 *  the gesture a webview turns into a zoom. `null` prev means there is no tap
 *  to pair with, so nothing to suppress. */
export function isDoubleTap(prev: TapPoint | null, next: TapPoint): boolean {
  if (!prev) return false;
  if (next.t - prev.t > DOUBLE_TAP_MS) return false;
  return Math.hypot(next.x - prev.x, next.y - prev.y) <= DOUBLE_TAP_SLOP_PX;
}

/** True when a touch sequence has enough fingers on the glass to pinch. */
export function isMultiTouch(touchCount: number): boolean {
  return touchCount > 1;
}

/** The tap-tracking half of the guard, kept apart from the DOM so the
 *  double-tap window can be tested without a browser. `tap` reports whether
 *  the tap it was just handed should be suppressed, and remembers it (or, when
 *  it did suppress one, forgets — so three fast taps are one suppression, not
 *  two). */
export function createTapTracker() {
  let last: TapPoint | null = null;
  return {
    tap(point: TapPoint): boolean {
      const suppress = isDoubleTap(last, point);
      last = suppress ? null : point;
      return suppress;
    },
    reset() {
      last = null;
    }
  };
}

type GuardTarget = {
  addEventListener: (type: string, fn: (e: any) => void, opts?: any) => void;
  removeEventListener: (type: string, fn: (e: any) => void, opts?: any) => void;
};

/** Wires the guard onto a document. Returns an uninstall function. */
export function installZoomGuard(target: GuardTarget): () => void {
  const tracker = createTapTracker();

  // iOS-only gesture events. These fire for pinch (and rotate) in WKWebView
  // regardless of the viewport meta, and preventing them is the only thing
  // that stops the zoom there.
  const blockGesture = (e: Event) => e.preventDefault();

  const onTouchMove = (e: TouchEvent) => {
    if (isMultiTouch(e.touches.length)) e.preventDefault();
  };

  const onTouchEnd = (e: TouchEvent) => {
    const touch = e.changedTouches[0];
    if (!touch) return;
    const point = { x: touch.clientX, y: touch.clientY, t: e.timeStamp };
    // Suppressing the tap cancels the webview's zoom, but it would also cancel
    // the click the user meant. Only the default action is blocked, and the
    // element's own click still dispatches from the first tap of the pair.
    if (tracker.tap(point) && e.cancelable) e.preventDefault();
  };

  target.addEventListener("gesturestart", blockGesture, { passive: false });
  target.addEventListener("gesturechange", blockGesture, { passive: false });
  target.addEventListener("gestureend", blockGesture, { passive: false });
  target.addEventListener("touchmove", onTouchMove, { passive: false });
  target.addEventListener("touchend", onTouchEnd, { passive: false });

  return () => {
    target.removeEventListener("gesturestart", blockGesture);
    target.removeEventListener("gesturechange", blockGesture);
    target.removeEventListener("gestureend", blockGesture);
    target.removeEventListener("touchmove", onTouchMove);
    target.removeEventListener("touchend", onTouchEnd);
  };
}
