import { AppConfig, LoanTask, TaskStatus, TaskType, UrgencyLevel, UserIdentity } from "./types.js";

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
  COMPLETED: ["NEEDS_REVIEW", "OPEN"],
  ARCHIVED: ["OPEN"],
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

const parseOffsetMinutes = (value: string): number => {
  const match = value.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!match) {
    return 0;
  }

  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number.parseInt(match[2] ?? "0", 10);
  const minutes = Number.parseInt(match[3] ?? "0", 10);
  return sign * (hours * 60 + minutes);
};

const zonedOffsetMinutes = (date: Date, timezone: string): number => {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "shortOffset",
    hour: "2-digit"
  })
    .formatToParts(date)
    .find((entry) => entry.type === "timeZoneName");
  return parseOffsetMinutes(part?.value ?? "GMT");
};

const zonedParts = (
  date: Date,
  timezone: string
): { year: number; month: number; day: number; weekday: string; hour: number; minute: number } => {
  const partMap = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  return {
    year: Number.parseInt(partMap.year ?? "1970", 10),
    month: Number.parseInt(partMap.month ?? "1", 10),
    day: Number.parseInt(partMap.day ?? "1", 10),
    weekday: partMap.weekday ?? "Mon",
    hour: Number.parseInt(partMap.hour ?? "0", 10),
    minute: Number.parseInt(partMap.minute ?? "0", 10)
  };
};

const isWeekend = (dayName: string): boolean => dayName === "Sat" || dayName === "Sun";

const isBusinessDate = (year: number, month: number, day: number): boolean => {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
  return !isWeekend(weekday);
};

const nextBusinessDate = (
  year: number,
  month: number,
  day: number,
  count: number
): { year: number; month: number; day: number } => {
  let cursor = new Date(Date.UTC(year, month - 1, day));
  let remaining = count;

  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth() + 1;
    const d = cursor.getUTCDate();
    if (isBusinessDate(y, m, d)) {
      remaining -= 1;
    }
  }

  while (!isBusinessDate(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate())) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return {
    year: cursor.getUTCFullYear(),
    month: cursor.getUTCMonth() + 1,
    day: cursor.getUTCDate()
  };
};

const zonedToUtcIso = (year: number, month: number, day: number, hour: number, minute: number, timezone: string): string => {
  const guessUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offset = zonedOffsetMinutes(new Date(guessUtc), timezone);
  return new Date(guessUtc - offset * 60 * 1000).toISOString();
};

export const computeDueAtFromUrgency = (
  urgency: UrgencyLevel,
  now: Date,
  config: AppConfig = DEFAULT_CONFIG
): string => {
  if (urgency === "RED") {
    return now.toISOString();
  }

  if (urgency === "ORANGE") {
    return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  }

  const localNow = zonedParts(now, config.businessTimezone);
  const nowMinutes = localNow.hour * 60 + localNow.minute;
  const endMinutes = config.businessEndHour * 60 + config.businessEndMinute;

  // Yellow means end of current business day (or next business day if already past close/weekend).
  if (urgency === "YELLOW") {
    if (!isWeekend(localNow.weekday) && nowMinutes <= endMinutes) {
      return zonedToUtcIso(localNow.year, localNow.month, localNow.day, config.businessEndHour, config.businessEndMinute, config.businessTimezone);
    }

    const next = nextBusinessDate(localNow.year, localNow.month, localNow.day, 1);
    return zonedToUtcIso(next.year, next.month, next.day, config.businessEndHour, config.businessEndMinute, config.businessTimezone);
  }

  // Green is "anytime" but reminders begin after the next business day closes.
  if (!isWeekend(localNow.weekday)) {
    const next = nextBusinessDate(localNow.year, localNow.month, localNow.day, 1);
    return zonedToUtcIso(next.year, next.month, next.day, config.businessEndHour, config.businessEndMinute, config.businessTimezone);
  }

  const firstBusiness = nextBusinessDate(localNow.year, localNow.month, localNow.day, 0);
  return zonedToUtcIso(
    firstBusiness.year,
    firstBusiness.month,
    firstBusiness.day,
    config.businessEndHour,
    config.businessEndMinute,
    config.businessTimezone
  );
};

export const computeDefaultDueAt = (
  _taskType: TaskType,
  now: Date,
  urgency: UrgencyLevel = "GREEN",
  config: AppConfig = DEFAULT_CONFIG
): string => {
  return computeDueAtFromUrgency(urgency, now, config);
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

export const canMoveToNeedsReview = (task: LoanTask, user: UserIdentity): boolean => {
  if (task.status !== "CLAIMED" && task.status !== "COMPLETED") {
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

  if (next === "NEEDS_REVIEW" && !canMoveToNeedsReview(task, user)) {
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
