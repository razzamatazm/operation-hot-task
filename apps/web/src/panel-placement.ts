/* Where an anchored, portaled panel goes (#113, #122, #231).
 *
 * Lifted out of App.tsx so it can be tested: it is pure arithmetic over a
 * trigger's rect and a viewport, and the one thing it must never do — let a
 * panel hang off the screen — is exactly what a screenshot review is bad at
 * catching and a test is good at. Same reasoning as `expand-state.ts` and
 * `toast-store.ts`: framework-free logic lives in its own module so a node test
 * can import it directly.
 *
 * The rule: prefer opening downward, flip above only when below cannot hold the
 * panel and above can, then clamp both axes into the viewport regardless.
 */

export const PANEL_GAP = 6;
export const PANEL_MARGIN = 8;

export type PanelBox = { top: number; left: number };
export type Viewport = { width: number; height: number };
/* Only the four edges are used, so callers can pass a real DOMRect or a plain
   object — which is what makes this testable without a browser. */
export type AnchorRect = { top: number; bottom: number; left: number; right: number };

export const placePanel = (
  anchor: AnchorRect,
  width: number,
  height: number,
  align: "left" | "right",
  viewport: Viewport
): PanelBox => {
  /* A panel taller than the viewport can never be placed clear of both edges,
     so it is capped to what will fit and scrolls internally (the CSS carries a
     matching `max-height`). Without this the clamp below silently gives up and
     the overflow lands off the bottom of the screen. */
  const usableHeight = Math.max(0, viewport.height - PANEL_MARGIN * 2);
  const boxHeight = Math.min(Math.max(height, 0), usableHeight);

  const roomBelow = viewport.height - anchor.bottom - PANEL_GAP - PANEL_MARGIN;
  const roomAbove = anchor.top - PANEL_GAP - PANEL_MARGIN;

  /* An unmeasured panel reports height 0, and a 0-height panel "fits" anywhere
     — which used to make this open downward every time and then clamp against
     a height of nothing, i.e. not at all. That is how a panel on one of the
     bottom rows ran off the screen (#231's visual pass). With no height to
     reason from, the honest answer is "whichever side has more room", and the
     re-place that follows the measurement corrects it. */
  const openDown = boxHeight > 0 ? roomBelow >= boxHeight || roomBelow >= roomAbove : roomBelow >= roomAbove;

  const rawTop = openDown ? anchor.bottom + PANEL_GAP : anchor.top - PANEL_GAP - boxHeight;
  const rawLeft = align === "right" ? anchor.right - width : anchor.left;

  const maxTop = Math.max(PANEL_MARGIN, viewport.height - boxHeight - PANEL_MARGIN);
  const maxLeft = Math.max(PANEL_MARGIN, viewport.width - width - PANEL_MARGIN);

  return {
    top: Math.min(Math.max(rawTop, PANEL_MARGIN), maxTop),
    left: Math.min(Math.max(rawLeft, PANEL_MARGIN), maxLeft)
  };
};

/* The height the panel is allowed to draw, for the caller to set as an inline
   `max-height`. Pairs with the cap above: the placement promises the box fits,
   and this is what makes the DOM keep that promise. */
export const maxPanelHeight = (viewport: Viewport): number => Math.max(0, viewport.height - PANEL_MARGIN * 2);
