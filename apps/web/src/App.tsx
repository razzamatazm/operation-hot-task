import { app as teamsApp, authentication } from "@microsoft/teams-js";
import { CLOSED_STATUSES, CreateTaskInput, LoanTask, TaskStatus, TaskType, TASK_TYPES, UrgencyLevel, UserIdentity, UserRole, canClaimTask, canRestoreTask, formatWallDate, getNotesFieldLabel, nextFlowStatuses, restoreTargetStatus } from "@loan-tasks/shared";
import { FormEvent, KeyboardEvent, MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";

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

/* LOAN_DOCS has multiple stages between claim and complete. Stage suffix
   rides on the title as a hyphen suffix so the type label stays terse. */
const stageSuffix = (task: LoanTask): string => {
  if (task.taskType !== "LOAN_DOCS") return "";
  if (task.status === "MERGE_DONE") return " - Merge Done";
  if (task.status === "MERGE_APPROVED") return " - Merge Approved";
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
  COMPLETED: "Completed",
  NEEDS_REVIEW: "Needs review"
};
const Timeline = ({ task }: { task: LoanTask }) => {
  const flow: TaskStatus[] =
    task.taskType === "LOAN_DOCS"
      ? ["OPEN", "CLAIMED", "MERGE_DONE", "MERGE_APPROVED", "COMPLETED"]
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

/* ── Task Card ────────────────────────────────────────────── */
const TaskCard = ({
  task,
  user,
  onClaim,
  onUnclaim,
  onTransition,
  onAddReviewNote,
  onUpdatePoints,
  onShare,
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
  onAddReviewNote: (taskId: string, text: string) => Promise<void>;
  onUpdatePoints: (taskId: string, points: number) => Promise<void>;
  /* Point a specific person at this task (issue #41). Resolves on success,
     rejects on failure so the card can show inline status. */
  onShare: (taskId: string, targetUserId: string) => Promise<void>;
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
  /* Share picker (issue #41): chosen person + send status + copy-link flash. */
  const [shareTargetId, setShareTargetId] = useState("");
  const [shareState, setShareState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [shareLinkCopied, setShareLinkCopied] = useState(false);
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

  /* Share: point one person at this task. Candidates are everyone in the
     directory except the current user (sharing with yourself is a no-op). */
  const shareCandidates = directory.filter((p) => p.id !== user.id);
  const handleShare = async () => {
    if (!shareTargetId) return;
    setShareState("sending");
    try {
      await onShare(task.id, shareTargetId);
      setShareState("done");
      setShareTargetId("");
    } catch {
      setShareState("error");
    }
  };
  /* Copy an in-app deep link to this task (the `#task-<id>` anchor matches the
     card's element id, so it scrolls the row into view). The person-picker
     above is the real deliverable; this is the lightweight "share link". */
  const handleCopyShareLink = async () => {
    const link = `${window.location.origin}${window.location.pathname}#task-${task.id}`;
    try {
      await navigator.clipboard.writeText(link);
      setShareLinkCopied(true);
      setTimeout(() => setShareLinkCopied(false), 1500);
    } catch {
      /* clipboard unavailable — ignore */
    }
  };

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

  type QuickAction = { label: string; kind: "good" | "ghost" | "danger" | "default"; run: () => void };
  let primaryAction: QuickAction | null = null;
  if (showActions) {
    if (task.status === "OPEN" && !isCreator && canClaimTask(task, user)) {
      primaryAction = { label: "Claim", kind: "good", run: () => { void onClaim(task.id); } };
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
    (isCreator || isAssignee || user.roles.includes("ADMIN"));
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
            </div>
          )}
          {/* Share (issue #41): DM a specific person a deep link to this task,
              outside the normal creator/assignee flow. Hidden when there's
              nobody else in the directory to point at. */}
          {showActions && shareCandidates.length > 0 && (
            <div className="task-card-share">
              <label className="task-card-share-label" htmlFor={`share-${task.id}`}>Make sure someone sees this</label>
              <div className="task-card-share-row">
                <select
                  id={`share-${task.id}`}
                  value={shareTargetId}
                  onChange={(e) => { setShareTargetId(e.target.value); setShareState("idle"); }}
                >
                  <option value="">Choose a person…</option>
                  {shareCandidates.map((p) => (
                    <option key={p.id} value={p.id}>{p.displayName}</option>
                  ))}
                </select>
                <button type="button" className="btn-sm" disabled={!shareTargetId || shareState === "sending"} onClick={() => void handleShare()}>
                  {shareState === "sending" ? "Sharing…" : "Share"}
                </button>
                <button type="button" className="btn-sm btn-ghost" onClick={() => void handleCopyShareLink()}>
                  {shareLinkCopied ? "Copied ✓" : "Copy link"}
                </button>
              </div>
              {shareState === "done" && <span className="task-card-share-status" role="status">Sent a heads-up ✓</span>}
              {shareState === "error" && <span className="task-card-share-status task-card-share-error" role="status">Couldn't share — try again</span>}
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
              <a href={task.humperdinkLink} target="_blank" rel="noreferrer" aria-label={`Open Humperdink link for ${task.folderName}`} title="Open Humperdink link" onClick={stopBubble}>
                <span>{task.folderName}</span>
                <span className="external-link-icon" aria-hidden="true">↗</span>
              </a>
            ) : (
              <span>{task.folderName}</span>
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
};

/* ── Card List ────────────────────────────────────────────── */
const CardList = ({
  tasks,
  user,
  onClaim,
  onUnclaim,
  onTransition,
  onAddReviewNote,
  onUpdatePoints,
  onShare,
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
  onAddReviewNote: (taskId: string, text: string) => Promise<void>;
  onUpdatePoints: (taskId: string, points: number) => Promise<void>;
  onShare: (taskId: string, targetUserId: string) => Promise<void>;
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
      tasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          user={user}
          onClaim={onClaim}
          onUnclaim={onUnclaim}
          onTransition={onTransition}
          onAddReviewNote={onAddReviewNote}
          onUpdatePoints={onUpdatePoints}
          onShare={onShare}
          directory={directory}
          showActions={showActions}
          pulsing={pulsingIds?.has(task.id) ?? false}
          {...(now !== undefined ? { now } : {})}
          {...(seenNotesAt?.[task.id] !== undefined ? { seenNoteAt: seenNotesAt[task.id] } : {})}
          {...(onMarkNoteSeen ? { onMarkNoteSeen } : {})}
          {...(expandOverrides?.[task.id] !== undefined ? { expandOverride: expandOverrides[task.id] } : {})}
          {...(onSetExpand ? { onSetExpand } : {})}
        />
      ))
    )}
  </div>
);

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

/* ── Main app ─────────────────────────────────────────────── */
export const App = () => {
  const [user, setUser] = useState<UserIdentity>(INITIAL_USER);
  const [tasks, setTasks] = useState<LoanTask[]>([]);
  /* Selectable people for the share picker (issue #41). Active users, id + name. */
  const [directory, setDirectory] = useState<Array<{ id: string; displayName: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [namvarHover, setNamvarHover] = useState<number | null>(null);
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
  const markNoteSeen = (taskId: string, at: string): void => {
    setSeenNotesAt((prev) => {
      const cur = prev[taskId];
      if (cur && cur >= at) return prev;
      return { ...prev, [taskId]: at };
    });
  };

  useEffect(() => {
    try {
      window.localStorage.setItem(expandKey, JSON.stringify(expandOverrides));
    } catch {
      /* storage unavailable — degrade silently */
    }
  }, [expandOverrides, expandKey]);
  const setExpandOverride = (taskId: string, open: boolean): void => {
    setExpandOverrides((prev) => ({ ...prev, [taskId]: open }));
  };
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

  const [form, setForm] = useState({
    folderName: "",
    taskType: "LOI" as TaskType,
    urgency: "GREEN" as UrgencyLevel,
    startDate: "",
    returnDate: "",
    notes: "",
    humperdinkLink: "",
    points: 0
  });

  const isAdmin = user.roles.includes("ADMIN");

  useEffect(() => {
    if (!isAdmin && (activeTab === "metrics" || activeTab === "all" || activeTab === "admin")) {
      setActiveTab("active");
    }
  }, [isAdmin, activeTab]);

  const refresh = async (): Promise<void> => {
    try {
      const data = await apiRequest<{ tasks: LoanTask[] }>("/tasks", { method: "GET" }, user);
      setTasks(data.tasks);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tasks");
    }
  };

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

  const onCreateTask = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const rawLink = form.humperdinkLink.trim();
    const normalizedLink = rawLink && !/^https?:\/\//i.test(rawLink) ? `https://${rawLink}` : rawLink;
    const payload: CreateTaskInput = {
      folderName: form.folderName,
      taskType: form.taskType,
      notes: form.notes,
      ...(form.taskType === "OOO" ? { startDate: form.startDate, returnDate: form.returnDate } : { urgency: form.urgency }),
      ...(form.taskType !== "OOO" && normalizedLink ? { humperdinkLink: normalizedLink } : {}),
      ...(form.points > 0 ? { points: form.points } : {})
    };

    try {
      await apiRequest<{ task: LoanTask }>("/tasks", { method: "POST", body: JSON.stringify(payload) }, user);
      setForm((c) => ({ ...c, folderName: "", notes: "", startDate: "", returnDate: "", humperdinkLink: "", points: 0 }));
      setError(null);
      setFormOpen(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create task");
    }
  };

  const onClaim = async (taskId: string): Promise<void> => {
    try {
      await apiRequest<{ task: LoanTask }>(`/tasks/${taskId}/claim`, { method: "POST" }, user);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to claim task");
    }
  };

  const onUnclaim = async (taskId: string): Promise<void> => {
    try {
      await apiRequest<{ task: LoanTask }>(`/tasks/${taskId}/unclaim`, { method: "POST" }, user);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to unclaim task");
    }
  };

  const onTransition = async (taskId: string, status: TaskStatus, reviewNotes?: string): Promise<void> => {
    try {
      await apiRequest<{ task: LoanTask }>(`/tasks/${taskId}/transition`, { method: "POST", body: JSON.stringify({ status, ...(reviewNotes ? { reviewNotes } : {}) }) }, user);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update task");
    }
  };

  const onAddReviewNote = async (taskId: string, text: string): Promise<void> => {
    try {
      await apiRequest<{ task: LoanTask }>(`/tasks/${taskId}/review-note`, { method: "POST", body: JSON.stringify({ text }) }, user);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add review note");
    }
  };

  const onUpdatePoints = async (taskId: string, points: number): Promise<void> => {
    try {
      await apiRequest<{ task: LoanTask }>(`/tasks/${taskId}/points`, { method: "POST", body: JSON.stringify({ points }) }, user);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update poops");
    }
  };

  /* Share a task with one person (issue #41). Rethrows so the card can flash
     an inline success/error state next to the picker. */
  const onShare = async (taskId: string, targetUserId: string): Promise<void> => {
    try {
      await apiRequest<{ ok: true }>(`/tasks/${taskId}/share`, { method: "POST", body: JSON.stringify({ targetUserId }) }, user);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to share task");
      throw err;
    }
  };

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
      onAddReviewNote,
      onUpdatePoints,
      onShare,
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

      {formOpen && (
        <div
          className="form-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="New task"
          onClick={() => setFormOpen(false)}
          onKeyDown={(e) => { if (e.key === "Escape") setFormOpen(false); }}
        >
          <div className="form-panel" onClick={(e) => e.stopPropagation()}>
          <form className="task-form" onSubmit={onCreateTask}>
            <label>
              {form.taskType === "OOO" ? "Vacation Description" : "Folder Name"}
              <input value={form.folderName} onChange={(e) => setForm((c) => ({ ...c, folderName: e.target.value }))} required />
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
              {getNotesFieldLabel(form.taskType)}
              <textarea rows={2} value={form.notes} onChange={(e) => setForm((c) => ({ ...c, notes: e.target.value }))} required />
            </label>
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
            <div className="form-actions">
              <button type="button" className="btn-ghost" onClick={() => setFormOpen(false)}>Cancel</button>
              <button type="submit">Create Task</button>
            </div>
          </form>
          </div>
        </div>
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
      {activeTab === "active" && renderTaskList(unifiedTasks, "No tasks yet.")}

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
