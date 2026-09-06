/* Zoom suppression for the mobile webview.
 *
 * Teams on a phone hosts the app in a system webview, and the webview brings
 * the browser's own zoom gestures with it. None of them belong in a task board
 * — a stray pinch leaves the user magnified into a corner with no obvious way
 * back, because the webview has no address bar and no reset control.
 *
 * Three layers are needed because no single one covers every gesture:
 *   1. the viewport meta in index.html  — Android/Chromium honours it
 *   2. `touch-action` in styles.css     — takes double-tap-zoom on both
 *                                         platforms, and pinch on Chromium
 *   3. this file                        — the iOS pinch, which neither of the
 *                                         other two reaches
 *
 * Deliberately NOT here: double-tap. `touch-action: pan-x pan-y` already takes
 * it on every engine the app runs in, and doing it again in JS actively broke
 * the app. Cancelling a `touchend` cancels the whole synthesized mouse
 * sequence after it — `click` and focus included — so suppressing the second
 * tap of a pair also swallowed that tap's press. Two quick checks down a
 * checklist, or a tap into a field right after a nearby control, lost the
 * second one. The declarative rule stops the zoom without touching the click,
 * which is the whole reason to prefer it.
 *
 * The predicate below is framework-free and side-effect-free so it can be
 * tested under `node --test`; `installZoomGuard` is the only part that touches
 * the DOM. */

/** True when a touch sequence has enough fingers on the glass to pinch. */
export function isMultiTouch(touchCount: number): boolean {
  return touchCount > 1;
}

type GuardTarget = {
  addEventListener: (type: string, fn: (e: any) => void, opts?: any) => void;
  removeEventListener: (type: string, fn: (e: any) => void, opts?: any) => void;
};

/** Wires the guard onto a document. Returns an uninstall function — unused in
 *  the app, which installs once for the life of the page, and exercised by the
 *  tests. */
export function installZoomGuard(target: GuardTarget): () => void {
  // iOS-only gesture events. These fire for pinch (and rotate) in WKWebView
  // regardless of the viewport meta, and cancelling them is the only thing
  // that stops the zoom there. Cancelling a gesture event has no click to
  // break: a pinch is not a tap, and no mouse sequence is synthesized from it.
  const blockGesture = (e: Event) => e.preventDefault();

  // The same pinch seen through the touch API, for engines that report the
  // fingers but not the gesture. Guarded on the finger count so a one-finger
  // scroll is never cancelled.
  const onTouchMove = (e: TouchEvent) => {
    if (isMultiTouch(e.touches.length)) e.preventDefault();
  };

  target.addEventListener("gesturestart", blockGesture, { passive: false });
  target.addEventListener("gesturechange", blockGesture, { passive: false });
  target.addEventListener("gestureend", blockGesture, { passive: false });
  target.addEventListener("touchmove", onTouchMove, { passive: false });

  return () => {
    target.removeEventListener("gesturestart", blockGesture);
    target.removeEventListener("gesturechange", blockGesture);
    target.removeEventListener("gestureend", blockGesture);
    target.removeEventListener("touchmove", onTouchMove);
  };
}
