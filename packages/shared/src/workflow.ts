import { submitBlockReason } from "./checklist.js";
import { ACTION_LABELS } from "./labels.js";
import { AppConfig, isSystemActor, LoanTask, TASK_TYPE_LABELS, TaskStatus, TaskType, UrgencyLevel, UserIdentity } from "./types.js";

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

/* The two parties to a task: whoever asked for it and whoever is doing it. */
export type PendingParty = "CREATOR" | "ASSIGNEE";

/* Whose move is it? Defined only for the *handoff* statuses — the ones where
   the flow has explicitly passed the ball from one party to the other and is
   waiting on a named person:

     MERGE_DONE       → CREATOR   (approves the merge)
     MERGE_APPROVED   → ASSIGNEE  (completes)
     AWAITING_ITEMS   → CREATOR   (the FRAUD requester submits the items)
     PENDING_APPROVAL → ASSIGNEE  (the fraud checker approves)

   Everything else is undefined on purpose. OPEN is waiting on nobody in
   particular (anyone may claim); CLAIMED means "someone is working on it",
   which is a state, not a handoff; NEEDS_REVIEW is open to creator, assignee
   and admin alike (see canMoveNeedsReview), so no single person holds it.

   The web collapsed row uses this for its passive `Waiting on <name>`
   indicator (#117) so the view never re-derives the flow. Status-only — it
   says who the flow is waiting on, not who is permitted to act, though on the
   merge rungs the two coincide by design: `canApproveMerge` gives MERGE_DONE's
   next move to the same CREATOR this reports. */
export const pendingPartyFor = (task: LoanTask): PendingParty | undefined => {
  switch (task.status) {
    case "MERGE_DONE":
      return "CREATOR";
    case "MERGE_APPROVED":
      return "ASSIGNEE";
    case "AWAITING_ITEMS":
      return "CREATOR";
    case "PENDING_APPROVAL":
      return "ASSIGNEE";
    default:
      return undefined;
  }
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

/* The only role that gates a workflow move. ADMIN used to be the other one;
   since ADR-0003 it is back-end access only and appears in no actor clause in
   this file. */
const isFileChecker = (user: UserIdentity): boolean => user.roles.includes("FILE_CHECKER");

/* SYSTEM (the scheduler) satisfies every *actor* clause below — role
   requirements and party checks alike — because there is no human to hold a
   role or a seat. It does not bypass status or flow legality: the scheduler
   may only make moves the workflow itself allows. See ADR-0003. */
const isSystem = (user: UserIdentity): boolean => isSystemActor(user);

/* Second pair of hands (ADR-0003): a task is a request for someone *else* to
   act, so its creator is never its assignee. You can't have a Buddy Chat with
   yourself, you can't cover your own vacation, and the whole point of a Fraud
   Check is that a second person looks at the file.

   This is a property of the TASK, not of the actor, which is why it reads off
   `task.createdBy` and never off who is asking: a third party handing a task
   back to its creator is refused on exactly the same grounds as the creator
   claiming it. No task type is exempt, and there is no admin override. */
const CREATOR_IS_ASSIGNEE = "created this task — a task takes a second pair of hands";

/* The whole of "may this person be this task's assignee", as a reason or
   `undefined` for yes. One function so the four doors an assignee can come
   through — claim, handoff, self-handoff, and assignment at creation — give the
   same answer AND the same explanation. Takes only the two fields it needs, so
   the create path can ask before the task exists.

   Does not consider status: a closed task rejects a handoff for its own
   reasons, which is `canAssignTaskTo`'s business. */
export const assigneeRefusal = (
  task: Pick<LoanTask, "taskType" | "createdBy">,
  candidate: UserIdentity
): string | undefined => {
  if (task.createdBy.id === candidate.id) {
    return `${candidate.displayName} ${CREATOR_IS_ASSIGNEE}`;
  }
  if (!canWorkTaskType(task.taskType, candidate)) {
    return assignRefusalMessage(task.taskType, candidate.displayName);
  }
  return undefined;
};

export const canBeAssignee = (
  task: Pick<LoanTask, "taskType" | "createdBy">,
  candidate: UserIdentity
): boolean => assigneeRefusal(task, candidate) === undefined;

/* Everyone in `candidates` who could hold this task — the picker's list, and
   the answer to "is there anybody to do this?". Takes the same task shape as
   `assigneeRefusal`, so the create form can ask before the task exists.

   Worth having as one function because the empty case is load-bearing: when a
   file checker files a Fraud Check and this comes back empty, nobody can work
   it, and the form has to say so at filing time rather than let it fail
   silently at claim time (ADR-0003 accepts that deadlock as the cost of
   separation of duties — the fix is a redirect, not an escape hatch). */
export const eligibleAssignees = <T extends UserIdentity>(
  task: Pick<LoanTask, "taskType" | "createdBy">,
  candidates: T[]
): T[] => candidates.filter((candidate) => canBeAssignee(task, candidate));

export const canClaimTask = (task: LoanTask, user: UserIdentity): boolean => {
  // Door one of four: claiming. The type/role rule and the second-pair-of-hands
  // rule both live in `canBeAssignee`, so this only decides *when* a claim is
  // on offer. The FILE_CHECKER requirement for a Fraud Check — and SYSTEM's
  // bypass of it — ride along in `canWorkTaskType` rather than being repeated
  // here.
  if (!canBeAssignee(task, user)) {
    return false;
  }
  /* A FRAUD task with no assignee is in the pool at whatever status it was
     released at. Both release paths unassign IN PLACE — the creator's "release
     for any fraud checker" (PENDING_APPROVAL) and the auto-release when a
     checker loses the seat (#145, any live status) — so the pool is defined by
     the empty seat, not by the status. Any file checker picks it up and carries
     on from where it was.

     Gating this on PENDING_APPROVAL stranded a check released from CLAIMED or
     AWAITING_ITEMS: nobody could claim it, `canFraudCheckerAct` needs an
     assignee, and the requester can't move it alone, so only a handoff got it
     back. Closed tasks are out of play (`canBeAssignee` is status-free). */
  if (task.taskType === "FRAUD" && !task.assignee && !CLOSED_STATUSES.includes(task.status)) {
    return true;
  }
  return task.status === "OPEN";
};

/* Why this user can't claim this task. `canClaimTask` is the gate; this is the
   sentence shown when it says no, so a refusal reads as a rule rather than a
   bug. */
export const claimRefusalMessage = (task: LoanTask, user: UserIdentity): string =>
  assigneeRefusal(task, user) ?? "This task isn't up for grabs right now";

/* Handoff (ADR-0002): may this task be handed to this person?
   Eligibility is checked on the RECIPIENT, never the actor — anyone
   authenticated may hand a task off, but only to someone who could work it.
   FRAUD mirrors `canClaimTask` above: fraud checks are FILE_CHECKER-only, so a
   handoff can't route one to someone who then can't complete it. Closed tasks
   (COMPLETED / CANCELLED / ARCHIVED) are out of play entirely.

   Self-handoff is deliberately allowed: it is just a claim, and is sometimes
   the only way to take a task that `canClaimTask` won't let you claim (already
   claimed by someone else). Handing a task to whoever already holds it is a
   no-op, not an error, and the caller treats it as such.

   ADR-0003 narrows that one step: self-handoff survives for everyone EXCEPT the
   task's creator, who is refused here like anyone else routing a task back to
   it. That's the door ADR-0002's version left open. */
export const canAssignTaskTo = (task: LoanTask, targetUser: UserIdentity): boolean => {
  if (CLOSED_STATUSES.includes(task.status)) {
    return false;
  }
  return canBeAssignee(task, targetUser);
};

/* The role half of `canAssignTaskTo`, split out for the one caller that has no
   task yet: creating a task already handed off (`assigneeUserId` on the create
   payload) has to check the recipient before the task exists. */
export const canWorkTaskType = (taskType: TaskType, user: UserIdentity): boolean =>
  taskType !== "FRAUD" || isSystem(user) || isFileChecker(user);

/* The refusal a rejected handoff shows. Both enforcement points — the route
   (create-with-assignee) and `TaskService.assignTask` — surface this exact
   string, and the web popover renders it inline next to the picker, so it is
   user-facing copy and belongs beside the rule it explains rather than being
   retyped at each throw site. */
export const assignRefusalMessage = (taskType: TaskType, targetName: string): string =>
  `${targetName} can't take a ${TASK_TYPE_LABELS[taskType]} — that needs a file checker`;

/* Who may attach a review note to a task: its creator or its assignee. The
   thread is a conversation between the two people with a stake in the task, so
   an admin who is neither is not in it (ADR-0003). Status-free — the composer
   and the completed-card affordance apply their own status rules on top. */
export const canAddNoteToTask = (task: LoanTask, user: UserIdentity): boolean => {
  const isCreator = task.createdBy.id === user.id;
  const isAssignee = task.assignee?.id === user.id;
  return isCreator || isAssignee;
};

export const canUnclaimTask = (task: LoanTask, user: UserIdentity): boolean => {
  if (task.status !== "CLAIMED") {
    return false;
  }

  const isAssignee = task.assignee?.id === user.id;
  return isSystem(user) || isAssignee;
};

/* LOAN_DOCS merge seat (#173). The merge chain hands the ball from one named
   person to the other, so each rung belongs to exactly one of them:

     CLAIMED    → MERGE_DONE      the assignee — they did the merge
     MERGE_DONE → MERGE_APPROVED  the creator — they requested it and sign off

   Both were unguarded: `canTransitionStatus` had no clause for either, so they
   fell through to `{ ok: true }` for anyone, and the rules survived only as
   inline checks in the web ladder. An assignee approving their own merge
   defeats the approval step; a creator marking a merge done speaks for work
   they didn't do. ADMIN confers nothing here (ADR-0003).

   Status-guarded like `canUnclaimTask` so they answer safely on their own, and
   in agreement with `pendingPartyFor`: the party that status says the flow is
   waiting on is the party permitted to make the move out of it. */
export const canMarkMergeDone = (task: LoanTask, user: UserIdentity): boolean => {
  if (task.taskType !== "LOAN_DOCS" || task.status !== "CLAIMED") {
    return false;
  }

  const isAssignee = task.assignee?.id === user.id;
  return isSystem(user) || isAssignee;
};

export const canApproveMerge = (task: LoanTask, user: UserIdentity): boolean => {
  if (task.status !== "MERGE_DONE") {
    return false;
  }

  const isCreator = task.createdBy.id === user.id;
  return isSystem(user) || isCreator;
};

export const canCancelTask = (task: LoanTask, user: UserIdentity): boolean => {
  const isCreator = task.createdBy.id === user.id;
  return isSystem(user) || isCreator;
};

export const canMoveToNeedsReview = (task: LoanTask, user: UserIdentity): boolean => {
  if (task.status !== "CLAIMED" && task.status !== "COMPLETED") {
    return false;
  }

  const isCreator = task.createdBy.id === user.id;
  const isAssignee = task.assignee?.id === user.id;
  return isSystem(user) || isCreator || isAssignee;
};

export const canMoveNeedsReview = (task: LoanTask, user: UserIdentity): boolean => {
  if (task.status !== "NEEDS_REVIEW") {
    return false;
  }

  const isCreator = task.createdBy.id === user.id;
  const isAssignee = task.assignee?.id === user.id;
  return isSystem(user) || isCreator || isAssignee;
};

export const canCompleteTask = (task: LoanTask, user: UserIdentity): boolean => {
  if (task.taskType === "FRAUD" && !isSystem(user) && !isFileChecker(user)) {
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
    // out — and neither does an admin, who is not a party to it.
    const isAssignee = task.assignee?.id === user.id;
    return isSystem(user) || isAssignee;
  }

  return false;
};

/* FRAUD-only: the fraud checker's own moves — sending outstanding items
   (CLAIMED → AWAITING_ITEMS), bouncing an approval request back
   (PENDING_APPROVAL → AWAITING_ITEMS), and reopening the initial pass
   (AWAITING_ITEMS → CLAIMED). Mirrors the completion gate: the assignee (the
   fraud checker), and — because it's a FRAUD task — FILE_CHECKER is required.
   Non-FRAUD tasks never reach these statuses. */
export const canFraudCheckerAct = (task: LoanTask, user: UserIdentity): boolean => {
  if (task.taskType !== "FRAUD") {
    return false;
  }
  if (!isSystem(user) && !isFileChecker(user)) {
    return false;
  }
  const isAssignee = task.assignee?.id === user.id;
  return isSystem(user) || isAssignee;
};

/* FRAUD-only: submitting the outstanding items back for approval
   (AWAITING_ITEMS → PENDING_APPROVAL) is the requester's move — the task
   creator's alone. */
export const canSubmitForApproval = (task: LoanTask, user: UserIdentity): boolean => {
  if (task.taskType !== "FRAUD") {
    return false;
  }
  const isCreator = task.createdBy.id === user.id;
  return isSystem(user) || isCreator;
};

/* Restore returns a reopened task to the exact closed status it held before the
   reopen. Unlike normal completion (assignee-only), it's available to whoever
   could have reopened it — creator or assignee — so a creator who reopened
   their own task can close it back out without routing through the assignee. */
export const canRestoreTask = (task: LoanTask, user: UserIdentity): boolean => {
  if (!restoreTargetStatus(task)) {
    return false;
  }
  const isCreator = task.createdBy.id === user.id;
  const isAssignee = task.assignee?.id === user.id;
  return isSystem(user) || isCreator || isAssignee;
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
      : { ok: false, reason: "Only the task creator or assignee can restore a reopened task" };
  }

  if (next === "CANCELLED" && !canCancelTask(task, user)) {
    return { ok: false, reason: "Only the task creator can cancel a task" };
  }

  if (next === "NEEDS_REVIEW" && !canMoveToNeedsReview(task, user)) {
    return { ok: false, reason: "Only assignee or creator can mark as needs review" };
  }

  if ((next === "CLAIMED" || next === "COMPLETED") && task.status === "NEEDS_REVIEW" && !canMoveNeedsReview(task, user)) {
    return { ok: false, reason: "Only assignee or creator can move a needs review task" };
  }

  if (next === "MERGE_DONE" && !canMarkMergeDone(task, user)) {
    return { ok: false, reason: "Only the assignee can mark the merge done" };
  }

  if (next === "MERGE_APPROVED" && !canApproveMerge(task, user)) {
    return { ok: false, reason: "Only the task creator can approve the merge" };
  }

  if (next === "CLAIMED" && task.status === "MERGE_DONE") {
    const isAssignee = task.assignee?.id === user.id;
    if (!isSystem(user) && !isAssignee) {
      return { ok: false, reason: "Only the assignee can undo merge done" };
    }
  }

  // FRAUD: moving *into* AWAITING_ITEMS is the fraud checker's move — whether
  // that's the initial pass (CLAIMED → AWAITING_ITEMS) or a bounce-back from
  // PENDING_APPROVAL. Same for reopening the initial pass (AWAITING_ITEMS →
  // CLAIMED).
  if (next === "AWAITING_ITEMS" && !canFraudCheckerAct(task, user)) {
    return { ok: false, reason: "Only the fraud checker (assignee) can send outstanding items" };
  }

  if (next === "CLAIMED" && task.status === "AWAITING_ITEMS" && !canFraudCheckerAct(task, user)) {
    return { ok: false, reason: "Only the fraud checker (assignee) can reopen the initial pass" };
  }

  // FRAUD: submitting the outstanding items for approval is the requester's
  // move, and only once they've said something about every item (#184).
  if (next === "PENDING_APPROVAL") {
    if (!canSubmitForApproval(task, user)) {
      return { ok: false, reason: "Only the task creator can submit for approval" };
    }
    /* The gate is about the task's state, not who you are, which is why it sits
       here rather than in `canSubmitForApproval`: the refusal carries a reason
       the caller can surface, and the seat check above stays a seat check. The
       system actor bypasses it like every other gate. */
    const blocked = isSystem(user) ? undefined : submitBlockReason(task.checklist ?? []);
    if (blocked) {
      return { ok: false, reason: blocked };
    }
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
