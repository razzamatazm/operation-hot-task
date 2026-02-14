import { NotificationEvent } from "@loan-tasks/shared";
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
  constructor(private readonly botClient: TeamsBotClient) {}

  async notify(event: NotificationEvent): Promise<void> {
    const prefix = `[${event.task.taskType}] [${event.task.urgency}]`;
    const detail = `Loan: ${event.task.loanName}\nStatus: ${event.task.status}\nUrgency: ${event.task.urgency}`;

    if (event.target === "CHANNEL") {
      await this.botClient.sendToChannels(`${prefix} ${event.message}`, detail);
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
      await this.botClient.sendToDms(`${prefix} ${event.message} (Loan: ${event.task.loanName})`);
      return;
    }

    console.log(`[notify:${event.target}] ${prefix} ${event.message}`);
  }
}
