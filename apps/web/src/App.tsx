import { app as teamsApp } from "@microsoft/teams-js";
import { CreateTaskInput, LoanTask, TaskStatus, TaskType, TASK_TYPES, UrgencyLevel, UserIdentity, USER_ROLES, getNotesFieldLabel, nextFlowStatuses } from "@loan-tasks/shared";
import { FormEvent, Fragment, KeyboardEvent, MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { mockUsers } from "./mockUsers";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";
const INITIAL_USER = mockUsers[0]!;
const RECENT_TASK_CAP = 30;

const CLOSED_STATUSES: TaskStatus[] = ["COMPLETED", "ARCHIVED", "CANCELLED"];
const TASK_TYPE_LABELS: Record<TaskType, string> = {
  LOI: "LOI Check",
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

const URGENCY_STRIPE_CLASS: Record<UrgencyLevel, string> = {
  GREEN: "task-card-urg-green",
  YELLOW: "task-card-urg-yellow",
  ORANGE: "task-card-urg-orange",
  RED: "task-card-urg-red"
};

const apiRequest = async <T,>(path: string, init: RequestInit, user: UserIdentity): Promise<T> => {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-user-id": user.id,
      "x-user-name": user.displayName,
      "x-user-roles": user.roles.join(","),
      ...(init.headers ?? {})
    }
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? "Request failed");
  }

  return data as T;
};

const statusLabel = (status: TaskStatus): string => status.replaceAll("_", " ");

const canUnclaim = (task: LoanTask, user: UserIdentity): boolean => task.status === "CLAIMED" && (task.assignee?.id === user.id || user.roles.includes("ADMIN"));

const isOverdue = (task: LoanTask): boolean => !CLOSED_STATUSES.includes(task.status) && new Date(task.dueAt).getTime() < Date.now();

const formatDate = (iso: string): string => {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
};

const formatCompactDate = (iso?: string): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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

const applyTheme = (theme?: string): void => {
  const normalized = theme === "dark" || theme === "contrast" ? theme : "light";
  document.documentElement.setAttribute("data-theme", normalized);
};

/* ── Status banner helpers ─────────────────────────────────── */
const STATUS_BANNER: Record<string, { label: string; className: string }> = {
  OPEN: { label: "Open", className: "status-banner status-open" },
  CLAIMED: { label: "In Progress", className: "status-banner status-claimed" },
  NEEDS_REVIEW: { label: "In Progress", className: "status-banner status-claimed" },
  MERGE_DONE: { label: "Merge Done", className: "status-banner status-merge" },
  MERGE_APPROVED: { label: "Merge Approved", className: "status-banner status-merge" },
  COMPLETED: { label: "✓ Completed", className: "status-banner status-completed" },
  CANCELLED: { label: "✕ Cancelled", className: "status-banner status-cancelled" },
  ARCHIVED: { label: "Archived", className: "status-banner status-archived" }
};

const firstName = (displayName: string | undefined): string => {
  if (!displayName) return "";
  return displayName.split(/\s+/)[0] ?? displayName;
};

/* Banner adapts to viewer perspective: a creator sees their own OPEN as
   "Pending Claim", and a CLAIMED task in someone else's hands as
   "In Progress · <FirstName>". */
const IN_FLIGHT_STATUSES: TaskStatus[] = ["CLAIMED", "NEEDS_REVIEW", "MERGE_DONE", "MERGE_APPROVED"];

/* LOAN_DOCS has multiple stages between claim and complete. The side banner
   only shows whose-court (CLAIMED vs IN PROGRESS); the actual stage rides
   on the title as a hyphen suffix. */
const stageSuffix = (task: LoanTask): string => {
  if (task.taskType !== "LOAN_DOCS") return "";
  if (task.status === "MERGE_DONE") return " - Merge Done";
  if (task.status === "MERGE_APPROVED") return " - Merge Approved";
  return "";
};

const resolveBanner = (
  task: LoanTask,
  isCreator: boolean,
  isAssignee: boolean
): { label: string; subs?: string[]; className: string } => {
  if (task.status === "OPEN" && isCreator) {
    return { label: "Pending Claim", className: "status-banner status-pending" };
  }
  /* Whose-court banner for any in-flight stage. CLAIMED = your turn,
     IN PROGRESS = waiting on the other party. */
  if (IN_FLIGHT_STATUSES.includes(task.status) && (isAssignee || isCreator)) {
    const otherInCourt =
      (isCreator && !isAssignee && (task.status === "CLAIMED" || task.status === "NEEDS_REVIEW" || task.status === "MERGE_APPROVED")) ||
      (isAssignee && !isCreator && task.status === "MERGE_DONE");
    const otherName = isAssignee
      ? firstName(task.createdBy.displayName)
      : task.assignee
        ? firstName(task.assignee.displayName)
        : "";
    const subs = otherName ? [otherName] : [];
    if (otherInCourt) {
      return { label: "In Progress", subs, className: "status-banner status-claimed" };
    }
    return { label: "Claimed", subs, className: "status-banner status-claimed" };
  }
  return STATUS_BANNER[task.status] ?? { label: "Open", className: "status-banner status-open" };
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
    ? `Shittiness: ${safeCount}/5 — click to rate`
    : `Shittiness: ${safeCount}/5`;

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
            aria-label={`Set shittiness to ${n}`}
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
  onDismiss,
  onUpdatePoints,
  showActions,
  variant,
  hideCollapsedHeader,
  seenNoteAt,
  onMarkNoteSeen
}: {
  task: LoanTask;
  user: UserIdentity;
  onClaim: (taskId: string) => Promise<void>;
  onUnclaim: (taskId: string) => Promise<void>;
  onTransition: (taskId: string, status: TaskStatus, reviewNotes?: string) => Promise<void>;
  onAddReviewNote: (taskId: string, text: string) => Promise<void>;
  onDismiss: (taskId: string) => void;
  onUpdatePoints: (taskId: string, points: number) => Promise<void>;
  showActions: boolean;
  variant: "own" | "watching" | "available" | "completed";
  hideCollapsedHeader?: boolean;
  seenNoteAt?: string;
  onMarkNoteSeen?: (taskId: string, at: string) => void;
}) => {
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState("");
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
  /* Auto-pop tasks the viewer needs to act on:
     - Available list: any OPEN task (browsing to claim)
     - My Tasks: tasks you've claimed (until you transition them) and tasks
       awaiting your approval as creator.
     Unread note from the other party also forces the card open until viewed. */
  const actionableByMe =
    (isAssignee && (task.status === "CLAIMED" || task.status === "NEEDS_REVIEW" || task.status === "MERGE_APPROVED")) ||
    (isCreator && task.status === "MERGE_DONE");
  const autoExpand =
    (task.status === "OPEN" && variant === "available") || actionableByMe;
  const [expanded, setExpanded] = useState(Boolean(hideCollapsedHeader) || autoExpand || hasUnreadNote);
  /* On status change, re-derive expanded from autoExpand (unread keeps it open). */
  useEffect(() => {
    if (hideCollapsedHeader) return;
    setExpanded(autoExpand || hasUnreadNote);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.status]);
  /* New unread note arriving (false -> true) force-opens the card. */
  useEffect(() => {
    if (!hasUnreadNote || hideCollapsedHeader) return;
    setExpanded(true);
  }, [hasUnreadNote, hideCollapsedHeader]);
  /* Acknowledge an unread note: clears force-open + undim lock. Triggered
     by an explicit user gesture (header click/key, or sending a reply) —
     not by auto-open, so the undim state is actually visible. */
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

  const banner = resolveBanner(task, isCreator, isAssignee);
  /* "In someone else's court" — they need to act, you're waiting. Dim. */
  const inOthersCourt =
    (isCreator && !isAssignee && task.status === "CLAIMED") ||
    (isCreator && !isAssignee && task.status === "MERGE_APPROVED") ||
    (isAssignee && !isCreator && task.status === "MERGE_DONE");
  /* Pending claim — your task, nobody picked it up. Dim + shrink. */
  const pendingClaim = isCreator && task.status === "OPEN" && variant !== "available";
  /* An unread note from the other party trumps dimming — surface it. */
  const dimmed = !hasUnreadNote && (inOthersCourt || pendingClaim);
  const isClosed = CLOSED_STATUSES.includes(task.status);
  const cardClass = [
    "task-card",
    !isClosed && task.taskType !== "OOO" ? URGENCY_STRIPE_CLASS[task.urgency] : "",
    !isClosed && dimmed ? "task-card-dimmed" : "",
    pendingClaim ? "task-card-shrunk" : "",
    !isClosed && !dimmed && variant === "watching" && task.status !== "MERGE_DONE" ? "task-card-watching" : "",
    !isClosed && !dimmed && variant === "own" ? "task-card-own" : "",
    isClosed && !isCreator ? "task-card-closed" : "",
    task.status === "COMPLETED" ? "task-card-completed" : "",
    task.status === "CANCELLED" ? "task-card-cancelled" : "",
    task.status === "ARCHIVED" ? "task-card-archived" : ""
  ].filter(Boolean).join(" ");

  const handleHeaderClick = () => {
    acknowledgeUnread();
    setExpanded((e) => !e);
  };
  const handleHeaderKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    acknowledgeUnread();
    setExpanded((v) => !v);
  };
  const stopBubble = (e: ReactMouseEvent) => e.stopPropagation();

  const dueDisplay = task.taskType === "OOO"
    ? `Return ${formatPtDateOnly(task.dueAt)}`
    : formatRelativeDue(task.dueAt, overdue);
  const dueTitle = task.taskType === "OOO" ? undefined : `Due ${formatDate(task.dueAt)}`;
  const urgencyTitle = task.taskType !== "OOO" ? `Urgency: ${URGENCY_LABELS[task.urgency]}` : undefined;

  type QuickAction = { label: string; kind: "good" | "ghost" | "danger" | "default"; run: () => void };
  let primaryAction: QuickAction | null = null;
  if (showActions) {
    if (task.status === "OPEN" && !isCreator) {
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
    } else if ((task.status === "COMPLETED" || task.status === "ARCHIVED") && (isCreator || isAssignee)) {
      primaryAction = { label: "Re-open", kind: "default", run: () => { void onTransition(task.id, "OPEN"); } };
    }
  }
  const quickActionClass = primaryAction
    ? `btn-sm task-card-quick-action${primaryAction.kind === "good" ? " btn-good" : primaryAction.kind === "ghost" ? " btn-ghost" : primaryAction.kind === "danger" ? " btn-danger" : ""}`
    : "";

  return (
    <div className={cardClass}>
      {!hideCollapsedHeader && (
        <div
          className={`task-card-collapsed${expanded ? " task-card-collapsed-open" : ""}`}
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
            {banner.subs?.map((line, i) => (
              <span key={i} className="status-banner-sub">{line}</span>
            ))}
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
          <PoopDisplay
            count={task.points ?? 0}
            canEdit={isCreator && !isClosed}
            onChange={(n) => { void onUpdatePoints(task.id, n); }}
          />
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
      )}
      {expanded && (
        <div className="task-card-expanded">
          <div className="task-card-left">
            <div className="task-card-meta">
              <div>Created: {formatDate(task.createdAt)}</div>
              {task.taskType === "OOO" && <div>Return Date: {formatPtDateOnly(task.dueAt)}</div>}
              {!isCreator && <div>Creator: {task.createdBy.displayName}</div>}
              {task.assignee && !isAssignee && <div>Assignee: {task.assignee.displayName}</div>}
            </div>
            {showActions && (
              <div className="task-card-actions">
                {task.status === "OPEN" && isCreator && (
                  <button type="button" className="btn-sm btn-danger" onClick={() => { acknowledgeUnread(); onTransition(task.id, "CANCELLED"); }}>
                    Cancel Task
                  </button>
                )}
                {canUnclaim(task, user) && (
                  <button type="button" className="btn-sm btn-ghost" onClick={() => { acknowledgeUnread(); onUnclaim(task.id); }}>
                    Unclaim
                  </button>
                )}
                {task.status === "CLAIMED" && isCreator && !isAssignee && (
                  <button type="button" className="btn-sm btn-danger" onClick={() => { acknowledgeUnread(); onTransition(task.id, "CANCELLED"); }}>
                    Cancel
                  </button>
                )}
                {task.status === "MERGE_DONE" && (isCreator || isAssignee) && (
                  <button type="button" className="btn-sm btn-danger" onClick={() => { acknowledgeUnread(); onTransition(task.id, "CANCELLED"); }}>
                    Cancel
                  </button>
                )}
                {task.status === "MERGE_APPROVED" && (isCreator || isAssignee) && (
                  <button type="button" className="btn-sm btn-danger" onClick={() => { acknowledgeUnread(); onTransition(task.id, "CANCELLED"); }}>
                    Cancel
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
  onDismiss,
  onUpdatePoints,
  showActions,
  emptyMessage,
  variant,
  seenNotesAt,
  onMarkNoteSeen
}: {
  tasks: LoanTask[];
  user: UserIdentity;
  onClaim: (taskId: string) => Promise<void>;
  onUnclaim: (taskId: string) => Promise<void>;
  onTransition: (taskId: string, status: TaskStatus, reviewNotes?: string) => Promise<void>;
  onAddReviewNote: (taskId: string, text: string) => Promise<void>;
  onDismiss: (taskId: string) => void;
  onUpdatePoints: (taskId: string, points: number) => Promise<void>;
  showActions: boolean;
  emptyMessage: string;
  variant?: (task: LoanTask) => "own" | "watching" | "available" | "completed";
  seenNotesAt?: Record<string, string>;
  onMarkNoteSeen?: (taskId: string, at: string) => void;
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
          onDismiss={onDismiss}
          onUpdatePoints={onUpdatePoints}
          showActions={showActions}
          variant={variant ? variant(task) : "own"}
          {...(seenNotesAt?.[task.id] !== undefined ? { seenNoteAt: seenNotesAt[task.id] } : {})}
          {...(onMarkNoteSeen ? { onMarkNoteSeen } : {})}
        />
      ))
    )}
  </div>
);

const RecentActivityTable = ({
  tasks,
  expandedTaskId,
  onToggleRow,
  user,
  onClaim,
  onUnclaim,
  onTransition,
  onAddReviewNote,
  onDismiss,
  onUpdatePoints,
  variantForTask
}: {
  tasks: LoanTask[];
  expandedTaskId: string | null;
  onToggleRow: (taskId: string) => void;
  user: UserIdentity;
  onClaim: (taskId: string) => Promise<void>;
  onUnclaim: (taskId: string) => Promise<void>;
  onTransition: (taskId: string, status: TaskStatus, reviewNotes?: string) => Promise<void>;
  onAddReviewNote: (taskId: string, text: string) => Promise<void>;
  onDismiss: (taskId: string) => void;
  onUpdatePoints: (taskId: string, points: number) => Promise<void>;
  variantForTask: (task: LoanTask) => "own" | "watching" | "available" | "completed";
}) => {
  if (tasks.length === 0) {
    return <div className="empty-card">No recent tasks yet.</div>;
  }

  const onRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, taskId: string): void => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onToggleRow(taskId);
  };

  return (
    <div className="recent-activity-wrap">
      <table className="recent-activity-table">
        <thead>
          <tr>
            <th scope="col">Task Name</th>
            <th scope="col">Status</th>
            <th scope="col">Type</th>
            <th scope="col">Creator</th>
            <th scope="col">Assignee</th>
            <th scope="col">Date Created</th>
            <th scope="col">Date Completed</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task, index) => {
            const isExpanded = expandedTaskId === task.id;
            const isClosed = CLOSED_STATUSES.includes(task.status);
            const detailId = `recent-detail-${task.id}`;

            return (
              <Fragment key={task.id}>
                <tr
                  role="button"
                  tabIndex={0}
                  className={`recent-row ${index % 2 === 1 ? "recent-row-alt" : ""} ${isClosed ? "recent-row-closed" : "recent-row-active"}${isExpanded ? " recent-row-expanded" : ""}`}
                  aria-expanded={isExpanded}
                  aria-controls={detailId}
                  onClick={() => onToggleRow(task.id)}
                  onKeyDown={(event) => onRowKeyDown(event, task.id)}
                >
                  <td className="recent-cell-task" title={task.folderName}>
                    {task.taskType !== "OOO" && task.humperdinkLink ? (
                      <a
                        href={task.humperdinkLink}
                        target="_blank"
                        rel="noreferrer"
                        title={`Open Humperdink link for ${task.folderName}`}
                        onClick={(event) => event.stopPropagation()}
                      >
                        {task.folderName}
                      </a>
                    ) : (
                      task.folderName
                    )}
                  </td>
                  <td>{statusLabel(task.status)}</td>
                  <td>{TASK_TYPE_LABELS[task.taskType]}</td>
                  <td title={task.createdBy.displayName}>{task.createdBy.displayName}</td>
                  <td title={task.assignee?.displayName ?? "Unassigned"}>{task.assignee?.displayName ?? "Unassigned"}</td>
                  <td>{formatCompactDate(task.createdAt)}</td>
                  <td>{formatCompactDate(task.completedAt)}</td>
                </tr>
                {isExpanded && (
                  <tr id={detailId} className="recent-detail-row">
                    <td colSpan={7}>
                      <TaskCard
                        task={task}
                        user={user}
                        onClaim={onClaim}
                        onUnclaim={onUnclaim}
                        onTransition={onTransition}
                        onAddReviewNote={onAddReviewNote}
                        onDismiss={onDismiss}
                        onUpdatePoints={onUpdatePoints}
                        showActions={true}
                        variant={variantForTask(task)}
                        hideCollapsedHeader
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

/* ── Metrics Panel ────────────────────────────────────────── */
const TYPE_BAR_CLASS: Record<TaskType, string> = {
  LOI: "type-bar type-bar-brand",
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
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [expandedRecentTaskId, setExpandedRecentTaskId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"active" | "archived" | "metrics">("active");

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
  /* When the active user changes (mock user picker), reset the in-memory
     map to that user's stored data BEFORE the writer effect runs — so we
     don't clobber B's localStorage with A's seen state. setState during
     render is the React-supported way to derive state from a changing prop. */
  const [trackedUserId, setTrackedUserId] = useState(user.id);
  if (trackedUserId !== user.id) {
    setTrackedUserId(user.id);
    setSeenNotesAt(loadSeenNotes(user.id));
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
    if (!isAdmin && activeTab === "metrics") {
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
      })
      .catch(() => {
        applyTheme("light");
      });
  }, []);

  useEffect(() => {
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

  const onDismiss = (taskId: string): void => {
    setDismissedIds((prev) => new Set(prev).add(taskId));
  };

  /*
   * My Tasks:
   *  - Tasks assigned to me (any active status)
   *  - Tasks I created that aren't ARCHIVED or CANCELLED (includes OPEN, CLAIMED by others, NEEDS_REVIEW, COMPLETED)
   */
  const myTasks = useMemo(
    () => tasks.filter((t) => {
      if (t.status === "ARCHIVED" || t.status === "CANCELLED") return false;
      if (dismissedIds.has(t.id)) return false;
      // Assignee (non-creator) stops seeing completed tasks
      if (t.status === "COMPLETED" && t.assignee?.id === user.id && t.createdBy.id !== user.id) return false;
      if (t.assignee?.id === user.id) return true;
      if (t.createdBy.id === user.id) return true;
      return false;
    }),
    [tasks, user.id, dismissedIds]
  );

  /*
   * Available Tasks: OPEN status, excluding tasks the user created (those are in My Tasks).
   * Fraud Check tasks only visible to FILE_CHECKER users.
   */
  const availableTasks = useMemo(
    () => tasks.filter((t) => {
      if (t.status !== "OPEN") return false;
      if (t.createdBy.id === user.id) return false;
      if (t.taskType === "FRAUD" && !user.roles.includes("FILE_CHECKER")) return false;
      return true;
    }),
    [tasks, user.id, user.roles]
  );

  const archivedTasks = useMemo(
    () => tasks.filter((t) => t.status === "ARCHIVED" || t.status === "CANCELLED"),
    [tasks]
  );

  const activeTasks = useMemo(
    () => tasks.filter((t) => !CLOSED_STATUSES.includes(t.status)),
    [tasks]
  );

  const recentTasks = useMemo(() => {
    const active = tasks
      .filter((t) => !CLOSED_STATUSES.includes(t.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const closed = tasks
      .filter((t) => CLOSED_STATUSES.includes(t.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return [...active, ...closed].slice(0, RECENT_TASK_CAP);
  }, [tasks]);

  useEffect(() => {
    if (!expandedRecentTaskId) return;
    if (!recentTasks.some((task) => task.id === expandedRecentTaskId)) {
      setExpandedRecentTaskId(null);
    }
  }, [recentTasks, expandedRecentTaskId]);

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

  const myTaskVariant = (task: LoanTask): "own" | "watching" | "available" | "completed" => {
    if (task.assignee?.id === user.id) return "own";
    if (task.createdBy.id === user.id) return "watching";
    return "own";
  };

  /* My Tasks order: completed (archive) → actionable by me → other's court → pending claim. */
  const sortedMyTasks = useMemo(() => {
    const bucket = (t: LoanTask): number => {
      const isCreator = t.createdBy.id === user.id;
      const isAssignee = t.assignee?.id === user.id;
      if (t.status === "COMPLETED") return 0;
      if (isCreator && t.status === "MERGE_DONE") return 1;
      if (isAssignee && (t.status === "CLAIMED" || t.status === "NEEDS_REVIEW" || t.status === "MERGE_APPROVED")) return 1;
      if (isCreator && t.status === "OPEN") return 3;
      return 2;
    };
    return [...myTasks].sort((a, b) => {
      const diff = bucket(a) - bucket(b);
      if (diff !== 0) return diff;
      return a.dueAt.localeCompare(b.dueAt);
    });
  }, [myTasks, user.id]);

  const recentTaskVariant = (task: LoanTask): "own" | "watching" | "available" | "completed" => {
    if (task.assignee?.id === user.id) return "own";
    if (task.createdBy.id === user.id) return "watching";
    if (CLOSED_STATUSES.includes(task.status)) return "completed";
    return "available";
  };

  const onToggleRecentTask = (taskId: string): void => {
    setExpandedRecentTaskId((current) => (current === taskId ? null : taskId));
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
      </header>

      {error && <p className="error-bar">{error}</p>}

      {formOpen && (
        <div className="form-panel">
          <form className="task-form" onSubmit={onCreateTask}>
            <label>
              {form.taskType === "OOO" ? "Vacation Description" : "Folder Name"}
              <input value={form.folderName} onChange={(e) => setForm((c) => ({ ...c, folderName: e.target.value }))} required />
            </label>
            <label>
              Type
              <select value={form.taskType} onChange={(e) => setForm((c) => ({ ...c, taskType: e.target.value as TaskType }))}>
                <option value="LOI">LOI Check</option>
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
            <label className="span-full">
              {getNotesFieldLabel(form.taskType)}
              <textarea rows={2} value={form.notes} onChange={(e) => setForm((c) => ({ ...c, notes: e.target.value }))} required />
            </label>
            {form.taskType !== "OOO" && (
              <label>
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
            <label>
              Shittiness <span className="form-hint">(poop score 1–5)</span>
              <span className="poop-picker poop-picker-form">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`poop-pick${n <= form.points ? " poop-pick-on" : ""}`}
                    onClick={() => setForm((c) => ({ ...c, points: c.points === n ? 0 : n }))}
                    aria-label={`${n} poop${n === 1 ? "" : "s"}`}
                    aria-pressed={n <= form.points}
                  >
                    💩
                  </button>
                ))}
                {form.points > 0 && (
                  <button
                    type="button"
                    className="poop-pick-cancel"
                    onClick={() => setForm((c) => ({ ...c, points: 0 }))}
                    aria-label="Clear"
                  >
                    ×
                  </button>
                )}
              </span>
            </label>
            <div className="form-actions">
              <button type="button" className="btn-ghost" onClick={() => setFormOpen(false)}>Cancel</button>
              <button type="submit">Create Task</button>
            </div>
          </form>
        </div>
      )}

      {/* ── Tab bar ─────────────────────────────────── */}
      <div className="tab-bar">
        <button
          type="button"
          className={`tab-btn${activeTab === "active" ? " tab-active" : ""}`}
          onClick={() => setActiveTab("active")}
        >
          Active
          <span className="section-count">{activeTasks.length}</span>
        </button>
        <button
          type="button"
          className={`tab-btn${activeTab === "archived" ? " tab-active" : ""}`}
          onClick={() => setActiveTab("archived")}
        >
          Archived
          <span className="section-count">{archivedTasks.length}</span>
        </button>
        {isAdmin && (
          <button
            type="button"
            className={`tab-btn${activeTab === "metrics" ? " tab-active" : ""}`}
            onClick={() => setActiveTab("metrics")}
          >
            Metrics
          </button>
        )}
      </div>

      {/* ── Active tab content ──────────────────────── */}
      {activeTab === "active" && (
        <>
          <div className="section-head">
            <h2>My Tasks</h2>
            <span className="section-count">{myTasks.length}</span>
          </div>
          <CardList
            tasks={sortedMyTasks}
            user={user}
            onClaim={onClaim}
            onUnclaim={onUnclaim}
            onTransition={onTransition}
            onAddReviewNote={onAddReviewNote}
            onDismiss={onDismiss}
            onUpdatePoints={onUpdatePoints}
            showActions={true}
            emptyMessage="No tasks assigned to you."
            variant={myTaskVariant}
            seenNotesAt={seenNotesAt}
            onMarkNoteSeen={markNoteSeen}
          />

          {availableTasks.length > 0 && (
            <>
              <div className="section-head">
                <h2>Available Tasks</h2>
                <span className="section-count">{availableTasks.length}</span>
              </div>
              <CardList
                tasks={availableTasks}
                user={user}
                onClaim={onClaim}
                onUnclaim={onUnclaim}
                onTransition={onTransition}
                onAddReviewNote={onAddReviewNote}
                onDismiss={onDismiss}
                onUpdatePoints={onUpdatePoints}
                showActions={true}
                emptyMessage="No open tasks available."
                variant={() => "available"}
              />
            </>
          )}

          <div className="section-head">
            <h2>Recent Task Activity</h2>
            <span className="section-count">{recentTasks.length}</span>
          </div>
          <RecentActivityTable
            tasks={recentTasks}
            expandedTaskId={expandedRecentTaskId}
            onToggleRow={onToggleRecentTask}
            user={user}
            onClaim={onClaim}
            onUnclaim={onUnclaim}
            onTransition={onTransition}
            onAddReviewNote={onAddReviewNote}
            onDismiss={onDismiss}
            onUpdatePoints={onUpdatePoints}
            variantForTask={recentTaskVariant}
          />
        </>
      )}

      {/* ── Archived tab content ──────────────────────── */}
      {activeTab === "archived" && (
        <>
          <div className="section-head">
            <h2>Archived / Cancelled</h2>
            <span className="section-count">{archivedTasks.length}</span>
          </div>
          <CardList
            tasks={archivedTasks}
            user={user}
            onClaim={onClaim}
            onUnclaim={onUnclaim}
            onTransition={onTransition}
            onAddReviewNote={onAddReviewNote}
            onDismiss={onDismiss}
            onUpdatePoints={onUpdatePoints}
            showActions={true}
            emptyMessage="No archived tasks yet."
            variant={() => "completed"}
          />
        </>
      )}

      {/* ── Metrics tab content ─────────────────────── */}
      {activeTab === "metrics" && isAdmin && (
        <MetricsPanel leaderboard={claimsLeaderboard} totals={statusTotals} typeBreakdown={typeBreakdown} />
      )}

      {/* ── Footer ──────────────────────────────────── */}
      <footer className="footer-note">
        Roles: {USER_ROLES.join(", ")} &middot; Reminders: hourly, business hours 8:30a&ndash;5:30p PT
      </footer>
    </main>
  );
};
