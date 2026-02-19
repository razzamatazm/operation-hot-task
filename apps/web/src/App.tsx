import { app as teamsApp } from "@microsoft/teams-js";
import { CreateTaskInput, LoanTask, TaskStatus, TaskType, TASK_TYPES, UrgencyLevel, UserIdentity, USER_ROLES, nextFlowStatuses } from "@loan-tasks/shared";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { mockUsers } from "./mockUsers";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";
const INITIAL_USER = mockUsers[0]!;

const CLOSED_STATUSES: TaskStatus[] = ["COMPLETED", "ARCHIVED", "CANCELLED"];
const TASK_TYPE_LABELS: Record<TaskType, string> = {
  LOI: "LOI Check",
  VALUE: "Value Check",
  FRAUD: "Fraud Check",
  LOAN_DOCS: "Loan Docs"
};

const URGENCY_LABELS: Record<UrgencyLevel, string> = {
  GREEN: "Anytime",
  YELLOW: "End of Day",
  ORANGE: "1 Hour",
  RED: "Urgent"
};

const URGENCY_TAG_CLASS: Record<UrgencyLevel, string> = {
  GREEN: "tag tag-green",
  YELLOW: "tag tag-yellow",
  ORANGE: "tag tag-orange",
  RED: "tag tag-red"
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

const applyTheme = (theme?: string): void => {
  const normalized = theme === "dark" || theme === "contrast" ? theme : "light";
  document.documentElement.setAttribute("data-theme", normalized);
};

/* ── Urgency Tag ──────────────────────────────────────────── */
const UrgencyTag = ({ urgency }: { urgency: UrgencyLevel }) => (
  <span className={URGENCY_TAG_CLASS[urgency]}>
    <span className="tag-dot" />
    {URGENCY_LABELS[urgency]}
  </span>
);

/* ── Status banner helpers ─────────────────────────────────── */
const STATUS_BANNER: Record<string, { label: string; className: string }> = {
  OPEN: { label: "Open", className: "status-banner status-open" },
  CLAIMED: { label: "In Progress", className: "status-banner status-claimed" },
  NEEDS_REVIEW: { label: "In Progress", className: "status-banner status-claimed" },
  MERGE_DONE: { label: "Merge Done — Awaiting Approval", className: "status-banner status-merge" },
  MERGE_APPROVED: { label: "Merge Approved", className: "status-banner status-merge" },
  COMPLETED: { label: "Completed", className: "status-banner status-completed" },
  CANCELLED: { label: "Cancelled", className: "status-banner status-cancelled" },
  ARCHIVED: { label: "Archived", className: "status-banner status-completed" }
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
  showActions,
  variant
}: {
  task: LoanTask;
  user: UserIdentity;
  onClaim: (taskId: string) => Promise<void>;
  onUnclaim: (taskId: string) => Promise<void>;
  onTransition: (taskId: string, status: TaskStatus, reviewNotes?: string) => Promise<void>;
  onAddReviewNote: (taskId: string, text: string) => Promise<void>;
  onDismiss: (taskId: string) => void;
  showActions: boolean;
  variant: "own" | "watching" | "available" | "completed";
}) => {
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState("");
  const overdue = isOverdue(task);
  const transitions = nextFlowStatuses(task).filter((s) => s !== "OPEN");
  const isAssignee = task.assignee?.id === user.id;
  const isCreator = task.createdBy.id === user.id;

  const handleSubmitNote = async () => {
    if (!noteText.trim()) return;
    await onAddReviewNote(task.id, noteText.trim());
    setNoteOpen(false);
    setNoteText("");
  };

  const banner = STATUS_BANNER[task.status] ?? { label: "Open", className: "status-banner status-open" };
  /* Dim when waiting on the other party to act */
  const waitingOnOther =
    (isCreator && !isAssignee && task.status === "CLAIMED") ||
    (isCreator && !isAssignee && task.status === "MERGE_APPROVED") ||
    (isAssignee && !isCreator && task.status === "MERGE_DONE");
  const isClosed = CLOSED_STATUSES.includes(task.status);
  const cardClass = [
    "task-card",
    !isClosed && waitingOnOther ? "task-card-dimmed" : "",
    !isClosed && !waitingOnOther && variant === "watching" && task.status !== "MERGE_DONE" ? "task-card-watching" : "",
    !isClosed && !waitingOnOther && variant === "own" ? "task-card-own" : "",
    isClosed && !isCreator ? "task-card-closed" : ""
  ].filter(Boolean).join(" ");

  return (
    <div className={cardClass}>
      <div className="task-card-left">
        <div className={banner.className}>{banner.label}</div>
        <div className="task-card-title">
          {task.humperdinkLink ? (
            <a href={task.humperdinkLink} target="_blank" rel="noreferrer">{task.loanName}</a>
          ) : (
            task.loanName
          )}
        </div>
        <div className="task-card-tags">
          <span className="tag tag-type">{TASK_TYPE_LABELS[task.taskType]}</span>
          <UrgencyTag urgency={task.urgency} />
          {overdue && <span className="tag tag-overdue">Overdue</span>}
        </div>
        <div className="task-card-meta">
          <div>Created: {formatDate(task.createdAt)}</div>
          {task.serverLocation && <div>Folder: {task.serverLocation}</div>}
          <div>Creator: {task.createdBy.displayName}</div>
          {task.assignee && <div>Assignee: {task.assignee.displayName}</div>}
          {variant === "watching" && (
            <div className="task-card-watching-label">You created this task</div>
          )}
        </div>
        {showActions && (
          <div className="task-card-actions">
            {/* OPEN: others can Claim, creator can Cancel */}
            {task.status === "OPEN" && !isCreator && (
              <button type="button" className="btn-sm btn-good" onClick={() => onClaim(task.id)}>
                Claim
              </button>
            )}
            {task.status === "OPEN" && isCreator && (
              <button type="button" className="btn-sm btn-danger" onClick={() => onTransition(task.id, "CANCELLED")}>
                Cancel Task
              </button>
            )}
            {/* CLAIMED: assignee can Unclaim, Complete/Merge Done; creator can only Cancel */}
            {canUnclaim(task, user) && (
              <button type="button" className="btn-sm btn-ghost" onClick={() => onUnclaim(task.id)}>
                Unclaim
              </button>
            )}
            {task.status === "CLAIMED" && isAssignee && (
              <>
                {task.taskType === "LOAN_DOCS" && transitions.includes("MERGE_DONE") ? (
                  <button type="button" className="btn-sm btn-good" onClick={() => onTransition(task.id, "MERGE_DONE")}>
                    Mark Merge Done
                  </button>
                ) : transitions.includes("COMPLETED") ? (
                  <button type="button" className="btn-sm btn-good" onClick={() => onTransition(task.id, "COMPLETED")}>
                    Complete
                  </button>
                ) : null}
              </>
            )}
            {task.status === "CLAIMED" && isCreator && !isAssignee && (
              <button type="button" className="btn-sm btn-danger" onClick={() => onTransition(task.id, "CANCELLED")}>
                Cancel
              </button>
            )}
            {/* MERGE_DONE: creator can Approve, anyone involved can Cancel */}
            {task.status === "MERGE_DONE" && isCreator && (
              <button type="button" className="btn-sm btn-good" onClick={() => onTransition(task.id, "MERGE_APPROVED")}>
                Approve Merge
              </button>
            )}
            {task.status === "MERGE_DONE" && (isCreator || isAssignee) && (
              <button type="button" className="btn-sm btn-danger" onClick={() => onTransition(task.id, "CANCELLED")}>
                Cancel
              </button>
            )}
            {/* MERGE_APPROVED: assignee can Complete, anyone involved can Cancel */}
            {task.status === "MERGE_APPROVED" && isAssignee && (
              <button type="button" className="btn-sm btn-good" onClick={() => onTransition(task.id, "COMPLETED")}>
                Complete
              </button>
            )}
            {task.status === "MERGE_APPROVED" && (isCreator || isAssignee) && (
              <button type="button" className="btn-sm btn-danger" onClick={() => onTransition(task.id, "CANCELLED")}>
                Cancel
              </button>
            )}
            {/* COMPLETED: creator can Archive */}
            {task.status === "COMPLETED" && isCreator && (
              <button type="button" className="btn-sm btn-ghost" onClick={() => onTransition(task.id, "ARCHIVED")}>
                Archive
              </button>
            )}
            {/* COMPLETED/ARCHIVED: either party can re-open */}
            {(task.status === "COMPLETED" || task.status === "ARCHIVED") && (isCreator || isAssignee) && (
              <button type="button" className="btn-sm" onClick={() => onTransition(task.id, "OPEN")}>
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
            {task.reviewNotes.map((note, i) => (
              <div key={i} className="review-thread-entry">
                <span className="review-thread-author">{note.by.displayName}</span>
                <span className="review-thread-time">{formatDate(note.at)}</span>
                <p>{note.text}</p>
              </div>
            ))}
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
  showActions,
  emptyMessage,
  variant
}: {
  tasks: LoanTask[];
  user: UserIdentity;
  onClaim: (taskId: string) => Promise<void>;
  onUnclaim: (taskId: string) => Promise<void>;
  onTransition: (taskId: string, status: TaskStatus, reviewNotes?: string) => Promise<void>;
  onAddReviewNote: (taskId: string, text: string) => Promise<void>;
  onDismiss: (taskId: string) => void;
  showActions: boolean;
  emptyMessage: string;
  variant?: (task: LoanTask) => "own" | "watching" | "available" | "completed";
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
          showActions={showActions}
          variant={variant ? variant(task) : "own"}
        />
      ))
    )}
  </div>
);

/* ── Metrics Panel ────────────────────────────────────────── */
const TYPE_BAR_CLASS: Record<TaskType, string> = {
  LOI: "type-bar type-bar-brand",
  VALUE: "type-bar type-bar-good",
  FRAUD: "type-bar type-bar-bad",
  LOAN_DOCS: "type-bar type-bar-hot"
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
  const [activeTab, setActiveTab] = useState<"active" | "archived" | "metrics">("active");

  const [form, setForm] = useState({
    loanName: "",
    taskType: "LOI" as TaskType,
    urgency: "GREEN" as UrgencyLevel,
    notes: "",
    humperdinkLink: "",
    serverLocation: ""
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
    const payload: CreateTaskInput = {
      loanName: form.loanName,
      taskType: form.taskType,
      urgency: form.urgency,
      notes: form.notes,
      ...(form.humperdinkLink ? { humperdinkLink: form.humperdinkLink } : {}),
      ...(form.serverLocation ? { serverLocation: form.serverLocation } : {})
    };

    try {
      await apiRequest<{ task: LoanTask }>("/tasks", { method: "POST", body: JSON.stringify(payload) }, user);
      setForm((c) => ({ ...c, loanName: "", notes: "", humperdinkLink: "", serverLocation: "" }));
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
              Loan Name
              <input value={form.loanName} onChange={(e) => setForm((c) => ({ ...c, loanName: e.target.value }))} required />
            </label>
            <label>
              Type
              <select value={form.taskType} onChange={(e) => setForm((c) => ({ ...c, taskType: e.target.value as TaskType }))}>
                <option value="LOI">LOI Check</option>
                <option value="VALUE">Value Check</option>
                <option value="FRAUD">Fraud Check</option>
                <option value="LOAN_DOCS">Loan Docs</option>
              </select>
            </label>
            <label>
              Urgency
              <select value={form.urgency} onChange={(e) => setForm((c) => ({ ...c, urgency: e.target.value as UrgencyLevel }))}>
                <option value="GREEN">Anytime</option>
                <option value="YELLOW">End of Day</option>
                <option value="ORANGE">Within 1 Hour</option>
                <option value="RED">Urgent Now</option>
              </select>
            </label>
            <label className="span-full">
              Notes
              <textarea rows={2} value={form.notes} onChange={(e) => setForm((c) => ({ ...c, notes: e.target.value }))} required />
            </label>
            <label>
              Humperdink Link
              <input type="url" placeholder="Optional" value={form.humperdinkLink} onChange={(e) => setForm((c) => ({ ...c, humperdinkLink: e.target.value }))} />
            </label>
            <label>
              Folder Name
              <input placeholder="Optional" value={form.serverLocation} onChange={(e) => setForm((c) => ({ ...c, serverLocation: e.target.value }))} />
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
            tasks={myTasks}
            user={user}
            onClaim={onClaim}
            onUnclaim={onUnclaim}
            onTransition={onTransition}
            onAddReviewNote={onAddReviewNote}
            onDismiss={onDismiss}
            showActions={true}
            emptyMessage="No tasks assigned to you."
            variant={myTaskVariant}
          />

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
            showActions={true}
            emptyMessage="No open tasks available."
            variant={() => "available"}
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
