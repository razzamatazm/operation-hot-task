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

   Framework-free, with `CreateFormValues` imported type-only, so it type-strips
   straight into `scripts/create-form-draft-sim-test.mjs` with no build — the
   same arrangement `create-form-state.ts` and `expand-state.ts` are in.

   Deliberately NOT here: whether the current form is worth saving at all. That
   is `formHasChanges` in `create-form-state.ts`, the same predicate the discard
   prompt asks (#283), and asking it twice in two places is how the prompt and
   the draft would come to disagree about what "untouched" means. */
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

/* Seven days, per the ticket: long enough that a Friday interruption is still
   there on Monday, short enough that nothing genuinely stale ever reappears.
   Measured from the last write, so a draft someone keeps coming back to keeps
   living. */
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/* Bumped only if the stored shape changes incompatibly. An unrecognised version
   reads as no draft, which is the same silent blank form as no draft at all —
   there is nothing here worth a migration, and a wrong-shaped restore would put
   values in front of someone that they never typed. */
export const DRAFT_VERSION = 1;

/* How long the form waits after the last keystroke before saving. The draft is
   written as someone types rather than on the way out, because the failure this
   ticket exists to survive is the one where nothing gets to run on the way out
   — so the only question is how often, and the answer is "shortly after they
   stop". Long enough that a sentence is one write rather than forty; short
   enough that nobody types for a whole thought and loses it. Lives here with
   the rest of the rules so the timing is one number with one reason, not a
   magic 400 buried in an effect. */
export const DRAFT_SAVE_DEBOUNCE_MS = 400;

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
export const serializeDraft = (values: CreateFormValues, savedAt: number): string =>
  JSON.stringify({ version: DRAFT_VERSION, savedAt, values: pickValues(values) } satisfies StoredDraft);

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
export const parseDraft = (raw: string | null, now: number): CreateFormValues | null => {
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
  if (now - record.savedAt >= DRAFT_MAX_AGE_MS) return null;
  const values = record.values as Record<string, unknown> | undefined;
  if (typeof values !== "object" || values === null) return null;
  for (const key of DRAFT_KEYS) {
    if (!DRAFT_FIELDS[key](values[key])) return null;
  }
  /* Arrays are copied so the caller's form state can never share a reference
     with something a second read would hand out again. */
  return { ...pickValues(values as unknown as CreateFormValues), initialItems: [...(values.initialItems as string[])] };
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
): CreateFormValues | null => {
  if (!storage) return null;
  try {
    const raw = storage.getItem(draftKey(userId));
    const values = parseDraft(raw, now);
    if (!values && raw !== null) storage.removeItem(draftKey(userId));
    return values;
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
   about local storage is a toast nobody can act on. */
export const writeDraft = (
  storage: DraftStorage | null,
  userId: string,
  values: CreateFormValues,
  savedAt: number = Date.now()
): void => {
  if (!storage) return;
  try {
    storage.setItem(draftKey(userId), serializeDraft(values, savedAt));
  } catch {
    /* storage unavailable or full — degrade silently */
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
