import type { ChecklistItem } from "./checklist.js";

export const TASK_TYPES = ["LOI", "BUDDY_CHAT", "VALUE", "FRAUD", "LOAN_DOCS", "OOO"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const NOTES_FIELD_LABELS: Readonly<Record<TaskType, string>> = {
  LOI: "Loan Terms and Contacts",
  BUDDY_CHAT: "Concerns",
  VALUE: "Notes",
  // FRAUD's free-text surface is the shared discussion thread (#68): the
  // structured checklist carries outstanding items, and this label heads the
  // card's thread. Relabeled from "Discussion" back to "Notes" for
  // consistency with every other task type (#81). The create form uses its
  // own purpose-built "Notes" label (#69), not this constant.
  FRAUD: "Notes",
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
  // FRAUD-only two-phase completion (#39). After the fraud checker's initial
  // pass, the task lands on AWAITING_ITEMS (checker has sent outstanding items,
  // waiting on the requester) and then PENDING_APPROVAL (requester submitted the
  // items, waiting on the checker's final approval). Both are NON-closed, so
  // notes keep flowing; only PENDING_APPROVAL → COMPLETED closes the task. Never
  // reached by non-FRAUD task types. See workflow.ts FRAUD_FLOW.
  "AWAITING_ITEMS",
  "PENDING_APPROVAL",
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

/* A loan is a first-class, linkable entity (ADR-0001). Name + optional
   Humperdink link live here, not duplicated on every task. The Humperdink
   link is the canonical unique key when present. `aliases` records names
   folded in by an auto-merge on a shared link. */
export interface Loan {
  id: string;
  name: string;
  humperdinkLink?: string;
  aliases?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateLoanInput {
  name: string;
  humperdinkLink?: string;
}

export interface UpdateLoanInput {
  name?: string;
  humperdinkLink?: string;
}

export interface LoanTask {
  id: string;
  /** Live reference to the owning Loan (ADR-0001). Present on every non-OOO
      task; absent on OOO (never loan-related). `folderName`/`humperdinkLink`
      below are a denormalized cache of the linked Loan, kept in sync so all
      existing reads and notification copy keep working. */
  loanId?: string;
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
  /** When a closed task (COMPLETED/ARCHIVED) is reopened back into an active
      status, the closed status it held immediately before the reopen. Drives
      the "Restore" action, which returns the task to exactly that status.
      Cleared as soon as the task reaches a closed status again. */
  reopenedFrom?: TaskStatus;
  lastReminderAt?: string;
  reviewNotes?: ReviewNote[];
  /** FRAUD only (#44): structured outstanding-items checklist that replaces the
      old free-text handoff. Built by the checker, resolved by the creator,
      approved by the checker. Absent on non-FRAUD tasks. */
  checklist?: ChecklistItem[];
  /** FRAUD only (#44): the outstanding-items pass counter. Starts at 1 when the
      checker first sends items (CLAIMED → AWAITING_ITEMS) and increments on
      each bounce-back (PENDING_APPROVAL → AWAITING_ITEMS). New items record the
      pass they were added on (`ChecklistItem.addedOnPass`). */
  checklistPass?: number;
  /** FRAUD only: when the checker last handed the task to the requester, i.e.
      the most recent entry into AWAITING_ITEMS (initial send or a Send Back).
      `updatedAt` can't stand in for this — it is rewritten on every checklist
      edit, which is exactly what the requester does while holding the task, so
      the "with requester" counter would reset each time they tick an item.
      Set on entry, never cleared: nothing reads it in other statuses and
      keeping it leaves a record of the last hand-off. */
  awaitingItemsSince?: string;
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
  /** When set, links the new task to this existing Loan (typeahead select).
      When absent, a Loan is resolved/created from `folderName` server-side. */
  loanId?: string;
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
  /** FRAUD only (#69): outstanding-items the creator already knows about, seeded
      onto the checklist at creation. Persisted as creator-added draft
      `ChecklistItem`s; ignored for non-FRAUD task types. Optional — zero is
      fine, the checker seeds later. */
  initialItems?: { text: string }[];
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
  target: "IN_APP" | "DM" | "DM_NOTE" | "DM_CLAIM" | "DM_CHAT_SEED" | "DM_SHARE" | "CHANNEL" | "CHANNEL_THREAD" | "CHANNEL_CLAIMED" | "CHANNEL_COMPLETED" | "CHANNEL_CANCELLED" | "CHANNEL_REOPENED" | "ACTIVITY_FEED";
  recipientUserIds?: string[];
  /* Free-text note from the actor, surfaced in the recipient's card (issue #41
     share). Optional — only DM_SHARE uses it today. */
  note?: string;
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
