import { ACTION_LABELS } from "./labels.js";
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

/* FRAUD checks get a two-phase completion (#39). After claiming, the fraud
   checker's initial pass sends outstanding items (CLAIMED → AWAITING_ITEMS);
   the requester then submits those items back (AWAITING_ITEMS →
   PENDING_APPROVAL); finally the fraud checker approves (PENDING_APPROVAL →
   COMPLETED). AWAITING_ITEMS and PENDING_APPROVAL are NON-closed, so notes keep
   flowing during the back-and-forth. Only FRAUD tasks travel this flow; every
   other task type stays on STANDARD_FLOW / LOAN_DOCS_FLOW, byte-for-byte as
   before. See AGENTS.md → Status Model. */
export const FRAUD_FLOW: TaskStatus[] = [
  "OPEN",
  "CLAIMED",
  "AWAITING_ITEMS",
  "PENDING_APPROVAL",
  "COMPLETED",
  "ARCHIVED"
];

/* The ordered status flow a task travels, selected by task type. Parallels the
   LOAN_DOCS / FRAUD / STANDARD split so callers never re-derive it inline. */
export const flowFor = (task: LoanTask): TaskStatus[] =>
  task.taskType === "LOAN_DOCS" ? LOAN_DOCS_FLOW : task.taskType === "FRAUD" ? FRAUD_FLOW : STANDARD_FLOW;

/* The terminal/closed statuses — a task here is done being worked. Canonical
   list so the web view, workflow rules, and services agree on what "closed"
   means. */
export const CLOSED_STATUSES: TaskStatus[] = ["COMPLETED", "CANCELLED", "ARCHIVED"];

const ALWAYS_ALLOWED: Partial<Record<TaskStatus, TaskStatus[]>> = {
  OPEN: ["CANCELLED"],
  CLAIMED: ["NEEDS_REVIEW", "CANCELLED"],
  NEEDS_REVIEW: ["CLAIMED", "COMPLETED", "CANCELLED"],
  COMPLETED: ["NEEDS_REVIEW", "OPEN"],
  ARCHIVED: ["OPEN"],
  MERGE_DONE: ["CLAIMED", "CANCELLED"],
  MERGE_APPROVED: ["CANCELLED"],
  // FRAUD-only two-phase completion. AWAITING_ITEMS can be reopened back to
  // CLAIMED (fraud checker redoes the initial pass) or cancelled;
  // PENDING_APPROVAL can be bounced back to AWAITING_ITEMS (checker wants more)
  // or cancelled. The forward steps (CLAIMED → AWAITING_ITEMS → PENDING_APPROVAL
  // → COMPLETED) come from FRAUD_FLOW, not this map. Only FRAUD tasks reach these
  // statuses, so every other flow is untouched.
  AWAITING_ITEMS: ["CLAIMED", "CANCELLED"],
  PENDING_APPROVAL: ["AWAITING_ITEMS", "CANCELLED"]
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

  // Green is due 24 real hours from creation; if that local due time lands on a weekend, shift to Monday.
  const greenCandidate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const localGreenCandidate = zonedParts(greenCandidate, config.businessTimezone);
  if (!isWeekend(localGreenCandidate.weekday)) {
    return greenCandidate.toISOString();
  }

  const nextBusiness = nextBusinessDate(localGreenCandidate.year, localGreenCandidate.month, localGreenCandidate.day, 0);
  return zonedToUtcIso(
    nextBusiness.year,
    nextBusiness.month,
    nextBusiness.day,
    localGreenCandidate.hour,
    localGreenCandidate.minute,
    config.businessTimezone
  );
};

const ISO_DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const computeDueAtFromReturnDate = (
  returnDate: string,
  config: AppConfig = DEFAULT_CONFIG
): string => {
  const trimmed = returnDate.trim();
  if (!ISO_DATE_ONLY_PATTERN.test(trimmed)) {
    throw new Error("returnDate must be in YYYY-MM-DD format");
  }

  const [yearRaw, monthRaw, dayRaw] = trimmed.split("-");
  const year = Number.parseInt(yearRaw ?? "", 10);
  const month = Number.parseInt(monthRaw ?? "", 10);
  const day = Number.parseInt(dayRaw ?? "", 10);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isFinite(candidate.getTime()) ||
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() + 1 !== month ||
    candidate.getUTCDate() !== day
  ) {
    throw new Error("returnDate must be a valid calendar date");
  }

  return zonedToUtcIso(year, month, day, config.businessStartHour, config.businessStartMinute, config.businessTimezone);
};

export const computeDefaultDueAt = (
  _taskType: TaskType,
  now: Date,
  urgency: UrgencyLevel = "GREEN",
  config: AppConfig = DEFAULT_CONFIG
): string => {
  return computeDueAtFromUrgency(urgency, now, config);
};

const nextForwardStatus = (task: LoanTask): TaskStatus | undefined => {
  const flow = flowFor(task);
  const index = flow.indexOf(task.status);
  return index >= 0 && index < flow.length - 1 ? flow[index + 1] : undefined;
};

/* Keyed by the *target* status. The single source of truth for these strings is
   ACTION_LABELS (#116) — the web quick-action ladder reads the same constants,
   so no surface can invent its own wording. */
export const ADVANCE_LABELS: Partial<Record<TaskStatus, string>> = {
  MERGE_DONE: ACTION_LABELS.MERGE_DONE,
  MERGE_APPROVED: ACTION_LABELS.APPROVE_MERGE,
  COMPLETED: ACTION_LABELS.COMPLETE
};

/* FRAUD's forward action label is keyed by the *current* status, not the target
   (its COMPLETED step reads "Approve", which would collide with the standard
   "Complete" if keyed by target). CLAIMED → "Send Outstanding Items"; then
   "Submit"; then "Approve". */
export const FRAUD_ADVANCE_LABELS: Partial<Record<TaskStatus, string>> = {
  CLAIMED: ACTION_LABELS.SEND_OUTSTANDING_ITEMS,
  AWAITING_ITEMS: ACTION_LABELS.SUBMIT,
  PENDING_APPROVAL: ACTION_LABELS.APPROVE
};

/* The single "move it forward" action to offer on a bot card (Merge Done →
   Approve Merge → Complete for Loan Docs; Send Outstanding Items → Submit →
   Approve for Fraud; Complete for everyone else). Returns undefined
   when there's no forward step worth a button (open/closed tasks). Status-only —
   the actual transition still enforces the caller's permission. */
export const botPrimaryAdvance = (task: LoanTask): { status: TaskStatus; label: string } | undefined => {
  if (task.status === "OPEN" || task.status === "COMPLETED" || task.status === "CANCELLED" || task.status === "ARCHIVED") {
    return undefined;
  }
  const forward = nextForwardStatus(task);
  if (task.taskType === "FRAUD") {
    const label = FRAUD_ADVANCE_LABELS[task.status];
    return forward && forward !== "ARCHIVED" && label ? { status: forward, label } : undefined;
  }
  const target = forward && forward !== "ARCHIVED" ? forward : task.status === "NEEDS_REVIEW" ? "COMPLETED" : undefined;
  if (!target) {
    return undefined;
  }
  const label = ADVANCE_LABELS[target];
  return label ? { status: target, label } : undefined;
};

/* A reopened task remembers the closed status it came from in `reopenedFrom`.
   That closed status is the target of the "Restore" action — the exact status
   to return the task to. Only valid while the task sits in an active status;
   returns undefined once the task is closed again (or was never reopened). */
export const restoreTargetStatus = (task: LoanTask): TaskStatus | undefined => {
  const from = task.reopenedFrom;
  if (from !== "COMPLETED" && from !== "ARCHIVED") {
    return undefined;
  }
  // Only meaningful while the task sits in an active status — once it's closed
  // again the breadcrumb is stale (the service clears it, but guard anyway).
  if (CLOSED_STATUSES.includes(task.status)) {
    return undefined;
  }
  return from;
};

export const nextFlowStatuses = (task: LoanTask): TaskStatus[] => {
  const flow = flowFor(task);
  const index = flow.indexOf(task.status);

  const nextCandidate = index >= 0 && index < flow.length - 1 ? flow[index + 1] : undefined;
  const next = nextCandidate ? [nextCandidate] : [];
  const extra = ALWAYS_ALLOWED[task.status] ?? [];
  const restore = restoreTargetStatus(task);
  return Array.from(new Set([...next, ...extra, ...(restore ? [restore] : [])]));
};

const hasRole = (user: UserIdentity, role: "FILE_CHECKER" | "ADMIN"): boolean => user.roles.includes(role);

export const canClaimTask = (task: LoanTask, user: UserIdentity): boolean => {
  // FRAUD "release for any fraud checker" support: a PENDING_APPROVAL task whose
  // original checker has been unassigned can be picked up by any FILE_CHECKER, so
  // final approval isn't blocked on one person. Any other status still requires
  // OPEN below.
  if (task.taskType === "FRAUD" && task.status === "PENDING_APPROVAL" && !task.assignee) {
    return hasRole(user, "FILE_CHECKER");
  }
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

  // PENDING_APPROVAL is the FRAUD final-approval state; approving it to COMPLETED
  // uses the same gate as any other completion (plus the FILE_CHECKER check
  // above).
  if (
    task.status === "CLAIMED" ||
    task.status === "MERGE_APPROVED" ||
    task.status === "NEEDS_REVIEW" ||
    task.status === "PENDING_APPROVAL"
  ) {
    // Completion belongs to whoever did the work (the assignee). The creator
    // requested the task and can review / re-open / cancel, but doesn't close it
    // out. Admins can always step in.
    const isAssignee = task.assignee?.id === user.id;
    const isAdmin = hasRole(user, "ADMIN");
    return isAssignee || isAdmin;
  }

  return false;
};

/* FRAUD-only: the fraud checker's own moves — sending outstanding items
   (CLAIMED → AWAITING_ITEMS), bouncing an approval request back
   (PENDING_APPROVAL → AWAITING_ITEMS), and reopening the initial pass
   (AWAITING_ITEMS → CLAIMED). Mirrors the completion gate: the assignee (the
   fraud checker) or an admin, and — because it's a FRAUD task — FILE_CHECKER is
   required. Non-FRAUD tasks never reach these statuses. */
export const canFraudCheckerAct = (task: LoanTask, user: UserIdentity): boolean => {
  if (task.taskType !== "FRAUD" || !hasRole(user, "FILE_CHECKER")) {
    return false;
  }
  const isAssignee = task.assignee?.id === user.id;
  const isAdmin = hasRole(user, "ADMIN");
  return isAssignee || isAdmin;
};

/* FRAUD-only: submitting the outstanding items back for approval
   (AWAITING_ITEMS → PENDING_APPROVAL) is the requester's move — the task
   creator, or an admin stepping in. */
export const canSubmitForApproval = (task: LoanTask, user: UserIdentity): boolean => {
  if (task.taskType !== "FRAUD") {
    return false;
  }
  const isCreator = task.createdBy.id === user.id;
  const isAdmin = hasRole(user, "ADMIN");
  return isCreator || isAdmin;
};

/* Restore returns a reopened task to the exact closed status it held before the
   reopen. Unlike normal completion (assignee-only), it's available to whoever
   could have reopened it — creator or assignee — plus admins, so a creator who
   reopened their own task can close it back out without routing through the
   assignee. */
export const canRestoreTask = (task: LoanTask, user: UserIdentity): boolean => {
  if (!restoreTargetStatus(task)) {
    return false;
  }
  const isCreator = task.createdBy.id === user.id;
  const isAssignee = task.assignee?.id === user.id;
  const isAdmin = hasRole(user, "ADMIN");
  return isCreator || isAssignee || isAdmin;
};

export const canTransitionStatus = (task: LoanTask, next: TaskStatus, user: UserIdentity): { ok: boolean; reason?: string } => {
  if (!nextFlowStatuses(task).includes(next)) {
    return { ok: false, reason: `Cannot move from ${task.status} to ${next}` };
  }

  // Restore is a first-class action distinct from the forward workflow: a
  // reopened task moving back to its prior closed status uses restore
  // permission (creator or assignee), not the assignee-only completion gate.
  if (next === restoreTargetStatus(task)) {
    return canRestoreTask(task, user)
      ? { ok: true }
      : { ok: false, reason: "Only the task creator, assignee, or an admin can restore a reopened task" };
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

  if (next === "CLAIMED" && task.status === "MERGE_DONE") {
    const isAssignee = task.assignee?.id === user.id;
    const isAdmin = hasRole(user, "ADMIN");
    if (!isAssignee && !isAdmin) {
      return { ok: false, reason: "Only assignee or admin can undo merge done" };
    }
  }

  // FRAUD: moving *into* AWAITING_ITEMS is the fraud checker's move — whether
  // that's the initial pass (CLAIMED → AWAITING_ITEMS) or a bounce-back from
  // PENDING_APPROVAL. Same for reopening the initial pass (AWAITING_ITEMS →
  // CLAIMED).
  if (next === "AWAITING_ITEMS" && !canFraudCheckerAct(task, user)) {
    return { ok: false, reason: "Only the fraud checker (assignee) or an admin can send outstanding items" };
  }

  if (next === "CLAIMED" && task.status === "AWAITING_ITEMS" && !canFraudCheckerAct(task, user)) {
    return { ok: false, reason: "Only the fraud checker (assignee) or an admin can reopen the initial pass" };
  }

  // FRAUD: submitting the outstanding items for approval is the requester's move.
  if (next === "PENDING_APPROVAL" && !canSubmitForApproval(task, user)) {
    return { ok: false, reason: "Only the task creator or an admin can submit for approval" };
  }

  if (next === "COMPLETED" && !canCompleteTask(task, user)) {
    return { ok: false, reason: "User cannot complete this task" };
  }

  return { ok: true };
};

export const isOverdue = (task: LoanTask, now: Date): boolean => {
  // AWAITING_ITEMS (FRAUD) is a wait-on-the-requester hold: the clock belongs to
  // the requester, not the checker, so it never reads as overdue and stays fully
  // silent (shouldSendReminder short-circuits on isOverdue). PENDING_APPROVAL is
  // an active checker obligation and uses the normal overdue engine.
  if (["COMPLETED", "ARCHIVED", "CANCELLED", "AWAITING_ITEMS"].includes(task.status)) {
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
