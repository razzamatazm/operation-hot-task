/* PROTOTYPE — throwaway. Not production code, not tested, not for main.
 *
 * Question: how should the Instructions box go into edit?
 *
 * What shipped in #303 opens a menu beside the box and makes you choose `Edit`.
 * That is two gestures to correct one field, and the menu has exactly one entry
 * in it. Tyler's read: clunky. His proposal: hold anywhere on the box, or
 * right-click it, and you are typing — the way holding a message in iMessage
 * puts the actions right there rather than sending you somewhere.
 *
 * Three variants on `?variant=`, rendered on the real task card with real data,
 * because a gesture judged in a vacuum always feels fine:
 *
 *   A  Straight in     — hold anywhere / right-click → editor. Explicit Save.
 *   B  Leaving commits — same entry, no Save button. Press away and it is
 *                        written, with a few seconds of Undo.
 *   C  One tap         — no hold at all. The box says it is editable and a
 *                        single click opens it. Explicit Save.
 *
 * A and B disagree about how an edit ends; A and C disagree about how one
 * starts. That is the whole design space this is here to settle.
 *
 * The variants write for real, through the same `onSave` the shipped box uses.
 * A commit model is not judgeable against a stub — B in particular is only a
 * question once the save actually lands. */

import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { LoanTask } from "@loan-tasks/shared";
import { emptyRequestFieldRefusal, getNotesFieldLabel } from "@loan-tasks/shared";

export const PROTOTYPE_VARIANTS = ["off", "A", "B", "C"] as const;
export type PrototypeVariant = (typeof PROTOTYPE_VARIANTS)[number];

const VARIANT_NAMES: Record<PrototypeVariant, string> = {
  off: "Shipped (menu, then Edit)",
  A: "Straight in — hold or right-click",
  B: "Leaving commits — no Save button",
  C: "One tap — no hold at all"
};

/* ── The variant, in the URL and in memory ───────────────────────────── */

const readFromUrl = (): PrototypeVariant => {
  if (typeof window === "undefined") return "off";
  const raw = new URLSearchParams(window.location.search).get("variant");
  return (PROTOTYPE_VARIANTS as readonly string[]).includes(raw ?? "") ? (raw as PrototypeVariant) : "off";
};

let current: PrototypeVariant = readFromUrl();
const listeners = new Set<() => void>();

const setVariant = (next: PrototypeVariant): void => {
  current = next;
  const url = new URL(window.location.href);
  if (next === "off") url.searchParams.delete("variant");
  else url.searchParams.set("variant", next);
  window.history.replaceState(null, "", url);
  listeners.forEach((l) => l());
};

/* `getServerSnapshot` matters: thread.tsx is rendered to a string by the node
   sim tests, where there is no window and the answer must be "off". */
export const usePrototypeVariant = (): PrototypeVariant =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => "off" as const
  );

/* ── The switcher ────────────────────────────────────────────────────── */

export const PrototypeSwitcher = (): React.ReactElement | null => {
  const variant = usePrototypeVariant();
  if (!import.meta.env.DEV) return null;

  const cycle = (step: number): void => {
    const i = PROTOTYPE_VARIANTS.indexOf(variant);
    setVariant(PROTOTYPE_VARIANTS[(i + step + PROTOTYPE_VARIANTS.length) % PROTOTYPE_VARIANTS.length]!);
  };

  return (
    <>
      <ProtoStyles />
      <ProtoKeys onCycle={cycle} />
      <div className="proto-bar" role="group" aria-label="Prototype variant">
        <button type="button" onClick={() => cycle(-1)} aria-label="Previous variant">←</button>
        <span className="proto-bar-label">
          <strong>{variant === "off" ? "OFF" : variant}</strong> {VARIANT_NAMES[variant]}
        </span>
        <button type="button" onClick={() => cycle(1)} aria-label="Next variant">→</button>
      </div>
    </>
  );
};

const ProtoKeys = ({ onCycle }: { onCycle: (step: number) => void }): null => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const el = document.activeElement;
      const tag = el?.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || (el as HTMLElement | null)?.isContentEditable) return;
      onCycle(event.key === "ArrowRight" ? 1 : -1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCycle]);
  return null;
};

/* ── Shared editor guts, so the three variants disagree only where they mean
      to. Deliberately not the shipped `InstructionsEditor`: this one has to be
      free to have no Save button at all. ─────────────────────────────── */

const useDraft = (instructions: string, taskType: LoanTask["taskType"]) => {
  const [draft, setDraft] = useState(instructions);
  const openedWith = useRef(instructions).current;
  const refusal = draft.trim().length === 0 ? emptyRequestFieldRefusal(taskType) : undefined;
  return { draft, setDraft, openedWith, changed: draft !== openedWith, refusal };
};

/* Focus, with the caret at the end rather than at the start. A hold that drops
   you in front of your own text reads as "the box moved", not "you may type". */
const focusAtEnd = (el: HTMLTextAreaElement | null): void => {
  if (!el) return;
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
};

/* ── Variant A — straight in, explicit save ──────────────────────────── */

export const VariantA = ({ task, instructions, editable, onSave }: BoxProps): React.ReactElement => {
  const [editing, setEditing] = useState(false);
  /* The height the words occupied a moment ago. Handed to the editor so the
     textarea opens at exactly that size: the box grows downward to make room
     for Save and Cancel, rather than the text shrinking to make room for them
     inside the height it already had. What you held is what you are typing in. */
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [startHeight, setStartHeight] = useState<number | undefined>(undefined);
  const hold = useStraightIn({
    enabled: editable && !editing,
    onOpen: () => {
      setStartHeight(bodyRef.current?.getBoundingClientRect().height);
      setEditing(true);
    }
  });

  /* The gesture is on the whole panel, heading and padding included — every
     pixel inside the white box answers a hold, because the box is the thing
     being corrected and a target the size of the sentence is a target people
     miss. Stood down while the editor is open: a hold on a textarea is a text
     selection. */
  return (
    <section
      className={`loi-terms proto-box${editable && !editing ? " proto-holdable" : ""}${
        hold.held ? " proto-held" : ""
      }`}
      {...hold.props}
    >
      <div className="loi-terms-head">
        <span className="loi-terms-title">{getNotesFieldLabel(task.taskType)}</span>
      </div>
      {editing ? (
        <ProtoEditor
          task={task}
          instructions={instructions}
          onSave={onSave}
          onClose={() => setEditing(false)}
          commit="button"
          startHeight={startHeight}
        />
      ) : (
        <div ref={bodyRef} className="loi-terms-body">
          {instructions}
        </div>
      )}
    </section>
  );
};

/* ── Variant B — same entry, leaving commits ─────────────────────────── */

export const VariantB = ({ task, instructions, editable, onSave }: BoxProps): React.ReactElement => {
  const [editing, setEditing] = useState(false);
  const [flash, setFlash] = useState<string | undefined>(undefined);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [startHeight, setStartHeight] = useState<number | undefined>(undefined);
  const hold = useStraightIn({
    enabled: editable && !editing,
    onOpen: () => {
      setStartHeight(bodyRef.current?.getBoundingClientRect().height);
      setEditing(true);
    }
  });

  /* The undo is a real one: it writes the old words back. */
  const undo = async (previous: string): Promise<void> => {
    setFlash(undefined);
    await onSave(previous);
  };

  return (
    <section
      className={`loi-terms proto-box${editable && !editing ? " proto-holdable" : ""}${
        hold.held ? " proto-held" : ""
      }`}
      {...hold.props}
    >
      <div className="loi-terms-head">
        <span className="loi-terms-title">{getNotesFieldLabel(task.taskType)}</span>
      </div>
      {editing ? (
        <ProtoEditor
          task={task}
          instructions={instructions}
          onSave={onSave}
          onClose={() => setEditing(false)}
          commit="leave"
          startHeight={startHeight}
          onCommitted={(previous) => {
            setFlash(previous);
            window.setTimeout(() => setFlash(undefined), 6000);
          }}
        />
      ) : (
        <div ref={bodyRef} className="loi-terms-body">
          {instructions}
        </div>
      )}
      {flash !== undefined && (
        <p className="proto-flash">
          Saved.{" "}
          <button type="button" className="proto-undo" onClick={() => void undo(flash)}>
            Undo
          </button>
        </p>
      )}
    </section>
  );
};

/* ── Variant C — one tap, no hold ────────────────────────────────────── */

export const VariantC = ({ task, instructions, editable, onSave }: BoxProps): React.ReactElement => {
  const [editing, setEditing] = useState(false);

  return (
    <section
      className={`loi-terms proto-box${editable && !editing ? " proto-tappable" : ""}`}
      onClick={(e) => {
        if (!editable || editing) return;
        /* The card underneath reads a click as "collapse me". */
        e.stopPropagation();
        setEditing(true);
      }}
    >
      <div className="loi-terms-head">
        <span className="loi-terms-title">{getNotesFieldLabel(task.taskType)}</span>
        {editable && !editing && <span className="proto-hint">click to edit</span>}
      </div>
      {editing ? (
        <ProtoEditor
          task={task}
          instructions={instructions}
          onSave={onSave}
          onClose={() => setEditing(false)}
          commit="button"
        />
      ) : (
        <div className="loi-terms-body">{instructions}</div>
      )}
    </section>
  );
};

/* ── The gesture A and B share ───────────────────────────────────────── */

const LONG_PRESS_MS = 450;

const useStraightIn = ({ enabled, onOpen }: { enabled: boolean; onOpen: () => void }) => {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const opened = useRef(false);
  const [held, setHeld] = useState(false);

  const cancel = (): void => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
    setHeld(false);
  };

  return {
    held,
    props: {
      onPointerDown: (): void => {
        if (!enabled) return;
        opened.current = false;
        cancel();
        setHeld(true);
        timer.current = setTimeout(() => {
          opened.current = true;
          setHeld(false);
          onOpen();
        }, LONG_PRESS_MS);
      },
      onPointerUp: cancel,
      onPointerMove: cancel,
      onPointerCancel: cancel,
      onPointerLeave: cancel,
      onContextMenu: (event: React.MouseEvent): void => {
        if (!enabled) return;
        event.preventDefault();
        cancel();
        onOpen();
      },
      /* The click a completed hold delivers would otherwise collapse the card. */
      onClickCapture: (event: React.MouseEvent): void => {
        if (!opened.current) return;
        opened.current = false;
        event.preventDefault();
        event.stopPropagation();
      }
    }
  };
};

/* ── The editor, with the two commit models ──────────────────────────── */

type BoxProps = {
  task: Pick<LoanTask, "taskType" | "notes" | "createdBy" | "assignee" | "status">;
  instructions: string;
  editable: boolean;
  onSave: (text: string) => Promise<void>;
};

const ProtoEditor = ({
  task,
  instructions,
  onSave,
  onClose,
  commit,
  startHeight,
  onCommitted
}: {
  task: BoxProps["task"];
  instructions: string;
  onSave: (text: string) => Promise<void>;
  onClose: () => void;
  commit: "button" | "leave";
  /* The read view's height at the moment of the hold. The textarea opens at it,
     so the words do not move and the box grows instead. */
  startHeight?: number | undefined;
  onCommitted?: (previous: string) => void;
}): React.ReactElement => {
  const { draft, setDraft, openedWith, changed, refusal } = useDraft(instructions, task.taskType);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const fieldId = `proto-instructions-${useId()}`;

  useEffect(() => focusAtEnd(fieldRef.current), []);

  const save = async (): Promise<void> => {
    if (!changed || refusal !== undefined || saving) return;
    setSaving(true);
    try {
      await onSave(draft);
      onCommitted?.(openedWith);
      onClose();
    } catch {
      /* Stays open with the typing in it; the caller has toasted. */
    } finally {
      setSaving(false);
    }
  };

  /* Leaving commits (variant B): a press outside writes what is in the box.
     Nothing is written when the words are unchanged or the box is empty — an
     empty box is refused, and leaving must not be a way past a refusal. */
  useEffect(() => {
    if (commit !== "leave") return;
    const onDown = (event: globalThis.PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && boxRef.current?.contains(target)) return;
      if (!changed || refusal !== undefined) {
        onClose();
        return;
      }
      void save();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  });

  return (
    <div className="loi-terms-edit" ref={boxRef}>
      <label className="sr-only" htmlFor={fieldId}>
        Edit {getNotesFieldLabel(task.taskType)}
      </label>
      <textarea
        id={fieldId}
        ref={fieldRef}
        className="loi-terms-edit-field"
        rows={6}
        style={startHeight !== undefined ? { height: `${Math.max(startHeight, 72)}px` } : undefined}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          if (confirming) {
            setConfirming(false);
            return;
          }
          if (commit === "leave") {
            if (changed && refusal === undefined) void save();
            else onClose();
            return;
          }
          if (changed) setConfirming(true);
          else onClose();
        }}
      />
      {refusal !== undefined && <p className="loi-terms-refusal">{refusal}</p>}
      {confirming ? (
        <div className="loi-terms-edit-actions">
          <span className="loi-terms-discard-question">Discard your changes?</span>
          <button type="button" className="btn-sm btn-ghost" autoFocus onClick={() => setConfirming(false)}>
            Keep editing
          </button>
          <button type="button" className="btn-sm btn-danger" onClick={onClose}>
            Discard
          </button>
        </div>
      ) : commit === "leave" ? (
        <p className="proto-leave-hint">
          {saving ? "Saving…" : refusal !== undefined ? "Empty — nothing will be saved" : "Press away to save · Esc to save"}
        </p>
      ) : (
        <div className="loi-terms-edit-actions">
          <button
            type="button"
            className="btn-sm"
            disabled={!changed || refusal !== undefined || saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="btn-sm btn-ghost"
            disabled={saving}
            onClick={() => (changed ? setConfirming(true) : onClose())}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
};

/* ── Prototype-only styling, kept out of styles.css so this branch is one
      file plus a two-line hook. ──────────────────────────────────────── */

const ProtoStyles = (): React.ReactElement => (
  <style>{`
.proto-bar {
  position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
  z-index: 200; display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; border-radius: 999px;
  background: #101014; color: #f4f4f5;
  box-shadow: 0 8px 24px rgba(0,0,0,0.35);
  font-family: "JetBrains Mono", monospace; font-size: 0.7rem; letter-spacing: 0.04em;
}
.proto-bar button {
  all: unset; cursor: pointer; padding: 2px 8px; border-radius: 999px;
  background: rgba(255,255,255,0.1); color: inherit; line-height: 1.4;
}
.proto-bar button:hover { background: rgba(255,255,255,0.22); }
.proto-bar-label strong { margin-right: 6px; }
.proto-box { position: relative; }
/* The whole box answers the gesture, padding included — that is variant A's
   actual claim, and a hold target the size of the text is not it. */
.proto-box.proto-holdable {
  cursor: pointer; touch-action: none; -webkit-user-select: none; user-select: none;
  -webkit-touch-callout: none;
}
/* The ring is on the outer box, because the outer box is what opens. Holding
   the text and then watching a smaller box appear inside it is the clunk. */
.proto-box.proto-held {
  box-shadow: inset 0 0 0 2px var(--brand), var(--shadow-md);
}
.proto-box.proto-tappable { cursor: text; }
.proto-box.proto-tappable:hover { box-shadow: inset 0 0 0 1px var(--brand), var(--shadow-sm); }
.proto-hint {
  font-family: "JetBrains Mono", monospace; font-size: 0.6rem;
  letter-spacing: 0.06em; color: var(--muted); text-transform: uppercase;
}
.proto-leave-hint {
  margin: 6px 0 0; font-family: "JetBrains Mono", monospace;
  font-size: 0.62rem; letter-spacing: 0.04em; color: var(--muted);
}
.proto-flash {
  margin: 6px 0 0; font-size: 0.75rem; color: var(--ink-secondary);
}
.proto-undo {
  all: unset; cursor: pointer; color: var(--brand); font-weight: 600;
  text-decoration: underline;
}
`}</style>
);
