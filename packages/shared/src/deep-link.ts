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

/* The field that carries "open the create form on arrival" inside the link's
   `context` JSON, beside `subEntityId` (#198).

   The Humperdink userscript copies a loan to the clipboard and then wants to
   land you where you can paste it. The payload travels on the clipboard, so the
   link itself carries no data at all — it only has to say which of Hot Task's
   two arrivals this is.

   Its own opt-in field rather than a sentinel in `subEntityId`, because every
   surface shares this builder — including the web app's "Copy link" — and a
   scheme that overloaded the task id would turn a link pasted into a chat into
   one that opens a create form for whoever clicks it. A caller that doesn't ask
   for it emits the byte-identical URL it always did. */
export const CREATE_FORM_INTENT_FIELD = "openCreateForm";

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
  /* Opt in to the create-form intent above. Off everywhere but the Humperdink
     userscript's "Send to Hot Task" control (#198). Independent of `taskId`:
     nothing builds both today, but the two are separate fields and the builder
     honours whichever it was asked for. */
  createForm?: boolean;
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
  /* `subEntityId` first and alone unless an intent was asked for, so every
     existing caller's URL is byte-for-byte what it was. */
  const context: Record<string, unknown> = {};
  if (taskId) {
    context.subEntityId = taskId;
    if (options.claim) {
      context[CLAIM_INTENT_FIELD] = true;
    }
  }
  if (options.createForm) {
    context[CREATE_FORM_INTENT_FIELD] = true;
  }
  if (Object.keys(context).length > 0) {
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
  /* Rewritten param by param with `encodeURIComponent`, not through
     `URLSearchParams.toString()`, which encodes a space as `+` where the
     builder writes `%20`. `label` is the folder name and folder names have
     spaces in them, so the round trip has to speak the builder's dialect or the
     two buttons on one card would carry differently-encoded twins. */
  const rewritten: string[] = [];
  let seenContext = false;
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? "" : decodeURIComponent(pair.slice(eq + 1));
    if (key !== "context") {
      rewritten.push(`${key}=${encodeURIComponent(value)}`);
      continue;
    }
    let context: Record<string, unknown>;
    try {
      context = JSON.parse(value) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    if (!context.subEntityId) {
      return undefined;
    }
    seenContext = true;
    rewritten.push(`context=${encodeURIComponent(JSON.stringify({ ...context, [CLAIM_INTENT_FIELD]: true }))}`);
  }
  return seenContext ? `${base}?${rewritten.join("&")}` : undefined;
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

/* Read the create-form intent back off whatever the host handed the tab (#198).

   teams-js v2 surfaces the link's `subEntityId` as `page.subPageId` and the v1
   shape put it at the top level; hosts differ on where the rest of the context
   JSON lands, so this looks in both rather than trusting one shape. Anything it
   can't find reads as no intent, which is the safe default — arriving by any
   other route, or by a link that fails to announce itself, lands on the normal
   board.

   Strictly `=== true`: only the boolean the builder writes counts, so a host
   that stringifies context values, or a URL somebody hand-edited, doesn't open
   a form nobody asked for. */
export const readCreateFormIntent = (context: unknown): boolean => {
  if (!context || typeof context !== "object") {
    return false;
  }
  const shape = context as { page?: Record<string, unknown> } & Record<string, unknown>;
  return shape[CREATE_FORM_INTENT_FIELD] === true || shape.page?.[CREATE_FORM_INTENT_FIELD] === true;
};
