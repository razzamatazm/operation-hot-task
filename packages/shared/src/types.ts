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

/* Human, creator-perspective phrase per task type for the "New Task" headline,
   e.g. "Tyler needs a set of loan docs done". OOO isn't a request, so it reads
   as a status instead. */
export const TASK_NEEDS_PHRASE: Readonly<Record<TaskType, string>> = {
  LOI: "needs an LOI checked",
  BUDDY_CHAT: "needs a Buddy Chat",
  VALUE: "needs a Value Check",
  FRAUD: "needs a Fraud Check",
  LOAN_DOCS: "needs a set of loan docs done",
  OOO: "needs OOO Coverage"
};

export const formatNewTaskHeadline = (displayName: string, taskType: TaskType): string =>
  `${displayName} ${TASK_NEEDS_PHRASE[taskType]}`;

/* Friendly, human-facing type name (e.g. "LOI Check") for notification copy and
   the web UI. Replaces the raw "[LOI]" tag in DMs/cards. */
export const TASK_TYPE_LABELS: Readonly<Record<TaskType, string>> = {
  LOI: "LOI Check",
  BUDDY_CHAT: "Buddy Chat",
  VALUE: "Value Check",
  FRAUD: "Fraud Check",
  LOAN_DOCS: "Loan Docs",
  OOO: "Out of Office"
};

/* First word of a display name — "Suzie Lim" → "Suzie". Used in compact
   notification copy. */
export const firstName = (displayName: string): string => displayName.trim().split(/\s+/)[0] ?? displayName;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/* Format a calendar date as "Jun 4, 2026" without any timezone shift. Accepts
   a bare "YYYY-MM-DD" or a full ISO string (uses only the date portion), so a
   date-only value never slips to the previous day under UTC parsing. */
export const formatWallDate = (value: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) {
    return value;
  }
  const [, year, month, day] = match;
  return `${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}`;
};

/* OOO doesn't read as a work request, so it gets its own headline asking for
   coverage across the absence window. */
export const formatOooHeadline = (displayName: string, startDate: string, returnDate: string): string =>
  `Out Of Office - ${displayName} will be out of the office from ${formatWallDate(startDate)} to ${formatWallDate(returnDate)} and needs coverage. Can you help?`;

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
  /** OOO only: raw calendar dates of the absence (YYYY-MM-DD). `dueAt` still
      holds the computed return-time for scheduling/sorting. */
  startDate?: string;
  returnDate?: string;
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
  /** OOO: first day out of office (YYYY-MM-DD). */
  startDate?: string;
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
  target: "IN_APP" | "DM" | "DM_NOTE" | "DM_CLAIM" | "DM_CHAT_SEED" | "CHANNEL" | "CHANNEL_THREAD" | "CHANNEL_CLAIMED" | "CHANNEL_COMPLETED" | "CHANNEL_CANCELLED" | "CHANNEL_REOPENED" | "ACTIVITY_FEED";
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
