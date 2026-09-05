import { useEffect, useRef, useState } from "react";

import {
  LoanTask,
  MESSAGE_EDITED_MARKER,
  StoredReviewNote,
  canDeleteMessage,
  canEditMessage,
  getNotesFieldLabel,
  isEmptyMessageText,
  noteBodyText,
  noteLabelPrefix,
  standingTermsFor
} from "@loan-tasks/shared";

import { bylineOf, initialsOf } from "./format";
/* PROTOTYPE (throwaway) — bubble variants for the conversation, gated on
   `?variant=`. Delete this import and the branch below with the file. */
import { PrototypeThread, prototypeVariant } from "./thread-bubbles-prototype";

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
/* How long a finger has to stay down before the menu opens on a touch screen.
   Long enough not to fire on a tap that was meant to scroll the thread, short
   enough that nobody wonders whether it worked. */
const LONG_PRESS_MS = 500;

/* One reply row, and the only stateful thing in this file.
 *
 * It is a component rather than markup inside the map because the edit box is
 * per-message state (#287): a draft, an open menu, and an in-flight save belong
 * to the row being edited, and hoisting them into `ThreadMessages` would mean
 * one "which message" variable that every row has to test itself against.
 *
 * `onEdit` absent means the surface offers no editing at all — which is how the
 * sim tests and any future read-only renderer get the thread exactly as it was.
 * When it is present, whether THIS row offers it is the shared
 * `canEditMessage`, never a local `note.by.id === viewerId`: the server asks the
 * same function, so the menu cannot appear on a message the API would refuse.
 * Hiding it is a courtesy; the refusal is the enforcement. */
const MessageRow = ({
  note,
  task,
  viewerId,
  onEdit,
  onDelete
}: {
  note: StoredReviewNote;
  task: Pick<LoanTask, "status">;
  viewerId: string;
  onEdit?: (messageId: string, text: string) => Promise<void>;
  onDelete?: (messageId: string) => Promise<void>;
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  /* The second step of `Delete` (#288). The act has no undo — rule 4 refuses
     one on purpose — so the menu asks once, in place, rather than firing on a
     stray click on a two-entry menu whose other entry is harmless. */
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /* `undefined` is "not editing". An empty string is a real draft — the author
     has cleared the box — and the Save button refuses it, so the two states
     cannot be the same value. */
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const menuRef = useRef<HTMLDivElement | null>(null);

  /* A press anywhere else closes the menu. Not a nicety: on a touch screen the
     trigger is `display: none` and the menu is opened by a long press, so
     without this the only way out of an opened menu is to choose something from
     it. On a pointer device it is also what stops every row's menu standing
     open at once, since an open one pins its trigger visible.
     Capture phase, like the card's own panels, so the close lands before
     whatever was clicked acts on it. */
  /* Closing the menu also takes the delete confirmation down with it: a menu
     reopened later must not still be holding a "yes, delete it" the person
     walked away from. */
  const closeMenu = (): void => {
    setMenuOpen(false);
    setConfirmingDelete(false);
  };

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: globalThis.PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      setMenuOpen(false);
      setConfirmingDelete(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [menuOpen]);

  /* A message the store has not backfilled an identifier onto cannot be
     addressed, so it cannot be edited — the `StoredReviewNote` case #286 left
     open. The store migrates at start-up, so this is a belt, not a road. */
  const editable =
    onEdit !== undefined && note.id !== undefined && canEditMessage(task, note, { id: viewerId });
  /* The same shape for `Delete` (#288), off the delete half of the same shared
     rule. Both come back false on a tombstone, which is how "no undelete, and
     no editing one back into a message" reaches the UI without this file
     knowing what a tombstone is. */
  const deletable =
    onDelete !== undefined && note.id !== undefined && canDeleteMessage(task, note, { id: viewerId });
  const hasMenu = editable || deletable;

  const cancelPress = (): void => {
    if (pressTimer.current !== undefined) {
      clearTimeout(pressTimer.current);
      pressTimer.current = undefined;
    }
  };

  /* Tap-and-hold, the touch half of ADR-0009 rule 9. A touch screen has no
     hover, so the trigger this reveals is invisible there and the press has to
     open the menu itself. Pointer events rather than touch events so one
     handler covers a pen as well, and `pointerType` keeps it off the mouse,
     where a slow click must stay a click. */
  const onPointerDown = (event: { pointerType: string }): void => {
    if (!hasMenu || event.pointerType === "mouse") return;
    cancelPress();
    pressTimer.current = setTimeout(() => setMenuOpen(true), LONG_PRESS_MS);
  };

  const startEditing = (): void => {
    closeMenu();
    /* The author's own words and nothing else. The app's label is not in the
       box because rule 5 says it is not theirs to change — it is drawn beside
       the box instead, so they can see the row will still read `Needs
       fixes: ...` when they save. */
    setDraft(note.text);
  };

  const stopEditing = (): void => {
    setDraft(undefined);
    setSaving(false);
  };

  const save = async (): Promise<void> => {
    if (draft === undefined || note.id === undefined || isEmptyMessageText(draft) || saving) return;
    setSaving(true);
    try {
      await onEdit?.(note.id, draft);
      stopEditing();
    } catch {
      /* The box stays open with the typing still in it. The caller has already
         said why in a toast, and closing on a refusal would throw away the
         author's words along with it — which on the one refusal a person can
         actually hit (somebody archived the task while they were typing) is the
         worst possible moment to lose them. */
    } finally {
      setSaving(false);
    }
  };

  /* Withdrawing it (#288). The menu stays open on a refusal — the caller has
     already said why in a toast — because the alternative is a control that
     vanishes without having done anything. On success the row redraws as a
     tombstone and the menu goes with it, since a tombstone offers neither
     entry. */
  const remove = async (): Promise<void> => {
    if (note.id === undefined || deleting) return;
    setDeleting(true);
    try {
      await onDelete?.(note.id);
      closeMenu();
    } catch {
      setConfirmingDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  const editing = draft !== undefined;
  const byline = bylineOf(note.by.displayName, note.at);
  return (
    <div
      className={`msg${note.by.id === viewerId ? " msg-mine" : ""}`}
      title={byline}
      onPointerDown={onPointerDown}
      onPointerUp={cancelPress}
      onPointerMove={cancelPress}
      onPointerCancel={cancelPress}
      onPointerLeave={cancelPress}
    >
      <ExpandAvatar name={note.by.displayName} />
      <div className="msg-body">
        <span className="sr-only">{byline}</span>
        {editing ? (
          <div className="msg-edit">
            <label className="sr-only" htmlFor={`msg-edit-${note.id}`}>
              Edit your message
            </label>
            <div className="msg-edit-field">
              {/* The label, shown and not editable — the evidence that the
                  prefix survives an edit it cannot be reached from. */}
              {note.label && <span className="msg-edit-label">{noteLabelPrefix(note)}</span>}
              <textarea
                id={`msg-edit-${note.id}`}
                rows={2}
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    stopEditing();
                  }
                  /* Enter saves, Shift+Enter takes a newline — the same idiom as
                     every other composer in the app. `preventDefault` runs even
                     on an empty box, so a refused save leaves no stray newline
                     behind. */
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void save();
                  }
                }}
              />
            </div>
            <div className="msg-edit-actions">
              <button
                type="button"
                className="btn-sm"
                disabled={isEmptyMessageText(draft) || saving}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : "Save"}
              </button>
              <button type="button" className="btn-sm btn-ghost" onClick={stopEditing} disabled={saving}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          /* A tombstone is the same row, muted, saying the app's words instead
             of the author's (#288, rule 4). It keeps the avatar, the byline and
             its place in the list above and below it, which is what makes the
             gap legible: you can see who withdrew something and roughly when.
             `noteBodyText` is what decides the wording, so a withdrawn
             send-back still reads `Needs fixes: message deleted` here and on the
             Teams card without either surface knowing how. */
          <div className={`msg-text${note.deleted ? " msg-deleted" : ""}`}>
            {noteBodyText(note)}
            {/* Rule 3, and the whole of what the thread says about an edit: no
                time, and no route back to the previous wording. That lives in
                the task's history. Never on a tombstone: there are no words
                left for it to be a footnote on. */}
            {note.edited && !note.deleted && <span className="msg-edited"> {MESSAGE_EDITED_MARKER}</span>}
          </div>
        )}
        {hasMenu && !editing && (
          <div
            ref={menuRef}
            className="msg-menu"
            /* Escape closes the menu, and stops there: focus is inside this
               wrapper whenever the menu is open, so nothing else needs to hear
               it — and the card's own Escape handlers must not also fire and
               take the whole row down with it. */
            onKeyDown={(e) => {
              if (e.key === "Escape" && menuOpen) {
                e.stopPropagation();
                closeMenu();
              }
            }}
          >
            <button
              type="button"
              className="msg-menu-trigger"
              aria-label="Message menu"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="2" />
                <circle cx="12" cy="12" r="2" />
                <circle cx="19" cy="12" r="2" />
              </svg>
            </button>
            {/* Opens in the row's own flow rather than as a portaled panel, the
                one panel in this app that does. The thread is a 178px scrolling
                box, so a panel taken out of flow is clipped by its own
                container on exactly the message people edit most — the last one
                — and escaping the box the way the card's menus do means the
                placement machinery in `App.tsx`, which this file deliberately
                cannot import. A two-entry menu is small enough to sit in the
                row instead; #288's `Delete` joins it here. */}
            {menuOpen && (
              <div className="msg-menu-panel" role="menu">
                {/* The confirmation replaces the menu rather than opening a
                    dialog over it: the row is already the smallest surface in
                    the app, and a modal for two words costs more than the
                    mistake it prevents. Escape and a press anywhere else both
                    back out of it, the same way they back out of the menu. */}
                {confirmingDelete ? (
                  <>
                    <span className="msg-menu-confirm">Delete this message?</span>
                    <button
                      type="button"
                      role="menuitem"
                      className="msg-menu-danger"
                      disabled={deleting}
                      onClick={() => void remove()}
                    >
                      {deleting ? "Deleting…" : "Delete"}
                    </button>
                    <button type="button" role="menuitem" disabled={deleting} onClick={() => setConfirmingDelete(false)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    {editable && (
                      <button type="button" role="menuitem" onClick={startEditing}>
                        Edit
                      </button>
                    )}
                    {deletable && (
                      <button
                        type="button"
                        role="menuitem"
                        className="msg-menu-danger"
                        onClick={() => setConfirmingDelete(true)}
                      >
                        Delete
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export const ThreadMessages = ({
  task,
  viewerId,
  canReply,
  onEditMessage,
  onDeleteMessage
}: {
  task: Pick<LoanTask, "taskType" | "notes" | "createdBy" | "createdAt" | "reviewNotes" | "status">;
  viewerId: string;
  canReply: boolean;
  /* The two writes this file can make (#287, #288). Optional so a renderer with
     nothing to save to — a test, a future read-only view — gets the thread
     exactly as it was before the edit path existed. */
  onEditMessage?: (messageId: string, text: string) => Promise<void>;
  onDeleteMessage?: (messageId: string) => Promise<void>;
}) => {
  const opensWithOriginatingNote = standingTermsFor(task) === undefined;
  /* PROTOTYPE (throwaway). With `?variant=A|B|C` in the URL the bubble
     prototype renders instead of the shipped rows; without it, nothing below
     changes. Delete with `thread-bubbles-prototype.tsx`. */
  const protoVariant = prototypeVariant();
  if (protoVariant !== null) {
    return (
      <PrototypeThread
        variant={protoVariant}
        task={task}
        viewerId={viewerId}
        canReply={canReply}
        opensWithOriginatingNote={opensWithOriginatingNote}
      />
    );
  }
  /* Tombstones are members of this list like any other message (#288, rule 4),
     which is the whole of what makes the empty state below correct: a thread
     holding only a withdrawn message is not an empty conversation, and saying
     "No messages yet" under a visible `Message deleted` reads as a bug. The
     collapsed row's reply count is the same length, counted in `App.tsx`. */
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
          <div className="msg-body">
            <span className="sr-only">{bylineOf(task.createdBy.displayName, task.createdAt)}</span>
            <div className="msg-text">{task.notes}</div>
          </div>
        </div>
      )}
      {/* The originating row above carries no menu, deliberately: it is the
          task's request field, not a message, and its one door is `Edit Task`
          in the hamburger (ADR-0008 rule 4). Only the replies below are
          messages somebody posted. */}
      {replies.map((note: StoredReviewNote, i: number) => (
        <MessageRow
          /* The message's own identifier since #286, which is what makes a row
             addressable rather than merely positional. The fallback to position
             is not dead: this renders whatever the API hands it, and a message
             the store has not backfilled yet is exactly the `StoredReviewNote`
             case — the same index this list keyed in full before #286. */
          key={note.id ?? i}
          note={note}
          task={task}
          viewerId={viewerId}
          {...(onEditMessage ? { onEdit: onEditMessage } : {})}
          {...(onDeleteMessage ? { onDelete: onDeleteMessage } : {})}
        />
      ))}
    </>
  );
};
