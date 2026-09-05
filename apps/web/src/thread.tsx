import { LoanTask, StoredReviewNote, getNotesFieldLabel, noteBodyText, standingTermsFor } from "@loan-tasks/shared";

import { bylineOf, initialsOf } from "./format";

/* ── The expanded card's terms section and its conversation ─────────────── */
/* Lifted out of App.tsx for the same reason `timeline.tsx` was: this is the
   surface ADR-0008 makes a promise about — an LOI's terms are drawn as a
   standing section and are *not* repeated as message number one — and App.tsx
   cannot be imported into a node script, so a promise left in there is a
   promise nothing can check. `scripts/loi-terms-section-sim-test.mjs` renders
   both components and reads the markup back.
 *
 * Only the read-only halves moved. The reply composer, the scroll ref and
 * every piece of card state stay in App.tsx; what a viewer may do to a task is
 * not this file's business, and since #260 the only door onto this field is
 * `Edit Task` in the row's hamburger. */

/* Small neutral avatar. Mono treatment: initials in a neutral circle, no
   per-user color. Since the thread dropped its author/timestamp row (#165)
   these initials are the only visible identity on a note — hence the size, and
   hence `.msg` carrying the full name for hover and for assistive tech. */
export const ExpandAvatar = ({ name }: { name?: string }) => (
  <span className="expand-avatar" aria-hidden="true">{initialsOf(name)}</span>
);

/* What heads the conversation. On the five types whose field is still the
   thread's first message that is the field's own label — "Concerns", "Notes" —
   because the label is describing the thing below it. On an LOI the field has
   moved into its own section above and taken its label with it, so the
   remaining rows are a conversation and nothing else, and saying
   "Loan Terms and Contacts" over them would name the box next door. */
export const threadHeadLabel = (task: Pick<LoanTask, "taskType" | "notes">): string =>
  standingTermsFor(task) === undefined ? getNotesFieldLabel(task.taskType) : "Conversation";

/* The standing terms of the loan (ADR-0008 rule 1), or nothing on the five
   types that have none. A bordered, shadowed panel on the recessed expanded
   body, with the conversation below it as bare rows: the two are told apart by
   shape rather than by their headings.
 *
 * Free text, rendered as typed. Line breaks survive via `white-space:
 * pre-wrap` on `.loi-terms-body`, so a typed list of figures reads as a list.
 * No parsing, no label columns, no structured fields — a form of ~25 mostly
 * empty inputs would buy formatting nobody asked for, and structured terms
 * wait for the direct import that would populate them.
 *
 * No edit affordance here, deliberately (#260). ADR-0008 rule 4 makes `Edit
 * Task` in the hamburger the one door onto this field; a second entrance on
 * the box is fewer clicks from where the error is spotted, at the cost of two
 * surfaces that have to be kept in agreement. This section displays. */
export const TermsSection = ({
  task
}: {
  task: Pick<LoanTask, "taskType" | "notes">;
}) => {
  const terms = standingTermsFor(task);
  if (terms === undefined) return null;
  /* No `aria-label` on the section: the visible mono title already names the
     block, and a label repeating it makes a screen reader say it twice. */
  return (
    <section className="loi-terms">
      <div className="loi-terms-head">
        <span className="loi-terms-title">{getNotesFieldLabel(task.taskType)}</span>
      </div>
      <div className="loi-terms-body">{terms}</div>
    </section>
  );
};

/* The rows inside `.msgs`. A note is one row — glyph, then what they said —
   with no name/timestamp line above it (#165); the author and the time ride
   the row's `title` and a visually-hidden span.
 *
 * The originating field opens the list only where it is still a thread member,
 * which `standingTermsFor` decides once for this file and the section above.
 * An LOI therefore opens genuinely empty and says so, rather than opening on a
 * copy of its own terms.
 *
 * The empty state is a real row rather than a blank box: an empty conversation
 * on a brand-new task is the normal case now, and an unexplained gap between
 * the terms and the composer reads as something failing to load. It invites a
 * reply only when the viewer has a composer — an Observer, or anyone looking at
 * a task with no reply box, has nothing below to start. */
export const ThreadMessages = ({
  task,
  viewerId,
  canReply
}: {
  task: Pick<LoanTask, "taskType" | "notes" | "createdBy" | "createdAt" | "reviewNotes">;
  viewerId: string;
  canReply: boolean;
}) => {
  const opensWithOriginatingNote = standingTermsFor(task) === undefined;
  const replies = Array.isArray(task.reviewNotes) ? task.reviewNotes : [];
  if (!opensWithOriginatingNote && replies.length === 0) {
    return (
      <div className="msgs-empty">
        {canReply ? "No messages yet — start the conversation below." : "No messages yet."}
      </div>
    );
  }
  return (
    <>
      {opensWithOriginatingNote && (
        <div className="msg" title={bylineOf(task.createdBy.displayName, task.createdAt)}>
          <ExpandAvatar name={task.createdBy.displayName} />
          <div>
            <span className="sr-only">{bylineOf(task.createdBy.displayName, task.createdAt)}</span>
            <div className="msg-text">{task.notes}</div>
          </div>
        </div>
      )}
      {replies.map((note: StoredReviewNote, i: number) => (
        <div
          /* The message's own identifier since #286, which is what makes a row
             addressable rather than merely positional. The fallback to position
             is not dead: this renders whatever the API hands it, and a message
             the store has not backfilled yet is exactly the `StoredReviewNote`
             case — the same index this list keyed in full before #286. */
          key={note.id ?? i}
          className={`msg${note.by.id === viewerId ? " msg-mine" : ""}`}
          title={bylineOf(note.by.displayName, note.at)}
        >
          <ExpandAvatar name={note.by.displayName} />
          <div>
            <span className="sr-only">{bylineOf(note.by.displayName, note.at)}</span>
            <div className="msg-text">{noteBodyText(note)}</div>
          </div>
        </div>
      ))}
    </>
  );
};
