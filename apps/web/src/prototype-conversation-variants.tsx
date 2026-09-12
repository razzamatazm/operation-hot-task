/* PROTOTYPE — throwaway. Not for main.

   Question: what should a task card's conversation look like if it borrowed the
   shape of the sections above it (the Instructions box and the Fraud Check's
   outstanding items, both a ruled page with the label in a left margin)?

   Four looks on the real board, switched with `?variant=` and the floating bar
   at the bottom of the screen (or the arrow keys):
     now — the thread as it ships today, for comparison
     A   — ruled page: label in the margin, today's bubbles to the right of it
     B   — ledger rows: label in the margin, messages as hairline-ruled rows
           like checklist items, with who and when on each row
     C   — speakers in the margin: each message's author and time sit in the
           margin column where the section label sits, the words to the right

   Every variant except `now` heads the section "Conversation" on every task
   type, per #387. */
import { ReactNode, useEffect, useSyncExternalStore } from "react";
import { formatDate } from "./format";

export const CONVERSATION_VARIANTS = [
  { key: "now", name: "Today's thread" },
  { key: "A", name: "Ruled page, bubbles kept" },
  { key: "B", name: "Ledger rows" },
  { key: "C", name: "Speakers in the margin" }
] as const;

export type ConversationVariant = (typeof CONVERSATION_VARIANTS)[number]["key"];

const CHANGE_EVENT = "prototype-conversation-variant";

/* Node renders thread.tsx in the sim tests with no window; they get today's
   markup. */
const readVariant = (): ConversationVariant => {
  if (typeof window === "undefined") return "now";
  const wanted = new URLSearchParams(window.location.search).get("variant");
  return CONVERSATION_VARIANTS.find((v) => v.key === wanted)?.key ?? "A";
};

const subscribe = (onChange: () => void): (() => void) => {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("popstate", onChange);
  };
};

export const useConversationVariant = (): ConversationVariant =>
  useSyncExternalStore(subscribe, readVariant, () => "now");

const stepVariant = (delta: number): void => {
  const keys = CONVERSATION_VARIANTS.map((v) => v.key);
  const at = keys.indexOf(readVariant());
  const next = keys[(at + delta + keys.length) % keys.length] ?? "now";
  const url = new URL(window.location.href);
  url.searchParams.set("variant", next);
  window.history.replaceState(null, "", url);
  window.dispatchEvent(new Event(CHANGE_EVENT));
};

/* The section wrapper and its heading. Replaces `<div className="thread">` and
   the `.thread-head` inside it in App.tsx. */
export const ProtoThread = ({ todayLabel, children }: { todayLabel: string; children: ReactNode }) => {
  const variant = useConversationVariant();
  const className =
    variant === "now" ? "thread" : variant === "C" ? "thread thread-proto-C" : `thread thread-proto thread-proto-${variant}`;
  return (
    <div className={className}>
      <div className="thread-head">{variant === "now" ? todayLabel : "Conversation"}</div>
      {children}
    </div>
  );
};

const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

/* Variant C: who and when, in the margin column, standing in for the avatar. */
export const ProtoSpeaker = ({ name, at }: { name: string; at: string }) => {
  if (useConversationVariant() !== "C") return null;
  return (
    <span className="msg-proto-speaker" aria-hidden="true">
      <b>{firstName(name)}</b>
      <span>{formatDate(at)}</span>
    </span>
  );
};

/* Variant B: who and when, a mono line over the words. */
export const ProtoByline = ({ name, at }: { name: string; at: string }) => {
  if (useConversationVariant() !== "B") return null;
  return (
    <span className="msg-proto-byline" aria-hidden="true">
      <b>{firstName(name)}</b> · {formatDate(at)}
    </span>
  );
};

export const ConversationVariantSwitcher = () => {
  const current = useConversationVariant();
  const isProd = import.meta.env?.PROD === true;

  useEffect(() => {
    if (isProd) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      stepVariant(event.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isProd]);

  if (isProd) return null;
  const variant = CONVERSATION_VARIANTS.find((v) => v.key === current)!;
  return (
    <div className="proto-switcher" role="toolbar" aria-label="Prototype variant">
      <button type="button" className="proto-switcher-arrow" aria-label="Previous variant" onClick={() => stepVariant(-1)}>
        ←
      </button>
      <span className="proto-switcher-label">
        {variant.key === "now" ? "Now" : variant.key} — {variant.name}
      </span>
      <button type="button" className="proto-switcher-arrow" aria-label="Next variant" onClick={() => stepVariant(1)}>
        →
      </button>
    </div>
  );
};
