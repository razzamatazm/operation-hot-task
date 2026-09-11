import { JsonFile } from "./json-file.js";

/* Mutable admin-managed settings, persisted to a JSON file (separate from the
   env-var `config`). Currently just the channel group notifications post to;
   add fields here as more admin toggles appear. */
export interface AdminSettings {
  /* `conversation.id` of the channel group notifications go to. Unset → post to
     every channel the bot has been added to (legacy broadcast behaviour). */
  notificationChannelId?: string;
}

/* Built on `JsonFile`, so a read waits behind a save. Before that, a read
   landing mid-save fell into the lenient path below and answered "no channel
   chosen", broadcasting a notification to every channel instead of the one an
   admin picked (#339). Lenient still, as it always was: settings that can't be
   read at all fall back to none rather than failing the notification. */
export class SettingsStore {
  private readonly file: JsonFile<AdminSettings>;

  constructor(filePath: string) {
    this.file = new JsonFile<AdminSettings>(filePath, { empty: () => ({}), lenient: true });
  }

  async init(): Promise<void> {
    await this.file.init();
  }

  read(): Promise<AdminSettings> {
    return this.file.read();
  }

  async getNotificationChannelId(): Promise<string | undefined> {
    return (await this.read()).notificationChannelId;
  }

  /* Pass null/undefined to clear the selection (revert to broadcast-to-all). */
  async setNotificationChannelId(channelId: string | null | undefined): Promise<void> {
    await this.file.update((settings) => {
      if (channelId) {
        settings.notificationChannelId = channelId;
      } else {
        delete settings.notificationChannelId;
      }
      return settings;
    });
  }
}
