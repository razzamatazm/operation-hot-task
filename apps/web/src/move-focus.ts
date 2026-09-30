/* Where keyboard focus goes after a confirmed move (#506). A keyboard Yes on
   Complete, Approve, End or Cancel throws its card away once the task changes
   section, so focus would fall to the page body. The board notes where the
   task stood at the Yes and, once the action settles, asks this module where
   focus belongs on the board as it is now. Plain TS, run under node by
   `scripts/move-focus-sim-test.mjs`. */

/* The board as rendered: its sections top to bottom, each with its task ids
   in order. A flat board is one section. Empty sections aren't drawn, so they
   aren't here either. */
export type BoardLayout = { key: string; ids: string[] }[];

/* Where the task stood when Yes was pressed. */
export type MovePlace = { taskId: string; section: string; index: number; sectionOrder: string[] };

export type FocusTarget =
  | { kind: "card"; taskId: string }
  | { kind: "section"; key: string }
  | { kind: "board" };

export const placeOf = (layout: BoardLayout, taskId: string): MovePlace | null => {
  for (const s of layout) {
    const index = s.ids.indexOf(taskId);
    if (index !== -1) return { taskId, section: s.key, index, sectionOrder: layout.map((x) => x.key) };
  }
  return null;
};

/* The task's own card if it's still on the board (moved, or a failed action
   left it where it was). Otherwise the card now in its old slot, or the one
   above if it was last; then the heading of the nearest section below the
   emptied one, then above; then the board itself. */
export const focusTargetAfterMove = (place: MovePlace, layout: BoardLayout): FocusTarget => {
  if (layout.some((s) => s.ids.includes(place.taskId))) return { kind: "card", taskId: place.taskId };
  const home = layout.find((s) => s.key === place.section);
  const neighbour = home?.ids[Math.min(place.index, home.ids.length - 1)];
  if (neighbour !== undefined) return { kind: "card", taskId: neighbour };
  const present = new Set(layout.map((s) => s.key));
  const at = place.sectionOrder.indexOf(place.section);
  const below = place.sectionOrder.slice(at + 1).find((k) => present.has(k));
  if (below) return { kind: "section", key: below };
  const above = place.sectionOrder.slice(0, at).reverse().find((k) => present.has(k));
  if (above) return { kind: "section", key: above };
  return { kind: "board" };
};

/* The DOM half, called only from the app. Cards carry `id="task-<id>"` inside
   a `.card-list`; a grouped board wraps each list in `section[data-court]`. */
const cardIds = (root: ParentNode): string[] =>
  Array.from(root.querySelectorAll<HTMLElement>('.card-list > .task-card[id^="task-"]')).map((el) =>
    el.id.slice("task-".length)
  );

export const readBoardLayout = (panel: HTMLElement | null): BoardLayout => {
  if (!panel) return [];
  const courts = Array.from(panel.querySelectorAll<HTMLElement>("section[data-court]"));
  if (courts.length === 0) {
    const ids = cardIds(panel);
    return ids.length > 0 ? [{ key: "", ids }] : [];
  }
  return courts.map((s) => ({ key: s.dataset.court ?? "", ids: cardIds(s) }));
};

/* A card's header row is its focus target; a court heading or the board panel
   stands in when there is no card to land on. */
export const focusBoardTarget = (panel: HTMLElement | null, target: FocusTarget): void => {
  if (!panel) return;
  const el =
    target.kind === "card"
      ? document.getElementById(`task-${target.taskId}`)?.querySelector<HTMLElement>(':scope > [role="button"]')
      : target.kind === "section"
        ? panel.querySelector<HTMLElement>(`[data-court-heading="${CSS.escape(target.key)}"]`)
        : null;
  (el ?? panel).focus();
};
