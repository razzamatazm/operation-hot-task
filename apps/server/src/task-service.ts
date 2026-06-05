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
  computeDueAtFromReturnDate,
  firstName,
  formatNewTaskHeadline,
  formatOooHeadline,
  isWithinBusinessHours,
  isOverdue,
  shouldPurgeArchived,
  shouldSendReminder
} from "@loan-tasks/shared";
import { ActivityFeedStateStore, ActivitySignalState, ActivitySignalType, KnownUserState } from "./activity-feed-state.js";
import { v4 as uuid } from "uuid";
import { NotificationProvider } from "./notifications.js";
import { SseHub } from "./sse.js";
import { TaskStore } from "./store.js";

const ACTIVE_STATUSES: TaskStatus[] = ["OPEN", "CLAIMED", "NEEDS_REVIEW", "MERGE_DONE", "MERGE_APPROVED"];
const REMINDER_INTERVAL_MS = 60 * 60 * 1000;
const clampPoints = (points: number): number => Math.max(0, Math.min(5, Math.trunc(points)));

export class TaskService {
  constructor(
    private readonly store: TaskStore,
    private readonly notifier: NotificationProvider,
    private readonly events: SseHub,
    private readonly appConfig: AppConfig,
    private readonly activityFeedState?: ActivityFeedStateStore
  ) {}

  async registerUser(user: UserIdentity): Promise<void> {
    if (!this.activityFeedState) {
      return;
    }
    await this.activityFeedState.upsertUser(user);
  }

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
    const isOoo = input.taskType === "OOO";
    const urgency = isOoo ? "GREEN" : input.urgency ?? "GREEN";
    const folderName = input.folderName.trim();
    const points = clampPoints(input.points ?? 0);
    const dueAt = isOoo
      ? computeDueAtFromReturnDate(input.returnDate ?? "", this.appConfig)
      : input.dueAt ?? computeDefaultDueAt(input.taskType, now, urgency, this.appConfig);
    if (isOoo && new Date(dueAt).getTime() <= now.getTime()) {
      throw new Error("returnDate must result in a future due time");
    }

    const startDate = input.startDate?.trim();
    const returnDate = input.returnDate?.trim();
    if (isOoo) {
      if (!startDate || !returnDate) {
        throw new Error("OOO tasks need a start date and a return date");
      }
      if (startDate > returnDate) {
        throw new Error("Start date must be on or before the return date");
      }
    }

    const task: LoanTask = {
      id: uuid(),
      folderName,
      loanName: folderName,
      taskType: input.taskType,
      dueAt,
      urgency,
      points,
      notes: input.notes.trim(),
      status: "OPEN",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      createdBy: { id: user.id, displayName: user.displayName },
      ...(isOoo && startDate ? { startDate } : {}),
      ...(isOoo && returnDate ? { returnDate } : {}),
      ...(input.humperdinkLink?.trim() ? { humperdinkLink: input.humperdinkLink.trim() } : {})
    };

    const createdMessage = isOoo
      ? formatOooHeadline(user.displayName, startDate ?? "", returnDate ?? "")
      : `${formatNewTaskHeadline(user.displayName, task.taskType)}: ${task.folderName}`;

    const event = this.makeHistory(task.id, user, "TASK_CREATED", `Created ${task.taskType} task`);
    await this.store.upsertTask(task, event);
    this.events.broadcast({ type: "task.changed", payload: task });

    await this.notify({
      type: "TASK_CREATED",
      task,
      actor: task.createdBy,
      message: createdMessage,
      target: "IN_APP"
    });
    await this.notify({
      type: "TASK_CREATED",
      task,
      actor: task.createdBy,
      message: createdMessage,
      target: "CHANNEL"
    });
    await this.evaluateActivitySignals({ now });

    return task;
  }

  async updateTaskPoints(taskId: string, points: number, user: UserIdentity): Promise<LoanTask> {
    const task = await this.requireTask(taskId);
    if (task.createdBy.id !== user.id && !user.roles.includes("ADMIN")) {
      throw new Error("Only the task creator can change poops");
    }
    if (!ACTIVE_STATUSES.includes(task.status)) {
      throw new Error("Poops cannot be changed on a closed task");
    }
    const next = clampPoints(points);
    if (next === task.points) {
      return task;
    }
    const updated: LoanTask = {
      ...task,
      points: next,
      updatedAt: new Date().toISOString()
    };
    const event = this.makeHistory(task.id, user, "TASK_POINTS_UPDATED", `Poops set to ${next}`);
    await this.store.upsertTask(updated, event);
    this.events.broadcast({ type: "task.changed", payload: updated });
    return updated;
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

    // No channel thread-reply on claim (Design A) — the root card silently flips
    // to its claimed state via CHANNEL_CLAIMED below, so nobody is re-pinged.
    await this.notify({
      type: "TASK_CLAIMED",
      task: updated,
      actor: { id: user.id, displayName: user.displayName },
      message: `You're on the hook for this one. Go get 'em.`,
      target: "DM_CLAIM",
      recipientUserIds: [user.id]
    });
    // Tell the creator their task got picked up (unless they claimed it).
    if (task.createdBy.id !== user.id) {
      await this.notify({
        type: "TASK_CLAIMED",
        task: updated,
        actor: { id: user.id, displayName: user.displayName },
        message: `${firstName(user.displayName)} claimed ${updated.folderName}`,
        target: "DM",
        recipientUserIds: [task.createdBy.id]
      });
    }
    // Update the channel card to its claimed state for everyone — fires for web
    // claims too, not just taps on the card's own Claim button.
    await this.notify({
      type: "TASK_CLAIMED",
      task: updated,
      actor: { id: user.id, displayName: user.displayName },
      message: `${user.displayName} grabbed ${updated.folderName}`,
      target: "CHANNEL_CLAIMED"
    });
    // Open the conversation surface for BOTH parties so they can chat right away
    // (the note card otherwise only appears once the first note is posted).
    await this.notify({
      type: "TASK_CLAIMED",
      task: updated,
      actor: { id: user.id, displayName: user.displayName },
      message: `Chat opened for ${updated.folderName}`,
      target: "DM_CHAT_SEED",
      recipientUserIds: [updated.createdBy.id, user.id]
    });
    await this.evaluateActivitySignals({ now: new Date(now) });

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

    // Design A: no thread-reply. Re-post a fresh claimable card as a new thread
    // (re-alerts the channel) and point the old card at it.
    await this.notify({
      type: "TASK_UNCLAIMED",
      task: updated,
      actor: { id: user.id, displayName: user.displayName },
      message: `${updated.folderName} is back up for grabs`,
      target: "CHANNEL_REOPENED"
    });
    await this.evaluateActivitySignals({ now: new Date(now) });

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
    if (next === "OPEN") {
      delete updated.completedAt;
      delete updated.archivedAt;
      if (task.assignee) {
        updated.status = "CLAIMED";
      }
    }
    if (next === "NEEDS_REVIEW" && reviewNotes) {
      updated.reviewNotes = [
        ...(task.reviewNotes ?? []),
        { text: reviewNotes, by: { id: user.id, displayName: user.displayName }, at: now }
      ];
    }

    const detail = reviewNotes
      ? `${task.status} -> ${next} | Review: ${reviewNotes}`
      : `${task.status} -> ${next}`;
    const event = this.makeHistory(task.id, user, "TASK_STATUS_CHANGED", detail);
    await this.store.upsertTask(updated, event);
    this.events.broadcast({ type: "task.changed", payload: updated });

    await this.notify({
      type: next === "ARCHIVED" ? "TASK_ARCHIVED" : "TASK_STATUS_CHANGED",
      task: updated,
      actor: { id: user.id, displayName: user.displayName },
      message: `${user.displayName} moved ${updated.folderName} to ${next}`,
      target: "IN_APP"
    });

    // Re-open (back to OPEN with no assignee) restores the claimable channel
    // card. When an assignee is retained the task returns to CLAIMED, so the
    // card stays in its claimed state and needs no flip.
    if (updated.status === "OPEN") {
      await this.notify({
        type: "TASK_STATUS_CHANGED",
        task: updated,
        actor: { id: user.id, displayName: user.displayName },
        message: `${updated.folderName} is back up for grabs`,
        target: "CHANNEL_REOPENED"
      });
    }

    if (next === "NEEDS_REVIEW") {
      const recipients = [task.createdBy.id, task.assignee?.id].filter((id): id is string => Boolean(id) && id !== user.id);
      if (recipients.length > 0) {
        await this.notify({
          type: "TASK_STATUS_CHANGED",
          task: updated,
          actor: { id: user.id, displayName: user.displayName },
          message: `${updated.folderName} needs your eyes`,
          target: "ACTIVITY_FEED",
          recipientUserIds: recipients
        });
      }
    }

    if (next === "MERGE_DONE" || next === "COMPLETED") {
      await this.notify({
        type: "TASK_STATUS_CHANGED",
        task: updated,
        actor: { id: user.id, displayName: user.displayName },
        message: next === "COMPLETED" ? `Done and dusted 🎉` : `Merge done — almost home`,
        target: "DM",
        recipientUserIds: [updated.createdBy.id]
      });
    }

    if (next === "COMPLETED") {
      // Silently edit the channel card to its terminal completed state.
      await this.notify({
        type: "TASK_STATUS_CHANGED",
        task: updated,
        actor: { id: user.id, displayName: user.displayName },
        message: `${updated.folderName} completed`,
        target: "CHANNEL_COMPLETED"
      });
    }

    if (next === "CANCELLED") {
      // Silently edit the channel card to its terminal cancelled state (covers
      // both a creator's card-tap Cancel and a cancel from the web app).
      await this.notify({
        type: "TASK_STATUS_CHANGED",
        task: updated,
        actor: { id: user.id, displayName: user.displayName },
        message: `${updated.folderName} cancelled`,
        target: "CHANNEL_CANCELLED"
      });
    }

    if (next === "MERGE_APPROVED" && updated.assignee) {
      await this.notify({
        type: "TASK_STATUS_CHANGED",
        task: updated,
        actor: { id: user.id, displayName: user.displayName },
        message: `Got the green light`,
        target: "DM",
        recipientUserIds: [updated.assignee.id]
      });
    }
    await this.evaluateActivitySignals({ now: new Date(now) });

    return updated;
  }

  async addReviewNote(taskId: string, text: string, user: UserIdentity): Promise<LoanTask> {
    const task = await this.requireTask(taskId);

    if (["COMPLETED", "ARCHIVED", "CANCELLED"].includes(task.status)) {
      throw new Error("Notes cannot be added to closed tasks");
    }

    const isCreator = task.createdBy.id === user.id;
    const isAssignee = task.assignee?.id === user.id;
    const isAdmin = user.roles.includes("ADMIN");
    if (!isCreator && !isAssignee && !isAdmin) {
      throw new Error("Only the creator, assignee, or admin can add review notes");
    }

    const now = new Date().toISOString();
    const updated: LoanTask = {
      ...task,
      reviewNotes: [
        ...(task.reviewNotes ?? []),
        { text, by: { id: user.id, displayName: user.displayName }, at: now }
      ],
      updatedAt: now
    };

    const event = this.makeHistory(task.id, user, "REVIEW_NOTE_ADDED", `Review note by ${user.displayName}`);
    await this.store.upsertTask(updated, event);
    this.events.broadcast({ type: "task.changed", payload: updated });

    // Note-card recipients are ALL participants (creator + assignee), including
    // the author — their own DM card stays in sync when they post from the app.
    // The notification layer skips creating/pinging the author's card.
    const participants = [task.createdBy.id, task.assignee?.id].filter((id): id is string => Boolean(id));
    const noteRecipients = Array.from(new Set(participants));
    // Activity-feed pings only go to the OTHER party (don't alert yourself).
    const feedRecipients = noteRecipients.filter((id) => id !== user.id);
    if (noteRecipients.length > 0) {
      await this.notify({
        type: "TASK_STATUS_CHANGED",
        task: updated,
        actor: { id: user.id, displayName: user.displayName },
        // message carries the raw note text; the DM card shows it and offers a
        // reply box that posts straight back as another note.
        message: text.trim(),
        target: "DM_NOTE",
        recipientUserIds: noteRecipients
      });
    }
    if (feedRecipients.length > 0) {
      await this.notify({
        type: "TASK_STATUS_CHANGED",
        task: updated,
        actor: { id: user.id, displayName: user.displayName },
        message: `New note on ${updated.folderName} from ${user.displayName}`,
        target: "ACTIVITY_FEED",
        recipientUserIds: feedRecipients
      });
    }
    await this.evaluateActivitySignals({ now: new Date(now) });

    return updated;
  }

  async runMaintenance(): Promise<{ reminded: number; purged: number; autoArchived: number }> {
    const now = new Date();
    const tasks = await this.store.allTasks();

    let reminded = 0;
    let autoArchived = 0;
    const historyEvents: TaskHistoryEvent[] = [];
    const updatedTasks: LoanTask[] = [];

    for (const task of tasks) {
      let next = task;
      const nowIso = now.toISOString();

      if (
        task.taskType === "OOO" &&
        ACTIVE_STATUSES.includes(task.status) &&
        new Date(task.dueAt).getTime() <= now.getTime()
      ) {
        next = {
          ...next,
          status: "COMPLETED",
          completedAt: nowIso,
          updatedAt: nowIso
        };
        historyEvents.push(this.makeHistory(task.id, { id: "system", displayName: "Task Scheduler", roles: ["ADMIN"] }, "TASK_STATUS_CHANGED", "AUTO_COMPLETED_RETURN_DATE"));
        await this.notify({
          type: "TASK_STATUS_CHANGED",
          task: next,
          actor: { id: "system", displayName: "Task Scheduler" },
          message: `${next.folderName} wrapped itself up on the return date`,
          target: "IN_APP"
        });
        await this.notify({
          type: "TASK_STATUS_CHANGED",
          task: next,
          actor: { id: "system", displayName: "Task Scheduler" },
          message: `Auto-completed while you were out — welcome back`,
          target: "DM",
          recipientUserIds: [next.createdBy.id]
        });
      }

      // Auto-archive completed/cancelled tasks after 14 days to keep active queues clean.
      if (["COMPLETED", "CANCELLED"].includes(next.status)) {
        const reference = next.completedAt ?? next.cancelledAt ?? next.updatedAt;
        const ageMs = now.getTime() - new Date(reference).getTime();
        if (ageMs > 14 * 24 * 60 * 60 * 1000) {
          next = {
            ...next,
            status: "ARCHIVED",
            archivedAt: nowIso,
            updatedAt: nowIso
          };
          autoArchived += 1;
        }
      }

      if (ACTIVE_STATUSES.includes(next.status) && shouldSendReminder(next, now, this.appConfig) && isOverdue(next, now)) {
        reminded += 1;
        next = {
          ...next,
          lastReminderAt: nowIso,
          updatedAt: nowIso
        };

        const reminderRecipients = this.reminderRecipients(next);
        if (reminderRecipients.length > 0) {
          await this.notify({
            type: "TASK_REMINDER",
            task: next,
            actor: { id: "system", displayName: "Task Scheduler" },
            message: `Heads up — this one's overdue`,
            target: "DM",
            recipientUserIds: reminderRecipients
          });
        }
      }

      updatedTasks.push(next);
    }

    const toPurge = updatedTasks.filter((task) => shouldPurgeArchived(task, now, this.appConfig.archiveRetentionDays));
    const retained = updatedTasks.filter((task) => !toPurge.some((purge) => purge.id === task.id));

    if (toPurge.length > 0 || autoArchived > 0 || reminded > 0 || historyEvents.length > 0) {
      await this.store.replaceTasks(retained);
      for (const event of historyEvents) {
        await this.store.appendHistory(event);
      }
      for (const task of retained) {
        this.events.broadcast({ type: "task.changed", payload: task });
      }
    }

    await this.evaluateActivitySignals({ now, allowReminders: true, tasks: retained });

    return {
      reminded,
      purged: toPurge.length,
      autoArchived
    };
  }

  private async evaluateActivitySignals({
    now,
    allowReminders = false,
    tasks
  }: {
    now: Date;
    allowReminders?: boolean;
    tasks?: LoanTask[];
  }): Promise<void> {
    if (!this.activityFeedState) {
      return;
    }

    const currentTasks = tasks ?? (await this.store.allTasks());
    const snapshot = await this.activityFeedState.read();
    const knownUsers = this.collectKnownUsers(snapshot.users, currentTasks);
    snapshot.users = knownUsers;

    const activeSignals = this.collectActiveSignals(currentTasks, knownUsers, now);
    const existingByKey = new Map(snapshot.signals.map((signal) => [signal.key, signal]));
    const notifications: Array<{ recipientUserIds: string[]; task: LoanTask; message: string }> = [];
    const nextSignals: ActivitySignalState[] = [];
    const nowIso = now.toISOString();

    for (const signal of activeSignals) {
      const previous = existingByKey.get(signal.key);
      if (!previous) {
        nextSignals.push({
          key: signal.key,
          userId: signal.userId,
          taskId: signal.task.id,
          signalType: signal.signalType,
          isActive: true,
          lastActivatedAt: nowIso,
          lastNotifiedAt: nowIso,
          lastReminderAt: nowIso
        });
        notifications.push({
          recipientUserIds: [signal.userId],
          task: signal.task,
          message: signal.message
        });
        continue;
      }

      const nextState: ActivitySignalState = {
        ...previous,
        isActive: true
      };

      const canSendReminder =
        allowReminders &&
        isWithinBusinessHours(now, this.appConfig) &&
        (!previous.lastReminderAt || now.getTime() - new Date(previous.lastReminderAt).getTime() >= REMINDER_INTERVAL_MS);

      if (canSendReminder) {
        notifications.push({
          recipientUserIds: [signal.userId],
          task: signal.task,
          message: signal.message
        });
        nextState.lastReminderAt = nowIso;
        nextState.lastNotifiedAt = nowIso;
      }

      nextSignals.push(nextState);
    }

    snapshot.signals = nextSignals;
    await this.activityFeedState.replace(snapshot);

    for (const note of notifications) {
      await this.notify({
        type: "TASK_STATUS_CHANGED",
        task: note.task,
        actor: { id: "system", displayName: "Task Scheduler" },
        message: note.message,
        target: "ACTIVITY_FEED",
        recipientUserIds: note.recipientUserIds
      });
    }
  }

  private collectKnownUsers(seedUsers: KnownUserState[], tasks: LoanTask[]): KnownUserState[] {
    const users = new Map<string, KnownUserState>();
    for (const user of seedUsers) {
      users.set(user.id, user);
    }

    for (const task of tasks) {
      if (!users.has(task.createdBy.id)) {
        users.set(task.createdBy.id, {
          id: task.createdBy.id,
          displayName: task.createdBy.displayName,
          roles: ["LOAN_OFFICER"]
        });
      }
      if (task.assignee && !users.has(task.assignee.id)) {
        users.set(task.assignee.id, {
          id: task.assignee.id,
          displayName: task.assignee.displayName,
          roles: ["LOAN_OFFICER"]
        });
      }
    }

    return [...users.values()];
  }

  private collectActiveSignals(
    tasks: LoanTask[],
    users: KnownUserState[],
    now: Date
  ): Array<{ key: string; userId: string; signalType: ActivitySignalType; message: string; task: LoanTask }> {
    const signals = new Map<string, { key: string; userId: string; signalType: ActivitySignalType; message: string; task: LoanTask }>();

    for (const task of tasks) {
      if (task.status === "OPEN") {
        for (const user of users) {
          if (!canClaimTask(task, { id: user.id, displayName: user.displayName, roles: user.roles })) {
            continue;
          }
          if (task.createdBy.id === user.id) {
            continue;
          }
          const key = `${user.id}:CLAIMABLE:${task.id}`;
          signals.set(key, {
            key,
            userId: user.id,
            signalType: "CLAIMABLE",
            message: `${task.folderName} is up for grabs`,
            task
          });
        }
      }

      if (ACTIVE_STATUSES.includes(task.status) && isOverdue(task, now)) {
        const overdueUserId = task.assignee?.id ?? task.createdBy.id;
        const key = `${overdueUserId}:OVERDUE:${task.id}`;
        signals.set(key, {
          key,
          userId: overdueUserId,
          signalType: "OVERDUE",
          message: `${task.folderName} is running late`,
          task
        });
      }

      if (task.status === "NEEDS_REVIEW") {
        const reviewers = [task.createdBy.id, task.assignee?.id].filter((id): id is string => Boolean(id));
        for (const userId of new Set(reviewers)) {
          const key = `${userId}:NEEDS_REVIEW:${task.id}`;
          signals.set(key, {
            key,
            userId,
            signalType: "NEEDS_REVIEW",
            message: `${task.folderName} needs your eyes`,
            task
          });
        }
      }
    }

    return [...signals.values()];
  }

  private reminderRecipients(task: LoanTask): string[] {
    if (task.taskType === "LOAN_DOCS" && task.status === "MERGE_DONE") {
      return [task.createdBy.id];
    }
    return task.assignee ? [task.assignee.id] : [];
  }

  private async notify(event: Omit<NotificationEvent, "createdAt">): Promise<void> {
    try {
      await this.notifier.notify({
        ...event,
        ...(event.recipientUserIds && event.recipientUserIds.length > 0
          ? { recipientUserIds: Array.from(new Set(event.recipientUserIds)) }
          : {}),
        createdAt: new Date().toISOString()
      });
    } catch (error) {
      console.error("notification_send_failed", {
        type: event.type,
        target: event.target,
        taskId: event.task.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
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
