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

/* The field that carries "claim this on arrival" inside the link's `context`
   JSON, beside `subEntityId` (#180).

   Its own field rather than a `claim:<taskId>` prefix on `subEntityId`,
   because every surface shares this builder — including the web app's "Copy
   link" — and a prefix scheme would turn a pasted link into something that
   claims a task for whoever opens it. The intent is opt-in: a caller has to
   ask for it, and one that doesn't emits the byte-identical view-only URL it
   always did. */
export const CLAIM_INTENT_FIELD = "claimOnOpen";

export interface TeamsTaskDeepLinkOptions {
  /* Human-readable name for the link — Teams shows it instead of the bare URL
     when the link is pasted into a chat. In practice the task's folder name. */
  label?: string;
  /* Where to send someone with no Teams client. The web app passes its own
     origin; the server passes APP_BASE_URL when it is configured. Omitted
     entirely when unset — Teams then just opens its own client. */
  webUrl?: string;
  /* Opt in to the claim intent above. Off everywhere but the channel card's
     "Claim & Open" button. Ignored without a `taskId` — there is nothing to
     claim. */
  claim?: boolean;
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
    /* `subEntityId` first and alone unless the claim intent was asked for, so
       every existing caller's URL is byte-for-byte what it was. */
    const context = options.claim
      ? { subEntityId: taskId, [CLAIM_INTENT_FIELD]: true }
      : { subEntityId: taskId };
    params.push(`context=${encodeURIComponent(JSON.stringify(context))}`);
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

/* The claim-intent twin of a link already built. The channel card offers both
   buttons off one recorded URL, and that URL is the one saved when the card was
   posted — a card keeps pointing where it always pointed across a config
   change, which rebuilding from the live app id would quietly undo.

   Returns undefined when there is nothing to claim: no link, or a link that
   names no task. The caller then omits the affordance rather than offering a
   button that lands on the plain tab. */
export const withClaimIntent = (url: string | undefined): string | undefined => {
  if (!url) {
    return undefined;
  }
  const [base, query] = url.split("?", 2);
  if (!query) {
    return undefined;
  }
  const params = new URLSearchParams(query);
  const raw = params.get("context");
  if (!raw) {
    return undefined;
  }
  let context: Record<string, unknown>;
  try {
    context = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!context.subEntityId) {
    return undefined;
  }
  params.set("context", JSON.stringify({ ...context, [CLAIM_INTENT_FIELD]: true }));
  /* URLSearchParams percent-encodes to the same set the builder's
     encodeURIComponent does, bar `+` for a space, which none of these values
     can contain — the label is the one free-text param and it is re-encoded
     from its decoded form here. */
  return `${base}?${params.toString()}`;
};

/* Read the claim intent back off whatever the host handed the tab.

   teams-js v2 surfaces the link's `subEntityId` as `page.subPageId` and the v1
   shape put it at the top level; hosts differ on where the rest of the context
   JSON lands, so this looks in both rather than trusting one shape. Anything it
   can't find reads as no intent, which is the safe default — a link that fails
   to announce itself opens the task view-only rather than claiming it. */
export const readClaimIntent = (context: unknown): boolean => {
  if (!context || typeof context !== "object") {
    return false;
  }
  const shape = context as { page?: Record<string, unknown> } & Record<string, unknown>;
  return shape[CLAIM_INTENT_FIELD] === true || shape.page?.[CLAIM_INTENT_FIELD] === true;
};
