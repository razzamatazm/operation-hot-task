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
export const discardConfirmCopy = (): { title: string; body: string; confirm: string; cancel: string } => ({
  title: "Discard this task?",
  body: "Your progress won't be saved.",
  confirm: "Discard",
  cancel: "Keep editing"
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
  onCancel
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) => {
  const copy = discardConfirmCopy();
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
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return (
    <div className="discard-confirm-overlay">
      <div className="discard-confirm-panel" role="alertdialog" aria-modal="true" aria-label={copy.title}>
        <h3 className="discard-confirm-title">{copy.title}</h3>
        <p className="discard-confirm-body">{copy.body}</p>
        <div className="discard-confirm-actions">
          <button type="button" className="btn-sm btn-ghost" ref={cancelRef} onClick={onCancel}>
            {copy.cancel}
          </button>
          <button type="button" className="btn-sm btn-danger" onClick={onConfirm}>
            {copy.confirm}
          </button>
        </div>
      </div>
    </div>
  );
};
