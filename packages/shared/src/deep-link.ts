/* Teams deep links to the Hot Task tab.

   One builder, shared by every surface that needs one: the bot's Adaptive
   Cards, the Graph activity-feed topic, and the web app's "Copy link". It used
   to be duplicated server-side (notifications.ts + activity-feed.ts) and the
   two copies had already drifted apart on the context shape, so it lives here
   now — per AGENTS.md, shared logic belongs in `packages/shared` before it is
   copied a third time. */

/* Entity id of the personal tab in the Teams manifest. Channel/group tabs are
   configurable and carry no entityId, so an `l/entity` link always resolves to
   the personal tab. */
export const HOT_TASK_ENTITY_ID = "loan-tasks-home";

export interface TeamsTaskDeepLinkOptions {
  /* Human-readable name for the link — Teams shows it instead of the bare URL
     when the link is pasted into a chat. In practice the task's folder name. */
  label?: string;
  /* Where to send someone with no Teams client. The web app passes its own
     origin; the server passes APP_BASE_URL when it is configured. Omitted
     entirely when unset — Teams then just opens its own client. */
  webUrl?: string;
}

/* Build the deep link, or return undefined when we have no app id.

   Without TEAMS_APP_ID (server) or a `/api/config` answer (web) there is no
   valid entity link to build, so callers omit the affordance rather than
   emitting a broken URL.

   `taskId` is optional: with one, the link focuses that task (teams-js
   surfaces `subEntityId` as `page.subPageId`, which the web app reads to
   expand + scroll to the card); without one, it opens the tab plain. */
export const teamsTaskDeepLink = (
  appId: string | null | undefined,
  taskId?: string,
  options: TeamsTaskDeepLinkOptions = {}
): string | undefined => {
  const id = appId?.trim();
  if (!id) {
    return undefined;
  }

  const params: string[] = [];
  if (taskId) {
    params.push(`context=${encodeURIComponent(JSON.stringify({ subEntityId: taskId }))}`);
  }
  if (options.label?.trim()) {
    params.push(`label=${encodeURIComponent(options.label.trim())}`);
  }
  if (options.webUrl?.trim()) {
    params.push(`webUrl=${encodeURIComponent(options.webUrl.trim())}`);
  }

  const base = `https://teams.microsoft.com/l/entity/${id}/${HOT_TASK_ENTITY_ID}`;
  return params.length > 0 ? `${base}?${params.join("&")}` : base;
};
