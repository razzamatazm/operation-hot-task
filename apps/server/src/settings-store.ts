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

  /* Queued behind any save (#339). A save rewrites the whole file, truncating
     before it fills, and a read landing in that gap used to parse nothing, fall
     into the catch below and answer "no channel chosen" — which broadcasts the
     next notification to every channel instead of the one an admin picked.
     The queue's own read stays off the queue, or a save would wait on itself. */
  async read(): Promise<AdminSettings> {
    return this.enqueue(() => this.readUnqueued());
  }

  private async readUnqueued(): Promise<AdminSettings> {
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
      const settings = await this.readUnqueued();
      if (channelId) {
        settings.notificationChannelId = channelId;
      } else {
        delete settings.notificationChannelId;
      }
      await fs.writeFile(this.filePath, JSON.stringify(settings, null, 2), "utf8");
    });
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.chain.then(operation, operation);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}
