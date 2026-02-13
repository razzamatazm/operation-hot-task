import { promises as fs } from "node:fs";
import path from "node:path";
import { ActivityHandler, BotFrameworkAdapter, CardFactory, ConversationReference, MessageFactory, TurnContext } from "botbuilder";
import { Express } from "express";

interface StoredReference {
  key: string;
  reference: Partial<ConversationReference>;
  scope: "DM" | "CHANNEL";
}

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
  constructor(private readonly onReference: (reference: Partial<ConversationReference>, scope: "DM" | "CHANNEL") => Promise<void>) {
    super();

    this.onConversationUpdate(async (context, next) => {
      await this.capture(context);
      await next();
    });

    this.onMessage(async (context, next) => {
      await this.capture(context);
      await context.sendActivity("Loan Tasks bot is connected.");
      await next();
    });
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

  constructor(private readonly appId: string | undefined, private readonly appPassword: string | undefined, dataFile: string) {
    this.store = new ReferenceStore(dataFile);

    if (appId && appPassword) {
      this.adapter = new BotFrameworkAdapter({ appId, appPassword });
      this.bot = new LoanTasksBot(async (reference, scope) => {
        const key = scope === "CHANNEL" ? `channel:${reference.conversation?.id ?? "unknown"}` : `dm:${reference.user?.id ?? "unknown"}`;
        await this.store.save({ key, reference, scope });
      });
    }
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
