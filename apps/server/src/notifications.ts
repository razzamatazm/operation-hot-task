import { NotificationEvent, TASK_TYPE_LABELS, URGENCY_TIMEFRAMES, botPrimaryAdvance, formatNewTaskHeadline, formatOooHeadline, formatWallDate } from "@loan-tasks/shared";
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

  /* Build the claimable channel card (title + detail + list preview) from a
     task. Uses the creator's name for the headline so it reads the same on a
     re-open as it did at creation, regardless of who triggered the change. */
  private buildChannelCard(task: NotificationEvent["task"]): { title: string; detail: string; summary: string; openUrl?: string } {
    const openUrl = teamsTaskDeepLink(task.id);
    const summary = formatNewTaskHeadline(task.createdBy.displayName, task.taskType);
    if (task.taskType === "OOO") {
      return {
        title: formatOooHeadline(task.createdBy.displayName, task.startDate ?? task.dueAt, task.returnDate ?? task.dueAt),
        detail: task.folderName ? `Details: ${task.folderName}` : "Coverage needed",
        summary,
        ...(openUrl ? { openUrl } : {})
      };
    }
    const howBad = task.points > 0 ? "💩".repeat(task.points) : "—";
    // The file name in the headline links to Humperdink when present.
    const fileName = task.humperdinkLink ? `[${task.folderName}](${task.humperdinkLink})` : task.folderName;
    return {
      title: `${summary}: ${fileName}`,
      detail: `How Bad: ${howBad}\nUrgency: ${URGENCY_TIMEFRAMES[task.urgency]}`,
      summary,
      ...(openUrl ? { openUrl } : {})
    };
  }

  async notify(event: NotificationEvent): Promise<void> {
    // Friendly type label ("LOI Check") instead of a raw "[LOI]" tag.
    const typeLabel = TASK_TYPE_LABELS[event.task.taskType];
    const howBad = event.task.points > 0 ? "💩".repeat(event.task.points) : "—";
    const detail = `How Bad: ${howBad}\nUrgency: ${URGENCY_TIMEFRAMES[event.task.urgency]}`;

    if (event.target === "CHANNEL") {
      // Created tasks post as an Adaptive Card carrying a one-tap Claim button
      // plus an "Open in Hot Task" deep link; the returned message id is
      // recorded so later updates can reply/refresh in place. The headline
      // ("Tyler needs an LOI checked") already names the type, so no tag.
      const card = this.buildChannelCard(event.task);
      await this.botClient.postTaskCard(event.task.id, card.title, card.detail, card.openUrl, card.summary);
      await this.webhookIfBroadcasting({ title: card.summary, text: card.detail });
      return;
    }

    if (event.target === "CHANNEL_REOPENED") {
      // A task went back to OPEN (unclaimed or re-opened) — flip its channel
      // card back to the claimable state so the Claim button returns.
      const card = this.buildChannelCard(event.task);
      await this.botClient.markTaskOpen(event.task.id, card.title, card.detail, card.openUrl);
      return;
    }

    if (event.target === "CHANNEL_CLAIMED") {
      // Update every recorded root card to its claimed state (button removed),
      // so a web claim disables the card too — not just a tap on the card.
      await this.botClient.markTaskClaimed(event.task.id, event.message, event.actor.displayName);
      return;
    }

    if (event.target === "CHANNEL_THREAD") {
      // Follow-ups (claim / unclaim) reply inside the task's existing thread.
      // The card above already names the type, so the reply carries no prefix;
      // the fallback (fresh post when no thread exists) gets the friendly label.
      await this.botClient.replyInThread(event.task.id, event.message, `${typeLabel} - ${event.message}`);
      await this.webhookIfBroadcasting({
        title: `${typeLabel} - ${event.message}`,
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
              `Type: ${typeLabel}`,
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
      await this.botClient.sendToDms(`${typeLabel} - You claimed ${event.task.folderName}`);
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
        // Teams shows activity.summary in the feed/notification preview; without
        // it the bot DM reads "Sent a card". Surface the note's first line.
        const firstLine = event.message.split("\n")[0]?.trim() ?? event.message.trim();
        const preview = firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
        const summary = `${event.actor.displayName} sent a note: ${preview}`;
        const baseNote = {
          taskId: event.task.id,
          folder: event.task.folderName,
          thread: thread.length > 0 ? thread : [{ author: event.actor.displayName, text: event.message }]
        };
        // "Complete" is the assignee's action — don't surface it to the creator
        // on their note card. Other advances (Loan Docs merge stages) stay
        // status-only and are enforced when tapped. Recipients are only the
        // creator/assignee, so an id check is enough here.
        const completeIsAssigneeOnly = advance?.status === "COMPLETED";
        const assigneeId = event.task.assignee?.id;
        const canSeeAdvance = (recipientId: string): boolean => !completeIsAssigneeOnly || recipientId === assigneeId;
        const withAdvance = event.recipientUserIds.filter((id) => advance && canSeeAdvance(id));
        const withoutAdvance = event.recipientUserIds.filter((id) => !advance || !canSeeAdvance(id));
        if (withAdvance.length > 0 && advance) {
          await this.botClient.sendNoteCardToUsers(withAdvance, { ...baseNote, advance }, summary);
        }
        if (withoutAdvance.length > 0) {
          await this.botClient.sendNoteCardToUsers(withoutAdvance, baseNote, summary);
        }
        return;
      }
      await this.botClient.sendToDms(`${typeLabel} - ${event.actor.displayName} left a note: ${event.message} (Folder: ${event.task.folderName})`);
      return;
    }

    if (event.target === "DM") {
      // Friendly type label instead of the raw "[LOI]" tag, e.g.
      // "LOI Check - Suzie claimed 2021 Broadway RWC LLC - Adams". Append the
      // folder only when the message doesn't already name it (some messages —
      // "Got the green light", "Heads up — this one's overdue" — need the
      // context; the claim message already carries the folder).
      const label = TASK_TYPE_LABELS[event.task.taskType];
      const folder = event.task.folderName;
      const namesFolder = folder ? event.message.includes(folder) : true;
      const dmText = namesFolder ? `${label} - ${event.message}` : `${label} - ${event.message} (${folder})`;
      if (Array.isArray(event.recipientUserIds) && event.recipientUserIds.length > 0) {
        await this.botClient.sendToDmUsers(event.recipientUserIds, dmText);
        return;
      }
      await this.botClient.sendToDms(dmText);
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

    console.log(`[notify:${event.target}] ${typeLabel} - ${event.message}`);
  }
}
