import {
  AppConfig,
  ChecklistItem,
  ChecklistSeat,
  CreateTaskInput,
  LoanTask,
  NotificationEvent,
  TaskHistoryEvent,
  TaskStatus,
  UserIdentity,
  addChecklistItem,
  assignRefusalMessage,
  canAddNoteToTask,
  canClaimTask,
  canDeleteChecklistItem,
  canEditChecklist,
  canEditChecklistItemText,
  checklistSeat,
  CLOSED_STATUSES,
  commitChecklistItems,
  canTransitionStatus,
  canUnclaimTask,
  assigneeRefusal,
  handoffRefusal,
  returnToPoolRefusal,
  claimRefusalMessage,
  editChecklistItemText,
  removeChecklistItem,
  setChecklistItemChecked,
  setChecklistItemNote,
  computeDefaultDueAt,
  computeDueAtFromReturnDate,
  computeDueAtFromUrgency,
  computeClaimAnchoredDueAt,
  isPoolNagDue,
  isPoolNagEligible,
  UNCLAIMED_ALERT_MS,
  isDeadlineRecomputeExempt,
  firstName,
  formatNewTaskHeadline,
  formatOooHeadline,
  isWithinBusinessHours,
  isOverdue,
  isSystemActor,
  submitBlockReason,
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
    /* Full identity, not a name/id pair: the eligibility check below needs the
       recipient's live roles. */
    assignee?: UserIdentity
  ): Promise<LoanTask> {
    const now = new Date();
    const isOoo = input.taskType === "OOO";
    const urgency = isOoo ? "GREEN" : input.urgency ?? "GREEN";
    const folderName = (input.folderName ?? "").trim();
    const points = clampPoints(input.points ?? 0);
    /* A born-assigned task arrives with a holder, so it is claimed at the same
       instant it is filed and gets the same anchored window a claim would give
       it (ADR-0005). Without this a born-assigned RED task is due the moment it
       exists — overdue on arrival, which is the exact bug #181 is about, just
       through the one door that never passes through `withNewHolder`.

       Unassigned still uses the plain default: an unclaimed task's `dueAt` is an
       ordering signal for the pool, not yet anybody's deadline. */
    const dueAt = isOoo
      ? computeDueAtFromReturnDate(input.returnDate ?? "", this.appConfig)
      : input.dueAt ??
        (assignee
          ? computeClaimAnchoredDueAt(urgency, now, this.appConfig)
          : computeDefaultDueAt(input.taskType, now, urgency, this.appConfig));
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

    /* Door four of four (ADR-0003): a task can be born assigned, and it must
       not be born assigned to its own creator. The guard lives here rather than
       in the route so one seam covers it — the route only resolves the id to an
       identity. */
    if (assignee) {
      const refusal = assigneeRefusal(
        { taskType: input.taskType, createdBy: { id: user.id, displayName: user.displayName } },
        assignee
      );
      if (refusal) {
        throw new Error(refusal);
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
    // The creator's alone: the points say what the creator thinks the ask is
    // worth. Admin used to be permitted here while the message said otherwise
    // (ADR-0003) — now the rule and the sentence agree.
    if (task.createdBy.id !== user.id) {
      throw new Error("Only the task creator can change poops");
    }
    if (!ACTIVE_STATUSES.includes(task.status)) {
      throw new Error("Poops cannot be changed on a closed task");
    }
    const next = clampPoints(points);
    if (next === task.points) {
      return task;
    }
    const event = this.makeHistory(task.id, user, "TASK_POINTS_UPDATED", `Poops set to ${next}`);
    return this.writeTask(task.id, (current) => ({
      task: { ...current, points: next, updatedAt: new Date().toISOString() },
      event
    }));
  }

  /* Everything that changes because the task has a new holder. The deadline
     belongs to whoever currently holds it, so every door an assignee arrives
     through re-anchors it to that instant (ADR-0005). Not unclaim or release,
     since the next claimer re-anchors anyway. Born-assigned does not come
     through here — creation and claim are the same moment, so the create path
     anchors it directly.

     The nag clock is dropped regardless of the deadline exemptions: somebody is
     on the task now, so it has stopped being the pool's problem whatever its
     type. The spent-nag count goes with it, because a task that comes back to
     the pool later is a fresh ask of the room and deserves its own ceiling
     rather than inheriting an exhausted one (#207). */
  private withNewHolder(current: LoanTask, at: string): LoanTask {
    const next = { ...current };
    delete next.lastPoolNagAt;
    delete next.poolNagCount;
    if (isDeadlineRecomputeExempt(current)) {
      return next;
    }

    next.dueAt = computeClaimAnchoredDueAt(current.urgency, new Date(at), this.appConfig);
    // The fresh clock deserves a fresh reminder cadence, matching what the
    // PENDING_APPROVAL transition already does when it restamps its own dueAt.
    delete next.lastReminderAt;
    return next;
  }

  async claimTask(taskId: string, user: UserIdentity): Promise<LoanTask> {
    const task = await this.requireTask(taskId);

    if (!canClaimTask(task, user)) {
      throw new Error(claimRefusalMessage(task, user));
    }

    const now = new Date().toISOString();
    // A released FRAUD task (unassigned past OPEN) is claimed to carry on from
    // where it was, NOT reopened — the new checker becomes the assignee at the
    // same status, so one released at PENDING_APPROVAL can be approved directly
    // and one released at AWAITING_ITEMS is still awaiting the requester's
    // items. Snapping back to CLAIMED would restart the exchange and throw away
    // the round-trip. Every other claim starts the work at CLAIMED.
    const claimedStatus: TaskStatus =
      task.taskType === "FRAUD" && task.status !== "OPEN" ? task.status : "CLAIMED";
    const event = this.makeHistory(task.id, user, "TASK_CLAIMED", `Claimed by ${user.displayName}`);
    const updated = await this.writeTask(task.id, (current) => ({
      task: {
        ...this.withNewHolder(current, now),
        status: claimedStatus,
        assignee: { id: user.id, displayName: user.displayName },
        updatedAt: now
      },
      event
    }));

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
      throw new Error("Only the assignee can unclaim this task");
    }

    return this.sendBackToPool(task, user, {
      detail: `Returned to open queue by ${user.displayName}`,
      method: "unclaimTask"
    });
  }

  /* "Back to the pool" (#208) — the creator takes their own request off a holder
     who has stalled on it.

     This is the replacement for self-assignment. Taking over a stalled task used
     to be something the taker did directly, by handing the task to themselves;
     that door is closed, so somebody has to be able to free it, and it is the
     person who asked for the work. The task lands OPEN and unassigned, the
     channel gets a claimable card, and the next holder arrives through the front
     door in the open.

     The creator cannot then take it themselves — ADR-0003 still bars them from
     their own task, which is exactly why this is a release and not a transfer. */
  async returnToPool(taskId: string, user: UserIdentity): Promise<LoanTask> {
    const task = await this.requireTask(taskId);

    const refusal = returnToPoolRefusal(task, user);
    if (refusal) {
      throw new Error(refusal);
    }

    return this.sendBackToPool(task, user, {
      detail: `Put back in the pool by ${user.displayName}`,
      method: "returnToPool"
    });
  }

  /* The mechanism the two doors out of CLAIMED share — the assignee walking away
     (`unclaimTask`) and the creator taking it back (`returnToPool`) — clearing
     the seat, dropping the task to OPEN, recording it, and re-alerting the
     channel. The POLICY — who may do it, and what the history reads — belongs to
     the callers; this is only the move.

     Distinct from `unassignInPlace` below, which keeps the status where it is.
     That one is for a release mid-exchange, where the next holder should inherit
     the pass and carry on. This one is for a task going back to the start of its
     life, which is what "the pool" means. */
  private async sendBackToPool(
    task: LoanTask,
    actor: UserIdentity,
    { detail, method }: { detail: string; method: string }
  ): Promise<LoanTask> {
    const now = new Date().toISOString();
    const exAssigneeId = task.assignee?.id;
    const event = this.makeHistory(task.id, actor, "TASK_UNCLAIMED", detail);
    const updated = await this.writeTask(task.id, (current) => {
      /* The task is the pool's problem again, and the CHANNEL_REOPENED post
         below is nag zero (#207) — so stamp the nag clock rather than leaving it
         absent. An absent stamp falls back to `createdAt`, which for anything
         that already sat out its first 20 minutes means a nag fires seconds
         after the reopen post, saying the same thing twice. That reasoning is
         why the stamp belongs on this shared seam rather than in either caller:
         both doors post the card, so both are nag zero, and the creator's door
         (#208) arrived after the rule and inherited it for free. */
      const { assignee: _assignee, ...withoutAssignee } = current;
      return { task: { ...withoutAssignee, status: "OPEN", lastPoolNagAt: now, updatedAt: now }, event };
    });

    this.background(async () => {
      // Design A: no thread-reply. Re-post a fresh claimable card as a new
      // thread (re-alerts the channel) and point the old card at it.
      await this.notify({
        type: "TASK_UNCLAIMED",
        task: updated,
        actor: { id: actor.id, displayName: actor.displayName },
        message: `${updated.folderName} is back up for grabs`,
        target: "CHANNEL_REOPENED"
      });
      // The ex-assignee is no longer on the task, so name them explicitly — their
      // DM card is the one still offering a Complete button they've just lost.
      // When the creator is the one freeing it, this is also how the displaced
      // holder finds out.
      await this.emitCardSync(updated, exAssigneeId ? [exAssigneeId] : []);
      await this.evaluateActivitySignals({ now: new Date(now) });
    }, { method, taskId: updated.id });

    return updated;
  }

  /* FRAUD "Release for any fraud checker" — the creator hands a
     PENDING_APPROVAL task back to the pool when the original checker is OOO.
     Unassign IN PLACE: status stays PENDING_APPROVAL, only the assignee is
     cleared, so canClaimTask then lets any FILE_CHECKER pick it up and approve
     directly. Unlike the rest of the two-phase back-and-forth, which is
     private, this one posts to the channel: it is a request for somebody new,
     and the channel is where an unheld task gets picked up. */
  async releaseForAnyChecker(taskId: string, user: UserIdentity): Promise<LoanTask> {
    const task = await this.requireTask(taskId);

    if (task.createdBy.id !== user.id) {
      throw new Error("Only the task creator can release for any fraud checker");
    }
    if (task.taskType !== "FRAUD" || task.status !== "PENDING_APPROVAL") {
      throw new Error("Only a fraud task awaiting approval can be released for any checker");
    }
    if (!task.assignee) {
      // Already in the pool — a double-tap is a harmless no-op.
      return task;
    }

    return this.unassignInPlace(task, user, {
      detail: `Released for any fraud checker by ${user.displayName}`,
      message: `${task.folderName} is up for grabs — final approval needed`,
      method: "releaseForAnyChecker"
    });
  }

  /* The mechanism the releases share: clear the assignee, leave the status
     exactly where it is, record it, and tell the people looking at stale
     buttons. The POLICY — who may do it, and why — belongs to the callers; this
     is only the move. Returns the updated task.

     "In place" is the whole point: the exchange resumes from wherever it had
     got to rather than restarting, so whoever picks the task up next inherits
     the pass, the checklist and the status. */
  private async unassignInPlace(
    task: LoanTask,
    actor: UserIdentity,
    { detail, message, method, sweepActivity = true }: { detail: string; message: string; method: string; sweepActivity?: boolean }
  ): Promise<LoanTask> {
    const now = new Date().toISOString();
    const exAssigneeId = task.assignee?.id;
    const event = this.makeHistory(task.id, actor, "TASK_RELEASED", detail);
    const updated = await this.writeTask(task.id, (current) => {
      const { assignee: _assignee, ...withoutAssignee } = current;
      return { task: { ...withoutAssignee, updatedAt: now }, event };
    });

    this.background(async () => {
      await this.notify({
        type: "TASK_STATUS_CHANGED",
        task: updated,
        actor: { id: actor.id, displayName: actor.displayName },
        message,
        target: "IN_APP"
      });
      // Back in the pool is only useful if somebody notices: repost the
      // claimable card to the channel so a file checker can pick it up from
      // there. It lives on this shared seam rather than in the two callers so
      // neither release can be added later and forget to announce itself.
      await this.notify({
        type: "TASK_UNCLAIMED",
        task: updated,
        actor: { id: actor.id, displayName: actor.displayName },
        message,
        target: "CHANNEL_RELEASED"
      });
      // The release strips the assignee without changing status, so the ex-
      // checker keeps a card offering moves they've just lost until it re-renders.
      await this.emitCardSync(updated, exAssigneeId ? [exAssigneeId] : []);
      if (sweepActivity) {
        await this.evaluateActivitySignals({ now: new Date(now) });
      }
    }, { method, taskId: updated.id });

    return updated;
  }

  /* The live Fraud Checks this person currently holds as checker. "Live" means
     any status that isn't closed — the seat exists for as long as the exchange
     does, not just while it's their turn.

     Read-only, and separate from the release below, because the admin panel has
     to be able to say what a demotion is about to do BEFORE it does it. */
  async liveFraudChecksForChecker(userId: string): Promise<LoanTask[]> {
    const tasks = await this.store.allTasks();
    return tasks.filter(
      (task) => task.taskType === "FRAUD" && task.assignee?.id === userId && !CLOSED_STATUSES.includes(task.status)
    );
  }

  /* Hand this person's live Fraud Checks back to the pool, because they can no
     longer hold the checker seat — their FILE_CHECKER role was removed, or they
     were deactivated. The role IS the check, so keeping the seat without it is
     meaningless; the alternative is a task stranded in whatever status it sat
     in, with nobody able to act and nothing announcing it.

     Same semantics as the requester's manual release: unassign IN PLACE, status
     untouched, so any file checker can claim it and carry on from where it was
     rather than restarting. Closed checks are left alone — that record is
     finished. The actor is the admin making the change, so history names the
     person who caused it rather than the person who lost the seat. */
  async releaseFraudChecksForChecker(userId: string, actor: UserIdentity): Promise<LoanTask[]> {
    const affected = await this.liveFraudChecksForChecker(userId);
    const released: LoanTask[] = [];

    for (const { id } of affected) {
      // Re-read: the list was taken before any of these awaits, and the seat's
      // own checklist edits rewrite the task while we work through it.
      const task = await this.store.findTask(id);
      if (!task || task.assignee?.id !== userId || CLOSED_STATUSES.includes(task.status)) {
        continue;
      }
      try {
        released.push(
          await this.unassignInPlace(task, actor, {
            detail: `Released for any fraud checker — ${task.assignee?.displayName ?? "the checker"} can no longer check files`,
            message: `${task.folderName} is up for grabs — its fraud checker can no longer check files`,
            method: "releaseFraudChecksForChecker",
            // One sweep after the loop instead of one per task: they read and
            // replace the same activity snapshot, so N in parallel lose each
            // other's writes.
            sweepActivity: false
          })
        );
      } catch (error) {
        /* One task failing must not abandon the rest, and must not fail the
           role change that has already been written — that would leave the
           caller told the demotion failed when it is exactly what succeeded.
           The count returned to the admin is of what actually moved. */
        console.error("release_fraud_check_failed", { taskId: id, userId, error });
      }
    }

    if (released.length > 0) {
      await this.evaluateActivitySignals({ now: new Date() });
    }
    return released;
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
    /* Everything from here to the write reads the task as it is AT WRITE TIME
       (`current`), not the copy the guards above ran against. The two differ
       whenever a seat ticks a checklist item while somebody moves the status:
       building the new task from the stale copy would carry the stale list and
       write it back over the tick (#158). Most guards stay outside — they answer
       "may this person make this move", which a checklist write doesn't change.
       The one that isn't like that is the Submit gate, re-checked below inside
       this closure: it reads the checklist, which is exactly the contended
       field. */
    const updated = await this.writeTask(task.id, (current) => {
      /* #184's gate, re-evaluated against the list as it is at write time. The
         copy the outer `canTransitionStatus` ran against can already be stale:
         the checker may add an item in the window between that read and this
         write (both seats write the checklist at any live status since #146),
         and submitting on the stale read lands the task in PENDING_APPROVAL
         with an item nobody has answered — the gate's whole job. Throwing here
         writes nothing (see `Store.updateTask`) and rejects only this caller.
         `isSystem` bypasses, same as it does in the shared predicate. */
      if (next === "PENDING_APPROVAL" && !isSystemActor(user)) {
        const blocked = submitBlockReason(current.checklist ?? []);
        if (blocked) {
          throw new Error(blocked);
        }
      }
      const moved: LoanTask = {
        ...current,
        status: next,
        updatedAt: now,
      };
      // FRAUD outstanding-items pass counter (#44): bump on every entry into
      // AWAITING_ITEMS — the checker's first send lands it at 1, each later
      // bounce-back increments it. New checklist items stamp this pass in
      // `addedOnPass`, so the UI can flag "added this round."
      if (next === "AWAITING_ITEMS") {
        moved.checklistPass = (current.checklistPass ?? 0) + 1;
        // Anchor for the web row's "with requester" counter. Stamped on every
        // entry, so a Send Back restarts the clock from that hand-back rather
        // than accumulating across passes.
        moved.awaitingItemsSince = now;
      }
      // FRAUD gated deletion (#66): a hand-off to the other party commits every
      // existing item, so nothing said before this round-trip can be deleted
      // anymore. Freshly-added items start as drafts again and stay deletable by
      // their adder until the next hand-off. Three transitions hand the ball
      // over: entering AWAITING_ITEMS (the checker's initial send or a
      // bounce-back), entering PENDING_APPROVAL (the requester's submit), and the
      // checker's AWAITING_ITEMS → CLAIMED reopen, which takes the list back off
      // the requester. Deliberately NOT the claim (OPEN → CLAIMED): nobody has
      // looked at the requester's seeded list yet, so those seeds stay theirs.
      const handsOff =
        next === "AWAITING_ITEMS" ||
        next === "PENDING_APPROVAL" ||
        (next === "CLAIMED" && current.status === "AWAITING_ITEMS");
      if (handsOff && (current.checklist?.length ?? 0) > 0) {
        moved.checklist = commitChecklistItems(current.checklist ?? []);
      }
      if (outstandingNote) {
        // Record the outstanding-items note on the task so the thread has a seed
        // (surfaced on the DM note card below).
        moved.reviewNotes = [
          ...(current.reviewNotes ?? []),
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
        moved.urgency = "YELLOW";
        moved.dueAt = computeDueAtFromUrgency("YELLOW", new Date(now), this.appConfig);
        delete moved.lastReminderAt;
      }
      if (next === "COMPLETED") {
        moved.completedAt = now;
      }
      if (next === "CANCELLED") {
        moved.cancelledAt = now;
      }
      if (next === "ARCHIVED") {
        moved.archivedAt = now;
      }
      if (next === "OPEN") {
        delete moved.completedAt;
        delete moved.archivedAt;
        // Remember the closed status we're reopening from so "Restore" can send
        // the task back to exactly COMPLETED or ARCHIVED (never just OPEN).
        moved.reopenedFrom = current.status;
        if (current.assignee) {
          moved.status = "CLAIMED";
        } else {
          /* The second door back to the pool, and it needs the same stamp
             `unclaimTask` makes for the same reason (#207): the CHANNEL_REOPENED
             post `notifyStatusChange` fires below IS nag zero. Without this the
             clock falls back to `createdAt`, and a task reopened after sitting
             out its first 20 minutes gets a nag seconds later repeating the post
             the room has just read. Only on the branch that actually lands at
             OPEN — retaining an assignee returns to CLAIMED, which posts nothing
             and is nobody's pool problem.

             The stamp only. The spent-nag count is deliberately NOT reset here:
             claiming is what earns a task a fresh ceiling, because somebody
             actually took it. A reopen has had no such hand, and resetting on
             this door would make a task cycled through COMPLETED and back an
             unbounded nag — the exact thing the ceiling exists to close. In
             practice the count is already zero by the time anything reaches
             here, since every route through a holder clears it. */
          moved.lastPoolNagAt = now;
        }
      }
      if (next === "NEEDS_REVIEW" && reviewNotes) {
        moved.reviewNotes = [
          ...(current.reviewNotes ?? []),
          { text: reviewNotes, by: { id: user.id, displayName: user.displayName }, at: now }
        ];
      }
      // Once a task is closed again (restored, completed, cancelled, or archived)
      // it's no longer "reopened" — drop the restore breadcrumb.
      if (moved.status === "COMPLETED" || moved.status === "CANCELLED" || moved.status === "ARCHIVED") {
        delete moved.reopenedFrom;
      }

      const detail = reviewNotes
        ? `${current.status} -> ${next} | Review: ${reviewNotes}`
        : `${current.status} -> ${next}`;
      return { task: moved, event: this.makeHistory(task.id, user, "TASK_STATUS_CHANGED", detail) };
    });

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

  /* Silently bring a task's DM cards back in line with its live state. Two
     callers: the bot, when a card action is rejected (self-heal for a sync that
     was dropped — delivery is best-effort and never retried), and a FRAUD
     checklist write, whose new list can open or close the Submit gate the card's
     buttons are drawn from (#184). */
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

    if (!canAddNoteToTask(task, user)) {
      throw new Error("Only the creator or assignee can add review notes");
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

    if (!canAddNoteToTask(task, user)) {
      throw new Error("Only the creator or assignee can add a note");
    }

    return this.appendReviewNote(task, text, user);
  }

  /* ------------------------------------------------------------------------
     FRAUD structured checklist (#44). Focused, atomic operations mirroring the
     completed-note pattern: each enforces its permission rule (the seat-wide
     canEditChecklist, or the item-scoped canDeleteChecklistItem /
     canEditChecklistItemText), applies a pure checklist transform, records a
     single history event, persists, and broadcasts. Deletion is GATED (#66):
     removeChecklistItem lets the adding seat drop a fresh, not-yet-handed-off
     item; committed items are permanently locked.
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
    this.assertCanRecord(task, user);
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("A checklist item needs some text");
    }
    const addedBy = this.requireSeat(task, user);
    const addedOnPass = task.checklistPass && task.checklistPass > 0 ? task.checklistPass : 1;
    const item = { id: uuid(), text: trimmed, addedBy, addedOnPass };
    return this.persistChecklist(
      task,
      (current) => addChecklistItem(current.checklist ?? [], item),
      user,
      `Added checklist item: ${trimmed}`
    );
  }

  /* Edit an item's text. Per the checked/stale invariant, editing a checked
     item auto-clears the check and marks it stale (handled by the pure fn). */
  async editChecklistItemText(taskId: string, itemId: string, text: string, user: UserIdentity): Promise<LoanTask> {
    const task = await this.requireTask(taskId);
    if (task.taskType !== "FRAUD") {
      throw new Error("Checklists are only on fraud checks");
    }
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("A checklist item needs some text");
    }
    const item = (task.checklist ?? []).find((entry) => entry.id === itemId);
    if (!item) {
      throw new Error("Checklist item not found");
    }
    // Item-scoped, like deletion: your own not-yet-handed-off item is yours to
    // retype, and the checker may additionally re-ask a committed one.
    if (!canEditChecklistItemText(task, user, item)) {
      throw new Error("You can't change this item's text");
    }
    return this.persistChecklist(
      task,
      (current) => editChecklistItemText(current.checklist ?? [], itemId, trimmed),
      user,
      `Edited checklist item`
    );
  }

  /* Delete an outstanding-items entry (#66). Gated, not free: only the seat
     that added the item, and only while it is still a fresh draft (not yet
     handed off) — the full invariant lives in the shared
     canDeleteChecklistItem and is enforced here server-side, not just in the
     UI. Committed items and the other seat's items are rejected. There is no
     turn clause: either seat may add off-turn, so one would trap the adder
     with an item they could never remove. */
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
    return this.persistChecklist(
      task,
      (current) => removeChecklistItem(current.checklist ?? [], itemId),
      user,
      `Removed checklist item: ${item.text}`
    );
  }

  /* Toggle an item's resolved (checked) state, optionally recording a per-item
     note in the same gesture. Which note field that lands in is derived from
     the actor's seat, not chosen by the caller — both seats may tick at any
     live status, so a seat-blind version would let a checker file a note under
     the requester's name just by ticking. */
  async setChecklistItemChecked(
    taskId: string,
    itemId: string,
    checked: boolean,
    note: string | undefined,
    user: UserIdentity
  ): Promise<LoanTask> {
    const task = await this.requireTask(taskId);
    this.assertCanRecord(task, user);
    this.requireItem(task, itemId);
    const seat = this.requireSeat(task, user);
    return this.persistChecklist(
      task,
      (current) => setChecklistItemChecked(current.checklist ?? [], itemId, checked, note?.trim(), seat),
      user,
      checked ? "Resolved checklist item" : "Reopened checklist item"
    );
  }

  /* Set a per-item note. WHICH field it lands in — the requester's `note` or
     the checker's `checkerNote` — is derived here from the actor's seat, the
     same way `addedBy` already was. There used to be two methods behind two
     endpoints, so the client chose the field by choosing the URL and could file
     a note under the other seat's name. */
  async setChecklistItemNote(taskId: string, itemId: string, note: string, user: UserIdentity): Promise<LoanTask> {
    const task = await this.requireTask(taskId);
    this.assertCanRecord(task, user);
    this.requireItem(task, itemId);
    const seat = this.requireSeat(task, user);
    return this.persistChecklist(
      task,
      (current) => setChecklistItemNote(current.checklist ?? [], itemId, note.trim(), seat),
      user,
      seat === "checker" ? "Set checklist item checker note" : "Set checklist item note"
    );
  }

  /* Enforce the seat-wide permission gate — recording reality (tick, add, your
     own note) is open to both seats at any live status. Throws when the actor
     may not act. Server-authoritative; the client's affordance gating is only a
     hint. Text-editing and deletion are item-scoped and gate themselves. */
  /* The actor's seat, or a refusal. Unreachable after assertCanRecord, which
     turns "holds no seat" away first — but a default here would file somebody's
     note or item under the requester's name, which is the bug this whole seam
     exists to prevent, so it throws rather than guessing. */
  private requireSeat(task: LoanTask, user: UserIdentity): ChecklistSeat {
    const seat = checklistSeat(task, user);
    if (!seat) {
      throw new Error("Only the fraud checker or the requester can change the checklist");
    }
    return seat;
  }

  private assertCanRecord(task: LoanTask, user: UserIdentity): void {
    if (task.taskType !== "FRAUD") {
      throw new Error("Checklists are only on fraud checks");
    }
    if (!canEditChecklist(task, user)) {
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
  /* Takes the transform, not the finished list. The list is the contended
     field — both seats tick at any live status since #146 — so a list computed
     from the copy the permission check ran against would carry that copy's
     version of everyone else's ticks and write them back over the real ones
     (#158). `apply` re-runs the same pure function against the list as it is at
     write time, inside the store's queue slot, so a tick that landed while we
     were checking permissions survives.

     The guards stay outside deliberately: they answer "may this person edit
     this task", which a concurrent checklist write doesn't change. */
  private async persistChecklist(
    task: LoanTask,
    apply: (current: LoanTask) => ChecklistItem[],
    user: UserIdentity,
    detail: string
  ): Promise<LoanTask> {
    const now = new Date().toISOString();
    const event = this.makeHistory(task.id, user, "CHECKLIST_UPDATED", detail);
    const updated = await this.writeTask(task.id, (current) => ({
      task: { ...current, checklist: apply(current), updatedAt: now },
      event
    }));

    /* A checklist write moves the Submit gate (#184), and the gate decides
       whether the requester's DM card offers Submit at all — so on a FRAUD task
       the list IS card state, not just body content. Nothing else brought the
       card along: this path sends no notification, note cards carry no `refresh`
       block, and the card's only self-repair was a rejected tap. Since the card
       now renders a blocked Submit as an inert reason instead of a tap the
       server refuses, there is no rejected tap left to trigger it — the
       requester who resolves the last item in the web app would be left staring
       at a card that still says "1 item still needs a check or a note", with
       nothing to press. Background and chained per task like every other
       fan-out: the request never waits on a Teams round-trip, and a failed sync
       never fails the write that landed. */
    if (updated.taskType === "FRAUD") {
      this.background(() => this.resyncTaskCards(updated.id), { method: "persistChecklist", taskId: updated.id });
    }
    return updated;
  }

  /* Append a ReviewNote to the task and fan out the note notifications. Callers
     own the status/permission guards; this only records the note (a single
     REVIEW_NOTE_ADDED history event), broadcasts the change, and pings the
     participants. Never mutates status, completedAt, or reopenedFrom. */
  private async appendReviewNote(task: LoanTask, text: string, user: UserIdentity): Promise<LoanTask> {
    const now = new Date().toISOString();
    const note = { text, by: { id: user.id, displayName: user.displayName }, at: now };
    const event = this.makeHistory(task.id, user, "REVIEW_NOTE_ADDED", `Review note by ${user.displayName}`);
    // Appended to the notes as they are at write time, not as they were when we
    // read the task: two people answering at once would otherwise each write a
    // list containing only their own note, and the slower one would win (#158).
    const updated = await this.writeTask(task.id, (current) => ({
      task: { ...current, reviewNotes: [...(current.reviewNotes ?? []), note], updatedAt: now },
      event
    }));

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
       - Handing a task to whoever already holds it is REFUSED (#208), not
         silently accepted. Nothing to do and nothing done are the same thing;
         reporting success for it is not.
       - Nobody may hand a task to THEMSELVES (#208). Taking work off a
         colleague is the creator's call now, made with `returnToPool` below,
         not something the taker does to them directly.
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

    /* One question, one answer, one sentence: closed, ineligible, already
       theirs, and handing to yourself all come back from `handoffRefusal`, which
       is the same function the picker filters with. */
    const refusal = handoffRefusal(task, params.target, params.actor);
    if (refusal) {
      throw new Error(refusal);
    }

    const previous = task.assignee;
    const now = new Date().toISOString();
    const detail = previous
      ? `Reassigned from ${previous.displayName} to ${params.target.displayName} by ${params.actor.displayName}`
      : `Assigned to ${params.target.displayName} by ${params.actor.displayName}`;
    const event = this.makeHistory(task.id, params.actor, "TASK_ASSIGNED", detail);
    const updated = await this.writeTask(task.id, (current) => ({
      task: {
        ...this.withNewHolder(current, now),
        status: current.status === "OPEN" ? "CLAIMED" : current.status,
        assignee: { id: params.target.id, displayName: params.target.displayName },
        updatedAt: now
      },
      event
    }));

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

  /* One-time, idempotent backfill (#207), run at boot alongside ADR-0001's loan
     migration. `isPoolNagDue` falls back to `createdAt` for a task with no
     `lastPoolNagAt`, which is every task written before the nag existed — so
     without this the first maintenance pass after deploy reads the entire open
     queue as overdue for a nag and posts one card per task, all at once, to a
     channel that has done nothing to deserve it.

     Stamping "now" says the truthful thing instead: these tasks have not been
     nagged, and their clock starts here. Each then nags on the normal cadence.

     Only tasks that are ALREADY past the nag threshold. This runs on every boot,
     not just the first, so the discriminator matters: a task filed twelve
     minutes before a restart has not earned a nag yet, so there is nothing to
     suppress, and stamping it would push its first nag out by another twenty
     minutes for no reason. Restart often enough and it would never nag at all.
     A task that is unstamped AND already overdue for a nag is the shape this
     exists for — either it predates the feature, or the server was down through
     the window it should have nagged in, and in both cases starting its clock
     here is the honest answer. */
  async backfillPoolNagClock(): Promise<{ stamped: number }> {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const tasks = await this.store.allTasks();
    let stamped = 0;
    for (const task of tasks) {
      // The nag's own eligibility rule, so the two cannot come to disagree about
      // which tasks are the pool's — anything the nag would never look at needs
      // no stamp, and stamping it would leave a misleading field on a task
      // nobody is being asked to pick up.
      if (!isPoolNagEligible(task) || task.lastPoolNagAt) {
        continue;
      }
      if (nowMs - new Date(task.createdAt).getTime() < UNCLAIMED_ALERT_MS) {
        continue;
      }
      await this.store.updateTask(task.id, (current) =>
        current.lastPoolNagAt ? { task: current } : { task: { ...current, lastPoolNagAt: now } }
      );
      stamped += 1;
    }
    return { stamped };
  }

  async runMaintenance(): Promise<{ reminded: number; nagged: number; purged: number; autoArchived: number }> {
    const now = new Date();
    const tasks = await this.store.allTasks();

    let reminded = 0;
    let nagged = 0;
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
            message: `your time's up on ${next.folderName}`,
            target: "DM",
            recipientUserIds: reminderRecipients
          });
        }
      }

      /* The pool nag (ADR-0005). An unclaimed task blowing its deadline is a
         staffing problem, so the pressure goes to the room rather than to the
         creator's inbox — and it repeats, because the whole failure mode is a
         task getting missed in the shuffle. Flat 20 minutes for every urgency:
         volume is low because tasks are normally grabbed immediately, and a
         cadence that varies by urgency is a cadence nobody can predict. It stops
         at `MAX_POOL_NAGS`, which `isPoolNagDue` enforces off the count stamped
         here (#207). */
      if (isPoolNagDue(next, now, this.appConfig)) {
        const unclaimedMinutes = Math.round((now.getTime() - new Date(next.createdAt).getTime()) / 60000);
        next = { ...next, lastPoolNagAt: nowIso, poolNagCount: (next.poolNagCount ?? 0) + 1, updatedAt: nowIso };
        nagged += 1;
        await this.notify({
          type: "TASK_REMINDER",
          task: next,
          actor: { id: SYSTEM_ACTOR.id, displayName: SYSTEM_ACTOR.displayName },
          message: `${next.folderName} is still unclaimed after ${unclaimedMinutes} minutes, who's taking it?`,
          target: "CHANNEL_NAG"
        });
      }

      updatedTasks.push(next);
    }

    const toPurge = updatedTasks.filter((task) => shouldPurgeArchived(task, now, this.appConfig.archiveRetentionDays));
    const retained = updatedTasks.filter((task) => !toPurge.some((purge) => purge.id === task.id));

    if (toPurge.length > 0 || autoArchived > 0 || reminded > 0 || nagged > 0 || historyEvents.length > 0) {
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
      nagged,
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

      /* Assignee only — no fallback to the creator (ADR-0005). An unclaimed task
         is a staffing problem, not the creator's lateness, and a feed row saying
         their own request is overdue is not something they can act on. The
         count-up on their row already tells them what they can act on: that
         nobody has taken it yet. */
      if (ACTIVE_STATUSES.includes(task.status) && task.assignee && isOverdue(task, now)) {
        const overdueUserId = task.assignee.id;
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

  /* Every write that CHANGES an existing task goes through here. `apply` builds
     the replacement from `current` — the task as it is inside the store's write
     slot — rather than from a copy read earlier, so a concurrent write to a
     field this one isn't touching survives instead of being erased by a full
     replacement built from stale data (#158).

     Creation is the one write that doesn't belong here: there is no prior read
     to go stale, so `createTask` still calls `store.upsertTask` directly.

     Throws when the task is gone. Every caller has already read it and run its
     guards, so a missing task here means it was deleted mid-flight — the same
     "task not found" the guards would have raised a moment earlier. */
  private async writeTask(
    taskId: string,
    apply: (current: LoanTask) => { task: LoanTask; event?: TaskHistoryEvent }
  ): Promise<LoanTask> {
    const updated = await this.store.updateTask(taskId, apply);
    if (!updated) {
      throw new Error("Task not found");
    }
    this.events.broadcast({ type: "task.changed", payload: updated });
    return updated;
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
