import { TASK_TYPE_LABELS, newestSavedFirst } from "@loan-tasks/shared";
import type { SavedForLaterTask } from "@loan-tasks/shared";
import { formatAgo } from "./format";

/* The board's Saved for Later section (#343, ADR-0011).

   Not a court. Everything else in Grouped view is a task sorted by whose move
   it is; these are not tasks yet, belong to the viewer alone, and have no move
   in them. So the section borrows the courts' heading and count and nothing
   else, and App places it right after Needs you.

   Lifted out of `App.tsx` for the reason `thread.tsx` was: what a row carries
   is the promise, `App.tsx` cannot be imported into a node script, and
   `scripts/saved-for-later-board-sim-test.mjs` renders this and reads it back.

   Hidden when empty, never collapsible, newest saved first.

   A row is three facts and deliberately no more: the loan as it was typed, the
   task type, and when it was saved. No who-to-whom, due time or poop rating,
   because none of those exist until the task is filed.

   Tapping a row reopens it (#344): the three facts sit inside one button that
   fills the row, so the whole row is the press target the way a task row is,
   and hands that row's record to `onOpen`. The button is a child of the `<li>`
   rather than the `<li>` itself so a second control can sit beside it on the
   row (delete, #345) without nesting one button inside another. */

const NO_LOAN_YET = "No loan yet";

export const SavedForLaterSection = ({
  items,
  now,
  onOpen
}: {
  items: SavedForLaterTask[];
  now: number;
  onOpen: (item: SavedForLaterTask) => void;
}) => {
  if (items.length === 0) return null;
  const ordered = [...items].sort(newestSavedFirst);
  return (
    <section className="court" data-court="saved">
      <div className="section-head">
        <h2>
          Saved for Later
          <span className="section-count">{items.length}</span>
        </h2>
      </div>
      <ul className="saved-list">
        {ordered.map((item) => (
          <li key={item.id} className="saved-row">
            <button type="button" className="saved-row-open" onClick={() => onOpen(item)}>
              <span className="saved-row-name">{item.form.folderName.trim() || NO_LOAN_YET}</span>
              <span className="saved-row-type">{TASK_TYPE_LABELS[item.form.taskType]}</span>
              <time className="saved-row-when" dateTime={item.savedAt}>
                saved {formatAgo(item.savedAt, now)}
              </time>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
};
