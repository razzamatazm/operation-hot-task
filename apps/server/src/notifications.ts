import { NotificationEvent, URGENCY_TIMEFRAMES, botPrimaryAdvance, formatNewTaskHeadline, formatWallDate } from "@loan-tasks/shared";
import { ActivityFeedClient } from "./activity-feed.js";
import { config } from "./config.js";
import { TeamsBotClient } from "./bot.js";
import { SettingsStore } from "./settings-store.js";

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
    private readonly activityFeedClient: ActivityFeedClient,
    private readonly settings: SettingsStore
  ) {}

  /* The legacy webhook posts to one fixed channel URL it can't retarget, so
     once an admin picks a specific notification channel we suppress it — the
     bot send already covers the chosen channel. With no selection (broadcast),
     the webhook still fires for backward compatibility. */
  private async webhookIfBroadcasting(payload: { title: string; text: string }): Promise<void> {
    if (await this.settings.getNotificationChannelId()) {
      return;
    }
    await sendWebhook(payload);
  }

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
      // recorded so later updates can thread under it.
      const isOoo = event.task.taskType === "OOO";
      let cardTitle: string;
      let cardDetail: string;
      if (isOoo) {
        // OOO carries its own coverage sentence (with the absence window); the
        // detail shows the vacation description rather than poops/urgency.
        cardTitle = event.message;
        cardDetail = event.task.folderName ? `Details: ${event.task.folderName}` : "Coverage needed";
      } else {
        // The file name in the headline links to Humperdink when present.
        const fileName = event.task.humperdinkLink
          ? `[${event.task.folderName}](${event.task.humperdinkLink})`
          : event.task.folderName;
        cardTitle = `${prefix} ${formatNewTaskHeadline(event.actor.displayName, event.task.taskType)}: ${fileName}`;
        cardDetail = detail;
      }
      await this.botClient.postTaskCard(event.task.id, cardTitle, cardDetail, teamsTaskDeepLink(event.task.id));
      await this.webhookIfBroadcasting({
        title: isOoo ? event.message : `${prefix} ${event.message}`,
        text: cardDetail
      });
      return;
    }

    if (event.target === "CHANNEL_THREAD") {
      // Follow-ups (claim / unclaim) reply inside the task's existing thread
      // instead of broadcasting a fresh card to the whole channel.
      await this.botClient.replyInThread(event.task.id, event.message, `${prefix} ${event.message}`);
      await this.webhookIfBroadcasting({
        title: `${prefix} ${event.message}`,
        text: detail
      });
      return;
    }

    if ((event.target === "DM" || event.target === "DM_NOTE" || event.target === "DM_CLAIM") && !config.enableDmNotifications) {
      return;
    }

    if (event.target === "DM_CLAIM") {
      // Full-details card to whoever claimed the task, with an advance/complete
      // button and a deep link. Falls back to a plain DM if no recipient.
      const howBad = event.task.points > 0 ? "💩".repeat(event.task.points) : "—";
      const lines =
        event.task.taskType === "OOO"
          ? [
              `Type: Out of Office`,
              `Out: ${event.task.startDate ? formatWallDate(event.task.startDate) : "—"} → ${event.task.returnDate ? formatWallDate(event.task.returnDate) : formatWallDate(event.task.dueAt)}`,
              `Details: ${event.task.folderName}`
            ]
          : [
              `Type: ${event.task.taskType}`,
              `How Bad: ${howBad}`,
              `Urgency: ${URGENCY_TIMEFRAMES[event.task.urgency]}`,
              `Due: ${formatWallDate(event.task.dueAt)}`,
              ...(event.task.notes?.trim() ? [`Notes: ${event.task.notes.trim()}`] : []),
              ...(event.task.humperdinkLink ? [`Humperdink: [link](${event.task.humperdinkLink})`] : [])
            ];
      const advance = botPrimaryAdvance(event.task);
      if (Array.isArray(event.recipientUserIds) && event.recipientUserIds.length > 0) {
        await this.botClient.sendDetailCardToUsers(event.recipientUserIds, {
          taskId: event.task.id,
          title: `You claimed ${event.task.folderName}`,
          detail: lines.join("\n"),
          ...(teamsTaskDeepLink(event.task.id) ? { openUrl: teamsTaskDeepLink(event.task.id) as string } : {}),
          ...(advance ? { advance } : {})
        });
        return;
      }
      await this.botClient.sendToDms(`${prefix} You claimed ${event.task.folderName}`);
      return;
    }

    if (event.target === "DM_NOTE") {
      // Interactive note card: shows the note text with an inline reply box that
      // posts straight back as another review note. `event.message` is the raw
      // note text. Falls back to a plain DM if there are no targeted recipients.
      if (Array.isArray(event.recipientUserIds) && event.recipientUserIds.length > 0) {
        // Last few notes for context, oldest → newest. Falls back to the raw
        // message if the task somehow carries no stored notes.
        const thread = (event.task.reviewNotes ?? [])
          .slice(-5)
          .map((entry) => ({ author: entry.by.displayName, text: entry.text }));
        const advance = botPrimaryAdvance(event.task);
        await this.botClient.sendNoteCardToUsers(event.recipientUserIds, {
          taskId: event.task.id,
          folder: event.task.folderName,
          thread: thread.length > 0 ? thread : [{ author: event.actor.displayName, text: event.message }],
          ...(advance ? { advance } : {})
        });
        return;
      }
      await this.botClient.sendToDms(`${prefix} ${event.actor.displayName} left a note: ${event.message} (Folder: ${event.task.folderName})`);
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
