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
  standingInstructionsFor
} from "@loan-tasks/shared";

import { bylineOf, initialsOf } from "./format";

/* ── The expanded card's Instructions box and its conversation ──────────── */
/* Lifted out of App.tsx for the same reason `timeline.tsx` was: this is the
   surface ADR-0008 made a promise about, and ADR-0010 widened — a task's
   instructions are drawn as a standing box and are *not* repeated as message
   number one — and App.tsx cannot be imported into a node script, so a promise
   left in there is a promise nothing can check.
   `scripts/instructions-box-sim-test.mjs` renders both components and reads the
   markup back.
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

/* What heads the conversation. On a Fraud Check, whose field is still the
   thread's first message, that is the field's own label — because the label is
   describing the thing below it. On the five box types the field has moved into
   its own section above and taken its label with it, so the remaining rows are
   a conversation and nothing else, and saying "Loan Terms and Contacts" or
   "Concerns" over them would name the box next door. */
export const threadHeadLabel = (task: Pick<LoanTask, "taskType" | "notes">): string =>
  standingInstructionsFor(task) === undefined ? getNotesFieldLabel(task.taskType) : "Conversation";

/* The task's standing instructions (ADR-0010 rule 1, widening ADR-0008 rule 1),
   or nothing on a Fraud Check, whose ask is its outstanding-items list. A
   bordered, shadowed panel on the recessed expanded body, with the conversation
   below it as bare rows: the two are told apart by shape rather than by their
   headings.
 *
 * Free text, rendered as typed. Line breaks survive via `white-space:
 * pre-wrap` on `.loi-terms-body`, so a typed list of figures reads as a list,
 * and the box caps its height and scrolls inside itself rather than pushing the
 * conversation off the card. No parsing, no label columns, no structured
 * fields — a form of ~25 mostly empty inputs would buy formatting nobody asked
 * for, and structured terms wait for the direct import that would populate
 * them.
 *
 * Body face on every type. The fixed-width exception is the *edit form's* LOI
 * field alone (`apps/web/CLAUDE.md`), where a pasted term sheet's columns have
 * to line up; a Buddy Chat's concerns are prose and widening the box must not
 * drag the exception along with it.
 *
 * No edit affordance here yet. ADR-0010 rule 4 gives the box a press-and-hold
 * editor, which is #303's work; until then `Edit Task` in the hamburger is the
 * one door onto this field and this section displays. */
export const InstructionsSection = ({
  task
}: {
  task: Pick<LoanTask, "taskType" | "notes">;
}) => {
  const instructions = standingInstructionsFor(task);
  if (instructions === undefined) return null;
  /* No `aria-label` on the section: the visible mono title already names the
     block, and a label repeating it makes a screen reader say it twice. */
  return (
    <section className="loi-terms">
      <div className="loi-terms-head">
        <span className="loi-terms-title">{getNotesFieldLabel(task.taskType)}</span>
      </div>
      <div className="loi-terms-body">{instructions}</div>
    </section>
  );
};

/* The rows inside `.msgs`. A note is one row — glyph, then what they said —
   with no name/timestamp line above it (#165); the author and the time ride
   the row's `title` and a visually-hidden span.
 *
 * The originating field opens the list only where it is still a thread member,
 * which `standingInstructionsFor` decides once for this file and the section
 * above. Since ADR-0010 that is a Fraud Check alone; the other five open
 * genuinely empty and say so, rather than opening on a copy of their own
 * instructions.
 *
 * The empty state is a real row rather than a blank box: an empty conversation
 * on a brand-new task is the normal case on five of six types now, and an
 * unexplained gap between the box and the composer reads as something failing
 * to load. It invites a reply only when the viewer has a composer — an
 * Observer, or anyone looking at a task with no reply box, has nothing below
 * to start. */
/* How long a press has to last before the menu opens. Long enough not to fire
   on a tap that was meant to scroll the thread, short enough that nobody
   wonders whether it worked.
   One number for touch and mouse alike since #297: the same gesture on both,
   rather than a hover-revealed trigger on one and a long press on the other. */
const LONG_PRESS_MS = 500;

/* One reply row.
 *
 * Which row is open is NOT its own business since #297. A row holding its own
 * "am I open" cannot close the others, which is how two edit boxes ended up on
 * screen at once; `ThreadMessages` owns that one variable and hands each row
 * its answer. What stays local is what belongs to the act rather than to the
 * choice of row: the draft, the in-flight save, the delete confirmation.
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
  onDelete,
  menuOpen,
  editing,
  onMenu,
  onEditing
}: {
  note: StoredReviewNote;
  task: Pick<LoanTask, "status">;
  viewerId: string;
  onEdit?: (messageId: string, text: string) => Promise<void>;
  onDelete?: (messageId: string) => Promise<void>;
  menuOpen: boolean;
  editing: boolean;
  onMenu: (open: boolean) => void;
  onEditing: (editing: boolean) => void;
}) => {
  /* The second step of `Delete` (#288). The act has no undo — rule 4 refuses
     one on purpose — so the menu asks once, in place, rather than firing on a
     stray click on a two-entry menu whose other entry is harmless. */
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /* `undefined` is "not editing". An empty string is a real draft — the author
     has cleared the box — and the Save button refuses it, so the two states
     cannot be the same value. The row above decides WHETHER this row is
     editing; this decides what is in the box while it is. */
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /* Set when a hold completes, read by the click that arrives as the press
     ends. Without it the press that opened the menu is also a click on the
     bubble, and on a card whose every row is an expand toggle that click has
     somewhere to land. */
  const heldOpen = useRef(false);
  const editRef = useRef<HTMLDivElement | null>(null);

  const closeMenu = (): void => {
    onMenu(false);
    setConfirmingDelete(false);
  };

  /* A menu closed from outside — a press elsewhere, another row opening — must
     not come back still holding a "yes, delete it" nobody confirmed. */
  useEffect(() => {
    if (!menuOpen) setConfirmingDelete(false);
  }, [menuOpen]);

  /* Bring the whole box into view when it opens. The box is taller than the
     row it replaces and the thread is a fixed-height scroller, so on the last
     message — the one people edit most — `Save` and `Cancel` open below the
     fold, behind the reply composer.
     The browser's own focus scroll is not enough: it stops as soon as the
     textarea's TOP is visible, which is exactly the part that was never
     hidden. So the container is nudged by however far the box's bottom
     overshoots it, after a frame, once the box has its real height. */
  useEffect(() => {
    if (!editing) return;
    const box = editRef.current;
    const scroller = box?.closest(".msgs");
    if (!box || !scroller) return;
    const frame = requestAnimationFrame(() => {
      /* 4px so the box's border and its focus ring clear the edge rather than
         sitting flush against it. */
      const overshoot = box.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom + 4;
      if (overshoot > 0) scroller.scrollTop += overshoot;
    });
    return () => cancelAnimationFrame(frame);
  }, [editing]);

  /* The box follows the same one owner. Opening it seeds the author's own
     words; closing it, from here or from anywhere else, throws the draft away
     — an edit nobody saved was never promised back. */
  useEffect(() => {
    if (editing) setDraft((d) => d ?? note.text);
    else {
      setDraft(undefined);
      setSaving(false);
    }
    /* `note.text` deliberately absent: a re-render carrying newer text must not
       overwrite what the author is part-way through typing. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

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

  /* Press and hold, ADR-0009 rule 9's gesture — now the only way in on every
     kind of machine (#297). It used to be the touch half of a pair, with a
     hover-revealed `⋯` for pointers; a control that only exists under a cursor
     is one half the people using the app never find, and holding a message is
     what everybody already does in every other chat they use.
     Pointer events rather than touch events, so one handler covers a pen too,
     and `pointerType` is no longer consulted: a slow click on your own message
     is a hold, and there is nothing else a click on a bubble could have meant. */
  const onPointerDown = (): void => {
    if (!hasMenu) return;
    heldOpen.current = false;
    cancelPress();
    pressTimer.current = setTimeout(() => {
      heldOpen.current = true;
      onMenu(true);
    }, LONG_PRESS_MS);
  };

  /* Right-click is the same act on a desktop, and it is what somebody reaches
     for first. Taking it also stops the OS menu landing on top of ours. */
  const onContextMenu = (event: { preventDefault: () => void }): void => {
    if (!hasMenu) return;
    event.preventDefault();
    cancelPress();
    onMenu(true);
  };

  /* Swallow the click a completed hold delivers on the way up, before the row
     underneath reads it as "collapse this card". */
  const onClickCapture = (event: { preventDefault: () => void; stopPropagation: () => void }): void => {
    if (!heldOpen.current) return;
    heldOpen.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  const startEditing = (): void => {
    setConfirmingDelete(false);
    /* The box opens with the author's own words and nothing else. The app's
       label is not in it because rule 5 says it is not theirs to change — it is
       drawn beside the box instead, so they can see the row will still read
       `Needs fixes: ...` when they save. */
    setDraft(note.text);
    onEditing(true);
  };

  const stopEditing = (): void => onEditing(false);

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

  const byline = bylineOf(note.by.displayName, note.at);
  return (
    <div className={`msg${note.by.id === viewerId ? " msg-mine" : ""}`} title={byline}>
      <ExpandAvatar name={note.by.displayName} />
      <div className="msg-body">
        <span className="sr-only">{byline}</span>
        {editing && draft !== undefined ? (
          <div className="msg-edit" ref={editRef}>
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
          /* The bubble (#297). It wraps to its own text rather than filling
             the row, and holding it is what opens the menu — no hover-only
             trigger, so the same gesture works on a phone and a desktop.
             A tombstone is the same bubble, muted, saying the app's words
             instead of the author's (#288, rule 4). It keeps the avatar, the
             byline and its place in the list above and below it, which is what
             makes the gap legible: you can see who withdrew something and
             roughly when. `noteBodyText` is what decides the wording, so a
             withdrawn send-back still reads `Needs fixes: message deleted`
             here and on the Teams card without either surface knowing how. */
          <div className="msg-line">
            <div
              className={`msg-bubble${note.deleted ? " msg-deleted" : ""}${
                hasMenu ? " msg-bubble-holdable" : ""
              }${menuOpen ? " msg-bubble-held" : ""}`}
              /* The one hook the sim tests count to ask "does this row offer a
                 menu at all", now that there is no trigger element to find. */
              data-holdable={hasMenu ? "true" : undefined}
              onPointerDown={onPointerDown}
              onPointerUp={cancelPress}
              onPointerMove={cancelPress}
              onPointerCancel={cancelPress}
              onPointerLeave={cancelPress}
              onContextMenu={onContextMenu}
              onClickCapture={onClickCapture}
            >
              {noteBodyText(note)}
              {/* Rule 3, and the whole of what the thread says about an edit: no
                  time, and no route back to the previous wording. That lives in
                  the task's history. Never on a tombstone: there are no words
                  left for it to be a footnote on. */}
              {note.edited && !note.deleted && <span className="msg-edited"> {MESSAGE_EDITED_MARKER}</span>}
            </div>
            {/* Beside the bubble, in the row's own flow — never over it and
                never below it. Still not a portaled panel: the thread is a
                178px scrolling box and `thread.tsx` is deliberately importable
                by a node script, so the placement machinery in `App.tsx` is out
                of reach. Sitting in the row instead means the row cannot grow
                taller when a menu opens, which a panel under the bubble did. */}
            {menuOpen && (
              <div className="msg-menu-panel" role="menu">
                {/* The confirmation replaces the menu rather than opening a
                    dialog over it: the row is already the smallest surface in
                    the app, and a modal for two words costs more than the
                    mistake it prevents. It has to fit the same strip the menu
                    occupies — a wider confirm step pushes past the thread's
                    edge, and the scroll box clips horizontally — so the red
                    word is the question. Escape and a press anywhere else both
                    back out of it, the same way they back out of the menu. */}
                {confirmingDelete ? (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      className="msg-menu-danger"
                      aria-label="Confirm deleting this message"
                      disabled={deleting}
                      onClick={() => void remove()}
                    >
                      {deleting ? "Deleting…" : "Sure?"}
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
  const opensWithOriginatingNote = standingInstructionsFor(task) === undefined;
  /* One menu and one edit box across the whole thread (#297). This is the
     variable the rows used to each hold a copy of, which is why two boxes could
     stand open at once: a row that only knows about itself cannot close its
     neighbour. Two ids rather than one union because they are not alternatives
     to each other — opening either closes both, but the closing is done here,
     in one place, rather than by every row testing itself against a mode. */
  const [menuId, setMenuId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const closeAll = (): void => {
    setMenuId(null);
    setEditingId(null);
  };

  /* A press anywhere outside the thread is a cancel — for the menu and for the
     edit box alike. Capture phase, like the card's own panels, so the close
     lands before whatever was pressed acts on it. It deliberately does not ask
     whether the box has typing in it: an edit nobody saved was never promised
     back, and a prompt here would be a second confirmation on a surface whose
     whole point is that it is small. */
  useEffect(() => {
    if (menuId === null && editingId === null) return;
    const onDown = (event: globalThis.PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && listRef.current?.contains(target)) return;
      closeAll();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [menuId, editingId]);

  /* Inside the thread, a press on anything that is not the open menu or the
     open box is also a cancel: a different bubble, or the gap between two of
     them. The menu and the box are exempt or `Edit` would be closed before its
     own click landed. A hold on the newly pressed bubble still opens that row a
     moment later, which is the gesture doing what it looks like it does. */
  const onListPointerDown = (event: React.PointerEvent): void => {
    if (menuId === null && editingId === null) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest(".msg-menu-panel") || target?.closest(".msg-edit")) return;
    closeAll();
  };

  /* Escape closes whatever is open and stops there — the card's own Escape
     handlers must not also fire and take the whole row down with it. The
     textarea keeps its own handler for the same reason it always had one:
     focus is inside the box, and this listener never sees the key first. */
  const onListKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    if (menuId === null && editingId === null) return;
    event.stopPropagation();
    closeAll();
  };

  const rowState = (id: string) => ({
    menuOpen: menuId === id,
    editing: editingId === id,
    onMenu: (open: boolean) => {
      setMenuId(open ? id : null);
      if (open) setEditingId(null);
    },
    onEditing: (editing: boolean) => {
      setEditingId(editing ? id : null);
      setMenuId(null);
    }
  });

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
    <div className="msgs-list" ref={listRef} onPointerDown={onListPointerDown} onKeyDown={onListKeyDown}>
      {opensWithOriginatingNote && (
        <div className="msg" title={bylineOf(task.createdBy.displayName, task.createdAt)}>
          <ExpandAvatar name={task.createdBy.displayName} />
          <div className="msg-body">
            <span className="sr-only">{bylineOf(task.createdBy.displayName, task.createdAt)}</span>
            <div className="msg-line">
              <div className="msg-bubble">{task.notes}</div>
            </div>
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
          {...rowState(note.id ?? `at:${note.at}:${i}`)}
          {...(onEditMessage ? { onEdit: onEditMessage } : {})}
          {...(onDeleteMessage ? { onDelete: onDeleteMessage } : {})}
        />
      ))}
    </div>
  );
};
