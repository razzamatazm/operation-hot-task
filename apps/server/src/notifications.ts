import { NotificationEvent } from "@loan-tasks/shared";
import { ActivityFeedClient } from "./activity-feed.js";
import { config } from "./config.js";
import { TeamsBotClient } from "./bot.js";

export interface NotificationProvider {
  notify(event: NotificationEvent): Promise<void>;
}

const sendWebhook = async (payload: { title: string; text: string }): Promise<void> => {
  if (!config.webhookUrl) {
    return;
  }

  await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
};

export class TeamsNotificationProvider implements NotificationProvider {
  constructor(
    private readonly botClient: TeamsBotClient,
    private readonly activityFeedClient: ActivityFeedClient
  ) {}

  async notify(event: NotificationEvent): Promise<void> {
    const prefix = `[${event.task.taskType}] [${event.task.urgency}]`;
    const detail = `Folder: ${event.task.folderName}\nStatus: ${event.task.status}\nUrgency: ${event.task.urgency}`;

    if (event.target === "CHANNEL") {
      // Created tasks post as an Adaptive Card carrying a one-tap Claim button;
      // the returned message id is recorded so later updates can thread under it.
      await this.botClient.postTaskCard(event.task.id, `${prefix} ${event.message}`, detail);
      await sendWebhook({
        title: `${prefix} ${event.message}`,
        text: detail
      });
      return;
    }

    if (event.target === "CHANNEL_THREAD") {
      // Follow-ups (claim / unclaim) reply inside the task's existing thread
      // instead of broadcasting a fresh card to the whole channel.
      await this.botClient.replyInThread(event.task.id, event.message, `${prefix} ${event.message}`);
      await sendWebhook({
        title: `${prefix} ${event.message}`,
        text: detail
      });
      return;
    }

    if (event.target === "DM" && !config.enableDmNotifications) {
      return;
    }

    if (event.target === "DM") {
      if (Array.isArray(event.recipientUserIds) && event.recipientUserIds.length > 0) {
        await this.botClient.sendToDmUsers(event.recipientUserIds, `${prefix} ${event.message} (Folder: ${event.task.folderName})`);
        return;
      }
      await this.botClient.sendToDms(`${prefix} ${event.message} (Folder: ${event.task.folderName})`);
      return;
    }

    if (event.target === "ACTIVITY_FEED") {
      if (!Array.isArray(event.recipientUserIds) || event.recipientUserIds.length === 0) {
        return;
      }
      if (!this.activityFeedClient.isEnabled()) {
        return;
      }
      await this.activityFeedClient.sendToUsers(event.recipientUserIds, event.message, event.task.id);
      return;
    }

    console.log(`[notify:${event.target}] ${prefix} ${event.message}`);
  }
}
