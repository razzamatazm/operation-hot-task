import { promises as fs } from "node:fs";
import path from "node:path";
import { CreateTaskInput, LoanTask, TaskStatus, TaskType, UrgencyLevel, UserIdentity, botPrimaryAdvance, computeDueAtFromReturnDate, getNotesFieldLabel } from "@loan-tasks/shared";
import { ActivityHandler, BotFrameworkAdapter, CardFactory, ConversationReference, InvokeResponse, MessageFactory, TurnContext } from "botbuilder";
import { Express } from "express";
import { normalizeHumperdinkLink } from "./validation.js";

interface StoredReference {
  key: string;
  reference: Partial<ConversationReference>;
  scope: "DM" | "CHANNEL";
  userId?: string;
  userAadObjectId?: string;
  /* Friendly "Team / Channel" label from channelData, for the admin picker. */
  displayName?: string;
}

/* Where a task's root channel card landed, per channel. We thread later
   updates (claim / unclaim) as replies under `activityId` instead of
   broadcasting a fresh card to the whole channel. One task fans out to
   every channel the bot lives in, so this is an array. */
interface StoredThread {
  taskId: string;
  posts: Array<{ reference: Partial<ConversationReference>; activityId: string }>;
}

type BotTaskCreateInput = Pick<CreateTaskInput, "folderName" | "taskType" | "urgency" | "points" | "notes" | "startDate" | "returnDate" | "humperdinkLink">;
type BotTaskCreator = (input: BotTaskCreateInput, user: UserIdentity) => Promise<LoanTask>;

type QuickAddStep =
  | "FOLDER_NAME"
  | "TASK_TYPE"
  | "START_DATE"
  | "RETURN_DATE"
  | "URGENCY"
  | "POINTS"
  | "NOTES"
  | "HUMPERDINK"
  | "REVIEW"
  | "CONFIRM_CREATE";
type EditableField = "FOLDER_NAME" | "TASK_TYPE" | "START_DATE" | "RETURN_DATE" | "URGENCY" | "POINTS" | "NOTES" | "HUMPERDINK";

interface QuickAddDraft {
  step: QuickAddStep;
  history: QuickAddStep[];
  folderName?: string;
  taskType?: TaskType;
  startDate?: string;
  returnDate?: string;
  urgency?: UrgencyLevel;
  points?: number;
  notes?: string;
  humperdinkLink?: string;
  editField?: EditableField;
}

const TASK_TYPE_CHOICES: ReadonlyArray<{ label: string; value: TaskType }> = [
  { label: "LOI Check", value: "LOI" },
  { label: "Buddy Chat", value: "BUDDY_CHAT" },
  { label: "Value Check", value: "VALUE" },
  { label: "Fraud Check", value: "FRAUD" },
  { label: "Loan Docs", value: "LOAN_DOCS" },
  { label: "OOO - Out of Office", value: "OOO" }
];

const URGENCY_CHOICES: ReadonlyArray<{ label: string; value: UrgencyLevel }> = [
  { label: "Within 24 Hours", value: "GREEN" },
  { label: "End of Day", value: "YELLOW" },
  { label: "Within 1 Hour", value: "ORANGE" },
  { label: "Urgent Now", value: "RED" }
];
const REVIEW_ACTIONS = [
  "Create task",
  "Edit Folder Name",
  "Edit Task Type",
  "Edit Start Date",
  "Edit Return Date",
  "Edit Urgency",
  "Edit Poops",
  "Edit Notes",
  "Edit Humperdink Link",
  "Cancel"
] as const;
const CONFIRM_CREATE_ACTIONS = ["Confirm create", "Back to review", "Cancel"] as const;
const formatPoops = (points: number): string => "💩".repeat(Math.max(1, Math.min(5, Math.trunc(points))));

const normalizeText = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const parseTaskType = (text: string): TaskType | undefined => {
  const normalized = normalizeText(text);
  const matched = TASK_TYPE_CHOICES.find((choice) => normalizeText(choice.label) === normalized);
  if (matched) {
    return matched.value;
  }

  if (normalized === "loi") {
    return "LOI";
  }
  if (normalized === "buddy chat" || normalized === "buddy_chat") {
    return "BUDDY_CHAT";
  }
  if (normalized === "value") {
    return "VALUE";
  }
  if (normalized === "fraud") {
    return "FRAUD";
  }
  if (normalized === "loan docs" || normalized === "loan_docs") {
    return "LOAN_DOCS";
  }
  if (normalized === "ooo" || normalized === "out of office" || normalized === "ooo - out of office") {
    return "OOO";
  }
  return undefined;
};

const parseUrgency = (text: string): UrgencyLevel | undefined => {
  const normalized = normalizeText(text);
  const matched = URGENCY_CHOICES.find((choice) => normalizeText(choice.label) === normalized);
  if (matched) {
    return matched.value;
  }

  if (normalized.startsWith("green")) {
    return "GREEN";
  }
  if (normalized.startsWith("yellow")) {
    return "YELLOW";
  }
  if (normalized.startsWith("orange")) {
    return "ORANGE";
  }
  if (normalized.startsWith("red")) {
    return "RED";
  }
  if (normalized.includes("anytime")) {
    return "GREEN";
  }
  if (
    normalized.includes("within 24 hours") ||
    normalized.includes("24 hours") ||
    normalized.includes("24 hour")
  ) {
    return "GREEN";
  }
  if (normalized.includes("end of day")) {
    return "YELLOW";
  }
  if (normalized.includes("1 hour") || normalized.includes("one hour")) {
    return "ORANGE";
  }
  if (normalized.includes("urgent")) {
    return "RED";
  }
  return undefined;
};
const parsePoints = (text: string): number | undefined => {
  const value = Number.parseInt(text.trim(), 10);
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    return undefined;
  }
  return value;
};

const isNoAdditionalNotes = (text: string): boolean => normalizeText(text) === "no additional notes";
const parseStartDate = (text: string): string | undefined => {
  const trimmed = text.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return undefined;
  }
  if (Number.isNaN(new Date(`${trimmed}T00:00:00`).getTime())) {
    return undefined;
  }
  return trimmed;
};
const parseReturnDate = (text: string): string | undefined => {
  const trimmed = text.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return undefined;
  }
  let dueAt: string;
  try {
    dueAt = computeDueAtFromReturnDate(trimmed);
  } catch {
    return undefined;
  }
  if (new Date(dueAt).getTime() <= Date.now()) {
    return undefined;
  }
  return trimmed;
};
const isSkip = (text: string): boolean => {
  const normalized = normalizeText(text);
  return normalized === "skip" || normalized === "none" || normalized === "n/a";
};
const formatField = (value: string | undefined): string => (value && value.trim().length > 0 ? value : "Not provided");
const urgencyLabel = (urgency: UrgencyLevel): string => URGENCY_CHOICES.find((choice) => choice.value === urgency)?.label ?? urgency;
const taskTypeLabel = (taskType: TaskType): string => TASK_TYPE_CHOICES.find((choice) => choice.value === taskType)?.label ?? taskType;
const notesPromptLabel = (taskType?: TaskType): string => `${getNotesFieldLabel(taskType)} (type your notes, or choose No additional notes):`;
const normalizeReviewAction = (text: string): string => normalizeText(text).replace(/\s+/g, " ");
const parseReviewAction = (text: string): string | undefined => {
  const normalized = normalizeReviewAction(text);
  return REVIEW_ACTIONS.find((action) => normalizeReviewAction(action) === normalized);
};
const parseConfirmCreateAction = (text: string): string | undefined => {
  const normalized = normalizeReviewAction(text);
  return CONFIRM_CREATE_ACTIONS.find((action) => normalizeReviewAction(action) === normalized);
};
const isEditableStep = (step: QuickAddStep): step is EditableField =>
  step === "FOLDER_NAME" || step === "TASK_TYPE" || step === "START_DATE" || step === "RETURN_DATE" || step === "URGENCY" || step === "POINTS" || step === "NOTES" || step === "HUMPERDINK";

const reviewActionsForDraft = (draft: QuickAddDraft): string[] => {
  if (draft.taskType === "OOO") {
    return REVIEW_ACTIONS.filter((action) => action !== "Edit Urgency" && action !== "Edit Humperdink Link");
  }
  return REVIEW_ACTIONS.filter((action) => action !== "Edit Start Date" && action !== "Edit Return Date");
};

const toBotUserIdentity = (context: TurnContext): UserIdentity => {
  const from = context.activity.from;
  return {
    id: from?.aadObjectId ?? from?.id ?? "teams-user",
    displayName: from?.name ?? "Teams User",
    roles: ["LOAN_OFFICER"]
  };
};

class ReferenceStore {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, "[]", "utf8");
    }
  }

  async read(): Promise<StoredReference[]> {
    const raw = await fs.readFile(this.filePath, "utf8");
    return JSON.parse(raw) as StoredReference[];
  }

  async save(reference: StoredReference): Promise<void> {
    await this.enqueue(async () => {
      const entries = await this.read();
      const idx = entries.findIndex((entry) => entry.key === reference.key);
      if (idx >= 0) {
        entries[idx] = reference;
      } else {
        entries.push(reference);
      }
      await fs.writeFile(this.filePath, JSON.stringify(entries, null, 2), "utf8");
    });
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(operation, operation);
    return this.chain;
  }
}

class ThreadStore {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, "[]", "utf8");
    }
  }

  async read(): Promise<StoredThread[]> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return JSON.parse(raw) as StoredThread[];
    } catch {
      return [];
    }
  }

  async get(taskId: string): Promise<StoredThread | undefined> {
    const entries = await this.read();
    return entries.find((entry) => entry.taskId === taskId);
  }

  async save(thread: StoredThread): Promise<void> {
    await this.enqueue(async () => {
      const entries = await this.read();
      const idx = entries.findIndex((entry) => entry.taskId === thread.taskId);
      if (idx >= 0) {
        entries[idx] = thread;
      } else {
        entries.push(thread);
      }
      await fs.writeFile(this.filePath, JSON.stringify(entries, null, 2), "utf8");
    });
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(operation, operation);
    return this.chain;
  }
}

/* Result the bot returns to the injected claim handler, normalized so the
   bot doesn't need to know about TaskService error shapes. */
interface ClaimOutcome {
  ok: boolean;
  message: string;
  status?: string;
  assignee?: string;
}

interface AdvanceAction {
  status: TaskStatus;
  label: string;
}

interface NoteThreadEntry {
  author: string;
  text: string;
}

interface NoteCardData {
  taskId: string;
  folder: string;
  thread: NoteThreadEntry[];
  advance?: AdvanceAction;
}

interface ConfirmData {
  taskId: string;
  folder: string;
  message: string;
  advance?: AdvanceAction;
}

/* Result of a reply-to-note submitted from a DM card. On success carries the
   refreshed note card data so the reply box stays open for the next message. */
interface NoteReplyOutcome {
  ok: boolean;
  message: string;
  note?: NoteCardData;
}

/* Result of a transition (advance/complete) submitted from a card. */
interface TransitionOutcome {
  ok: boolean;
  message: string;
  confirm?: ConfirmData;
}

const STATUS_DISPLAY: Record<TaskStatus, string> = {
  OPEN: "open",
  CLAIMED: "claimed",
  NEEDS_REVIEW: "in review",
  MERGE_DONE: "merge done",
  MERGE_APPROVED: "merge approved",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  ARCHIVED: "archived"
};

/* Last few notes for a card thread, oldest → newest. */
const threadFromTask = (task: LoanTask): NoteThreadEntry[] =>
  (task.reviewNotes ?? []).slice(-5).map((entry) => ({ author: entry.by.displayName, text: entry.text }));

/* Build note-card data from a task (used to refresh after a reply). */
const noteCardDataFromTask = (task: LoanTask): NoteCardData => {
  const advance = botPrimaryAdvance(task);
  return { taskId: task.id, folder: task.folderName, thread: threadFromTask(task), ...(advance ? { advance } : {}) };
};

/* The contextual "move it forward" button (Mark Merge Done / Approve Merge /
   Complete). Empty when there's no forward step. */
const advanceButton = (taskId: string, advance?: AdvanceAction): Record<string, unknown>[] =>
  advance
    ? [{ type: "Action.Execute", title: advance.label, verb: "transitionTask", data: { taskId, targetStatus: advance.status } }]
    : [];

/* DM card for a review-note conversation: the recent thread (oldest → newest),
   an inline reply box that posts straight back as another note, and a contextual
   advance/complete button. The reply box persists so users can send several
   messages in a row. */
const noteCard = (data: NoteCardData): Record<string, unknown> => ({
  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
  type: "AdaptiveCard",
  version: "1.4",
  body: [
    { type: "TextBlock", text: `Conversation on ${data.folder}`, weight: "Bolder", wrap: true },
    ...data.thread.map((entry) => ({
      type: "TextBlock",
      text: `**${entry.author}:** ${entry.text}`,
      wrap: true,
      spacing: "Small"
    })),
    { type: "Input.Text", id: "replyText", placeholder: "Type a reply…", isMultiline: true }
  ],
  actions: [
    { type: "Action.Execute", title: "Reply", verb: "replyNote", data: { taskId: data.taskId, folder: data.folder } },
    ...advanceButton(data.taskId, data.advance)
  ]
});

/* Full-details DM card sent to whoever claims a task. */
const detailCard = (opts: { taskId: string; title: string; detail: string; openUrl?: string; advance?: AdvanceAction }): Record<string, unknown> => ({
  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
  type: "AdaptiveCard",
  version: "1.4",
  body: [
    { type: "TextBlock", text: opts.title, weight: "Bolder", wrap: true, size: "Medium" },
    { type: "TextBlock", text: opts.detail, wrap: true, spacing: "Small" }
  ],
  actions: [
    ...advanceButton(opts.taskId, opts.advance),
    ...(opts.openUrl ? [{ type: "Action.OpenUrl", title: "Open in Hot Task", url: opts.openUrl }] : [])
  ]
});

/* Card a card is refreshed to after a successful transition — confirms the move
   and offers the next forward step if there is one. */
const transitionConfirmCard = (data: ConfirmData): Record<string, unknown> => ({
  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
  type: "AdaptiveCard",
  version: "1.4",
  body: [{ type: "TextBlock", text: data.message, weight: "Bolder", wrap: true }],
  actions: advanceButton(data.taskId, data.advance)
});

/* Adaptive Card shown on a freshly created task: headline + detail + a
   single one-tap Claim button (universal Action.Execute, handled by
   onInvokeActivity). */
const adaptiveTaskCard = (opts: { title: string; detail: string; taskId: string; openUrl?: string }): Record<string, unknown> => ({
  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
  type: "AdaptiveCard",
  version: "1.4",
  body: [
    { type: "TextBlock", text: opts.title, weight: "Bolder", wrap: true, size: "Medium" },
    { type: "TextBlock", text: opts.detail, wrap: true, spacing: "Small", isSubtle: true }
  ],
  actions: [
    { type: "Action.Execute", title: "Claim", verb: "claimTask", data: { taskId: opts.taskId } },
    ...(opts.openUrl ? [{ type: "Action.OpenUrl", title: "Open in Hot Task", url: opts.openUrl }] : [])
  ]
});

/* Card the original message is refreshed to after a successful claim — the
   Claim button is gone so the task can't be double-claimed from the card. */
const claimedCard = (outcome: ClaimOutcome): Record<string, unknown> => ({
  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
  type: "AdaptiveCard",
  version: "1.4",
  body: [
    { type: "TextBlock", text: outcome.message, weight: "Bolder", wrap: true, size: "Medium" },
    ...(outcome.assignee
      ? [{ type: "TextBlock", text: `Claimed by ${outcome.assignee}`, wrap: true, spacing: "Small", isSubtle: true }]
      : [])
  ]
});

/* Replace the tapped card with a refreshed Adaptive Card. */
const cardRefreshResponse = (card: Record<string, unknown>): InvokeResponse => ({
  status: 200,
  body: {
    statusCode: 200,
    type: "application/vnd.microsoft.card.adaptive",
    value: card
  }
});

/* Leave the card as-is and surface a short toast to the tapper (e.g. when
   the task was already claimed). */
const cardMessageResponse = (text: string): InvokeResponse => ({
  status: 200,
  body: {
    statusCode: 200,
    type: "application/vnd.microsoft.activity.message",
    value: text
  }
});

/* Point a captured channel reference at a specific root message so a reply
   lands inside that task's thread rather than starting a new one. Teams
   threads on `conversation.id` suffixed with `;messageid=<rootId>`. */
/* Friendly "Team / Channel" label from a channel activity's channelData, for
   the admin picker. Teams often omits channel.name for the default General
   channel, so fall back to just the team name. Returns undefined for DMs or
   when no names are present (caller then falls back to conversation id). */
const channelDisplayName = (activity: { channelData?: unknown }): string | undefined => {
  const data = activity.channelData as { team?: { name?: string }; channel?: { name?: string } } | undefined;
  const parts = [data?.team?.name, data?.channel?.name].filter((p): p is string => Boolean(p && p.trim()));
  return parts.length > 0 ? parts.join(" / ") : undefined;
};

const threadReference = (
  reference: Partial<ConversationReference>,
  rootMessageId: string
): Partial<ConversationReference> => {
  const conversation = reference.conversation;
  if (!conversation?.id) {
    return reference;
  }
  const baseId = conversation.id.split(";")[0];
  return {
    ...reference,
    conversation: { ...conversation, id: `${baseId};messageid=${rootMessageId}` }
  };
};

class LoanTasksBot extends ActivityHandler {
  private readonly drafts = new Map<string, QuickAddDraft>();

  constructor(
    private readonly onReference: (reference: Partial<ConversationReference>, scope: "DM" | "CHANNEL", displayName?: string) => Promise<void>,
    private readonly onQuickAddTask: (input: BotTaskCreateInput, user: UserIdentity) => Promise<LoanTask>,
    /* Resolve a tapped Claim button (`from.aadObjectId` + `taskId`) into a
       claim. Returns a normalized outcome the bot renders back into the card. */
    private readonly onClaim: (taskId: string, aadObjectId: string | undefined, displayName: string) => Promise<ClaimOutcome>,
    /* Resolve a reply submitted from a note DM card into a new review note. */
    private readonly onNoteReply: (taskId: string, text: string, aadObjectId: string | undefined) => Promise<NoteReplyOutcome>,
    /* Resolve an advance/complete button into a status transition. */
    private readonly onTransition: (taskId: string, targetStatus: string, aadObjectId: string | undefined) => Promise<TransitionOutcome>
  ) {
    super();

    this.onConversationUpdate(async (context, next) => {
      await this.capture(context);
      await next();
    });

    this.onMessage(async (context, next) => {
      await this.capture(context);
      await this.handleMessage(context);
      await next();
    });
  }

  /* Universal Action.Execute handler for the Claim button on task cards.
     ActivityHandler delivers card actions here as `adaptiveCard/action`
     invokes; everything else falls through to the base implementation. */
  protected async onInvokeActivity(context: TurnContext): Promise<InvokeResponse> {
    await this.capture(context);
    if (context.activity.name !== "adaptiveCard/action") {
      return super.onInvokeActivity(context);
    }

    const value = (context.activity.value ?? {}) as { action?: { verb?: string; data?: Record<string, unknown> } };
    const verb = value.action?.verb;
    const data = value.action?.data ?? {};
    const taskId = typeof data.taskId === "string" ? data.taskId : undefined;
    const from = context.activity.from;

    if (verb === "claimTask") {
      if (!taskId) {
        return cardMessageResponse("Sorry, I couldn't tell which task that was.");
      }
      const outcome = await this.onClaim(taskId, from?.aadObjectId, from?.name ?? "Someone");
      if (!outcome.ok) {
        return cardMessageResponse(outcome.message);
      }
      return cardRefreshResponse(claimedCard(outcome));
    }

    if (verb === "replyNote") {
      const replyText = typeof data.replyText === "string" ? data.replyText.trim() : "";
      if (!taskId) {
        return cardMessageResponse("Sorry, I couldn't tell which task that was.");
      }
      if (!replyText) {
        return cardMessageResponse("Type a reply first, then tap Reply.");
      }
      const outcome = await this.onNoteReply(taskId, replyText, from?.aadObjectId);
      if (!outcome.ok || !outcome.note) {
        return cardMessageResponse(outcome.message);
      }
      // Refresh to a live note card (updated thread + reply box) so the user can
      // keep sending messages without waiting for a response.
      return cardRefreshResponse(noteCard(outcome.note));
    }

    if (verb === "transitionTask") {
      const targetStatus = typeof data.targetStatus === "string" ? data.targetStatus : undefined;
      if (!taskId || !targetStatus) {
        return cardMessageResponse("Sorry, I couldn't tell which task that was.");
      }
      const outcome = await this.onTransition(taskId, targetStatus, from?.aadObjectId);
      if (!outcome.ok || !outcome.confirm) {
        return cardMessageResponse(outcome.message);
      }
      return cardRefreshResponse(transitionConfirmCard(outcome.confirm));
    }

    return cardMessageResponse("Sorry, I didn't recognise that action.");
  }

  private async handleMessage(context: TurnContext): Promise<void> {
    const cleanText = TurnContext.removeRecipientMention(context.activity) ?? context.activity.text ?? "";
    const text = cleanText.trim();
    const command = normalizeText(text);
    const key = this.quickAddKey(context);

    if (command === "help" || command === "/bot help" || command === "bot help") {
      await this.sendHelp(context);
      return;
    }

    if (command === "cancel" || command === "/bot cancel" || command === "bot cancel") {
      this.drafts.delete(key);
      await context.sendActivity("Quick add cancelled.");
      return;
    }

    if (command === "new" || command === "/bot new" || command === "bot new") {
      this.drafts.set(key, { step: "FOLDER_NAME", history: [] });
      await context.sendActivity("New task started. Enter task description:");
      return;
    }

    const draft = this.drafts.get(key);

    if (command === "back" || command === "/bot back" || command === "bot back") {
      if (!draft) {
        await context.sendActivity("No active quick add. Send `/bot new` to start.");
        return;
      }
      await this.goBack(context, key, draft);
      return;
    }

    if (!draft) {
      await context.sendActivity("Loan Tasks bot is connected. Send `/bot new` to add a task, or `help`.");
      return;
    }

    if (draft.step === "FOLDER_NAME") {
      const folderName = text.trim();
      if (!folderName) {
        await context.sendActivity("Description cannot be blank. Enter task description:");
        return;
      }

      const nextDraft = this.updateDraft(draft, { folderName, step: "TASK_TYPE" });
      this.drafts.set(key, nextDraft);
      if (nextDraft.step === "REVIEW") {
        await this.sendReview(context, nextDraft);
        return;
      }
      await context.sendActivity(
        MessageFactory.suggestedActions(
          TASK_TYPE_CHOICES.map((choice) => choice.label),
          "Choose task type:"
        )
      );
      return;
    }

    if (draft.step === "TASK_TYPE") {
      const parsed = parseTaskType(text);
      if (!parsed) {
        await context.sendActivity(
          MessageFactory.suggestedActions(
            TASK_TYPE_CHOICES.map((choice) => choice.label),
            "Pick one of the task types:"
          )
        );
        return;
      }

      const nextDraft = this.updateDraft(draft, { taskType: parsed, step: parsed === "OOO" ? "START_DATE" : "URGENCY" });
      if (parsed === "OOO") {
        delete nextDraft.urgency;
        delete nextDraft.humperdinkLink;
      } else {
        delete nextDraft.startDate;
        delete nextDraft.returnDate;
      }
      this.drafts.set(key, nextDraft);
      if (nextDraft.step === "REVIEW") {
        await this.sendReview(context, nextDraft);
        return;
      }
      if (nextDraft.step === "START_DATE") {
        await context.sendActivity("Enter start date (first day out) in YYYY-MM-DD (PT):");
        return;
      }
      await context.sendActivity(
        MessageFactory.suggestedActions(
          URGENCY_CHOICES.map((choice) => choice.label),
          "Choose urgency:"
        )
      );
      return;
    }

    if (draft.step === "START_DATE") {
      const parsed = parseStartDate(text);
      if (!parsed) {
        await context.sendActivity("Enter a start date in YYYY-MM-DD (PT):");
        return;
      }

      const nextDraft = this.updateDraft(draft, { startDate: parsed, step: "RETURN_DATE" });
      this.drafts.set(key, nextDraft);
      if (nextDraft.step === "REVIEW") {
        await this.sendReview(context, nextDraft);
        return;
      }
      await context.sendActivity("Enter return date in YYYY-MM-DD (PT):");
      return;
    }

    if (draft.step === "RETURN_DATE") {
      const parsed = parseReturnDate(text);
      if (!parsed) {
        await context.sendActivity("Enter a future return date in YYYY-MM-DD (PT):");
        return;
      }
      if (draft.startDate && parsed < draft.startDate) {
        await context.sendActivity("Return date must be on or after the start date. Enter return date in YYYY-MM-DD (PT):");
        return;
      }

      const nextDraft = this.updateDraft(draft, { returnDate: parsed, step: "POINTS" });
      this.drafts.set(key, nextDraft);
      if (nextDraft.step === "REVIEW") {
        await this.sendReview(context, nextDraft);
        return;
      }
      await context.sendActivity(MessageFactory.suggestedActions(["1", "2", "3", "4", "5"], "Choose Poops (1-5):"));
      return;
    }

    if (draft.step === "POINTS") {
      const parsed = parsePoints(text);
      if (!parsed) {
        await context.sendActivity(MessageFactory.suggestedActions(["1", "2", "3", "4", "5"], "Pick a poop value from 1 to 5:"));
        return;
      }

      const nextDraft = this.updateDraft(draft, { points: parsed, step: "NOTES" });
      this.drafts.set(key, nextDraft);
      if (nextDraft.step === "REVIEW") {
        await this.sendReview(context, nextDraft);
        return;
      }
      await context.sendActivity(
        MessageFactory.suggestedActions(["No additional notes"], notesPromptLabel(nextDraft.taskType))
      );
      return;
    }

    if (draft.step === "URGENCY") {
      const parsed = parseUrgency(text);
      if (!parsed) {
        await context.sendActivity(
          MessageFactory.suggestedActions(
            URGENCY_CHOICES.map((choice) => choice.label),
            "Pick one urgency level:"
          )
        );
        return;
      }

      const nextDraft = this.updateDraft(draft, { urgency: parsed, step: "POINTS" });
      this.drafts.set(key, nextDraft);
      if (nextDraft.step === "REVIEW") {
        await this.sendReview(context, nextDraft);
        return;
      }
      await context.sendActivity(MessageFactory.suggestedActions(["1", "2", "3", "4", "5"], "Choose Poops (1-5):"));
      return;
    }

    if (draft.step === "NOTES") {
      const noteText = text.trim();
      const notes = noteText.length > 0 && !isNoAdditionalNotes(noteText) ? noteText : "No additional notes";
      const nextStep: QuickAddStep = draft.taskType === "OOO" ? "REVIEW" : "HUMPERDINK";
      const nextDraft = this.updateDraft(draft, { notes, step: nextStep });
      this.drafts.set(key, nextDraft);
      if (nextDraft.step === "REVIEW") {
        await this.sendReview(context, nextDraft);
        return;
      }
      await context.sendActivity(MessageFactory.suggestedActions(["Skip"], "Humperdink Link (paste URL or choose Skip):"));
      return;
    }

    if (draft.step === "HUMPERDINK") {
      const trimmed = text.trim();
      const skipOrEmpty = isSkip(trimmed) || trimmed.length === 0;
      const normalized = skipOrEmpty ? "" : normalizeHumperdinkLink(trimmed);
      if (!skipOrEmpty && (normalized === null || normalized === "")) {
        await context.sendActivity(MessageFactory.suggestedActions(["Skip"], "Please enter a valid URL (http/https), or choose Skip:"));
        return;
      }

      const humperdinkLink = skipOrEmpty ? undefined : (normalized as string);
      const nextDraft = this.updateDraft(draft, { step: "REVIEW" });
      if (humperdinkLink) {
        nextDraft.humperdinkLink = humperdinkLink;
      } else {
        delete nextDraft.humperdinkLink;
      }
      this.drafts.set(key, nextDraft);
      await this.sendReview(context, nextDraft);
      return;
    }

    if (draft.step === "REVIEW") {
      const action = parseReviewAction(text);
      if (!action) {
        await this.sendReview(context, draft);
        return;
      }

      if (action === "Cancel") {
        this.drafts.delete(key);
        await context.sendActivity("Quick add cancelled.");
        return;
      }

      if (action === "Create task") {
        const nextDraft = this.updateDraft(draft, { step: "CONFIRM_CREATE" });
        this.drafts.set(key, nextDraft);
        await this.sendCreateConfirmation(context, nextDraft);
        return;
      }

      if (action === "Edit Folder Name") {
        this.drafts.set(key, this.updateDraft(draft, { step: "FOLDER_NAME", editField: "FOLDER_NAME" }));
        await context.sendActivity(draft.taskType === "OOO" ? "Enter OOO description:" : "Enter task description:");
        return;
      }

      if (action === "Edit Task Type") {
        this.drafts.set(key, this.updateDraft(draft, { step: "TASK_TYPE", editField: "TASK_TYPE" }));
        await context.sendActivity(MessageFactory.suggestedActions(TASK_TYPE_CHOICES.map((choice) => choice.label), "Choose task type:"));
        return;
      }

      if (action === "Edit Urgency") {
        if (draft.taskType === "OOO") {
          await this.sendReview(context, draft);
          return;
        }
        this.drafts.set(key, this.updateDraft(draft, { step: "URGENCY", editField: "URGENCY" }));
        await context.sendActivity(MessageFactory.suggestedActions(URGENCY_CHOICES.map((choice) => choice.label), "Choose urgency:"));
        return;
      }

      if (action === "Edit Poops") {
        this.drafts.set(key, this.updateDraft(draft, { step: "POINTS", editField: "POINTS" }));
        await context.sendActivity(MessageFactory.suggestedActions(["1", "2", "3", "4", "5"], "Choose Poops (1-5):"));
        return;
      }

      if (action === "Edit Start Date") {
        if (draft.taskType !== "OOO") {
          await this.sendReview(context, draft);
          return;
        }
        this.drafts.set(key, this.updateDraft(draft, { step: "START_DATE", editField: "START_DATE" }));
        await context.sendActivity("Enter start date (first day out) in YYYY-MM-DD (PT):");
        return;
      }

      if (action === "Edit Return Date") {
        if (draft.taskType !== "OOO") {
          await this.sendReview(context, draft);
          return;
        }
        this.drafts.set(key, this.updateDraft(draft, { step: "RETURN_DATE", editField: "RETURN_DATE" }));
        await context.sendActivity("Enter return date in YYYY-MM-DD (PT):");
        return;
      }

      if (action === "Edit Notes") {
        this.drafts.set(key, this.updateDraft(draft, { step: "NOTES", editField: "NOTES" }));
        await context.sendActivity(MessageFactory.suggestedActions(["No additional notes"], notesPromptLabel(draft.taskType)));
        return;
      }

      if (action === "Edit Humperdink Link") {
        if (draft.taskType === "OOO") {
          await this.sendReview(context, draft);
          return;
        }
        this.drafts.set(key, this.updateDraft(draft, { step: "HUMPERDINK", editField: "HUMPERDINK" }));
        await context.sendActivity(MessageFactory.suggestedActions(["Skip"], "Humperdink Link (paste URL or choose Skip):"));
        return;
      }

      return;
    }

    if (draft.step === "CONFIRM_CREATE") {
      const action = parseConfirmCreateAction(text);
      if (!action) {
        await this.sendCreateConfirmation(context, draft);
        return;
      }

      if (action === "Cancel") {
        this.drafts.delete(key);
        await context.sendActivity("Quick add cancelled.");
        return;
      }

      if (action === "Back to review") {
        const nextDraft = this.updateDraft(draft, { step: "REVIEW" });
        this.drafts.set(key, nextDraft);
        await this.sendReview(context, nextDraft);
        return;
      }

      await this.completeQuickAdd(context, key);
      return;
    }
  }

  private updateDraft(draft: QuickAddDraft, updates: Partial<QuickAddDraft>, options?: { pushHistory?: boolean }): QuickAddDraft {
    const next = { ...draft, ...updates };
    const pushHistory = options?.pushHistory ?? true;
    const previousStep = draft.step;

    if (!isEditableStep(next.step)) {
      delete next.editField;
    } else if (next.editField) {
      const editing = next.editField;
      if (next.step !== editing) {
        next.step = "REVIEW";
        delete next.editField;
      }
    }

    if (pushHistory && next.step !== previousStep) {
      next.history = [...draft.history, previousStep];
    } else if (!next.history) {
      next.history = [...draft.history];
    }

    return next;
  }

  private async goBack(context: TurnContext, key: string, draft: QuickAddDraft): Promise<void> {
    const previousStep = draft.history.at(-1);
    if (!previousStep) {
      await context.sendActivity("You are already at the first step. Enter task description:");
      return;
    }

    const nextHistory = draft.history.slice(0, -1);
    const nextDraft = this.updateDraft(
      draft,
      {
        step: previousStep,
        history: nextHistory
      },
      { pushHistory: false }
    );
    delete nextDraft.editField;
    this.drafts.set(key, nextDraft);
    await this.promptForStep(context, nextDraft);
  }

  private async promptForStep(context: TurnContext, draft: QuickAddDraft): Promise<void> {
    if (draft.step === "FOLDER_NAME") {
      await context.sendActivity(draft.taskType === "OOO" ? "Enter OOO description:" : "Enter task description:");
      return;
    }
    if (draft.step === "TASK_TYPE") {
      await context.sendActivity(MessageFactory.suggestedActions(TASK_TYPE_CHOICES.map((choice) => choice.label), "Choose task type:"));
      return;
    }
    if (draft.step === "URGENCY") {
      await context.sendActivity(MessageFactory.suggestedActions(URGENCY_CHOICES.map((choice) => choice.label), "Choose urgency:"));
      return;
    }
    if (draft.step === "POINTS") {
      await context.sendActivity(MessageFactory.suggestedActions(["1", "2", "3", "4", "5"], "Choose Poops (1-5):"));
      return;
    }
    if (draft.step === "START_DATE") {
      await context.sendActivity("Enter start date (first day out) in YYYY-MM-DD (PT):");
      return;
    }
    if (draft.step === "RETURN_DATE") {
      await context.sendActivity("Enter return date in YYYY-MM-DD (PT):");
      return;
    }
    if (draft.step === "NOTES") {
      await context.sendActivity(MessageFactory.suggestedActions(["No additional notes"], notesPromptLabel(draft.taskType)));
      return;
    }
    if (draft.step === "HUMPERDINK") {
      await context.sendActivity(MessageFactory.suggestedActions(["Skip"], "Humperdink Link (paste URL or choose Skip):"));
      return;
    }
    if (draft.step === "REVIEW") {
      await this.sendReview(context, draft);
      return;
    }
    await this.sendCreateConfirmation(context, draft);
  }

  private async sendReview(context: TurnContext, draft: QuickAddDraft): Promise<void> {
    const lines = [
      `${draft.taskType === "OOO" ? "Vacation Description" : "Folder Name"}: ${formatField(draft.folderName)}`,
      `Task Type: ${draft.taskType ? taskTypeLabel(draft.taskType) : "Not provided"}`,
      ...(draft.taskType === "OOO"
        ? [`Start Date: ${formatField(draft.startDate)}`, `Return Date: ${formatField(draft.returnDate)}`]
        : [`Urgency: ${draft.urgency ? urgencyLabel(draft.urgency) : "Not provided"}`]),
      `Poops: ${formatPoops(draft.points ?? 1)} (${draft.points ?? 1})`,
      `${getNotesFieldLabel(draft.taskType)}: ${formatField(draft.notes)}`,
      ...(draft.taskType === "OOO" ? [] : [`Humperdink Link: ${formatField(draft.humperdinkLink)}`])
    ];
    await context.sendActivity(
      MessageFactory.suggestedActions(
        reviewActionsForDraft(draft),
        `Review task details:\n${lines.join("\n")}\nChoose an action:`
      )
    );
  }

  private async sendCreateConfirmation(context: TurnContext, draft: QuickAddDraft): Promise<void> {
    const lines = [
      `${draft.taskType === "OOO" ? "Vacation Description" : "Folder Name"}: ${formatField(draft.folderName)}`,
      `Task Type: ${draft.taskType ? taskTypeLabel(draft.taskType) : "Not provided"}`,
      ...(draft.taskType === "OOO"
        ? [`Start Date: ${formatField(draft.startDate)}`, `Return Date: ${formatField(draft.returnDate)}`]
        : [`Urgency: ${draft.urgency ? urgencyLabel(draft.urgency) : "Not provided"}`]),
      `Poops: ${formatPoops(draft.points ?? 1)} (${draft.points ?? 1})`
    ];
    await context.sendActivity(
      MessageFactory.suggestedActions(
        [...CONFIRM_CREATE_ACTIONS],
        `Confirm task creation:\n${lines.join("\n")}\nType "Back" to revisit earlier steps, or choose an action:`
      )
    );
  }

  private async completeQuickAdd(context: TurnContext, key: string): Promise<void> {
    const draft = this.drafts.get(key);
    if (!draft?.folderName || !draft.taskType || !draft.notes) {
      this.drafts.delete(key);
      await context.sendActivity("Quick add state was incomplete. Please run `/bot new` again.");
      return;
    }
    if (draft.taskType === "OOO" && (!draft.startDate || !draft.returnDate)) {
      this.drafts.delete(key);
      await context.sendActivity("Quick add state was incomplete. Please run `/bot new` again.");
      return;
    }
    if (draft.taskType !== "OOO" && !draft.urgency) {
      this.drafts.delete(key);
      await context.sendActivity("Quick add state was incomplete. Please run `/bot new` again.");
      return;
    }

    const user = toBotUserIdentity(context);
    const payload: BotTaskCreateInput = {
      folderName: draft.folderName,
      taskType: draft.taskType,
      points: draft.points ?? 1,
      notes: draft.notes,
      ...(draft.taskType === "OOO" && draft.startDate ? { startDate: draft.startDate } : {}),
      ...(draft.taskType === "OOO" && draft.returnDate ? { returnDate: draft.returnDate } : {}),
      ...(draft.taskType !== "OOO" && draft.urgency ? { urgency: draft.urgency } : {}),
      ...(draft.taskType !== "OOO" && draft.humperdinkLink ? { humperdinkLink: draft.humperdinkLink } : {})
    };

    try {
      const task = await this.onQuickAddTask(payload, user);
      this.drafts.delete(key);
      await context.sendActivity(
        `Task created: ${task.folderName}\nType: ${taskTypeLabel(task.taskType)}\n${
          task.taskType === "OOO" ? `Out: ${draft.startDate} → ${draft.returnDate}` : `Urgency: ${urgencyLabel(task.urgency)}`
        }\nPoops: ${formatPoops(task.points)} (${task.points})\nStatus: ${task.status}`
      );
    } catch (error) {
      this.drafts.delete(key);
      await context.sendActivity(`Could not create task: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  private async sendHelp(context: TurnContext): Promise<void> {
    await context.sendActivity(
      "Commands:\n- `/bot new` start quick add\n- `/bot back` go to previous step\n- `/bot cancel` cancel current quick add\n- `help` show this message"
    );
  }

  private quickAddKey(context: TurnContext): string {
    const user = context.activity.from?.aadObjectId ?? context.activity.from?.id ?? "teams-user";
    const conversation = context.activity.conversation?.id ?? "conversation";
    return `${user}:${conversation}`;
  }

  private async capture(context: TurnContext): Promise<void> {
    const reference = TurnContext.getConversationReference(context.activity);
    const conversationType = context.activity.conversation?.conversationType;
    const scope = conversationType === "channel" ? "CHANNEL" : "DM";
    await this.onReference(reference, scope, channelDisplayName(context.activity));
  }
}

export class TeamsBotClient {
  private readonly adapter?: BotFrameworkAdapter;
  private readonly bot?: LoanTasksBot;
  private readonly store: ReferenceStore;
  private readonly threads: ThreadStore;
  private taskCreator?: BotTaskCreator;
  private taskClaimer?: (taskId: string, user: UserIdentity) => Promise<LoanTask>;
  private userResolver?: (aadObjectId: string) => Promise<UserIdentity | undefined>;
  private noteAdder?: (taskId: string, text: string, user: UserIdentity) => Promise<LoanTask>;
  private taskTransitioner?: (taskId: string, status: TaskStatus, user: UserIdentity) => Promise<LoanTask>;
  private notificationChannelResolver?: () => Promise<string | undefined>;

  constructor(
    private readonly appId: string | undefined,
    private readonly appPassword: string | undefined,
    private readonly appTenantId: string | undefined,
    dataFile: string,
    /* Invoked when a user DMs the bot, so the users table can record their
       Teams `userId` (the `29:…` id) against their AAD oid — useful for the
       admin bot-status strip + auditing. No-ops for users not in the table. */
    private readonly onDmUser?: (aadObjectId: string, teamsUserId: string) => Promise<void>
  ) {
    this.store = new ReferenceStore(dataFile);
    this.threads = new ThreadStore(path.join(path.dirname(dataFile), "bot-task-threads.json"));

    if (appId && appPassword) {
      this.adapter = new BotFrameworkAdapter({
        appId,
        appPassword,
        ...(this.appTenantId ? { channelAuthTenant: this.appTenantId } : {})
      });
      this.bot = new LoanTasksBot(
        async (reference, scope, displayName) => {
          const dmUserId = scope === "DM" ? reference.user?.id : undefined;
          const dmAadObjectId = scope === "DM" ? (reference.user as { aadObjectId?: string } | undefined)?.aadObjectId : undefined;
          const key = scope === "CHANNEL" ? `channel:${reference.conversation?.id ?? "unknown"}` : `dm:${dmAadObjectId ?? dmUserId ?? "unknown"}`;
          await this.store.save({ key, reference, scope, ...(dmUserId ? { userId: dmUserId } : {}), ...(dmAadObjectId ? { userAadObjectId: dmAadObjectId } : {}), ...(displayName ? { displayName } : {}) });
          if (scope === "DM" && dmAadObjectId && dmUserId && this.onDmUser) {
            await this.onDmUser(dmAadObjectId, dmUserId);
          }
        },
        async (input, user) => {
          if (!this.taskCreator) {
            throw new Error("Quick add is not configured on server");
          }
          return this.taskCreator(input, user);
        },
        async (taskId, aadObjectId, displayName) => this.handleClaim(taskId, aadObjectId, displayName),
        async (taskId, text, aadObjectId) => this.handleNoteReply(taskId, text, aadObjectId),
        async (taskId, targetStatus, aadObjectId) => this.handleTransition(taskId, targetStatus, aadObjectId)
      );
    }
  }

  setTaskCreator(taskCreator: BotTaskCreator): void {
    this.taskCreator = taskCreator;
  }

  /* Wire the one-tap Claim button to the task service. `resolveUser` maps a
     Teams `aadObjectId` to a permission-bearing identity; `claim` performs
     the claim (and fires its own thread/DM notifications). */
  setClaimHandler(
    resolveUser: (aadObjectId: string) => Promise<UserIdentity | undefined>,
    claim: (taskId: string, user: UserIdentity) => Promise<LoanTask>
  ): void {
    this.userResolver = resolveUser;
    this.taskClaimer = claim;
  }

  /* Wire the inline reply box on note DM cards. `addNote` posts the reply back
     as a review note (which fires its own notification to the counterpart). */
  setNoteReplyHandler(
    resolveUser: (aadObjectId: string) => Promise<UserIdentity | undefined>,
    addNote: (taskId: string, text: string, user: UserIdentity) => Promise<LoanTask>
  ): void {
    this.userResolver = resolveUser;
    this.noteAdder = addNote;
  }

  /* Wire the advance/complete buttons on cards to the task service. */
  setTransitionHandler(
    resolveUser: (aadObjectId: string) => Promise<UserIdentity | undefined>,
    transition: (taskId: string, status: TaskStatus, user: UserIdentity) => Promise<LoanTask>
  ): void {
    this.userResolver = resolveUser;
    this.taskTransitioner = transition;
  }

  private async handleNoteReply(taskId: string, text: string, aadObjectId: string | undefined): Promise<NoteReplyOutcome> {
    if (!this.noteAdder || !this.userResolver) {
      return { ok: false, message: "Replies aren't wired up on the server yet." };
    }
    if (!aadObjectId) {
      return { ok: false, message: "Couldn't identify you in Teams — reply from the web app instead." };
    }
    const user = await this.userResolver(aadObjectId);
    if (!user) {
      return { ok: false, message: "You're not set up in Hot Task yet — ask an admin." };
    }
    try {
      const task = await this.noteAdder(taskId, text, user);
      return { ok: true, message: "Reply posted.", note: noteCardDataFromTask(task) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Couldn't post that reply." };
    }
  }

  private async handleTransition(taskId: string, targetStatus: string, aadObjectId: string | undefined): Promise<TransitionOutcome> {
    if (!this.taskTransitioner || !this.userResolver) {
      return { ok: false, message: "Actions aren't wired up on the server yet." };
    }
    if (!aadObjectId) {
      return { ok: false, message: "Couldn't identify you in Teams — use the web app instead." };
    }
    const user = await this.userResolver(aadObjectId);
    if (!user) {
      return { ok: false, message: "You're not set up in Hot Task yet — ask an admin." };
    }
    try {
      const task = await this.taskTransitioner(taskId, targetStatus as TaskStatus, user);
      const advance = botPrimaryAdvance(task);
      return {
        ok: true,
        message: "Done.",
        confirm: {
          taskId: task.id,
          folder: task.folderName,
          message: `${task.folderName} is now ${STATUS_DISPLAY[task.status] ?? task.status}.`,
          ...(advance ? { advance } : {})
        }
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Couldn't update that task." };
    }
  }

  /* DM references for a set of user ids (AAD oid / Teams id / dm:<id> key). */
  private async dmReferencesFor(userIds: string[]): Promise<StoredReference[]> {
    const unique = Array.from(new Set(userIds.map((id) => id.trim()).filter((id) => id.length > 0)));
    if (unique.length === 0) {
      return [];
    }
    return (await this.store.read()).filter((entry) => {
      if (entry.scope !== "DM") {
        return false;
      }
      return unique.some((userId) => entry.userAadObjectId === userId || entry.userId === userId || entry.key === `dm:${userId}`);
    });
  }

  private async sendCardToReferences(references: StoredReference[], card: ReturnType<typeof CardFactory.adaptiveCard>): Promise<void> {
    await Promise.all(
      references.map((entry) =>
        this.adapter!.continueConversationAsync(this.appId!, entry.reference, async (context) => {
          await context.sendActivity({ attachments: [card] });
        })
      )
    );
  }

  /* DM an interactive note card to specific users — the recent thread plus an
     inline reply box and advance button. Mirrors sendToDmUsers with a card. */
  async sendNoteCardToUsers(userIds: string[], note: NoteCardData): Promise<void> {
    if (!this.adapter || userIds.length === 0) {
      return;
    }
    await this.sendCardToReferences(await this.dmReferencesFor(userIds), CardFactory.adaptiveCard(noteCard(note)));
  }

  /* DM a full-details card (e.g. to whoever just claimed a task). */
  async sendDetailCardToUsers(
    userIds: string[],
    detail: { taskId: string; title: string; detail: string; openUrl?: string; advance?: AdvanceAction }
  ): Promise<void> {
    if (!this.adapter || userIds.length === 0) {
      return;
    }
    await this.sendCardToReferences(await this.dmReferencesFor(userIds), CardFactory.adaptiveCard(detailCard(detail)));
  }

  private async handleClaim(taskId: string, aadObjectId: string | undefined, _displayName: string): Promise<ClaimOutcome> {
    if (!this.taskClaimer || !this.userResolver) {
      return { ok: false, message: "Claiming isn't wired up on the server yet." };
    }
    if (!aadObjectId) {
      return { ok: false, message: "Couldn't identify you in Teams — try claiming from the web app." };
    }
    const user = await this.userResolver(aadObjectId);
    if (!user) {
      return { ok: false, message: "You're not set up as a file checker yet — ask an admin." };
    }
    try {
      const task = await this.taskClaimer(taskId, user);
      const outcome: ClaimOutcome = {
        ok: true,
        message: `${user.displayName} grabbed ${task.folderName}`,
        status: task.status,
        assignee: user.displayName
      };
      // The invoke response only refreshes the card for the tapper's client.
      // Update every recorded root message so the Claim button disappears for
      // the whole channel (and across channels the task fanned out to).
      await this.updateTaskCard(taskId, claimedCard(outcome));
      return outcome;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "";
      // canClaimTask fails for two reasons (already claimed, or fraud needs a
      // file checker); both surface as this one error. Show a single friendly
      // toast, and pass through anything unexpected so real bugs aren't masked.
      if (reason === "Task cannot be claimed by this user") {
        return { ok: false, message: "Can't claim this one — it's already taken or needs a file checker." };
      }
      return { ok: false, message: reason || "Couldn't claim that task." };
    }
  }

  /* Replace the recorded root task card(s) in-place via updateActivity, so a
     claim made from one card disables the button for everyone, everywhere the
     card was posted — not just the client that tapped it. Best-effort: a
     failed update (e.g. message deleted) shouldn't fail the claim. */
  private async updateTaskCard(taskId: string, card: Record<string, unknown>): Promise<void> {
    if (!this.adapter) {
      return;
    }
    const thread = await this.threads.get(taskId);
    if (!thread || thread.posts.length === 0) {
      return;
    }
    const attachment = CardFactory.adaptiveCard(card);
    await Promise.all(
      thread.posts.map((post) =>
        this.adapter!.continueConversationAsync(this.appId!, post.reference, async (context) => {
          try {
            await context.updateActivity({ type: "message", id: post.activityId, attachments: [attachment] });
          } catch (error) {
            console.error("bot_update_task_card_failed", error);
          }
        })
      )
    );
  }

  async init(): Promise<void> {
    await this.store.init();
    await this.threads.init();
  }

  isEnabled(): boolean {
    return Boolean(this.adapter && this.bot);
  }

  /* Bot connectivity for the admin panel. `enabled` = credentials are
     configured. DM/channel counts come from stored conversation references,
     which only exist once Teams has actually delivered a message to this
     server — so a non-zero count is real proof the bot is wired end-to-end. */
  async status(): Promise<{ enabled: boolean; dmCount: number; channelCount: number }> {
    if (!this.isEnabled()) {
      return { enabled: false, dmCount: 0, channelCount: 0 };
    }
    let references: { scope: "DM" | "CHANNEL" }[] = [];
    try {
      references = await this.store.read();
    } catch {
      references = [];
    }
    return {
      enabled: true,
      dmCount: references.filter((r) => r.scope === "DM").length,
      channelCount: references.filter((r) => r.scope === "CHANNEL").length
    };
  }

  register(app: Express, pathName = "/api/bot/messages"): void {
    app.post(pathName, async (req, res) => {
      if (!this.adapter || !this.bot) {
        res.status(503).json({ error: "Bot credentials not configured" });
        return;
      }

      try {
        await this.adapter.processActivity(req, res, async (turnContext) => {
          await this.bot?.run(turnContext);
        });
      } catch (error) {
        console.error("bot_process_activity_failed", error);
        if (!res.headersSent) {
          res.status(500).json({ error: "Bot activity handling failed" });
        }
      }
    });
  }

  async sendToDms(text: string): Promise<void> {
    if (!this.adapter) {
      return;
    }

    const references = (await this.store.read()).filter((entry) => entry.scope === "DM");
    await Promise.all(
      references.map((entry) =>
        this.adapter!.continueConversationAsync(this.appId!, entry.reference, async (context) => {
          await context.sendActivity(MessageFactory.text(text));
        })
      )
    );
  }

  async sendToDmUsers(userIds: string[], text: string): Promise<void> {
    if (!this.adapter || userIds.length === 0) {
      return;
    }

    const unique = Array.from(new Set(userIds.map((id) => id.trim()).filter((id) => id.length > 0)));
    if (unique.length === 0) {
      return;
    }

    const references = (await this.store.read()).filter((entry) => {
      if (entry.scope !== "DM") {
        return false;
      }
      return unique.some((userId) => entry.userAadObjectId === userId || entry.userId === userId || entry.key === `dm:${userId}`);
    });

    await Promise.all(
      references.map((entry) =>
        this.adapter!.continueConversationAsync(this.appId!, entry.reference, async (context) => {
          await context.sendActivity(MessageFactory.text(text));
        })
      )
    );
  }

  /* Resolve which channel group notifications target (an admin setting). When
     it returns undefined, notifications broadcast to every channel the bot is
     in (legacy behaviour). */
  setNotificationChannelResolver(resolver: () => Promise<string | undefined>): void {
    this.notificationChannelResolver = resolver;
  }

  /* Captured CHANNEL references, narrowed to the admin-selected channel when one
     is set (and present). If the selection no longer matches any captured
     channel, fall back to all so notifications aren't silently dropped. */
  private async targetChannelReferences(): Promise<StoredReference[]> {
    const channels = (await this.store.read()).filter((entry) => entry.scope === "CHANNEL");
    const selectedId = this.notificationChannelResolver ? await this.notificationChannelResolver() : undefined;
    if (!selectedId) {
      return channels;
    }
    const matched = channels.filter((entry) => entry.reference.conversation?.id === selectedId);
    return matched.length > 0 ? matched : channels;
  }

  /* List captured channels for the admin picker. Name falls back to the id when
     Teams didn't include a display name on the reference. */
  async listChannels(): Promise<Array<{ id: string; name: string }>> {
    const channels = (await this.store.read()).filter((entry) => entry.scope === "CHANNEL");
    const byId = new Map<string, { id: string; name: string }>();
    for (const entry of channels) {
      const id = entry.reference.conversation?.id;
      if (!id) {
        continue;
      }
      byId.set(id, { id, name: entry.displayName ?? entry.reference.conversation?.name ?? id });
    }
    return [...byId.values()];
  }

  async sendToChannels(title: string, text: string): Promise<void> {
    if (!this.adapter) {
      return;
    }

    const references = await this.targetChannelReferences();
    const card = CardFactory.heroCard(title, text);

    await Promise.all(
      references.map((entry) =>
        this.adapter!.continueConversationAsync(this.appId!, entry.reference, async (context) => {
          await context.sendActivity({ attachments: [card] });
        })
      )
    );
  }

  /* Post a freshly created task as an Adaptive Card with a one-tap Claim
     button, recording each channel's root message id so later updates can
     thread under it. */
  async postTaskCard(taskId: string, title: string, detail: string, openUrl?: string): Promise<void> {
    if (!this.adapter) {
      return;
    }

    const references = await this.targetChannelReferences();
    const card = CardFactory.adaptiveCard(adaptiveTaskCard({ title, detail, taskId, ...(openUrl ? { openUrl } : {}) }));
    const posts: StoredThread["posts"] = [];

    await Promise.all(
      references.map((entry) =>
        this.adapter!.continueConversationAsync(this.appId!, entry.reference, async (context) => {
          const response = await context.sendActivity({ attachments: [card] });
          if (response?.id) {
            posts.push({ reference: entry.reference, activityId: response.id });
          }
        })
      )
    );

    if (posts.length > 0) {
      await this.threads.save({ taskId, posts });
    }
  }

  /* Reply inside a task's existing channel thread (e.g. "Alex grabbed this
     one"). Falls back to a fresh channel post if we have no record of the
     root card — the bot may have restarted, or the task predates threading. */
  async replyInThread(taskId: string, text: string, fallbackTitle: string): Promise<void> {
    if (!this.adapter) {
      return;
    }

    const thread = await this.threads.get(taskId);
    // Honour the admin's channel selection: a task created while broadcasting to
    // all channels keeps a root post per channel, so narrow to the selected one.
    // If none of the stored posts is in the selected channel, fall back to a
    // fresh (already-filtered) channel post so the update still lands there.
    const selectedId = this.notificationChannelResolver ? await this.notificationChannelResolver() : undefined;
    const posts = thread
      ? selectedId
        ? thread.posts.filter((post) => post.reference.conversation?.id === selectedId)
        : thread.posts
      : [];
    if (posts.length === 0) {
      await this.sendToChannels(fallbackTitle, text);
      return;
    }

    await Promise.all(
      posts.map((post) =>
        this.adapter!.continueConversationAsync(
          this.appId!,
          threadReference(post.reference, post.activityId),
          async (context) => {
            await context.sendActivity(MessageFactory.text(text));
          }
        )
      )
    );
  }
}
