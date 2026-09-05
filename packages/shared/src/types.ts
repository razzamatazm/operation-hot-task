/* Type-only, and it has to stay that way. checklist.ts takes a value from this
   module (CLOSED_STATUSES, below), so this edge is the return leg of a loop
   that only stays harmless because `import type` erases at compile time. Turn
   it into a value import and the pair becomes a real module cycle — a
   module-scope const here that reads a checklist export would TDZ at import
   time. See #205. */
import type { ChecklistItem } from "./checklist.js";

export const TASK_TYPES = ["LOI", "BUDDY_CHAT", "VALUE", "FRAUD", "LOAN_DOCS", "OOO"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const NOTES_FIELD_LABELS: Readonly<Record<TaskType, string>> = {
  LOI: "Loan Terms and Contacts",
  BUDDY_CHAT: "Concerns",
  VALUE: "Notes",
  // FRAUD's free-text surface is the shared discussion thread (#68): the
  // structured checklist carries outstanding items, and this label heads the
  // card's thread. Relabeled from "Discussion" back to "Notes" for
  // consistency with every other task type (#81). The create form uses its
  // own purpose-built "Notes" label (#69), not this constant.
  FRAUD: "Notes",
  LOAN_DOCS: "Notes",
  OOO: "Notes"
};

export const getNotesFieldLabel = (taskType?: TaskType): string => {
  if (!taskType) {
    return "Notes";
  }
  return NOTES_FIELD_LABELS[taskType] ?? "Notes";
};

/* The same field named mid-sentence rather than as a box heading. Prose wants
   "the terms cannot be emptied", not "the Loan Terms and Contacts cannot be
   emptied", so this is the short noun and `NOTES_FIELD_LABELS` above stays the
   heading.

   One definition because three sentences use it and they must agree: the
   refusal a permission check throws (`amendRefusal`), the refusal an emptied
   field throws, and the history entry an applied edit writes. A reader who is
   told "the terms cannot be changed on a closed task" and then finds a history
   line saying "Notes changed" is reading about two different fields (#263,
   ADR-0008 rule 5). Lowercase, because every use is mid-sentence bar one that
   capitalises it itself. */
export const requestFieldNoun = (taskType: TaskType): string =>
  taskType === "LOI" ? "terms" : "notes";

/* Human, creator-perspective phrase per task type for the "New Task" headline,
   e.g. "Tyler needs a set of loan docs done". OOO isn't a request, so it reads
   as a status instead. */
export const TASK_NEEDS_PHRASE: Readonly<Record<TaskType, string>> = {
  LOI: "needs an LOI checked",
  BUDDY_CHAT: "needs a Buddy Chat",
  VALUE: "needs a Value Check",
  FRAUD: "needs a Fraud Check",
  LOAN_DOCS: "needs a set of loan docs done",
  OOO: "needs OOO Coverage"
};

export const formatNewTaskHeadline = (displayName: string, taskType: TaskType): string =>
  `${displayName} ${TASK_NEEDS_PHRASE[taskType]}`;

/* Headline of the channel card once somebody takes the task. Composed here
   because two surfaces build it — the in-place edit on claim, and the
   user-specific refresh rebuilding the same card from the live task — and a
   claimed card that reads two ways depending on which one rendered it is the
   drift this card family already had once (#193). */
export const formatClaimedHeadline = (assigneeName: string | undefined, folderName: string): string =>
  `${assigneeName ?? "Someone"} grabbed ${folderName}`;

/* A Fraud Check released back to the pool is NOT a new request — it's a
   half-finished one whose checker walked away, so the channel card says so
   rather than borrowing the "needs a Fraud Check" headline and reading as a
   duplicate task. */
export const formatReleasedHeadline = (folderName: string): string =>
  `${folderName} needs a new file checker`;

/* What the person picking a released check up would be walking into. Phrased
   from the incoming checker's side, because the card exists to get somebody to
   take it and "which half is done" is the question they'd ask. Only the live
   fraud statuses appear: a release never happens anywhere else. */
export const FRAUD_RELEASE_PHASE: Readonly<Partial<Record<TaskStatus, string>>> = {
  CLAIMED: "the initial pass",
  AWAITING_ITEMS: "outstanding items, waiting on the requester",
  PENDING_APPROVAL: "final approval"
};

/* Friendly, human-facing type name (e.g. "LOI Check") for notification copy and
   the web UI. Replaces the raw "[LOI]" tag in DMs/cards. */
export const TASK_TYPE_LABELS: Readonly<Record<TaskType, string>> = {
  LOI: "LOI Check",
  BUDDY_CHAT: "Buddy Chat",
  VALUE: "Value Check",
  FRAUD: "Fraud Check",
  LOAN_DOCS: "Loan Docs",
  OOO: "Out of Office"
};

/* The one context line every post-creation channel card carries under its
   headline (#193). The claimed / completed / cancelled cards used to be rebuilt
   from the folder name alone, which dropped the two facts a reader scrolling
   the channel actually wants — who asked for this, and what kind of work it was
   — the moment the card left its created state.

   Reads as `LOI Check · Smith-1042 · asked by Tyler · done by Suzie`: the
   friendly type label (the same `TASK_TYPE_LABELS` wording every DM surface
   uses, never a second phrasing), the file name, the assigner, the current
   holder. A segment is omitted rather than rendered empty, so a cancelled task
   nobody claimed simply ends after the assigner.

   OOO carries no file name: an OOO task's Folder Name is a Vacation
   Description and the task has no Loan behind it, so there is nothing to name.

   `assigneeVerb` is how the holder got there — "claimed by" for a real claim,
   "done by" on the completed card, "assigned to" for a task born assigned
   (Handoff at creation, ADR-0002), which nobody claimed. */
export interface ChannelCardContext {
  taskType: TaskType;
  /** The file name, or — on OOO — the Vacation Description, which never
      reaches the line. */
  folderName: string;
  /** Display name of whoever asked for the work. */
  createdBy: string;
  /** Display name of whoever holds it now, absent when nobody does. */
  assignee?: string;
}

export const formatChannelContextLine = (params: ChannelCardContext & { assigneeVerb?: string }): string => {
  const segments: string[] = [TASK_TYPE_LABELS[params.taskType]];
  if (params.taskType !== "OOO" && params.folderName.trim()) {
    segments.push(params.folderName.trim());
  }
  if (params.createdBy.trim()) {
    segments.push(`asked by ${params.createdBy.trim()}`);
  }
  if (params.assignee?.trim()) {
    segments.push(`${params.assigneeVerb ?? "claimed by"} ${params.assignee.trim()}`);
  }
  return segments.join(" · ");
};

/* What the requester's completion DM says, by task type (#232).

   `Done and dusted 🎉` is the historical message and stays the default: it
   reads fine for work whose result the requester can see for themselves.

   An LOI check is the exception. The requester asked somebody to look at a
   file, and `Done and dusted` told them the task closed without telling them
   what the look found — the message behind the "did you actually check it?"
   incident (#172). A check that finds something doesn't complete — it goes to
   the corrections loop (ADR-0007) — so the completion the checker performs is
   the clean one, and it is exactly the moment to say so.

   One completion isn't the checker's: the creator can close a task out of
   corrections themselves (`NEEDS_REVIEW → COMPLETED`), and they'd read this
   line about a fix they made. Telling the two closures apart is #239's, which
   owns the corrections-loop notifications and the record of who closed; this
   is deliberately keyed on task type alone until that lands.

   The folder name isn't in the copy: `formatLifecycleDmText` appends it, so
   the reader sees `LOI Check - Good to go! (Smith-1042)` with the folder
   carrying the deep link back to the task. */
export const COMPLETION_DM_MESSAGE_DEFAULT = "Done and dusted 🎉";

const COMPLETION_DM_MESSAGES: Readonly<Partial<Record<TaskType, string>>> = {
  LOI: "Good to go!"
};

export const completionDmMessage = (taskType: TaskType): string =>
  COMPLETION_DM_MESSAGES[taskType] ?? COMPLETION_DM_MESSAGE_DEFAULT;

/* Text of a plain lifecycle DM — the completion notice, the merge steps, the
   fraud round trip, handoff displacement, OOO auto-completion and the overdue
   reminder all read as `<friendly type> - <message>`, with the folder name
   appended in parentheses only when the message doesn't already name it.

   One composition point for every one of them (#174), so the folder name is
   also the link back to the task: whichever occurrence the reader sees — the
   inline one or the appended one — becomes the anchor. `url` comes from
   `teamsTaskDeepLink`, which returns undefined with no app id (the normal case
   locally and in tests); without it, or without a folder to hang the link on,
   the text is character-for-character what it was before links existed, raw
   folder name and all. */
/* The Humperdink line on a DM detail card, held here rather than typed at the
   send site because two places need the exact same string: the card body that
   writes it, and the correction that has to find that line again to swap the
   link inside it when the loan's link is edited (#280). A near-miss between the
   two reads as "the correction silently did nothing". */
export const formatHumperdinkCardLine = (url: string): string => `Humperdink: [link](${url})`;

export const formatLifecycleDmText = (params: {
  typeLabel: string;
  message: string;
  folderName?: string;
  url?: string;
}): string => {
  // Deliberately untrimmed: this is the pre-link behaviour verbatim, and
  // trimming here would silently reword every DM whose folder carries stray
  // whitespace.
  const folder = params.folderName ?? "";
  const namesFolder = folder ? params.message.includes(folder) : true;
  const body = namesFolder ? params.message : `${params.message} (${folder})`;
  /* A square bracket in the folder name would end the anchor early, and no
     amount of escaping fixes that in Teams' Markdown subset — so that folder
     goes unlinked rather than rendering as literal `[folder](https://…)`,
     which the reader would find worse than today's no link at all. */
  if (!params.url || folder.trim().length === 0 || /[[\]]/.test(folder)) {
    return `${params.typeLabel} - ${body}`;
  }
  /* Parentheses are the other way the anchor breaks, and they reach the URL
     too: the folder name rides the deep link as `label=`, and
     encodeURIComponent leaves `(` and `)` alone. One unbalanced paren in a
     folder name ends the link destination early. Percent-escaping both in the
     destination is the fix — the URL means the same thing, and the destination
     then holds no parens to miscount. The anchor text itself is safe either
     way; it's bracket-delimited. */
  const href = params.url.replace(/\(/g, "%28").replace(/\)/g, "%29");
  // Replacer function, not a replacement string: `$&` and friends in a folder
  // name would otherwise be expanded by String.replace.
  return `${params.typeLabel} - ${body.replace(folder, () => `[${folder}](${href})`)}`;
};

/* First word of a display name — "Suzie Lim" → "Suzie". Used in compact
   notification copy. */
export const firstName = (displayName: string): string => displayName.trim().split(/\s+/)[0] ?? displayName;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/* Format a calendar date as "Jun 4, 2026" without any timezone shift. Accepts
   a bare "YYYY-MM-DD" or a full ISO string (uses only the date portion), so a
   date-only value never slips to the previous day under UTC parsing. */
export const formatWallDate = (value: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) {
    return value;
  }
  const [, year, month, day] = match;
  return `${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}`;
};

/* OOO doesn't read as a work request, so it gets its own headline asking for
   coverage across the absence window. */
export const formatOooHeadline = (displayName: string, startDate: string, returnDate: string): string =>
  `Out Of Office - ${displayName} will be out of the office from ${formatWallDate(startDate)} to ${formatWallDate(returnDate)} and needs coverage. Can you help?`;

export const URGENCY_LEVELS = ["GREEN", "YELLOW", "ORANGE", "RED"] as const;
export type UrgencyLevel = (typeof URGENCY_LEVELS)[number];

/* Human time-frame for each urgency level — used in bot/notification copy so
   we surface the deadline ("Within 1 Hour") rather than the raw colour code. */
export const URGENCY_TIMEFRAMES: Record<UrgencyLevel, string> = {
  GREEN: "Within 24 Hours",
  YELLOW: "End of Day",
  ORANGE: "Within 1 Hour",
  RED: "Urgent Now"
};

export const USER_ROLES = ["LOAN_OFFICER", "FILE_CHECKER", "ADMIN"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/* The scheduler acts without a human behind it. It used to borrow ADMIN to do
   that, which conflated "administers the system" with "acts on its own" — see
   ADR-0003. It is an identity, not a role: SYSTEM carries no roles at all, and
   the actor gates in workflow.ts let it past on the strength of its id.
   `system` is reserved: `authenticate` refuses any inbound request claiming it,
   so only in-process callers can ever be this actor. */
export const SYSTEM_ACTOR_ID = "system";

export const SYSTEM_ACTOR: UserIdentity = {
  id: SYSTEM_ACTOR_ID,
  displayName: "Task Scheduler",
  roles: []
};

export const isSystemActor = (user: Pick<UserIdentity, "id">): boolean => user.id === SYSTEM_ACTOR_ID;

export const TASK_STATUSES = [
  "OPEN",
  "CLAIMED",
  "NEEDS_REVIEW",
  "MERGE_DONE",
  "MERGE_APPROVED",
  // FRAUD-only two-phase completion (#39). After the fraud checker's initial
  // pass, the task lands on AWAITING_ITEMS (checker has sent outstanding items,
  // waiting on the requester) and then PENDING_APPROVAL (requester submitted the
  // items, waiting on the checker's final approval). Both are NON-closed, so
  // notes keep flowing; only PENDING_APPROVAL → COMPLETED closes the task. Never
  // reached by non-FRAUD task types. See workflow.ts FRAUD_FLOW.
  "AWAITING_ITEMS",
  "PENDING_APPROVAL",
  "COMPLETED",
  "CANCELLED",
  "ARCHIVED"
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/* The terminal/closed statuses — a task here is done being worked. Canonical
   list so the web view, workflow rules, and services agree on what "closed"
   means. */
export const CLOSED_STATUSES: TaskStatus[] = ["COMPLETED", "CANCELLED", "ARCHIVED"];

export interface UserIdentity {
  id: string;
  displayName: string;
  roles: UserRole[];
  /* Entra `preferred_username` / UPN. Optional: header-auth dev users and
     historical task snapshots may not carry it. */
  email?: string;
}

/* One message in a task's conversation.

   ADR-0009 gives a message two things it did not have. Both are structural and
   neither is visible: a thread built from these renders exactly as it did
   before #286.

   `id` is the stable handle. A message used to be identified only by its author
   and `at`, and ADR-0009 rule 6 freezes `at` across an edit precisely so it
   stays the value the unread comparison reads — which is what stops it doubling
   as a version marker, and what leaves anything addressing one message with
   nothing to point at. Minted at write time; messages stored before #286 are
   backfilled once at start-up (`migrateTaskMessages`, run by `TaskStore.init`).

   `label` is the app's own words, held apart from the author's (ADR-0009 rule
   5). When a checker sends work back the reason they typed is filed under a
   prefix naming the exit that wrote it; that prefix used to be ordinary
   characters at the front of `text`, indistinguishable from anything a person
   typed. Held separately it can survive an edit that rewrites `text` and a
   delete that removes it. Absent on an ordinary reply. Never rendered on its
   own — `noteBodyText` is the one place label and text are put back together.

   `edited` is set the first time the author corrects their own words (#287,
   ADR-0009 rule 3), and is the whole of what the thread says about it: a plain
   `(edited)`, with no edit time and no previous version. Rule 3 rejected both —
   a second timestamp beside the message's own invites "so which one is this",
   and an expandable previous version is the affordance that makes people
   hesitate before fixing a typo. Whoever needs to know what changed reads the
   task's history, which carries the text on both sides of every edit.

   Note what an edit does NOT move: `at` is not re-stamped and `label` is not
   touched. The first is rule 6 — `at` is the value the unread comparison reads,
   so moving it would re-raise a corrected message at somebody who had already
   read it. The second is rule 5 — the author owns their words, the app owns the
   label saying why the row exists.

   `deleted` is the tombstone (#288, ADR-0009 rule 4): the author withdrew what
   they said, and the row stays. It is a state on the message rather than a
   removal from the list because the gap is the point — the row keeps its
   author, its place and its label, so a reader can see that somebody withdrew
   something here and roughly when. It counts as a message everywhere a message
   is counted.

   A tombstoned message's `text` is emptied when the flag goes on, because
   "deleted" that still ships the words to every client is not deleted. The
   withdrawn words survive in the task's history, which is where rule 7 puts
   them and the only place rule 4 lets anyone read them. Nothing renders `text`
   directly — `noteBodyText` answers what the row reads, and on a tombstone
   that is the app's words, not the author's.

   One way (rule 4): there is no undelete, and a tombstone is not editable. The
   two refusals come off the same shared rule the edit does. */
export interface ReviewNote {
  id: string;
  label?: string;
  text: string;
  by: Pick<UserIdentity, "id" | "displayName">;
  at: string;
  edited?: boolean;
  deleted?: boolean;
}

/* A message as it may still be sitting in the store: a `ReviewNote` whose
   identifier may be missing, because it was written before #286 gave messages
   one. The single shape in the codebase that admits that possibility, and it
   exists so the admission is in one place rather than an optional field
   everything downstream has to keep re-checking.

   Two callers, both at the boundary: the migration that repairs such a message
   (`migrateTaskMessages`) and the web thread, which renders whatever the API
   hands it. Everything else takes a `ReviewNote` and its required `id` — the
   store backfills at start-up, so by the time anything else looks, it is true. */
export type StoredReviewNote = Omit<ReviewNote, "id"> & { id?: string };

/* A loan is a first-class, linkable entity (ADR-0001). Name + optional
   Humperdink link live here, not duplicated on every task. The Humperdink
   link is the canonical unique key when present. `aliases` records names
   folded in by an auto-merge on a shared link. */
export interface Loan {
  id: string;
  name: string;
  humperdinkLink?: string;
  aliases?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateLoanInput {
  name: string;
  humperdinkLink?: string;
}

export interface UpdateLoanInput {
  name?: string;
  humperdinkLink?: string;
}

export interface LoanTask {
  id: string;
  /** Live reference to the owning Loan (ADR-0001). Present on every non-OOO
      task; absent on OOO (never loan-related). `folderName`/`humperdinkLink`
      below are a denormalized cache of the linked Loan, kept in sync so all
      existing reads and notification copy keep working. */
  loanId?: string;
  folderName: string;
  /** @deprecated Compatibility alias for one release window. */
  loanName?: string;
  taskType: TaskType;
  dueAt: string;
  urgency: UrgencyLevel;
  points: number;
  notes: string;
  humperdinkLink?: string;
  /** @deprecated Compatibility alias for one release window. */
  serverLocation?: string;
  status: TaskStatus;
  /** OOO only: raw calendar dates of the absence (YYYY-MM-DD). `dueAt` still
      holds the computed return-time for scheduling/sorting. */
  startDate?: string;
  returnDate?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: Pick<UserIdentity, "id" | "displayName">;
  assignee?: Pick<UserIdentity, "id" | "displayName">;
  archivedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  /** When a closed task (COMPLETED/ARCHIVED) is reopened back into an active
      status, the closed status it held immediately before the reopen. Drives
      the "Restore" action, which returns the task to exactly that status.
      Cleared as soon as the task reaches a closed status again. */
  reopenedFrom?: TaskStatus;
  /** LOI corrections loop only (#238, ADR-0007 rule 5): the status a task now
      sitting with its assignee was sent back FROM, when the creator sent it
      back for a confirming look rather than closing it themselves. Always
      `NEEDS_REVIEW` in practice — it is typed as a status, and set off the
      status the move came from, for the same reason `reopenedFrom` above is:
      the breadcrumb says where the task has been, not that a flag was raised.

      It is what tells a CLAIMED task that arrived this way apart from one that
      never entered corrections, which is otherwise indistinguishable. That
      difference is the whole of rule 5: the confirm at the tail of the loop
      closes AND archives, because the person pressing it is confirming
      somebody else's fix and should not be left tidying up after it.

      Read through `completionTargetStatus`, never directly. Cleared when the
      task moves anywhere else, and when a new holder arrives. */
  awaitingConfirmationFrom?: TaskStatus;
  lastReminderAt?: string;
  reviewNotes?: ReviewNote[];
  /** FRAUD only (#44): structured outstanding-items checklist that replaces the
      old free-text handoff. Built by the checker, resolved by the creator,
      approved by the checker. Absent on non-FRAUD tasks. */
  checklist?: ChecklistItem[];
  /** FRAUD only (#44): the outstanding-items pass counter. Starts at 1 when the
      checker first sends items (CLAIMED → AWAITING_ITEMS) and increments on
      each bounce-back (PENDING_APPROVAL → AWAITING_ITEMS). New items record the
      pass they were added on (`ChecklistItem.addedOnPass`). */
  checklistPass?: number;
  /** FRAUD only: when the checker last handed the task to the requester, i.e.
      the most recent entry into AWAITING_ITEMS (initial send or a Send Back).
      `updatedAt` can't stand in for this — it is rewritten on every checklist
      edit, which is exactly what the requester does while holding the task, so
      the "with requester" counter would reset each time they tick an item.
      Set on entry, never cleared: nothing reads it in other statuses and
      keeping it leaves a record of the last hand-off. */
  awaitingItemsSince?: string;
  /** When the pool nag last posted to the group channel for this unclaimed task
      (ADR-0005). Absent until the first nag, and stamped rather than cleared on
      every door back to OPEN, because the reopen post the channel already gets
      is nag zero — see `unclaimTask`. Also stamped by the boot backfill, so a
      task that predates the nag is not read as "never nagged" and does not fire
      the instant the feature ships (#207). */
  lastPoolNagAt?: string;
  /** When this task most recently entered the pool — was filed unheld, or came
      back after somebody let go of it (#210). Absent means it has never left,
      so `createdAt` is the answer and `inPoolSince` falls back to it.

      `lastPoolNagAt` cannot stand in for this: it is stamped on every nag as
      well as on entry, so it answers "how recently was the room asked", which
      is a different question from "how long has this been sitting". */
  pooledSince?: string;
  /** How many pool nags this task has already spent (#207). The nag repeats,
      but not forever: past `MAX_POOL_NAGS` the room has been asked enough and
      re-asking is noise, so the count is the ceiling's memory. Absent means
      none sent. Reset when the task finds a holder, since the next spell in the
      pool is a fresh ask. */
  poolNagCount?: number;
}

export interface TaskHistoryEvent {
  id: string;
  taskId: string;
  action: string;
  at: string;
  by: Pick<UserIdentity, "id" | "displayName">;
  detail?: string;
}

export interface CreateTaskInput {
  /** When set, links the new task to this existing Loan (typeahead select).
      When absent, a Loan is resolved/created from `folderName` server-side. */
  loanId?: string;
  folderName: string;
  /** @deprecated Compatibility alias for one release window. */
  loanName?: string;
  taskType: TaskType;
  dueAt?: string;
  /** OOO: first day out of office (YYYY-MM-DD). */
  startDate?: string;
  returnDate?: string;
  urgency?: UrgencyLevel;
  points?: number;
  notes: string;
  humperdinkLink?: string;
  /** @deprecated Compatibility alias for one release window. */
  serverLocation?: string;
  /** FRAUD only (#69): outstanding-items the creator already knows about, seeded
      onto the checklist at creation. Persisted as creator-added draft
      `ChecklistItem`s; ignored for non-FRAUD task types. Optional — zero is
      fine, the checker seeds later. */
  initialItems?: { text: string }[];
  /** Handoff at creation (ADR-0002): the task is born assigned to this user and
      lands CLAIMED, in one atomic operation rather than create-then-assign.
      The recipient must be eligible to work it (`canAssignTaskTo`). Optional. */
  assigneeUserId?: string;
  /** Optional one-liner that rides the recipient's handoff DM card, exactly as
      the share note does. Ignored without `assigneeUserId`. */
  assigneeNote?: string;
}

export interface UpdateTaskStatusInput {
  status: TaskStatus;
  reviewNotes?: string;
}

export interface UpdateTaskPointsInput {
  points: number;
}

export interface NotificationEvent {
  type: "TASK_CREATED" | "TASK_CLAIMED" | "TASK_UNCLAIMED" | "TASK_STATUS_CHANGED" | "TASK_REMINDER" | "TASK_ARCHIVED";
  task: LoanTask;
  actor: Pick<UserIdentity, "id" | "displayName">;
  message: string;
  /* DM_CARD_SYNC is not a message — it's a silent in-place refresh of the DM
     cards already sitting in participants' chats, so their buttons track the
     task's live status instead of freezing at whatever step they were sent at.
     Emitted on every status change; creates nothing, pings nobody.

     CARD_CORRECTION is DM_CARD_SYNC plus the channel card, and it exists for a
     different reason: not "the task moved" but "what the task is called moved"
     (#280). A loan's name and link are edited once and pushed onto every task
     on that loan, so every card already posted for those tasks is quoting a
     name nobody uses any more. Each one is corrected where it sits, in the
     lifecycle shape it is already in — nothing is posted, nothing is deleted,
     and nobody is re-pinged for a rename. */
  target: "IN_APP" | "DM" | "DM_NOTE" | "DM_CLAIM" | "DM_CHAT_SEED" | "DM_SHARE" | "DM_ASSIGN" | "DM_CARD_SYNC" | "CARD_CORRECTION" | "CHANNEL" | "CHANNEL_THREAD" | "CHANNEL_CLAIMED" | "CHANNEL_COMPLETED" | "CHANNEL_CANCELLED" | "CHANNEL_REOPENED" | "CHANNEL_RELEASED" | "CHANNEL_NAG" | "ACTIVITY_FEED";
  recipientUserIds?: string[];
  /* Free-text note from the actor, surfaced in the recipient's card (issue #41
     share, and the Handoff's DM_ASSIGN card — ADR-0002). Optional. */
  note?: string;
  createdAt: string;
}

export interface AppConfig {
  businessTimezone: string;
  businessStartHour: number;
  businessStartMinute: number;
  businessEndHour: number;
  businessEndMinute: number;
  archiveRetentionDays: number;
}
