import { app as teamsApp } from "@microsoft/teams-js";
import { CreateTaskInput, LoanTask, TaskStatus, TaskType, UrgencyLevel, UserIdentity, USER_ROLES, nextFlowStatuses } from "@loan-tasks/shared";
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
  GREEN: "Green - Anytime",
  YELLOW: "Yellow - End of Day",
  ORANGE: "Orange - Within 1 Hour",
  RED: "Red - Urgent Now"
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

const urgencyClass = (urgency: UrgencyLevel): string => {
  if (urgency === "RED") {
    return "urgency urgency-red";
  }
  if (urgency === "ORANGE") {
    return "urgency urgency-orange";
  }
  if (urgency === "YELLOW") {
    return "urgency urgency-yellow";
  }
  return "urgency urgency-green";
};

const statusLabel = (status: TaskStatus): string => status.replaceAll("_", " ");

const canUnclaim = (task: LoanTask, user: UserIdentity): boolean => task.status === "CLAIMED" && (task.assignee?.id === user.id || user.roles.includes("ADMIN"));

const isOverdue = (task: LoanTask): boolean => !CLOSED_STATUSES.includes(task.status) && new Date(task.dueAt).getTime() < Date.now();

const applyTheme = (theme?: string): void => {
  const normalized = theme === "dark" || theme === "contrast" ? theme : "light";
  document.documentElement.setAttribute("data-theme", normalized);
};

const TaskCard = ({
  task,
  user,
  onClaim,
  onUnclaim,
  onTransition
}: {
  task: LoanTask;
  user: UserIdentity;
  onClaim: (taskId: string) => Promise<void>;
  onUnclaim: (taskId: string) => Promise<void>;
  onTransition: (taskId: string, status: TaskStatus) => Promise<void>;
}) => {
  const transitions = nextFlowStatuses(task).filter((status) => status !== "OPEN");
  const [nextStatus, setNextStatus] = useState<TaskStatus | "">(transitions[0] ?? "");
  const overdue = isOverdue(task);

  useEffect(() => {
    setNextStatus(transitions[0] ?? "");
  }, [task.status]);

  return (
    <article className="task-card">
      <header className="task-card-head">
        <div>
          <h4>{task.loanName}</h4>
          <div className="task-pill-row">
            <span className="pill">{TASK_TYPE_LABELS[task.taskType]}</span>
            <span className="pill">{statusLabel(task.status)}</span>
            {overdue && <span className="pill pill-overdue">Overdue</span>}
          </div>
        </div>
        <span className={urgencyClass(task.urgency)}>{URGENCY_LABELS[task.urgency]}</span>
      </header>
      <p className="task-notes">{task.notes}</p>

      <div className="task-mini-grid">
        <p className="task-meta small">
          <strong>Creator:</strong> {task.createdBy.displayName}
        </p>
        <p className="task-meta small">
          <strong>Assignee:</strong> {task.assignee?.displayName ?? "Unassigned"}
        </p>
      </div>

      {task.humperdinkLink && (
        <p className="task-meta small">
          <strong>Humperdink:</strong>{" "}
          <a href={task.humperdinkLink} target="_blank" rel="noreferrer">
            Open Link
          </a>
        </p>
      )}

      {task.serverLocation && (
        <p className="task-meta small">
          <strong>Server:</strong> {task.serverLocation}
        </p>
      )}

      <div className="task-actions">
        {task.status === "OPEN" && (
          <button type="button" onClick={() => onClaim(task.id)}>
            Claim
          </button>
        )}

        {canUnclaim(task, user) && (
          <button type="button" className="secondary" onClick={() => onUnclaim(task.id)}>
            Unclaim
          </button>
        )}

        {transitions.length > 0 && (
          <>
            <select value={nextStatus} onChange={(event) => setNextStatus(event.target.value as TaskStatus)}>
              {transitions.map((status) => (
                <option key={status} value={status}>
                  {statusLabel(status)}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => (nextStatus ? onTransition(task.id, nextStatus) : Promise.resolve())}>
              Update
            </button>
          </>
        )}
      </div>
    </article>
  );
};

export const App = () => {
  const [user, setUser] = useState<UserIdentity>(INITIAL_USER);
  const [tasks, setTasks] = useState<LoanTask[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<string[]>([]);

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
    refresh().catch(() => {
      // handled in refresh
    });
  }, [user.id]);

  useEffect(() => {
    const source = new EventSource(`${API_BASE}/stream`);
    source.addEventListener("task.changed", (event) => {
      const incoming = JSON.parse((event as MessageEvent<string>).data) as LoanTask;
      setTasks((current) => {
        const idx = current.findIndex((task) => task.id === incoming.id);
        if (idx === -1) {
          return [incoming, ...current];
        }
        const copy = [...current];
        copy[idx] = incoming;
        return copy.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      });
      setNotifications((current) => [`Task updated: ${incoming.loanName} (${statusLabel(incoming.status)})`, ...current].slice(0, 6));
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
      setForm((current) => ({
        ...current,
        loanName: "",
        notes: "",
        humperdinkLink: "",
        serverLocation: ""
      }));
      setError(null);
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

  const onTransition = async (taskId: string, status: TaskStatus): Promise<void> => {
    try {
      await apiRequest<{ task: LoanTask }>(`/tasks/${taskId}/transition`, { method: "POST", body: JSON.stringify({ status }) }, user);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update task");
    }
  };

  const columns = useMemo(
    () => ({
      open: tasks.filter((task) => task.status === "OPEN"),
      active: tasks.filter((task) => ["CLAIMED", "NEEDS_REVIEW", "MERGE_DONE", "MERGE_APPROVED"].includes(task.status)),
      completed: tasks.filter((task) => task.status === "COMPLETED"),
      archived: tasks.filter((task) => ["ARCHIVED", "CANCELLED"].includes(task.status))
    }),
    [tasks]
  );

  const stats = useMemo(() => {
    const overdue = tasks.filter((task) => isOverdue(task)).length;
    return {
      total: tasks.length,
      open: columns.open.length,
      active: columns.active.length,
      overdue
    };
  }, [tasks, columns]);

  const boardSections = [
    { key: "open", title: "Open Tasks", items: columns.open },
    { key: "active", title: "In Progress", items: columns.active },
    { key: "completed", title: "Completed", items: columns.completed },
    { key: "archived", title: "Archive", items: columns.archived }
  ] as const;

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <h1>Loan Tasks</h1>
          <p>Fast coordination for LOI, Value, Fraud, and Loan Docs checks.</p>
          <div className="summary-strip">
            <span className="summary-chip">Total {stats.total}</span>
            <span className="summary-chip">Open {stats.open}</span>
            <span className="summary-chip">In Progress {stats.active}</span>
            <span className="summary-chip summary-chip-warning">Overdue {stats.overdue}</span>
          </div>
        </div>

        <label className="user-picker">
          Acting user
          <select value={user.id} onChange={(event) => setUser(mockUsers.find((entry) => entry.id === event.target.value) ?? INITIAL_USER)}>
            {mockUsers.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.displayName} ({entry.roles.join("/")})
              </option>
            ))}
          </select>
        </label>
      </header>

      {error && <p className="error">{error}</p>}

      <section className="panel">
        <h2>Create Task</h2>
        <form className="task-form" onSubmit={onCreateTask}>
          <label>
            Loan Name
            <input value={form.loanName} onChange={(event) => setForm((current) => ({ ...current, loanName: event.target.value }))} required />
          </label>

          <label>
            Task Type
            <select value={form.taskType} onChange={(event) => setForm((current) => ({ ...current, taskType: event.target.value as TaskType }))}>
              <option value="LOI">LOI Check</option>
              <option value="VALUE">Value Check</option>
              <option value="FRAUD">Fraud Check</option>
              <option value="LOAN_DOCS">Loan Docs</option>
            </select>
          </label>

          <label>
            Urgency
            <select value={form.urgency} onChange={(event) => setForm((current) => ({ ...current, urgency: event.target.value as UrgencyLevel }))}>
              <option value="GREEN">Green - Anytime</option>
              <option value="YELLOW">Yellow - End of Day</option>
              <option value="ORANGE">Orange - Within 1 Hour</option>
              <option value="RED">Red - Urgent Now</option>
            </select>
          </label>

          <label className="full-width">
            Notes
            <textarea rows={3} value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} required />
          </label>

          <label>
            Humperdink Link (optional)
            <input type="url" value={form.humperdinkLink} onChange={(event) => setForm((current) => ({ ...current, humperdinkLink: event.target.value }))} />
          </label>

          <label>
            Server Location (optional)
            <input value={form.serverLocation} onChange={(event) => setForm((current) => ({ ...current, serverLocation: event.target.value }))} />
          </label>

          <button type="submit">Create Task</button>
        </form>
      </section>

      <section className="board-grid">
        {boardSections.map((section) => (
          <section className="panel" key={section.key}>
            <h3>
              {section.title} ({section.items.length})
            </h3>
            <div className="task-list">
              {section.items.length === 0 ? (
                <p className="empty-state">No tasks in this queue.</p>
              ) : (
                section.items.map((task) => <TaskCard key={task.id} task={task} user={user} onClaim={onClaim} onUnclaim={onUnclaim} onTransition={onTransition} />)
              )}
            </div>
          </section>
        ))}
      </section>

      <section className="panel">
        <h3>Live Notifications</h3>
        {notifications.length === 0 ? <p className="small">No events yet.</p> : <ul className="notice-list">{notifications.map((item) => <li key={item}>{item}</li>)}</ul>}
      </section>

      <footer className="footer-note">
        <p>
          Roles: {USER_ROLES.join(", ")} | Reminders: hourly, business hours 8:30 AM-5:30 PM America/Los_Angeles
        </p>
      </footer>
    </main>
  );
};
