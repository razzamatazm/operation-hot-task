import { AppConfig, LoanTask, TaskStatus, TaskType, UserIdentity } from "./types.js";

const LOAN_DOCS_FLOW: TaskStatus[] = [
  "OPEN",
  "CLAIMED",
  "MERGE_DONE",
  "MERGE_APPROVED",
  "COMPLETED",
  "ARCHIVED"
];

const STANDARD_FLOW: TaskStatus[] = ["OPEN", "CLAIMED", "COMPLETED", "ARCHIVED"];

const ALWAYS_ALLOWED: Partial<Record<TaskStatus, TaskStatus[]>> = {
  OPEN: ["CANCELLED"],
  CLAIMED: ["NEEDS_REVIEW", "CANCELLED"],
  NEEDS_REVIEW: ["CLAIMED", "COMPLETED", "CANCELLED"],
  MERGE_DONE: ["CANCELLED"],
  MERGE_APPROVED: ["CANCELLED"]
};

export const DEFAULT_CONFIG: AppConfig = {
  businessTimezone: "America/Los_Angeles",
  businessStartHour: 8,
  businessStartMinute: 30,
  businessEndHour: 17,
  businessEndMinute: 30,
  archiveRetentionDays: 90
};

export const toUtcISOString = (date: Date): string => date.toISOString();

export const computeDefaultDueAt = (taskType: TaskType, now: Date): string => {
  if (taskType === "LOI" || taskType === "LOAN_DOCS") {
    const due = new Date(now.getTime() + 60 * 60 * 1000);
    return toUtcISOString(due);
  }

  if (taskType === "FRAUD") {
    const local = new Date(now);
    local.setHours(DEFAULT_CONFIG.businessEndHour, DEFAULT_CONFIG.businessEndMinute, 0, 0);
    if (local.getTime() <= now.getTime()) {
      local.setDate(local.getDate() + 1);
      while (local.getDay() === 0 || local.getDay() === 6) {
        local.setDate(local.getDate() + 1);
      }
      local.setHours(DEFAULT_CONFIG.businessEndHour, DEFAULT_CONFIG.businessEndMinute, 0, 0);
    }
    return toUtcISOString(local);
  }

  const due = new Date(now);
  due.setDate(due.getDate() + 1);
  while (due.getDay() === 0 || due.getDay() === 6) {
    due.setDate(due.getDate() + 1);
  }
  due.setHours(DEFAULT_CONFIG.businessEndHour, DEFAULT_CONFIG.businessEndMinute, 0, 0);
  return toUtcISOString(due);
};

export const nextFlowStatuses = (task: LoanTask): TaskStatus[] => {
  const flow = task.taskType === "LOAN_DOCS" ? LOAN_DOCS_FLOW : STANDARD_FLOW;
  const index = flow.indexOf(task.status);

  const nextCandidate = index >= 0 && index < flow.length - 1 ? flow[index + 1] : undefined;
  const next = nextCandidate ? [nextCandidate] : [];
  const extra = ALWAYS_ALLOWED[task.status] ?? [];
  return Array.from(new Set([...next, ...extra]));
};

const hasRole = (user: UserIdentity, role: "FILE_CHECKER" | "ADMIN"): boolean => user.roles.includes(role);

export const canClaimTask = (task: LoanTask, user: UserIdentity): boolean => {
  if (task.status !== "OPEN") {
    return false;
  }
  if (task.taskType === "FRAUD" && !hasRole(user, "FILE_CHECKER")) {
    return false;
  }
  return true;
};

export const canUnclaimTask = (task: LoanTask, user: UserIdentity): boolean => {
  if (task.status !== "CLAIMED") {
    return false;
  }

  const isAssignee = task.assignee?.id === user.id;
  const isAdmin = hasRole(user, "ADMIN");
  return isAssignee || isAdmin;
};

export const canCancelTask = (task: LoanTask, user: UserIdentity): boolean => {
  const isCreator = task.createdBy.id === user.id;
  const isAdmin = hasRole(user, "ADMIN");
  return isCreator || isAdmin;
};

export const canMoveClaimedToNeedsReview = (task: LoanTask, user: UserIdentity): boolean => {
  if (task.status !== "CLAIMED") {
    return false;
  }

  const isCreator = task.createdBy.id === user.id;
  const isAssignee = task.assignee?.id === user.id;
  return isCreator || isAssignee;
};

export const canMoveNeedsReview = (task: LoanTask, user: UserIdentity): boolean => {
  if (task.status !== "NEEDS_REVIEW") {
    return false;
  }

  const isCreator = task.createdBy.id === user.id;
  const isAssignee = task.assignee?.id === user.id;
  const isAdmin = hasRole(user, "ADMIN");
  return isCreator || isAssignee || isAdmin;
};

export const canCompleteTask = (task: LoanTask, user: UserIdentity): boolean => {
  if (task.taskType === "FRAUD" && !hasRole(user, "FILE_CHECKER")) {
    return false;
  }

  if (task.status === "CLAIMED" || task.status === "MERGE_APPROVED" || task.status === "NEEDS_REVIEW") {
    const isCreator = task.createdBy.id === user.id;
    const isAssignee = task.assignee?.id === user.id;
    const isAdmin = hasRole(user, "ADMIN");
    return isCreator || isAssignee || isAdmin;
  }

  return false;
};

export const canTransitionStatus = (task: LoanTask, next: TaskStatus, user: UserIdentity): { ok: boolean; reason?: string } => {
  if (!nextFlowStatuses(task).includes(next)) {
    return { ok: false, reason: `Cannot move from ${task.status} to ${next}` };
  }

  if (next === "CANCELLED" && !canCancelTask(task, user)) {
    return { ok: false, reason: "Only the task creator or admin can cancel a task" };
  }

  if (next === "NEEDS_REVIEW" && !canMoveClaimedToNeedsReview(task, user)) {
    return { ok: false, reason: "Only assignee or creator can mark as needs review" };
  }

  if ((next === "CLAIMED" || next === "COMPLETED") && task.status === "NEEDS_REVIEW" && !canMoveNeedsReview(task, user)) {
    return { ok: false, reason: "Only assignee, creator, or admin can move a needs review task" };
  }

  if (next === "COMPLETED" && !canCompleteTask(task, user)) {
    return { ok: false, reason: "User cannot complete this task" };
  }

  return { ok: true };
};

export const isOverdue = (task: LoanTask, now: Date): boolean => {
  if (["COMPLETED", "ARCHIVED", "CANCELLED"].includes(task.status)) {
    return false;
  }

  return new Date(task.dueAt).getTime() < now.getTime();
};

export const shouldPurgeArchived = (task: LoanTask, now: Date, retentionDays: number): boolean => {
  if (task.status !== "ARCHIVED" || !task.archivedAt) {
    return false;
  }

  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  return now.getTime() - new Date(task.archivedAt).getTime() > retentionMs;
};

export const isWithinBusinessHours = (now: Date, config: AppConfig = DEFAULT_CONFIG): boolean => {
  const dayName = new Intl.DateTimeFormat("en-US", {
    timeZone: config.businessTimezone,
    weekday: "short"
  }).format(now);

  if (dayName === "Sat" || dayName === "Sun") {
    return false;
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: config.businessTimezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  const hour = Number.parseInt(parts.hour ?? "0", 10);
  const minute = Number.parseInt(parts.minute ?? "0", 10);
  const minutes = hour * 60 + minute;
  const start = config.businessStartHour * 60 + config.businessStartMinute;
  const end = config.businessEndHour * 60 + config.businessEndMinute;
  return minutes >= start && minutes <= end;
};

export const shouldSendReminder = (task: LoanTask, now: Date, config: AppConfig = DEFAULT_CONFIG): boolean => {
  if (!isOverdue(task, now)) {
    return false;
  }

  if (task.lastReminderAt) {
    const elapsedMs = now.getTime() - new Date(task.lastReminderAt).getTime();
    if (elapsedMs < 60 * 60 * 1000) {
      return false;
    }
  }

  return isWithinBusinessHours(now, config);
};
