import { promises as fs } from "node:fs";
import path from "node:path";
import { CreateTaskInput, LoanTask, TaskType, UrgencyLevel, UserIdentity } from "@loan-tasks/shared";
import { ActivityHandler, BotFrameworkAdapter, CardFactory, ConversationReference, MessageFactory, TurnContext } from "botbuilder";
import { Express } from "express";

interface StoredReference {
  key: string;
  reference: Partial<ConversationReference>;
  scope: "DM" | "CHANNEL";
}

type BotTaskCreateInput = Pick<CreateTaskInput, "loanName" | "taskType" | "urgency" | "notes" | "humperdinkLink" | "serverLocation">;
type BotTaskCreator = (input: BotTaskCreateInput, user: UserIdentity) => Promise<LoanTask>;

type QuickAddStep = "TASK_TYPE" | "URGENCY" | "NOTES" | "HUMPERDINK" | "SERVER_LOCATION" | "LOAN_NAME_CONFIRM" | "LOAN_NAME_CUSTOM";

interface QuickAddDraft {
  step: QuickAddStep;
  taskType?: TaskType;
  urgency?: UrgencyLevel;
  notes?: string;
  humperdinkLink?: string;
  serverLocation?: string;
}

const TASK_TYPE_CHOICES: ReadonlyArray<{ label: string; value: TaskType }> = [
  { label: "LOI Check", value: "LOI" },
  { label: "Value Check", value: "VALUE" },
  { label: "Loan Docs", value: "LOAN_DOCS" },
  { label: "Fraud Check", value: "FRAUD" }
];

const URGENCY_CHOICES: ReadonlyArray<{ label: string; value: UrgencyLevel }> = [
  { label: "Green - Anytime", value: "GREEN" },
  { label: "Yellow - End of Day", value: "YELLOW" },
  { label: "Orange - Within 1 Hour", value: "ORANGE" },
  { label: "Red - Urgent Now", value: "RED" }
];

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
  return undefined;
};

const isSkip = (text: string): boolean => {
  const normalized = normalizeText(text);
  return normalized === "skip" || normalized === "none" || normalized === "n/a";
};

const isNoAdditionalNotes = (text: string): boolean => normalizeText(text) === "no additional notes";

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
      this.drafts.set(key, { step: "TASK_TYPE" });
      await context.sendActivity(
        MessageFactory.suggestedActions(
          TASK_TYPE_CHOICES.map((choice) => choice.label),
          "New task started. Choose task type:"
        )
      );
      return;
    }

    const draft = this.drafts.get(key);
    if (!draft) {
      await context.sendActivity("Loan Tasks bot is connected. Send `/bot new` to add a task, or `help`.");
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

      this.drafts.set(key, { ...draft, taskType: parsed, step: "URGENCY" });
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

      this.drafts.set(key, { ...draft, urgency: parsed, step: "NOTES" });
      await context.sendActivity(
        MessageFactory.suggestedActions(["No additional notes"], "Notes (type your notes, or choose No additional notes):")
      );
      return;
    }

    if (draft.step === "NOTES") {
      const noteText = text.trim();
      const notes = noteText.length > 0 && !isNoAdditionalNotes(noteText) ? noteText : "No additional notes";
      this.drafts.set(key, { ...draft, notes, step: "HUMPERDINK" });
      await context.sendActivity(MessageFactory.suggestedActions(["Skip"], "Humperdink Link (paste URL or choose Skip):"));
      return;
    }

    if (draft.step === "HUMPERDINK") {
      const humperdinkLink = isSkip(text) || text.trim().length === 0 ? undefined : text.trim();
      this.drafts.set(key, {
        ...draft,
        ...(humperdinkLink ? { humperdinkLink } : {}),
        step: "SERVER_LOCATION"
      });
      await context.sendActivity(MessageFactory.suggestedActions(["Skip"], "Server file name/path (or choose Skip):"));
      return;
    }

    if (draft.step === "SERVER_LOCATION") {
      const serverLocation = isSkip(text) || text.trim().length === 0 ? undefined : text.trim();

      if (!serverLocation) {
        this.drafts.set(key, { ...draft, step: "LOAN_NAME_CUSTOM" });
        await context.sendActivity("Loan Name is required when server file name is skipped. Enter Loan Name:");
        return;
      }

      this.drafts.set(key, { ...draft, serverLocation, step: "LOAN_NAME_CONFIRM" });
      await context.sendActivity(
        MessageFactory.suggestedActions(
          ["Use server file name", "Set different loan name"],
          `Use "${serverLocation}" as Loan Name?`
        )
      );
      return;
    }

    if (draft.step === "LOAN_NAME_CONFIRM") {
      const normalized = normalizeText(text);
      if (normalized === "use server file name") {
        await this.completeQuickAdd(context, key, draft.serverLocation ?? "Untitled Task");
        return;
      }

      if (normalized === "set different loan name") {
        this.drafts.set(key, { ...draft, step: "LOAN_NAME_CUSTOM" });
        await context.sendActivity("Enter Loan Name:");
        return;
      }

      await context.sendActivity(MessageFactory.suggestedActions(["Use server file name", "Set different loan name"], "Choose one option:"));
      return;
    }

    if (draft.step === "LOAN_NAME_CUSTOM") {
      const loanName = text.trim();
      if (!loanName) {
        await context.sendActivity("Loan Name cannot be blank. Enter Loan Name:");
        return;
      }

      await this.completeQuickAdd(context, key, loanName);
      return;
    }
  }

  private async completeQuickAdd(context: TurnContext, key: string, loanName: string): Promise<void> {
    const draft = this.drafts.get(key);
    if (!draft?.taskType || !draft.urgency || !draft.notes) {
      this.drafts.delete(key);
      await context.sendActivity("Quick add state was incomplete. Please run `/bot new` again.");
      return;
    }

    const user = toBotUserIdentity(context);
    const payload: BotTaskCreateInput = {
      loanName,
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
        `Task created: ${task.loanName}\nType: ${task.taskType}\nUrgency: ${task.urgency}\nStatus: ${task.status}`
      );
    } catch (error) {
      this.drafts.delete(key);
      await context.sendActivity(`Could not create task: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  private async sendHelp(context: TurnContext): Promise<void> {
    await context.sendActivity(
      "Commands:\n- `/bot new` start quick add\n- `/bot cancel` cancel current quick add\n- `help` show this message"
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

  constructor(private readonly appId: string | undefined, private readonly appPassword: string | undefined, dataFile: string) {
    this.store = new ReferenceStore(dataFile);

    if (appId && appPassword) {
      this.adapter = new BotFrameworkAdapter({ appId, appPassword });
      this.bot = new LoanTasksBot(
        async (reference, scope) => {
          const key = scope === "CHANNEL" ? `channel:${reference.conversation?.id ?? "unknown"}` : `dm:${reference.user?.id ?? "unknown"}`;
          await this.store.save({ key, reference, scope });
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

      await this.adapter.processActivity(req, res, async (turnContext) => {
        await this.bot?.run(turnContext);
      });
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
