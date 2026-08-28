import { promises as fs } from "node:fs";
import path from "node:path";
import { CreateTaskInput, FraudCardAction, LoanTask, TaskCardRecipient, TaskStatus, TaskType, UrgencyLevel, UserIdentity, botPrimaryAdvance, canTransitionStatus, computeDueAtFromReturnDate, fraudCardActions, getNotesFieldLabel } from "@loan-tasks/shared";
import { Activity, ActivityHandler, BotFrameworkAdapter, CardFactory, ConversationAccount, ConversationParameters, ConversationReference, InvokeResponse, MessageFactory, TeamsInfo, TextFormatTypes, TurnContext } from "botbuilder";
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
  /* `userId` is recorded for DM posts so a later status-driven re-sync can
     rebuild each recipient's card with the buttons *that* viewer should see.
     Absent on channel posts (and on DM entries written before it existed). */
  /* `kind` distinguishes the original creation card from a pool-nag card
     (ADR-0005), so a fresh nag deletes only the nag before it. Absent on DM
     posts and on channel posts written before nags existed — treat as "create",
     which is the safe reading: an unmarked post is never deleted. */
  posts: Array<{ reference: Partial<ConversationReference>; activityId: string; userId?: string; kind?: "create" | "nag" }>;
  /* The claimable-card content, kept so the user-specific refresh can rebuild
     the creator's Cancel view (and the OPEN base card) without re-deriving it. */
  card?: { title: string; detail: string; openUrl?: string; creatorUserIds?: string[] };
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
        // Keep a previously captured friendly label when this save lacks one
        // (e.g. an invoke activity with only the conversation id) so the admin
        // picker doesn't regress to the raw id.
        const prior = entries[idx];
        entries[idx] = {
          ...reference,
          ...(reference.displayName === undefined && prior?.displayName ? { displayName: prior.displayName } : {})
        };
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
  openUrl?: string;
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
  /* Fraud two-phase buttons. Its presence (even as []) marks the card as a fraud
     card, so `noteCard` uses this button set instead of the generic advance. */
  fraudActions?: FraudCardAction[];
  /* Set once the task reaches a terminal status: the card becomes a record
     rather than a control surface, so every advance/fraud button is dropped.
     `allowReply` keeps the reply box for COMPLETED, where addCompletedNote
     (issue #45) still accepts notes; CANCELLED/ARCHIVED lose it too. */
  closed?: ClosedCardState;
}

interface ClosedCardState {
  label: string;
  allowReply: boolean;
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
  // FRAUD two-phase completion (#39). Reads naturally in the DM confirm line
  // "<folder> is now <label>." (e.g. "…is now awaiting outstanding items.").
  AWAITING_ITEMS: "awaiting outstanding items",
  PENDING_APPROVAL: "pending final approval",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  ARCHIVED: "archived"
};

/* Last few notes for a card thread, oldest → newest. Exported because every
   card-sending path in the notification layer needs the same window. */
export const recentNoteThread = (task: LoanTask): NoteThreadEntry[] =>
  (task.reviewNotes ?? []).slice(-5).map((entry) => ({ author: entry.by.displayName, text: entry.text }));

/* The forward button a card offers this viewer, or undefined when the flow has
   no next step or this viewer isn't the one who takes it. `botPrimaryAdvance`
   answers the first half (status only, deliberately); `canTransitionStatus`
   answers the second, so a card never renders a button the server would refuse.

   One definition for every card surface that shows the affordance (#173). The
   note card asked the permission question; the confirm card asked it for FRAUD
   only, on the reasoning that a fraud hand-off passes the task to the other
   party. Every merge rung is a hand-off too, so once the merge seats were
   guarded that exception handed the assignee who had just tapped Merge Done an
   Approve Merge button belonging to the creator.

   A viewer is optional and its absence is a real answer, not an unknown one:
   the channel card is addressed to no one in particular and has nobody to gate
   against, so it keeps the flow's next step. */
export const advanceFor = (task: LoanTask, viewer?: UserIdentity): { status: TaskStatus; label: string } | undefined => {
  const advance = botPrimaryAdvance(task);
  if (!advance) {
    return undefined;
  }
  return !viewer || canTransitionStatus(task, advance.status, viewer).ok ? advance : undefined;
};

/* Build note-card data from a task (used to refresh after a reply). The
   advance/Complete button is only offered to a viewer allowed to perform it
   (e.g. Complete is the assignee's action, not the creator's) — without this
   the reply-box refresh would re-add Complete for anyone. */
export const noteCardDataFromTask = (task: LoanTask, viewer?: UserIdentity): NoteCardData => {
  const closed = closedStateFor(task.status, task.folderName);
  // FRAUD cards carry the role-aware two-phase button set (keyed off the viewer)
  // instead of the generic single advance. The key is always present for a fraud
  // task (empty when this viewer has no action in this state) so `noteCard`
  // routes to the fraud button set and never re-adds the generic advance.
  if (task.taskType === "FRAUD") {
    return {
      taskId: task.id,
      folder: task.folderName,
      thread: recentNoteThread(task),
      fraudActions: fraudCardActions(task, viewer),
      ...(closed ? { closed } : {})
    };
  }
  const advance = advanceFor(task, viewer);
  return {
    taskId: task.id,
    folder: task.folderName,
    thread: recentNoteThread(task),
    ...(advance ? { advance } : {}),
    ...(closed ? { closed } : {})
  };
};

/* The contextual "move it forward" button (Merge Done / Approve Merge /
   Complete). Title comes from botPrimaryAdvance, i.e. the shared
   ACTION_LABELS — the bot never words an action itself (#116).
   Empty when there's no forward step. */
const advanceButton = (taskId: string, advance?: AdvanceAction): Record<string, unknown>[] =>
  advance
    ? [{ type: "Action.Execute", title: advance.label, verb: "transitionTask", data: { taskId, targetStatus: advance.status } }]
    : [];

/* Render the fraud button set. A note-required action opens an inline note input
   (Action.ShowCard) whose submit carries the note as the transition's
   reviewNotes — the server rejects a blank note, and the submit handler guards
   it too. Plain transitions and release are one-tap Action.Execute. */
const fraudActionButtons = (taskId: string, actions: FraudCardAction[]): Record<string, unknown>[] =>
  actions.map((action) => {
    /* Blocked by the task's state rather than by who's tapping (#184: Submit
       waits until every checklist item is checked or noted). Adaptive Cards 1.4
       has no disabled action, so the button opens the reason in place instead of
       firing a move the server would refuse — the card says why, which is the
       same thing the web button's disabled hint says. */
    if (action.blockedReason) {
      return {
        type: "Action.ShowCard",
        title: action.label,
        card: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [{ type: "TextBlock", text: action.blockedReason, wrap: true }]
        }
      };
    }
    if (action.kind === "release") {
      return { type: "Action.Execute", title: action.label, verb: "releaseTask", data: { taskId } };
    }
    if (action.kind === "transition") {
      return { type: "Action.Execute", title: action.label, verb: "transitionTask", data: { taskId, targetStatus: action.targetStatus } };
    }
    return {
      type: "Action.ShowCard",
      title: action.label,
      card: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.4",
        body: [{ type: "Input.Text", id: "fraudNote", placeholder: "Describe what's outstanding…", isMultiline: true }],
        actions: [{ type: "Action.Execute", title: action.label, verb: "transitionWithNote", data: { taskId, targetStatus: action.targetStatus } }]
      }
    };
  });

/* DM card for a review-note conversation: the recent thread (oldest → newest),
   an inline reply box that posts straight back as another note, and a contextual
   advance/complete button. The reply box persists so users can send several
   messages in a row. */
export const noteCard = (data: NoteCardData): Record<string, unknown> => {
  const canReply = !data.closed || data.closed.allowReply;
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      // A closed task leads with its terminal banner; the conversation stays
      // below it, since the point of keeping the card is keeping the history.
      ...(data.closed ? [{ type: "TextBlock", text: data.closed.label, weight: "Bolder", wrap: true, size: "Medium" }] : []),
      { type: "TextBlock", text: `Conversation on ${data.folder}`, weight: "Bolder", wrap: true },
      ...data.thread.map((entry) => ({
        type: "TextBlock",
        text: `**${entry.author}:** ${entry.text}`,
        wrap: true,
        spacing: "Small"
      })),
      ...(canReply ? [{ type: "Input.Text", id: "replyText", placeholder: "Type a reply…", isMultiline: true }] : [])
    ],
    actions: [
      ...(canReply
        ? [{ type: "Action.Execute", title: "Reply", verb: "replyNote", data: { taskId: data.taskId, folder: data.folder } }]
        : []),
      // A closed task has no forward step, so it carries no action buttons. A
      // fraud card (fraudActions present, even when empty) otherwise drives its
      // own role-aware set; every other card keeps the single advance button.
      ...(data.closed
        ? []
        : data.fraudActions !== undefined
          ? fraudActionButtons(data.taskId, data.fraudActions)
          : advanceButton(data.taskId, data.advance))
    ]
  };
};

/* Full-details DM card sent to whoever claims a task. `closed` replaces the
   title with the terminal banner and drops the advance button — the details and
   the Open in Hot Task link stay, so the card is still a useful record. */
export const detailCard = (opts: {
  taskId: string;
  title: string;
  detail: string;
  openUrl?: string;
  advance?: AdvanceAction;
  closed?: ClosedCardState;
}): Record<string, unknown> => ({
  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
  type: "AdaptiveCard",
  version: "1.4",
  body: [
    { type: "TextBlock", text: opts.closed ? opts.closed.label : opts.title, weight: "Bolder", wrap: true, size: "Medium" },
    { type: "TextBlock", text: opts.detail, wrap: true, spacing: "Small" }
  ],
  actions: [
    ...(opts.closed ? [] : advanceButton(opts.taskId, opts.advance)),
    ...(opts.openUrl ? [{ type: "Action.OpenUrl", title: "Open in Hot Task", url: opts.openUrl }] : [])
  ]
});

/* The terminal banner a DM card carries once its task is closed, and whether the
   note card keeps its reply box. Undefined while the task is still live, which
   is what makes a re-open re-arm the buttons for free. */
export const closedStateFor = (status: TaskStatus, folder: string): ClosedCardState | undefined => {
  if (status === "COMPLETED") {
    return { label: `✅ Completed — ${folder}`, allowReply: true };
  }
  if (status === "CANCELLED") {
    return { label: `🚫 Cancelled — ${folder}`, allowReply: false };
  }
  if (status === "ARCHIVED") {
    return { label: `📦 Archived — ${folder}`, allowReply: false };
  }
  return undefined;
};

/* Card a card is refreshed to after a successful transition — confirms the move
   and offers the next forward step if there is one. */
const transitionConfirmCard = (data: ConfirmData): Record<string, unknown> => ({
  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
  type: "AdaptiveCard",
  version: "1.4",
  body: [{ type: "TextBlock", text: data.message, weight: "Bolder", wrap: true }],
  actions: advanceButton(data.taskId, data.advance)
});

/* A `refresh` block makes Teams auto-fetch a user-specific view for the listed
   user MRIs (the creator) — they get the creator card (Cancel) while everyone
   else keeps the base Claim card. Omitted when we don't know the creator's MRI
   (they've never messaged the bot), so the card simply stays Claim-for-all. */
const refreshBlock = (taskId: string, creatorUserIds: string[]): Record<string, unknown> | undefined =>
  creatorUserIds.length > 0
    ? { action: { type: "Action.Execute", title: "Refresh", verb: "refreshTaskCard", data: { taskId } }, userIds: creatorUserIds }
    : undefined;

/* Adaptive Card shown on a freshly created task: headline + detail + a
   single one-tap Claim button (universal Action.Execute, handled by
   onInvokeActivity). `creatorUserIds` (Teams MRIs) opt the creator into a
   user-specific Cancel view via the refresh block. */
const adaptiveTaskCard = (opts: { title: string; detail: string; taskId: string; openUrl?: string; creatorUserIds?: string[] }): Record<string, unknown> => {
  const refresh = refreshBlock(opts.taskId, opts.creatorUserIds ?? []);
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    ...(refresh ? { refresh } : {}),
    body: [
      { type: "TextBlock", text: opts.title, weight: "Bolder", wrap: true, size: "Medium" },
      { type: "TextBlock", text: opts.detail, wrap: true, spacing: "Small", isSubtle: true }
    ],
    actions: [
      { type: "Action.Execute", title: "Claim", verb: "claimTask", data: { taskId: opts.taskId } },
      ...(opts.openUrl ? [{ type: "Action.OpenUrl", title: "Open in Hot Task", url: opts.openUrl }] : [])
    ]
  };
};

/* The creator's user-specific view of an OPEN task card: same headline/detail,
   but Cancel instead of Claim (the creator manages, doesn't claim, their own
   task). Keeps the refresh block so the view stays current. */
const creatorTaskCard = (opts: { title: string; detail: string; taskId: string; openUrl?: string; creatorUserIds: string[] }): Record<string, unknown> => {
  const refresh = refreshBlock(opts.taskId, opts.creatorUserIds);
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    ...(refresh ? { refresh } : {}),
    body: [
      { type: "TextBlock", text: opts.title, weight: "Bolder", wrap: true, size: "Medium" },
      { type: "TextBlock", text: opts.detail, wrap: true, spacing: "Small", isSubtle: true },
      { type: "TextBlock", text: "Your task — cancel it if it's no longer needed.", wrap: true, spacing: "Small", isSubtle: true }
    ],
    actions: [
      { type: "Action.Execute", title: "Cancel Task", verb: "cancelTask", data: { taskId: opts.taskId } },
      ...(opts.openUrl ? [{ type: "Action.OpenUrl", title: "Open in Hot Task", url: opts.openUrl }] : [])
    ]
  };
};

/* The deep-link button, as a spreadable fragment. Every root-card state carries
   it and every one of them must omit the `actions` key entirely when there's no
   recorded link — an empty array is not the same card. `teamsTaskDeepLink`
   returns undefined whenever `TEAMS_APP_ID` is unset, which is local and test. */
const openUrlAction = (openUrl?: string): Record<string, unknown> =>
  openUrl ? { actions: [{ type: "Action.OpenUrl", title: "Open in Hot Task", url: openUrl }] } : {};

/* Card the original message is refreshed to after a successful claim — the
   Claim button is gone so the task can't be double-claimed from the card, but
   "Open in Hot Task" stays so the card is still useful after claiming.
   `assigneeLine` overrides the default "Claimed by X" attribution: a task born
   assigned (Handoff at creation, ADR-0002) posts this same card, and nobody
   claimed that one. */
const claimedCard = (outcome: ClaimOutcome, openUrl?: string, assigneeLine?: string): Record<string, unknown> => ({
  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
  type: "AdaptiveCard",
  version: "1.4",
  body: [
    { type: "TextBlock", text: outcome.message, weight: "Bolder", wrap: true, size: "Medium" },
    ...(outcome.assignee
      ? [{ type: "TextBlock", text: assigneeLine ?? `Claimed by ${outcome.assignee}`, wrap: true, spacing: "Small", isSubtle: true }]
      : [])
  ],
  ...openUrlAction(openUrl)
});

/* Terminal state the root card is silently edited to when a task completes —
   every action button is gone, but "Open in Hot Task" survives so the card that
   records the finished work is still a way into it (#178). Also the ARCHIVED
   rendering. */
const completedCard = (folder: string, assignee?: string, openUrl?: string): Record<string, unknown> => ({
  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
  type: "AdaptiveCard",
  version: "1.4",
  body: [
    { type: "TextBlock", text: `✅ Completed — ${folder}`, weight: "Bolder", wrap: true, size: "Medium" },
    ...(assignee ? [{ type: "TextBlock", text: `by ${assignee}`, wrap: true, spacing: "Small", isSubtle: true }] : [])
  ],
  ...openUrlAction(openUrl)
});

/* Terminal cancelled state for the root card. Keeps the link for the same
   reason — a cancellation is exactly when someone goes to look at what
   happened. */
const cancelledCard = (folder: string, openUrl?: string): Record<string, unknown> => ({
  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
  type: "AdaptiveCard",
  version: "1.4",
  body: [{ type: "TextBlock", text: `🚫 Cancelled — ${folder}`, weight: "Bolder", wrap: true, size: "Medium" }],
  ...openUrlAction(openUrl)
});

/* The old root card is silently edited to this pointer when a task is re-opened
   into a fresh thread, so the stale card doesn't keep showing a Claim button. */
const reopenedPointerCard = (folder: string): Record<string, unknown> => ({
  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
  type: "AdaptiveCard",
  version: "1.4",
  body: [{ type: "TextBlock", text: `↩︎ Reopened — ${folder} is back up for grabs (see latest post)`, wrap: true, isSubtle: true }]
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

/* A Teams channel conversation id can carry a `;messageid=…` thread suffix when
   the captured activity happened inside a thread. The channel itself is the part
   before the suffix, so normalise to it for listing/selection — otherwise the
   same channel shows up multiple times in the picker. */
const baseChannelId = (id: string): string => id.split(";")[0] ?? id;

/* Flatten markdown links (`[text](url)` → `text`) for a card's summary, the
   plain text Teams shows in the channel list / notification instead of "Card". */
const plainSummary = (title: string): string => title.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

/* Collapse captured channel references to one per real channel, preferring the
   unsuffixed root reference over a `;messageid=…` thread capture, so a single
   channel never receives duplicate broadcasts. */
const dedupeChannelRefs = (refs: StoredReference[]): StoredReference[] => {
  const byBase = new Map<string, StoredReference>();
  for (const entry of refs) {
    const id = entry.reference.conversation?.id;
    if (!id) {
      continue;
    }
    const base = baseChannelId(id);
    const existing = byBase.get(base);
    const existingIsRoot = existing?.reference.conversation?.id === base;
    if (!existing || (id === base && !existingIsRoot)) {
      byBase.set(base, entry);
    }
  }
  return [...byBase.values()];
};

/* Collapse captured DM references to one per 1:1 conversation before a
   proactive fan-out. A single user can hold two "DM" references for the same
   chat — one captured before Teams populated `aadObjectId` (keyed
   `dm:<teamsId>`) and one after (keyed `dm:<aadObjectId>`). Different keys, so
   ReferenceStore.save never overwrote, but the same `conversation.id`, so both
   satisfy a userId match and the message lands twice (issue #40). Unlike
   channels, DMs carry no `;messageid=…` thread suffix, so dedupe on the exact
   conversation id. Drop references with no conversation id (nothing to send
   to). Mirrors dedupeChannelRefs. Exported for unit coverage. */
export const dedupeDmRefs = (refs: StoredReference[]): StoredReference[] => {
  const byConversation = new Map<string, StoredReference>();
  for (const entry of refs) {
    const id = entry.reference.conversation?.id;
    if (!id) {
      continue;
    }
    if (!byConversation.has(id)) {
      byConversation.set(id, entry);
    }
  }
  return [...byConversation.values()];
};

/* Friendly "Team / Channel" label from a channel activity's channelData, for
   the admin picker. Teams often omits channel.name for the default General
   channel, so fall back to just the team name. Returns undefined for DMs or
   when no names are present (caller then falls back to conversation id). */
const channelDisplayName = (activity: { channelData?: unknown }): string | undefined => {
  const data = activity.channelData as { team?: { name?: string }; channel?: { name?: string } } | undefined;
  const parts = [data?.team?.name, data?.channel?.name].filter((p): p is string => Boolean(p && p.trim()));
  return parts.length > 0 ? parts.join(" / ") : undefined;
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
    /* Resolve an advance/complete button into a status transition. `reviewNotes`
       rides along for note-required fraud moves (Send Outstanding Items / Send
       Back) and is ignored by plain transitions. */
    private readonly onTransition: (taskId: string, targetStatus: string, aadObjectId: string | undefined, reviewNotes?: string) => Promise<TransitionOutcome>,
    /* Resolve a "Release for any fraud checker" tap into an in-place unassign. */
    private readonly onRelease: (taskId: string, aadObjectId: string | undefined) => Promise<TransitionOutcome>,
    /* Resolve a user-specific card refresh into the card that viewer should see
       (creator → Cancel while OPEN; everyone else → current base state). */
    private readonly onRefreshCard: (taskId: string, aadObjectId: string | undefined) => Promise<Record<string, unknown> | undefined>
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
      return cardRefreshResponse(claimedCard(outcome, outcome.openUrl));
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

    if (verb === "transitionWithNote") {
      // Note-required fraud move (Send Outstanding Items / Send Back): the note
      // rides in as the transition's reviewNotes. The server rejects a blank
      // note; guard here too so the tapper gets a clear toast instead.
      const targetStatus = typeof data.targetStatus === "string" ? data.targetStatus : undefined;
      const note = typeof data.fraudNote === "string" ? data.fraudNote.trim() : "";
      if (!taskId || !targetStatus) {
        return cardMessageResponse("Sorry, I couldn't tell which task that was.");
      }
      if (!note) {
        return cardMessageResponse("Add a note describing what's outstanding first, then submit.");
      }
      const outcome = await this.onTransition(taskId, targetStatus, from?.aadObjectId, note);
      if (!outcome.ok || !outcome.confirm) {
        return cardMessageResponse(outcome.message);
      }
      return cardRefreshResponse(transitionConfirmCard(outcome.confirm));
    }

    if (verb === "releaseTask") {
      if (!taskId) {
        return cardMessageResponse("Sorry, I couldn't tell which task that was.");
      }
      const outcome = await this.onRelease(taskId, from?.aadObjectId);
      if (!outcome.ok || !outcome.confirm) {
        return cardMessageResponse(outcome.message);
      }
      return cardRefreshResponse(transitionConfirmCard(outcome.confirm));
    }

    if (verb === "cancelTask") {
      // Creator tapped Cancel on their user-specific card view.
      if (!taskId) {
        return cardMessageResponse("Sorry, I couldn't tell which task that was.");
      }
      const outcome = await this.onTransition(taskId, "CANCELLED", from?.aadObjectId);
      if (!outcome.ok || !outcome.confirm) {
        return cardMessageResponse(outcome.message);
      }
      return cardRefreshResponse(transitionConfirmCard(outcome.confirm));
    }

    if (verb === "refreshTaskCard") {
      // Teams auto-refresh (or a manual refresh) of a user-specific view.
      if (!taskId) {
        return super.onInvokeActivity(context);
      }
      const card = await this.onRefreshCard(taskId, from?.aadObjectId);
      if (!card) {
        return super.onInvokeActivity(context);
      }
      return cardRefreshResponse(card);
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
    const displayName = scope === "CHANNEL" ? await this.resolveChannelLabel(context) : undefined;
    await this.onReference(reference, scope, displayName);
  }

  /* Build the "Team / Channel" label for the picker from the Teams connector
     (getTeamChannels for the channel name, getTeamDetails for the team name) —
     channelData hands these out inconsistently. No extra Graph permission.
     Falls back to the channelData label if the connector calls fail. */
  private async resolveChannelLabel(context: TurnContext): Promise<string | undefined> {
    const fallback = channelDisplayName(context.activity);
    const channelData = context.activity.channelData as
      | { team?: { name?: string }; channel?: { id?: string } }
      | undefined;
    const channelId = channelData?.channel?.id ?? baseChannelId(context.activity.conversation?.id ?? "");

    // channelData supplies team/channel names inconsistently across activity
    // types (root message vs thread reply), so resolve both from the Teams
    // connector (no extra Graph perm) for a stable "Team / Channel" label on
    // every capture.
    let teamName = channelData?.team?.name?.trim() || undefined;
    let channelName: string | undefined;
    try {
      const channels = await TeamsInfo.getTeamChannels(context);
      const match = channels.find((c) => baseChannelId(c.id ?? "") === baseChannelId(channelId));
      channelName = match?.name?.trim() || undefined;
    } catch {
      /* connector unavailable — keep whatever channelData gave us */
    }
    if (!teamName) {
      try {
        teamName = (await TeamsInfo.getTeamDetails(context))?.name?.trim() || undefined;
      } catch {
        /* ignore */
      }
    }

    const parts = [teamName, channelName].filter((p): p is string => Boolean(p));
    return parts.length > 0 ? parts.join(" / ") : fallback;
  }
}

export class TeamsBotClient {
  private readonly adapter?: BotFrameworkAdapter;
  private readonly bot?: LoanTasksBot;
  private readonly store: ReferenceStore;
  private readonly threads: ThreadStore;
  /* Per-task DM note-conversation cards, keyed by taskId with one post per
     recipient DM. Lets a note posted from the web app update the existing DM
     card in place instead of sending a brand-new card each time. */
  private readonly noteCards: ThreadStore;
  /* Per-task DM claim-detail cards, same shape as the note-card store. Without
     this the claim card was fire-and-forget: its activity id was discarded, so
     its Complete button could never be taken away once the task moved on. */
  private readonly detailCards: ThreadStore;
  private taskCreator?: BotTaskCreator;
  private taskClaimer?: (taskId: string, user: UserIdentity) => Promise<LoanTask>;
  private userResolver?: (aadObjectId: string) => Promise<UserIdentity | undefined>;
  private noteAdder?: (taskId: string, text: string, user: UserIdentity) => Promise<LoanTask>;
  private taskTransitioner?: (taskId: string, status: TaskStatus, user: UserIdentity, reviewNotes?: string) => Promise<LoanTask>;
  private taskReleaser?: (taskId: string, user: UserIdentity) => Promise<LoanTask>;
  private taskLookup?: (taskId: string) => Promise<LoanTask | undefined>;
  private cardResync?: (taskId: string) => Promise<void>;
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
    this.noteCards = new ThreadStore(path.join(path.dirname(dataFile), "bot-note-cards.json"));
    this.detailCards = new ThreadStore(path.join(path.dirname(dataFile), "bot-detail-cards.json"));

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
        async (taskId, targetStatus, aadObjectId, reviewNotes) => this.handleTransition(taskId, targetStatus, aadObjectId, reviewNotes),
        async (taskId, aadObjectId) => this.handleRelease(taskId, aadObjectId),
        async (taskId, aadObjectId) => this.handleRefreshCard(taskId, aadObjectId)
      );
    }
  }

  /* Look up a task by id — used by the user-specific card refresh to decide the
     creator's view from live state. */
  setTaskLookup(lookup: (taskId: string) => Promise<LoanTask | undefined>): void {
    this.taskLookup = lookup;
  }

  /* Re-run a task's DM card sync on demand. Card sync is best-effort and never
     retried, so an update can be dropped; wiring this lets a card that failed to
     update repair itself the first time someone taps a button on it. */
  setCardResync(resync: (taskId: string) => Promise<void>): void {
    this.cardResync = resync;
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

  /* Wire the advance/complete buttons on cards to the task service. `reviewNotes`
     carries the outstanding-items note for note-required fraud moves. */
  setTransitionHandler(
    resolveUser: (aadObjectId: string) => Promise<UserIdentity | undefined>,
    transition: (taskId: string, status: TaskStatus, user: UserIdentity, reviewNotes?: string) => Promise<LoanTask>
  ): void {
    this.userResolver = resolveUser;
    this.taskTransitioner = transition;
  }

  /* Wire the "Release for any fraud checker" button to the task service. */
  setReleaseHandler(
    resolveUser: (aadObjectId: string) => Promise<UserIdentity | undefined>,
    release: (taskId: string, user: UserIdentity) => Promise<LoanTask>
  ): void {
    this.userResolver = resolveUser;
    this.taskReleaser = release;
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
      return { ok: true, message: "Reply posted.", note: noteCardDataFromTask(task, user) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Couldn't post that reply." };
    }
  }

  private async handleTransition(taskId: string, targetStatus: string, aadObjectId: string | undefined, reviewNotes?: string): Promise<TransitionOutcome> {
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
      const task = await this.taskTransitioner(taskId, targetStatus as TaskStatus, user, reviewNotes);
      return { ok: true, message: "Done.", confirm: this.confirmFor(task, user) };
    } catch (error) {
      return this.staleTapOutcome(taskId, error, "Couldn't update that task.");
    }
  }

  private async handleRelease(taskId: string, aadObjectId: string | undefined): Promise<TransitionOutcome> {
    if (!this.taskReleaser || !this.userResolver) {
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
      const task = await this.taskReleaser(taskId, user);
      return {
        ok: true,
        message: "Done.",
        confirm: {
          taskId: task.id,
          folder: task.folderName,
          message: `${task.folderName} is up for grabs — any fraud checker can approve it now.`
        }
      };
    } catch (error) {
      return this.staleTapOutcome(taskId, error, "Couldn't release that task.");
    }
  }

  /* A rejected card action usually means the card is out of date — the task moved
     on somewhere else and this button shouldn't still be here. Kick off a re-sync
     so the card repairs itself, and say so, rather than leaving a dead button the
     user can keep tapping. Fire-and-forget: the invoke response shouldn't wait on
     a Teams round-trip, and a failed repair must not swallow the real error. */
  private staleTapOutcome(taskId: string, error: unknown, fallback: string): TransitionOutcome {
    const reason = error instanceof Error ? error.message : fallback;
    void Promise.resolve(this.cardResync?.(taskId)).catch((resyncError) => {
      console.error("bot_card_resync_failed", resyncError);
    });
    return { ok: false, message: `${reason} Refreshing this card.` };
  }

  /* Build the confirm card shown after a card-tap transition. The forward button
     is offered only when the acting user can actually take the next step (a
     FRAUD hand-off passes the task to the *other* party, so the tapper sees no
     stray next button). */
  private confirmFor(task: LoanTask, user: UserIdentity): ConfirmData {
    // Every flow hands off, not just FRAUD: the tapper is offered the next step
    // only when it is theirs to take (#173).
    const advance = advanceFor(task, user);
    return {
      taskId: task.id,
      folder: task.folderName,
      message: `${task.folderName} is now ${STATUS_DISPLAY[task.status] ?? task.status}.`,
      ...(advance ? { advance } : {})
    };
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

  /* Proactively send an activity to a stored conversation reference.

     The adapter's continueConversationAsync path returns "NotImplemented" for
     this bot's auth config — in prod every DM, thread reply, and card update
     failed that way. createConnectorClient + the conversations REST API works
     (it's the same primitive createChannelThread uses for new channel posts),
     so all proactive sends go through it. Best-effort: logs and swallows errors
     so a failed notification never breaks the action that triggered it. */
  private async proactiveSend(reference: Partial<ConversationReference>, activity: Partial<Activity>): Promise<string | undefined> {
    const serviceUrl = reference.serviceUrl;
    const conversationId = reference.conversation?.id;
    if (!this.adapter || !serviceUrl || !conversationId) {
      return undefined;
    }
    try {
      const client = this.adapter.createConnectorClient(serviceUrl);
      const outgoing = TurnContext.applyConversationReference({ ...activity }, reference) as Activity;
      // The created activity id lets callers update this message later (e.g.
      // keep a note conversation to a single, in-place-updated DM card).
      const res = await client.conversations.sendToConversation(conversationId, outgoing);
      return res?.id;
    } catch (error) {
      console.error("bot_proactive_send_failed", error);
      return undefined;
    }
  }

  /* In-place update of a previously sent activity (e.g. flipping a task card to
     its claimed state) via the connector REST API, for the same reason as
     proactiveSend. Returns whether the update landed so callers can recover
     from a stale activity id (e.g. one left over from a previous deploy).
     Best-effort: never throws. */
  private async proactiveUpdate(
    reference: Partial<ConversationReference>,
    activityId: string,
    activity: Partial<Activity>
  ): Promise<boolean> {
    const serviceUrl = reference.serviceUrl;
    const conversationId = reference.conversation?.id;
    if (!this.adapter || !serviceUrl || !conversationId || !activityId) {
      return false;
    }
    try {
      const client = this.adapter.createConnectorClient(serviceUrl);
      const outgoing = TurnContext.applyConversationReference({ ...activity }, reference) as Activity;
      outgoing.id = activityId;
      await client.conversations.updateActivity(conversationId, activityId, outgoing);
      return true;
    } catch (error) {
      console.error("bot_update_task_card_failed", error);
      return false;
    }
  }

  /* `summary` sets activity.summary — the text Teams shows in the activity feed
     / notification preview. Without it a card DM reads "Sent a card". */
  /* Delete a previously-sent activity via the connector REST API — used to move
     a note card to the bottom of a chat (delete here, repost fresh). Teams lets
     a bot delete its own messages. Best-effort: never throws. */
  private async proactiveDelete(reference: Partial<ConversationReference>, activityId: string): Promise<void> {
    const serviceUrl = reference.serviceUrl;
    const conversationId = reference.conversation?.id;
    if (!this.adapter || !serviceUrl || !conversationId || !activityId) {
      return;
    }
    try {
      const client = this.adapter.createConnectorClient(serviceUrl);
      await client.conversations.deleteActivity(conversationId, activityId);
    } catch (error) {
      console.error("bot_note_card_delete_failed", error);
    }
  }

  private async sendCardToReferences(
    references: StoredReference[],
    card: ReturnType<typeof CardFactory.adaptiveCard>,
    summary?: string
  ): Promise<void> {
    const activity: Partial<Activity> = { type: "message", attachments: [card], ...(summary?.trim() ? { summary: summary.trim() } : {}) };
    await Promise.all(references.map((entry) => this.proactiveSend(entry.reference, activity)));
  }

  /* Sync the interactive note-conversation card to each participant's DM. Keeps
     ONE card per task per DM: an existing card is updated in place (so a note
     added from the web app — or by the participant themselves — refreshes the
     card instead of stacking a new one); a participant with no card yet gets a
     fresh one only when `createIfMissing` is set (we don't self-ping the author
     of the note). `showAdvance` gates the Complete/advance button per recipient
     (it's the assignee's action, not the creator's). One read-modify-write of
     the store covers all recipients to avoid races. */
  async syncNoteCards(opts: {
    taskId: string;
    folder: string;
    thread: NoteThreadEntry[];
    advance?: AdvanceAction;
    /* Terminal banner for a closed task — drops every action button. */
    closed?: ClosedCardState;
    /* A silent status re-sync, which must not put a new message in anyone's
       chat: it edits what's already there or does nothing. Without this, a card
       whose stored id has gone stale would be reposted, turning a background
       sync into an unannounced DM. The dead id is left for the next note-driven
       send to repair. */
    silent?: boolean;
    recipients: Array<TaskCardRecipient & { createIfMissing: boolean; reposition?: boolean; summary?: string }>;
  }): Promise<void> {
    if (!this.adapter || opts.recipients.length === 0) {
      return;
    }
    const existing = await this.noteCards.get(opts.taskId);
    const posts: StoredThread["posts"] = existing?.posts ? [...existing.posts] : [];
    for (const recipient of opts.recipients) {
      const references = await this.dmReferencesFor([recipient.userId]);
      const card = CardFactory.adaptiveCard(
        noteCard({
          taskId: opts.taskId,
          folder: opts.folder,
          thread: opts.thread,
          // A fraud recipient always carries fraudActions (possibly empty) so the
          // card renders the role-aware button set, never the generic advance.
          ...(recipient.fraudActions !== undefined
            ? { fraudActions: recipient.fraudActions }
            : recipient.showAdvance && opts.advance
              ? { advance: opts.advance }
              : {}),
          ...(opts.closed ? { closed: opts.closed } : {})
        })
      );
      const activity: Partial<Activity> = {
        type: "message",
        attachments: [card],
        ...(recipient.summary?.trim() ? { summary: recipient.summary.trim() } : {})
      };
      for (const entry of references) {
        const conversationId = entry.reference.conversation?.id;
        if (!conversationId) {
          continue;
        }
        const prior = posts.find((post) => post.reference.conversation?.id === conversationId);
        if (prior && recipient.reposition) {
          // Move the card to the bottom of the chat (so it isn't stranded above
          // newer lifecycle DMs). Post the fresh card FIRST, then delete the old
          // one — so a failed repost never strands the user with no card; it
          // just degrades to an in-place refresh of the existing card.
          const activityId = await this.proactiveSend(entry.reference, activity);
          if (activityId) {
            await this.proactiveDelete(entry.reference, prior.activityId);
            prior.activityId = activityId;
          } else {
            await this.proactiveUpdate(entry.reference, prior.activityId, activity);
          }
        } else if (prior) {
          const updated = await this.proactiveUpdate(entry.reference, prior.activityId, activity);
          if (!updated && !opts.silent) {
            // Stale id (card deleted, or predates a redeploy) — repost fresh and
            // repair the stored id so the note isn't lost.
            const activityId = await this.proactiveSend(entry.reference, activity);
            if (activityId) {
              prior.activityId = activityId;
            }
          }
        } else if (recipient.createIfMissing) {
          const activityId = await this.proactiveSend(entry.reference, activity);
          if (activityId) {
            posts.push({ reference: entry.reference, activityId, userId: recipient.userId });
          }
        }
      }
    }
    if (posts.length > 0) {
      await this.noteCards.save({ taskId: opts.taskId, posts });
    }
  }

  /* Whether we hold a DM conversation reference for this user — i.e. whether a
     proactive DM to them would actually reach them. The share flow (issue #41)
     uses this to report delivered-vs-not, since sendDetailCardToUsers silently
     no-ops for a user who has never messaged the bot. */
  async hasDmReference(userId: string): Promise<boolean> {
    return (await this.dmReferencesFor([userId])).length > 0;
  }

  /* DM a full-details card and forget about it — used by the share flow (issue
     #41), whose card carries no action buttons to go stale and whose body holds
     the sharer's personal note that a rebuild-from-task would throw away. */
  async sendDetailCardToUsers(
    userIds: string[],
    detail: { taskId: string; title: string; detail: string; openUrl?: string; advance?: AdvanceAction }
  ): Promise<void> {
    if (!this.adapter || userIds.length === 0) {
      return;
    }
    // The card title (e.g. "Dana shared <folder> with you") doubles as the feed
    // preview.
    await this.sendCardToReferences(await this.dmReferencesFor(userIds), CardFactory.adaptiveCard(detailCard(detail)), detail.title);
  }

  /* DM the claim card, recording where each copy landed (activity id +
     recipient) plus the rendered title/detail. That record is what lets
     `syncTaskCards` edit the exact message later — without it, the card's
     Complete button outlives the task, which is the bug this whole path exists
     to fix. */
  async sendTrackedDetailCard(
    userIds: string[],
    detail: { taskId: string; title: string; detail: string; openUrl?: string; advance?: AdvanceAction }
  ): Promise<void> {
    if (!this.adapter || userIds.length === 0) {
      return;
    }
    const card = CardFactory.adaptiveCard(detailCard(detail));
    const activity: Partial<Activity> = { type: "message", attachments: [card], summary: detail.title };
    const existing = await this.detailCards.get(detail.taskId);
    const posts: StoredThread["posts"] = existing?.posts ? [...existing.posts] : [];
    for (const userId of Array.from(new Set(userIds))) {
      for (const entry of await this.dmReferencesFor([userId])) {
        const activityId = await this.proactiveSend(entry.reference, activity);
        if (!activityId) {
          continue;
        }
        // Re-claiming sends a fresh card; the old id is dead to us, so replace
        // rather than accumulate two entries for the same conversation.
        const idx = posts.findIndex((post) => post.reference.conversation?.id === entry.reference.conversation?.id);
        const post = { reference: entry.reference, activityId, userId };
        if (idx >= 0) {
          posts[idx] = post;
        } else {
          posts.push(post);
        }
      }
    }
    if (posts.length > 0) {
      await this.detailCards.save({
        taskId: detail.taskId,
        posts,
        card: { title: detail.title, detail: detail.detail, ...(detail.openUrl ? { openUrl: detail.openUrl } : {}) }
      });
    }
  }

  /* Silently re-render every DM card already sitting in a participant's chat so
     its buttons match the task's live status — the DM counterpart of
     markTaskClaimed/markTaskCompleted on the channel side.

     Strictly an in-place edit: nothing is created (a participant with no card
     stays without one), nothing is repositioned, and no `summary` is set, so
     nobody is re-pinged for a change they were already told about through the
     normal notification. Best-effort, like every other proactive write here. */
  async syncTaskCards(opts: {
    taskId: string;
    folder: string;
    status: TaskStatus;
    thread: NoteThreadEntry[];
    advance?: AdvanceAction;
    recipients: TaskCardRecipient[];
  }): Promise<void> {
    const closed = closedStateFor(opts.status, opts.folder);
    await this.syncNoteCards({
      taskId: opts.taskId,
      folder: opts.folder,
      thread: opts.thread,
      ...(opts.advance ? { advance: opts.advance } : {}),
      ...(closed ? { closed } : {}),
      silent: true,
      recipients: opts.recipients.map((recipient) => ({
        ...recipient,
        createIfMissing: false,
        reposition: false
      }))
    });
    await this.syncDetailCards({ ...opts, ...(closed ? { closed } : {}) });
  }

  /* Re-render the tracked claim-detail card(s) for a task. The body is replayed
     from what was stored at send time (so the due date / notes / Humperdink
     block survives verbatim); only the title and the advance button move. */
  private async syncDetailCards(opts: {
    taskId: string;
    advance?: AdvanceAction;
    closed?: ClosedCardState;
    recipients: TaskCardRecipient[];
  }): Promise<void> {
    if (!this.adapter) {
      return;
    }
    const entry = await this.detailCards.get(opts.taskId);
    if (!entry?.card) {
      return;
    }
    for (const post of entry.posts) {
      // A fraud task's forward move is note-required and lives on the chat card,
      // so the detail card never carries a button for it — same rule as the
      // card's original send in the DM_CLAIM handler.
      const recipient = post.userId ? opts.recipients.find((candidate) => candidate.userId === post.userId) : undefined;
      const showAdvance = Boolean(recipient?.showAdvance) && recipient?.fraudActions === undefined;
      const card = detailCard({
        taskId: opts.taskId,
        title: entry.card.title,
        detail: entry.card.detail,
        ...(entry.card.openUrl ? { openUrl: entry.card.openUrl } : {}),
        ...(showAdvance && opts.advance ? { advance: opts.advance } : {}),
        ...(opts.closed ? { closed: opts.closed } : {})
      });
      await this.proactiveUpdate(post.reference, post.activityId, {
        type: "message",
        attachments: [CardFactory.adaptiveCard(card)]
      });
    }
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
      // claimTask fires a CHANNEL_CLAIMED notification → markTaskClaimed updates
      // every recorded root card. The invoke response below still refreshes the
      // tapper's own client immediately.
      const thread = await this.threads.get(taskId);
      const outcome: ClaimOutcome = {
        ok: true,
        message: `${user.displayName} grabbed ${task.folderName}`,
        status: task.status,
        assignee: user.displayName,
        ...(thread?.card?.openUrl ? { openUrl: thread.card.openUrl } : {})
      };
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

  /* Update a task's channel card(s) to the claimed state. Called for every
     claim (web or card tap) so the Claim button disappears everywhere. A silent
     in-place edit — no new channel message, so nobody is re-pinged. */
  async markTaskClaimed(taskId: string, message: string, assignee: string): Promise<void> {
    const thread = await this.threads.get(taskId);
    await this.updateTaskCard(taskId, claimedCard({ ok: true, message, assignee }, thread?.card?.openUrl));
  }

  /* Silently edit the channel card(s) to the terminal "completed" state. The
     link comes off the recorded thread rather than being rebuilt from the app
     id, so a card posted before a config change keeps pointing where it always
     pointed — the same read markTaskClaimed makes right above. */
  async markTaskCompleted(taskId: string, folder: string, assignee?: string): Promise<void> {
    const thread = await this.threads.get(taskId);
    await this.updateTaskCard(taskId, completedCard(folder, assignee, thread?.card?.openUrl));
  }

  /* Silently edit the channel card(s) to the terminal "cancelled" state — for a
     creator's card-tap Cancel and for a cancel from the web app alike. */
  async markTaskCancelled(taskId: string, folder: string): Promise<void> {
    const thread = await this.threads.get(taskId);
    await this.updateTaskCard(taskId, cancelledCard(folder, thread?.card?.openUrl));
  }

  /* Build the card a user sees when Teams auto-refreshes the user-specific view
     (or someone manually refreshes). The creator sees Cancel while a task is
     OPEN; everyone else — and all non-OPEN states — see the current base state.
     Returns undefined when we have nothing recorded (the invoke then no-ops). */
  private async handleRefreshCard(taskId: string, aadObjectId: string | undefined): Promise<Record<string, unknown> | undefined> {
    const thread = await this.threads.get(taskId);
    const content = thread?.card;
    if (!content) {
      return undefined;
    }
    const creatorUserIds = content.creatorUserIds ?? [];
    const task = this.taskLookup ? await this.taskLookup(taskId) : undefined;
    const base = adaptiveTaskCard({ title: content.title, detail: content.detail, taskId, ...(content.openUrl ? { openUrl: content.openUrl } : {}), creatorUserIds });
    if (!task) {
      return base;
    }
    const isCreator = Boolean(aadObjectId) && task.createdBy.id === aadObjectId;
    const withRefresh = (card: Record<string, unknown>): Record<string, unknown> => {
      const refresh = refreshBlock(taskId, creatorUserIds);
      return refresh ? { ...card, refresh } : card;
    };
    if (task.status === "OPEN") {
      // The whole point: the creator gets Cancel, everyone else gets Claim.
      return isCreator
        ? creatorTaskCard({ title: content.title, detail: content.detail, taskId, ...(content.openUrl ? { openUrl: content.openUrl } : {}), creatorUserIds })
        : base;
    }
    if (task.status === "COMPLETED") {
      return withRefresh(completedCard(task.folderName, task.assignee?.displayName, content.openUrl));
    }
    if (task.status === "CANCELLED") {
      return withRefresh(cancelledCard(task.folderName, content.openUrl));
    }
    if (task.status === "ARCHIVED") {
      return withRefresh(completedCard(task.folderName, task.assignee?.displayName, content.openUrl));
    }
    // In-flight (CLAIMED / NEEDS_REVIEW / MERGE_*): show the claimed state.
    return withRefresh(
      claimedCard(
        {
          ok: true,
          message: `${task.assignee?.displayName ?? "Someone"} grabbed ${task.folderName}`,
          ...(task.assignee?.displayName ? { assignee: task.assignee.displayName } : {})
        },
        content.openUrl
      )
    );
  }

  /* Re-open: rather than silently flipping the existing (now-buried) card back
     to claimable, post a FRESH claimable card as a new top-level thread so the
     channel re-alerts like a new task (Design A). The old card is edited to a
     pointer, and the task's recorded thread is replaced so later claim/complete
     edits target the new card. Falls back to an in-place flip if we can't post
     a new one (no channel reference). */
  async repostReopenedTask(
    taskId: string,
    card: { title: string; detail: string; openUrl?: string; folder: string; creatorAadObjectId?: string }
  ): Promise<void> {
    if (!this.adapter) {
      return;
    }
    const references = await this.targetChannelReferences();
    const creatorUserIds = await this.resolveCreatorUserIds(card.creatorAadObjectId);
    const claimable = adaptiveTaskCard({ title: card.title, detail: card.detail, taskId, ...(card.openUrl ? { openUrl: card.openUrl } : {}), creatorUserIds });
    const activity = MessageFactory.attachment(CardFactory.adaptiveCard(claimable));
    activity.summary = plainSummary(card.title);
    const posts: StoredThread["posts"] = [];
    for (const entry of references) {
      const post = await this.createChannelThread(entry, activity);
      if (post) {
        posts.push(post);
      }
    }
    const storedCard = { title: card.title, detail: card.detail, ...(card.openUrl ? { openUrl: card.openUrl } : {}), creatorUserIds };
    if (posts.length === 0) {
      // No new thread could be posted — fall back to flipping the old card back
      // to claimable so the Claim button at least returns somewhere.
      await this.updateTaskCard(taskId, claimable);
      return;
    }
    // Point the old card(s) at the new post, then make the new post the record.
    await this.updateTaskCard(taskId, reopenedPointerCard(card.folder));
    await this.threads.save({ taskId, posts, card: storedCard });
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
    // Re-attach the user-specific refresh block so the creator's Cancel view
    // keeps tracking state changes (a base-card update also refreshes the
    // user-specific card). No-op when we have no creator MRI.
    const refresh = refreshBlock(taskId, thread.card?.creatorUserIds ?? []);
    const attachment = CardFactory.adaptiveCard(refresh ? { ...card, refresh } : card);
    await Promise.all(
      thread.posts.map((post) =>
        this.proactiveUpdate(post.reference, post.activityId, { type: "message", attachments: [attachment] })
      )
    );
  }

  async init(): Promise<void> {
    await this.store.init();
    await this.threads.init();
    await this.noteCards.init();
    await this.detailCards.init();
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

  /* Lifecycle DM text carries a Markdown link to the task (#174), and Teams
     only renders Markdown when the activity says so. MessageFactory.text
     leaves textFormat unset, which means the Bot Framework default — markdown
     — but the default is a spec detail, not a promise from this code, and a
     message that shows a literal `[folder](https://…)` is worse than no link.
     So say it. This covers every plain-text DM, not just the lifecycle ones —
     the note fallback interpolates a user-typed note body, which can well
     contain `*` or `_`. That text was already being rendered as Markdown under
     the default; naming the format changes nothing about it, it just stops the
     rendering of a link we now depend on from resting on a default. */
  private static markdownText(text: string): Partial<Activity> {
    return { ...MessageFactory.text(text), textFormat: TextFormatTypes.Markdown };
  }

  async sendToDms(text: string): Promise<void> {
    if (!this.adapter) {
      return;
    }

    const references = dedupeDmRefs((await this.store.read()).filter((entry) => entry.scope === "DM"));
    await Promise.all(references.map((entry) => this.proactiveSend(entry.reference, TeamsBotClient.markdownText(text))));
  }

  async sendToDmUsers(userIds: string[], text: string): Promise<void> {
    if (!this.adapter || userIds.length === 0) {
      return;
    }

    const unique = Array.from(new Set(userIds.map((id) => id.trim()).filter((id) => id.length > 0)));
    if (unique.length === 0) {
      return;
    }

    const references = dedupeDmRefs(
      (await this.store.read()).filter((entry) => {
        if (entry.scope !== "DM") {
          return false;
        }
        return unique.some((userId) => entry.userAadObjectId === userId || entry.userId === userId || entry.key === `dm:${userId}`);
      })
    );

    await Promise.all(references.map((entry) => this.proactiveSend(entry.reference, TeamsBotClient.markdownText(text))));
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
      // One reference per channel — without this, a channel with several
      // thread-suffixed captures would get duplicate broadcasts.
      return dedupeChannelRefs(channels);
    }
    // Match on the base channel id so a selection still resolves references
    // captured inside a thread (`…;messageid=…`), then collapse to one.
    const selectedBase = baseChannelId(selectedId);
    const matched = channels.filter((entry) => {
      const id = entry.reference.conversation?.id;
      return id ? baseChannelId(id) === selectedBase : false;
    });
    return dedupeChannelRefs(matched.length > 0 ? matched : channels);
  }

  /* List captured channels for the admin picker, one row per real channel
     (thread suffixes collapsed). Prefers a friendly "Team / Channel" label;
     falls back to the channel name, then the raw id. */
  async listChannels(): Promise<Array<{ id: string; name: string }>> {
    const channels = (await this.store.read()).filter((entry) => entry.scope === "CHANNEL");
    // Among captures of the same channel, prefer the most informative label: a
    // full "Team / Channel" beats a name beats the bare id. (channelData hands
    // out team-only and channel-only labels on different activities.)
    const labelScore = (name: string, id: string): number => (name === id ? 0 : name.includes(" / ") ? 2 : 1);
    const byId = new Map<string, { id: string; name: string }>();
    for (const entry of channels) {
      const rawId = entry.reference.conversation?.id;
      if (!rawId) {
        continue;
      }
      const id = baseChannelId(rawId);
      const name = entry.displayName ?? entry.reference.conversation?.name ?? id;
      const existing = byId.get(id);
      if (!existing || labelScore(name, id) > labelScore(existing.name, id)) {
        byId.set(id, { id, name });
      }
    }
    return [...byId.values()];
  }

  /* Post a brand-new message into a Teams channel as a new thread. A proactive
     continueConversation/sendActivity to the channel root returns
     "NotImplemented" — new top-level channel posts must go through
     createConversation with channelData.channel.id. Returns the created thread's
     reference + root message id so follow-ups can reply/update in place.
     Best-effort: logs and returns null on failure. */
  private async createChannelThread(
    entry: StoredReference,
    activity: Partial<Activity>
  ): Promise<{ reference: Partial<ConversationReference>; activityId: string } | null> {
    const serviceUrl = entry.reference.serviceUrl;
    const channelId = baseChannelId(entry.reference.conversation?.id ?? "");
    if (!this.adapter || !serviceUrl || !channelId) {
      return null;
    }
    try {
      const client = this.adapter.createConnectorClient(serviceUrl);
      const params = {
        isGroup: true,
        channelData: { channel: { id: channelId } },
        activity: activity as Activity
      } as ConversationParameters;
      const res = await client.conversations.createConversation(params);
      const reference: Partial<ConversationReference> = {
        ...entry.reference,
        conversation: { ...(entry.reference.conversation as ConversationAccount), id: res.id }
      };
      return { reference, activityId: res.activityId ?? "" };
    } catch (error) {
      console.error("bot_channel_post_failed", error);
      return null;
    }
  }

  async sendToChannels(title: string, text: string): Promise<void> {
    if (!this.adapter) {
      return;
    }
    const references = await this.targetChannelReferences();
    const activity = MessageFactory.attachment(CardFactory.heroCard(title, text));
    // Without a summary, Teams shows "Card" in the channel list / notifications.
    activity.summary = plainSummary(title);
    for (const entry of references) {
      await this.createChannelThread(entry, activity);
    }
  }

  /* The creator's Teams MRI(s) (29:…) captured from their DM reference, used to
     opt them into a user-specific Cancel view. Empty when they've never messaged
     the bot — the card then stays Claim-for-all (graceful degradation). */
  private async resolveCreatorUserIds(creatorAadObjectId?: string): Promise<string[]> {
    if (!creatorAadObjectId) {
      return [];
    }
    const refs = await this.store.read();
    const ids = refs
      .filter((entry) => entry.scope === "DM" && entry.userAadObjectId === creatorAadObjectId)
      .map((entry) => entry.userId)
      .filter((id): id is string => Boolean(id));
    return Array.from(new Set(ids));
  }

  /* Post a freshly created task as an Adaptive Card with a one-tap Claim
     button, recording each channel thread so later updates can reply/update.
     `creatorAadObjectId` opts the creator into the user-specific Cancel view.

     `assignedTo` is the Handoff-at-creation case (ADR-0002): the task is born
     CLAIMED, so it posts the claimed-card variant — announced, but with no
     Claim button to appear and immediately vanish. The thread is still
     recorded, so completion/cancellation still edit this card in place. */
  /* The pool nag (ADR-0005): a fresh channel post asking the room to pick up a
     task nobody has claimed. It has to be a new post rather than an edit of the
     existing card — an in-place edit notifies nobody, which is the entire point
     of the feature, and the same reasoning repostReopenedTask records.

     Post first, then delete the previous nag, so a failed post never leaves the
     channel with nothing claimable. The original creation card is never deleted:
     it is the record that the task was filed, and it is what the creator sees
     their own request in. So the channel holds at most two cards per unclaimed
     task.

     The stored `card` blob stays the original claimable content, so a refresh on
     either card renders the same view. The nag title is a nudge at post time,
     not a permanent identity for the task. */
  async postPoolNag(
    taskId: string,
    title: string,
    detail: string,
    openUrl?: string,
    creatorAadObjectId?: string
  ): Promise<void> {
    if (!this.adapter) {
      return;
    }
    const references = await this.targetChannelReferences();
    const creatorUserIds = await this.resolveCreatorUserIds(creatorAadObjectId);
    const card = adaptiveTaskCard({ title, detail, taskId, ...(openUrl ? { openUrl } : {}), creatorUserIds });
    const activity = MessageFactory.attachment(CardFactory.adaptiveCard(card));
    activity.summary = plainSummary(title);

    const existing = await this.threads.get(taskId);
    const posted: StoredThread["posts"] = [];
    for (const entry of references) {
      const post = await this.createChannelThread(entry, activity);
      if (post) {
        posted.push({ ...post, kind: "nag" });
      }
    }
    if (posted.length === 0) {
      // Nothing new landed, so leave the previous nag standing rather than
      // clearing the channel of the only claimable card there.
      return;
    }

    const kept = (existing?.posts ?? []).filter((post) => post.kind !== "nag");
    for (const stale of existing?.posts ?? []) {
      if (stale.kind === "nag") {
        await this.proactiveDelete(stale.reference, stale.activityId);
      }
    }
    await this.threads.save({
      taskId,
      posts: [...kept, ...posted],
      ...(existing?.card ? { card: existing.card } : { card: { title, detail, ...(openUrl ? { openUrl } : {}), creatorUserIds } })
    });
  }

  async postTaskCard(
    taskId: string,
    title: string,
    detail: string,
    openUrl?: string,
    summary?: string,
    creatorAadObjectId?: string,
    assignedTo?: string
  ): Promise<void> {
    if (!this.adapter) {
      return;
    }
    const references = await this.targetChannelReferences();
    const creatorUserIds = await this.resolveCreatorUserIds(creatorAadObjectId);
    const card = assignedTo
      ? claimedCard({ ok: true, message: title, assignee: assignedTo }, openUrl, `Assigned to ${assignedTo}`)
      : adaptiveTaskCard({ title, detail, taskId, ...(openUrl ? { openUrl } : {}), creatorUserIds });
    const activity = MessageFactory.attachment(CardFactory.adaptiveCard(card));
    // Short channel-list preview / notification text (otherwise Teams says
    // "Card"); the full headline + folder lives in the card body.
    activity.summary = summary?.trim() || plainSummary(title);
    const posts: StoredThread["posts"] = [];
    for (const entry of references) {
      const post = await this.createChannelThread(entry, activity);
      if (post) {
        posts.push({ ...post, kind: "create" });
      }
    }
    if (posts.length > 0) {
      await this.threads.save({ taskId, posts, card: { title, detail, ...(openUrl ? { openUrl } : {}), creatorUserIds } });
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
    // all channels keeps a thread per channel, so narrow to the selected one
    // (by base id). If none matches, fall back to a fresh (already-filtered)
    // channel post so the update still lands there.
    const selectedId = this.notificationChannelResolver ? await this.notificationChannelResolver() : undefined;
    const selectedBase = selectedId ? baseChannelId(selectedId) : undefined;
    const posts = thread
      ? selectedBase
        ? thread.posts.filter((post) => baseChannelId(post.reference.conversation?.id ?? "") === selectedBase)
        : thread.posts
      : [];
    if (posts.length === 0) {
      await this.sendToChannels(fallbackTitle, text);
      return;
    }

    // post.reference already targets the thread (its conversation id carries the
    // root message id from createConversation), so a plain reply lands in-thread.
    await Promise.all(posts.map((post) => this.proactiveSend(post.reference, MessageFactory.text(text))));
  }
}
