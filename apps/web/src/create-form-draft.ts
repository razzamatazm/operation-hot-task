/* The new task form's saved draft (#284).

   Someone starts filing a task, switches tab in Teams, and the tab reloads.
   Everything they typed used to go with it, because the form's state lived in a
   component that unmounted. This module is the copy that survives that: the
   whole of the codec — what a draft looks like on disk, when it is worth
   keeping, when it is too old to come back — with the browser reachable only
   through a three-method `DraftStorage` the caller hands in.

   Why a module and not four lines in the form: the rules here are the ticket
   (a draft expires after seven days, a malformed one is no draft, storage that
   refuses to store is not an error), and rules that can only be exercised by
   rendering a form and waiting a week are rules nobody checks. Everything below
   is value-in/value-out over a storage object a test can fake, which is the
   ticket's "testable without rendering the form".

   Framework-free, so it type-strips straight into
   `scripts/create-form-draft-sim-test.mjs`.

   Deliberately NOT here: whether the current form is worth saving at all. That
   is `formHasChanges` in `create-form-state.ts`, the same predicate the discard
   prompt asks (#283), and asking it twice in two places is how the prompt and
   the draft would come to disagree about what "untouched" means. */
import { AUTOSAVE_MAX_AGE_MS } from "@loan-tasks/shared";
import type { CreateFormValues } from "./create-form-state";

/* One draft per person, under the app's existing `loan-tasks:<thing>:<userId>`
   convention (`loan-tasks:expand:<id>`, `loan-tasks:seen-notes:<id>`).

   Per-user rather than per-machine because two people share a machine on a
   shift handover, and a half-written task carrying a loan and a note about a
   borrower is not something to hand the next person by accident. Different key,
   different draft, no reading and no clobbering: the key is the whole of that
   guarantee, which is why it is a function here rather than a template string
   at the call site. */
export const DRAFT_KEY_PREFIX = "loan-tasks:create-draft:";

export const draftKey = (userId: string): string => `${DRAFT_KEY_PREFIX}${userId}`;

/* Bumped only if the stored shape changes incompatibly. An unrecognised version
   reads as no draft, which is the same silent blank form as no draft at all —
   there is nothing here worth a migration, and a wrong-shaped restore would put
   values in front of someone that they never typed. */
export const DRAFT_VERSION = 1;

/* The three methods this needs from `window.localStorage`, and nothing else.
   Narrow on purpose: it is what makes the tests a plain object rather than a
   DOM, and it keeps this module honest about how little it touches. */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/* localStorage, or `null` where the browser won't hand it over. Some Teams
   setups lock storage down, and merely *reading* the property can throw there —
   which is why this exists at all rather than the caller writing
   `window.localStorage`. `null` flows through every function below as "do
   nothing, quietly": no toast, no console noise, and a form that behaves
   exactly as it did before this ticket. */
export const browserDraftStorage = (): DraftStorage | null => {
  try {
    return window.localStorage;
  } catch {
    /* storage unavailable — degrade silently */
    return null;
  }
};

/* What a draft looks like on disk. `savedAt` is epoch milliseconds and is the
   only thing expiry reads. */
export interface StoredDraft {
  version: number;
  savedAt: number;
  over?: number | null;
  values: CreateFormValues;
}

type FieldCheck = (value: unknown) => boolean;

const isString: FieldCheck = (value) => typeof value === "string";

/* Every field of the form, and the shape each one must have come back in.

   Written out here rather than derived from `BLANK_CREATE_FORM` because this
   module imports that one type-only, which is what lets it run in a test with
   no build. The duplication is guarded instead of avoided: the sim test asserts
   these keys are exactly the form's keys, so a field added to the form without
   being added here fails the suite rather than silently going unsaved.

   Structural, not semantic. `taskType` and `urgency` are checked as strings
   rather than against the shared enums, because importing those as values would
   tie this module to `@loan-tasks/shared`'s compiled `dist`. The values in
   storage got there from this app's own select elements, so the reachable
   failure is corruption, not an unknown-but-plausible task type. */
const DRAFT_FIELDS: Record<keyof CreateFormValues, FieldCheck> = {
  folderName: isString,
  /* Kept, but never trusted on its own — see `readDraft`. */
  loanId: isString,
  taskType: isString,
  urgency: isString,
  startDate: isString,
  returnDate: isString,
  notes: isString,
  humperdinkLink: isString,
  points: (value) => typeof value === "number" && Number.isFinite(value),
  initialItems: (value) => Array.isArray(value) && value.every(isString),
  pickerMode: (value) => value === "share" || value === "assign",
  recipientUserId: isString,
  recipientNote: isString
};

const DRAFT_KEYS = Object.keys(DRAFT_FIELDS) as (keyof CreateFormValues)[];

/* Exported for the sim test, which holds this to the form's own field list. */
export const draftFieldNames = (): string[] => [...DRAFT_KEYS];

/* Exactly the form's fields, in this module's order, and nothing that rode
   along beside them. Both halves matter: a stray key written by some future
   caller would come back out of storage and be compared against the opening
   form by `formHasChanges`, which counts a field present on one side only as a
   change — an untouched restored form would then prompt on the way out. */
const pickValues = (values: CreateFormValues): CreateFormValues => {
  const picked: Record<string, unknown> = {};
  for (const key of DRAFT_KEYS) picked[key] = values[key];
  return picked as unknown as CreateFormValues;
};

/* The record this app writes, as the string that goes into storage. Split out
   from `writeDraft` so the format is testable without a storage object at all,
   and so the read side has something to be tested against. */
export const serializeDraft = (values: CreateFormValues, savedAt: number, over?: number | null): string =>
  JSON.stringify({ version: DRAFT_VERSION, savedAt, ...(over === undefined ? {} : { over }), values: pickValues(values) } satisfies StoredDraft);

/* A stored string back into form values, or `null` for anything this app would
   not put in front of a person.

   Null covers four different nothings on purpose, because they all mean the
   same thing to the form — open blank: nothing stored, something stored that
   isn't a draft (bad JSON, wrong version, a missing or wrong-typed field), and
   a draft that has aged out. "Anything malformed is treated as no draft" is the
   ticket's rule, and the alternative — restoring half a draft — puts a form in
   front of someone that is neither what they typed nor blank.

   A `savedAt` in the future (a clock that went backwards, a draft synced from
   somewhere) is not treated as corrupt; it simply lives a little longer. The
   failure it would otherwise cause is throwing away work over a wrong clock,
   which is worse than the one it prevents. */
export const parseDraft = (raw: string | null, now: number): CreateFormValues | null => parseDraftCopy(raw, now)?.values ?? null;

/* An autosave that could come back, and when it was written, in epoch
   milliseconds. The browser's offline copy and the server's autosave (#371)
   both become one of these, so the form can weigh the two with one rule. */
export interface AutosaveCopy {
  values: CreateFormValues;
  savedAt: number;
  /* An offline copy's: the server stamp of the Autosave it was typed over, null
     when the server had none, absent when not known (#470). */
  over?: number | null;
}

/* Something claiming to be the form's values, as exactly those values, or
   `null` if any field is missing or the wrong shape. Arrays are copied so the
   caller's form state can never share a reference with something a second read
   would hand out again. */
const formValuesOf = (candidate: unknown): CreateFormValues | null => {
  if (typeof candidate !== "object" || candidate === null) return null;
  const values = candidate as Record<string, unknown>;
  for (const key of DRAFT_KEYS) {
    if (!DRAFT_FIELDS[key](values[key])) return null;
  }
  return { ...pickValues(values as unknown as CreateFormValues), initialItems: [...(values.initialItems as string[])] };
};

const parseDraftCopy = (raw: string | null, now: number): AutosaveCopy | null => {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Partial<StoredDraft>;
  if (record.version !== DRAFT_VERSION) return null;
  if (typeof record.savedAt !== "number" || !Number.isFinite(record.savedAt)) return null;
  if (now - record.savedAt >= AUTOSAVE_MAX_AGE_MS) return null;
  const values = formValuesOf(record.values);
  if (!values) return null;
  const over = record.over === null || (typeof record.over === "number" && Number.isFinite(record.over)) ? record.over : undefined;
  return over === undefined ? { values, savedAt: record.savedAt } : { values, savedAt: record.savedAt, over };
};

/* The server's autosave (#371) as a copy the form can restore, or `null` for
   none, one aged out, or one that is not the form's shape. The server already
   refuses a malformed write and never answers with an aged-out one; asking again
   here costs nothing and means an old copy App held since sign-in cannot come
   back past its seven days. */
export const autosaveCopy = (
  item: { savedAt: string; form: unknown } | null | undefined,
  now: number
): AutosaveCopy | null => {
  if (!item) return null;
  const savedAt = Date.parse(item.savedAt);
  if (!Number.isFinite(savedAt) || now - savedAt >= AUTOSAVE_MAX_AGE_MS) return null;
  const values = formValuesOf(item.form);
  return values ? { values, savedAt } : null;
};

/* Which autosave a New Task opens on, given the server's and this browser's
   offline copy (#371). The one written last: the offline copy only exists
   because a write to the server failed, so when it is the newer it is typing
   the server never got, and when it is the older a later write reached the
   server from somewhere. A tie goes to the server's, the copy every device
   sees.

   The two stamps come from different clocks, so an offline copy that knows
   which server copy it was typed over is weighed by that instead, when the
   server was reached (#470), by `typedOver`. A held copy may not be the
   server's, so it is weighed by clock. */
export const newerAutosave = (
  server: AutosaveCopy | null,
  offline: AutosaveCopy | null,
  reached = true
): AutosaveCopy | null => {
  if (!server) return offline;
  if (!offline) return server;
  if (reached && offline.over !== undefined) return typedOver({ savedAt: offline.over }, { savedAt: server.savedAt }) ? offline : server;
  return offline.savedAt > server.savedAt ? offline : server;
};

/* What the server held when an offline copy was typed over it: its stamp, null
   for nothing there, and for a Task Draft its unsaved typing (null for none,
   absent when not known). */
export interface CopyBase {
  savedAt: number | null;
  unsaved?: CreateFormValues | null;
}

/* The one clock-free rule for an offline copy, the Autosave's (#470) and a
   reopened Task Draft's (#476) alike: it is the newer while the server still
   holds exactly what it was typed over, and loses once it holds anything else. */
export const typedOver = (base: CopyBase, server: CopyBase): boolean => {
  if (base.savedAt !== server.savedAt) return false;
  if (base.unsaved === undefined) return true;
  return base.unsaved && server.unsaved ? JSON.stringify(pickValues(base.unsaved)) === JSON.stringify(pickValues(server.unsaved)) : !base.unsaved && !server.unsaved;
};

/* This person's draft, or `null`. Prunes on the way past: a record that came
   back unusable — stale, corrupt, from a version that no longer exists — is
   deleted rather than left to sit in storage forever being re-read and
   re-rejected. Expiry has no other enforcement point; nothing sweeps storage in
   the background, and the read is the only moment a draft's age is ever asked
   about.

   The restored `loanId` is deliberately kept rather than dropped or verified
   here. A draft can sit for a week, in which time the loan could be renamed or
   removed, and this module has no loan list to check it against. It does not
   need one: the create path only sends a `loanId` whose loan still exists AND
   still carries the folder name in the box, and otherwise resolves the typed
   name at Create the way it does for anything typed by hand (ADR-0001). A loan
   that moved on therefore behaves like a typo — the same no-match — rather than
   like an error. */
export const readDraft = (
  storage: DraftStorage | null,
  userId: string,
  now: number = Date.now()
): CreateFormValues | null => readDraftCopy(storage, userId, now)?.values ?? null;

/* The same read, with when the copy was written, so it can be weighed against
   the server's autosave (#371). */
export const readDraftCopy = (
  storage: DraftStorage | null,
  userId: string,
  now: number = Date.now()
): AutosaveCopy | null => {
  if (!storage) return null;
  try {
    const raw = storage.getItem(draftKey(userId));
    const copy = parseDraftCopy(raw, now);
    if (!copy && raw !== null) storage.removeItem(draftKey(userId));
    return copy;
  } catch {
    /* storage unavailable — degrade silently */
    return null;
  }
};

/* Save this person's draft over whatever was there. Last write wins, including
   across two windows: the ticket says so, and the alternative (merging two
   half-written tasks) has no sane answer.

   Silent on failure, which is mostly `QuotaExceededError` — storage is full, or
   a locked-down Teams profile refuses writes. A person who has never seen this
   feature is exactly as well off as they were before it existed, and a toast
   about local storage is a toast nobody can act on.

   Returns whether the draft is now on disk, so the caller's idea of "there is a
   copy out there" is what actually happened rather than what it attempted. On a
   full disk that is the difference between believing a save landed and knowing
   it didn't. */
export const writeDraft = (
  storage: DraftStorage | null,
  userId: string,
  values: CreateFormValues,
  savedAt: number = Date.now(),
  over?: number | null
): boolean => {
  if (!storage) return false;
  try {
    storage.setItem(draftKey(userId), serializeDraft(values, savedAt, over));
    return true;
  } catch {
    /* storage unavailable or full — degrade silently */
    return false;
  }
};

/* Forget this person's draft. The one call behind every way a draft is meant to
   end deliberately: the task got created, or they confirmed the discard prompt.
   Kept as one named thing so those paths cannot each grow their own idea of
   what clearing means. Removing a key that isn't there is not an error. */
export const clearDraft = (storage: DraftStorage | null, userId: string): void => {
  if (!storage) return;
  try {
    storage.removeItem(draftKey(userId));
  } catch {
    /* storage unavailable — degrade silently */
  }
};

/* ── A reopened Task Draft's typing the server never got (#476) ──
   One per person per record. `base` is the record as the server held it when
   the copy was written: its last save and its unsaved typing (null for none,
   absent when never heard from the server). While the server still holds
   exactly that, the copy is the newer; once it holds anything else, a later
   write got there and the copy loses. No clocks are compared, and no expiry:
   the record it belongs to doesn't expire. */
const unsavedCopyKey = (userId: string, savedId: string): string => `loan-tasks:unsaved-copy:${userId}:${savedId}`;

export interface UnsavedCopyBase {
  savedAt: string;
  unsaved?: CreateFormValues | null;
}

export interface UnsavedCopy {
  values: CreateFormValues;
  base: UnsavedCopyBase;
}

export const writeUnsavedCopy = (storage: DraftStorage | null, userId: string, savedId: string, copy: UnsavedCopy): void => {
  if (!storage) return;
  try {
    const { savedAt, unsaved } = copy.base;
    const base = unsaved === undefined ? { savedAt } : { savedAt, unsaved: unsaved && pickValues(unsaved) };
    storage.setItem(unsavedCopyKey(userId, savedId), JSON.stringify({ version: DRAFT_VERSION, values: pickValues(copy.values), base }));
  } catch {
    /* storage unavailable or full — degrade silently */
  }
};

/* The copy, or null for none or one that isn't the right shape (pruned). */
export const readUnsavedCopy = (storage: DraftStorage | null, userId: string, savedId: string): UnsavedCopy | null => {
  if (!storage) return null;
  try {
    const key = unsavedCopyKey(userId, savedId);
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const copy = parseUnsavedCopy(raw);
    if (!copy) storage.removeItem(key);
    return copy;
  } catch {
    /* storage unavailable — degrade silently */
    return null;
  }
};

const parseUnsavedCopy = (raw: string): UnsavedCopy | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as { version?: unknown; values?: unknown; base?: { savedAt?: unknown; unsaved?: unknown } };
  if (record.version !== DRAFT_VERSION || typeof record.base !== "object" || record.base === null) return null;
  if (typeof record.base.savedAt !== "string") return null;
  const values = formValuesOf(record.values);
  if (!values) return null;
  const { savedAt, unsaved } = record.base;
  if (!("unsaved" in record.base)) return { values, base: { savedAt } };
  if (unsaved === null) return { values, base: { savedAt, unsaved: null } };
  const known = formValuesOf(unsaved);
  return known ? { values, base: { savedAt, unsaved: known } } : null;
};

export const clearUnsavedCopy = (storage: DraftStorage | null, userId: string, savedId: string): void => {
  if (!storage) return;
  try {
    storage.removeItem(unsavedCopyKey(userId, savedId));
  } catch {
    /* storage unavailable — degrade silently */
  }
};

/* A filed task whose server Autosave could not be forgotten (#472). While this
   is set, the server's copy is the filed task and never opens; the forget is
   owed until a DELETE lands or a newer write replaces the copy. */
export const filedAutosaveKey = (userId: string): string => `loan-tasks:autosave-filed:${userId}`;

export const filedForgetOwed = (storage: DraftStorage | null, userId: string): boolean => {
  try {
    return storage?.getItem(filedAutosaveKey(userId)) != null;
  } catch {
    return false;
  }
};

export const oweFiledForget = (storage: DraftStorage | null, userId: string, owed: boolean): void => {
  try {
    if (owed) storage?.setItem(filedAutosaveKey(userId), "1");
    else storage?.removeItem(filedAutosaveKey(userId));
  } catch {
    /* storage unavailable — degrade silently */
  }
};

/* ── What a restored form says about itself (#285) ──────────
   Restoring silently is the right default and a small mystery: someone opens
   New Task expecting an empty form and finds last Tuesday's abandoned attempt
   with no clue where it came from. One line says where, and the button beside
   it is the way out for the person who did not want it back.

   A pure function for the reason `discardConfirmCopy` is one: the wording IS
   the feature — it is the whole of the explanation — so a test asserts it
   directly rather than fishing it out of rendered markup one refactor away from
   being dropped.

   Says "Hot Task", not "we" or "this form": the point is that the app did
   something on the person's behalf while they were away. The second sentence
   is what makes it an explanation rather than a notification — it names the
   state the form is in, which is why the line stays up while the form is open
   instead of flashing past.

   "Start fresh" rather than "Discard" or "Clear": nothing is being thrown away
   that the person still wants, and the button is a beginning rather than a
   deletion. It takes no confirmation — anyone pressing it wants an empty form,
   and the form starts saving again the moment they type. */
export const restoredDraftCopy = (): { note: string; action: string } => ({
  note: "Hot Task saved your progress. Picking up where you left off.",
  action: "Start fresh"
});

/* The same note for a Task Draft reopened on its unsaved typing (#475). No
   action: going back to the last save is not offered. */
export const UNSAVED_CHANGES_NOTE = "You have unsaved changes to this Task Draft. Picking up where you left off.";
