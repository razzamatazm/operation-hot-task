import {
  AppConfig,
  CreateTaskInput,
  LoanTask,
  NotificationEvent,
  TaskHistoryEvent,
  TaskStatus,
  UserIdentity,
  canClaimTask,
  canTransitionStatus,
  canUnclaimTask,
  computeDefaultDueAt,
  isOverdue,
  shouldPurgeArchived,
  shouldSendReminder
} from "@loan-tasks/shared";
import { v4 as uuid } from "uuid";
import { NotificationProvider } from "./notifications.js";
import { SseHub } from "./sse.js";
import { TaskStore } from "./store.js";

const ACTIVE_STATUSES: TaskStatus[] = ["OPEN", "CLAIMED", "NEEDS_REVIEW", "MERGE_DONE", "MERGE_APPROVED"];

export class TaskService {
  constructor(
    private readonly store: TaskStore,
    private readonly notifier: NotificationProvider,
    private readonly events: SseHub,
    private readonly appConfig: AppConfig
  ) {}

  async listTasks(): Promise<LoanTask[]> {
    return this.store.allTasks();
  }

  async getTask(taskId: string): Promise<LoanTask | undefined> {
    return this.store.findTask(taskId);
  }

  async getHistory(taskId: string): Promise<TaskHistoryEvent[]> {
    return this.store.allHistoryForTask(taskId);
  }

  async createTask(input: CreateTaskInput, user: UserIdentity): Promise<LoanTask> {
    const now = new Date();
    const urgency = input.urgency ?? "GREEN";
    const task: LoanTask = {
      id: uuid(),
      loanName: input.loanName.trim(),
      taskType: input.taskType,
      dueAt: input.dueAt ?? computeDefaultDueAt(input.taskType, now, urgency, this.appConfig),
      urgency,
      notes: input.notes.trim(),
      status: "OPEN",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      createdBy: { id: user.id, displayName: user.displayName },
      ...(input.humperdinkLink?.trim() ? { humperdinkLink: input.humperdinkLink.trim() } : {}),
      ...(input.serverLocation?.trim() ? { serverLocation: input.serverLocation.trim() } : {})
    };

    const event = this.makeHistory(task.id, user, "TASK_CREATED", `Created ${task.taskType} task`);
    await this.store.upsertTask(task, event);
    this.events.broadcast({ type: "task.changed", payload: task });

    await this.notifyAllTargets({
      type: "TASK_CREATED",
      task,
      actor: task.createdBy,
      message: `${user.displayName} created task ${task.loanName}`
    });

    return task;
  }

  async claimTask(taskId: string, user: UserIdentity): Promise<LoanTask> {
    const task = await this.requireTask(taskId);

    if (!canClaimTask(task, user)) {
      throw new Error("Task cannot be claimed by this user");
    }

    const now = new Date().toISOString();
    const updated: LoanTask = {
      ...task,
      status: "CLAIMED",
      assignee: { id: user.id, displayName: user.displayName },
      updatedAt: now
    };

    const event = this.makeHistory(task.id, user, "TASK_CLAIMED", `Claimed by ${user.displayName}`);
    await this.store.upsertTask(updated, event);
    this.events.broadcast({ type: "task.changed", payload: updated });

    await this.notifyAllTargets({
      type: "TASK_CLAIMED",
      task: updated,
      actor: { id: user.id, displayName: user.displayName },
      message: `${user.displayName} claimed ${updated.loanName}`
    });

    return updated;
  }

  async unclaimTask(taskId: string, user: UserIdentity): Promise<LoanTask> {
    const task = await this.requireTask(taskId);

    if (!canUnclaimTask(task, user)) {
      throw new Error("Only assignee or admin can unclaim this task");
    }

    const now = new Date().toISOString();
    const { assignee: _assignee, ...withoutAssignee } = task;
    const updated: LoanTask = {
      ...withoutAssignee,
      status: "OPEN",
      updatedAt: now
    };

    const event = this.makeHistory(task.id, user, "TASK_UNCLAIMED", `Returned to open queue by ${user.displayName}`);
    await this.store.upsertTask(updated, event);
    this.events.broadcast({ type: "task.changed", payload: updated });

    await this.notifyAllTargets({
      type: "TASK_UNCLAIMED",
      task: updated,
      actor: { id: user.id, displayName: user.displayName },
      message: `${user.displayName} unclaimed ${updated.loanName}`
    });

    return updated;
  }

  async transitionStatus(taskId: string, next: TaskStatus, user: UserIdentity, reviewNotes?: string): Promise<LoanTask> {
    const task = await this.requireTask(taskId);
    const access = canTransitionStatus(task, next, user);

    if (!access.ok) {
      throw new Error(access.reason ?? "Transition blocked");
    }

    const now = new Date().toISOString();
    const updated: LoanTask = {
      ...task,
      status: next,
      updatedAt: now,
    };
    if (next === "COMPLETED") {
      updated.completedAt = now;
    }
    if (next === "CANCELLED") {
      updated.cancelledAt = now;
    }
    if (next === "ARCHIVED") {
      updated.archivedAt = now;
    }
    if (next === "NEEDS_REVIEW" && reviewNotes) {
      updated.reviewNotes = reviewNotes;
    }

    const detail = reviewNotes
      ? `${task.status} -> ${next} | Review: ${reviewNotes}`
      : `${task.status} -> ${next}`;
    const event = this.makeHistory(task.id, user, "TASK_STATUS_CHANGED", detail);
    await this.store.upsertTask(updated, event);
    this.events.broadcast({ type: "task.changed", payload: updated });

    await this.notifyAllTargets({
      type: next === "ARCHIVED" ? "TASK_ARCHIVED" : "TASK_STATUS_CHANGED",
      task: updated,
      actor: { id: user.id, displayName: user.displayName },
      message: `${user.displayName} moved ${updated.loanName} to ${next}`
    });

    return updated;
  }

  async runMaintenance(): Promise<{ reminded: number; purged: number; autoArchived: number }> {
    const now = new Date();
    const tasks = await this.store.allTasks();

    let reminded = 0;
    let autoArchived = 0;
    const updatedTasks: LoanTask[] = [];

    for (const task of tasks) {
      let next = task;

      // Auto-archive completed/cancelled tasks after 14 days to keep active queues clean.
      if (["COMPLETED", "CANCELLED"].includes(task.status)) {
        const reference = task.completedAt ?? task.cancelledAt ?? task.updatedAt;
        const ageMs = now.getTime() - new Date(reference).getTime();
        if (ageMs > 14 * 24 * 60 * 60 * 1000) {
          next = {
            ...next,
            status: "ARCHIVED",
            archivedAt: now.toISOString(),
            updatedAt: now.toISOString()
          };
          autoArchived += 1;
        }
      }

      if (ACTIVE_STATUSES.includes(next.status) && shouldSendReminder(next, now, this.appConfig) && isOverdue(next, now)) {
        reminded += 1;
        next = {
          ...next,
          lastReminderAt: now.toISOString(),
          updatedAt: now.toISOString()
        };

        await this.notifyAllTargets({
          type: "TASK_REMINDER",
          task: next,
          actor: { id: "system", displayName: "Task Scheduler" },
          message: `Task ${next.loanName} is overdue`
        });
      }

      updatedTasks.push(next);
    }

    const toPurge = updatedTasks.filter((task) => shouldPurgeArchived(task, now, this.appConfig.archiveRetentionDays));
    const retained = updatedTasks.filter((task) => !toPurge.some((purge) => purge.id === task.id));

    if (toPurge.length > 0 || autoArchived > 0 || reminded > 0) {
      await this.store.replaceTasks(retained);
      for (const task of retained) {
        this.events.broadcast({ type: "task.changed", payload: task });
      }
    }

    return {
      reminded,
      purged: toPurge.length,
      autoArchived
    };
  }

  private async notifyAllTargets(event: Omit<NotificationEvent, "target" | "createdAt">): Promise<void> {
    const base = {
      ...event,
      createdAt: new Date().toISOString()
    };

    await this.notifier.notify({ ...base, target: "IN_APP" });
    await this.notifier.notify({ ...base, target: "DM" });
    await this.notifier.notify({ ...base, target: "CHANNEL" });
  }

  private makeHistory(taskId: string, user: UserIdentity, action: string, detail: string): TaskHistoryEvent {
    return {
      id: uuid(),
      taskId,
      action,
      detail,
      at: new Date().toISOString(),
      by: {
        id: user.id,
        displayName: user.displayName
      }
    };
  }

  private async requireTask(taskId: string): Promise<LoanTask> {
    const task = await this.store.findTask(taskId);
    if (!task) {
      throw new Error("Task not found");
    }
    return task;
  }
}
