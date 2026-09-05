import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from "react";

import {
  LoanTask,
  MESSAGE_EDITED_MARKER,
  StoredReviewNote,
  canAmendTask,
  canDeleteMessage,
  canEditMessage,
  emptyRequestFieldRefusal,
  getNotesFieldLabel,
  isEmptyMessageText,
  noteBodyText,
  noteLabelPrefix,
  standingInstructionsFor,
  threadOpeningNoteFor
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
 * The reply composer, the scroll ref and every piece of card state stay in
 * App.tsx. What lives here is what a person does to the two surfaces
 * themselves: a message is held to edit or withdraw (#287, #288, #297), and
 * since #303 so is the box (ADR-0010 rule 4). Both ask a shared rule whether
 * they may — this file writes no permission logic of its own — and both take
 * their writes as injected callbacks, so a renderer that hands over neither
 * gets the two surfaces read-only. `Edit Task` in the row's hamburger is still
 * the other door onto the box, deliberately (ADR-0010 rule 4). */

/* How long a press has to last before a menu opens. Long enough not to fire on
   a tap that was meant to scroll the thread, short enough that nobody wonders
   whether it worked.
   One number for touch and mouse alike since #297: the same gesture on both,
   rather than a hover-revealed trigger on one and a long press on the other.
   One number for the *bubbles and the box* alike since #303 — the box borrows
   the gesture, and a box that answers to a different hold than the messages an
   inch below it is two gestures wearing one name. */
const LONG_PRESS_MS = 500;

/* ── One menu at a time, across the whole card (#303) ────────────────────── */
/* Until #303 the thread was the only surface on a card with a hold menu, so
   `ThreadMessages` owning "which row is open" was enough. The Instructions box
   now has one too, and it is a *sibling* of the thread rather than a row in it,
   so the variable has to sit above both of them — otherwise the box's menu and
   a message's menu can stand open at once, which is the exact bug #297 fixed
   inside the thread.

   A context rather than props threaded through <App>, for two reasons. The
   thread already reads this state in a dozen places and would have to grow a
   controlled/uncontrolled pair of code paths to take it from outside; and this
   file has to stay renderable on its own by a node script, which the fallback
   below preserves — a component with no provider over it keeps its own copy and
   behaves exactly as it did before.

   Ids are namespaced by surface: `msg:<id>` for a bubble, `box` for the
   Instructions box. Each surface acts only on its own — a press outside the
   thread must not close a menu the thread does not own, which would otherwise
   unmount the box's `Edit` button before its own click landed. */
export const INSTRUCTIONS_MENU_ID = "box";
export const messageMenuId = (id: string): string => `msg:${id}`;
const isMessageMenu = (openId: string | null): boolean => openId !== null && openId.startsWith("msg:");

interface CardMenuScope {
  openId: string | null;
  setOpenId: (id: string | null) => void;
}

const CardMenuContext = createContext<CardMenuScope | null>(null);

/* Wrapped around one expanded card body. Per card, not per app: two cards open
   at once are two conversations, and closing one because somebody held
   something on the other would be surprising. */
export const CardMenuScopeProvider = ({ children }: { children?: React.ReactNode }) => {
  const [openId, setOpenId] = useState<string | null>(null);
  const value = useMemo<CardMenuScope>(() => ({ openId, setOpenId }), [openId]);
  return <CardMenuContext.Provider value={value}>{children}</CardMenuContext.Provider>;
};

/* The scope, or a private one when nothing provided it. Both hooks run every
   render either way, so this is a choice of value and not a conditional hook. */
const useCardMenuScope = (): CardMenuScope => {
  const shared = useContext(CardMenuContext);
  const [localId, setLocalId] = useState<string | null>(null);
  const fallback = useMemo<CardMenuScope>(() => ({ openId: localId, setOpenId: setLocalId }), [localId]);
  return shared ?? fallback;
};

/* ── The gesture, once ───────────────────────────────────────────────────── */
/* Press and hold to open a menu, ADR-0009 rule 9's gesture, now worn by two
   surfaces: a message bubble (#287, #288, #297) and the Instructions box
   (#303). ADR-0010 rule 4 says the box borrows the gesture and not the
   behaviour, so the gesture is the part that is shared and the only part —
   what the menu then offers, and what happens once an editor is open, stay
   with each component and deliberately disagree.

   Written out twice before this, which made "the same threshold" a thing a
   test had to check rather than a thing that was true. Now the threshold, the
   pointer events that cancel a press, the right-click and the swallowed click
   are one implementation with one caller-supplied `onOpen`.

   Pointer events rather than touch events, so one handler covers a pen too,
   and `pointerType` is not consulted: a slow click is a hold, on any machine.

   Returns the props to spread onto whatever element is held. Handler
   parameters are structurally typed rather than `React.MouseEvent`, so a node
   test can call them with a plain object. */
const useHoldMenu = ({ enabled, onOpen }: { enabled: boolean; onOpen: () => void }) => {
  const pressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /* Set when a hold completes, read by the click that arrives as the press
     ends. Without it the press that opened the menu is also a click, and on a
     card whose every row is an expand toggle that click has somewhere to
     land. */
  const heldOpen = useRef(false);

  const cancelPress = (): void => {
    if (pressTimer.current !== undefined) {
      clearTimeout(pressTimer.current);
      pressTimer.current = undefined;
    }
  };

  return {
    onPointerDown: (): void => {
      if (!enabled) return;
      heldOpen.current = false;
      cancelPress();
      pressTimer.current = setTimeout(() => {
        heldOpen.current = true;
        onOpen();
      }, LONG_PRESS_MS);
    },
    onPointerUp: cancelPress,
    onPointerMove: cancelPress,
    onPointerCancel: cancelPress,
    onPointerLeave: cancelPress,
    /* Right-click is the same act on a desktop, and it is what somebody reaches
       for first. Taking it also stops the OS menu landing on top of ours. */
    onContextMenu: (event: { preventDefault: () => void }): void => {
      if (!enabled) return;
      event.preventDefault();
      cancelPress();
      onOpen();
    },
    /* Swallow the click a completed hold delivers on the way up, before
       whatever is underneath reads it as "collapse this card". */
    onClickCapture: (event: { preventDefault: () => void; stopPropagation: () => void }): void => {
      if (!heldOpen.current) return;
      heldOpen.current = false;
      event.preventDefault();
      event.stopPropagation();
    }
  };
};

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
 * Held to edit since #303 (ADR-0010 rule 4), which is the second door onto this
 * field — `Edit Task` in the hamburger is still the first. `onSave` absent
 * means this is a read-only rendering and the box behaves exactly as it did
 * before that ticket, which is how the sim tests and any future read-only
 * surface get the section unchanged. */
export const InstructionsSection = ({
  task,
  viewerId,
  onSave
}: {
  task: Pick<LoanTask, "taskType" | "notes" | "createdBy" | "assignee" | "status">;
  viewerId?: string;
  /* The one write this box can make. Optional for the reason `onEditMessage` is
     optional on the thread: a renderer with nothing to save to gets the box as
     it was. Rejects on a refusal, having already toasted, so the editor can
     stay open with the typing still in it. */
  onSave?: (text: string) => Promise<void>;
}) => {
  const instructions = standingInstructionsFor(task);
  if (instructions === undefined) return null;
  return <InstructionsBox task={task} instructions={instructions} viewerId={viewerId} onSave={onSave} />;
};

/* The box itself, split from the section above only so the "is this field in
   the thread?" answer can still be an early return — the hooks below cannot sit
   behind one. */
const InstructionsBox = ({
  task,
  instructions,
  viewerId,
  onSave
}: {
  task: Pick<LoanTask, "taskType" | "notes" | "createdBy" | "assignee" | "status">;
  instructions: string;
  /* Explicitly `| undefined` rather than optional: this is an internal split of
     the section above and always receives both, whatever they hold. */
  viewerId: string | undefined;
  onSave: ((text: string) => Promise<void>) | undefined;
}) => {
  const scope = useCardMenuScope();
  const menuOpen = scope.openId === INSTRUCTIONS_MENU_ID;
  const [editing, setEditing] = useState(false);
  const sectionRef = useRef<HTMLElement | null>(null);

  /* Whether this person may correct this box, asked of the shared rule and of
     nothing else (ADR-0010 rule 5, criterion "no permission logic is written in
     the web app"). `canAmendTask` is `amendRefusal(task, user, "notes")` with
     the sentence thrown away, which is both halves of the rule at once: both
     parties on an LOI, the creator alone on the other four, and nobody at all
     on a completed, cancelled or archived task. The route asks the same
     function, so a box that offers no menu is a box the API would refuse
     anyway — hiding it is the courtesy, the refusal is the enforcement.

     Short-circuited on `onSave` first so a read-only render never reaches a
     rule it has no viewer to ask. */
  const editable = onSave !== undefined && viewerId !== undefined && canAmendTask(task, { id: viewerId });

  /* The gesture, from the one implementation the bubbles below also use — same
     threshold, same pointer events, same right-click, same swallowed click.
     Stood down while the editor is open: the box is the editor then, and a hold
     on a textarea is a text selection. */
  const holdProps = useHoldMenu({
    enabled: editable && !editing,
    onOpen: () => scope.setOpenId(INSTRUCTIONS_MENU_ID)
  });

  /* A press anywhere outside the box closes its menu — capture phase, like the
     thread's, so the close lands before whatever was pressed acts on it.
     It closes only the box's own menu: `openId` is shared across the card, and
     a handler that cleared it unconditionally would take a message menu down
     from over here for no reason.

     Deliberately not armed while the editor is open. That is the whole of
     ADR-0010 rule 4's departure from the message editor — an outside press is
     the commonest stray gesture there is, and a half-rewritten brief does not
     go anywhere because somebody clicked the card next to it. */
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: globalThis.PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && sectionRef.current?.contains(target)) return;
      scope.setOpenId(null);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [menuOpen, scope]);

  /* Escape closes the menu and stops there, so the card's own Escape handlers
     do not also fire and take the row down with it. On the document rather than
     on the section, because a hold leaves focus nowhere in particular and a
     menu that only answers Escape while focused is a menu that mostly doesn't.
     The editor's own Escape is the textarea's, which has focus by then. */
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      scope.setOpenId(null);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [menuOpen, scope]);

  const startEditing = (): void => {
    scope.setOpenId(null);
    setEditing(true);
  };

  /* No `aria-label` on the section: the visible mono title already names the
     block, and a label repeating it makes a screen reader say it twice. */
  return (
    <section className="loi-terms" ref={sectionRef}>
      <div className="loi-terms-head">
        <span className="loi-terms-title">{getNotesFieldLabel(task.taskType)}</span>
        {/* Beside the box, in the head's own reserved right-hand slot, the way
            the message menu sits beside its bubble. One entry and no `Delete`:
            instructions cannot be emptied (ADR-0010 rule 4), and a control that
            is always refused is worse than no control. */}
        {menuOpen && (
          <div className="msg-menu-panel loi-terms-menu" role="menu">
            <button type="button" role="menuitem" onClick={startEditing}>
              Edit
            </button>
          </div>
        )}
      </div>
      {editing && onSave ? (
        <InstructionsEditor
          taskType={task.taskType}
          instructions={instructions}
          onSave={onSave}
          onClose={() => setEditing(false)}
        />
      ) : (
        <div
          className={`loi-terms-body${editable ? " loi-terms-holdable" : ""}${
            menuOpen ? " loi-terms-held" : ""
          }`}
          /* The one hook the sim tests count to ask "does this box answer a
             hold at all", there being no trigger element to find. */
          data-holdable={editable ? "true" : undefined}
          {...holdProps}
        >
          {instructions}
        </div>
      )}
    </section>
  );
};

/* The box turned into a field in place (#303, ADR-0010 rule 4).

   Its own component and deliberately not a mode of the message editor. The two
   share the gesture that opens them and the menu's visual shell, and they
   disagree about the two things that matter once open: Enter, and what
   cancelling costs. One component asking which of the two it was would carry
   both sets of rules and would eventually apply the wrong one.

   **Enter makes a new line.** There is no key handler for it at all — a
   textarea already does the right thing, and the message editor's
   `preventDefault` is the special case, not this. A message is a sentence and
   can be committed by reflex; this box holds a pasted term sheet a dozen lines
   long, and committing it halfway through a paste is not a shrug.

   **Committing is a button.** Refused while the box is empty, with the same
   sentence the route throws, so the two doors onto this field cannot disagree
   about what "empty" means. Refused while nothing has changed, because a save
   that writes nothing is a button that lies about what it did.

   **Cancelling a changed draft asks.** One press is not enough to lose a
   rewrite — the requirement the ticket left as a build-time call. The
   confirmation is the same in-place two-step the thread's `Delete` uses rather
   than a modal: the box is already wide enough to hold the question, and a
   dialog over a card for one question costs more than it prevents. An
   untouched draft still closes on the first press, because a prompt that
   appears every time is a prompt people stop reading — the same rule the task
   form's discard guard follows. */
/* The editor's two decisions, as a function rather than as three expressions
   inlined in the JSX — the same move `formHasChanges` made for the task form's
   discard guard, and for the same reason. "One stray keystroke does not bin a
   half-rewritten brief" is the promise this ticket is about, and a promise
   buried in a `disabled={...}` can only be asserted by reading the source.

   `changed` is raw and untrimmed: somebody who has only added a blank line has
   still changed the box, and a guard that decides otherwise throws away a
   change it could not see the point of.

   `refusal` is the route's own sentence, from shared, so the box and the API
   cannot disagree about what an emptied field is told. */
export const instructionsEditState = (
  draft: string,
  instructions: string,
  taskType: LoanTask["taskType"]
): { changed: boolean; refusal: string | undefined; canSave: boolean; cancelAsks: boolean } => {
  const changed = draft !== instructions;
  const refusal = draft.trim().length === 0 ? emptyRequestFieldRefusal(taskType) : undefined;
  return { changed, refusal, canSave: changed && refusal === undefined, cancelAsks: changed };
};

export const InstructionsEditor = ({
  taskType,
  instructions,
  onSave,
  onClose
}: {
  taskType: LoanTask["taskType"];
  instructions: string;
  onSave: (text: string) => Promise<void>;
  onClose: () => void;
}) => {
  const [draft, setDraft] = useState(instructions);
  const [saving, setSaving] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  /* Two cards can be expanded at once, so the field's id has to be this box's
     own rather than a constant two boxes would share with each other. */
  const fieldId = `instructions-edit-${useId()}`;

  /* The words the box held when this editor opened, pinned. `instructions` is a
     live prop: the card refetches after any save on the task, and on an LOI the
     other party can correct the box while somebody is part-way through their
     own rewrite. Measured against the moving value, a remote edit that happened
     to match the draft would flip `changed` to false and let the next Escape
     bin the typing with no prompt — the one loss this editor exists to prevent
     — and the commoner direction would start asking "Discard your changes?"
     over a box nobody had touched. Same reasoning as the task form's
     `openedWith` ref, and the same fix. */
  const openedWith = useRef(instructions).current;
  const { refusal, canSave, cancelAsks } = instructionsEditState(draft, openedWith, taskType);

  /* Focus lands on the answer that keeps the typing, never on the one that
     bins it — a stray Return on the confirmation must not be the discard. */
  useEffect(() => {
    if (confirmingCancel) keepRef.current?.focus();
  }, [confirmingCancel]);

  const requestClose = (): void => {
    if (cancelAsks) setConfirmingCancel(true);
    else onClose();
  };

  const save = async (): Promise<void> => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      await onSave(draft);
      onClose();
    } catch {
      /* The box stays open with the typing still in it. The caller has already
         said why in a toast, and closing on a refusal would throw away the
         rewrite along with it. */
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="loi-terms-edit">
      <label className="sr-only" htmlFor={fieldId}>
        Edit {getNotesFieldLabel(taskType)}
      </label>
      <textarea
        id={fieldId}
        className="loi-terms-edit-field"
        rows={6}
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          /* Escape only. Enter is deliberately not here: it is a newline, which
             is what the textarea does when nobody interferes. */
          if (e.key !== "Escape") return;
          e.stopPropagation();
          if (confirmingCancel) setConfirmingCancel(false);
          else requestClose();
        }}
      />
      {/* The refusal, said where the person is looking rather than after a round
         trip. Same sentence as the route's, from shared. */}
      {refusal !== undefined && <p className="loi-terms-refusal">{refusal}</p>}
      {confirmingCancel ? (
        <div className="loi-terms-edit-actions">
          <span className="loi-terms-discard-question">Discard your changes?</span>
          <button type="button" className="btn-sm btn-ghost" ref={keepRef} onClick={() => setConfirmingCancel(false)}>
            Keep editing
          </button>
          <button type="button" className="btn-sm btn-danger" onClick={onClose}>
            Discard
          </button>
        </div>
      ) : (
        <div className="loi-terms-edit-actions">
          <button type="button" className="btn-sm" disabled={!canSave || saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button type="button" className="btn-sm btn-ghost" disabled={saving} onClick={requestClose}>
            Cancel
          </button>
        </div>
      )}
    </div>
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

  /* Press and hold, ADR-0009 rule 9's gesture — now the only way in on every
     kind of machine (#297). It used to be the touch half of a pair, with a
     hover-revealed `⋯` for pointers; a control that only exists under a cursor
     is one half the people using the app never find, and holding a message is
     what everybody already does in every other chat they use.
     Since #303 the mechanics are `useHoldMenu`, shared with the Instructions
     box above, which is what makes "the same threshold" true rather than
     merely tested. */
  const holdProps = useHoldMenu({ enabled: hasMenu, onOpen: () => onMenu(true) });

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
              {...holdProps}
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
  /* The opening row, or nothing. Since #302 "nothing" has two causes and the
     shared rule holds both: the field is a standing box on five types, and on a
     Fraud Check filed on its conditions alone there is no note to draw. Either
     way the conversation below is the whole of the thread. */
  const originatingNote = threadOpeningNoteFor(task);
  const opensWithOriginatingNote = originatingNote !== undefined;
  /* One menu and one edit box across the whole thread (#297). This is the
     variable the rows used to each hold a copy of, which is why two boxes could
     stand open at once: a row that only knows about itself cannot close its
     neighbour. Two ids rather than one union because they are not alternatives
     to each other — opening either closes both, but the closing is done here,
     in one place, rather than by every row testing itself against a mode.

     Since #303 the *menu* half of that lives one level higher again, in the
     card's menu scope, because the Instructions box above the thread now has a
     menu too and the same argument applies across the pair of them. The
     open-editor half stays here: the box's editor is deliberately not closed by
     anything the thread does, and vice versa. */
  const scope = useCardMenuScope();
  const menuId = isMessageMenu(scope.openId) ? scope.openId : null;
  /* Clears the shared slot only when what is in it is a menu of ours. Every
     "close the menu" in this component means "close mine", never "close
     whatever the card has open". */
  const setMenuId = (): void => {
    if (menuId !== null) scope.setOpenId(null);
  };
  const [editingId, setEditingId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const closeAll = (): void => {
    /* Only ever clears a menu the thread owns. `openId` is shared with the box
       above, and a thread that cleared it wholesale would close the box's menu
       from over here — which would unmount its `Edit` before the click that
       chose it had landed. */
    if (menuId !== null) setMenuId();
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

  /* The menu id is namespaced (`msg:<id>`), the editing id is not: one is
     shared with the box above and has to say which surface it belongs to, the
     other never leaves this component. */
  const rowState = (id: string) => ({
    menuOpen: menuId === messageMenuId(id),
    editing: editingId === id,
    onMenu: (open: boolean) => {
      /* Opening a message menu closes the box's, because `openId` holds one
         answer for the whole card. */
      if (open) {
        scope.setOpenId(messageMenuId(id));
        setEditingId(null);
      } else {
        setMenuId();
      }
    },
    onEditing: (editing: boolean) => {
      setEditingId(editing ? id : null);
      setMenuId();
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
              <div className="msg-bubble">{originatingNote}</div>
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
