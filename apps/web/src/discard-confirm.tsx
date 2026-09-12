/* Asking before the task form throws someone's typing away (#283).
 *
 * Closing the form used to be instant and silent: Cancel and Escape both
 * unmounted it, and everything in it went. That is fine on a form nobody has
 * touched and quietly awful on one somebody spent two minutes filling in — the
 * grey backdrop was already made inert for exactly this reason (#114), which
 * fixed the accidental exit and left the deliberate-looking ones untouched.
 *
 * So the two real exits ask, once there is something to lose. Whether there IS
 * something to lose is `formHasChanges` in `create-form-state.ts`, deliberately
 * over-eager: any field differing from the form as it opened, a changed task
 * type included. An untouched form still closes on the first click, because a
 * prompt that appears every time is a prompt people stop reading.
 *
 * This is the app's second confirmation dialog, and it is built as the first
 * one (`loan-merge-confirm.tsx`) rather than as a new thing: same overlay and
 * panel construction, same `alertdialog`, same inert backdrop, same Escape-
 * declines, same focus on the safe answer. Two dialogs that behave differently
 * are two dialogs people have to read twice.
 *
 * It ships ahead of the draft-saving work, which makes Cancel destructive on
 * purpose — it will delete the saved draft — so the guard has to be in place
 * before that lands. `onConfirm` is the single place that later work hooks the
 * "and clear the draft" step onto.
 *
 * Lives outside `task-form.tsx` so `scripts/discard-confirm-sim-test.mjs` can
 * render it on its own and read the markup back, the same arrangement the merge
 * confirmation uses.
 */
import { useEffect, useRef } from "react";

/* What the dialog says. A pure function for the reason `mergeConfirmCopy` is
   one: the wording is the promise, so it is asserted directly rather than
   fished out of rendered markup one refactor away from being dropped.

   The question is short because there is nothing to explain — the person knows
   what they typed. What they may not know is that nothing is saved anywhere
   yet, which is the whole point of the second sentence. */
/* Since #348 a create form's prompt has a third answer, Save for later
   (ADR-0011), and "your progress won't be saved" stops being true of leaving:
   the person can keep it. So the create form asks a question that names both
   ways out. A reopened Task Draft says what its Discard does, which since #388
   is delete the draft: pressing Discard on a draft you opened means you don't
   want it. There is no longer an answer that goes back to the last save.
   Edit mode has nowhere to save for later and keeps the original question. */
export const discardConfirmCopy = (
  offer: { saveForLater: boolean; reopened: boolean } = { saveForLater: false, reopened: false }
): { title: string; body: string; confirm: string; cancel: string; save: string } => {
  const answers = { confirm: "Discard", cancel: "Keep editing", save: "Save for later" };
  if (!offer.saveForLater) return { title: "Discard this task?", body: "Your progress won't be saved.", ...answers };
  return {
    title: "Leave this task?",
    body: offer.reopened
      ? "Save your changes for later, or discard them and delete this Task Draft."
      : "Save it for later to pick it back up from the board, or discard it.",
    ...answers
  };
};

/* The second question a reopened Task Draft's Discard asks (#388). Deleting has
   no undo, so it asks once more, with the Task Drafts row's own two answers
   (#345): Keep and Delete. A pure function for the reason the prompt's copy is
   one. */
export const deleteTaskDraftCopy = (): { title: string; body: string; confirm: string; cancel: string; busy: string } => ({
  title: "Delete this Task Draft?",
  body: "It comes off Task Drafts for good, with your changes.",
  confirm: "Delete",
  cancel: "Keep",
  busy: "Deleting…"
});

/* The dialog itself. Rendered by the form as a sibling of its overlay rather
   than a child, so its own z-index is measured against the app instead of
   against the inside of a modal — it has to sit above the form (50) and above a
   toast (60), the same as the merge confirmation.

   `alertdialog`, not `dialog`: it interrupts something the person already
   started and there is nothing to read here but the question. The backdrop is
   inert for the reason the form's is — a stray click must not be an answer, and
   least of all the destructive one. Escape declines, because the safe answer is
   the one that keeps the typing. */
export const DiscardConfirmDialog = ({
  onConfirm,
  onCancel,
  onSaveForLater,
  saveForLaterDisabled,
  reopened = false,
  busy = false
}: {
  onConfirm: () => void;
  onCancel: () => void;
  /* The create form's third answer (#348). Absent, as in edit mode, means the
     two-way prompt exactly as it was. */
  onSaveForLater?: () => void;
  /* Unavailable exactly when the footer's Save for later is, so the two cannot
     disagree about whether there is anything to keep. */
  saveForLaterDisabled?: boolean;
  /* The form came from a Task Draft, so Discard deletes it (#388) and the
     prompt says so. */
  reopened?: boolean;
  /* An answer is being carried out (a new form's Discard settles its autosave
     writes first). Every answer is shut and Escape does nothing until it is
     done, so a second press cannot race the first. */
  busy?: boolean;
}) => {
  const copy = discardConfirmCopy({ saveForLater: onSaveForLater !== undefined, reopened });
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  /* Focus lands on "Keep editing": this dialog appears over a form somebody was
     typing in, and the answer that throws that away should never be one stray
     Return away. */
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  /* Captured on the window, and the propagation stopped, because the form's
     overlay listens for Escape too — the key that opened this dialog would
     otherwise pass straight through it and close the form anyway, which is the
     precise thing being guarded against. Same reason the typeahead and the
     locked-type popover inside the form stop it. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (!busy) onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel, busy]);

  return (
    <div className="discard-confirm-overlay">
      <div className="discard-confirm-panel" role="alertdialog" aria-modal="true" aria-label={copy.title}>
        <h3 className="discard-confirm-title">{copy.title}</h3>
        <p className="discard-confirm-body">{copy.body}</p>
        <div className="discard-confirm-actions">
          <button type="button" className="btn-sm btn-ghost" ref={cancelRef} disabled={busy || undefined} onClick={onCancel}>
            {copy.cancel}
          </button>
          {/* Between the safe answer and the destructive one, in the ghost style
              the form's footer gives it, so Discard stays the one loud button
              and furthest from where focus lands. */}
          {onSaveForLater && (
            <button type="button" className="btn-sm btn-ghost" disabled={busy || saveForLaterDisabled || undefined} onClick={onSaveForLater}>
              {copy.save}
            </button>
          )}
          <button type="button" className="btn-sm btn-danger" disabled={busy || undefined} onClick={onConfirm}>
            {copy.confirm}
          </button>
        </div>
      </div>
    </div>
  );
};

/* The delete question (#388), raised in place of the prompt above when Discard
   is pressed on a reopened Task Draft. Its own dialog rather than a mode of
   that one, but built exactly the same way: same overlay and panel, same
   `alertdialog`, same inert backdrop, focus on the safe answer, and Escape
   captured and stopped so it answers Keep instead of reaching the form. Keep
   goes back to the form with nothing written or cleared; Delete removes the
   draft, and both are shut while that is out. */
export const DeleteTaskDraftDialog = ({
  onConfirm,
  onCancel,
  busy = false
}: {
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) => {
  const copy = deleteTaskDraftCopy();
  const keepRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    keepRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (!busy) onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel, busy]);

  return (
    <div className="discard-confirm-overlay">
      <div className="discard-confirm-panel" role="alertdialog" aria-modal="true" aria-label={copy.title}>
        <h3 className="discard-confirm-title">{copy.title}</h3>
        <p className="discard-confirm-body">{copy.body}</p>
        <div className="discard-confirm-actions">
          <button type="button" className="btn-sm btn-ghost" ref={keepRef} disabled={busy || undefined} onClick={onCancel}>
            {copy.cancel}
          </button>
          <button type="button" className="btn-sm btn-danger" disabled={busy || undefined} onClick={onConfirm}>
            {busy ? copy.busy : copy.confirm}
          </button>
        </div>
      </div>
    </div>
  );
};
