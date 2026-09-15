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

/* The `subEntityId` a Humperdink arrival carries (#412): somebody pressed Send
   to Hot Task, the loan is on their clipboard, and the tab should open a new LOI
   Check for it.

   A fixed value in `subEntityId` rather than a field of its own, because
   `subEntityId` is the one context value proven to reach the tab on Teams
   desktop (2026-09-13, in all three states: Hot Task on screen, Teams on
   another page, Teams quit). The separate create-form context field #198 used
   was never once seen to survive real Teams, and is gone. Task ids are UUIDs, so this can't
   collide with one.

   Overloading the task id this way means a link pasted into a chat opens a form
   for whoever clicks it. That was the reason #198 refused a sentinel, and it is
   harmless: the form only fills from the clicker's own clipboard, only a valid
   Send to Hot Task payload fills it, and nothing is filed until they press
   Create. What must never happen is the claim scheme's failure, a link that
   acts for someone, and this one doesn't act.

   The link carries nothing but this and a press tag (below). Teams writes every
   deep link it receives into its local log, so no loan data goes in the URL. */
export const HUMPERDINK_ARRIVAL_ID = "new:humperdink";

/* The sentinel, alone or with a press tag after a colon: `new:humperdink` or
   `new:humperdink:<tag>`.

   The tag is there because Teams desktop ignores a deep link identical to the
   page it is already showing. It navigates, but never reloads the tab, so a
   second Export to HT with Hot Task still on screen opened nothing (seen in
   Teams' own log 2026-09-14: presses 2 to 4 logged no frame reload, and two
   links differing only in the tag reloaded it both times). A tag that differs on
   every press makes every press a new link. The bare sentinel still reads as an
   arrival, for any userscript copy from before the tag. */
export const isHumperdinkArrival = (value: unknown): boolean =>
  typeof value === "string" && (value === HUMPERDINK_ARRIVAL_ID || value.startsWith(`${HUMPERDINK_ARRIVAL_ID}:`));

/* What a press tag may be: letters and digits, so nothing but a counter or a
   timestamp can ride in the link. */
const PRESS_TAG = /^[0-9a-z]+$/i;

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
   expand + scroll to the card); without one, it opens the tab plain. The
   Humperdink sentinel is never a task id here: handed it, the builder names no
   task, so a task link can't turn into an arrival link. */
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
  /* `subEntityId` first and alone unless the claim was asked for, so every
     existing caller's URL is byte-for-byte what it was. */
  const context: Record<string, unknown> = {};
  if (taskId && !isHumperdinkArrival(taskId)) {
    context.subEntityId = taskId;
    if (options.claim) {
      context[CLAIM_INTENT_FIELD] = true;
    }
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

/* The Humperdink arrival link (#412), or undefined with no app id.

   The `msteams:` form, not `https://teams.microsoft.com/l/…`: the https form
   detours through Microsoft's "Join conversation" launcher page, and the
   `msteams:` one was proven to open Teams desktop directly. The team uses Teams
   desktop only. Context is exactly `{"subEntityId":"<sentinel>"}` and there
   are no other params: no label, no webUrl, and never any loan data.

   `press` is the press tag (see `isHumperdinkArrival`). The userscript passes a
   new one on every press. A tag that isn't letters and digits is left off rather
   than put in the link. */
export const humperdinkArrivalLink = (appId: string | null | undefined, press?: string): string | undefined => {
  const id = appId?.trim();
  if (!id) {
    return undefined;
  }
  const tag = press?.trim();
  const subEntityId = tag && PRESS_TAG.test(tag) ? `${HUMPERDINK_ARRIVAL_ID}:${tag}` : HUMPERDINK_ARRIVAL_ID;
  const context = encodeURIComponent(JSON.stringify({ subEntityId }));
  return `msteams:/l/entity/${id}/${HOT_TASK_ENTITY_ID}?context=${context}`;
};

/* The claim-intent twin of a link already built. The channel card offers both
   buttons off one recorded URL, and that URL is the one saved when the card was
   posted — a card keeps pointing where it always pointed across a config
   change, which rebuilding from the live app id would quietly undo.

   Returns undefined when there is nothing to claim: no link, a link that names
   no task, or a Humperdink arrival link, which names no task either. The caller
   then omits the affordance rather than offering a button that lands on the
   plain tab. */
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
    if (!context.subEntityId || isHumperdinkArrival(context.subEntityId)) {
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

/* Which way somebody arrived at the tab. */
export type TeamsArrival =
  /* Send to Hot Task: open a new LOI Check. Names no task, carries no claim. */
  | { kind: "humperdink" }
  /* A task link: focus that task, and claim it only when `claim` is set. */
  | { kind: "task"; taskId: string; claim: boolean }
  /* No deep link, or one that names nothing: the normal board. */
  | { kind: "none" };

/* Read the arrival off whatever the host handed the tab, once, so the tab has
   one answer to branch on (#412).

   The value is `page.subPageId` (teams-js v2) or top-level `subEntityId` (v1),
   the v2 one first, which is the order the tab always read them in. The
   Humperdink sentinel is checked before anything treats the value as a task, so
   it never becomes a task to focus, and a claim intent riding beside it is
   ignored rather than claiming a task called `new:humperdink`. Anything that
   isn't a non-empty string is no arrival. */
export const readTeamsArrival = (context: unknown): TeamsArrival => {
  if (!context || typeof context !== "object") {
    return { kind: "none" };
  }
  const shape = context as { page?: Record<string, unknown> } & Record<string, unknown>;
  const value = shape.page?.subPageId ?? shape.subEntityId;
  if (typeof value !== "string" || !value) {
    return { kind: "none" };
  }
  if (isHumperdinkArrival(value)) {
    return { kind: "humperdink" };
  }
  return { kind: "task", taskId: value, claim: readClaimIntent(context) };
};
