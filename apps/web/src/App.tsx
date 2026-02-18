import { app as teamsApp } from "@microsoft/teams-js";
import { CreateTaskInput, LoanTask, TaskStatus, TaskType, UrgencyLevel, UserIdentity, USER_ROLES, nextFlowStatuses } from "@loan-tasks/shared";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { mockUsers } from "./mockUsers";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";
const INITIAL_USER = mockUsers[0]!;

const CLOSED_STATUSES: TaskStatus[] = ["COMPLETED", "ARCHIVED", "CANCELLED"];
const TASK_TYPE_LABELS: Record<TaskType, string> = {
  LOI: "LOI",
  VALUE: "Value",
  FRAUD: "Fraud",
  LOAN_DOCS: "Docs"
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

/* ── Task Card ────────────────────────────────────────────── */
const TaskCard = ({
  task,
  user,
  onClaim,
  onUnclaim,
  onTransition,
  showActions
}: {
  task: LoanTask;
  user: UserIdentity;
  onClaim: (taskId: string) => Promise<void>;
  onUnclaim: (taskId: string) => Promise<void>;
  onTransition: (taskId: string, status: TaskStatus, reviewNotes?: string) => Promise<void>;
  showActions: boolean;
}) => {
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewText, setReviewText] = useState("");
  const overdue = isOverdue(task);
  const transitions = nextFlowStatuses(task).filter((s) => s !== "OPEN");

  const handleFlagReview = () => {
    setReviewOpen(true);
    setReviewText("");
  };

  const handleSubmitReview = async () => {
    if (!reviewText.trim()) return;
    await onTransition(task.id, "NEEDS_REVIEW", reviewText.trim());
    setReviewOpen(false);
    setReviewText("");
  };

  const handleCancelReview = () => {
    setReviewOpen(false);
    setReviewText("");
  };

  return (
    <div className="task-card">
      <div className="task-card-left">
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
          <span className={overdue ? "tag tag-overdue" : "tag tag-status"}>
            {statusLabel(task.status)}
            {overdue && " !"}
          </span>
        </div>
        <div className="task-card-meta">
          {task.serverLocation && <div>Folder: {task.serverLocation}</div>}
          <div>Creator: {task.createdBy.displayName}</div>
          {task.assignee && <div>Assignee: {task.assignee.displayName}</div>}
        </div>
        {showActions && (
          <div className="task-card-actions">
            {task.status === "OPEN" && (
              <button type="button" className="btn-sm btn-good" onClick={() => onClaim(task.id)}>
                Claim
              </button>
            )}
            {canUnclaim(task, user) && (
              <button type="button" className="btn-sm btn-ghost" onClick={() => onUnclaim(task.id)}>
                Unclaim
              </button>
            )}
            {task.status === "CLAIMED" && (
              <>
                <button type="button" className="btn-sm btn-warn" onClick={handleFlagReview}>
                  Flag for Review
                </button>
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
            {task.status === "NEEDS_REVIEW" && (
              <>
                <button type="button" className="btn-sm" onClick={() => onTransition(task.id, "CLAIMED")}>
                  Return to Work
                </button>
                <button type="button" className="btn-sm btn-good" onClick={() => onTransition(task.id, "COMPLETED")}>
                  Complete
                </button>
                <button type="button" className="btn-sm btn-danger" onClick={() => onTransition(task.id, "CANCELLED")}>
                  Cancel
                </button>
              </>
            )}
            {task.status === "MERGE_DONE" && (
              <>
                <button type="button" className="btn-sm btn-good" onClick={() => onTransition(task.id, "MERGE_APPROVED")}>
                  Approve Merge
                </button>
                <button type="button" className="btn-sm btn-danger" onClick={() => onTransition(task.id, "CANCELLED")}>
                  Cancel
                </button>
              </>
            )}
            {task.status === "MERGE_APPROVED" && (
              <>
                <button type="button" className="btn-sm btn-good" onClick={() => onTransition(task.id, "COMPLETED")}>
                  Complete
                </button>
                <button type="button" className="btn-sm btn-danger" onClick={() => onTransition(task.id, "CANCELLED")}>
                  Cancel
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div className="task-card-right">
        <div className="task-card-notes">{task.notes}</div>
        {task.reviewNotes && (
          <div className="task-card-review">
            <strong>Review Notes</strong>
            <p>{task.reviewNotes}</p>
          </div>
        )}
        {reviewOpen && (
          <div className="review-note-input">
            <textarea
              rows={3}
              placeholder="Describe what needs review..."
              value={reviewText}
              onChange={(e) => setReviewText(e.target.value)}
              autoFocus
            />
            <div className="review-note-actions">
              <button type="button" className="btn-sm btn-ghost" onClick={handleCancelReview}>Cancel</button>
              <button type="button" className="btn-sm btn-warn" onClick={handleSubmitReview} disabled={!reviewText.trim()}>Submit</button>
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
  showActions,
  emptyMessage
}: {
  tasks: LoanTask[];
  user: UserIdentity;
  onClaim: (taskId: string) => Promise<void>;
  onUnclaim: (taskId: string) => Promise<void>;
  onTransition: (taskId: string, status: TaskStatus, reviewNotes?: string) => Promise<void>;
  showActions: boolean;
  emptyMessage: string;
}) => (
  <div className="card-list">
    {tasks.length === 0 ? (
      <div className="empty-card">{emptyMessage}</div>
    ) : (
      tasks.map((task) => (
        <TaskCard key={task.id} task={task} user={user} onClaim={onClaim} onUnclaim={onUnclaim} onTransition={onTransition} showActions={showActions} />
      ))
    )}
  </div>
);

/* ── Main app ─────────────────────────────────────────────── */
export const App = () => {
  const [user, setUser] = useState<UserIdentity>(INITIAL_USER);
  const [tasks, setTasks] = useState<LoanTask[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<string[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"active" | "completed">("active");

  const [form, setForm] = useState({
    loanName: "",
    taskType: "LOI" as TaskType,
    urgency: "GREEN" as UrgencyLevel,
    notes: "",
    humperdinkLink: "",
    serverLocation: ""
  });

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
      setNotifications((current) => [`${incoming.loanName} \u2192 ${statusLabel(incoming.status)}`, ...current].slice(0, 5));
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

  /* My Tasks: tasks assigned to me (active), or tasks I created that are NEEDS_REVIEW or COMPLETED */
  const myTasks = useMemo(
    () => tasks.filter((t) => {
      if (CLOSED_STATUSES.includes(t.status)) return false;
      if (t.assignee?.id === user.id) return true;
      if (t.createdBy.id === user.id && (t.status === "NEEDS_REVIEW" || t.status === "COMPLETED")) return true;
      return false;
    }),
    [tasks, user.id]
  );

  /* Available Tasks: OPEN status */
  const availableTasks = useMemo(
    () => tasks.filter((t) => t.status === "OPEN"),
    [tasks]
  );

  const completedTasks = useMemo(
    () => tasks.filter((t) => CLOSED_STATUSES.includes(t.status)),
    [tasks]
  );

  const activeTasks = useMemo(
    () => tasks.filter((t) => !CLOSED_STATUSES.includes(t.status)),
    [tasks]
  );

  const stats = useMemo(() => ({
    total: tasks.length,
    active: activeTasks.length,
    completed: completedTasks.length,
    overdue: tasks.filter(isOverdue).length
  }), [tasks, activeTasks, completedTasks]);

  return (
    <main className="app-shell">
      {/* ── Header ──────────────────────────────────── */}
      <header className="top-bar">
        <div className="top-bar-left">
          <h1>Loan Tasks</h1>
          <div className="top-bar-stats">
            <span><span className="stat-label">Active</span>{stats.active}</span>
            <span><span className="stat-label">Done</span>{stats.completed}</span>
            {stats.overdue > 0 && (
              <span className="stat-warn"><span className="stat-label">Overdue</span>{stats.overdue}</span>
            )}
          </div>
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

      {/* ── Notifications (inline chips) ────────────── */}
      {notifications.length > 0 && (
        <div className="notif-bar">
          {notifications.map((msg, i) => (
            <span className="notif-chip" key={`${msg}-${i}`}>
              <span className="notif-dot" />
              {msg}
            </span>
          ))}
        </div>
      )}

      {error && <p className="error-bar">{error}</p>}

      {/* ── Create form toggle ──────────────────────── */}
      <div>
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
          className={`tab-btn${activeTab === "completed" ? " tab-active" : ""}`}
          onClick={() => setActiveTab("completed")}
        >
          Completed
          <span className="section-count">{completedTasks.length}</span>
        </button>
      </div>

      {/* ── Active tab content ──────────────────────── */}
      {activeTab === "active" && (
        <>
          <div className="section-head">
            <h2>My Tasks</h2>
            <span className="section-count">{myTasks.length}</span>
          </div>
          <CardList tasks={myTasks} user={user} onClaim={onClaim} onUnclaim={onUnclaim} onTransition={onTransition} showActions={true} emptyMessage="No tasks assigned to you." />

          <div className="section-head">
            <h2>Available Tasks</h2>
            <span className="section-count">{availableTasks.length}</span>
          </div>
          <CardList tasks={availableTasks} user={user} onClaim={onClaim} onUnclaim={onUnclaim} onTransition={onTransition} showActions={true} emptyMessage="No open tasks available." />
        </>
      )}

      {/* ── Completed tab content ───────────────────── */}
      {activeTab === "completed" && (
        <>
          <div className="section-head">
            <h2>Completed / Archived / Cancelled</h2>
            <span className="section-count">{completedTasks.length}</span>
          </div>
          <CardList tasks={completedTasks} user={user} onClaim={onClaim} onUnclaim={onUnclaim} onTransition={onTransition} showActions={false} emptyMessage="No completed tasks yet." />
        </>
      )}

      {/* ── Footer ──────────────────────────────────── */}
      <footer className="footer-note">
        Roles: {USER_ROLES.join(", ")} &middot; Reminders: hourly, business hours 8:30a&ndash;5:30p PT
      </footer>
    </main>
  );
};
