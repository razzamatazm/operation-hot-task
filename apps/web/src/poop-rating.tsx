/* How Bad?, and where on a card it is drawn (#335).

   The rating is set and changed in the task form and nowhere else — filing a
   task, or `Edit Task` afterwards. Every rating the card draws is read-only,
   for every viewer, the creator included (the user's call on #335).

   A card could once draw it in two places at once: #332's track on the
   collapsed row, and a `How Bad?` line in the expanded body. The row does not
   unmount when the card expands, so an open pool task showed the same number
   twice. So there is one rule, `ratingSurface`, and each surface asks
   `ratingBlock` with its own name; a surface that is not the answer draws
   nothing. The expanded body is never the answer.

   - row  — unclaimed and out for the first time. The question it answers is
            "can I take this right now" while scanning the pool.
   - menu — everything else: dropped and re-offered, claimed, in flight,
            closed. Reference detail at the foot of the hamburger, above the
            timestamps.

   An unrated task draws nothing on either: `PoopDisplay` returns null for a
   zero, so there is never an empty five-slot block.

   Lifted out of App.tsx for the reason `thread.tsx` was: the promise is about
   rendered output, and App.tsx cannot be imported into a node script.
   `scripts/rating-placement-sim-test.mjs` renders this module. */
import type { ReactElement } from "react";
import type { LoanTask } from "@loan-tasks/shared";
import { isFirstTimeInPool, isUnclaimed } from "@loan-tasks/shared";

export type RatingSurface = "row" | "menu";

const clampRating = (count: number): number => Math.max(0, Math.min(5, count | 0));

export const ratingSurface = (task: LoanTask): RatingSurface =>
  isUnclaimed(task) && isFirstTimeInPool(task) ? "row" : "menu";

/* ── Poop score track ─────────────────────────────────────── */
/* Fixed five slots — 1..N in full colour, the rest ghosted, so a 3 reads as
   three out of five. Read-only everywhere: the only control for this number is
   the form's picker. */
export const PoopDisplay = ({ count }: { count: number }) => {
  const safeCount = clampRating(count);
  if (safeCount === 0) return null;
  const titleText = `How Bad? ${safeCount}/5`;
  return (
    <span className="poop-track" title={titleText} aria-label={titleText}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={`poop-slot${n <= safeCount ? " poop-slot-on" : ""}`} aria-hidden="true">
          💩
        </span>
      ))}
    </span>
  );
};

/* The rating as `surface` draws it, or null when that surface is not where
   this task's one copy lives or the task is unrated. Null rather than an empty
   element, so the menu's "is any block non-empty" test reads it directly. */
export const ratingBlock = (surface: RatingSurface, task: LoanTask): ReactElement | null => {
  if (ratingSurface(task) !== surface) return null;
  const count = clampRating(task.points ?? 0);
  if (count === 0) return null;

  const track = <PoopDisplay count={count} />;
  if (surface === "row") return track;

  /* `role="group"` for the reason the timestamps block under it carries one:
     `group` is an owned role of `menu`, so the block is announced as a labelled
     part of the panel without being a `menuitem` or an arrow-key stop. */
  return (
    <div className="task-card-menu-rating" role="group" aria-label="How Bad?">
      <b>How Bad?</b>
      {track}
    </div>
  );
};
