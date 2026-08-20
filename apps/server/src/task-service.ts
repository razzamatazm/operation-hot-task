import {
  AppConfig,
  ChecklistItem,
  ChecklistOp,
  CreateTaskInput,
  LoanTask,
  NotificationEvent,
  TaskHistoryEvent,
  TaskStatus,
  UserIdentity,
  addChecklistItem,
  assignRefusalMessage,
  canAssignTaskTo,
  canClaimTask,
  canDeleteChecklistItem,
  canEditChecklist,
  checklistSeat,
  CLOSED_STATUSES,
  commitChecklistItems,
  canTransitionStatus,
  canUnclaimTask,
  editChecklistItemText,
  removeChecklistItem,
  setChecklistItemChecked,
  setChecklistItemCheckerNote,
  setChecklistItemNote,
  computeDefaultDueAt,
  computeDueAtFromReturnDate,
  computeDueAtFromUrgency,
  firstName,
  formatNewTaskHeadline,
  formatOooHeadline,
  isWithinBusinessHours,
  isOverdue,
  shouldPurgeArchived,
  shouldSendReminder,
  SYSTEM_ACTOR
} from "@loan-tasks/shared";
import { ActivityFeedStateStore, ActivitySignalState, ActivitySignalType, KnownUserState } from "./activity-feed-state.js";
import { v4 as uuid } from "uuid";
import { LoanService } from "./loan-service.js";
import { NotificationProvider } from "./notifications.js";
import { SseHub } from "./sse.js";
import { TaskStore } from "./store.js";

// PENDING_APPROVAL (FRAUD final-approval) is an active checker obligation: it
// takes the normal reminder engine (a fresh end-of-day clock set on entry), so
// it belongs here. AWAITING_ITEMS is deliberately absent — it's a wait on the
// requester and stays fully silent (isOverdue already returns false for it).
const ACTIVE_STATUSES: TaskStatus[] = ["OPEN", "CLAIMED", "NEEDS_REVIEW", "MERGE_DONE", "MERGE_APPROVED", "PENDING_APPROVAL"];
const REMINDER_INTERVAL_MS = 60 * 60 * 1000;
const clampPoints = (points: number): number => Math.max(0, Math.min(5, Math.trunc(points)));

export class TaskService {
  /* Post-response fan-out currently in flight (#119), one chain per task id.
     Every entry has already had its rejection handled by `background`, so
     awaiting them can never reject. Entries are dropped as they drain, so this
     stays bounded by the number of tasks being acted on right now. */
  private readonly backgroundChains = new Map<string, Promise<void>>();

  constructor(
    private readonly store: TaskStore,
    private readonly notifier: NotificationProvider,
    private readonly events: SseHub,
    private readonly appConfig: AppConfig,
    private readonly activityFeedState?: ActivityFeedStateStore,
    private readonly loans?: LoanService
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

  /* Create a task, optionally already handed off (ADR-0002). `assignee` is the
     resolved identity behind `input.assigneeUserId` — the route looks it up and
     checks `canAssignTaskTo`, because this service has no user store. When it's
     present the task is born CLAIMED in ONE operation: a create-then-assign
     follow-up would post the normal claimable channel card first and then edit
     the Claim button away, which the channel sees as a button that appears and
     vanishes, and it would race the backgrounded fan-out. */
  async createTask(
    input: CreateTaskInput,
    user: UserIdentity,
    assignee?: Pick<UserIdentity, "id" | "displayName">
  ): Promise<LoanTask> {
    const now = new Date();
    const isOoo = input.taskType === "OOO";
    const urgency = isOoo ? "GREEN" : input.urgency ?? "GREEN";
    const folderName = (input.folderName ?? "").trim();
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

    // Non-OOO tasks are Loan-scoped (ADR-0001): resolve or create the Loan and
    // link it. OOO tasks are never loan-related and carry no loanId/link.
    let loanId: string | undefined;
    let resolvedFolderName = folderName;
    let resolvedLink = input.humperdinkLink?.trim();
    if (!isOoo && this.loans) {
      const loan = await this.loans.resolveForTask({
        ...(input.loanId ? { loanId: input.loanId } : {}),
        name: folderName,
        ...(resolvedLink ? { humperdinkLink: resolvedLink } : {})
      });
      loanId = loan.id;
      resolvedFolderName = loan.name;
      resolvedLink = loan.humperdinkLink;
    }

    // FRAUD only (#69): the creator can seed outstanding items they already know
    // about at creation. They're persisted as creator-added draft items on pass
    // 0 (before any hand-off), so gated deletion (#66) lets the creator manage
    // them while the task is OPEN and the checker's first send commits them.
    // Non-FRAUD task types have no checklist surface, so the payload is ignored.
    let seededChecklist: ChecklistItem[] = [];
    if (input.taskType === "FRAUD" && input.initialItems) {
      for (const entry of input.initialItems) {
        const text = entry.text.trim();
        if (!text) {
          continue;
        }
        seededChecklist = addChecklistItem(seededChecklist, { id: uuid(), text, addedBy: "creator", addedOnPass: 0 });
      }
    }

    const task: LoanTask = {
      id: uuid(),
      ...(loanId ? { loanId } : {}),
      folderName: resolvedFolderName,
      loanName: resolvedFolderName,
      taskType: input.taskType,
      dueAt,
      urgency,
      points,
      notes: input.notes.trim(),
      // Born assigned (Handoff at creation) → CLAIMED, exactly the end state a
      // claim by that person would have produced.
      status: assignee ? "CLAIMED" : "OPEN",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      createdBy: { id: user.id, displayName: user.displayName },
      ...(assignee ? { assignee: { id: assignee.id, displayName: assignee.displayName } } : {}),
      ...(isOoo && startDate ? { startDate } : {}),
      ...(isOoo && returnDate ? { returnDate } : {}),
      ...(!isOoo && resolvedLink ? { humperdinkLink: resolvedLink } : {}),
      ...(seededChecklist.length > 0 ? { checklist: seededChecklist } : {})
    };

    const createdMessage = isOoo
      ? formatOooHeadline(user.displayName, startDate ?? "", returnDate ?? "")
      : `${formatNewTaskHeadline(user.displayName, task.taskType)}: ${task.folderName}`;

    const event = this.makeHistory(task.id, user, "TASK_CREATED", `Created ${task.taskType} task`);
    await this.store.upsertTask(task, event);
    if (assignee) {
      // The handoff is an event in its own right, so it gets its own audit row
      // rather than hiding inside "Created …".
      await this.store.appendHistory(
        this.makeHistory(task.id, user, "TASK_ASSIGNED", `Assigned to ${assignee.displayName} by ${user.displayName} at creation`)
      );
    }
    this.events.broadcast({ type: "task.changed", payload: task });

    this.background(async () => {
      await this.notify({
        type: "TASK_CREATED",
        task,
        actor: task.createdBy,
        message: createdMessage,
        target: "IN_APP"
      });
      // The channel post is the same one either way; the provider picks the
      // claimed-card variant off `task.assignee` so a born-assigned task is
      // announced without a dead Claim button.
      await this.notify({
        type: "TASK_CREATED",
        task,
        actor: task.createdBy,
        message: createdMessage,
        target: "CHANNEL"
      });
      if (assignee) {
        // The recipient still gets the same handoff DM the assign route sends —
        // being picked at creation is how they find out the task exists.
        const assigneeNote = input.assigneeNote?.trim() || undefined;
        await this.notify({
          type: "TASK_CREATED",
          task,
          actor: task.createdBy,
          message: `${user.displayName} assigned ${task.folderName} to you`,
          target: "DM_ASSIGN",
          recipientUserIds: [assignee.id],
          ...(assigneeNote ? { note: assigneeNote } : {})
        });
      }
      await this.evaluateActivitySignals({ now });
    }, { method: "createTask", taskId: task.id });

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
    // A released FRAUD task (PENDING_APPROVAL with no assignee) is claimed for
    // final approval, NOT reopened — the new checker just becomes the assignee
    // and can Approve directly, so the status must stay PENDING_APPROVAL rather
    // than snap back to CLAIMED. Every other claim starts the work at CLAIMED.
    const claimedStatus: TaskStatus =
      task.taskType === "FRAUD" && task.status === "PENDING_APPROVAL" ? "PENDING_APPROVAL" : "CLAIMED";
    const updated: LoanTask = {
      ...task,
      status: claimedStatus,
      assignee: { id: user.id, displayName: user.displayName },
      updatedAt: now
    };

    const event = this.makeHistory(task.id, user, "TASK_CLAIMED", `Claimed by ${user.displayName}`);
    await this.store.upsertTask(updated, event);
    this.events.broadcast({ type: "task.changed", payload: updated });

    this.background(async () => {
      // No channel thread-reply on claim (Design A) — the root card silently
      // flips to its claimed state via CHANNEL_CLAIMED below, so nobody is
      // re-pinged.
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
      // Update the channel card to its claimed state for everyone — fires for
      // web claims too, not just taps on the card's own Claim button.
      await this.notify({
        type: "TASK_CLAIMED",
        task: updated,
        actor: { id: user.id, displayName: user.displayName },
        message: `${user.displayName} grabbed ${updated.folderName}`,
        target: "CHANNEL_CLAIMED"
      });
      // Open the conversation surface for BOTH parties so they can chat right
      // away (the note card otherwise only appears once the first note is
      // posted).
      await this.notify({
        type: "TASK_CLAIMED",
        task: updated,
        actor: { id: user.id, displayName: user.displayName },
        message: `Chat opened for ${updated.folderName}`,
        target: "DM_CHAT_SEED",
        recipientUserIds: [updated.createdBy.id, user.id]
      });
      // Claiming is a status change like any other; the cards just sent above
      // are already correct, but a card left over from an earlier claim (or a
      // FRAUD release and re-claim) is not.
      await this.emitCardSync(updated);
      await this.evaluateActivitySignals({ now: new Date(now) });
    }, { method: "claimTask", taskId: updated.id });

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

    this.background(async () => {
      // Design A: no thread-reply. Re-post a fresh claimable card as a new
      // thread (re-alerts the channel) and point the old card at it.
      await this.notify({
        type: "TASK_UNCLAIMED",
        task: updated,
        actor: { id: user.id, displayName: user.displayName },
        message: `${updated.folderName} is back up for grabs`,
        target: "CHANNEL_REOPENED"
      });
      // The ex-assignee is no longer on the task, so name them explicitly — their
      // DM card is the one still offering a Complete button they've just lost.
      await this.emitCardSync(updated, task.assignee ? [task.assignee.id] : []);
      await this.evaluateActivitySignals({ now: new Date(now) });
    }, { method: "unclaimTask", taskId: updated.id });

    return updated;
  }

  /* FRAUD "Release for any fraud checker" — the creator (or an admin) hands a
     PENDING_APPROVAL task back to the pool when the original checker is OOO.
     Unassign IN PLACE: status stays PENDING_APPROVAL, only the assignee is
     cleared, so canClaimTask then lets any FILE_CHECKER pick it up and approve
     directly. Private, like the rest of the two-phase back-and-forth — no
     channel post. */
  async releaseForAnyChecker(taskId: string, user: UserIdentity): Promise<LoanTask> {
    const task = await this.requireTask(taskId);

    const isCreator = task.createdBy.id === user.id;
    const isAdmin = user.roles.includes("ADMIN");
    if (!isCreator && !isAdmin) {
      throw new Error("Only the task creator or an admin can release for any fraud checker");
    }
    if (task.taskType !== "FRAUD" || task.status !== "PENDING_APPROVAL") {
      throw new Error("Only a fraud task awaiting approval can be released for any checker");
    }
    if (!task.assignee) {
      // Already in the pool — a double-tap is a harmless no-op.
      return task;
    }

    const now = new Date().toISOString();
    const { assignee: _assignee, ...withoutAssignee } = task;
    const updated: LoanTask = {
      ...withoutAssignee,
      updatedAt: now
    };

    const event = this.makeHistory(task.id, user, "TASK_RELEASED", `Released for any fraud checker by ${user.displayName}`);
    await this.store.upsertTask(updated, event);
    this.events.broadcast({ type: "task.changed", payload: updated });

    this.background(async () => {
      await this.notify({
        type: "TASK_STATUS_CHANGED",
        task: updated,
        actor: { id: user.id, displayName: user.displayName },
        message: `${updated.folderName} is up for grabs — final approval needed`,
        target: "IN_APP"
      });
      // Release strips the assignee without changing status, so the released
      // checker keeps a card offering Approve / Send Back until it's re-rendered.
      await this.emitCardSync(updated, task.assignee ? [task.assignee.id] : []);
      await this.evaluateActivitySignals({ now: new Date(now) });
    }, { method: "releaseForAnyChecker", taskId: updated.id });

    return updated;
  }

  async transitionStatus(taskId: string, next: TaskStatus, user: UserIdentity, reviewNotes?: string): Promise<LoanTask> {
    const task = await this.requireTask(taskId);
    const access = canTransitionStatus(task, next, user);

    if (!access.ok) {
      throw new Error(access.reason ?? "Transition blocked");
    }

    // FRAUD hand-back: entering AWAITING_ITEMS — the checker's initial pass
    // (CLAIMED → AWAITING_ITEMS) or a bounce-back (PENDING_APPROVAL →
    // AWAITING_ITEMS) — cannot go out empty. With the structured checklist (#44)
    // a non-empty checklist IS the payload, so it satisfies the requirement on
    // its own; otherwise the outstanding-items free-text note (which rides in on
    // reviewNotes and seeds the thread) is still required, preserving the #50
    // note-only path (e.g. from a bot card that can't build a checklist).
    const outstandingNote = next === "AWAITING_ITEMS" ? reviewNotes?.trim() : undefined;
    const hasChecklistItems = (task.checklist?.length ?? 0) > 0;
    if (next === "AWAITING_ITEMS" && !outstandingNote && !hasChecklistItems) {
      throw new Error("Sending outstanding items requires a note or at least one checklist item");
    }

    const now = new Date().toISOString();
    const updated: LoanTask = {
      ...task,
      status: next,
      updatedAt: now,
    };
    // FRAUD outstanding-items pass counter (#44): bump on every entry into
    // AWAITING_ITEMS — the checker's first send lands it at 1, each later
    // bounce-back increments it. New checklist items stamp this pass in
    // `addedOnPass`, so the UI can flag "added this round."
    if (next === "AWAITING_ITEMS") {
      updated.checklistPass = (task.checklistPass ?? 0) + 1;
      // Anchor for the web row's "with requester" counter. Stamped on every
      // entry, so a Send Back restarts the clock from that hand-back rather
      // than accumulating across passes.
      updated.awaitingItemsSince = now;
    }
    // FRAUD gated deletion (#66): entering AWAITING_ITEMS (checker's initial
    // send or a bounce-back) or PENDING_APPROVAL (creator's submit) is a
    // hand-off to the other party — commit every existing item so nothing added
    // before this round-trip can be deleted anymore. Freshly-added items after
    // the hand-off start as drafts again and stay deletable by their adder until
    // the next hand-off.
    if ((next === "AWAITING_ITEMS" || next === "PENDING_APPROVAL") && (task.checklist?.length ?? 0) > 0) {
      updated.checklist = commitChecklistItems(task.checklist ?? []);
    }
    if (outstandingNote) {
      // Record the outstanding-items note on the task so the thread has a seed
      // (surfaced on the DM note card below).
      updated.reviewNotes = [
        ...(task.reviewNotes ?? []),
        { text: outstandingNote, by: { id: user.id, displayName: user.displayName }, at: now }
      ];
    }
    if (next === "PENDING_APPROVAL") {
      // Final approval gets a fresh, gentle clock: discard the task's original
      // dueAt/urgency and recompute end-of-current-business-day (the YELLOW
      // path). The normal reminder engine (PENDING_APPROVAL is in
      // ACTIVE_STATUSES) then takes over — quiet the rest of today, hourly next
      // business morning. Clear any stale reminder stamp so the new clock starts
      // clean.
      updated.urgency = "YELLOW";
      updated.dueAt = computeDueAtFromUrgency("YELLOW", new Date(now), this.appConfig);
      delete updated.lastReminderAt;
    }
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
      // Remember the closed status we're reopening from so "Restore" can send
      // the task back to exactly COMPLETED or ARCHIVED (never just OPEN).
      updated.reopenedFrom = task.status;
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
    // Once a task is closed again (restored, completed, cancelled, or archived)
    // it's no longer "reopened" — drop the restore breadcrumb.
    if (updated.status === "COMPLETED" || updated.status === "CANCELLED" || updated.status === "ARCHIVED") {
      delete updated.reopenedFrom;
    }

    const detail = reviewNotes
      ? `${task.status} -> ${next} | Review: ${reviewNotes}`
      : `${task.status} -> ${next}`;
    const event = this.makeHistory(task.id, user, "TASK_STATUS_CHANGED", detail);
    await this.store.upsertTask(updated, event);
    this.events.broadcast({ type: "task.changed", payload: updated });

    this.background(
      () => this.notifyStatusChange({ updated, task, next, user, outstandingNote, now }),
      { method: "transitionStatus", taskId: updated.id }
    );

    return updated;
  }

  /* The whole notification fan-out for a status change, in one place. Extracted
     verbatim from transitionStatus (#119) — the sequence and its conditions are
     unchanged, it just no longer nests a 125-line if-cascade inside a closure
     inside the method that computes the transition. Runs in the background,
     chained per task, so the relative order below is what actually reaches
     Teams. */
  private async notifyStatusChange({
    updated,
    task,
    next,
    user,
    outstandingNote,
    now
  }: {
    /* The already-persisted task, post-transition. */
    updated: LoanTask;
    /* Its pre-transition state — only the participant ids are read, for the
       NEEDS_REVIEW recipient list. */
    task: LoanTask;
    next: TaskStatus;
    user: UserIdentity;
    outstandingNote: string | undefined;
    now: string;
  }): Promise<void> {
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

    // FRAUD entry to AWAITING_ITEMS (private — no channel post): exactly one
    // lifecycle DM to the creator that the ball is now in their court, plus the
    // outstanding-items note itself as a DM note card so the two participants
    // have somewhere to chat. Never repeated; the reminder engine stays silent
    // here (AWAITING_ITEMS is not in ACTIVE_STATUSES and never reads overdue).
    if (next === "AWAITING_ITEMS") {
      await this.notify({
        type: "TASK_STATUS_CHANGED",
        task: updated,
        actor: { id: user.id, displayName: user.displayName },
        message: `Fraud check came back with outstanding items — it's in your court`,
        target: "DM",
        recipientUserIds: [updated.createdBy.id]
      });
      if (outstandingNote) {
        const noteRecipients = Array.from(
          new Set([updated.createdBy.id, updated.assignee?.id].filter((id): id is string => Boolean(id)))
        );
        if (noteRecipients.length > 0) {
          await this.notify({
            type: "TASK_STATUS_CHANGED",
            task: updated,
            actor: { id: user.id, displayName: user.displayName },
            message: outstandingNote,
            target: "DM_NOTE",
            recipientUserIds: noteRecipients
          });
        }
      }
    }

    // FRAUD entry to PENDING_APPROVAL (private — no channel post): exactly one DM
    // to the checker (assignee) that the items are back for review. The fresh
    // end-of-day clock (set above) then hands off to the normal reminder engine.
    if (next === "PENDING_APPROVAL" && updated.assignee) {
      await this.notify({
        type: "TASK_STATUS_CHANGED",
        task: updated,
        actor: { id: user.id, displayName: user.displayName },
        message: `Items are back — ready for your final review`,
        target: "DM",
        recipientUserIds: [updated.assignee.id]
      });
    }

    // Last word on the task's DM cards: every branch above may have sent or
    // rebuilt one, so the sync runs after them and leaves each participant's card
    // showing the step that's actually next. Unconditional — a card frozen on a
    // stale button is a bug at every status, not just the terminal ones.
    await this.emitCardSync(updated);
    await this.evaluateActivitySignals({ now: new Date(now) });
  }

  /* Silently bring a task's DM cards back in line with its live status. Called on
     demand when a card action is rejected — the bot's self-heal for a sync that
     was dropped, since delivery is best-effort and never retried. */
  async resyncTaskCards(taskId: string): Promise<void> {
    const task = await this.store.findTask(taskId);
    if (task) {
      await this.emitCardSync(task);
    }
  }

  /* Ask the notification layer to re-render this task's existing DM cards.
     `alsoNotify` names people who should still be synced even though they're no
     longer participants — an unclaim or a fraud release strips the assignee, and
     it's exactly that ex-assignee holding a card with a button they've lost. */
  private async emitCardSync(task: LoanTask, alsoNotify: string[] = []): Promise<void> {
    await this.notify({
      type: "TASK_STATUS_CHANGED",
      task,
      actor: { id: "system", displayName: "Hot Task" },
      message: `${task.folderName} cards synced`,
      target: "DM_CARD_SYNC",
      ...(alsoNotify.length > 0 ? { recipientUserIds: alsoNotify } : {})
    });
  }

  async addReviewNote(taskId: string, text: string, user: UserIdentity): Promise<LoanTask> {
    const task = await this.requireTask(taskId);

    if (["COMPLETED", "ARCHIVED", "CANCELLED"].includes(task.status)) {
      throw new Error("Notes cannot be added to closed tasks");
    }

    if (!this.canAddNote(task, user)) {
      throw new Error("Only the creator, assignee, or admin can add review notes");
    }

    return this.appendReviewNote(task, text, user);
  }

  /* A reply typed into a DM note card. The card is the one surface that stays
     open on a COMPLETED task — its reply box deliberately survives the terminal
     re-render, because addCompletedNote (#45) exists so people can keep talking
     about finished work — so route that case there instead of at addReviewNote,
     which rejects any closed task. Every other status takes the normal path,
     including CANCELLED/ARCHIVED (whose cards drop the reply box anyway, and
     whose rejection here is the invariant, not a bug). */
  async addNoteFromCard(taskId: string, text: string, user: UserIdentity): Promise<LoanTask> {
    const task = await this.requireTask(taskId);
    return task.status === "COMPLETED"
      ? this.addCompletedNote(taskId, text, user)
      : this.addReviewNote(taskId, text, user);
  }

  /* Add a note to an already-COMPLETED task (issue #45 — the card's "Add a note"
     affordance). Server-atomic: the note is appended while the task stays
     COMPLETED, so there's no visible reopen round-trip and nothing to strand in
     OPEN if a second call fails. Deliberately COMPLETED-only — CANCELLED /
     ARCHIVED tasks stay closed to notes (addReviewNote's invariant), and a
     still-active task uses the normal note composer. completedAt and any
     reopenedFrom breadcrumb are untouched, so Restore semantics stay correct,
     and a single REVIEW_NOTE_ADDED history event is recorded (not a reopen +
     complete pair). Applies to every task type. */
  async addCompletedNote(taskId: string, text: string, user: UserIdentity): Promise<LoanTask> {
    const task = await this.requireTask(taskId);

    if (task.status !== "COMPLETED") {
      throw new Error("A note can only be added here to a COMPLETED task");
    }

    if (!this.canAddNote(task, user)) {
      throw new Error("Only the creator, assignee, or admin can add a note");
    }

    return this.appendReviewNote(task, text, user);
  }

  /* ------------------------------------------------------------------------
     FRAUD structured checklist (#44). Focused, atomic operations mirroring the
     completed-note pattern: each enforces the turn/permission rule
     (canEditChecklist), applies a pure checklist transform, records a single
     history event, persists, and broadcasts. Deletion is GATED (#66):
     removeChecklistItem lets the adding seat drop a fresh, not-yet-handed-off
     item (see canDeleteChecklistItem); committed items are permanently locked.
     The checked/stale invariant lives in the pure
     editChecklistItemText. The approval gate stays where #50 put it (the
     PENDING_APPROVAL → COMPLETED completion gate); this file only adds the item
     mechanics and the pass counter (bumped in transitionStatus).
     ------------------------------------------------------------------------ */

  /* Add an outstanding-items entry. `addedBy` is derived from the actor's real
     role on the task (creator vs checker), not trusted from the client, so a
     creator-added item is reliably flagged for the checker. Stamps the current
     pass. */
  async addChecklistItem(taskId: string, text: string, user: UserIdentity): Promise<LoanTask> {
    const task = await this.requireTask(taskId);
    this.assertChecklistOp(task, user, "add");
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("A checklist item needs some text");
    }
    const addedBy = checklistSeat(task, user);
    if (!addedBy) {
      // Unreachable: assertChecklistOp above refuses anyone holding no seat.
      throw new Error("Only the fraud checker or the requester can add an outstanding item");
    }
    const addedOnPass = task.checklistPass && task.checklistPass > 0 ? task.checklistPass : 1;
    const next = addChecklistItem(task.checklist ?? [], { id: uuid(), text: trimmed, addedBy, addedOnPass });
    return this.persistChecklist(task, next, user, `Added checklist item: ${trimmed}`);
  }

  /* Edit an item's text. Per the checked/stale invariant, editing a checked
     item auto-clears the check and marks it stale (handled by the pure fn). */
  async editChecklistItemText(taskId: string, itemId: string, text: string, user: UserIdentity): Promise<LoanTask> {
    const task = await this.requireTask(taskId);
    this.assertChecklistOp(task, user, "editText");
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("A checklist item needs some text");
    }
    this.requireItem(task, itemId);
    const next = editChecklistItemText(task.checklist ?? [], itemId, trimmed);
    return this.persistChecklist(task, next, user, `Edited checklist item`);
  }

  /* Delete an outstanding-items entry (#66). Gated, not free: only the seat that
     added the item, only on that seat's active editing turn, and only while the
     item is still a fresh draft (not yet handed off) — the full invariant lives
     in the shared canDeleteChecklistItem and is enforced here server-side, not
     just in the UI. Committed items and the other seat's items are rejected. */
  async removeChecklistItem(taskId: string, itemId: string, user: UserIdentity): Promise<LoanTask> {
    const task = await this.requireTask(taskId);
    if (task.taskType !== "FRAUD") {
      throw new Error("Checklists are only on fraud checks");
    }
    const item = (task.checklist ?? []).find((entry) => entry.id === itemId);
    if (!item) {
      throw new Error("Checklist item not found");
    }
    if (!canDeleteChecklistItem(task, user, item)) {
      throw new Error("You can't delete this checklist item");
    }
    const next = removeChecklistItem(task.checklist ?? [], itemId);
    return this.persistChecklist(task, next, user, `Removed checklist item: ${item.text}`);
  }

  /* Toggle an item's resolved (checked) state, optionally recording the
     creator's per-item note in the same gesture. */
  async setChecklistItemChecked(
    taskId: string,
    itemId: string,
    checked: boolean,
    note: string | undefined,
    user: UserIdentity
  ): Promise<LoanTask> {
    const task = await this.requireTask(taskId);
    this.assertChecklistOp(task, user, "toggle");
    this.requireItem(task, itemId);
    const next = setChecklistItemChecked(task.checklist ?? [], itemId, checked, note?.trim());
    return this.persistChecklist(task, next, user, checked ? "Resolved checklist item" : "Reopened checklist item");
  }

  /* Set the creator's per-item exception note. */
  async setChecklistItemNote(taskId: string, itemId: string, note: string, user: UserIdentity): Promise<LoanTask> {
    const task = await this.requireTask(taskId);
    this.assertChecklistOp(task, user, "creatorNote");
    this.requireItem(task, itemId);
    const next = setChecklistItemNote(task.checklist ?? [], itemId, note.trim());
    return this.persistChecklist(task, next, user, "Set checklist item note");
  }

  /* Set the checker's per-item rework note. */
  async setChecklistItemCheckerNote(taskId: string, itemId: string, checkerNote: string, user: UserIdentity): Promise<LoanTask> {
    const task = await this.requireTask(taskId);
    this.assertChecklistOp(task, user, "checkerNote");
    this.requireItem(task, itemId);
    const next = setChecklistItemCheckerNote(task.checklist ?? [], itemId, checkerNote.trim());
    return this.persistChecklist(task, next, user, "Set checklist item checker note");
  }

  /* Enforce the turn/permission gate for a checklist op; throws when the actor
     may not act. Server-authoritative — the client's affordance gating is only
     a hint. */
  private assertChecklistOp(task: LoanTask, user: UserIdentity, op: ChecklistOp): void {
    if (task.taskType !== "FRAUD") {
      throw new Error("Checklists are only on fraud checks");
    }
    if (!canEditChecklist(task, user, op)) {
      throw new Error("You can't change the checklist right now");
    }
  }

  private requireItem(task: LoanTask, itemId: string): void {
    if (!(task.checklist ?? []).some((item) => item.id === itemId)) {
      throw new Error("Checklist item not found");
    }
  }

  /* Persist a new checklist array on the task with one history event, broadcast
     the change, and return the updated task. Never touches status — the
     lifecycle transitions own that. */
  private async persistChecklist(
    task: LoanTask,
    checklist: ChecklistItem[],
    user: UserIdentity,
    detail: string
  ): Promise<LoanTask> {
    const now = new Date().toISOString();
    const updated: LoanTask = { ...task, checklist, updatedAt: now };
    const event = this.makeHistory(task.id, user, "CHECKLIST_UPDATED", detail);
    await this.store.upsertTask(updated, event);
    this.events.broadcast({ type: "task.changed", payload: updated });
    return updated;
  }

  /* Who may attach a review note to a task: its creator, its assignee, or an
     admin. Shared by the active-task composer and the completed-task affordance
     so both gates agree. */
  private canAddNote(task: LoanTask, user: UserIdentity): boolean {
    const isCreator = task.createdBy.id === user.id;
    const isAssignee = task.assignee?.id === user.id;
    const isAdmin = user.roles.includes("ADMIN");
    return isCreator || isAssignee || isAdmin;
  }

  /* Append a ReviewNote to the task and fan out the note notifications. Callers
     own the status/permission guards; this only records the note (a single
     REVIEW_NOTE_ADDED history event), broadcasts the change, and pings the
     participants. Never mutates status, completedAt, or reopenedFrom. */
  private async appendReviewNote(task: LoanTask, text: string, user: UserIdentity): Promise<LoanTask> {
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
    this.background(async () => {
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
    }, { method: "appendReviewNote", taskId: updated.id });

    return updated;
  }

  /* Share a task directly with one person (issue #41). Sends the TARGET a Teams
     bot DM that deep-links to the task — deliberately outside the creator/
     assignee notification flow, so nobody else is pinged. The share is recorded
     in history for audit. Caller (route) validates that the target user exists.

     Returns whether the DM will actually reach the target: a share to a user who
     has never messaged the bot has no stored reference, so the DM is dropped.
     We report that (`delivered: false`) rather than let it vanish silently, so
     the UI can tell the sharer to have them message the bot first. The share
     itself still "succeeds" — the history record + intent stand regardless. */
  async shareTask(params: {
    taskId: string;
    target: { id: string; displayName: string };
    sharedBy: UserIdentity;
    note?: string;
  }): Promise<{ task: LoanTask; delivered: boolean }> {
    const task = await this.requireTask(params.taskId);
    const note = params.note?.trim() || undefined;

    const event = this.makeHistory(
      task.id,
      params.sharedBy,
      "TASK_SHARED",
      `Shared with ${params.target.displayName} by ${params.sharedBy.displayName}`
    );
    await this.store.appendHistory(event);

    // Probe reachability up front so we can report it; the actual send below
    // no-ops for an unreachable target, matching this result. This one stays on
    // the request path — `delivered` is part of the response.
    const delivered = await this.notifier.canReachDm(params.target.id);

    this.background(async () => {
      await this.notify({
        type: "TASK_STATUS_CHANGED",
        task,
        actor: { id: params.sharedBy.id, displayName: params.sharedBy.displayName },
        message: `${firstName(params.sharedBy.displayName)} wants you to see ${task.folderName}`,
        target: "DM_SHARE",
        recipientUserIds: [params.target.id],
        ...(note ? { note } : {})
      });
    }, { method: "shareTask", taskId: task.id });

    return { task, delivered };
  }

  /* Handoff (ADR-0002): point a task at somebody else. Deliberately a sibling of
     `claimTask` rather than a reuse of it — claim couples actor and assignee
     (`assignee = user`), and decoupling it there would contort the one path
     every claim in the app goes through.

     Rules, all settled in ADR-0002:
       - Anyone authenticated may hand off; eligibility is checked on the
         RECIPIENT (`canAssignTaskTo`), which the route has already validated
         and we re-check here because this is the authority.
       - OPEN → CLAIMED (same end state as if they'd claimed it themselves).
         Anything already in flight — CLAIMED, NEEDS_REVIEW, and FRAUD's
         AWAITING_ITEMS / PENDING_APPROVAL — swaps assignee IN PLACE, status
         untouched: "the wrong checker picked this up" is the main reason anyone
         reaches for this, and that task is by definition not OPEN.
       - Handing a task to whoever already holds it is a no-op, not an error.
       - DMs only. No channel post, no activity-feed alert: a handoff is a
         conversation between two people and the channel already saw the task.
       - The note rides the recipient's card only. It is never written as a
         review note — that would fire the DM_NOTE fan-out and double-notify. */
  async assignTask(params: {
    taskId: string;
    target: UserIdentity;
    actor: UserIdentity;
    note?: string;
  }): Promise<LoanTask> {
    const task = await this.requireTask(params.taskId);
    const note = params.note?.trim() || undefined;

    /* Closed first, then the no-op. A closed task is rejected even when the
       target already holds it — otherwise the API quietly 200s on a handoff of
       a COMPLETED task, and "was it rejected?" depends on who you named. */
    if (CLOSED_STATUSES.includes(task.status)) {
      throw new Error("This task is closed — it can't be handed off");
    }
    // Already theirs: nothing to do, and nobody to notify.
    if (task.assignee?.id === params.target.id) {
      return task;
    }
    if (!canAssignTaskTo(task, params.target)) {
      throw new Error(assignRefusalMessage(task.taskType, params.target.displayName));
    }

    const previous = task.assignee;
    const now = new Date().toISOString();
    const updated: LoanTask = {
      ...task,
      status: task.status === "OPEN" ? "CLAIMED" : task.status,
      assignee: { id: params.target.id, displayName: params.target.displayName },
      updatedAt: now
    };

    const detail = previous
      ? `Reassigned from ${previous.displayName} to ${params.target.displayName} by ${params.actor.displayName}`
      : `Assigned to ${params.target.displayName} by ${params.actor.displayName}`;
    const event = this.makeHistory(task.id, params.actor, "TASK_ASSIGNED", detail);
    await this.store.upsertTask(updated, event);
    this.events.broadcast({ type: "task.changed", payload: updated });

    this.background(async () => {
      await this.notify({
        type: "TASK_STATUS_CHANGED",
        task: updated,
        actor: { id: params.actor.id, displayName: params.actor.displayName },
        message: `${params.actor.displayName} assigned ${updated.folderName} to you`,
        target: "DM_ASSIGN",
        recipientUserIds: [params.target.id],
        ...(note ? { note } : {})
      });
      if (previous) {
        // Anyone may pull a task out from under anyone, so the displaced
        // assignee is always told. One line, no card — they have no move left.
        await this.notify({
          type: "TASK_STATUS_CHANGED",
          task: updated,
          actor: { id: params.actor.id, displayName: params.actor.displayName },
          message: `${firstName(params.actor.displayName)} passed ${updated.folderName} to ${params.target.displayName}`,
          target: "DM",
          recipientUserIds: [previous.id]
        });
      }
      /* Recompute signal state so a handed-off OPEN task stops reading as
         claimable — but silently. A handoff moves the task into the recipient's
         court, which mints fresh signal keys under their id (NEEDS_REVIEW,
         OVERDUE); those would fire an activity-feed alert on first sight, since
         the new-signal branch pushes unconditionally and `allowReminders` gates
         only the repeat branch. ADR-0002 says DMs only, and they already have
         the DM_ASSIGN card. */
      await this.evaluateActivitySignals({ now: new Date(now), alertOnNewSignals: false });
    }, { method: "assignTask", taskId: updated.id });

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
        historyEvents.push(this.makeHistory(task.id, SYSTEM_ACTOR, "TASK_STATUS_CHANGED", "AUTO_COMPLETED_RETURN_DATE"));
        await this.notify({
          type: "TASK_STATUS_CHANGED",
          task: next,
          actor: { id: SYSTEM_ACTOR.id, displayName: SYSTEM_ACTOR.displayName },
          message: `${next.folderName} wrapped itself up on the return date`,
          target: "IN_APP"
        });
        await this.notify({
          type: "TASK_STATUS_CHANGED",
          task: next,
          actor: { id: SYSTEM_ACTOR.id, displayName: SYSTEM_ACTOR.displayName },
          message: `Auto-completed while you were out — welcome back`,
          target: "DM",
          recipientUserIds: [next.createdBy.id]
        });
        // The scheduler closes this task without going through transitionStatus,
        // so it has to retire the DM cards itself.
        await this.emitCardSync(next);
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
          // Archiving retires the reply box the COMPLETED banner still allowed.
          await this.emitCardSync(next);
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
            actor: { id: SYSTEM_ACTOR.id, displayName: SYSTEM_ACTOR.displayName },
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

  /* `alertOnNewSignals: false` seeds newly-appeared signal keys into the
     snapshot without notifying anyone for them. Only the handoff path wants
     this: it must recompute state (so a handed-off OPEN task stops reading as
     claimable) while staying DM-only per ADR-0002. The recipient still enters
     the normal reminder cadence on the next `runMaintenance` pass — they're
     silenced for this instant, not exempted. */
  private async evaluateActivitySignals({
    now,
    allowReminders = false,
    alertOnNewSignals = true,
    tasks
  }: {
    now: Date;
    allowReminders?: boolean;
    alertOnNewSignals?: boolean;
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
        if (alertOnNewSignals) {
          notifications.push({
            recipientUserIds: [signal.userId],
            task: signal.task,
            message: signal.message
          });
        }
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
        actor: { id: SYSTEM_ACTOR.id, displayName: SYSTEM_ACTOR.displayName },
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

  /* Run post-response work (notification fan-out + activity-signal evaluation)
     off the request path (#119). A mutating request is only obliged to wait for
     its store write and the in-memory broadcast; everything after that is
     best-effort fan-out, and the Teams-bound parts are network calls whose
     latency we don't control.

     Callers pass ONE async function containing their whole existing sequence,
     so the awaits inside it still run in order — a channel post can never land
     before its in-app counterpart. Never float a bare promise instead: an
     unhandled rejection is a hard process crash in Node, so the rejection is
     caught and logged here, mirroring `notify`'s own failure path.

     Work is chained PER TASK rather than run free. Awaiting used to give a
     second request on the same task an implicit guarantee — claim's fan-out had
     finished before transition's could start — and dropping the await would
     otherwise let a CHANNEL_COMPLETED card edit overtake the CHANNEL_CLAIMED one
     that should precede it. Chaining per task id restores exactly that ordering.
     It is deliberately not ONE global chain: fan-out for unrelated tasks already
     ran concurrently today (concurrent requests), and a single queue would let
     one hanging notifier stall every other task's notifications forever. */
  private background(work: () => Promise<void>, context: { method: string; taskId: string }): void {
    const previous = this.backgroundChains.get(context.taskId) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        await work();
      } catch (error) {
        console.error("background_work_failed", {
          method: context.method,
          taskId: context.taskId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });
    this.backgroundChains.set(context.taskId, next);
    void next.then(() => {
      // Only drop it if nothing else has extended this task's chain meanwhile.
      if (this.backgroundChains.get(context.taskId) === next) {
        this.backgroundChains.delete(context.taskId);
      }
    });
  }

  /* Await every outstanding background fan-out. For tests: the sim tests drive
     the service directly and assert that notifications have been dispatched by
     the time a call resolves. They await this instead of sleeping. The loop is
     load-bearing — a chain can be extended while we're awaiting it. */
  async settleBackgroundWork(): Promise<void> {
    while (this.backgroundChains.size > 0) {
      await Promise.all([...this.backgroundChains.values()]);
    }
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
