/* Asking before two loans are folded together (#265, ADR-0008 rule 7).
 *
 * Changing a Humperdink link to one another loan already holds merges the two:
 * the other record's tasks come across, its name survives only as an alias, and
 * the record itself is gone. That is usually the right outcome — duplicate
 * records for one loan is the problem the merge exists to solve — but it is far
 * too large a consequence to fall out of fixing a URL unannounced. So the save
 * asks first.
 *
 * This is the one place in the app where a dialog is right. The shared-record
 * line under the same two fields is deliberately NOT one (see apps/web/CLAUDE.md):
 * nothing has gone wrong there and nothing needs answering. Here something does.
 * A toast is not an alternative — a toast cannot ask a question, and it goes
 * away on its own, which is exactly the wrong behaviour for a decision.
 *
 * The flow is a two-step round trip, not an optimistic merge. The save posts as
 * it always did; the server finds the collision, writes nothing, and refuses
 * with 409 naming the other loan. Only if the person says yes does the identical
 * change go back up with `confirmMerge`, and the merge then runs exactly as it
 * always has, transient notice and all. Saying no sends nothing at all.
 *
 * Lives outside App.tsx so `scripts/loan-merge-confirm-sim-test.mjs` can render
 * it and read the markup back, the same arrangement as `task-form.tsx`.
 */
import { useEffect, useRef } from "react";

/* "No thanks" travelling back up the save path. A rejection rather than a
   return value because every caller of the save already treats a rejection as
   "stay open, keep the typing" — which is exactly the right behaviour here — and
   its own type so nobody toasts it: declining is not a failure, the person got
   what they asked for, and nothing was sent. */
export class MergeDeclined extends Error {
  constructor() {
    super("Merge declined");
    this.name = "MergeDeclined";
  }
}

/* The other loan standing in the way, as the server names it — plus which of
   the two records would come out of the merge and which would be absorbed.

   That direction is NOT "the other one loses". The surviving record is the older
   of the two, which on the commonest version of this — correcting the URL on a
   record filed last week so it points at a loan that has been open for months —
   is the OTHER loan, and it is the one being edited that disappears. A dialog
   that assumed otherwise would tell half the people who read it the opposite of
   what is about to happen, so the server, which decides it, says which. */
export interface LoanLinkCollision {
  loanId: string;
  loanName: string;
  survivingName: string;
  absorbedName: string;
}

/* Read the collision out of a failed request, or `undefined` if this failure is
   something else. Duck-typed on the shape `apiRequest` throws (status + parsed
   body) rather than the class itself, so the rule "409 carrying a collision, and
   nothing else, is a merge question" is testable without importing App.tsx.

   A 409 with no collision body, or a collision with no name, is not treated as
   one: a dialog that asks "merge with ...?" and cannot fill in the blank is
   worse than the plain error the caller would otherwise show. */
export const linkCollisionIn = (error: unknown): LoanLinkCollision | undefined => {
  if (!error || typeof error !== "object") return undefined;
  const { status, body } = error as { status?: unknown; body?: unknown };
  if (status !== 409 || !body || typeof body !== "object") return undefined;
  const collision = (body as { collision?: unknown }).collision;
  if (!collision || typeof collision !== "object") return undefined;
  const { loanId, loanName, survivingName, absorbedName } = collision as Record<string, unknown>;
  if (typeof loanId !== "string" || typeof loanName !== "string" || !loanName.trim()) return undefined;
  if (typeof survivingName !== "string" || typeof absorbedName !== "string") return undefined;
  if (!survivingName.trim() || !absorbedName.trim()) return undefined;
  return { loanId, loanName, survivingName, absorbedName };
};

/* What the dialog says. A pure function so the wording is asserted directly:
   the ticket's promise is that the other loan is NAMED, so the person is making
   a decision rather than clearing a dialog, and a name only present in JSX is a
   name one refactor away from being dropped.

   Plain words, specific about what is lost, and specific about WHICH of the two
   loses it. "Its tasks move over and its record goes away" is the sentence
   someone would be upset to discover after the fact, and it is true of exactly
   one of the two records — the newer one, which is often the one they are
   standing in. Both names appear, in the roles they will actually play. */
export const mergeConfirmCopy = (
  collision: Pick<LoanLinkCollision, "loanName" | "survivingName" | "absorbedName">
): { title: string; body: string; confirm: string; cancel: string } => ({
  title: `Merge with "${collision.loanName}"?`,
  body:
    `That Humperdink link already belongs to "${collision.loanName}". Saving it here combines the two into ` +
    `one loan, kept under the older name, "${collision.survivingName}". Every task on "${collision.absorbedName}" ` +
    `moves onto it, "${collision.absorbedName}" is kept only as an old name, and its separate record goes away. ` +
    `This can't be undone from here.`,
  confirm: "Merge the loans",
  cancel: "Keep them separate"
});

/* The dialog itself. Rendered by App above whatever surface asked — the edit
   form is itself a modal, so this layers over it.

   `alertdialog`, not `dialog`: it interrupts a save the person already started
   and there is nothing to read here but the question. The backdrop is inert for
   the same reason the create form's is — a stray click must not answer a
   question about another loan's history. Escape declines, because the safe
   answer is the one that sends nothing. */
export const MergeConfirmDialog = ({
  collision,
  busy,
  onConfirm,
  onCancel
}: {
  collision: LoanLinkCollision;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) => {
  const copy = mergeConfirmCopy(collision);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  /* Focus lands on "Keep them separate": the destructive answer should never be
     one stray Return away, and this dialog appears over a form the person was
     typing in. */
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

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
    <div className="merge-confirm-overlay">
      <div className="merge-confirm-panel" role="alertdialog" aria-modal="true" aria-label={copy.title}>
        <h3 className="merge-confirm-title">{copy.title}</h3>
        <p className="merge-confirm-body">{copy.body}</p>
        <div className="merge-confirm-actions">
          <button
            type="button"
            className="btn-sm btn-ghost"
            ref={cancelRef}
            disabled={busy}
            onClick={onCancel}
          >
            {copy.cancel}
          </button>
          <button type="button" className="btn-sm btn-danger" disabled={busy} onClick={onConfirm}>
            {busy ? "Merging…" : copy.confirm}
          </button>
        </div>
      </div>
    </div>
  );
};
