import { app as teamsApp, authentication } from "@microsoft/teams-js";
import { CreateTaskInput, LoanTask, TaskStatus, TaskType, TASK_TYPES, UrgencyLevel, UserIdentity, canClaimTask, getNotesFieldLabel, nextFlowStatuses } from "@loan-tasks/shared";
import { FormEvent, KeyboardEvent, MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { mockUsers } from "./mockUsers";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";
const IS_DEV = import.meta.env.DEV;
/* In a Teams tab the user is resolved from the SSO token (see bootstrap
   effect). In a plain dev browser there's no Teams host, so fall back to a
   mock user the dev can switch between. */
const INITIAL_USER: UserIdentity = IS_DEV
  ? mockUsers[0]!
  : { id: "", displayName: "Signing in", roles: ["LOAN_OFFICER"] };

/* SSO bearer token, set once the Teams auth flow resolves. Module-level so
   the standalone apiRequest helper can read it without prop-drilling. */
let authToken: string | null = null;
export const setAuthToken = (token: string | null): void => {
  authToken = token;
};

const CLOSED_STATUSES: TaskStatus[] = ["COMPLETED", "ARCHIVED", "CANCELLED"];
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

/* Left stripe = status (not urgency).
   OPEN → red ("needs a claim"), in-flight → orange ("warming"),
   COMPLETED/CANCELLED/ARCHIVED carry their own closed-status stripes. */
const STATUS_STRIPE_CLASS: Partial<Record<TaskStatus, string>> = {
  OPEN: "task-card-stripe-open",
  CLAIMED: "task-card-stripe-progress",
  NEEDS_REVIEW: "task-card-stripe-progress",
  MERGE_DONE: "task-card-stripe-progress",
  MERGE_APPROVED: "task-card-stripe-progress"
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

const formatRelativeDue = (iso: string, overdue: boolean): string => {
  const diffMs = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const min = Math.round(abs / 60000);
  const hr = Math.round(abs / 3600000);
  const day = Math.round(abs / 86400000);
  let span: string;
  if (min < 60) span = `${min}m`;
  else if (hr < 24) span = `${hr}h`;
  else span = `${day}d`;
  return overdue ? `${span} overdue` : `due in ${span}`;
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

/* ── Status banner helpers ─────────────────────────────────── */
/* Single perspective-free banner per status. The Assigner / Assignee
   columns carry "whose court" — the banner is just the task state. */
/* Multi-word labels embed a newline so `.status-banner-label`'s
   `white-space: pre-line` stacks them across two lines, keeping the
   status column narrow and the rows tidy. */
const STATUS_BANNER: Record<string, { label: string; className: string }> = {
  OPEN: { label: "OPEN", className: "status-banner status-open" },
  CLAIMED: { label: "IN\nPROGRESS", className: "status-banner status-claimed" },
  NEEDS_REVIEW: { label: "IN\nREVIEW", className: "status-banner status-claimed" },
  MERGE_DONE: { label: "MERGE\nDONE", className: "status-banner status-merge" },
  MERGE_APPROVED: { label: "MERGE\nAPPROVED", className: "status-banner status-merge" },
  COMPLETED: { label: "COMPLETED!", className: "status-banner status-completed" },
  CANCELLED: { label: "CANCELLED", className: "status-banner status-cancelled" },
  ARCHIVED: { label: "ARCHIVED", className: "status-banner status-archived" }
};

const firstName = (displayName: string | undefined): string => {
  if (!displayName) return "";
  return displayName.split(/\s+/)[0] ?? displayName;
};

/* LOAN_DOCS has multiple stages between claim and complete. Stage suffix
   rides on the title as a hyphen suffix so the status banner stays terse. */
const stageSuffix = (task: LoanTask): string => {
  if (task.taskType !== "LOAN_DOCS") return "";
  if (task.status === "MERGE_DONE") return " - Merge Done";
  if (task.status === "MERGE_APPROVED") return " - Merge Approved";
  return "";
};

const resolveBanner = (task: LoanTask): { label: string; className: string } =>
  STATUS_BANNER[task.status] ?? { label: "OPEN", className: "status-banner status-open" };

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

/* ── Task Card ────────────────────────────────────────────── */
const TaskCard = ({
  task,
  user,
  onClaim,
  onUnclaim,
  onTransition,
  onAddReviewNote,
  onUpdatePoints,
  showActions,
  variant,
  seenNoteAt,
  onMarkNoteSeen,
  pulsing,
  expandOverride,
  onSetExpand
}: {
  task: LoanTask;
  user: UserIdentity;
  onClaim: (taskId: string) => Promise<void>;
  onUnclaim: (taskId: string) => Promise<void>;
  onTransition: (taskId: string, status: TaskStatus, reviewNotes?: string) => Promise<void>;
  onAddReviewNote: (taskId: string, text: string) => Promise<void>;
  onUpdatePoints: (taskId: string, points: number) => Promise<void>;
  showActions: boolean;
  variant: "own" | "watching" | "available" | "completed";
  seenNoteAt?: string;
  onMarkNoteSeen?: (taskId: string, at: string) => void;
  pulsing?: boolean;
  /* Per-user persisted manual open/close. undefined = follow the default. */
  expandOverride?: boolean;
  onSetExpand?: (taskId: string, open: boolean) => void;
}) => {
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState("");
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
  const latestOtherNoteAt = useMemo(() => {
    let latest = "";
    for (const n of task.reviewNotes ?? []) {
      if (n.by.id !== user.id && n.at > latest) latest = n.at;
    }
    return latest;
  }, [task.reviewNotes, user.id]);
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

  const handleSubmitNote = async () => {
    if (!noteText.trim()) return;
    await onAddReviewNote(task.id, noteText.trim());
    setNoteOpen(false);
    setNoteText("");
    acknowledgeUnread();
  };

  const banner = resolveBanner(task);
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
  const cardClass = [
    "task-card",
    !isClosed && task.taskType !== "OOO" ? STATUS_STRIPE_CLASS[task.status] ?? "" : "",
    dimmed ? "task-card-dimmed" : "",
    mini ? "task-card-mini" : "",
    pulsing ? "task-card-celebrating" : "",
    !isClosed && !dimmed && variant === "watching" && task.status !== "MERGE_DONE" ? "task-card-watching" : "",
    !isClosed && !dimmed && variant === "own" ? "task-card-own" : "",
    task.status === "COMPLETED" ? "task-card-completed" : "",
    task.status === "CANCELLED" ? "task-card-cancelled" : "",
    task.status === "ARCHIVED" ? "task-card-archived" : ""
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

  const dueDisplay = task.status === "COMPLETED" || task.status === "ARCHIVED"
    ? formatRelativeCompleted(task.completedAt)
    : task.taskType === "OOO"
      ? `Return ${formatPtDateOnly(task.dueAt)}`
      : formatRelativeDue(task.dueAt, overdue);
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

  const assignerIsMe = isCreator;
  const assigneeIsMe = isAssignee;
  const assigneeMissing = !task.assignee;
  const assignerLabel = assignerIsMe ? "ME" : firstName(task.createdBy.displayName).toUpperCase();
  const assigneeLabel = assigneeMissing
    ? task.status === "OPEN" ? "PENDING" : "—"
    : assigneeIsMe ? "ME" : firstName(task.assignee?.displayName).toUpperCase();
  const assignerValueClass = `task-card-people-value${assignerIsMe ? " task-card-people-me" : ""}`;
  const assigneeValueClass = `task-card-people-value${assigneeIsMe || assigneeMissing ? " task-card-people-me" : ""}`;

  return (
    <div className={cardClass}>
      <div
          className={`task-card-collapsed${expanded ? " task-card-collapsed-open" : ""}${mini ? " task-card-collapsed-mini" : ""}`}
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onClick={handleHeaderClick}
          onKeyDown={handleHeaderKey}
          title={urgencyTitle}
        >
          <span className={banner.className}>
            <span className="status-banner-label">
              {banner.label}
              {hasUnreadNote && (
                <span className="task-card-unread-dot" aria-label="New note" title="New note" />
              )}
            </span>
          </span>
          <span className="task-card-people task-card-people-assigner">
            <span className="task-card-people-label">Assigner</span>
            <span className={assignerValueClass} title={task.createdBy.displayName}>
              {assignerLabel}
            </span>
          </span>
          <span className="task-card-people task-card-people-assignee">
            <span className="task-card-people-label">Assignee</span>
            <span className={assigneeValueClass} title={task.assignee?.displayName ?? "Unassigned"}>
              {assigneeLabel}
            </span>
          </span>
          <span className="task-card-collapsed-title">
            <span className={`task-card-collapsed-type task-type-${task.taskType.toLowerCase()}`}>
              {TASK_TYPE_LABELS[task.taskType]}
              {stageSuffix(task) && (
                <span className="task-card-collapsed-stage">{stageSuffix(task)}</span>
              )}
            </span>
            <span className="task-card-collapsed-folder">
              {task.taskType !== "OOO" && task.humperdinkLink ? (
                <a
                  href={task.humperdinkLink}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open Humperdink link for ${task.folderName}`}
                  title="Open Humperdink link"
                  onClick={stopBubble}
                >
                  <span>{task.folderName}</span>
                  <span className="external-link-icon" aria-hidden="true">↗</span>
                </a>
              ) : (
                <span>{task.folderName}</span>
              )}
            </span>
          </span>
          {mini ? (
            <span className="task-card-collapsed-cell-empty" aria-hidden="true" />
          ) : (
            <PoopDisplay
              count={task.points ?? 0}
              canEdit={isCreator && !isClosed}
              onChange={(n) => { void onUpdatePoints(task.id, n); }}
            />
          )}
          <span
            className={`task-card-collapsed-due${overdue ? " task-card-collapsed-due-overdue" : ""}`}
            title={dueTitle}
          >
            {dueDisplay}
          </span>
          {primaryAction ? (
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
      {expanded && (
        <div className="task-card-expanded">
          <div className="task-card-left">
            <div className="task-card-meta">
              <div>Created: {formatDate(task.createdAt)}</div>
              {task.taskType === "OOO" && <div>Return Date: {formatPtDateOnly(task.dueAt)}</div>}
              {task.taskType !== "OOO" && <div>Urgency: {URGENCY_LABELS[task.urgency]}</div>}
              {task.assignee && !isAssignee && <div>Assignee: {task.assignee.displayName}</div>}
            </div>
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
              <div className="task-card-actions">
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
              </div>
            )}
          </div>
          <div className="task-card-right">
            <div className="task-card-notes">{task.notes}</div>
            {Array.isArray(task.reviewNotes) && task.reviewNotes.length > 0 && (
              <div className="task-card-review">
                <strong>Notes Thread</strong>
                <div className="task-card-review-list" ref={reviewListRef}>
                  {task.reviewNotes.map((note, i) => (
                    <div key={i} className="review-thread-entry">
                      <span className="review-thread-author">{note.by.displayName}</span>
                      <span className="review-thread-time">{formatDate(note.at)}</span>
                      <p>{note.text}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {showActions && !CLOSED_STATUSES.includes(task.status) && (isCreator || isAssignee || user.roles.includes("ADMIN")) && !noteOpen && (
              <button type="button" className="btn-sm btn-ghost review-reply-btn" onClick={() => { setNoteOpen(true); setNoteText(""); }}>
                Add Note
              </button>
            )}
            {noteOpen && (
              <div className="review-note-input">
                <textarea
                  rows={2}
                  placeholder="Add a note..."
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  autoFocus
                />
                <div className="review-note-actions">
                  <button type="button" className="btn-sm btn-ghost" onClick={() => setNoteOpen(false)}>Cancel</button>
                  <button type="button" className="btn-sm" onClick={handleSubmitNote} disabled={!noteText.trim()}>Add Note</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
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
  showActions,
  emptyMessage,
  variant,
  seenNotesAt,
  onMarkNoteSeen,
  pulsingIds,
  expandOverrides,
  onSetExpand
}: {
  tasks: LoanTask[];
  user: UserIdentity;
  onClaim: (taskId: string) => Promise<void>;
  onUnclaim: (taskId: string) => Promise<void>;
  onTransition: (taskId: string, status: TaskStatus, reviewNotes?: string) => Promise<void>;
  onAddReviewNote: (taskId: string, text: string) => Promise<void>;
  onUpdatePoints: (taskId: string, points: number) => Promise<void>;
  showActions: boolean;
  emptyMessage: string;
  variant?: (task: LoanTask) => "own" | "watching" | "available" | "completed";
  seenNotesAt?: Record<string, string>;
  onMarkNoteSeen?: (taskId: string, at: string) => void;
  pulsingIds?: Set<string>;
  expandOverrides?: Record<string, boolean>;
  onSetExpand?: (taskId: string, open: boolean) => void;
}) => (
  <div className="card-list">
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
          showActions={showActions}
          variant={variant ? variant(task) : "own"}
          pulsing={pulsingIds?.has(task.id) ?? false}
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

/* ── Main app ─────────────────────────────────────────────── */
export const App = () => {
  const [user, setUser] = useState<UserIdentity>(INITIAL_USER);
  const [tasks, setTasks] = useState<LoanTask[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [namvarHover, setNamvarHover] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<"active" | "all" | "metrics">("active");

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
    returnDate: "",
    notes: "",
    humperdinkLink: "",
    points: 0
  });

  const isAdmin = user.roles.includes("ADMIN");

  useEffect(() => {
    if (!isAdmin && (activeTab === "metrics" || activeTab === "all")) {
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
        };
        applyTheme(context.app?.theme ?? context.theme);
        teamsApp.registerOnThemeChangeHandler?.((theme) => applyTheme(theme));

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
      ...(form.taskType === "OOO" ? { returnDate: form.returnDate } : { urgency: form.urgency }),
      ...(form.taskType !== "OOO" && normalizedLink ? { humperdinkLink: normalizedLink } : {}),
      ...(form.points > 0 ? { points: form.points } : {})
    };

    try {
      await apiRequest<{ task: LoanTask }>("/tasks", { method: "POST", body: JSON.stringify(payload) }, user);
      setForm((c) => ({ ...c, folderName: "", notes: "", returnDate: "", humperdinkLink: "", points: 0 }));
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

  /* Unified visible-task list. CANCELLED is filtered out (still counted
     in admin Metrics). Closed tasks (COMPLETED / ARCHIVED) older than
     CLOSED_TTL_DAYS drop off the bottom — admins can see everything
     ever via the All Tasks tab. Fraud Check claims are gated to
     FILE_CHECKERs in the workflow; the UI just hides the Claim button
     for viewers who can't act. Sort: celebrating (creator-only
     completion milestone) pinned to the very top → OPEN → in-flight →
     closed mini rows, newest-first within each bucket. */
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
      .filter((t) => t.status !== "CANCELLED")
      .filter((t) => {
        if (includeOldClosed) return true;
        if (!CLOSED_STATUSES.includes(t.status)) return true;
        const stamp = t.completedAt ?? t.updatedAt;
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

  const variantForTask = (task: LoanTask): "own" | "watching" | "available" | "completed" => {
    if (CLOSED_STATUSES.includes(task.status)) return "completed";
    if (task.assignee?.id === user.id) return "own";
    if (task.createdBy.id === user.id) return "watching";
    return "available";
  };

  return (
    <main className="app-shell">
      {/* ── Header ──────────────────────────────────── */}
      <header className="top-bar">
        <div className="top-bar-left">
          <h1>Operation Hot Task</h1>
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
        </div>
        {IS_DEV ? (
          <label className="user-picker">
            <span>User:</span>
            <select value={user.id} onChange={(e) => setUser(mockUsers.find((u) => u.id === e.target.value) ?? INITIAL_USER)}>
              {mockUsers.map((u) => (
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
              <label>
                Return Date
                <input
                  type="date"
                  value={form.returnDate}
                  onChange={(e) => setForm((c) => ({ ...c, returnDate: e.target.value }))}
                  required
                />
              </label>
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
      </div>
      )}

      {/* ── Unified task grid ──────────────────────── */}
      {activeTab === "active" && (
        <>
          <CardList
            tasks={unifiedTasks}
            user={user}
            onClaim={onClaim}
            onUnclaim={onUnclaim}
            onTransition={onTransition}
            onAddReviewNote={onAddReviewNote}
            onUpdatePoints={onUpdatePoints}
            showActions={true}
            emptyMessage="No tasks yet."
            variant={variantForTask}
            seenNotesAt={seenNotesAt}
            onMarkNoteSeen={markNoteSeen}
            pulsingIds={pulsingIds}
            expandOverrides={expandOverrides}
            onSetExpand={setExpandOverride}
          />
        </>
      )}

      {/* ── All Tasks (admin) ────────────────────────── */}
      {activeTab === "all" && isAdmin && (
        <>
          <div className="section-head task-grid-head">
            <h2>All Tasks (admin)</h2>
            <span className="section-count">{allTasksAdmin.length} total · no age cutoff</span>
          </div>
          <CardList
            tasks={allTasksAdmin}
            user={user}
            onClaim={onClaim}
            onUnclaim={onUnclaim}
            onTransition={onTransition}
            onAddReviewNote={onAddReviewNote}
            onUpdatePoints={onUpdatePoints}
            showActions={true}
            emptyMessage="No tasks yet."
            variant={variantForTask}
            seenNotesAt={seenNotesAt}
            onMarkNoteSeen={markNoteSeen}
            pulsingIds={pulsingIds}
            expandOverrides={expandOverrides}
            onSetExpand={setExpandOverride}
          />
        </>
      )}

      {/* ── Metrics tab content ─────────────────────── */}
      {activeTab === "metrics" && isAdmin && (
        <MetricsPanel leaderboard={claimsLeaderboard} totals={statusTotals} typeBreakdown={typeBreakdown} />
      )}
    </main>
  );
};
