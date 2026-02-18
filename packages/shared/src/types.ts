export const TASK_TYPES = ["LOI", "VALUE", "FRAUD", "LOAN_DOCS"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const URGENCY_LEVELS = ["GREEN", "YELLOW", "ORANGE", "RED"] as const;
export type UrgencyLevel = (typeof URGENCY_LEVELS)[number];

export const USER_ROLES = ["LOAN_OFFICER", "FILE_CHECKER", "ADMIN"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const TASK_STATUSES = [
  "OPEN",
  "CLAIMED",
  "NEEDS_REVIEW",
  "MERGE_DONE",
  "MERGE_APPROVED",
  "COMPLETED",
  "CANCELLED",
  "ARCHIVED"
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface UserIdentity {
  id: string;
  displayName: string;
  roles: UserRole[];
}

export interface LoanTask {
  id: string;
  loanName: string;
  taskType: TaskType;
  dueAt: string;
  urgency: UrgencyLevel;
  notes: string;
  humperdinkLink?: string;
  serverLocation?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: Pick<UserIdentity, "id" | "displayName">;
  assignee?: Pick<UserIdentity, "id" | "displayName">;
  archivedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  lastReminderAt?: string;
  reviewNotes?: string;
}

export interface TaskHistoryEvent {
  id: string;
  taskId: string;
  action: string;
  at: string;
  by: Pick<UserIdentity, "id" | "displayName">;
  detail?: string;
}

export interface CreateTaskInput {
  loanName: string;
  taskType: TaskType;
  dueAt?: string;
  urgency?: UrgencyLevel;
  notes: string;
  humperdinkLink?: string;
  serverLocation?: string;
}

export interface UpdateTaskStatusInput {
  status: TaskStatus;
  reviewNotes?: string;
}

export interface NotificationEvent {
  type: "TASK_CREATED" | "TASK_CLAIMED" | "TASK_UNCLAIMED" | "TASK_STATUS_CHANGED" | "TASK_REMINDER" | "TASK_ARCHIVED";
  task: LoanTask;
  actor: Pick<UserIdentity, "id" | "displayName">;
  message: string;
  target: "IN_APP" | "DM" | "CHANNEL";
  createdAt: string;
}

export interface AppConfig {
  businessTimezone: string;
  businessStartHour: number;
  businessStartMinute: number;
  businessEndHour: number;
  businessEndMinute: number;
  archiveRetentionDays: number;
}
