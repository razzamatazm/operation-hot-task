import { FRAUD_RELEASE_PHASE, NotificationEvent, TASK_TYPE_LABELS, UserIdentity, URGENCY_TIMEFRAMES, botPrimaryAdvance, formatLifecycleDmText, formatNewTaskHeadline, formatOooHeadline, formatReleasedHeadline, formatWallDate, fraudCardActions, taskCardRecipients, teamsTaskDeepLink } from "@loan-tasks/shared";
import { ActivityFeedClient } from "./activity-feed.js";
import { config } from "./config.js";
import { TeamsBotClient, recentNoteThread } from "./bot.js";
import { SettingsStore } from "./settings-store.js";

export interface NotificationProvider {
  notify(event: NotificationEvent): Promise<void>;
  /* Whether a DM to this user would actually be delivered right now — a stored
     bot reference exists AND DM notifications are enabled. Lets callers (issue
     #41 share) report delivered-vs-not instead of dropping silently. */
  canReachDm(userId: string): Promise<boolean>;
}

/* Teams deep link to the Hot Task tab, focused on a specific task. The builder
   itself lives in `packages/shared` (deep-link.ts) so the bot, the activity
   feed, and the web app's "Copy link" all emit the same URL; this wrapper only
   binds the server's config to it. Requires TEAMS_APP_ID — without it there's
   no valid entity link, so the card simply omits the button. `label` (the
   folder name) makes the link unfurl readably when pasted into a chat;
   `webUrl` is only attached when APP_BASE_URL is configured. */
const taskDeepLink = (taskId: string, label?: string): string | undefined =>
  teamsTaskDeepLink(config.teamsAppId, taskId, {
    ...(label ? { label } : {}),
    ...(config.appBaseUrl ? { webUrl: config.appBaseUrl } : {})
  });

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
    private readonly settings: SettingsStore,
    /* A fraud card's button set turns on the viewer's seat, and the checker
       seat needs a live FILE_CHECKER role — which the task snapshot doesn't
       carry. Recipients arrive as bare ids, so the card paths look the roles
       up here. Required, not optional: a silent fallback to "no roles" would
       quietly strip every checker's buttons. */
    private readonly resolveIdentity: (userId: string) => Promise<UserIdentity | undefined>
  ) {}

  /* Ids → identities for the card builders. An id with no user record (or a
     deactivated one) resolves to a roleless viewer: they still get the card,
     they just hold no seat on it. */
  private async cardViewers(userIds: Array<string | undefined>): Promise<UserIdentity[]> {
    const ids = Array.from(new Set(userIds.filter((id): id is string => Boolean(id && id.trim().length > 0))));
    return Promise.all(
      ids.map(async (id) => (await this.resolveIdentity(id)) ?? { id, displayName: "", roles: [] })
    );
  }

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
    const openUrl = taskDeepLink(task.id, task.folderName);
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

  /* The three DM surfaces that send a full task detail card — DM_SHARE,
     DM_ASSIGN and DM_CLAIM — differ in exactly three ways: the title, whether
     the body carries a Due line, and whether the card offers the
     advance/complete button. Everything else is identical: the OOO/non-OOO
     body split, How Bad, urgency, notes, the Humperdink link, a quoted note
     leading the body, the deep link, and the plain-DM fallback when there's no
     targeted recipient. It lives here once so a change to the card body can't
     land on two of the three and drift the way the labels did.

     `withAdvance` also decides whether the card is TRACKED (#136). The two are
     the same question asked twice: a card offering a forward move is exactly a
     card that goes stale when the task moves, so it has to stay editable for
     DM_CARD_SYNC to refresh it. DM_SHARE offers no move and needs no tracking;
     DM_CLAIM and the handoff's DM_ASSIGN both do. */
  private async sendTaskDetailDm(
    event: NotificationEvent,
    options: { title: string; withDue: boolean; withAdvance: boolean; fallbackText?: string }
  ): Promise<void> {
    const typeLabel = TASK_TYPE_LABELS[event.task.taskType];
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
            ...(options.withDue ? [`Due: ${formatWallDate(event.task.dueAt)}`] : []),
            ...(event.task.notes?.trim() ? [`Notes: ${event.task.notes.trim()}`] : []),
            ...(event.task.humperdinkLink ? [`Humperdink: [link](${event.task.humperdinkLink})`] : [])
          ];
    // A personal note (share or handoff) leads the body, above the task
    // details, so the "hey, look at this" reads before the metadata.
    if (event.note?.trim()) {
      lines.unshift(`"${event.note.trim()}"`, "");
    }
    /* FRAUD's forward move is note-required (Send Outstanding Items) and lives
       on the two-phase chat card (DM_CHAT_SEED), so the plain detail card omits
       it — a buttonless advance here would post a blank note the server
       rejects. */
    const advance =
      options.withAdvance && event.task.taskType !== "FRAUD" ? botPrimaryAdvance(event.task) : undefined;
    const openUrl = taskDeepLink(event.task.id, event.task.folderName);
    if (Array.isArray(event.recipientUserIds) && event.recipientUserIds.length > 0) {
      const card = {
        taskId: event.task.id,
        title: options.title,
        detail: lines.join("\n"),
        ...(openUrl ? { openUrl } : {}),
        ...(advance ? { advance } : {})
      };
      if (options.withAdvance) {
        await this.botClient.sendTrackedDetailCard(event.recipientUserIds, card);
      } else {
        await this.botClient.sendDetailCardToUsers(event.recipientUserIds, card);
      }
      return;
    }
    await this.botClient.sendToDms(`${typeLabel} - ${options.fallbackText ?? options.title}`);
  }

  async canReachDm(userId: string): Promise<boolean> {
    if (!config.enableDmNotifications) {
      return false;
    }
    return this.botClient.hasDmReference(userId);
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
      // A task born assigned (Handoff at creation, ADR-0002) is announced with
      // the claimed-card variant instead — no Claim button to appear and then
      // vanish. Deliberately quiet: channel posts set no activity alert.
      await this.botClient.postTaskCard(
        event.task.id,
        card.title,
        card.detail,
        card.openUrl,
        card.summary,
        event.task.createdBy.id,
        event.task.assignee?.displayName
      );
      await this.webhookIfBroadcasting({ title: card.summary, text: card.detail });
      return;
    }

    if (event.target === "CHANNEL_NAG") {
      // The pool nag (ADR-0005): a task nobody has claimed, re-asked of the room.
      // A fresh post, because an in-place edit pings nobody — same reasoning as
      // CHANNEL_REOPENED below. The nag message names the folder itself, so it
      // is the card headline rather than being run through the usual
      // "<Type> - <message> (<folder>)" shaping.
      const card = this.buildChannelCard(event.task);
      await this.botClient.postPoolNag(
        event.task.id,
        event.message,
        card.detail,
        card.openUrl,
        event.task.createdBy.id
      );
      return;
    }

    if (event.target === "CHANNEL_REOPENED") {
      // A task went back to OPEN (unclaimed or re-opened). Design A: re-alert the
      // channel with a FRESH claimable card as a new thread (so a "notify on new
      // messages, not replies" team setting still pings), and point the old card
      // at it. The headline uses the creator's name so it reads like a new task.
      const card = this.buildChannelCard(event.task);
      await this.botClient.repostReopenedTask(event.task.id, {
        title: card.title,
        detail: card.detail,
        folder: event.task.folderName,
        creatorAadObjectId: event.task.createdBy.id,
        ...(card.openUrl ? { openUrl: card.openUrl } : {})
      });
      return;
    }

    if (event.target === "CHANNEL_RELEASED") {
      /* A Fraud Check went back to the pool with its status untouched — either
         the requester released it or its checker lost the seat. Same mechanism
         as CHANNEL_REOPENED, and for the same reason: an in-place edit of the
         old card pings nobody, and a check nobody notices is a check nobody
         picks up. So a FRESH claimable card as a new thread, with the old card
         pointed at it.

         The copy is what differs. This isn't a new request, so it doesn't
         borrow the "X needs a Fraud Check" headline; and the phase leads the
         body because "how much of this is already done" is the first thing a
         checker deciding whether to take it wants to know. */
      const card = this.buildChannelCard(event.task);
      const phase = FRAUD_RELEASE_PHASE[event.task.status];
      await this.botClient.repostReopenedTask(event.task.id, {
        title: formatReleasedHeadline(event.task.folderName),
        detail: phase ? `Picks up at: ${phase}\n${card.detail}` : card.detail,
        folder: event.task.folderName,
        creatorAadObjectId: event.task.createdBy.id,
        ...(card.openUrl ? { openUrl: card.openUrl } : {})
      });
      return;
    }

    if (event.target === "CHANNEL_CLAIMED") {
      // Silently edit every recorded root card to its claimed state (button
      // removed) — a web claim disables the card too, with no channel re-ping.
      await this.botClient.markTaskClaimed(event.task.id, event.message, event.actor.displayName);
      return;
    }

    if (event.target === "CHANNEL_COMPLETED") {
      // Silently edit the root card to the terminal completed state.
      await this.botClient.markTaskCompleted(
        event.task.id,
        event.task.folderName,
        event.task.assignee?.displayName
      );
      return;
    }

    if (event.target === "CHANNEL_CANCELLED") {
      // Silently edit the root card to the terminal cancelled state.
      await this.botClient.markTaskCancelled(event.task.id, event.task.folderName);
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

    if (event.target === "DM_CARD_SYNC") {
      // Deliberately above the enableDmNotifications gate: this sends nothing.
      // It only edits cards already in people's chats, and turning DMs off is no
      // reason to strand a live Complete button on a task that's already done.
      // The task's own participants, plus anyone the caller names — an unclaim
      // or a fraud release drops the assignee, and it's precisely that
      // ex-assignee whose card is still offering a button they no longer have.
      const advance = botPrimaryAdvance(event.task);
      const recipients = taskCardRecipients(
        event.task,
        await this.cardViewers([
          event.task.createdBy.id,
          event.task.assignee?.id,
          ...(event.recipientUserIds ?? [])
        ])
      );
      if (recipients.length === 0) {
        return;
      }
      await this.botClient.syncTaskCards({
        taskId: event.task.id,
        folder: event.task.folderName,
        status: event.task.status,
        thread: recentNoteThread(event.task),
        ...(advance ? { advance } : {}),
        recipients
      });
      return;
    }

    if (
      (event.target === "DM" || event.target === "DM_NOTE" || event.target === "DM_CLAIM" || event.target === "DM_CHAT_SEED" || event.target === "DM_SHARE" || event.target === "DM_ASSIGN") &&
      !config.enableDmNotifications
    ) {
      return;
    }

    if (event.target === "DM_CHAT_SEED") {
      // On claim, open the note-conversation card for BOTH parties so the chat
      // surface exists before the first note. Seeds with existing notes, or an
      // intro line when there are none. Reposts at the bottom (reposition) so a
      // re-claim moves a stale card down.
      if (!Array.isArray(event.recipientUserIds) || event.recipientUserIds.length === 0) {
        return;
      }
      const advance = botPrimaryAdvance(event.task);
      const existing = recentNoteThread(event.task);
      const seeded =
        existing.length > 0
          ? existing
          : [{ author: "Hot Task", text: `${event.actor.displayName} claimed this — reply here to chat about it.` }];
      const recipients = taskCardRecipients(event.task, await this.cardViewers(event.recipientUserIds)).map((recipient) => ({
        ...recipient,
        createIfMissing: true,
        reposition: true,
        summary: `Chat opened for ${event.task.folderName}`
      }));
      await this.botClient.syncNoteCards({
        taskId: event.task.id,
        folder: event.task.folderName,
        thread: seeded,
        ...(advance ? { advance } : {}),
        recipients
      });
      return;
    }

    if (event.target === "DM_SHARE") {
      /* Someone pointed a specific person at this task from the dashboard. DM
         only the target (never the creator/assignee). No Due line and no
         advance button: the target isn't necessarily going to work it, so the
         card informs rather than offering a move. */
      await this.sendTaskDetailDm(event, {
        title: `${event.actor.displayName} shared ${event.task.folderName} with you`,
        withDue: false,
        withAdvance: false,
        fallbackText: event.message
      });
      return;
    }

    if (event.target === "DM_ASSIGN") {
      /* Handoff (ADR-0002): somebody pointed this task AT the recipient — they
         own it now. Exactly the card a claimer gets, because they're in exactly
         the position a claimer is in: Due line and advance button included.
         Only the title differs. The handoff note is never written as a review
         note — that would double-notify via DM_NOTE. */
      await this.sendTaskDetailDm(event, {
        title: `${event.actor.displayName} assigned ${event.task.folderName} to you`,
        withDue: true,
        withAdvance: true
      });
      return;
    }

    if (event.target === "DM_CLAIM") {
      // Full-details card to whoever claimed the task — the surface that shows
      // due date, plus the advance/complete button and the deep link. Tracked
      // via withAdvance, so DM_CARD_SYNC can refresh it (#136).
      await this.sendTaskDetailDm(event, {
        title: `You claimed ${event.task.folderName}`,
        withDue: true,
        withAdvance: true
      });
      return;
    }

    if (event.target === "DM_NOTE") {
      // Interactive note card: shows the note text with an inline reply box that
      // posts straight back as another review note. `event.message` is the raw
      // note text. Falls back to a plain DM if there are no targeted recipients.
      if (Array.isArray(event.recipientUserIds) && event.recipientUserIds.length > 0) {
        // Last few notes for context, oldest → newest. Falls back to the raw
        // message if the task somehow carries no stored notes.
        const thread = recentNoteThread(event.task);
        const advance = botPrimaryAdvance(event.task);
        // Teams shows activity.summary in the feed/notification preview; without
        // it the bot DM reads "Sent a card". Surface the note's first line.
        const firstLine = event.message.split("\n")[0]?.trim() ?? event.message.trim();
        const preview = firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
        const summaryText = `${event.actor.displayName} sent a note: ${preview}`;
        const resolvedThread = thread.length > 0 ? thread : [{ author: event.actor.displayName, text: event.message }];
        // Recipients are the task's participants (creator + assignee), including
        // the note's author so their own DM card stays in sync when they post
        // from the web app. Which buttons each one sees is `taskCardRecipients`;
        // this only adds the delivery behaviour, per recipient:
        //  - createIfMissing: don't spawn (and self-ping) a fresh card for the
        //    author of this note; only update theirs if it already exists.
        //  - summary: only ping non-authors.
        const authorId = event.actor.id;
        const recipients = taskCardRecipients(event.task, await this.cardViewers(event.recipientUserIds)).map((recipient) => ({
          ...recipient,
          createIfMissing: recipient.userId !== authorId,
          // The other party's card moves to the bottom so a new note isn't
          // stranded above older lifecycle DMs; the author's card updates in
          // place (no self-ping, no needless repost).
          reposition: recipient.userId !== authorId,
          ...(recipient.userId !== authorId ? { summary: summaryText } : {})
        }));
        await this.botClient.syncNoteCards({
          taskId: event.task.id,
          folder: event.task.folderName,
          thread: resolvedThread,
          ...(advance ? { advance } : {}),
          recipients
        });
        return;
      }
      await this.botClient.sendToDms(`${typeLabel} - ${event.actor.displayName} left a note: ${event.message} (Folder: ${event.task.folderName})`);
      return;
    }

    if (event.target === "DM") {
      /* Friendly type label instead of the raw "[LOI]" tag, e.g.
         "LOI Check - Suzie claimed 2021 Broadway RWC LLC - Adams", with the
         folder name carrying the deep link back to the task (#174). Composed
         in `packages/shared` because this is the one point every lifecycle
         notice passes through — completion, the merge steps, the fraud round
         trip, handoff displacement, OOO auto-completion, overdue reminders —
         so the next one added gets the link for free. With no TEAMS_APP_ID
         `taskDeepLink` returns undefined and the text is exactly what it was
         before. Markdown renders because the DM send sets the activity's
         textFormat (see markdownText in bot.ts). */
      const openUrl = taskDeepLink(event.task.id, event.task.folderName);
      const dmText = formatLifecycleDmText({
        typeLabel: TASK_TYPE_LABELS[event.task.taskType],
        message: event.message,
        folderName: event.task.folderName,
        ...(openUrl ? { url: openUrl } : {})
      });
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
