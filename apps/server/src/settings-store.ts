import { promises as fs } from "node:fs";
import path from "node:path";

/* Mutable admin-managed settings, persisted to a JSON file (separate from the
   env-var `config`). Currently just the channel group notifications post to;
   add fields here as more admin toggles appear. */
export interface AdminSettings {
  /* `conversation.id` of the channel group notifications go to. Unset → post to
     every channel the bot has been added to (legacy broadcast behaviour). */
  notificationChannelId?: string;
}

export class SettingsStore {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, "{}", "utf8");
    }
  }

  async read(): Promise<AdminSettings> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return JSON.parse(raw) as AdminSettings;
    } catch {
      return {};
    }
  }

  async getNotificationChannelId(): Promise<string | undefined> {
    return (await this.read()).notificationChannelId;
  }

  /* Pass null/undefined to clear the selection (revert to broadcast-to-all). */
  async setNotificationChannelId(channelId: string | null | undefined): Promise<void> {
    await this.enqueue(async () => {
      const settings = await this.read();
      if (channelId) {
        settings.notificationChannelId = channelId;
      } else {
        delete settings.notificationChannelId;
      }
      await fs.writeFile(this.filePath, JSON.stringify(settings, null, 2), "utf8");
    });
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(operation, operation);
    return this.chain;
  }
}
