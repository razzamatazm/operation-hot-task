export const TASK_TYPES = ["LOI", "BUDDY_CHAT", "VALUE", "FRAUD", "LOAN_DOCS", "OOO"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const NOTES_FIELD_LABELS: Readonly<Record<TaskType, string>> = {
  LOI: "Loan Terms and Contacts",
  BUDDY_CHAT: "Concerns",
  VALUE: "Notes",
  FRAUD: "Outstanding Items and Notes",
  LOAN_DOCS: "Notes",
  OOO: "Notes"
};

export const getNotesFieldLabel = (taskType?: TaskType): string => {
  if (!taskType) {
    return "Notes";
  }
  return NOTES_FIELD_LABELS[taskType] ?? "Notes";
};

export const URGENCY_LEVELS = ["GREEN", "YELLOW", "ORANGE", "RED"] as const;
export type UrgencyLevel = (typeof URGENCY_LEVELS)[number];

/* Human time-frame for each urgency level — used in bot/notification copy so
   we surface the deadline ("Within 1 Hour") rather than the raw colour code. */
export const URGENCY_TIMEFRAMES: Record<UrgencyLevel, string> = {
  GREEN: "Within 24 Hours",
  YELLOW: "End of Day",
  ORANGE: "Within 1 Hour",
  RED: "Urgent Now"
};

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
  /* Entra `preferred_username` / UPN. Optional: header-auth dev users and
     historical task snapshots may not carry it. */
  email?: string;
}

export interface ReviewNote {
  text: string;
  by: Pick<UserIdentity, "id" | "displayName">;
  at: string;
}

export interface LoanTask {
  id: string;
  folderName: string;
  /** @deprecated Compatibility alias for one release window. */
  loanName?: string;
  taskType: TaskType;
  dueAt: string;
  urgency: UrgencyLevel;
  points: number;
  notes: string;
  humperdinkLink?: string;
  /** @deprecated Compatibility alias for one release window. */
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
  reviewNotes?: ReviewNote[];
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
  folderName: string;
  /** @deprecated Compatibility alias for one release window. */
  loanName?: string;
  taskType: TaskType;
  dueAt?: string;
  returnDate?: string;
  urgency?: UrgencyLevel;
  points?: number;
  notes: string;
  humperdinkLink?: string;
  /** @deprecated Compatibility alias for one release window. */
  serverLocation?: string;
}

export interface UpdateTaskStatusInput {
  status: TaskStatus;
  reviewNotes?: string;
}

export interface UpdateTaskPointsInput {
  points: number;
}

export interface NotificationEvent {
  type: "TASK_CREATED" | "TASK_CLAIMED" | "TASK_UNCLAIMED" | "TASK_STATUS_CHANGED" | "TASK_REMINDER" | "TASK_ARCHIVED";
  task: LoanTask;
  actor: Pick<UserIdentity, "id" | "displayName">;
  message: string;
  target: "IN_APP" | "DM" | "CHANNEL" | "CHANNEL_THREAD" | "ACTIVITY_FEED";
  recipientUserIds?: string[];
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
