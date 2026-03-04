import { promises as fs } from "node:fs";
import path from "node:path";
import { CreateTaskInput, LoanTask, TaskType, UrgencyLevel, UserIdentity } from "@loan-tasks/shared";
import { ActivityHandler, BotFrameworkAdapter, CardFactory, ConversationReference, MessageFactory, TurnContext } from "botbuilder";
import { Express } from "express";

interface StoredReference {
  key: string;
  reference: Partial<ConversationReference>;
  scope: "DM" | "CHANNEL";
  userId?: string;
  userAadObjectId?: string;
}

type BotTaskCreateInput = Pick<CreateTaskInput, "loanName" | "taskType" | "urgency" | "notes" | "humperdinkLink" | "serverLocation">;
type BotTaskCreator = (input: BotTaskCreateInput, user: UserIdentity) => Promise<LoanTask>;

type QuickAddStep =
  | "LOAN_NAME"
  | "TASK_TYPE"
  | "URGENCY"
  | "NOTES"
  | "HUMPERDINK"
  | "SERVER_LOCATION"
  | "LOAN_NAME_REPLACE_CONFIRM"
  | "REVIEW"
  | "CONFIRM_CREATE";
type EditableField = "LOAN_NAME" | "TASK_TYPE" | "URGENCY" | "NOTES" | "HUMPERDINK" | "SERVER_LOCATION";

interface QuickAddDraft {
  step: QuickAddStep;
  history: QuickAddStep[];
  loanName?: string;
  taskType?: TaskType;
  urgency?: UrgencyLevel;
  notes?: string;
  humperdinkLink?: string;
  serverLocation?: string;
  editField?: EditableField;
}

const TASK_TYPE_CHOICES: ReadonlyArray<{ label: string; value: TaskType }> = [
  { label: "LOI Check", value: "LOI" },
  { label: "Value Check", value: "VALUE" },
  { label: "Loan Docs", value: "LOAN_DOCS" },
  { label: "Fraud Check", value: "FRAUD" }
];

const URGENCY_CHOICES: ReadonlyArray<{ label: string; value: UrgencyLevel }> = [
  { label: "Anytime", value: "GREEN" },
  { label: "End of Day", value: "YELLOW" },
  { label: "Within 1 Hour", value: "ORANGE" },
  { label: "Urgent Now", value: "RED" }
];
const REVIEW_ACTIONS = [
  "Create task",
  "Edit Loan Name",
  "Edit Task Type",
  "Edit Urgency",
  "Edit Notes",
  "Edit Humperdink Link",
  "Edit Server file/path",
  "Cancel"
] as const;
const CONFIRM_CREATE_ACTIONS = ["Confirm create", "Back to review", "Cancel"] as const;

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
  if (normalized === "value") {
    return "VALUE";
  }
  if (normalized === "fraud") {
    return "FRAUD";
  }
  if (normalized === "loan docs" || normalized === "loan_docs") {
    return "LOAN_DOCS";
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

const isSkip = (text: string): boolean => {
  const normalized = normalizeText(text);
  return normalized === "skip" || normalized === "none" || normalized === "n/a";
};

const isNoAdditionalNotes = (text: string): boolean => normalizeText(text) === "no additional notes";
const isValidUrl = (text: string): boolean => {
  try {
    const parsed = new URL(text);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};
const formatField = (value: string | undefined): string => (value && value.trim().length > 0 ? value : "Not provided");
const urgencyLabel = (urgency: UrgencyLevel): string => URGENCY_CHOICES.find((choice) => choice.value === urgency)?.label ?? urgency;
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
  step === "LOAN_NAME" || step === "TASK_TYPE" || step === "URGENCY" || step === "NOTES" || step === "HUMPERDINK" || step === "SERVER_LOCATION";

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

class LoanTasksBot extends ActivityHandler {
  private readonly drafts = new Map<string, QuickAddDraft>();

  constructor(
    private readonly onReference: (reference: Partial<ConversationReference>, scope: "DM" | "CHANNEL") => Promise<void>,
    private readonly onQuickAddTask: (input: BotTaskCreateInput, user: UserIdentity) => Promise<LoanTask>
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
      this.drafts.set(key, { step: "LOAN_NAME", history: [] });
      await context.sendActivity("New task started. Enter Loan Name:");
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

    if (draft.step === "LOAN_NAME") {
      const loanName = text.trim();
      if (!loanName) {
        await context.sendActivity("Loan Name cannot be blank. Enter Loan Name:");
        return;
      }

      const nextDraft = this.updateDraft(draft, { loanName, step: "TASK_TYPE" });
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

      const nextDraft = this.updateDraft(draft, { taskType: parsed, step: "URGENCY" });
      this.drafts.set(key, nextDraft);
      if (nextDraft.step === "REVIEW") {
        await this.sendReview(context, nextDraft);
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

      const nextDraft = this.updateDraft(draft, { urgency: parsed, step: "NOTES" });
      this.drafts.set(key, nextDraft);
      if (nextDraft.step === "REVIEW") {
        await this.sendReview(context, nextDraft);
        return;
      }
      await context.sendActivity(
        MessageFactory.suggestedActions(["No additional notes"], "Notes (type your notes, or choose No additional notes):")
      );
      return;
    }

    if (draft.step === "NOTES") {
      const noteText = text.trim();
      const notes = noteText.length > 0 && !isNoAdditionalNotes(noteText) ? noteText : "No additional notes";
      const nextDraft = this.updateDraft(draft, { notes, step: "HUMPERDINK" });
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
      if (!isSkip(trimmed) && trimmed.length > 0 && !isValidUrl(trimmed)) {
        await context.sendActivity(MessageFactory.suggestedActions(["Skip"], "Please enter a valid URL (http/https), or choose Skip:"));
        return;
      }

      const humperdinkLink = isSkip(trimmed) || trimmed.length === 0 ? undefined : trimmed;
      const nextDraft = this.updateDraft(draft, { step: "SERVER_LOCATION" });
      if (humperdinkLink) {
        nextDraft.humperdinkLink = humperdinkLink;
      } else {
        delete nextDraft.humperdinkLink;
      }
      this.drafts.set(key, nextDraft);
      if (nextDraft.step === "REVIEW") {
        await this.sendReview(context, nextDraft);
        return;
      }
      await context.sendActivity(MessageFactory.suggestedActions(["Skip"], "Server file name/path (or choose Skip):"));
      return;
    }

    if (draft.step === "SERVER_LOCATION") {
      const serverLocation = isSkip(text) || text.trim().length === 0 ? undefined : text.trim();
      if (serverLocation) {
        this.drafts.set(key, this.updateDraft(draft, { serverLocation, step: "LOAN_NAME_REPLACE_CONFIRM" }));
        await context.sendActivity(
          MessageFactory.suggestedActions(
            ["Keep current loan name", "Replace loan name"],
            `Replace Loan Name "${draft.loanName ?? "Untitled Task"}" with "${serverLocation}"?`
          )
        );
        return;
      }

      const nextDraft = this.updateDraft(draft, { step: "REVIEW" });
      delete nextDraft.serverLocation;
      this.drafts.set(key, nextDraft);
      await this.sendReview(context, nextDraft);
      return;
    }

    if (draft.step === "LOAN_NAME_REPLACE_CONFIRM") {
      const normalized = normalizeText(text);
      if (normalized === "keep current loan name") {
        this.drafts.set(key, this.updateDraft(draft, { step: "REVIEW" }));
        await this.sendReview(context, this.drafts.get(key)!);
        return;
      }

      if (normalized === "replace loan name") {
        const nextLoanName = draft.serverLocation ?? draft.loanName;
        if (!nextLoanName) {
          this.drafts.delete(key);
          await context.sendActivity("Quick add state was incomplete. Please run `/bot new` again.");
          return;
        }
        const nextDraft = this.updateDraft(draft, { loanName: nextLoanName, step: "REVIEW" });
        this.drafts.set(key, nextDraft);
        await this.sendReview(context, nextDraft);
        return;
      }

      await context.sendActivity(
        MessageFactory.suggestedActions(["Keep current loan name", "Replace loan name"], "Choose one option:")
      );
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

      if (action === "Edit Loan Name") {
        this.drafts.set(key, this.updateDraft(draft, { step: "LOAN_NAME", editField: "LOAN_NAME" }));
        await context.sendActivity("Enter Loan Name:");
        return;
      }

      if (action === "Edit Task Type") {
        this.drafts.set(key, this.updateDraft(draft, { step: "TASK_TYPE", editField: "TASK_TYPE" }));
        await context.sendActivity(MessageFactory.suggestedActions(TASK_TYPE_CHOICES.map((choice) => choice.label), "Choose task type:"));
        return;
      }

      if (action === "Edit Urgency") {
        this.drafts.set(key, this.updateDraft(draft, { step: "URGENCY", editField: "URGENCY" }));
        await context.sendActivity(MessageFactory.suggestedActions(URGENCY_CHOICES.map((choice) => choice.label), "Choose urgency:"));
        return;
      }

      if (action === "Edit Notes") {
        this.drafts.set(key, this.updateDraft(draft, { step: "NOTES", editField: "NOTES" }));
        await context.sendActivity(MessageFactory.suggestedActions(["No additional notes"], "Notes (type your notes, or choose No additional notes):"));
        return;
      }

      if (action === "Edit Humperdink Link") {
        this.drafts.set(key, this.updateDraft(draft, { step: "HUMPERDINK", editField: "HUMPERDINK" }));
        await context.sendActivity(MessageFactory.suggestedActions(["Skip"], "Humperdink Link (paste URL or choose Skip):"));
        return;
      }

      if (action === "Edit Server file/path") {
        this.drafts.set(key, this.updateDraft(draft, { step: "SERVER_LOCATION", editField: "SERVER_LOCATION" }));
        await context.sendActivity(MessageFactory.suggestedActions(["Skip"], "Server file name/path (or choose Skip):"));
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
      await context.sendActivity("You are already at the first step. Enter Loan Name:");
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
    if (draft.step === "LOAN_NAME") {
      await context.sendActivity("Enter Loan Name:");
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
    if (draft.step === "NOTES") {
      await context.sendActivity(MessageFactory.suggestedActions(["No additional notes"], "Notes (type your notes, or choose No additional notes):"));
      return;
    }
    if (draft.step === "HUMPERDINK") {
      await context.sendActivity(MessageFactory.suggestedActions(["Skip"], "Humperdink Link (paste URL or choose Skip):"));
      return;
    }
    if (draft.step === "SERVER_LOCATION") {
      await context.sendActivity(MessageFactory.suggestedActions(["Skip"], "Server file name/path (or choose Skip):"));
      return;
    }
    if (draft.step === "LOAN_NAME_REPLACE_CONFIRM") {
      await context.sendActivity(
        MessageFactory.suggestedActions(
          ["Keep current loan name", "Replace loan name"],
          `Replace Loan Name "${draft.loanName ?? "Untitled Task"}" with "${draft.serverLocation ?? "server file/path"}"?`
        )
      );
      return;
    }
    if (draft.step === "REVIEW") {
      await this.sendReview(context, draft);
      return;
    }
    await this.sendCreateConfirmation(context, draft);
  }

  private async sendReview(context: TurnContext, draft: QuickAddDraft): Promise<void> {
    await context.sendActivity(
      MessageFactory.suggestedActions(
        [...REVIEW_ACTIONS],
        `Review task details:\nLoan Name: ${formatField(draft.loanName)}\nTask Type: ${draft.taskType ?? "Not provided"}\nUrgency: ${
          draft.urgency ? urgencyLabel(draft.urgency) : "Not provided"
        }\nNotes: ${formatField(draft.notes)}\nHumperdink Link: ${formatField(draft.humperdinkLink)}\nServer file/path: ${formatField(
          draft.serverLocation
        )}\nChoose an action:`
      )
    );
  }

  private async sendCreateConfirmation(context: TurnContext, draft: QuickAddDraft): Promise<void> {
    await context.sendActivity(
      MessageFactory.suggestedActions(
        [...CONFIRM_CREATE_ACTIONS],
        `Confirm task creation:\nLoan Name: ${formatField(draft.loanName)}\nTask Type: ${draft.taskType ?? "Not provided"}\nUrgency: ${
          draft.urgency ? urgencyLabel(draft.urgency) : "Not provided"
        }\nType "Back" to revisit earlier steps, or choose an action:`
      )
    );
  }

  private async completeQuickAdd(context: TurnContext, key: string): Promise<void> {
    const draft = this.drafts.get(key);
    if (!draft?.loanName || !draft.taskType || !draft.urgency || !draft.notes) {
      this.drafts.delete(key);
      await context.sendActivity("Quick add state was incomplete. Please run `/bot new` again.");
      return;
    }

    const user = toBotUserIdentity(context);
    const payload: BotTaskCreateInput = {
      loanName: draft.loanName,
      taskType: draft.taskType,
      urgency: draft.urgency,
      notes: draft.notes,
      ...(draft.humperdinkLink ? { humperdinkLink: draft.humperdinkLink } : {}),
      ...(draft.serverLocation ? { serverLocation: draft.serverLocation } : {})
    };

    try {
      const task = await this.onQuickAddTask(payload, user);
      this.drafts.delete(key);
      await context.sendActivity(
        `Task created: ${task.loanName}\nType: ${task.taskType}\nUrgency: ${urgencyLabel(task.urgency)}\nStatus: ${task.status}`
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
    await this.onReference(reference, scope);
  }
}

export class TeamsBotClient {
  private readonly adapter?: BotFrameworkAdapter;
  private readonly bot?: LoanTasksBot;
  private readonly store: ReferenceStore;
  private taskCreator?: BotTaskCreator;

  constructor(
    private readonly appId: string | undefined,
    private readonly appPassword: string | undefined,
    private readonly appTenantId: string | undefined,
    dataFile: string
  ) {
    this.store = new ReferenceStore(dataFile);

    if (appId && appPassword) {
      this.adapter = new BotFrameworkAdapter({
        appId,
        appPassword,
        ...(this.appTenantId ? { channelAuthTenant: this.appTenantId } : {})
      });
      this.bot = new LoanTasksBot(
        async (reference, scope) => {
          const dmUserId = scope === "DM" ? reference.user?.id : undefined;
          const dmAadObjectId = scope === "DM" ? (reference.user as { aadObjectId?: string } | undefined)?.aadObjectId : undefined;
          const key = scope === "CHANNEL" ? `channel:${reference.conversation?.id ?? "unknown"}` : `dm:${dmAadObjectId ?? dmUserId ?? "unknown"}`;
          await this.store.save({ key, reference, scope, ...(dmUserId ? { userId: dmUserId } : {}), ...(dmAadObjectId ? { userAadObjectId: dmAadObjectId } : {}) });
        },
        async (input, user) => {
          if (!this.taskCreator) {
            throw new Error("Quick add is not configured on server");
          }
          return this.taskCreator(input, user);
        }
      );
    }
  }

  setTaskCreator(taskCreator: BotTaskCreator): void {
    this.taskCreator = taskCreator;
  }

  async init(): Promise<void> {
    await this.store.init();
  }

  isEnabled(): boolean {
    return Boolean(this.adapter && this.bot);
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

  async sendToChannels(title: string, text: string): Promise<void> {
    if (!this.adapter) {
      return;
    }

    const references = (await this.store.read()).filter((entry) => entry.scope === "CHANNEL");
    const card = CardFactory.heroCard(title, text);

    await Promise.all(
      references.map((entry) =>
        this.adapter!.continueConversationAsync(this.appId!, entry.reference, async (context) => {
          await context.sendActivity({ attachments: [card] });
        })
      )
    );
  }
}
