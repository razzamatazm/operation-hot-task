import { TASK_TYPE_LABELS, isAutosaveExpired, newestSavedFirst } from "@loan-tasks/shared";
import type { Autosave, SavedForLaterTask } from "@loan-tasks/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatAgo } from "./format";
import { TrashIcon } from "./icons";

/* The Task Drafts page (#343, ADR-0011; its own tab since #363).

   "Task Drafts" is the name on screen; the thing listed is still a Saved for
   Later task, which is the domain term (CONTEXT.md). These are not tasks yet,
   belong to the viewer alone, and have no move in them, so they are never in
   the task list. They used to be a section inside it; now they are the whole
   body of the board's Task Drafts tab (`board-tabs.tsx`), which is also their
   heading, so the page draws no heading or count of its own.

   Lifted out of `App.tsx` for the reason `thread.tsx` was: what a row carries
   is the promise, `App.tsx` cannot be imported into a node script, and
   `scripts/saved-for-later-board-sim-test.mjs` renders this and reads it back.

   Never collapsible, newest saved first. With none, the page says so.

   A row is three facts and deliberately no more: the loan as it was typed, the
   task type, and when it was saved. No who-to-whom, due time or poop rating,
   because none of those exist until the task is filed.

   Tapping a row reopens it (#344): the three facts sit inside one button that
   fills the row, so the whole row is the press target the way a task row is,
   and hands that row's record to `onOpen`. The button is a child of the `<li>`
   rather than the `<li>` itself so the delete control (#345) sits beside it on
   the row without nesting one button inside another.

   The viewer's autosave is listed here too (#371): the new task form's typing,
   kept on the server, so a person can find it from the board as well as by
   opening New Task. It is one more row in the same shape, placed by when it was
   last written like every draft, reading `Autosaved N ago` where a draft reads
   `saved N ago`. Tapping it opens New Task, which restores it; its delete asks
   the same question and forgets the autosave. Only one ever shows, and one
   seven days old does not show at all. */

const NO_LOAN_YET = "No loan yet";

/* The autosave's row id. Saved for Later ids are UUIDs, so this cannot collide
   with one. */
const AUTOSAVE_ROW_ID = "autosave";

/* What a row needs: a Saved for Later task, or the autosave standing in as one. */
type DraftRowItem = Pick<SavedForLaterTask, "id" | "savedAt" | "form"> & { autosaved?: true };

/* The autosave the page lists and the tab counts, or null: none, or aged out. */
const shownAutosave = (autosave: Autosave | null | undefined, now: number): Autosave | null =>
  autosave && !isAutosaveExpired(autosave.savedAt, now) ? autosave : null;

/* The Task Drafts tab's count (#363, #371): every Saved for Later task, and the
   autosave when there is one to show. One rule, so the tab can never count a row
   the page does not draw. */
export const taskDraftsCount = (items: SavedForLaterTask[], autosave: Autosave | null | undefined, now: number): number =>
  items.length + (shownAutosave(autosave, now) ? 1 : 0);

/* The second step of deleting one (#345). Deleting has no undo, so the row asks
   once, in place, the way the thread's `Delete` and the Instructions box's
   discard do: the question takes the row's own line, where the person is
   already looking, rather than a dialog over the board for three words.

   Same answers-in-order rule as the task form's discard dialog: the safe
   answer first, holding focus, so a stray Return keeps it; the destructive one
   in the danger style carries its own word. Escape declines. */
export const SavedForLaterDeleteConfirm = ({
  name,
  deleting,
  onConfirm,
  onCancel
}: {
  name: string;
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) => {
  const keepRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    keepRef.current?.focus();
  }, []);
  return (
    <div
      className="saved-row-confirm"
      role="alertdialog"
      aria-label={`Delete ${name}?`}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
      }}
    >
      <span className="saved-row-confirm-question">Delete this saved task?</span>
      <button type="button" className="btn-sm btn-ghost" disabled={deleting} ref={keepRef} onClick={onCancel}>
        Keep
      </button>
      <button type="button" className="btn-sm btn-danger" disabled={deleting} onClick={onConfirm}>
        {deleting ? "Deleting…" : "Delete"}
      </button>
    </div>
  );
};

const SavedForLaterRow = <T extends DraftRowItem,>({
  item,
  now,
  onOpen,
  onDelete
}: {
  item: T;
  now: number;
  onOpen: (item: T) => void;
  onDelete: (item: T) => Promise<boolean>;
}) => {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deleteRef = useRef<HTMLButtonElement | null>(null);
  /* Set when the question closes with the row still here, so focus goes back
     to the control that asked it rather than to the top of the page. */
  const returnFocus = useRef(false);
  const name = item.form.folderName.trim() || NO_LOAN_YET;

  useEffect(() => {
    if (confirming || !returnFocus.current) return;
    returnFocus.current = false;
    deleteRef.current?.focus();
  }, [confirming]);

  const decline = (): void => {
    returnFocus.current = true;
    setConfirming(false);
  };

  /* App removes the row once the server has let it go, which unmounts this. If
     the row is still here afterwards the delete did not land, App has already
     said why, and the question closes on a row left exactly as it was. */
  const confirmDelete = async (): Promise<void> => {
    if (deleting) return;
    setDeleting(true);
    try {
      await onDelete(item);
    } finally {
      setDeleting(false);
      returnFocus.current = true;
      setConfirming(false);
    }
  };

  return (
    <li className="saved-row">
      {confirming ? (
        <SavedForLaterDeleteConfirm
          name={name}
          deleting={deleting}
          onConfirm={() => void confirmDelete()}
          onCancel={decline}
        />
      ) : (
        <>
          <button type="button" className="saved-row-open" onClick={() => onOpen(item)}>
            <span className="saved-row-name">{name}</span>
            <span className="saved-row-type">{TASK_TYPE_LABELS[item.form.taskType]}</span>
            <time className="saved-row-when" dateTime={item.savedAt}>
              {`${item.autosaved ? "Autosaved" : "saved"} ${formatAgo(item.savedAt, now)}`}
            </time>
          </button>
          <button
            type="button"
            className="saved-row-delete"
            aria-label={`${item.autosaved ? "Delete autosaved task" : "Delete saved task"}: ${name}`}
            title="Delete"
            ref={deleteRef}
            onClick={() => setConfirming(true)}
          >
            <TrashIcon />
          </button>
        </>
      )}
    </li>
  );
};

type ListedRow =
  | { kind: "saved"; item: SavedForLaterTask }
  | { kind: "autosave"; item: DraftRowItem };

export const TaskDraftsPage = ({
  items,
  autosave,
  now,
  onOpen,
  onDelete,
  onOpenAutosave = () => {},
  onDeleteAutosave = async () => false
}: {
  items: SavedForLaterTask[];
  /* The viewer's autosave (#371), listed as one more row when there is one. */
  autosave?: Autosave | null;
  now: number;
  onOpen: (item: SavedForLaterTask) => void;
  /* Resolves true once the row is off the list, false when it stayed. */
  onDelete: (item: SavedForLaterTask) => Promise<boolean>;
  /* Tapping the Autosaved row: opens New Task, which restores it. */
  onOpenAutosave?: () => void;
  /* The Autosaved row's delete, once confirmed. Resolves as `onDelete` does. */
  onDeleteAutosave?: () => Promise<boolean>;
}) => {
  /* Every row, newest written first: the Saved for Later tasks, and the
     autosave placed among them by when it was last written. */
  const listed = useMemo<ListedRow[]>(() => {
    const shown = shownAutosave(autosave, now);
    const rows: ListedRow[] = items.map((item) => ({ kind: "saved", item }));
    if (shown) rows.push({ kind: "autosave", item: { id: AUTOSAVE_ROW_ID, savedAt: shown.savedAt, form: shown.form, autosaved: true } });
    return rows.sort((a, b) => newestSavedFirst(a.item, b.item));
  }, [items, autosave, now]);

  /* Where focus goes once a delete lands. The row that held it is gone, and a
     keyboard user dropped onto the page body has lost their place in the list,
     so focus moves to the row that took its place, or the new last row. A delete
     that did not land leaves the row, which takes focus back itself, so the mark
     is cleared. When the last one goes the list goes with it and there is no
     row left to land on. */
  const listRef = useRef<HTMLUListElement | null>(null);
  const refocus = useRef<{ id: string; index: number } | null>(null);
  useEffect(() => {
    const mark = refocus.current;
    if (!mark || listed.some((i) => i.item.id === mark.id)) return;
    refocus.current = null;
    const rows = listRef.current?.querySelectorAll<HTMLButtonElement>(".saved-row-open");
    if (!rows || rows.length === 0) return;
    rows[Math.min(mark.index, rows.length - 1)]?.focus();
  }, [listed]);

  const deleteRow = async <T extends DraftRowItem,>(item: T, index: number, remove: (item: T) => Promise<boolean>): Promise<boolean> => {
    refocus.current = { id: item.id, index };
    const removed = await remove(item);
    if (!removed) refocus.current = null;
    return removed;
  };

  /* The button keeps its own wording, Save for later, while the tab says Task
     Drafts (the maintainer's call on #363), so the empty page names the button
     that fills it. */
  if (listed.length === 0) {
    return <div className="empty-card">No task drafts. Use Save for later on a new task to keep one here.</div>;
  }
  return (
    <ul className="saved-list" ref={listRef}>
      {listed.map((row, index) =>
        row.kind === "autosave" ? (
          <SavedForLaterRow
            key={row.item.id}
            item={row.item}
            now={now}
            onOpen={onOpenAutosave}
            onDelete={(it) => deleteRow(it, index, onDeleteAutosave)}
          />
        ) : (
          <SavedForLaterRow key={row.item.id} item={row.item} now={now} onOpen={onOpen} onDelete={(it) => deleteRow(it, index, onDelete)} />
        )
      )}
    </ul>
  );
};
