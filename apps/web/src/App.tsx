import { app as teamsApp, authentication } from "@microsoft/teams-js";
import { CLOSED_STATUSES, ChecklistItem, CreateTaskInput, FraudCardAction, Loan, LoanTask, TaskStatus, TaskType, TASK_TYPES, UrgencyLevel, UserIdentity, UserRole, canClaimTask, canDeleteChecklistItem, canEditChecklist, canRestoreTask, deriveMyLoanIds, formatWallDate, fraudCardActions, getNotesFieldLabel, loanTypeaheadSuggestions, nextFlowStatuses, nextHighlightIndex, restoreTargetStatus, sortChecklist, unresolvedCount } from "@loan-tasks/shared";
import { FormEvent, KeyboardEvent, MouseEvent as ReactMouseEvent, memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useToast } from "./toast";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";
const IS_DEV = import.meta.env.DEV;
/* Dev-only mock identities for the plain-browser path (no Teams host). The
   server's `x-user-*` header fallback (auth.ts, only when SSO is unconfigured)
   trusts these so local role-switching works. IS_DEV is statically false in a
   prod build, so this list and the selector are tree-shaken out of the bundle.
   In a Teams tab the real identity comes from the SSO token (bootstrap). */
const DEV_USERS: UserIdentity[] = [
  { id: "loan-officer-1", displayName: "Suzie", roles: ["LOAN_OFFICER"] },
  { id: "file-checker-1", displayName: "Alexa", roles: ["LOAN_OFFICER", "FILE_CHECKER"] },
  { id: "admin-1", displayName: "Johanna", roles: ["LOAN_OFFICER", "FILE_CHECKER", "ADMIN"] }
];
const INITIAL_USER: UserIdentity = IS_DEV
  ? DEV_USERS[0]!
  : { id: "", displayName: "Signing in", roles: ["LOAN_OFFICER"] };

/* SSO bearer token, set once the Teams auth flow resolves. Module-level so
   the standalone apiRequest helper can read it without prop-drilling. */
let authToken: string | null = null;
export const setAuthToken = (token: string | null): void => {
  authToken = token;
};

const TASK_TYPE_LABELS: Record<TaskType, string> = {
  LOI: "LOI Check",
  BUDDY_CHAT: "Buddy Chat",
  VALUE: "Value Check",
  FRAUD: "Fraud Check",
  LOAN_DOCS: "Loan Docs",
  OOO: "OOO - Out of Office"
};

const URGENCY_LABELS: Record<UrgencyLevel, string> = {
  GREEN: "Within 24 Hours",
  YELLOW: "End of Day",
  ORANGE: "Within 1 Hour",
  RED: "Urgent Now"
};

const apiRequest = async <T,>(path: string, init: RequestInit, user: UserIdentity): Promise<T> => {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      /* Teams: SSO bearer. Dev browser (no token): identify via the mock
         user headers so local role-switching still works. */
      ...(authToken
        ? { authorization: `Bearer ${authToken}` }
        : {
            "x-user-id": user.id,
            "x-user-name": user.displayName,
            "x-user-roles": user.roles.join(",")
          }),
      ...(init.headers ?? {})
    }
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? "Request failed");
  }

  return data as T;
};

const canUnclaim = (task: LoanTask, user: UserIdentity): boolean => task.status === "CLAIMED" && (task.assignee?.id === user.id || user.roles.includes("ADMIN"));

const isOverdue = (task: LoanTask): boolean => !CLOSED_STATUSES.includes(task.status) && new Date(task.dueAt).getTime() < Date.now();

const formatDate = (iso: string): string => {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
};

const formatPtDateOnly = (iso: string): string => {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Los_Angeles"
  });
};

/* For closed tasks the deadline is moot — show how long ago it landed.
   Falls back to "done" when no completedAt is recorded. */
const formatRelativeCompleted = (iso?: string): string => {
  if (!iso) return "done";
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 60000) return "done just now";
  const min = Math.round(diffMs / 60000);
  if (min < 60) return `done ${min}m ago`;
  const hr = Math.round(diffMs / 3600000);
  if (hr < 24) return `done ${hr}h ago`;
  const day = Math.round(diffMs / 86400000);
  return `done ${day}d ago`;
};

const applyTheme = (theme?: string): void => {
  const normalized = theme === "dark" || theme === "contrast" ? theme : "light";
  document.documentElement.setAttribute("data-theme", normalized);
};

/* ── Grouped ("courts") view helpers ──────────────────────── */
/* Two-letter initials for the compact avatar chips, "Suzie Lim" → "SL". */
const initialsOf = (name?: string): string => {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  const letters = parts.map((p) => p[0] ?? "").join("");
  return (letters.slice(0, 2) || "?").toUpperCase();
};

/* Whose court is the ball in? Drives the grouped buckets. Mirrors the
   collapsed-row primary-action ladder so the section a task lands in and the
   button it offers agree. Permission edge cases (e.g. a creator can't COMPLETE
   a NEEDS_REVIEW task) are still gated by the action ladder itself — a "you"
   card may carry no quick button and be acted on from the expanded body. */
type Court = "you" | "pool" | "them" | "done";
const courtOf = (task: LoanTask, user: UserIdentity): Court => {
  if (CLOSED_STATUSES.includes(task.status)) return "done";
  if (task.status === "OPEN") {
    // An OPEN task you created isn't "up for grabs" for you — you're waiting on
    // someone else to claim it, so it belongs in your "In flight" court.
    return task.createdBy.id === user.id ? "them" : "pool";
  }
  const isAssignee = task.assignee?.id === user.id;
  const isCreator = task.createdBy.id === user.id;
  // FRAUD two-phase (#39): the ball alternates between the requester (creator)
  // and the fraud checker (assignee). CLAIMED (checker's initial pass) falls
  // through to the generic assignee-owns-CLAIMED rule below. AWAITING_ITEMS is
  // the requester's move (gather the outstanding items back). PENDING_APPROVAL
  // is the checker's move (approve or send back) — unless it's been released
  // (no assignee), when it's up for grabs by any fraud checker.
  if (task.taskType === "FRAUD") {
    if (task.status === "AWAITING_ITEMS") return isCreator ? "you" : "them";
    if (task.status === "PENDING_APPROVAL") {
      if (!task.assignee) return isCreator ? "them" : "pool";
      return isAssignee ? "you" : "them";
    }
  }
  if (task.status === "CLAIMED" && isAssignee) return "you";
  if (task.status === "MERGE_DONE" && isCreator) return "you";
  if (task.status === "MERGE_APPROVED" && isAssignee) return "you";
  // Review is the creator's move (AGENTS.md: review transitions are done by the
  // assignee or creator and "do not require admin"), so an admin who isn't a
  // party to the task doesn't get every in-review task dumped in their court.
  if (task.status === "NEEDS_REVIEW" && isCreator) return "you";
  return "them";
};

/* Latest review-note timestamp from someone other than `userId` — the basis
   for the unread-note signal (red dot) and the Message-pull court override.
   Empty string when there is no such note. */
const latestNoteFromOther = (task: LoanTask, userId: string): string => {
  let latest = "";
  for (const n of task.reviewNotes ?? []) {
    if (n.by.id !== userId && n.at > latest) latest = n.at;
  }
  return latest;
};

/* Calm, real coarse distance for a not-imminent deadline — hour/day grain,
   no ticking minutes, capped at ">1w" so a quiet task reads as a real distance
   instead of shouting a precise number (and never as an urgency category). */
const coarseDue = (dueIso: string, nowMs: number): string => {
  const h = (new Date(dueIso).getTime() - nowMs) / 3600000;
  if (h >= 24 * 7) return ">1w";
  if (h >= 48) return `${Math.round(h / 24)}d`;
  return `${Math.round(h)}h`;
};

/* Live "2h 14m" / "38m" / "2d" countdown, sign flips on overdue. */
const liveCountdown = (dueIso: string, nowMs: number): { overdue: boolean; text: string } => {
  const diff = new Date(dueIso).getTime() - nowMs;
  const abs = Math.abs(diff);
  const m = Math.floor(abs / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  let text: string;
  if (d >= 2) text = `${d}d`;
  else if (h >= 1) text = `${h}h ${String(m % 60).padStart(2, "0")}m`;
  else text = `${m}m`;
  return { overdue: diff < 0, text };
};

/* The label-over-value "DUE IN / 6h" cell shown in a grouped row. Closed
   tasks read "✓ Nm ago"; OOO reads its return date. Within 4h (or overdue) we
   show the live ticking value; further out we fall back to a calm coarse
   distance so quiet tasks don't shout a precise number. */
const groupedDue = (
  task: LoanTask,
  nowMs: number
): { label: string; value: string; overdue: boolean; done: boolean } => {
  if (task.status === "COMPLETED" || task.status === "ARCHIVED") {
    const stamp = task.completedAt ?? task.archivedAt;
    return { label: "", value: `✓ ${formatRelativeCompleted(stamp).replace(/^done\s*/, "")}`.trim(), overdue: false, done: true };
  }
  // Cancelled tasks are closed — the deadline is moot, so show when they were
  // cancelled (mirrors the completed/archived stamp, with a ✕ instead of ✓)
  // rather than a stale due countdown now that Cancelled rides the Done view.
  if (task.status === "CANCELLED") {
    const stamp = task.cancelledAt ?? task.updatedAt;
    return { label: "", value: `✕ ${formatRelativeCompleted(stamp).replace(/^done\s*/, "")}`.trim(), overdue: false, done: true };
  }
  if (task.taskType === "OOO") {
    return { label: "RETURNS", value: formatPtDateOnly(task.dueAt), overdue: false, done: false };
  }
  const cd = liveCountdown(task.dueAt, nowMs);
  if (cd.overdue) return { label: "OVERDUE BY", value: cd.text, overdue: true, done: false };
  if (new Date(task.dueAt).getTime() - nowMs <= 4 * 3600000) {
    return { label: "DUE IN", value: cd.text, overdue: false, done: false };
  }
  return { label: "DUE IN", value: coarseDue(task.dueAt, nowMs), overdue: false, done: false };
};

const firstName = (displayName: string | undefined): string => {
  if (!displayName) return "";
  return displayName.split(/\s+/)[0] ?? displayName;
};

/* LOAN_DOCS and FRAUD have multiple stages between claim and complete. Stage
   suffix rides on the title as a hyphen suffix so the type label stays terse.
   For FRAUD it also disambiguates a released final-approval task sitting in the
   pool ("Final Approval Needed") from a fresh unclaimed check. */
const stageSuffix = (task: LoanTask): string => {
  if (task.taskType === "LOAN_DOCS") {
    if (task.status === "MERGE_DONE") return " - Merge Done";
    if (task.status === "MERGE_APPROVED") return " - Merge Approved";
    return "";
  }
  if (task.taskType === "FRAUD") {
    if (task.status === "AWAITING_ITEMS") return " - Outstanding Items";
    if (task.status === "PENDING_APPROVAL") return task.assignee ? " - Final Approval" : " - Final Approval Needed";
    return "";
  }
  return "";
};

/* ── Poop score control ───────────────────────────────────── */
const PoopDisplay = ({
  count,
  canEdit,
  onChange
}: {
  count: number;
  canEdit: boolean;
  onChange: (next: number) => void;
}) => {
  const safeCount = Math.max(0, Math.min(5, count | 0));

  if (safeCount === 0 && !canEdit) return null;

  const titleText = canEdit
    ? `How Bad? ${safeCount}/5 — click to rate`
    : `How Bad? ${safeCount}/5`;

  return (
    <span
      className={`poop-track${canEdit ? " poop-track-editable" : ""}`}
      onClick={(e) => e.stopPropagation()}
      title={titleText}
      aria-label={titleText}
    >
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = n <= safeCount;
        const className = `poop-slot${filled ? " poop-slot-on" : ""}`;
        if (!canEdit) {
          return (
            <span key={n} className={className} aria-hidden="true">
              💩
            </span>
          );
        }
        return (
          <button
            key={n}
            type="button"
            className={className}
            onClick={(e) => {
              e.stopPropagation();
              onChange(n === safeCount ? 0 : n);
            }}
            aria-label={`Set How Bad? to ${n}`}
            aria-pressed={filled}
          >
            💩
          </button>
        );
      })}
    </span>
  );
};

/* ── Small neutral avatar (expanded strip + notes thread) ──── */
/* Mono treatment: initials in a neutral circle, no per-user color. */
const ExpandAvatar = ({ name }: { name?: string }) => (
  <span className="expand-avatar" aria-hidden="true">{initialsOf(name)}</span>
);

/* ── Status timeline (expanded body) ──────────────────────── */
/* Vertical rail of the task's lifecycle. NEEDS_REVIEW sits on the CLAIMED
   step (and tags it); ARCHIVED reads as COMPLETED. The current in-flight
   step carries a "NOW" (or "NEEDS REVIEW") chip. */
const TIMELINE_LABELS: Record<string, string> = {
  OPEN: "Opened",
  CLAIMED: "Claimed",
  MERGE_DONE: "Merge done",
  MERGE_APPROVED: "Merge approved",
  // FRAUD two-phase (#39): outstanding items sent to the requester, then the
  // requester submits them back for the checker's final approval.
  AWAITING_ITEMS: "Outstanding items",
  PENDING_APPROVAL: "Final approval",
  COMPLETED: "Completed",
  NEEDS_REVIEW: "Needs review"
};
const Timeline = ({ task }: { task: LoanTask }) => {
  const flow: TaskStatus[] =
    task.taskType === "LOAN_DOCS"
      ? ["OPEN", "CLAIMED", "MERGE_DONE", "MERGE_APPROVED", "COMPLETED"]
      : task.taskType === "FRAUD"
        ? ["OPEN", "CLAIMED", "AWAITING_ITEMS", "PENDING_APPROVAL", "COMPLETED"]
        : ["OPEN", "CLAIMED", "COMPLETED"];
  const effective: TaskStatus =
    task.status === "NEEDS_REVIEW" ? "CLAIMED" : task.status === "ARCHIVED" ? "COMPLETED" : task.status;
  const idx = flow.indexOf(effective);
  return (
    <div className="timeline">
      {flow.map((s, i) => {
        const done = i <= idx;
        const current = i === idx && !CLOSED_STATUSES.includes(task.status);
        const dotColor = done
          ? s === "COMPLETED" && task.status === "COMPLETED"
            ? "var(--good)"
            : "var(--brand)"
          : "var(--line)";
        return (
          <div key={s} className="tl-item">
            <span className="tl-dot" style={{ background: dotColor }} />
            <div className="tl-body">
              <b style={{ color: done ? "var(--ink)" : "var(--muted)" }}>{TIMELINE_LABELS[s]}</b>
              {current && task.status === "NEEDS_REVIEW" && <span className="tag tag-warn">NEEDS REVIEW</span>}
              {current && task.status !== "NEEDS_REVIEW" && <span className="tag tag-brand">NOW</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
};

/* Standard three-connected-nodes "share" glyph (#58). Hand-rolled inline SVG —
   the app ships no icon library (only the logo SVG + Unicode marks), so this is
   the one reusable share icon every share affordance should use. Sized via
   `.icon-share` in styles.css; color follows `currentColor`. */
const ShareIcon = () => (
  <svg
    className="icon-share"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <line x1="8.6" y1="10.7" x2="15.4" y2="6.3" />
    <line x1="8.6" y1="13.3" x2="15.4" y2="17.7" />
  </svg>
);

/* Funnel glyph for the per-row "filter to this loan" affordance (#57). Inline
   SVG in the ShareIcon idiom — no icon library ships. Sized via `.icon-filter`;
   color follows `currentColor`. */
const FilterIcon = () => (
  <svg
    className="icon-filter"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M3 5h18l-7 8v6l-4 2v-8z" />
  </svg>
);

/* ── Share popover ───────────────────────────────────────────
   A compact icon trigger (#58) that opens an anchored panel — above the trigger
   (#59) — with the people-picker, optional note, and Copy link. Collapses the
   share UI behind a button so it stops dominating the card (#52). Self-contained
   so the create-task flow (#46) can reuse it. Dismisses on outside-click or Esc.
   On a successful share (recorded server-side regardless of DM delivery) it
   fires a "Shared" toast and auto-dismisses; Copy link keeps its "Copied ✓"
   flash, then auto-dismisses (#60). */
const SharePopover = ({
  candidates,
  onShare,
  link
}: {
  /* People the picker offers — pre-filtered by the caller (excludes creator,
     assignee, and self per #41). */
  candidates: Array<{ id: string; displayName: string }>;
  /* Fire the share. Resolves with whether the DM actually reached them; rejects
     on request failure so the panel can show inline status. */
  onShare: (targetUserId: string, note?: string) => Promise<{ delivered: boolean }>;
  /* Copy-link target (in-app deep link). null/undefined hides the Copy link
     button — e.g. when there's no task id yet. */
  link?: string | null;
}) => {
  const [open, setOpen] = useState(false);
  /* Chosen person + optional note + in-flight flag + copy-link flash. Success
     and failure are both toasts now (#60), so no status text lives in the panel;
     `state` only drives the button label + disabled while a share is in flight. */
  const [targetId, setTargetId] = useState("");
  const [note, setNote] = useState("");
  const [state, setState] = useState<"idle" | "sending">("idle");
  const [copied, setCopied] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const selectId = useId();
  const { showToast } = useToast();

  /* Close and reset the transient flags so the next open starts clean. */
  const close = () => {
    setOpen(false);
    setCopied(false);
    setState("idle");
  };

  /* Dismiss on an outside mousedown while open. Esc is handled on the panel. */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const handleShare = async () => {
    if (!targetId) return;
    setState("sending");
    try {
      /* The share is recorded server-side regardless of DM delivery, so any
         resolution is a success — confirm with a toast and auto-dismiss (#60). */
      await onShare(targetId, note.trim() || undefined);
      setTargetId("");
      setNote("");
      showToast("Shared", { variant: "success" });
      close();
    } catch {
      /* Re-enable the button so they can retry; the failure surfaces as a toast. */
      setState("idle");
      showToast("Couldn't share — try again", { variant: "error" });
    }
  };

  /* Copy the in-app deep link (`#task-<id>` anchor scrolls the row into view).
     The person-picker above is the real deliverable; this is the lightweight
     "share link". Keep the "Copied ✓" flash, then auto-dismiss the popover (#60). */
  const handleCopy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(close, 1100);
    } catch {
      /* clipboard unavailable — ignore */
    }
  };

  return (
    <div className="share-pop" ref={wrapRef}>
      <button
        type="button"
        className="btn-sm btn-ghost share-pop-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Share"
        title="Share"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <ShareIcon />
      </button>
      {open && (
        <div
          className="share-pop-panel"
          role="dialog"
          aria-label="Share this task"
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}
        >
          <label className="share-pop-label" htmlFor={selectId}>Share</label>
          <select
            id={selectId}
            value={targetId}
            onChange={(e) => { setTargetId(e.target.value); setState("idle"); }}
            autoFocus
          >
            <option value="">Choose a person…</option>
            {candidates.map((p) => (
              <option key={p.id} value={p.id}>{p.displayName}</option>
            ))}
          </select>
          <input
            className="share-pop-note"
            type="text"
            value={note}
            placeholder="Add a note (optional)"
            maxLength={280}
            onChange={(e) => { setNote(e.target.value); if (state !== "sending") setState("idle"); }}
          />
          <div className="share-pop-actions">
            <button type="button" className="btn-sm" disabled={!targetId || state === "sending"} onClick={() => void handleShare()}>
              {state === "sending" ? "Sharing…" : "Share"}
            </button>
            {link && (
              <button type="button" className="btn-sm btn-ghost" onClick={() => void handleCopy()}>
                {copied ? "Copied ✓" : "Copy link"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

/* ── Fraud outstanding-items checklist (#44) ──────────────────
   The structured handoff that replaces the old free-text outstanding-items
   surface on FRAUD checks. The checker builds the list, the creator resolves
   it (tick = collected OR not-needed, with an optional note), the checker
   reviews and approves or bounces. Items are never deleted — an item leaves
   consideration only by being checked off. Unresolved items float to the top.
   Every affordance is gated by the shared canEditChecklist so the UI matches
   the server's turn rules; the server is still the authority. */
export interface ChecklistApi {
  addItem: (taskId: string, text: string) => Promise<void>;
  editText: (taskId: string, itemId: string, text: string) => Promise<void>;
  deleteItem: (taskId: string, itemId: string) => Promise<void>;
  toggle: (taskId: string, itemId: string, checked: boolean, note?: string) => Promise<void>;
  setNote: (taskId: string, itemId: string, note: string) => Promise<void>;
  setCheckerNote: (taskId: string, itemId: string, checkerNote: string) => Promise<void>;
}

const CheckIcon = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
    <path d="M3 8.5l3.2 3.3L13 4.8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const TrashIcon = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
    <path d="M3 4.5h10M6.5 4.5V3.2a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.3M5 4.5l.6 8a1 1 0 0 0 1 .95h2.8a1 1 0 0 0 1-.95l.6-8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const FraudChecklist = ({ task, user, api }: { task: LoanTask; user: UserIdentity; api: ChecklistApi }) => {
  const [newItem, setNewItem] = useState("");
  /* One inline editor open at a time: which item + which field. */
  const [active, setActive] = useState<{ id: string; kind: "text" | "note" | "checkerNote" } | null>(null);
  const [draft, setDraft] = useState("");

  const items = task.checklist ?? [];
  const sorted = sortChecklist(items);
  const open = unresolvedCount(items);

  const canAdd = canEditChecklist(task, user, "add");
  const canToggle = canEditChecklist(task, user, "toggle");
  const canEditText = canEditChecklist(task, user, "editText");
  const canCreatorNote = canEditChecklist(task, user, "creatorNote");
  const canCheckerNote = canEditChecklist(task, user, "checkerNote");

  const openEditor = (id: string, kind: "text" | "note" | "checkerNote", seed: string) => {
    setActive({ id, kind });
    setDraft(seed);
  };
  const closeEditor = () => { setActive(null); setDraft(""); };
  const saveEditor = async (item: ChecklistItem) => {
    if (!active) return;
    const value = draft.trim();
    if (active.kind === "text") {
      if (value && value !== item.text) await api.editText(task.id, item.id, value);
    } else if (active.kind === "note") {
      await api.setNote(task.id, item.id, value);
    } else {
      await api.setCheckerNote(task.id, item.id, value);
    }
    closeEditor();
  };

  const addItem = async () => {
    const value = newItem.trim();
    if (!value) return;
    setNewItem("");
    await api.addItem(task.id, value);
  };

  /* One-line turn cue so each party knows what the list wants from them.
     OPEN (unclaimed/just-created) intentionally has no cue — the create
     form already has its own Outstanding Items seeder (#82). */
  const turnCue =
    task.status === "OPEN"
      ? null
      : task.status === "CLAIMED"
        ? "Checker's pass — list what's outstanding"
        : task.status === "AWAITING_ITEMS"
        ? "Requester's turn — collect items, then submit"
        : task.status === "PENDING_APPROVAL"
          ? "Final review — approve or send back"
          : null;

  return (
    <div className="checklist">
      <div className="checklist-head">
        <span className="checklist-title">Outstanding items</span>
        <span className="checklist-count">{items.length === 0 ? "none yet" : `${open} open / ${items.length}`}</span>
        {turnCue && <span className="checklist-turn">{turnCue}</span>}
      </div>

      {sorted.length > 0 && (
        <ul className="checklist-items">
          {sorted.map((item) => {
            const editingText = active?.id === item.id && active.kind === "text";
            const editingNote = active?.id === item.id && active.kind === "note";
            const editingCheckerNote = active?.id === item.id && active.kind === "checkerNote";
            return (
              <li key={item.id} className={`checklist-item${item.checked ? " checklist-item-done" : ""}${item.stale ? " checklist-item-stale" : ""}`}>
                <div className="checklist-item-main">
                  <button
                    type="button"
                    className={`checklist-check${item.checked ? " checklist-check-on" : ""}`}
                    role="checkbox"
                    aria-checked={item.checked}
                    aria-label={item.checked ? `Mark "${item.text}" unresolved` : `Mark "${item.text}" resolved`}
                    disabled={!canToggle}
                    onClick={() => { if (canToggle) void api.toggle(task.id, item.id, !item.checked); }}
                  >
                    {item.checked && <CheckIcon />}
                  </button>

                  {editingText ? (
                    <input
                      className="checklist-item-input"
                      value={draft}
                      autoFocus
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); void saveEditor(item); }
                        if (e.key === "Escape") closeEditor();
                      }}
                      onBlur={() => void saveEditor(item)}
                    />
                  ) : (
                    <button
                      type="button"
                      className="checklist-item-text"
                      disabled={!canEditText}
                      title={canEditText ? "Edit item" : undefined}
                      onClick={() => { if (canEditText) openEditor(item.id, "text", item.text); }}
                    >
                      {item.text}
                    </button>
                  )}

                  <span className="checklist-badges">
                    {item.addedBy === "creator" && <span className="checklist-badge checklist-badge-creator" title="Added by the requester">+requester</span>}
                    {item.stale && <span className="checklist-badge checklist-badge-stale" title="Text changed after it was checked — re-verify">stale · re-verify</span>}
                  </span>

                  {/* Gated delete (#66): only for a fresh item you added, on your
                      own turn, before it's handed off. Locks once submitted /
                      sent / bounced. */}
                  {canDeleteChecklistItem(task, user, item) && (
                    <button
                      type="button"
                      className="checklist-delete"
                      title="Delete this item (only until you hand it off)"
                      aria-label={`Delete "${item.text}"`}
                      onClick={() => void api.deleteItem(task.id, item.id)}
                    >
                      <TrashIcon />
                    </button>
                  )}
                </div>

                {/* Per-item notes: the requester's exception note and the
                    checker's rework note, each shown when present and editable
                    by the owning role on their turn. */}
                <div className="checklist-item-notes">
                  {editingNote ? (
                    <div className="checklist-note-edit">
                      <input
                        className="checklist-item-input"
                        placeholder="Why it's not needed / how it was handled…"
                        value={draft}
                        autoFocus
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void saveEditor(item); } if (e.key === "Escape") closeEditor(); }}
                        onBlur={() => void saveEditor(item)}
                      />
                    </div>
                  ) : item.note ? (
                    <button type="button" className="checklist-note checklist-note-creator" disabled={!canCreatorNote} onClick={() => { if (canCreatorNote) openEditor(item.id, "note", item.note ?? ""); }}>
                      <span className="checklist-note-label">Requester</span> {item.note}
                    </button>
                  ) : canCreatorNote ? (
                    <button type="button" className="checklist-note-add" onClick={() => openEditor(item.id, "note", "")}>+ note</button>
                  ) : null}

                  {editingCheckerNote ? (
                    <div className="checklist-note-edit">
                      <input
                        className="checklist-item-input"
                        placeholder="Why this isn't sufficient / needs rework…"
                        value={draft}
                        autoFocus
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void saveEditor(item); } if (e.key === "Escape") closeEditor(); }}
                        onBlur={() => void saveEditor(item)}
                      />
                    </div>
                  ) : item.checkerNote ? (
                    <button type="button" className="checklist-note checklist-note-checker" disabled={!canCheckerNote} onClick={() => { if (canCheckerNote) openEditor(item.id, "checkerNote", item.checkerNote ?? ""); }}>
                      <span className="checklist-note-label">Checker</span> {item.checkerNote}
                    </button>
                  ) : canCheckerNote ? (
                    <button type="button" className="checklist-note-add" onClick={() => openEditor(item.id, "checkerNote", "")}>+ checker note</button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {canAdd && (
        <div className="checklist-add">
          <input
            className="checklist-item-input"
            placeholder="Add an item, press Enter…"
            value={newItem}
            onChange={(e) => setNewItem(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addItem(); } }}
          />
          <button type="button" className="btn-sm" onClick={() => void addItem()} disabled={!newItem.trim()}>Add</button>
        </div>
      )}

      {sorted.length === 0 && !canAdd && (
        <div className="checklist-empty">No outstanding items yet.</div>
      )}
    </div>
  );
};

/* ── Task Card ────────────────────────────────────────────── */
/* Memoized so non-card App state changes — most notably the 30s `now` ticker
   (#73) — re-render only the cards whose props actually changed. This bites
   only because every prop below is referentially stable: the ~10 handlers and
   `checklistApi` are `useCallback`/`useMemo`-wrapped in App, and the rest are
   primitives or already-stable values (see the `cardProps` object). Adding an
   unstable prop here silently defeats the memo. */
const TaskCard = memo(({
  task,
  user,
  onClaim,
  onUnclaim,
  onTransition,
  onRelease,
  onAddReviewNote,
  onAddCompletedNote,
  onUpdatePoints,
  onFilterLoan,
  onShare,
  checklist,
  directory,
  showActions,
  seenNoteAt,
  onMarkNoteSeen,
  pulsing,
  expandOverride,
  onSetExpand,
  now
}: {
  task: LoanTask;
  user: UserIdentity;
  onClaim: (taskId: string) => Promise<void>;
  onUnclaim: (taskId: string) => Promise<void>;
  onTransition: (taskId: string, status: TaskStatus, reviewNotes?: string) => Promise<void>;
  onRelease: (taskId: string) => Promise<void>;
  onAddReviewNote: (taskId: string, text: string) => Promise<void>;
  /* Append a note to an already-COMPLETED task (#45). Server keeps the task
     COMPLETED — no visible reopen. */
  onAddCompletedNote: (taskId: string, text: string) => Promise<void>;
  onUpdatePoints: (taskId: string, points: number) => Promise<void>;
  /* FRAUD structured checklist ops (#44). */
  checklist: ChecklistApi;
  onFilterLoan?: (loanId: string) => void;
  /* Point a specific person at this task (issue #41). Resolves with whether the
     DM actually reached them; rejects on request failure so the card can show
     inline status. */
  onShare: (taskId: string, targetUserId: string, note?: string) => Promise<{ delivered: boolean }>;
  /* Selectable people for the share picker (active users, id + name). */
  directory: Array<{ id: string; displayName: string }>;
  showActions: boolean;
  seenNoteAt?: string;
  onMarkNoteSeen?: (taskId: string, at: string) => void;
  pulsing?: boolean;
  /* Per-user persisted manual open/close. undefined = follow the default. */
  expandOverride?: boolean;
  onSetExpand?: (taskId: string, open: boolean) => void;
  /* Ticking clock (ms) for the row's live countdown. */
  now?: number;
}) => {
  const [noteText, setNoteText] = useState("");
  /* FRAUD note-required moves (Send Outstanding Items / Send Back) reveal an
     inline textarea whose text posts as the transition's reviewNotes. `fraudNote`
     holds the draft; `openFraudNote` is the target status of the move whose box
     is open (null = none). The server also rejects a blank note. */
  const [fraudNote, setFraudNote] = useState("");
  const [openFraudNote, setOpenFraudNote] = useState<TaskStatus | null>(null);
  /* "Add a note" on a COMPLETED card (#45): the button reveals an inline field
     whose text posts to the server-atomic completed-note endpoint (task stays
     COMPLETED). `completedNoteOpen` toggles the field; `completedNote` is the
     draft. */
  const [completedNoteOpen, setCompletedNoteOpen] = useState(false);
  const [completedNote, setCompletedNote] = useState("");
  /* Two-step cancel: confirm row → 1s "Cancelled" flash → server refresh
     drops the task from the grid since cancelled rows are filtered out. */
  const [cancelStage, setCancelStage] = useState<"idle" | "confirming" | "done">("idle");
  useEffect(() => {
    if (cancelStage !== "done") return;
    const id = setTimeout(() => setCancelStage("idle"), 1200);
    return () => clearTimeout(id);
  }, [cancelStage]);
  const isAssignee = task.assignee?.id === user.id;
  const isCreator = task.createdBy.id === user.id;
  /* Who may attach a review note: the task's creator, its assignee, or an admin.
     Mirrors the server's canAddNote so UI and API agree; reused by the active
     composer (canPostNote) and the completed-card "Add a note" gate (#45). */
  const canNoteTask = isCreator || isAssignee || user.roles.includes("ADMIN");
  /* Latest note from the OTHER party — drives unread/force-open behavior. */
  const latestOtherNoteAt = useMemo(
    () => latestNoteFromOther(task, user.id),
    [task.reviewNotes, user.id]
  );
  const hasUnreadNote = !!latestOtherNoteAt && latestOtherNoteAt > (seenNoteAt ?? "");
  /* Accordion default-open rule:
       - OPEN (up for grabs) → open for everyone
       - an unread note from the other party → open (even once completed)
       - you're involved (creator/assignee) and the task is in-flight → open
     Everything else (completed / closed without an unread note) → closed.
     A persisted per-user manual override (expandOverride) wins; the App
     clears it on a status change or a fresh unread note so the default
     re-applies. */
  const involvedInFlight =
    (isCreator || isAssignee) &&
    (task.status === "CLAIMED" ||
      task.status === "NEEDS_REVIEW" ||
      task.status === "MERGE_DONE" ||
      task.status === "MERGE_APPROVED");
  const defaultOpen = task.status === "OPEN" || hasUnreadNote || involvedInFlight;
  const expanded = expandOverride ?? defaultOpen;
  const setExpanded = (open: boolean): void => onSetExpand?.(task.id, open);
  /* Acknowledge an unread note: clears the undim lock and the red dot.
     Triggered by an explicit user gesture (header click/key, or sending
     a reply). */
  const acknowledgeUnread = (): void => {
    if (hasUnreadNote && latestOtherNoteAt && onMarkNoteSeen) {
      onMarkNoteSeen(task.id, latestOtherNoteAt);
    }
  };
  /* Auto-scroll the notes thread to the newest entry whenever the count grows
     or the card opens. */
  const reviewListRef = useRef<HTMLDivElement | null>(null);
  const reviewCount = task.reviewNotes?.length ?? 0;
  useEffect(() => {
    const el = reviewListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [reviewCount, expanded]);
  const overdue = isOverdue(task);
  const transitions = nextFlowStatuses(task).filter((s) => s !== "OPEN");
  // Non-undefined only for a reopened task; the exact closed status to restore
  // it to (COMPLETED/ARCHIVED). Permission mirrors the shared canRestoreTask.
  const restoreTarget = restoreTargetStatus(task);

  const handleSubmitNote = async () => {
    if (!noteText.trim()) return;
    await onAddReviewNote(task.id, noteText.trim());
    setNoteText("");
    acknowledgeUnread();
  };

  /* Submit the COMPLETED-card note (#45). One gesture: post, clear, close the
     field; the task stays COMPLETED (the server handles the atomic append). */
  const submitCompletedNote = async () => {
    if (!completedNote.trim()) return;
    acknowledgeUnread();
    await onAddCompletedNote(task.id, completedNote.trim());
    setCompletedNote("");
    setCompletedNoteOpen(false);
  };

  /* Share: point one person at this task. Candidates exclude the current user
     plus the creator and assignee — they already see the task, so the picker
     only offers genuinely new recipients (issue #41). */
  const shareCandidates = directory.filter(
    (p) => p.id !== user.id && p.id !== task.createdBy.id && p.id !== task.assignee?.id
  );
  /* In-app deep link to this task (the `#task-<id>` anchor matches the card's
     element id, so it scrolls the row into view) — the Copy link target. */
  const shareLink = `${window.location.origin}${window.location.pathname}#task-${task.id}`;

  const isClosed = CLOSED_STATUSES.includes(task.status);
  const isObserver = !isCreator && !isAssignee;
  /* "Celebrating" = the creator just hit a completion milestone
     (COMPLETED, or LOAN_DOCS MERGE_DONE). Stays celebrating until the
     creator archives the task (or it falls back to an earlier status). */
  const isCelebrating =
    isCreator &&
    (task.status === "COMPLETED" || (task.taskType === "LOAN_DOCS" && task.status === "MERGE_DONE"));
  /* Dim rule:
     - OPEN → always bright (anyone may claim).
     - Attached (creator or assignee), in-flight → bright (it's your work).
     - Closed (completed/cancelled/archived) → dim, even if attached.
     - Observer, in-flight → dim (not your task).
     - Celebrating card and unread notes override → stay bright. */
  const dimmed = !hasUnreadNote && !isCelebrating && task.status !== "OPEN" && (
    isClosed || isObserver
  );
  /* Mini = closed bottom-bucket row. Celebrating COMPLETED renders as a
     full-size pulsing card at the top until the creator archives it. */
  const mini = isClosed && !isCelebrating;
  /* The grouped ("courts") row is deliberately mono: the court section already
     says "whose court" and the row's own thin stripe encodes overdue, so we
     carry only the dim, mini, and celebrating-pulse signals — no colored status
     stripe, closed backdrop, or own/watching accents. */
  const cardClass = [
    "task-card",
    "task-card-grouped-wrap",
    expanded ? "task-card-grouped-open" : "",
    dimmed ? "task-card-dimmed" : "",
    mini ? "task-card-mini" : "",
    pulsing ? "task-card-celebrating" : ""
  ].filter(Boolean).join(" ");

  const handleHeaderClick = () => {
    acknowledgeUnread();
    setExpanded(!expanded);
  };
  const handleHeaderKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    acknowledgeUnread();
    setExpanded(!expanded);
  };
  const stopBubble = (e: ReactMouseEvent) => e.stopPropagation();

  const dueTitle = task.status === "COMPLETED" || task.status === "ARCHIVED"
    ? (task.completedAt ? `Completed ${formatDate(task.completedAt)}` : undefined)
    : task.taskType === "OOO"
      ? undefined
      : `Due ${formatDate(task.dueAt)}`;
  const urgencyTitle = task.taskType !== "OOO" ? `Urgency: ${URGENCY_LABELS[task.urgency]}` : undefined;

  /* FRAUD two-phase role-aware buttons (#39), shared with the bot cards so both
     surfaces show the same set. Empty for non-FRAUD. `fraudQuick` is the single
     plain forward move (Submit for Approval / Approve) promoted to the collapsed
     quick-action slot; note-required moves (Send Outstanding Items / Send Back)
     and Release live in the expanded body where the note box fits. */
  const fraudActions = fraudCardActions(task, user.id);
  const fraudQuick = fraudActions.find((a) => a.kind === "transition");
  // A released final-approval task (unassigned PENDING_APPROVAL) is claimable
  // by any fraud checker via the same claim path as an OPEN task.
  const isReleasedForClaim = task.taskType === "FRAUD" && task.status === "PENDING_APPROVAL" && !task.assignee;

  type QuickAction = { label: string; kind: "good" | "ghost" | "danger" | "default"; run: () => void };
  let primaryAction: QuickAction | null = null;
  if (showActions) {
    if ((task.status === "OPEN" || isReleasedForClaim) && !isCreator && canClaimTask(task, user)) {
      primaryAction = { label: "Claim", kind: "good", run: () => { void onClaim(task.id); } };
    } else if (fraudQuick && fraudQuick.targetStatus) {
      const target = fraudQuick.targetStatus;
      primaryAction = { label: fraudQuick.label, kind: "good", run: () => { void onTransition(task.id, target); } };
    } else if (task.status === "CLAIMED" && isAssignee && task.taskType === "LOAN_DOCS" && transitions.includes("MERGE_DONE")) {
      primaryAction = { label: "Mark Merge Done", kind: "good", run: () => { void onTransition(task.id, "MERGE_DONE"); } };
    } else if (task.status === "CLAIMED" && isAssignee && transitions.includes("COMPLETED")) {
      primaryAction = { label: "Complete", kind: "good", run: () => { void onTransition(task.id, "COMPLETED"); } };
    } else if (task.status === "MERGE_DONE" && isCreator) {
      primaryAction = { label: "Approve", kind: "good", run: () => { void onTransition(task.id, "MERGE_APPROVED"); } };
    } else if (task.status === "MERGE_APPROVED" && isAssignee) {
      primaryAction = { label: "Complete", kind: "good", run: () => { void onTransition(task.id, "COMPLETED"); } };
    } else if (task.status === "COMPLETED" && isCreator) {
      primaryAction = { label: "Archive", kind: "ghost", run: () => { void onTransition(task.id, "ARCHIVED"); } };
    }
    /* Re-open is intentionally NOT a quick-action — it lives in the
       expanded body. Closed mini rows show Archive (creator-only) or
       nothing; clicking the row expands to reveal Re-open. */
  }
  const quickActionClass = primaryAction
    ? `btn-sm task-card-quick-action${primaryAction.kind === "good" ? " btn-good" : primaryAction.kind === "ghost" ? " btn-ghost" : primaryAction.kind === "danger" ? " btn-danger" : ""}`
    : "";

  /* Expanded body, rendered below the collapsed row when open.
     Mirrors the design's accordion: a slim metadata strip up top, then a
     220px / 1fr split — Timeline + actions on the left, the conversation
     thread on the right. */
  const notesLabel = getNotesFieldLabel(task.taskType);
  const replyTarget = isCreator
    ? task.assignee ? firstName(task.assignee.displayName) : "the pool"
    : firstName(task.createdBy.displayName);
  const canPostNote =
    showActions &&
    !CLOSED_STATUSES.includes(task.status) &&
    canNoteTask;

  /* Fire a FRAUD move. Plain transition and release are one-tap; a note-required
     move (Send Outstanding Items / Send Back) posts the (optional) note as the
     transition's reviewNotes. With the structured checklist (#44) the note is
     optional context — a non-empty checklist is the payload — so the move sends
     even with an empty note as long as there are items. */
  const fraudHasChecklist = (task.checklist?.length ?? 0) > 0;
  const runFraudAction = (action: FraudCardAction): void => {
    acknowledgeUnread();
    if (action.kind === "release") {
      void onRelease(task.id);
    } else if (action.kind === "transition" && action.targetStatus) {
      void onTransition(task.id, action.targetStatus);
    }
  };
  const submitFraudNote = (target: TaskStatus): void => {
    const note = fraudNote.trim();
    // The server rejects an empty hand-back with no note AND no checklist; the
    // button mirrors that so the checklist path sends note-free.
    if (!note && !fraudHasChecklist) return;
    acknowledgeUnread();
    void onTransition(task.id, target, note || undefined);
    setFraudNote("");
    setOpenFraudNote(null);
  };

  const renderExpanded = () => (
    <div className="task-card-expanded">
      {/* Meta facts live in one slim strip up top — the columns below
          belong to the lifecycle (timeline) and the conversation. */}
      <div className="expand-strip">
        <span className="strip-item">
          <label>Assigner</label>
          <span className="v"><ExpandAvatar name={task.createdBy.displayName} />{task.createdBy.displayName}</span>
        </span>
        <span className="strip-item">
          <label>Assignee</label>
          <span className="v">
            {task.assignee ? (
              <><ExpandAvatar name={task.assignee.displayName} />{task.assignee.displayName}</>
            ) : (
              <span className="v-pending">Pending</span>
            )}
          </span>
        </span>
        <span className="strip-item">
          <label>Created</label>
          <span className="v">{formatDate(task.createdAt)}</span>
        </span>
        {task.taskType === "OOO" ? (
          <span className="strip-item">
            <label>Returns</label>
            <span className="v">{task.returnDate ? formatWallDate(task.returnDate) : formatPtDateOnly(task.dueAt)}</span>
          </span>
        ) : (
          <span className="strip-item">
            <label>Due</label>
            <span className={`v${overdue ? " v-due-late" : ""}`}>{formatDate(task.dueAt)}</span>
          </span>
        )}
      </div>

      {/* FRAUD structured outstanding-items checklist (#44) — the handoff
          surface, full-width above the timeline/thread split. Non-FRAUD tasks
          skip it entirely. */}
      {task.taskType === "FRAUD" && <FraudChecklist task={task} user={user} api={checklist} />}

      <div className="expand-cols">
        <div className="expand-meta">
          <Timeline task={task} />
          {showActions && cancelStage === "confirming" && (
            <div className="task-card-cancel-confirm" role="alertdialog" aria-label="Confirm cancel">
              <span>Cancel this task?</span>
              <button type="button" className="btn-sm btn-danger" onClick={() => { acknowledgeUnread(); setCancelStage("done"); void onTransition(task.id, "CANCELLED"); }}>
                Yes, cancel
              </button>
              <button type="button" className="btn-sm btn-ghost" onClick={() => setCancelStage("idle")}>
                Keep
              </button>
            </div>
          )}
          {showActions && cancelStage === "done" && (
            <div className="task-card-cancel-confirm task-card-cancel-done" role="status">Cancelled ✓</div>
          )}
          {showActions && cancelStage === "idle" && (
            <div className="task-card-actions expand-actions">
              {/* FRAUD two-phase forward moves (#39). The plain quick move also
                  rides the collapsed row; the note-required moves (Send
                  Outstanding Items / Send Back) reveal an inline note that posts
                  as the transition's reviewNotes, and Release hands the task to
                  the checker pool. Same set the bot DM cards render. */}
              {fraudActions.length > 0 && (
                <div className="task-card-fraud">
                  {fraudActions.map((action) => {
                    const noteRequired = action.kind === "transitionWithNote";
                    const noteOpen = noteRequired && openFraudNote === action.targetStatus;
                    return (
                      <div key={action.label} className="task-card-fraud-action">
                        <button
                          type="button"
                          className={`btn-sm ${action.kind === "release" ? "btn-ghost" : "btn-good"}`}
                          aria-expanded={noteRequired ? noteOpen : undefined}
                          onClick={() => {
                            if (noteRequired && action.targetStatus) {
                              setFraudNote("");
                              setOpenFraudNote(noteOpen ? null : action.targetStatus);
                            } else {
                              runFraudAction(action);
                            }
                          }}
                        >
                          {action.label}
                        </button>
                        {noteOpen && action.targetStatus && (
                          <div className="task-card-fraud-note">
                            <textarea
                              rows={2}
                              placeholder={fraudHasChecklist ? "Optional note for the thread…" : "Describe what's outstanding…"}
                              value={fraudNote}
                              onChange={(e) => setFraudNote(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitFraudNote(action.targetStatus!); } }}
                              autoFocus
                            />
                            <div className="task-card-fraud-note-actions">
                              <button type="button" className="btn-sm btn-good" onClick={() => submitFraudNote(action.targetStatus!)} disabled={!fraudNote.trim() && !fraudHasChecklist}>
                                Send
                              </button>
                              <button type="button" className="btn-sm btn-ghost" onClick={() => { setOpenFraudNote(null); setFraudNote(""); }}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {task.status === "OPEN" && isCreator && (
                <button type="button" className="btn-sm btn-danger" onClick={() => { acknowledgeUnread(); setCancelStage("confirming"); }}>
                  Cancel Task
                </button>
              )}
              {canUnclaim(task, user) && (
                <button type="button" className="btn-sm btn-ghost" onClick={() => { acknowledgeUnread(); onUnclaim(task.id); }}>
                  Unclaim
                </button>
              )}
              {task.status === "CLAIMED" && isCreator && !isAssignee && (
                <button type="button" className="btn-sm btn-danger" onClick={() => { acknowledgeUnread(); setCancelStage("confirming"); }}>
                  Cancel
                </button>
              )}
              {task.status === "MERGE_DONE" && isAssignee && (
                <button type="button" className="btn-sm btn-ghost" onClick={() => { acknowledgeUnread(); onTransition(task.id, "CLAIMED"); }}>
                  Undo Merge Done
                </button>
              )}
              {task.status === "MERGE_DONE" && (isCreator || isAssignee) && (
                <button type="button" className="btn-sm btn-danger" onClick={() => { acknowledgeUnread(); setCancelStage("confirming"); }}>
                  Cancel
                </button>
              )}
              {task.status === "MERGE_APPROVED" && (isCreator || isAssignee) && (
                <button type="button" className="btn-sm btn-danger" onClick={() => { acknowledgeUnread(); setCancelStage("confirming"); }}>
                  Cancel
                </button>
              )}
              {task.status === "COMPLETED" && isCreator && (
                <button type="button" className="btn-sm btn-ghost" onClick={() => { acknowledgeUnread(); onTransition(task.id, "ARCHIVED"); }}>
                  Archive
                </button>
              )}
              {(task.status === "COMPLETED" || task.status === "ARCHIVED") && (isCreator || isAssignee) && (
                <button type="button" className="btn-sm btn-ghost" onClick={() => { acknowledgeUnread(); onTransition(task.id, "OPEN"); }}>
                  Re-open
                </button>
              )}
              {/* Add a note to a COMPLETED task (#45): reveal an inline field
                  that posts to the completed-note endpoint (task stays
                  COMPLETED). Every task type; creator/assignee/admin. */}
              {task.status === "COMPLETED" && canNoteTask && (
                <button
                  type="button"
                  className="btn-sm btn-ghost"
                  aria-expanded={completedNoteOpen}
                  onClick={() => { acknowledgeUnread(); setCompletedNote(""); setCompletedNoteOpen((open) => !open); }}
                >
                  Add a note
                </button>
              )}
              {/* A reopened task remembers the closed status it came from.
                  "Restore" sends it straight back there (COMPLETED or ARCHIVED),
                  available to whoever reopened it — creator, assignee, or admin —
                  so a creator-only reopen doesn't need the assignee to close it
                  out. Gated by the shared canRestoreTask so UI and API agree. */}
              {restoreTarget && canRestoreTask(task, user) && (
                <button type="button" className="btn-sm btn-good" onClick={() => { acknowledgeUnread(); onTransition(task.id, restoreTarget); }}>
                  Restore
                </button>
              )}
              {/* Share (issues #41, #52, #58): icon trigger on the same row as
                  the other actions (e.g. Cancel) — DM a specific person a deep
                  link to this task, outside the normal creator/assignee flow.
                  Hidden when there's nobody else in the directory to point at. */}
              {shareCandidates.length > 0 && (
                <SharePopover
                  candidates={shareCandidates}
                  onShare={(targetUserId, note) => onShare(task.id, targetUserId, note)}
                  link={shareLink}
                />
              )}
              {/* Inline note field for the "Add a note" affordance (#45). Full
                  width below the action buttons; Enter (no shift) or Add posts,
                  Esc / Cancel dismisses. */}
              {task.status === "COMPLETED" && completedNoteOpen && (
                <div className="task-card-note-add">
                  <textarea
                    rows={2}
                    placeholder="Add a note to this completed task…"
                    value={completedNote}
                    onChange={(e) => setCompletedNote(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submitCompletedNote(); }
                      if (e.key === "Escape") { setCompletedNoteOpen(false); setCompletedNote(""); }
                    }}
                    autoFocus
                  />
                  <div className="task-card-note-add-actions">
                    <button type="button" className="btn-sm btn-good" onClick={() => void submitCompletedNote()} disabled={!completedNote.trim()}>
                      Add note
                    </button>
                    <button type="button" className="btn-sm btn-ghost" onClick={() => { setCompletedNoteOpen(false); setCompletedNote(""); }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="thread">
          <div className="thread-head">{notesLabel}</div>
          <div className="note-brief"><b>{task.createdBy.displayName}:</b> {task.notes}</div>
          {Array.isArray(task.reviewNotes) && task.reviewNotes.length > 0 && (
            <div className="msgs" ref={reviewListRef}>
              {task.reviewNotes.map((note, i) => (
                <div key={i} className={`msg${note.by.id === user.id ? " msg-mine" : ""}`}>
                  <ExpandAvatar name={note.by.displayName} />
                  <div>
                    <div className="msg-meta">
                      <span className="msg-author">{note.by.displayName}</span>
                      <span className="msg-time">{formatDate(note.at)}</span>
                    </div>
                    <div className="msg-text">{note.text}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {canPostNote && (
            <div className="composer">
              <textarea
                rows={1}
                placeholder={`Reply to ${replyTarget}…`}
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleSubmitNote(); } }}
              />
              <button type="button" className="btn-sm" onClick={() => void handleSubmitNote()} disabled={!noteText.trim()}>Send</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  /* Grouped-row people values: Owner = assignee (or "Unclaimed"), From =
     creator. Shown as avatar chip + first name. */
  const ownerName = task.assignee?.displayName;
  const due = groupedDue(task, now ?? Date.now());
  const groupedOverdue = due.overdue;

  return (
    <div className={cardClass} id={`task-${task.id}`}>
      <div
        className={`task-card-grouped${mini ? " task-card-grouped-mini" : ""}${groupedOverdue ? " task-card-grouped-overdue" : ""}`}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={handleHeaderClick}
        onKeyDown={handleHeaderKey}
        title={urgencyTitle}
      >
        <span className="task-card-grouped-stripe" aria-hidden="true" />
        <span className="task-card-grouped-people">
          <span className="task-card-grouped-person">
            <span className="task-card-grouped-role">Owner</span>
            {task.assignee ? (
              <>
                <span className="task-card-grouped-avatar" aria-hidden="true">{initialsOf(ownerName)}</span>
                <span className="task-card-grouped-name" title={ownerName}>{firstName(ownerName)}</span>
              </>
            ) : (
              <>
                <span className="task-card-grouped-avatar task-card-grouped-avatar-none" aria-hidden="true" />
                <span className="task-card-grouped-name task-card-grouped-name-none">Unclaimed</span>
              </>
            )}
          </span>
          <span className="task-card-grouped-person task-card-grouped-person-from">
            <span className="task-card-grouped-role">From</span>
            <span className="task-card-grouped-avatar" aria-hidden="true">{initialsOf(task.createdBy.displayName)}</span>
            <span className="task-card-grouped-name" title={task.createdBy.displayName}>{firstName(task.createdBy.displayName)}</span>
          </span>
        </span>
        <span className="task-card-collapsed-title">
          <span className={`task-card-collapsed-type task-type-${task.taskType.toLowerCase()}`}>
            {TASK_TYPE_LABELS[task.taskType]}
            {stageSuffix(task) && <span className="task-card-collapsed-stage">{stageSuffix(task)}</span>}
            {!mini && (
              <PoopDisplay
                count={task.points ?? 0}
                canEdit={isCreator && !isClosed}
                onChange={(n) => { void onUpdatePoints(task.id, n); }}
              />
            )}
            {hasUnreadNote && (
              <span className="task-card-unread-dot" aria-label="New note" title="New note" />
            )}
          </span>
          <span className="task-card-collapsed-folder">
            {task.taskType !== "OOO" && task.humperdinkLink ? (
              // The loan name opens the Humperdink link directly (#57); the
              // ↗ marks it as an external link.
              <a href={task.humperdinkLink} target="_blank" rel="noreferrer" aria-label={`Open Humperdink link for ${task.folderName}`} title="Open Humperdink link" onClick={stopBubble}>
                {task.folderName}
                <span className="external-link-icon" aria-hidden="true">↗</span>
              </a>
            ) : (
              // No stored link → the name is inert plain text (#57).
              <span>{task.folderName}</span>
            )}
            {task.taskType !== "OOO" && task.loanId && onFilterLoan && (
              <button
                type="button"
                className="loan-filter-btn"
                aria-label={`Filter list to loan: ${task.folderName}`}
                title={`Filter to loan: ${task.folderName}`}
                onClick={(e) => { stopBubble(e); onFilterLoan(task.loanId!); }}
              >
                <FilterIcon />
              </button>
            )}
          </span>
        </span>
        <span className={`task-card-grouped-due${groupedOverdue ? " task-card-grouped-due-overdue" : ""}${due.done ? " task-card-grouped-due-done" : ""}`} title={dueTitle}>
          {due.label && <span className="task-card-grouped-due-label">{due.label}</span>}
          <span className="task-card-grouped-due-value">{due.value}</span>
        </span>
        {!mini && primaryAction ? (
          <button
            type="button"
            className={quickActionClass}
            onClick={(e) => { e.stopPropagation(); acknowledgeUnread(); primaryAction!.run(); }}
          >
            {primaryAction.label}
          </button>
        ) : (
          <span className="task-card-quick-action-empty" aria-hidden="true" />
        )}
      </div>
      {expanded && renderExpanded()}
    </div>
  );
});
TaskCard.displayName = "TaskCard";

/* ── Card List ────────────────────────────────────────────── */
const CardList = ({
  tasks,
  user,
  onClaim,
  onUnclaim,
  onTransition,
  onRelease,
  onAddReviewNote,
  onAddCompletedNote,
  onUpdatePoints,
  onFilterLoan,
  onShare,
  checklist,
  directory,
  showActions,
  emptyMessage,
  seenNotesAt,
  onMarkNoteSeen,
  pulsingIds,
  expandOverrides,
  onSetExpand,
  now
}: {
  tasks: LoanTask[];
  user: UserIdentity;
  onClaim: (taskId: string) => Promise<void>;
  onUnclaim: (taskId: string) => Promise<void>;
  onTransition: (taskId: string, status: TaskStatus, reviewNotes?: string) => Promise<void>;
  onRelease: (taskId: string) => Promise<void>;
  onAddReviewNote: (taskId: string, text: string) => Promise<void>;
  onAddCompletedNote: (taskId: string, text: string) => Promise<void>;
  onUpdatePoints: (taskId: string, points: number) => Promise<void>;
  onFilterLoan?: (loanId: string) => void;
  onShare: (taskId: string, targetUserId: string, note?: string) => Promise<{ delivered: boolean }>;
  checklist: ChecklistApi;
  directory: Array<{ id: string; displayName: string }>;
  showActions: boolean;
  emptyMessage: string;
  seenNotesAt?: Record<string, string>;
  onMarkNoteSeen?: (taskId: string, at: string) => void;
  pulsingIds?: Set<string>;
  expandOverrides?: Record<string, boolean>;
  onSetExpand?: (taskId: string, open: boolean) => void;
  now?: number;
}) => (
  <div className="card-list card-list-grouped">
    {tasks.length === 0 ? (
      <div className="empty-card">{emptyMessage}</div>
    ) : (
      /* Only live-countdown (non-closed) rows take the ticking `now` (#73):
         `groupedDue` ignores it for COMPLETED / CANCELLED / ARCHIVED, so
         withholding it keeps those cards' props stable and lets TaskCard's memo
         skip them on a 30s tick. Active cards still re-render on a tick — their
         countdown is the input that changed. */
      tasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          user={user}
          onClaim={onClaim}
          onUnclaim={onUnclaim}
          onTransition={onTransition}
          onRelease={onRelease}
          onAddReviewNote={onAddReviewNote}
          onAddCompletedNote={onAddCompletedNote}
          onUpdatePoints={onUpdatePoints}
          {...(onFilterLoan ? { onFilterLoan } : {})}
          onShare={onShare}
          checklist={checklist}
          directory={directory}
          showActions={showActions}
          pulsing={pulsingIds?.has(task.id) ?? false}
          {...(now !== undefined && !CLOSED_STATUSES.includes(task.status) ? { now } : {})}
          {...(seenNotesAt?.[task.id] !== undefined ? { seenNoteAt: seenNotesAt[task.id] } : {})}
          {...(onMarkNoteSeen ? { onMarkNoteSeen } : {})}
          {...(expandOverrides?.[task.id] !== undefined ? { expandOverride: expandOverrides[task.id] } : {})}
          {...(onSetExpand ? { onSetExpand } : {})}
        />
      ))
    )}
  </div>
);

/* Editable header shown above the task list when it's filtered to a single
   Loan (ADR-0001). The app's only post-creation edit surface, scoped to the
   Loan's name + Humperdink link. Any authenticated user may edit. */
const LoanFilterHeader = ({
  loan,
  taskCount,
  onSave,
  onClear
}: {
  loan: Loan;
  taskCount: number;
  onSave: (loanId: string, name: string, humperdinkLink: string) => Promise<void>;
  onClear: () => void;
}) => {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(loan.name);
  const [link, setLink] = useState(loan.humperdinkLink ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    // Re-sync when the underlying loan changes (e.g. after a save/merge).
    setName(loan.name);
    setLink(loan.humperdinkLink ?? "");
    setEditing(false);
  }, [loan.id, loan.name, loan.humperdinkLink]);

  const save = async (): Promise<void> => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onSave(loan.id, name, link);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="loan-header">
      <div className="loan-header-main">
        <span className="loan-header-eyebrow">Loan</span>
        {editing ? (
          <div className="loan-header-edit">
            <input
              className="loan-header-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Loan name"
            />
            <input
              className="loan-header-link-input"
              value={link}
              placeholder="Humperdink link (optional)"
              onChange={(e) => setLink(e.target.value)}
              aria-label="Humperdink link"
            />
            <button type="button" className="btn-sm btn-good" disabled={saving} onClick={() => { void save(); }}>Save</button>
            <button type="button" className="btn-sm btn-ghost" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        ) : (
          <div className="loan-header-view">
            <h2 className="loan-header-name">{loan.name}</h2>
            {loan.humperdinkLink && (
              <a className="loan-header-link" href={loan.humperdinkLink} target="_blank" rel="noreferrer">
                Humperdink <span aria-hidden="true">↗</span>
              </a>
            )}
            <button type="button" className="btn-sm btn-ghost" onClick={() => setEditing(true)}>Edit</button>
          </div>
        )}
      </div>
      <div className="loan-header-meta">
        <span className="section-count">{taskCount} TASK{taskCount === 1 ? "" : "S"}</span>
        <button type="button" className="btn-sm btn-ghost" onClick={onClear}>Clear filter</button>
      </div>
    </div>
  );
};

/* ── Metrics Panel ────────────────────────────────────────── */
const TYPE_BAR_CLASS: Record<TaskType, string> = {
  LOI: "type-bar type-bar-brand",
  BUDDY_CHAT: "type-bar type-bar-brand",
  VALUE: "type-bar type-bar-good",
  FRAUD: "type-bar type-bar-bad",
  LOAN_DOCS: "type-bar type-bar-hot",
  OOO: "type-bar type-bar-brand"
};

const MetricsPanel = ({
  leaderboard,
  totals,
  typeBreakdown
}: {
  leaderboard: { id: string; displayName: string; count: number }[];
  totals: { total: number; active: number; completed: number; archived: number; cancelled: number };
  typeBreakdown: { type: TaskType; label: string; count: number; pct: number }[];
}) => {
  const maxClaims = leaderboard[0]?.count ?? 1;
  const maxTypeCount = Math.max(...typeBreakdown.map((t) => t.count), 1);

  return (
    <div className="metrics-panel">
      {/* Claims leaderboard */}
      <div className="metrics-section">
        <div className="metrics-section-title">Who Is Claiming Tasks</div>
        {leaderboard.length === 0 ? (
          <div className="empty-card">No tasks have been claimed yet.</div>
        ) : (
          leaderboard.map((entry, i) => (
            <div key={entry.id} className="leaderboard-row">
              <span className="leaderboard-rank">{i + 1}.</span>
              <span className="leaderboard-name">{entry.displayName}</span>
              <div className="leaderboard-bar-wrap">
                <div className="leaderboard-bar" style={{ width: `${(entry.count / maxClaims) * 100}%` }} />
              </div>
              <span className="leaderboard-count">{entry.count}</span>
            </div>
          ))
        )}
      </div>

      {/* Status totals */}
      <div className="metrics-section">
        <div className="metrics-section-title">Task Overview</div>
        <div className="metrics-stat-grid">
          <div className="stat-card stat-card-total">
            <div className="stat-number">{totals.total}</div>
            <div className="stat-label">Total</div>
          </div>
          <div className="stat-card stat-card-active">
            <div className="stat-number">{totals.active}</div>
            <div className="stat-label">Active</div>
          </div>
          <div className="stat-card stat-card-completed">
            <div className="stat-number">{totals.completed}</div>
            <div className="stat-label">Completed</div>
          </div>
          <div className="stat-card stat-card-archived">
            <div className="stat-number">{totals.archived}</div>
            <div className="stat-label">Archived</div>
          </div>
          <div className="stat-card stat-card-cancelled">
            <div className="stat-number">{totals.cancelled}</div>
            <div className="stat-label">Cancelled</div>
          </div>
        </div>
      </div>

      {/* LOI to Docs ratio */}
      {(() => {
        const loiCount = typeBreakdown.find((t) => t.type === "LOI")?.count ?? 0;
        const docsCount = typeBreakdown.find((t) => t.type === "LOAN_DOCS")?.count ?? 0;
        const ratio = loiCount > 0 ? ((docsCount / loiCount) * 100).toFixed(0) : "—";
        return (
          <div className="metrics-section">
            <div className="metrics-section-title">LOI to Docs Conversion</div>
            <div className="loi-docs-ratio">
              <div className="ratio-visual">
                <div className="ratio-segment ratio-segment-loi">
                  <div className="ratio-segment-count">{loiCount}</div>
                  <div className="ratio-segment-label">LOI Checks</div>
                </div>
                <div className="ratio-arrow">→</div>
                <div className="ratio-segment ratio-segment-docs">
                  <div className="ratio-segment-count">{docsCount}</div>
                  <div className="ratio-segment-label">Loan Docs</div>
                </div>
                <div className="ratio-result">
                  <div className="ratio-result-number">{ratio}{ratio !== "—" && "%"}</div>
                  <div className="ratio-result-label">Conversion</div>
                </div>
              </div>
              {loiCount > 0 && (
                <div className="ratio-bar-track">
                  <div className="ratio-bar-fill" style={{ width: `${Math.min((docsCount / loiCount) * 100, 100)}%` }} />
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Task type breakdown */}
      <div className="metrics-section">
        <div className="metrics-section-title">Task Type Breakdown</div>
        {typeBreakdown.map((entry) => (
          <div key={entry.type} className="type-row">
            <span className="type-label">{entry.label}</span>
            <div className="leaderboard-bar-wrap">
              <div className={TYPE_BAR_CLASS[entry.type]} style={{ width: `${(entry.count / maxTypeCount) * 100}%` }} />
            </div>
            <span className="type-count">{entry.count}</span>
            <span className="type-pct">{entry.pct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
};

/* ── Admin panel (Users & Roles) ──────────────────────────── */
interface AdminUser {
  id: string;
  email?: string;
  displayName: string;
  roles: UserRole[];
  active: boolean;
  createdAt: string;
  lastSeenAt: string;
}

const ADMIN_ROLE_DEFS: { key: UserRole; label: string; cls: string }[] = [
  { key: "LOAN_OFFICER", label: "Loan Officer", cls: "lo" },
  { key: "FILE_CHECKER", label: "File Checker", cls: "fc" },
  { key: "ADMIN", label: "Admin", cls: "admin" }
];

const formatAgo = (iso?: string): string => {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return "just now";
  const min = Math.round(diff / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(diff / 3600000);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(diff / 86400000);
  return `${day}d ago`;
};

interface SystemStatus {
  bot: { enabled: boolean; dmCount: number; channelCount: number };
  channelWebhook: boolean;
  activityFeed: boolean;
}

const botStatusView = (
  s: SystemStatus | null
): { label: string; cls: "ok" | "warn" | "off" } => {
  if (!s || !s.bot.enabled) return { label: "Not configured", cls: "off" };
  const reach = s.bot.dmCount + s.bot.channelCount;
  if (reach > 0) {
    return {
      label: `Connected · ${s.bot.dmCount} DM${s.bot.dmCount === 1 ? "" : "s"}, ${s.bot.channelCount} channel${s.bot.channelCount === 1 ? "" : "s"}`,
      cls: "ok"
    };
  }
  return { label: "Configured · no activity yet", cls: "warn" };
};

const AdminPanel = ({ user }: { user: UserIdentity }) => {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addEmail, setAddEmail] = useState("");
  const [addRoles, setAddRoles] = useState<UserRole[]>(["LOAN_OFFICER"]);
  const [adding, setAdding] = useState(false);
  const [channels, setChannels] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [channelBusy, setChannelBusy] = useState(false);

  const load = async (): Promise<void> => {
    try {
      const data = await apiRequest<{ users: AdminUser[] }>("/users", { method: "GET" }, user);
      setUsers(data.users);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load users");
    }
  };
  useEffect(() => {
    load().catch(() => {});
    apiRequest<SystemStatus>("/status", { method: "GET" }, user)
      .then(setStatus)
      .catch(() => setStatus(null));
    apiRequest<{ channels: Array<{ id: string; name: string }>; selected: string | null }>("/admin/channels", { method: "GET" }, user)
      .then((d) => { setChannels(d.channels); setSelectedChannel(d.selected); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeChannel = async (value: string): Promise<void> => {
    const channelId = value === "" ? null : value;
    setChannelBusy(true);
    try {
      const d = await apiRequest<{ selected: string | null }>("/admin/channels", { method: "PUT", body: JSON.stringify({ channelId }) }, user);
      setSelectedChannel(d.selected);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to set channel");
    } finally {
      setChannelBusy(false);
    }
  };

  const activeAdminCount = users.filter((u) => u.active && u.roles.includes("ADMIN")).length;

  const run = async (id: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusyId(id);
    try {
      await fn();
      await load();
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  };

  const toggleRole = (u: AdminUser, role: UserRole): void => {
    const has = u.roles.includes(role);
    const roles = has ? u.roles.filter((r) => r !== role) : [...u.roles, role];
    if (roles.length === 0) {
      setErr("A user needs at least one role.");
      return;
    }
    void run(u.id, () =>
      apiRequest(`/users/${u.id}/roles`, { method: "PUT", body: JSON.stringify({ roles }) }, user)
    );
  };

  const setActive = (u: AdminUser, active: boolean): void => {
    void run(u.id, () =>
      apiRequest(`/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ active }) }, user)
    );
  };

  const removeUser = (u: AdminUser): void => {
    if (!window.confirm(`Remove ${u.displayName}? This deletes their record and role assignments.`)) {
      return;
    }
    void run(u.id, () => apiRequest(`/users/${u.id}`, { method: "DELETE" }, user));
  };

  const submitAdd = async (): Promise<void> => {
    const email = addEmail.trim();
    if (!email) return;
    setAdding(true);
    try {
      await apiRequest("/users", { method: "POST", body: JSON.stringify({ email, roles: addRoles }) }, user);
      setAddEmail("");
      setAddRoles(["LOAN_OFFICER"]);
      setAddOpen(false);
      await load();
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to add user");
    } finally {
      setAdding(false);
    }
  };

  const toggleAddRole = (role: UserRole): void => {
    setAddRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));
  };

  return (
    <div className="admin-panel">
      <div className="section-head">
        <h2>
          Users &amp; Roles
          <span className="section-count">
            {users.length} USERS · {activeAdminCount} ADMIN
          </span>
        </h2>
        <button type="button" className="btn-sm" onClick={() => setAddOpen((o) => !o)}>
          {addOpen ? "Cancel" : "+ Add User"}
        </button>
      </div>

      <div className="admin-status-bar">
        {(() => {
          const b = botStatusView(status);
          return (
            <span className={`admin-stat admin-stat-${b.cls}`} title="Teams bot connectivity">
              <span className="admin-stat-label">Bot</span>
              {b.label}
            </span>
          );
        })()}
        <span className={`admin-stat admin-stat-${status?.channelWebhook ? "ok" : "off"}`} title="Legacy incoming-webhook posts (separate from the bot). Bot channel posts use the Notification Channel below, not this.">
          <span className="admin-stat-label">Legacy webhook</span>
          {status?.channelWebhook ? "On" : "Off"}
        </span>
        <span className={`admin-stat admin-stat-${status?.activityFeed ? "ok" : "off"}`} title="Teams activity-feed notifications">
          <span className="admin-stat-label">Activity feed</span>
          {status?.activityFeed ? "On" : "Off"}
        </span>
      </div>

      {err && <p className="error-bar">{err}</p>}

      {addOpen && (
        <div className="admin-add-row">
          <input
            type="email"
            placeholder="name@loneoakfund.com"
            value={addEmail}
            onChange={(e) => setAddEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void submitAdd(); }}
            autoFocus
          />
          <div className="admin-roles-cell">
            {ADMIN_ROLE_DEFS.map((r) => (
              <button
                key={r.key}
                type="button"
                className={`admin-role ${r.cls}${addRoles.includes(r.key) ? " on" : ""}`}
                onClick={() => toggleAddRole(r.key)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button type="button" className="btn-sm btn-good" disabled={adding || !addEmail.trim()} onClick={() => void submitAdd()}>
            {adding ? "Adding…" : "Add"}
          </button>
        </div>
      )}

      <table className="admin-table">
        <thead>
          <tr>
            <th>User</th>
            <th>Roles · click to toggle</th>
            <th>Status</th>
            <th>Last seen</th>
            <th className="admin-manage-col">Manage</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const isSelf = u.id === user.id;
            const rowClass = !u.active ? "admin-row-off" : "";
            return (
              <tr key={u.id} className={rowClass} aria-busy={busyId === u.id}>
                <td>
                  <div className="admin-uname">
                    {u.displayName}
                    {isSelf && <span className="admin-you">YOU</span>}
                  </div>
                  <div className="admin-umail">{u.email ?? u.id}</div>
                </td>
                <td>
                  <div className="admin-roles-cell">
                    {ADMIN_ROLE_DEFS.map((r) => (
                      <button
                        key={r.key}
                        type="button"
                        className={`admin-role ${r.cls}${u.roles.includes(r.key) ? " on" : ""}`}
                        disabled={busyId === u.id}
                        onClick={() => toggleRole(u, r.key)}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                </td>
                <td>
                  <span className={`admin-status ${u.active ? "active" : "deact"}`}>
                    {u.active ? "Active" : "Deactivated"}
                  </span>
                </td>
                <td>
                  <span className="admin-seen" title={u.lastSeenAt ? formatDate(u.lastSeenAt) : undefined}>
                    {formatAgo(u.lastSeenAt)}
                  </span>
                </td>
                <td>
                  <div className="admin-actions">
                    {u.active ? (
                      <button
                        type="button"
                        className="admin-link warn"
                        disabled={busyId === u.id || isSelf}
                        onClick={() => setActive(u, false)}
                      >
                        Deactivate
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="admin-link good"
                        disabled={busyId === u.id}
                        onClick={() => setActive(u, true)}
                      >
                        Reactivate
                      </button>
                    )}
                    <button
                      type="button"
                      className="admin-link bad"
                      disabled={busyId === u.id || isSelf}
                      onClick={() => removeUser(u)}
                    >
                      Remove
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
          {users.length === 0 && (
            <tr>
              <td colSpan={5} className="admin-empty">No users yet.</td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="admin-hint">
        New people auto-create as Loan Officer on first login. The last active admin
        can&rsquo;t be removed or demoted.
      </p>

      <div className="section-head">
        <h2>
          Notification Channel
          <span className="section-count">{channels.length} CHANNEL{channels.length === 1 ? "" : "S"}</span>
        </h2>
      </div>
      {channels.length === 0 ? (
        <p className="admin-hint">
          No channels yet — add the bot to a Teams channel and post once so it shows up here.
          Until one is chosen, group notifications go to every channel the bot is in.
        </p>
      ) : (
        <div className="admin-channel-row">
          <label>
            Group notifications go to
            <select
              value={selectedChannel ?? ""}
              disabled={channelBusy}
              onChange={(e) => void changeChannel(e.target.value)}
            >
              <option value="">All channels</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
};

/* ── Create-task form ─────────────────────────────────────────
   Extracted from App (issue #72) so that typing in any field only
   re-renders this subtree — App (and the whole task list it renders) no
   longer re-renders on every keystroke. All form-input state lives here;
   App keeps only `formOpen` and mounts this child while it's true. The two
   side-effects the form triggers (persist + post-create share) stay on App
   behind the single stable `onCreate` callback so this component stays
   presentational — it builds the payload and closes on success. */
interface CreateTaskFormProps {
  loans: Loan[];
  directory: Array<{ id: string; displayName: string }>;
  user: UserIdentity;
  tasks: LoanTask[];
  onClose: () => void;
  /* Persist the task, then fire the optional post-create share (#46) with its
     delivered/couldn't-reach toast, and refresh. Resolves once the task is
     created; rejects only when the create itself fails (App has already shown
     the error toast) so the form stays open for a retry. */
  onCreate: (payload: CreateTaskInput, shareWithUserId: string) => Promise<void>;
}

const CreateTaskForm = ({ loans, directory, user, tasks, onClose, onCreate }: CreateTaskFormProps) => {
  const { showToast } = useToast();
  const [form, setForm] = useState({
    folderName: "",
    loanId: "",
    taskType: "LOI" as TaskType,
    urgency: "GREEN" as UrgencyLevel,
    startDate: "",
    returnDate: "",
    notes: "",
    humperdinkLink: "",
    points: 0,
    // FRAUD only (#69): outstanding items the creator seeds at creation. Enter-
    // to-add list of item texts; mapped to the `initialItems` payload and
    // persisted as creator-added draft checklist items server-side.
    initialItems: [] as string[],
    // "Make sure X sees this" at creation (issue #46): optional target who gets
    // the same share DM #41 sends, fired right after the task is persisted.
    shareWithUserId: ""
  });
  /* Draft text for the FRAUD outstanding-items seeder input (#69), separate
     from the committed `form.initialItems` list. */
  const [seedDraft, setSeedDraft] = useState("");
  /* Create-form loan typeahead: which suggestion list is open + which loan
     (if any) the typed Folder Name resolved to. */
  const [loanSuggestOpen, setLoanSuggestOpen] = useState(false);
  /* The text the user actually typed into Folder Name (issue #55). Kept
     separate from `form.folderName` so keyboard arrow-autofill can preview a
     highlighted loan's name in the field without reshuffling the match list. */
  const [loanQuery, setLoanQuery] = useState("");
  /* Highlighted suggestion index for keyboard nav, or -1 for none (#55). */
  const [loanHighlight, setLoanHighlight] = useState(-1);
  const [namvarHover, setNamvarHover] = useState<number | null>(null);

  /* Loans that are "mine" for the create-form shortlist (#55): any loan linked
     by a task the current user created (merged loans share one id, so they
     count automatically). Drives the empty-query, open-on-focus view. Kept
     local so it only recomputes on this form's renders, not App's. */
  const myLoanIds = useMemo(() => deriveMyLoanIds(tasks, user.id), [tasks, user.id]);

  /* Current typeahead suggestions: empty query → my most-recently-used loans;
     typing → all users' loans ranked by match (#55). Excludes an option that
     exactly equals what's already typed. */
  const loanMatches = useMemo(
    () =>
      loanTypeaheadSuggestions(loanQuery, loans, myLoanIds, 6).filter(
        (m) => m.loan.name.trim().toLowerCase() !== loanQuery.trim().toLowerCase()
      ),
    [loanQuery, loans, myLoanIds]
  );

  /* Commit a loan pick from the typeahead (mouse click or keyboard Enter):
     link the task to the existing loan and confirm with a transient toast
     (#56) instead of an inline hint that reflowed the form. */
  const selectLoan = (loan: Loan): void => {
    setForm((c) => ({
      ...c,
      folderName: loan.name,
      loanId: loan.id,
      humperdinkLink: loan.humperdinkLink ?? c.humperdinkLink
    }));
    setLoanQuery(loan.name);
    setLoanSuggestOpen(false);
    setLoanHighlight(-1);
    showToast("Linked to an existing loan", { variant: "success" });
  };

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const rawLink = form.humperdinkLink.trim();
    const normalizedLink = rawLink && !/^https?:\/\//i.test(rawLink) ? `https://${rawLink}` : rawLink;
    // Only pass loanId when the typed name still matches the selected loan —
    // editing the text after selecting means the user intends a new loan.
    const selectedLoan = form.loanId ? loans.find((l) => l.id === form.loanId) : undefined;
    const keepLoanId = form.taskType !== "OOO" && selectedLoan && selectedLoan.name === form.folderName.trim();
    // FRAUD only (#69): fold any not-yet-added seeder draft into the list, then
    // ship the outstanding items the creator already knows about.
    const seededItems =
      form.taskType === "FRAUD"
        ? [...form.initialItems, seedDraft.trim()].map((t) => t.trim()).filter((t) => t.length > 0)
        : [];
    const payload: CreateTaskInput = {
      folderName: form.folderName,
      taskType: form.taskType,
      notes: form.notes,
      ...(keepLoanId ? { loanId: form.loanId } : {}),
      ...(form.taskType === "OOO" ? { startDate: form.startDate, returnDate: form.returnDate } : { urgency: form.urgency }),
      ...(form.taskType !== "OOO" && normalizedLink ? { humperdinkLink: normalizedLink } : {}),
      ...(form.points > 0 ? { points: form.points } : {}),
      ...(seededItems.length > 0 ? { initialItems: seededItems.map((text) => ({ text })) } : {})
    };

    try {
      // App owns persist + post-create share + refresh; on success we close,
      // which unmounts this child and discards the draft state. A create
      // failure rejects here (App already toasted) — keep the form open.
      await onCreate(payload, form.shareWithUserId);
      onClose();
    } catch {
      /* create failed — App surfaced the error; leave the form open to retry */
    }
  };

  return (
    <div
      className="form-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="New task"
      onClick={onClose}
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
    >
      <div className="form-panel" onClick={(e) => e.stopPropagation()}>
      <form className="task-form" onSubmit={handleSubmit}>
        <label>
          {form.taskType === "OOO" ? "Vacation Description" : "Folder Name"}
          {form.taskType === "OOO" ? (
            <input value={form.folderName} onChange={(e) => setForm((c) => ({ ...c, folderName: e.target.value }))} required />
          ) : (
            <span className="loan-typeahead">
              <input
                value={form.folderName}
                autoComplete="off"
                placeholder="Search existing loans or type a new name"
                role="combobox"
                aria-expanded={loanSuggestOpen && loanMatches.length > 0}
                aria-autocomplete="list"
                aria-activedescendant={loanHighlight >= 0 ? `loan-opt-${loanHighlight}` : undefined}
                onChange={(e) => {
                  const v = e.target.value;
                  // Typing diverges from any prior selection → treat as a new
                  // loan, and re-scope the match list to the typed query.
                  setForm((c) => ({ ...c, folderName: v, loanId: "" }));
                  setLoanQuery(v);
                  setLoanSuggestOpen(true);
                  setLoanHighlight(-1);
                }}
                onFocus={() => { setLoanQuery(form.folderName); setLoanSuggestOpen(true); setLoanHighlight(-1); }}
                onBlur={() => { window.setTimeout(() => setLoanSuggestOpen(false), 120); }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    if (loanMatches.length === 0) return;
                    e.preventDefault();
                    if (!loanSuggestOpen) setLoanSuggestOpen(true);
                    const next = nextHighlightIndex(loanHighlight, e.key === "ArrowDown" ? 1 : -1, loanMatches.length);
                    setLoanHighlight(next);
                    // Autofill the field with the highlighted loan's name;
                    // selection (link + toast) waits for Enter.
                    const preview = loanMatches[next];
                    if (preview) setForm((c) => ({ ...c, folderName: preview.loan.name, loanId: "" }));
                  } else if (e.key === "Enter" && loanSuggestOpen && loanHighlight >= 0 && loanMatches[loanHighlight]) {
                    e.preventDefault();
                    selectLoan(loanMatches[loanHighlight]!.loan);
                  } else if (e.key === "Escape" && loanSuggestOpen) {
                    e.preventDefault();
                    e.stopPropagation();
                    setLoanSuggestOpen(false);
                    setLoanHighlight(-1);
                  }
                }}
                required
              />
              {loanSuggestOpen && loanMatches.length > 0 && (
                <ul className="loan-typeahead-list" role="listbox">
                  {loanMatches.map((m, i) => (
                    <li key={m.loan.id}>
                      <button
                        type="button"
                        id={`loan-opt-${i}`}
                        role="option"
                        aria-selected={i === loanHighlight}
                        className={`loan-typeahead-option${i === loanHighlight ? " loan-typeahead-option-active" : ""}`}
                        onMouseEnter={() => setLoanHighlight(i)}
                        // onMouseDown fires before the input's onBlur so the pick registers.
                        onMouseDown={(e) => { e.preventDefault(); selectLoan(m.loan); }}
                      >
                        <span className="loan-typeahead-name">{m.loan.name}</span>
                        {m.loan.humperdinkLink && <span className="loan-typeahead-link" aria-hidden="true">↗</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </span>
          )}
        </label>
        <label>
          Type
          <select value={form.taskType} onChange={(e) => setForm((c) => ({ ...c, taskType: e.target.value as TaskType }))}>
            <option value="LOI">LOI Check</option>
            <option value="BUDDY_CHAT">Buddy Chat</option>
            <option value="VALUE">Value Check</option>
            <option value="FRAUD">Fraud Check</option>
            <option value="LOAN_DOCS">Loan Docs</option>
            <option value="OOO">OOO - Out of Office</option>
          </select>
        </label>
        {form.taskType === "OOO" ? (
          <>
            <label>
              Start Date
              <input
                type="date"
                value={form.startDate}
                onChange={(e) => setForm((c) => ({ ...c, startDate: e.target.value }))}
                required
              />
            </label>
            <label>
              Return Date
              <input
                type="date"
                value={form.returnDate}
                min={form.startDate || undefined}
                onChange={(e) => setForm((c) => ({ ...c, returnDate: e.target.value }))}
                required
              />
            </label>
          </>
        ) : (
          <label>
            Urgency
            <select value={form.urgency} onChange={(e) => setForm((c) => ({ ...c, urgency: e.target.value as UrgencyLevel }))}>
              <option value="GREEN">Within 24 Hours</option>
              <option value="YELLOW">End of Day</option>
              <option value="ORANGE">Within 1 Hour</option>
              <option value="RED">Urgent Now</option>
            </select>
          </label>
        )}
        <label>
          How Bad?
          <span
            className="poop-picker poop-picker-form"
            onMouseLeave={() => setNamvarHover(null)}
          >
            {[1, 2, 3, 4, 5].map((n) => {
              const active = n <= (namvarHover ?? form.points);
              return (
                <button
                  key={n}
                  type="button"
                  className={`poop-pick${active ? " poop-pick-on" : ""}`}
                  onMouseEnter={() => setNamvarHover(n)}
                  onClick={() => setForm((c) => ({ ...c, points: c.points === n ? 0 : n }))}
                  aria-label={`${n} poop${n === 1 ? "" : "s"}`}
                  aria-pressed={n <= form.points}
                >
                  💩
                </button>
              );
            })}
          </span>
        </label>
        <label className="span-full">
          {/* FRAUD's free-text field is now a general discussion seed, so it
              gets a purpose-built "Notes" label (#69); the shared
              NOTES_FIELD_LABELS.FRAUD ("Discussion") heads the card thread. */}
          {form.taskType === "FRAUD" ? "Notes" : getNotesFieldLabel(form.taskType)}
          <textarea rows={2} value={form.notes} onChange={(e) => setForm((c) => ({ ...c, notes: e.target.value }))} required />
        </label>
        {/* FRAUD only (#69): seed the outstanding-items checklist with items
            the creator already knows about. Enter-to-add, mirrors the card's
            FraudChecklist add idiom. Optional — the checker seeds later. */}
        {form.taskType === "FRAUD" && (
          <div className="span-full task-form-seed">
            <span className="task-form-seed-head">Outstanding Items <span className="form-label-optional">- Optional</span></span>
            {form.initialItems.length > 0 && (
              <ul className="task-form-seed-list">
                {form.initialItems.map((text, idx) => (
                  <li key={idx} className="task-form-seed-item">
                    <span className="task-form-seed-text">{text}</span>
                    <button
                      type="button"
                      className="checklist-delete"
                      aria-label={`Remove "${text}"`}
                      onClick={() => setForm((c) => ({ ...c, initialItems: c.initialItems.filter((_, i) => i !== idx) }))}
                    >
                      <TrashIcon />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="checklist-add">
              <input
                className="checklist-item-input"
                placeholder="Add an item, press Enter…"
                value={seedDraft}
                onChange={(e) => setSeedDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const v = seedDraft.trim();
                    if (!v) return;
                    setForm((c) => ({ ...c, initialItems: [...c.initialItems, v] }));
                    setSeedDraft("");
                  }
                }}
              />
              <button
                type="button"
                className="btn-sm"
                disabled={!seedDraft.trim()}
                onClick={() => {
                  const v = seedDraft.trim();
                  if (!v) return;
                  setForm((c) => ({ ...c, initialItems: [...c.initialItems, v] }));
                  setSeedDraft("");
                }}
              >
                Add
              </button>
            </div>
          </div>
        )}
        {form.taskType !== "OOO" && (
          <label className="span-full">
            Humperdink Link
            <input
              type="text"
              inputMode="url"
              placeholder="Optional"
              value={form.humperdinkLink}
              onChange={(e) => setForm((c) => ({ ...c, humperdinkLink: e.target.value }))}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && !/^https?:\/\//i.test(v)) {
                  setForm((c) => ({ ...c, humperdinkLink: `https://${v}` }));
                }
              }}
            />
          </label>
        )}
        {/* "Make sure someone sees this" (issue #46): optional at-creation
            share. Reuses #41's people directory + share endpoint; excludes
            the creator. Hidden when nobody else is in the directory. */}
        {directory.some((u) => u.id !== user.id) && (
          <label className="span-full">
            <span>Share Directly <span className="form-label-optional">- Optional</span></span>
            <select
              value={form.shareWithUserId}
              onChange={(e) => setForm((c) => ({ ...c, shareWithUserId: e.target.value }))}
            >
              <option value="">No one — just create it</option>
              {directory
                .filter((u) => u.id !== user.id)
                .map((u) => (
                  <option key={u.id} value={u.id}>{u.displayName}</option>
                ))}
            </select>
          </label>
        )}
        <div className="form-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit">Create Task</button>
        </div>
      </form>
      </div>
    </div>
  );
};

/* ── Main app ─────────────────────────────────────────────── */
export const App = () => {
  const [user, setUser] = useState<UserIdentity>(INITIAL_USER);
  const [tasks, setTasks] = useState<LoanTask[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  /* When set, the task list is filtered to a single Loan and shows its
     editable header (ADR-0001: click a loan name to filter + edit). */
  const [loanFilterId, setLoanFilterId] = useState<string | null>(null);
  /* Selectable people for the share picker (issue #41). Active users, id + name. */
  const [directory, setDirectory] = useState<Array<{ id: string; displayName: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  /* Whether the New Task form is open. Only App state the create form needs —
     it flips on open/close, never per keystroke, so the whole form-input state
     lives in <CreateTaskForm> (issue #72) and App no longer re-renders (and
     re-renders the task list) as the user types. */
  const [formOpen, setFormOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"active" | "all" | "metrics" | "admin">("active");

  /* Grouped ("courts") view toggle — buckets tasks by whose court the ball is
     in instead of one flat list. App-wide viewing preference, persisted so it
     survives reloads. Defaults on. */
  const GROUPED_KEY = "loan-tasks:grouped";
  const [grouped, setGrouped] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(GROUPED_KEY) !== "false";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(GROUPED_KEY, grouped ? "true" : "false");
    } catch {
      /* storage unavailable — degrade silently */
    }
  }, [grouped]);

  /* Ticking clock for the live countdowns. Both views (flat and courts) use the
     same compact row, so this runs always. 30s cadence matches the granularity
     of the "Xh Ym" / "Nm" labels. */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(id);
  }, []);

  /* Per-user "I've seen the latest note from someone else" map, keyed by
     task id → ISO timestamp of the latest non-self note already viewed.
     Persisted in localStorage so it survives reloads. */
  const seenNotesKey = `loan-tasks:seen-notes:${user.id}`;
  const loadSeenNotes = (uid: string): Record<string, string> => {
    try {
      const raw = window.localStorage.getItem(`loan-tasks:seen-notes:${uid}`);
      return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    } catch {
      return {};
    }
  };
  const [seenNotesAt, setSeenNotesAt] = useState<Record<string, string>>(() => loadSeenNotes(user.id));
  /* Per-user manual accordion overrides: task id → true (forced open) /
     false (forced closed). undefined = follow the default-open rule. Persisted
     so a manual collapse/expand survives Teams tab reloads. */
  const expandKey = `loan-tasks:expand:${user.id}`;
  const loadExpand = (uid: string): Record<string, boolean> => {
    try {
      const raw = window.localStorage.getItem(`loan-tasks:expand:${uid}`);
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  };
  const [expandOverrides, setExpandOverrides] = useState<Record<string, boolean>>(() => loadExpand(user.id));
  /* Task to focus from a Teams deep link (bot card "Open in Hot Task" carries
     the task id as subEntityId). Held until the task is present in `tasks`,
     then expanded + scrolled into view by the effect below. */
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null);
  /* When the active user changes (mock user picker), reset the in-memory
     maps to that user's stored data BEFORE the writer effects run — so we
     don't clobber B's localStorage with A's state. setState during render is
     the React-supported way to derive state from a changing prop. */
  const [trackedUserId, setTrackedUserId] = useState(user.id);
  if (trackedUserId !== user.id) {
    setTrackedUserId(user.id);
    setSeenNotesAt(loadSeenNotes(user.id));
    setExpandOverrides(loadExpand(user.id));
  }
  useEffect(() => {
    try {
      window.localStorage.setItem(seenNotesKey, JSON.stringify(seenNotesAt));
    } catch {
      /* storage unavailable — degrade silently */
    }
  }, [seenNotesAt, seenNotesKey]);
  const markNoteSeen = useCallback((taskId: string, at: string): void => {
    setSeenNotesAt((prev) => {
      const cur = prev[taskId];
      if (cur && cur >= at) return prev;
      return { ...prev, [taskId]: at };
    });
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(expandKey, JSON.stringify(expandOverrides));
    } catch {
      /* storage unavailable — degrade silently */
    }
  }, [expandOverrides, expandKey]);
  const setExpandOverride = useCallback((taskId: string, open: boolean): void => {
    setExpandOverrides((prev) => ({ ...prev, [taskId]: open }));
  }, []);
  /* Deep-link focus: once the linked task has loaded, jump to the main list,
     expand it, and scroll it into view. Waits for the task to be present so a
     cold open (tasks fetched after Teams init) still lands correctly. The rAF
     defers the scroll until the expanded card has rendered. */
  useEffect(() => {
    if (!focusTaskId || !tasks.some((t) => t.id === focusTaskId)) {
      return;
    }
    const target = focusTaskId;
    setActiveTab("active");
    setExpandOverride(target, true);
    const raf = requestAnimationFrame(() => {
      document.getElementById(`task-${target}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    setFocusTaskId(null);
    return () => cancelAnimationFrame(raf);
  }, [focusTaskId, tasks]);
  /* Clear a manual override when the task's status changes or a fresh note
     from the other party arrives, so the default-open rule re-applies (a
     status move or new message is a strong enough signal to re-evaluate). */
  const expandSnapshotRef = useRef<Map<string, { status: TaskStatus; note: string }>>(new Map());
  useEffect(() => {
    const prevSnap = expandSnapshotRef.current;
    const nextSnap = new Map<string, { status: TaskStatus; note: string }>();
    const clear: string[] = [];
    for (const t of tasks) {
      let latestOther = "";
      for (const n of t.reviewNotes ?? []) {
        if (n.by.id !== user.id && n.at > latestOther) latestOther = n.at;
      }
      nextSnap.set(t.id, { status: t.status, note: latestOther });
      const before = prevSnap.get(t.id);
      if (before && (before.status !== t.status || latestOther > before.note)) {
        clear.push(t.id);
      }
    }
    expandSnapshotRef.current = nextSnap;
    if (clear.length === 0) return;
    setExpandOverrides((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of clear) {
        if (id in next) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [tasks, user.id]);
  /* Reset the status/note snapshot on user switch so a fresh viewer's first
     render doesn't read the previous viewer's note-visibility state. */
  useEffect(() => {
    expandSnapshotRef.current = new Map();
  }, [user.id]);

  /* "Celebrating" — a task the current viewer created that just hit a
     completion milestone (COMPLETED, or LOAN_DOCS MERGE_DONE). The task
     pins to a celebrating bucket at the top of the grid while the
     status holds, and pulses green briefly when the transition lands.
     Pulse only fires for transitions observed during this session —
     never on initial page load. */
  const isCelebratingStatus = (t: LoanTask): boolean =>
    t.status === "COMPLETED" || (t.taskType === "LOAN_DOCS" && t.status === "MERGE_DONE");
  const [pulsingIds, setPulsingIds] = useState<Set<string>>(() => new Set());
  const prevStatusesRef = useRef<Map<string, TaskStatus>>(new Map());
  useEffect(() => {
    const next = new Map<string, TaskStatus>();
    const newlyPulsing: string[] = [];
    for (const t of tasks) {
      next.set(t.id, t.status);
      if (t.createdBy.id !== user.id) continue;
      if (!isCelebratingStatus(t)) continue;
      const prev = prevStatusesRef.current.get(t.id);
      if (prev !== undefined && prev !== t.status) {
        newlyPulsing.push(t.id);
      }
    }
    prevStatusesRef.current = next;
    if (newlyPulsing.length === 0) return;
    setPulsingIds((p) => {
      const merged = new Set(p);
      for (const id of newlyPulsing) merged.add(id);
      return merged;
    });
    const timer = setTimeout(() => {
      setPulsingIds((p) => {
        const merged = new Set(p);
        for (const id of newlyPulsing) merged.delete(id);
        return merged;
      });
    }, 3500);
    return () => clearTimeout(timer);
  }, [tasks, user.id]);
  /* Reset pulse + status snapshot on mock-user switch so a fresh viewer
     doesn't inherit the previous user's pulse state or transitions. */
  useEffect(() => {
    prevStatusesRef.current = new Map();
    setPulsingIds(new Set());
  }, [user.id]);

  const { showToast } = useToast();

  const isAdmin = user.roles.includes("ADMIN");

  useEffect(() => {
    if (!isAdmin && (activeTab === "metrics" || activeTab === "all" || activeTab === "admin")) {
      setActiveTab("active");
    }
  }, [isAdmin, activeTab]);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const data = await apiRequest<{ tasks: LoanTask[] }>("/tasks", { method: "GET" }, user);
      setTasks(data.tasks);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tasks");
    }
  }, [user]);

  const loadLoans = useCallback(async (): Promise<void> => {
    try {
      const data = await apiRequest<{ loans: Loan[] }>("/loans", { method: "GET" }, user);
      setLoans(data.loans);
    } catch {
      /* Loan typeahead is a convenience — a failed load just means no
         suggestions, so swallow rather than blocking the task view. */
    }
  }, [user]);

  useEffect(() => {
    teamsApp
      .initialize()
      .then(async () => {
        const context = (await teamsApp.getContext()) as {
          app?: { theme?: string };
          theme?: string;
          page?: { subPageId?: string };
          subEntityId?: string;
        };
        applyTheme(context.app?.theme ?? context.theme);
        teamsApp.registerOnThemeChangeHandler?.((theme) => applyTheme(theme));

        /* Deep link from a bot card → focus that task once it loads.
           teams-js v2 surfaces the link's subEntityId as page.subPageId. */
        const deepLinkTaskId = context.page?.subPageId ?? context.subEntityId;
        if (deepLinkTaskId) {
          setFocusTaskId(deepLinkTaskId);
        }

        /* Teams host present → resolve the real identity via SSO. */
        const token = await authentication.getAuthToken();
        setAuthToken(token);
        const me = await apiRequest<UserIdentity>("/me", { method: "GET" }, INITIAL_USER);
        setUser(me);
      })
      .catch(() => {
        /* Plain browser (no Teams host) or SSO failure. In dev, keep the
           mock user + selector. In prod surface that sign-in is required. */
        applyTheme("light");
        if (!IS_DEV) {
          setError("Unable to sign in. Open this app from Microsoft Teams.");
        }
      });
  }, []);

  useEffect(() => {
    /* In prod, hold the first fetch until SSO resolves a real identity.
       The placeholder user has an empty id (and dev-header auth would send a
       non-ASCII display name), so fetching now both 401s and risks a header
       encoding error. Dev always has a real mock id, so it runs immediately. */
    if (!IS_DEV && !user.id) return;
    refresh().catch(() => {});
    loadLoans().catch(() => {});
  }, [user.id]);

  useEffect(() => {
    /* Load the people directory for the share picker (issue #41). Same
       gate as the task fetch: hold until a real identity resolves in prod. */
    if (!IS_DEV && !user.id) return;
    apiRequest<{ users: Array<{ id: string; displayName: string }> }>("/users/directory", { method: "GET" }, user)
      .then((data) => setDirectory(data.users))
      .catch(() => {});
  }, [user.id]);

  useEffect(() => {
    const source = new EventSource(`${API_BASE}/stream`);
    source.addEventListener("task.changed", (event) => {
      const incoming = JSON.parse((event as MessageEvent<string>).data) as LoanTask;
      setTasks((current) => {
        const idx = current.findIndex((t) => t.id === incoming.id);
        if (idx === -1) return [incoming, ...current];
        const copy = [...current];
        copy[idx] = incoming;
        return copy.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      });
    });
    return () => source.close();
  }, []);

  /* Create-form submit seam (issue #72). <CreateTaskForm> owns the form state
     and builds the payload; App keeps the two side-effects — persistence and
     the post-create share — so the child stays presentational. Resolves once
     the task is persisted (the child then closes itself); rejects only when the
     create itself fails, after surfacing the error, so the form stays open. */
  const onCreate = async (payload: CreateTaskInput, shareWithUserId: string): Promise<void> => {
    let created: { task: LoanTask };
    try {
      created = await apiRequest<{ task: LoanTask }>("/tasks", { method: "POST", body: JSON.stringify(payload) }, user);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to create task", { variant: "error" });
      throw err;
    }
    setError(null);
    // "Make sure X sees this" (issue #46): the share has to fire AFTER the task
    // is persisted, so it's a follow-up call to #41's endpoint using the new
    // task id — deliberately decoupled so a failed/undelivered share never
    // blocks task creation. `delivered` tells us if the DM actually landed.
    // The outcome surfaces as a shared toast. A share failure here does not
    // reject — the task was created, so the form still closes.
    if (shareWithUserId) {
      const target = directory.find((u) => u.id === shareWithUserId);
      const targetName = target ? firstName(target.displayName) : "them";
      try {
        const { delivered } = await onShare(created.task.id, shareWithUserId);
        if (delivered) {
          showToast(`Sent ${targetName} a heads-up about this task ✓`, { variant: "success" });
        } else {
          showToast(
            `Task created, but we couldn't reach ${targetName} — have them message the bot first.`,
            { variant: "warn" }
          );
        }
      } catch {
        showToast(`Task created, but sharing with ${targetName} failed.`, { variant: "error" });
      }
    }
    await refresh();
    await loadLoans();
  };

  const onClaim = useCallback(async (taskId: string): Promise<void> => {
    try {
      await apiRequest<{ task: LoanTask }>(`/tasks/${taskId}/claim`, { method: "POST" }, user);
      await refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to claim task", { variant: "error" });
    }
  }, [user, refresh, showToast]);

  const onUnclaim = useCallback(async (taskId: string): Promise<void> => {
    try {
      await apiRequest<{ task: LoanTask }>(`/tasks/${taskId}/unclaim`, { method: "POST" }, user);
      await refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to unclaim task", { variant: "error" });
    }
  }, [user, refresh, showToast]);

  const onTransition = useCallback(async (taskId: string, status: TaskStatus, reviewNotes?: string): Promise<void> => {
    try {
      await apiRequest<{ task: LoanTask }>(`/tasks/${taskId}/transition`, { method: "POST", body: JSON.stringify({ status, ...(reviewNotes ? { reviewNotes } : {}) }) }, user);
      await refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to update task", { variant: "error" });
    }
  }, [user, refresh, showToast]);

  /* FRAUD "release for any fraud checker" (#39): the requester hands a
     PENDING_APPROVAL task back to the checker pool (server unassigns it, keeps
     it PENDING_APPROVAL) so final approval isn't stuck on one checker. */
  const onRelease = useCallback(async (taskId: string): Promise<void> => {
    try {
      await apiRequest<{ task: LoanTask }>(`/tasks/${taskId}/release`, { method: "POST" }, user);
      await refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to release task", { variant: "error" });
    }
  }, [user, refresh, showToast]);

  const onAddReviewNote = useCallback(async (taskId: string, text: string): Promise<void> => {
    try {
      await apiRequest<{ task: LoanTask }>(`/tasks/${taskId}/review-note`, { method: "POST", body: JSON.stringify({ text }) }, user);
      await refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to add review note", { variant: "error" });
    }
  }, [user, refresh, showToast]);

  /* Add a note to a COMPLETED task (#45). Hits the server-atomic endpoint that
     appends the note while keeping the task COMPLETED — no visible reopen. */
  const onAddCompletedNote = useCallback(async (taskId: string, text: string): Promise<void> => {
    try {
      await apiRequest<{ task: LoanTask }>(`/tasks/${taskId}/completed-note`, { method: "POST", body: JSON.stringify({ text }) }, user);
      await refresh();
      showToast("Note added", { variant: "success" });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to add note", { variant: "error" });
    }
  }, [user, refresh, showToast]);

  /* FRAUD structured checklist (#44). One handler per atomic endpoint; each
     refreshes so the live task (and SSE-driven cards) reflect the change. Errors
     surface as a toast — the server is the authority on turn/permission, so a
     rejected op just tells the user it isn't their turn. Bundled into one object
     so the card only takes a single prop. */
  const runChecklist = useCallback(async (path: string, body: unknown, fallback: string): Promise<void> => {
    try {
      await apiRequest<{ task: LoanTask }>(path, { method: "POST", body: JSON.stringify(body) }, user);
      await refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : fallback, { variant: "error" });
    }
  }, [user, refresh, showToast]);
  const deleteChecklist = useCallback(async (path: string, fallback: string): Promise<void> => {
    try {
      await apiRequest<{ task: LoanTask }>(path, { method: "DELETE" }, user);
      await refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : fallback, { variant: "error" });
    }
  }, [user, refresh, showToast]);
  /* Memoized so the object identity is stable across renders (#73) — a fresh
     literal every render would defeat TaskCard's memo for every card. */
  const checklistApi = useMemo<ChecklistApi>(() => ({
    addItem: (taskId, text) => runChecklist(`/tasks/${taskId}/checklist/items`, { text }, "Failed to add item"),
    editText: (taskId, itemId, text) => runChecklist(`/tasks/${taskId}/checklist/items/${itemId}/text`, { text }, "Failed to edit item"),
    deleteItem: (taskId, itemId) => deleteChecklist(`/tasks/${taskId}/checklist/items/${itemId}`, "Failed to delete item"),
    toggle: (taskId, itemId, checked, note) =>
      runChecklist(`/tasks/${taskId}/checklist/items/${itemId}/checked`, { checked, ...(note !== undefined ? { note } : {}) }, "Failed to update item"),
    setNote: (taskId, itemId, note) => runChecklist(`/tasks/${taskId}/checklist/items/${itemId}/note`, { note }, "Failed to save note"),
    setCheckerNote: (taskId, itemId, checkerNote) => runChecklist(`/tasks/${taskId}/checklist/items/${itemId}/checker-note`, { checkerNote }, "Failed to save note")
  }), [runChecklist, deleteChecklist]);

  /* Edit a Loan's name/link (the app's first post-creation edit surface).
     Server propagates to every linked task; we refresh tasks + loans so the
     live reference is reflected everywhere. */
  const onSaveLoan = async (loanId: string, name: string, humperdinkLink: string): Promise<void> => {
    try {
      const trimmedLink = humperdinkLink.trim();
      const normLink = trimmedLink && !/^https?:\/\//i.test(trimmedLink) ? `https://${trimmedLink}` : trimmedLink;
      const { loan, merged } = await apiRequest<{
        loan: Loan;
        merged?: { intoLoanId: string; intoLoanName: string; mergedName: string };
      }>(
        `/loans/${loanId}`,
        { method: "PATCH", body: JSON.stringify({ name: name.trim(), humperdinkLink: normLink }) },
        user
      );
      setLoanFilterId(loan.id);
      setError(null);
      // ADR-0001: a shared Humperdink link auto-merges the two loans; surface
      // that so the edit doesn't silently fold this record into another. The
      // notice is a transient auto-dismiss toast (ADR-0001 addendum 2026-07-31).
      if (merged) {
        showToast(
          `Merged with "${merged.intoLoanName}", an existing loan sharing this Humperdink link.`,
          { variant: "info" }
        );
      }
      await refresh();
      await loadLoans();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to update loan", { variant: "error" });
    }
  };

  const onUpdatePoints = useCallback(async (taskId: string, points: number): Promise<void> => {
    try {
      await apiRequest<{ task: LoanTask }>(`/tasks/${taskId}/points`, { method: "POST", body: JSON.stringify({ points }) }, user);
      await refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to update poops", { variant: "error" });
    }
  }, [user, refresh, showToast]);

  /* Share a task with one person (issue #41). Returns whether the DM actually
     reached them (they may have no bot reference), so the card can distinguish
     "sent ✓" from a "couldn't reach them" heads-up. Rethrows on request failure
     so the card can flash an inline error next to the picker. */
  const onShare = useCallback(async (taskId: string, targetUserId: string, note?: string): Promise<{ delivered: boolean }> => {
    try {
      const res = await apiRequest<{ ok: true; delivered: boolean }>(
        `/tasks/${taskId}/share`,
        { method: "POST", body: JSON.stringify({ targetUserId, ...(note ? { note } : {}) }) },
        user
      );
      setError(null);
      return { delivered: res.delivered };
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to share task", { variant: "error" });
      throw err;
    }
  }, [user, showToast]);

  /* Stable so it doesn't defeat TaskCard's memo (#73) — was an inline arrow
     rebuilt inside `cardProps` every render. */
  const onFilterLoan = useCallback((loanId: string): void => {
    setLoanFilterId(loanId);
  }, []);

  /* Unified visible-task list. Closed tasks (COMPLETED / CANCELLED /
     ARCHIVED) older than CLOSED_TTL_DAYS drop off the bottom — admins can
     see everything ever via the All Tasks tab. CANCELLED rides the same
     retention window as the other closed statuses (it used to vanish
     immediately) so a just-cancelled task stays visible in Done before being
     pruned. Fraud Check claims are gated to FILE_CHECKERs in the workflow;
     the UI just hides the Claim button for viewers who can't act. Sort:
     celebrating (creator-only completion milestone) pinned to the very top →
     OPEN → in-flight → closed mini rows, newest-first within each bucket. */
  const CLOSED_TTL_DAYS = 14;
  const buildSorted = (includeOldClosed: boolean): LoanTask[] => {
    const cutoff = Date.now() - CLOSED_TTL_DAYS * 24 * 60 * 60 * 1000;
    const bucket = (t: LoanTask): number => {
      if (t.createdBy.id === user.id && isCelebratingStatus(t)) return 0;
      if (t.status === "OPEN") return 1;
      if (CLOSED_STATUSES.includes(t.status)) return 3;
      return 2;
    };
    return tasks
      .filter((t) => {
        if (includeOldClosed) return true;
        if (!CLOSED_STATUSES.includes(t.status)) return true;
        const stamp = t.completedAt ?? t.cancelledAt ?? t.archivedAt ?? t.updatedAt;
        return new Date(stamp).getTime() >= cutoff;
      })
      .sort((a, b) => {
        const diff = bucket(a) - bucket(b);
        if (diff !== 0) return diff;
        return b.createdAt.localeCompare(a.createdAt);
      });
  };
  const unifiedTasks = useMemo(() => buildSorted(false),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, user.id]);
  const allTasksAdmin = useMemo(() => buildSorted(true),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, user.id]);

  const activeCount = useMemo(() => unifiedTasks.filter((t) => !CLOSED_STATUSES.includes(t.status)).length, [unifiedTasks]);

  /* Re-bucket an already-filtered task list (CANCELLED dropped, TTL applied)
     into the grouped view's courts. A completion the viewer created pins to a
     "Just finished" section at the very top (kept until they archive it) and
     is held out of Done so it isn't listed twice; everyone else's completions
     fall into Done. Active courts sort soonest-due first, Done newest-first. */
  type CourtSection = { key: string; title: string; tasks: LoanTask[] };
  const buildCourtSections = (list: LoanTask[]): CourtSection[] => {
    const celebrating: LoanTask[] = [];
    const you: LoanTask[] = [];
    const pool: LoanTask[] = [];
    const them: LoanTask[] = [];
    const done: LoanTask[] = [];
    for (const t of list) {
      // "Finished" celebrates only truly-done work the viewer created. A
      // LOAN_DOCS task at MERGE_DONE still needs the creator's Approve, so it
      // falls through to its court ("Needs you") instead of being mislabeled as
      // finished — the brief green pulse still fires via pulsingIds.
      if (t.createdBy.id === user.id && t.status === "COMPLETED") {
        celebrating.push(t);
        continue;
      }
      let court = courtOf(t, user);
      // Message pull (CONTEXT.md): an unread reply from the other party
      // temporarily pulls a task into the recipient's "Needs you", even when
      // they don't own the current section. Reuses the red-dot unread signal
      // (seenNotesAt) so a Party's bucket and red dot agree. Only ever ADDS a
      // court — never removes one — and only for a Party (creator/assignee);
      // an Observer has no move, so an unread note doesn't pull them in.
      if (court === "them" || court === "pool") {
        const isParty = t.createdBy.id === user.id || t.assignee?.id === user.id;
        const latestOther = latestNoteFromOther(t, user.id);
        if (isParty && latestOther && latestOther > (seenNotesAt[t.id] ?? "")) {
          court = "you";
        }
      }
      if (court === "you") you.push(t);
      else if (court === "pool") pool.push(t);
      else if (court === "them") them.push(t);
      else done.push(t);
    }
    const byDue = (a: LoanTask, b: LoanTask): number => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
    const byRecent = (a: LoanTask, b: LoanTask): number =>
      new Date(b.completedAt ?? b.updatedAt).getTime() - new Date(a.completedAt ?? a.updatedAt).getTime();
    you.sort(byDue);
    pool.sort(byDue);
    them.sort(byDue);
    done.sort(byRecent);
    celebrating.sort(byRecent);
    const sections: CourtSection[] = [];
    if (celebrating.length) sections.push({ key: "celebrating", title: "Finished", tasks: celebrating });
    sections.push({ key: "you", title: "Needs you", tasks: you });
    sections.push({ key: "pool", title: "Up for grabs", tasks: pool });
    sections.push({ key: "them", title: "In flight", tasks: them });
    sections.push({ key: "done", title: "Done", tasks: done });
    return sections;
  };

  const renderTaskList = (list: LoanTask[], emptyMessage: string) => {
    const cardProps = {
      user,
      onClaim,
      onUnclaim,
      onTransition,
      onRelease,
      onAddReviewNote,
      onAddCompletedNote,
      onUpdatePoints,
      onFilterLoan,
      onShare,
      checklist: checklistApi,
      directory,
      showActions: true,
      seenNotesAt,
      onMarkNoteSeen: markNoteSeen,
      pulsingIds,
      expandOverrides,
      onSetExpand: setExpandOverride
    };
    /* The toggle only controls court bucketing — both views render the same
       compact row, so a task looks identical either way. Flat view is the
       whole list in one CardList; grouped view splits it into court sections. */
    if (!grouped) {
      return <CardList tasks={list} emptyMessage={emptyMessage} now={now} {...cardProps} />;
    }
    const sections = buildCourtSections(list).filter((s) => s.tasks.length > 0);
    if (sections.length === 0) {
      return <div className="empty-card">{emptyMessage}</div>;
    }
    return (
      <div className="courts">
        {sections.map((s) => (
          <section className="court" key={s.key} data-court={s.key}>
            <div className="section-head">
              <h2>
                {s.title}
                <span className="section-count">{s.tasks.length}</span>
              </h2>
            </div>
            <CardList tasks={s.tasks} emptyMessage="" now={now} {...cardProps} />
          </section>
        ))}
      </div>
    );
  };

  /* ── Metrics computations (admin only) ──────────────────── */
  const claimsLeaderboard = useMemo(() => {
    if (!isAdmin) return [];
    const counts = new Map<string, { id: string; displayName: string; count: number }>();
    for (const t of tasks) {
      if (!t.assignee) continue;
      const entry = counts.get(t.assignee.id);
      if (entry) {
        entry.count++;
      } else {
        counts.set(t.assignee.id, { id: t.assignee.id, displayName: t.assignee.displayName, count: 1 });
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  }, [tasks, isAdmin]);

  const statusTotals = useMemo(() => {
    if (!isAdmin) return { total: 0, active: 0, completed: 0, archived: 0, cancelled: 0 };
    let active = 0, completed = 0, archived = 0, cancelled = 0;
    for (const t of tasks) {
      if (t.status === "COMPLETED") completed++;
      else if (t.status === "ARCHIVED") archived++;
      else if (t.status === "CANCELLED") cancelled++;
      else active++;
    }
    return { total: tasks.length, active, completed, archived, cancelled };
  }, [tasks, isAdmin]);

  const typeBreakdown = useMemo(() => {
    if (!isAdmin) return [];
    const counts = new Map<TaskType, number>();
    for (const tt of TASK_TYPES) counts.set(tt, 0);
    for (const t of tasks) counts.set(t.taskType, (counts.get(t.taskType) ?? 0) + 1);
    const total = tasks.length || 1;
    return TASK_TYPES.map((tt) => ({
      type: tt,
      label: TASK_TYPE_LABELS[tt],
      count: counts.get(tt) ?? 0,
      pct: Math.round(((counts.get(tt) ?? 0) / total) * 100)
    }));
  }, [tasks, isAdmin]);

  return (
    <main className="app-shell">
      {/* ── Header ──────────────────────────────────── */}
      <header className="top-bar">
        <div className="top-bar-left">
          <span className="top-bar-brand">
            <svg className="top-bar-logo" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
            </svg>
            <h1>Hot Task</h1>
          </span>
          <button
            type="button"
            className="form-toggle"
            aria-expanded={formOpen}
            onClick={() => setFormOpen((o) => !o)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New Task
          </button>
          {(activeTab === "active" || activeTab === "all") && (
            <div className="group-toggle">
              <span className="group-toggle-label">Grouped</span>
              <button
                type="button"
                className={`group-switch${grouped ? " group-switch-on" : ""}`}
                role="switch"
                aria-checked={grouped}
                aria-label="Group tasks by whose court the ball is in"
                title={grouped ? "Grouped into courts — click for a flat list" : "Flat list — click to group into courts"}
                onClick={() => setGrouped((g) => !g)}
              >
                <span className="group-switch-knob" />
              </button>
            </div>
          )}
        </div>
        {IS_DEV ? (
          <label className="user-picker">
            <span>User:</span>
            <select value={user.id} onChange={(e) => setUser(DEV_USERS.find((u) => u.id === e.target.value) ?? INITIAL_USER)}>
              {DEV_USERS.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName} ({u.roles.join("/")})
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="user-picker user-picker-static">{user.displayName}</span>
        )}
      </header>

      {error && <p className="error-bar">{error}</p>}

      {/* New Task form (issue #72): its input state lives in the child, so
          typing never re-renders App or the task list. Mounted only while
          open; unmounting on close discards the draft. */}
      {formOpen && (
        <CreateTaskForm
          loans={loans}
          directory={directory}
          user={user}
          tasks={tasks}
          onClose={() => setFormOpen(false)}
          onCreate={onCreate}
        />
      )}

      {/* Tab bar only renders when there's more than one tab to choose
          (i.e. admins with the Metrics panel). Non-admins see the unified
          grid directly. */}
      {isAdmin && (
      <div className="tab-bar">
        <button
          type="button"
          className={`tab-btn${activeTab === "active" ? " tab-active" : ""}`}
          onClick={() => setActiveTab("active")}
        >
          Tasks
          <span className="section-count">{activeCount}</span>
        </button>
        <button
          type="button"
          className={`tab-btn${activeTab === "all" ? " tab-active" : ""}`}
          onClick={() => setActiveTab("all")}
        >
          All Tasks
          <span className="section-count">{allTasksAdmin.length}</span>
        </button>
        <button
          type="button"
          className={`tab-btn${activeTab === "metrics" ? " tab-active" : ""}`}
          onClick={() => setActiveTab("metrics")}
        >
          Metrics
        </button>
        <button
          type="button"
          className={`tab-btn${activeTab === "admin" ? " tab-active" : ""}`}
          onClick={() => setActiveTab("admin")}
        >
          Admin
        </button>
      </div>
      )}

      {/* ── Unified task grid ──────────────────────── */}
      {activeTab === "active" && (() => {
        // A stale id (loan merged away) simply resolves to undefined → the
        // list renders unfiltered with no header, which is harmless.
        const activeLoan = loanFilterId ? loans.find((l) => l.id === loanFilterId) : undefined;
        if (activeLoan) {
          const filtered = unifiedTasks.filter((t) => t.loanId === activeLoan.id);
          return (
            <>
              <LoanFilterHeader
                loan={activeLoan}
                taskCount={filtered.length}
                onSave={onSaveLoan}
                onClear={() => setLoanFilterId(null)}
              />
              {renderTaskList(filtered, "No tasks for this loan.")}
            </>
          );
        }
        return renderTaskList(unifiedTasks, "No tasks yet.");
      })()}

      {/* ── All Tasks (admin) ────────────────────────── */}
      {activeTab === "all" && isAdmin && (
        <>
          <div className="section-head task-grid-head">
            <h2>All Tasks (admin)</h2>
            <span className="section-count">{allTasksAdmin.length} total · no age cutoff</span>
          </div>
          {renderTaskList(allTasksAdmin, "No tasks yet.")}
        </>
      )}

      {/* ── Metrics tab content ─────────────────────── */}
      {activeTab === "metrics" && isAdmin && (
        <MetricsPanel leaderboard={claimsLeaderboard} totals={statusTotals} typeBreakdown={typeBreakdown} />
      )}

      {/* ── Admin tab content ───────────────────────── */}
      {activeTab === "admin" && isAdmin && <AdminPanel user={user} />}
    </main>
  );
};
