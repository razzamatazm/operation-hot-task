import { NotificationEvent, URGENCY_TIMEFRAMES, formatNewTaskHeadline } from "@loan-tasks/shared";
import { ActivityFeedClient } from "./activity-feed.js";
import { config } from "./config.js";
import { TeamsBotClient } from "./bot.js";

export interface NotificationProvider {
  notify(event: NotificationEvent): Promise<void>;
}

/* Teams deep link to the Hot Task tab, focused on a specific task via
   subEntityId (teams-js surfaces it as page.subPageId, which the web app reads
   to expand + scroll to the card). Requires TEAMS_APP_ID; without it we can't
   build a valid entity link, so the card simply omits the button. The
   `loan-tasks-home` entity id matches the static tab in the Teams manifest. */
const teamsTaskDeepLink = (taskId: string): string | undefined => {
  if (!config.teamsAppId) {
    return undefined;
  }
  const context = encodeURIComponent(JSON.stringify({ subEntityId: taskId }));
  return `https://teams.microsoft.com/l/entity/${config.teamsAppId}/loan-tasks-home?context=${context}`;
};

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
    // Type tag only — urgency now rides the detail block as a time-frame.
    const prefix = `[${event.task.taskType}]`;
    const howBad = event.task.points > 0 ? "💩".repeat(event.task.points) : "—";
    // Folder lives in the card title (as a Humperdink link when present), so the
    // detail block carries only How Bad + Urgency.
    const detail = `How Bad: ${howBad}\nUrgency: ${URGENCY_TIMEFRAMES[event.task.urgency]}`;

    if (event.target === "CHANNEL") {
      // Created tasks post as an Adaptive Card carrying a one-tap Claim button
      // plus an "Open in Hot Task" deep link; the returned message id is
      // recorded so later updates can thread under it. The file name in the
      // headline links to Humperdink when the task has a link.
      const fileName = event.task.humperdinkLink
        ? `[${event.task.folderName}](${event.task.humperdinkLink})`
        : event.task.folderName;
      const cardTitle = `${prefix} ${formatNewTaskHeadline(event.actor.displayName, event.task.taskType)}: ${fileName}`;
      await this.botClient.postTaskCard(event.task.id, cardTitle, detail, teamsTaskDeepLink(event.task.id));
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
