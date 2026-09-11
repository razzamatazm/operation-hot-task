/* How Bad?, and where on a card it is drawn (#335).

   A card can draw the rating in three places: #332's read-only track on the
   collapsed row, a `How Bad?` line in the expanded body, and a block in the
   hamburger. The row does not unmount when the card expands, so any two of
   those answering independently is the same number twice on one open card —
   which is what #332 shipped. So there is one rule, `ratingSurface`, and every
   surface asks `ratingBlock` with its own name; a surface that is not the
   answer draws nothing.

   - row  — unclaimed, out for the first time, and rated. The question it
            answers is "can I take this right now" while scanning the pool.
   - body — any other unclaimed task: one that has been dropped (no row track
            by #332's rule), or an unrated first timer, whose creator still
            needs somewhere to set it.
   - menu — everything else: claimed, in flight, closed. The body leads with
            the timeline and the work, and the rating sits with the reference
            detail at the foot of the panel.

   On every surface an unrated task draws nothing unless the viewer may set it,
   and that test is `ratingVisible`, asked once here rather than per surface.

   Lifted out of App.tsx for the reason `thread.tsx` was: the promise is about
   rendered output, and App.tsx cannot be imported into a node script.
   `scripts/rating-placement-sim-test.mjs` renders this module. */
import type { ReactElement } from "react";
import type { LoanTask } from "@loan-tasks/shared";
import { amendRefusal, isFirstTimeInPool, isUnclaimed } from "@loan-tasks/shared";

export type RatingSurface = "row" | "body" | "menu";

const clampRating = (count: number): number => Math.max(0, Math.min(5, count | 0));

/* Whether a track is worth drawing at all: a rating, or a viewer who may set
   one. An unrated read-only track is five ghosts saying nothing. */
const ratingVisible = (count: number, canEdit: boolean): boolean => clampRating(count) > 0 || canEdit;

export const ratingSurface = (task: LoanTask): RatingSurface => {
  if (!isUnclaimed(task)) return "menu";
  return isFirstTimeInPool(task) && clampRating(task.points ?? 0) > 0 ? "row" : "body";
};

/* Permission is unchanged by #335 and is not decided here: the shared amend
   rule answers it — the creator, while the task is not closed. */
const canRate = (task: LoanTask, viewerId: string): boolean =>
  amendRefusal(task, { id: viewerId }, "points") === undefined;

/* ── Poop score control ───────────────────────────────────── */
export const PoopDisplay = ({
  count,
  canEdit,
  onChange
}: {
  count: number;
  canEdit: boolean;
  /* Optional because the read-only track has nothing to call: the collapsed
     row draws one and holds no rating handler at all. */
  onChange?: ((next: number) => void) | undefined;
}) => {
  const safeCount = clampRating(count);

  if (!ratingVisible(safeCount, canEdit)) return null;

  const titleText = canEdit
    ? `How Bad? ${safeCount}/5 — click to rate`
    : `How Bad? ${safeCount}/5`;

  return (
    <span
      className={`poop-track${canEdit ? " poop-track-editable" : ""}`}
      onClick={(e) => e.stopPropagation()}
      title={titleText}
      aria-label={titleText}
    >
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = n <= safeCount;
        const className = `poop-slot${filled ? " poop-slot-on" : ""}`;
        if (!canEdit) {
          return (
            <span key={n} className={className} aria-hidden="true">
              💩
            </span>
          );
        }
        return (
          <button
            key={n}
            type="button"
            className={className}
            onClick={(e) => {
              e.stopPropagation();
              onChange?.(n === safeCount ? 0 : n);
            }}
            aria-label={`Set How Bad? to ${n}`}
            aria-pressed={filled}
          >
            💩
          </button>
        );
      })}
    </span>
  );
};

/* The rating as `surface` draws it, or null when that surface is not where
   this task's one copy lives or there is nothing to show. Null rather than an
   empty element, so the menu's "is any block non-empty" test reads it
   directly. */
export const ratingBlock = (
  surface: RatingSurface,
  task: LoanTask,
  viewerId: string,
  onChange?: (next: number) => void
): ReactElement | null => {
  if (ratingSurface(task) !== surface) return null;
  const count = clampRating(task.points ?? 0);

  /* The row is read-only for everyone: a five-slot editable track inside a
     row that is itself a press target is five touch targets nobody asked for. */
  if (surface === "row") return <PoopDisplay count={count} canEdit={false} />;

  const canEdit = canRate(task, viewerId);
  if (!ratingVisible(count, canEdit)) return null;
  const track = <PoopDisplay count={count} canEdit={canEdit} onChange={onChange} />;

  if (surface === "body") {
    return (
      <div className="task-card-poop-row">
        <span className="task-card-poop-label">How Bad?</span>
        {track}
      </div>
    );
  }

  /* `role="group"` for the reason the timestamps block under it carries one:
     `group` is an owned role of `menu`, so the block is announced as a labelled
     part of the panel without being a `menuitem` or an arrow-key stop. The
     creator's slots are still buttons in the tab order, each with its own
     label and pressed state. */
  return (
    <div className="task-card-menu-rating" role="group" aria-label="How Bad?">
      <b>How Bad?</b>
      {track}
    </div>
  );
};
