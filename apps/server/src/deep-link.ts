import { teamsTaskDeepLink } from "@loan-tasks/shared";
import { config } from "./config.js";

/* Teams deep link to the Hot Task tab, focused on a specific task. The builder
   itself lives in `packages/shared` (deep-link.ts) so the bot, the activity
   feed, and the web app's "Copy link" all emit the same URL; this wrapper only
   binds the server's config to it. Requires TEAMS_APP_ID — without it there's
   no valid entity link, so a card simply omits the button. `label` (the
   folder name) makes the link unfurl readably when pasted into a chat;
   `webUrl` is only attached when APP_BASE_URL is configured.

   Its own module because two layers need it: the notification layer, for the
   cards it sends, and the bot, which rebuilds the conversation card on a Reply
   tap and has to put the same link back on it. */
export const taskDeepLink = (taskId: string, label?: string): string | undefined =>
  teamsTaskDeepLink(config.teamsAppId, taskId, {
    ...(label ? { label } : {}),
    ...(config.appBaseUrl ? { webUrl: config.appBaseUrl } : {})
  });
