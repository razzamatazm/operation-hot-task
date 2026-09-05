/* PROTOTYPE — THROWAWAY. Not production code. Delete with the branch.
 *
 * Question: what should the conversation's messages look like as bubbles, and
 * what should press-and-hold feel like on both touch and desktop?
 *
 * Three variants of the message row, rendered on the real expanded task card
 * (the real thread, the real data, the real 178px scroll box), switchable via
 * `?variant=A|B|C` and the floating bar at the bottom of the screen.
 *
 * Constraints taken from the brief:
 *  - bubbles wrap to their text, they don't fill the row
 *  - both parties sit on the SAME side, avatar to the left, as today
 *  - press-and-hold opens Edit/Delete, on touch AND on desktop
 *
 * Mutations are stubs. Editing and deleting change local state only and are
 * forgotten on reload — the question is how it looks, not whether the API
 * works, and that half already shipped.
 */

import { useEffect, useRef, useState } from "react";

import { LoanTask, StoredReviewNote, noteBodyText, noteLabelPrefix } from "@loan-tasks/shared";

import { bylineOf, initialsOf } from "./format";

export type PrototypeVariant = "A" | "B" | "C";

const VARIANTS: { key: PrototypeVariant; name: string }[] = [
  { key: "A", name: "Paper bubbles, side controls (the winner)" },
  { key: "B", name: "Lifted bubbles, action sheet" },
  { key: "C", name: "Ledger blocks, inline action strip" }
];

/* Read from the URL each render rather than held in state: the switcher writes
   the param and forces a re-render, and a reload has to land on the same
   variant. `null` means "not prototyping" — the real thread renders. */
export const prototypeVariant = (): PrototypeVariant | null => {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("variant");
  return raw === "A" || raw === "B" || raw === "C" ? raw : null;
};

/* How long a press has to last before the menu opens. 500ms matches the
   shipped touch handler; the desktop hold uses the same number so the two
   gestures feel like one gesture. */
const HOLD_MS = 500;

/* ── The hold gesture, shared by all three variants ───────────────────────
 *
 * This is the part actually being prototyped, so it lives in one place and the
 * variants differ only in what they draw when it fires.
 *
 * Covers three ways in: long-press on touch, press-and-hold on mouse, and
 * right-click on desktop (free, and what a desktop user reaches for first).
 *
 * It also fixes the mobile junk Tyler hit — the magnifier, the text selection
 * and the OS context menu all firing during a hold. `touch-action` and
 * `user-select` are on the bubble class in the CSS below; the JS half is
 * cancelling the browser's own context menu and swallowing the click that a
 * completed hold would otherwise deliver to whatever is underneath.
 */
const useHold = (enabled: boolean, open: () => void) => {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /* Set when a hold completes, read by the click handler that fires right
     after the finger lifts. Without it, the press that opened the menu also
     counts as a click on the bubble. */
  const fired = useRef(false);
  const cancel = (): void => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
  };
  useEffect(() => cancel, []);
  if (!enabled) return {};
  return {
    onPointerDown: () => {
      fired.current = false;
      cancel();
      timer.current = setTimeout(() => {
        fired.current = true;
        open();
      }, HOLD_MS);
    },
    onPointerUp: cancel,
    onPointerMove: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      open();
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (fired.current) {
        e.preventDefault();
        e.stopPropagation();
        fired.current = false;
      }
    }
  };
};

/* Local stand-in for the message list. The real one comes from the API; this
   copy is what the stubbed Edit and Delete write to. */
type Local = { text: string; edited: boolean; deleted: boolean };

const useLocalEdits = () => {
  const [local, setLocal] = useState<Record<string, Local>>({});
  const apply = (note: StoredReviewNote): StoredReviewNote => {
    const id = note.id;
    const over = id ? local[id] : undefined;
    return over ? { ...note, text: over.text, edited: over.edited, deleted: over.deleted } : note;
  };
  const edit = (id: string, text: string): void =>
    setLocal((p) => ({ ...p, [id]: { text, edited: true, deleted: p[id]?.deleted ?? false } }));
  const remove = (id: string, text: string): void =>
    setLocal((p) => ({ ...p, [id]: { text, edited: p[id]?.edited ?? false, deleted: true } }));
  return { apply, edit, remove };
};

/* Everything a variant's row needs. Kept flat so each variant can throw the
   whole layout away and still be handed the same things. */
type RowProps = {
  note: StoredReviewNote;
  mine: boolean;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string, text: string) => void;
  /* Owned by the thread, not the row (A only — B and C keep their own, which
     is exactly the "two boxes open at once" behaviour A now fixes). Calling
     `setOpen()` with nothing opens this row's menu and closes every other. */
  open: boolean;
  editing: boolean;
  setOpen: (v?: boolean) => void;
  setEditing: (v: boolean) => void;
};

/* The in-place edit box, identical across variants — the brief is about the
   bubble and the gesture, not about the box, and three different boxes would
   only muddy the comparison. */
const EditBox = ({
  note,
  onSave,
  onCancel
}: {
  note: StoredReviewNote;
  onSave: (text: string) => void;
  onCancel: () => void;
}) => {
  const [draft, setDraft] = useState(note.text);
  return (
    <div className="pb-edit">
      {note.label && <span className="pb-edit-label">{noteLabelPrefix(note)}</span>}
      <textarea
        rows={2}
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (draft.trim()) onSave(draft);
          }
        }}
      />
      <div className="pb-edit-actions">
        <button type="button" className="btn-sm" disabled={!draft.trim()} onClick={() => onSave(draft)}>
          Save
        </button>
        <button type="button" className="btn-sm btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
};

/* ── Variant A — paper bubbles, side controls (the winner, revised) ────────
 *
 * The closest thing to iMessage the warm-ledger palette allows: a rounded
 * bubble that wraps to its text, your own in the brand tint, everyone else's
 * on paper with a hairline. Same side, avatar left, per the brief.
 *
 * Revised after the first look, on Tyler's three notes:
 *  - the controls moved off the bubble's bottom edge and out to its right, the
 *    way C does it, so the thread never grows a row taller when a menu opens
 *  - A's own type treatment stayed on the menu
 *  - which message is open is decided one level up, so only one bubble can be
 *    holding a menu or an edit box at a time, and a press anywhere else is a
 *    cancel
 */
const RowA = ({ note, mine, onEdit, onDelete, open, editing, setOpen, setEditing }: RowProps) => {
  const [confirm, setConfirm] = useState(false);
  const hold = useHold(mine && !note.deleted, () => setOpen());
  const byline = bylineOf(note.by.displayName, note.at);
  /* A menu closed from outside must not come back still holding a "yes,
     delete it" nobody confirmed. */
  useEffect(() => {
    if (!open) setConfirm(false);
  }, [open]);
  return (
    <div className={`pb-row${mine ? " pb-mine" : ""}`} title={byline}>
      <span className="expand-avatar" aria-hidden="true">
        {initialsOf(note.by.displayName)}
      </span>
      <div className="pb-col">
        {editing ? (
          <EditBox
            note={note}
            onSave={(t) => {
              onEdit(note.id ?? "", t);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div className={`pb-side-wrap${open ? " pb-side-open" : ""}`}>
            <div
              className={`pb-bubble${note.deleted ? " pb-tomb" : ""}${open ? " pb-held" : ""}`}
              {...hold}
            >
              {noteBodyText(note)}
              {note.edited && !note.deleted && <span className="pb-edited"> (edited)</span>}
            </div>
            {open && (
              <div className="pb-menu-a pb-menu-side" role="menu">
                {confirm ? (
                  /* The confirm step has to fit the same strip as the menu it
                     replaces, so it is two buttons rather than a question and
                     two buttons. The red "Sure?" is the question. */
                  <>
                    <button
                      type="button"
                      className="pb-danger"
                      onClick={() => {
                        onDelete(note.id ?? "", note.text);
                        setOpen(false);
                        setConfirm(false);
                      }}
                    >
                      Sure?
                    </button>
                    <button type="button" onClick={() => setConfirm(false)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={() => setEditing(true)}>
                      Edit
                    </button>
                    <button type="button" className="pb-danger" onClick={() => setConfirm(true)}>
                      Delete
                    </button>
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

/* ── Variant B — lifted bubbles, iOS-style action sheet ────────────────────
 *
 * Borderless bubbles carrying a soft shadow instead of a hairline, so the
 * thread reads as objects on paper rather than boxes.
 *
 * The gesture is the loud half: holding dims the whole card, floats the
 * pressed bubble above the dimming with its timestamp revealed underneath —
 * the one place the app shows a message's time — and slides an action sheet up
 * from the bottom of the card. Big targets, unmissable on a phone, and the
 * dimming makes it obvious WHICH message is about to be changed.
 */
const RowB = ({ note, mine, onEdit, onDelete }: RowProps) => {
  const [sheet, setSheet] = useState(false);
  const [editing, setEditing] = useState(false);
  const hold = useHold(mine && !note.deleted, () => setSheet(true));
  const byline = bylineOf(note.by.displayName, note.at);
  return (
    <>
      <div className={`pb-row pb-row-b${mine ? " pb-mine" : ""}`} title={byline}>
        <span className="expand-avatar" aria-hidden="true">
          {initialsOf(note.by.displayName)}
        </span>
        <div className="pb-col">
          {editing ? (
            <EditBox
              note={note}
              onSave={(t) => {
                onEdit(note.id ?? "", t);
                setEditing(false);
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <>
              <div
                className={`pb-bubble pb-bubble-b${note.deleted ? " pb-tomb" : ""}${sheet ? " pb-raised" : ""}`}
                {...hold}
              >
                {noteBodyText(note)}
                {note.edited && !note.deleted && <span className="pb-edited"> (edited)</span>}
              </div>
              {sheet && <div className="pb-stamp">{byline}</div>}
            </>
          )}
        </div>
      </div>
      {sheet && (
        <div className="pb-scrim" onClick={() => setSheet(false)}>
          <div className="pb-sheet" role="menu" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => {
                setEditing(true);
                setSheet(false);
              }}
            >
              Edit
            </button>
            <button
              type="button"
              className="pb-danger"
              onClick={() => {
                onDelete(note.id ?? "", note.text);
                setSheet(false);
              }}
            >
              Delete
            </button>
            <button type="button" className="pb-sheet-cancel" onClick={() => setSheet(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
};

/* ── Variant C — ledger blocks, inline action strip ────────────────────────
 *
 * The house take rather than the iMessage one: no rounded pill, a squared
 * block tinted and ruled down its left edge in the accent, still wrapping to
 * its text. Denser than A and B — more messages visible in the same 178px.
 *
 * Nothing overlays anything. Holding slides a strip of actions in at the
 * block's right edge, pushing the text aside; the row stays in flow, so
 * nothing can be clipped by the scroll box and there is no scrim to dismiss.
 */
const RowC = ({ note, mine, onEdit, onDelete }: RowProps) => {
  const [strip, setStrip] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const hold = useHold(mine && !note.deleted, () => setStrip(true));
  const byline = bylineOf(note.by.displayName, note.at);
  return (
    <div className={`pb-row pb-row-c${mine ? " pb-mine" : ""}`} title={byline}>
      <span className="expand-avatar" aria-hidden="true">
        {initialsOf(note.by.displayName)}
      </span>
      <div className="pb-col">
        {editing ? (
          <EditBox
            note={note}
            onSave={(t) => {
              onEdit(note.id ?? "", t);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div className={`pb-block-wrap${strip ? " pb-block-open" : ""}`}>
            <div className={`pb-block${note.deleted ? " pb-tomb" : ""}`} {...hold}>
              {noteBodyText(note)}
              {note.edited && !note.deleted && <span className="pb-edited"> (edited)</span>}
            </div>
            {strip && (
              <div className="pb-strip" role="menu">
                {confirm ? (
                  <>
                    <button
                      type="button"
                      className="pb-danger"
                      onClick={() => {
                        onDelete(note.id ?? "", note.text);
                        setStrip(false);
                        setConfirm(false);
                      }}
                    >
                      Sure?
                    </button>
                    <button type="button" onClick={() => setConfirm(false)}>
                      ✕
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(true);
                        setStrip(false);
                      }}
                    >
                      Edit
                    </button>
                    <button type="button" className="pb-danger" onClick={() => setConfirm(true)}>
                      Delete
                    </button>
                    <button type="button" onClick={() => setStrip(false)}>
                      ✕
                    </button>
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

/* The whole thread, per variant. Mirrors the real `ThreadMessages` closely
   enough to be judged against it: the originating note opens the list where it
   still belongs to the thread, tombstones are members like anything else, and
   an empty conversation says so. */
export const PrototypeThread = ({
  variant,
  task,
  viewerId,
  canReply,
  opensWithOriginatingNote
}: {
  variant: PrototypeVariant;
  task: Pick<LoanTask, "taskType" | "notes" | "createdBy" | "createdAt" | "reviewNotes" | "status">;
  viewerId: string;
  canReply: boolean;
  opensWithOriginatingNote: boolean;
}) => {
  const { apply, edit, remove } = useLocalEdits();
  const replies = Array.isArray(task.reviewNotes) ? task.reviewNotes : [];
  const Row = variant === "A" ? RowA : variant === "B" ? RowB : RowC;
  /* One at a time, and the thread is the only thing that can know that. A row
     holding its own "am I open" cannot close the other rows, which is how two
     edit boxes ended up open at once. */
  const [openId, setOpenId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  /* A press anywhere outside a message is a cancel — for the menu and for the
     edit box alike. Capture phase so it lands before whatever was clicked
     acts, and it deliberately does not ask whether the box has typing in it:
     an edit that was never saved is not a draft anyone promised to keep. */
  useEffect(() => {
    if (openId === null && editingId === null) return;
    const onDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && wrapRef.current?.contains(target)) return;
      setOpenId(null);
      setEditingId(null);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [openId, editingId]);

  /* Inside the thread, a press on anything that isn't the open menu or the open
     box is also a cancel — pressing a different bubble, or the gap between two
     of them, gets you out. Presses on the menu and the box itself are exempt,
     or `Edit` would be closed before its own click landed. A hold on the newly
     pressed bubble still opens that row a moment later, which is the gesture
     doing exactly what it looks like it does. */
  const onThreadDown = (event: React.PointerEvent): void => {
    if (openId === null && editingId === null) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest(".pb-menu-a") || target?.closest(".pb-edit")) return;
    setOpenId(null);
    setEditingId(null);
  };

  const rowState = (id: string) => ({
    open: openId === id,
    editing: editingId === id,
    setOpen: (v?: boolean) => {
      setOpenId(v === false ? null : id);
      if (v !== false) setEditingId(null);
    },
    setEditing: (v: boolean) => {
      setEditingId(v ? id : null);
      setOpenId(null);
    }
  });
  if (!opensWithOriginatingNote && replies.length === 0) {
    return (
      <div className="msgs-empty">
        {canReply ? "No messages yet — start the conversation below." : "No messages yet."}
      </div>
    );
  }
  return (
    <div
      className={`pb-thread pb-thread-${variant.toLowerCase()}`}
      ref={wrapRef}
      onPointerDown={onThreadDown}
    >
      {opensWithOriginatingNote && (
        <Row
          note={
            {
              text: task.notes,
              by: task.createdBy,
              at: task.createdAt,
              id: "originating"
            } as unknown as StoredReviewNote
          }
          mine={false}
          onEdit={edit}
          onDelete={remove}
          {...rowState("originating")}
        />
      )}
      {replies.map((note, i) => {
        const shown = apply(note);
        const id = note.id ?? `i${i}`;
        return (
          <Row
            key={id}
            note={shown}
            mine={note.by.id === viewerId}
            onEdit={edit}
            onDelete={remove}
            {...rowState(id)}
          />
        );
      })}
    </div>
  );
};

/* ── The switcher ─────────────────────────────────────────────────────────
 * Fixed pill at the bottom of the screen. Arrows and ← / → cycle, the param is
 * written to the URL so a variant is shareable and survives a reload, and the
 * whole thing is gone in a production build. */
export const PrototypeSwitcher = () => {
  const [, force] = useState(0);
  const current = prototypeVariant();

  const go = (next: PrototypeVariant | null): void => {
    const url = new URL(window.location.href);
    if (next === null) url.searchParams.delete("variant");
    else url.searchParams.set("variant", next);
    window.history.replaceState(null, "", url.toString());
    force((n) => n + 1);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable);
      if (typing || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      const keys = VARIANTS.map((v) => v.key);
      const at = current ? keys.indexOf(current) : -1;
      const step = e.key === "ArrowRight" ? 1 : -1;
      const next = keys[(at + step + keys.length) % keys.length];
      go(next ?? "A");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!import.meta.env.DEV || current === null) return null;
  const meta = VARIANTS.find((v) => v.key === current);
  const keys = VARIANTS.map((v) => v.key);
  const at = keys.indexOf(current);
  return (
    <div className="pb-switcher">
      <button type="button" onClick={() => go(keys[(at - 1 + keys.length) % keys.length] ?? "A")}>
        ←
      </button>
      <span className="pb-switcher-label">
        {current} — {meta?.name}
      </span>
      <button type="button" onClick={() => go(keys[(at + 1) % keys.length] ?? "A")}>
        →
      </button>
      <button type="button" className="pb-switcher-exit" onClick={() => go(null)}>
        exit
      </button>
    </div>
  );
};

/* Styles live here rather than in `styles.css` so the prototype is one file to
   delete. Theme tokens only — the point is to judge these against the real
   palette in all three themes. */
export const PrototypeStyles = () => (
  <style>{`
/* The 3px of padding is for the held ring and the shadow. They sit outside the
   bubble's box, so in a scroll container with nothing to spare they get shaved
   off at the top and bottom of the list — most visibly on the last message,
   where the ring runs into the reply box. */
.pb-thread {
  display: flex; flex-direction: column; gap: 8px;
  --pb-menu-w: 118px; min-width: 0;
  padding: 3px 0;
}
/* Every one of these min-widths is load-bearing. A flex or grid item defaults
   to a minimum of its content, so the bubble's refusal to shrink travels all
   the way out: the row takes the bubble's longest unwrapped line as its own
   minimum, outgrows the thread's scroll box, and the box clips it. Zeroing the
   minimum at each level stops that at the bubble, where the 82% cap can do its
   job and wrap the text. */
.pb-row { display: grid; grid-template-columns: 24px 1fr; gap: 10px; align-items: start; min-width: 0; }
.pb-col { min-width: 0; max-width: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }

/* The fix for the mobile mess: no magnifier, no selection, no OS menu, and no
   500ms tap delay while a hold is in progress. */
.pb-bubble, .pb-block {
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
  touch-action: pan-y;
}

/* ── A ── */
.pb-bubble {
  max-width: 82%;
  width: fit-content;
  padding: 7px 11px;
  border-radius: 14px;
  border-top-left-radius: 4px;
  font-size: 0.86rem;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--bg-soft);
  border: 1px solid var(--line-soft);
  color: var(--ink);
  transition: box-shadow 120ms ease, outline-color 120ms ease;
}
.pb-mine .pb-bubble { background: var(--brand-soft); border-color: transparent; }
/* Held. Deliberately not a scale: scaling grows the bubble by a share of its
   own width, so a long message expands several pixels a short one doesn't —
   and a transform takes no space in the layout, so the extra width lands on
   top of the menu beside it. A shadow and a ring are the same size on every
   bubble and stay inside the 6px gap. */
.pb-held {
  box-shadow: var(--shadow-md);
  outline: 2px solid var(--brand);
  outline-offset: 1px;
}
.pb-tomb { color: var(--muted); font-style: italic; background: transparent; border-style: dashed; }
.pb-edited { color: var(--muted); font-size: 0.78rem; }
/* Controls beside the bubble, C's placement with A's type. The row keeps its
   height when a menu opens — nothing below it moves — and the bubble gives up
   width instead, which it can afford because it was never full-width. */
/* The wrap spans the column so the bubble measures itself against the thread's
   full width, not against its own shrunk-to-fit parent.
   Not a flex row: side by side, the bubble was a flex item, and a flex item
   shrinks — which broke its text to one word per line rather than let the
   fixed menu give up a pixel. Reserving a fixed slice for the menu instead
   only moved the problem, because the menu has two widths (the confirm step is
   half again as wide) and the wider one spilled out of the thread's scroll box
   and got clipped. */
/* C's sizing model, which is the one that works, with A's looks on top.
 *
 * The bug in every previous attempt was a percentage. "max-width: 82%" on a
 * flex item resolves against its containing block, and this one is
 * shrink-to-fit — an indefinite width — so the percentage cannot be resolved
 * and the item falls back to min-content: one word per line. Forcing the
 * container definite and pinning the bubble with "flex: 0 0 auto" fixed that
 * by making the bubble unshrinkable, which just moved the failure outward —
 * the row then took the longest unwrapped line as its own minimum, outgrew the
 * thread, and the scroll box clipped it.
 *
 * No percentage anywhere here. The bubble is sized by its text, capped by a
 * gutter in pixels, and free to shrink toward its longest word if the menu
 * beside it genuinely needs the room. */
.pb-side-wrap {
  display: flex; align-items: center; gap: 6px;
  max-width: 100%; min-width: 0;
  /* Keeps a bubble off the right edge so it reads as a bubble rather than a
     full-width row. Pixels, deliberately: a percentage here is the bug. */
  padding-right: 26px;
}
.pb-side-wrap .pb-bubble { width: fit-content; max-width: 100%; flex: 0 1 auto; min-width: 0; }
/* The menu keeps its width whatever the bubble does — it is the fixed thing in
   the row, and the bubble is what gives. One width in both of its states, so
   the confirm step cannot be wider than the space the menu already took. */
.pb-menu-side {
  flex: 0 0 var(--pb-menu-w);
  width: var(--pb-menu-w);
  justify-content: center;
}
.pb-menu-a {
  display: flex; gap: 4px; align-items: center; flex: none;
  background: var(--panel); border: 1px solid var(--line);
  border-radius: 8px; padding: 4px; box-shadow: var(--shadow-md);
}
/* Beside a bubble the menu is competing for the row's width, so it drops the
   third "Cancel" entry — pressing anywhere off the bubble is the cancel now. */
/* The -50% this used to carry was for a menu positioned absolutely against the
   bubble. It sits in the row's own flow now, so that offset was lifting it half
   its height off its resting place and settling it back on every open — the
   visible twitch. It slides in from the right and nowhere else. */
.pb-menu-side { animation: pb-slide-in 120ms ease-out; }
@keyframes pb-slide-in {
  from { opacity: 0; transform: translateX(8px); }
  to { opacity: 1; transform: none; }
}
.pb-menu-a button, .pb-strip button {
  font-size: 0.78rem; padding: 4px 8px; border: 0; border-radius: 6px;
  background: transparent; color: var(--ink); cursor: pointer;
}
.pb-menu-a button:hover, .pb-strip button:hover { background: var(--control-hover); }
.pb-danger { color: var(--bad) !important; }
.pb-menu-confirm { font-size: 0.78rem; color: var(--ink-secondary); padding: 0 6px; }

/* ── B ── */
.pb-bubble-b {
  border: 0;
  background: var(--panel);
  box-shadow: var(--shadow-sm);
  border-radius: 16px;
  border-top-left-radius: 5px;
}
.pb-mine .pb-bubble-b { background: var(--brand-soft); }
.pb-raised { position: relative; z-index: 60; box-shadow: var(--shadow-md); transform: scale(1.03); }
.pb-stamp {
  position: relative; z-index: 60;
  font-family: "JetBrains Mono", monospace; font-size: 0.62rem;
  text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted);
}
.pb-scrim {
  position: fixed; inset: 0; z-index: 50;
  background: rgba(0,0,0,0.42);
  display: flex; align-items: flex-end; justify-content: center;
}
.pb-sheet {
  width: min(420px, 100%); margin: 10px;
  background: var(--panel); border-radius: 14px; overflow: hidden;
  box-shadow: var(--shadow-md); display: flex; flex-direction: column;
}
.pb-sheet button {
  padding: 15px; font-size: 0.95rem; border: 0; background: transparent;
  color: var(--ink); cursor: pointer; border-bottom: 1px solid var(--line-soft);
}
.pb-sheet button:hover { background: var(--row-hover); }
.pb-sheet-cancel { font-weight: 600; border-bottom: 0 !important; }

/* ── C ── */
.pb-block-wrap { display: flex; align-items: stretch; gap: 6px; max-width: 100%; }
.pb-block {
  width: fit-content; max-width: 100%;
  padding: 5px 10px 5px 9px;
  border-left: 2px solid var(--line);
  background: var(--row-alt);
  font-size: 0.86rem; line-height: 1.42;
  white-space: pre-wrap; word-break: break-word; color: var(--ink);
  border-radius: 0 4px 4px 0;
}
.pb-mine .pb-block { border-left-color: var(--brand); background: var(--brand-soft); }
.pb-block-open .pb-block { opacity: 0.55; }
.pb-strip {
  display: flex; align-items: center; gap: 2px;
  background: var(--panel); border: 1px solid var(--line);
  border-radius: 6px; padding: 2px; box-shadow: var(--shadow-sm);
}

/* Shared edit box */
.pb-edit { display: flex; flex-direction: column; gap: 6px; width: 100%; }
.pb-edit textarea {
  width: 100%; font: inherit; font-size: 0.86rem; padding: 6px 8px;
  border: 1px solid var(--line); border-radius: 8px;
  background: var(--panel); color: var(--ink); resize: vertical;
}
.pb-edit-label {
  font-family: "JetBrains Mono", monospace; font-size: 0.66rem;
  text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted);
}
.pb-edit-actions { display: flex; gap: 6px; }

/* Switcher */
.pb-switcher {
  position: fixed; bottom: 14px; left: 50%; transform: translateX(-50%);
  z-index: 9999; display: flex; align-items: center; gap: 8px;
  padding: 6px 8px; border-radius: 999px;
  background: #111; color: #fff; box-shadow: 0 6px 24px rgba(0,0,0,0.35);
  font-family: "JetBrains Mono", monospace; font-size: 0.7rem;
}
.pb-switcher button {
  border: 0; background: rgba(255,255,255,0.14); color: #fff;
  border-radius: 999px; width: 24px; height: 24px; cursor: pointer;
}
.pb-switcher-exit { width: auto !important; padding: 0 10px; font-size: 0.66rem; }
.pb-switcher-label { padding: 0 4px; letter-spacing: 0.04em; }
`}</style>
);
