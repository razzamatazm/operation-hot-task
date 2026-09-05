import { ACTION_LABELS } from "./labels.js";
import { isTaskParty } from "./parties.js";
import { LoanTask, ReviewNote, StoredReviewNote, UserIdentity } from "./types.js";

/* ADR-0008 rules 1–3 — an LOI's terms are a standing description of the loan,
   not message number one.

   Nothing about the data moves. On an LOI the `notes` field has always held
   the terms — labelled "Loan Terms and Contacts", required since day one, and
   always written by the creator at creation, which is exactly why every
   existing LOI's first thread row is already its terms. No column is added and
   nothing migrates. What changes is where that one field is drawn: its own
   bordered section above the conversation, and *out* of the conversation,
   because a copy of the terms living inside the thread has no answer to what
   happens to it when the terms are corrected.

   LOI only. The other five types' fields are the creator's own words about
   their own situation — a Buddy Chat's concerns, an OOO's description — with
   no second party verifying the contents, so they keep one blended field
   rendered as the thread's first message.

   This is one function rather than a `taskType === "LOI"` at each surface
   because the two halves of the rule have to agree: the section shows the
   field exactly when the thread stops showing it. The caller that draws the
   section and the caller that builds the message list read the same answer off
   the same call. Asked separately, a task ends up showing its terms twice, or
   not at all.

   It hands back the text rather than a boolean so a renderer has no reason to
   reach past it for `task.notes`. `undefined` means the field is still a
   member of the thread. */
export const standingTermsFor = (task: Pick<LoanTask, "taskType" | "notes">): string | undefined =>
  task.taskType === "LOI" ? task.notes : undefined;

/* Latest review-note timestamp from someone other than `userId`. Empty string
   when there is no such note.

   Deliberately not exported. It is half of the attention question, and handing
   half out is what #161 was: a caller took the note lookup, paired it with its
   own idea of who counts, and got the second half wrong. Callers ask
   `unreadNoteFor` instead and get the whole answer. */
const latestNoteFromOther = (task: LoanTask, userId: string): string => {
  let latest = "";
  for (const n of task.reviewNotes ?? []) {
    if (n.by.id !== userId && n.at > latest) latest = n.at;
  }
  return latest;
};

/* The note this viewer has yet to read, or undefined when nothing here wants
   their attention. Returns the timestamp rather than a bare yes/no because the
   caller that shows the signal is also the caller that acknowledges it, and
   acknowledging means writing back exactly the note that was counted unread.
   Handing back one value keeps the flag and the acknowledgement in lockstep;
   computing them separately is how they drift.

   Two conditions, and the whole point of this function is that they are asked
   together. A note is unread if it is newer than what the viewer has
   acknowledged (`seenNoteAt`, undefined when they've acknowledged nothing) —
   but it only *means* anything if the viewer is a Party. An Observer has
   acknowledged nothing by definition, so under the note check alone every note
   on every task in the list read as unread at them; that was #161, and it lit
   up all three of the card's attention signals for work that wasn't theirs.

   The party check is folded in here rather than left to each caller because
   the bug was exactly a caller combining the two by hand and forgetting half.
   Callers get the answer, not the ingredients.

   Deliberately says nothing about status. Whether a card is open is no longer
   derived from anything — cards stay collapsed until the viewer opens them —
   so this answers only "is there something here for you to read".

   Also deliberately says nothing about `task.notes`. ADR-0008 took an LOI's
   terms out of the thread and flagged this calculation as something that might
   have leant on the thread's first row being the originating note. It never
   did: the walk is over `reviewNotes` alone, so the originating field has never
   been able to read as an unread message at anybody, and taking it out of the
   thread changes nothing here. That is asserted, not assumed — see
   `scripts/loi-terms-section-sim-test.mjs`. */
export const unreadNoteFor = (
  task: LoanTask,
  user: Pick<UserIdentity, "id">,
  seenNoteAt: string | undefined
): string | undefined => {
  if (!isTaskParty(task, user)) return undefined;
  const latestOther = latestNoteFromOther(task, user.id);
  if (!latestOther || latestOther <= (seenNoteAt ?? "")) return undefined;
  return latestOther;
};

/* The same question as a plain predicate, for callers that only need the
   yes/no — the grouped view's message-pull, which moves a task's court but has
   nothing to acknowledge. One walk, one rule, stated once above. */
export const hasUnreadNoteForViewer = (
  task: LoanTask,
  user: Pick<UserIdentity, "id">,
  seenNoteAt: string | undefined
): boolean => unreadNoteFor(task, user, seenNoteAt) !== undefined;

/* ── A message's identity and its label (#286, ADR-0009 rules 5 and 6) ───── */

/* The separator between the app's label and the author's words. One constant
   because two places have to agree about it forever: the renderer that joins
   them, and the migration that pulls apart the messages stored before they
   were ever separate. */
const LABEL_SEPARATOR = ": ";

/* Every prefix the app has ever written into a thread.

   Pinned literals, and then whatever the button says today. The distinction is
   load-bearing. A message filed last March carries the words the label had last
   March, and those characters are now a historical fact sitting in a file —
   whereas `ACTION_LABELS.NEEDS_FIXES` is a live string that has been renamed
   before and will be again (#237 and #254 both renamed labels). Deriving the
   list from the live label alone means the next rename quietly stops the
   migration recognising genuine send-backs already on disk: their prefix would
   stay inside the author's text and the label would be lost for good, which is
   the one thing this ticket exists to prevent.

   So the history is written down, and the current label is appended for the
   messages written since the last rename. Deduplicated, because today they are
   the same string and trying it twice buys nothing.

   Only the derivation reads this. A message written from now on stores the
   label it was given, so a later rename leaves it reading as it always did —
   which is what holding the label as data rather than as a lookup is for. */
const HISTORIC_NOTE_PREFIXES: readonly string[] = ["Needs fixes"];

export const NOTE_LABELS: readonly string[] = Array.from(
  new Set([...HISTORIC_NOTE_PREFIXES, ACTION_LABELS.NEEDS_FIXES])
);

/* What a message reads as. The ONE place a label and an author's words are put
   back together, so no surface has to know that they were ever apart, and so
   none of them can join them differently.

   Every reader goes through it — the web thread, the Teams card's quoted
   thread. A message with no label reads as its text and nothing else, which is
   why moving a prefix out of `text` and into `label` changes nothing anybody
   sees. Asserted against `needsFixesNote`, which is how the prefix was written
   before it was a label: the two must produce the same sentence. */
export const noteBodyText = (note: Pick<ReviewNote, "label" | "text">): string =>
  `${noteLabelPrefix(note)}${note.text}`;

/* The app's half of the sentence, ending in its separator, or an empty string
   on a message the app has nothing to say about.

   Split out of `noteBodyText` for the edit box (#287): the box holds the
   author's `text` alone, because rule 5 says the prefix is not theirs to
   change, and the surface still has to show them the row will keep reading
   `Needs fixes: ...`. Drawing that prefix means writing the separator, and a
   separator written twice is two ideas of what a labelled message looks like.
   So it is written once, here, and `noteBodyText` is stated in terms of it. */
export const noteLabelPrefix = (note: Pick<ReviewNote, "label">): string =>
  note.label ? `${note.label}${LABEL_SEPARATOR}` : "";

/* One stored message brought up to date, or the same object when it already
   is. Two independent repairs, because a message can need either or both: an
   identifier it never had, and a label still sitting inside its text.

   The label half is a derivation, not a lookup — nothing recorded which
   messages the app prefixed, so the prefix in the text is the only evidence
   there is. A message that already carries a `label` is left alone, which is
   what makes a second pass a no-op and what stops `Needs fixes: Needs fixes: x`
   being peeled twice.

   A person who typed a message beginning `Needs fixes: ` by hand gets a label
   they did not ask for. Accepted knowingly: it renders identically (see
   `noteBodyText`), and the alternative is leaving genuine send-backs
   unlabelled, which is the case the ADR is about. */
const migrateStoredNote = (note: StoredReviewNote, mintId: () => string): ReviewNote => {
  /* The one cast in this file, and the reason `StoredReviewNote` exists: a
     message that already carries an identifier IS a `ReviewNote`, and the test
     on the left of this ternary is the only thing that knows so. Past this line
     every reader can go on treating the identifier as something every message
     has, because after this line it is. */
  let migrated: ReviewNote = note.id ? (note as ReviewNote) : { ...note, id: mintId() };
  if (migrated.label === undefined) {
    const label = NOTE_LABELS.find((candidate) => migrated.text.startsWith(candidate + LABEL_SEPARATOR));
    if (label) {
      migrated = { ...migrated, label, text: migrated.text.slice(label.length + LABEL_SEPARATOR.length) };
    }
  }
  return migrated;
};

/* A whole task's conversation brought up to date, and whether anything moved.

   Idempotent by construction: it repairs only what is missing, so the second
   run finds nothing and reports `changed: false`. The caller writes only when
   something changed, which is what keeps a start-up migration from rewriting
   the store on every boot.

   `mintId` is injected rather than called directly so the store can hand in
   `randomUUID` and a test can hand in a counter — the identifier only has to be
   unique within its task, and a UUID clears that bar with room to spare.

   It lives here rather than in the store because it is the inverse of
   `noteBodyText`: the rule for how a label and a text were once one string is
   one rule, and splitting it across the package boundary is how the two halves
   would come to disagree. */
export const migrateTaskMessages = (
  task: LoanTask,
  mintId: () => string
): { task: LoanTask; changed: boolean } => {
  const notes = task.reviewNotes;
  if (!Array.isArray(notes) || notes.length === 0) {
    return { task, changed: false };
  }
  const migrated = notes.map((note) => migrateStoredNote(note, mintId));
  const changed = migrated.some((note, i) => note !== notes[i]);
  return changed ? { task: { ...task, reviewNotes: migrated }, changed } : { task, changed };
};

/* ── Correcting a message you posted (#287, ADR-0009) ────────────────────── */

/* What an edited message says, and the whole of it (rule 3). A constant rather
   than a literal in the renderer because the sim test asserting the marker and
   the thread drawing it have to be the same string, and because the words are
   the product's, not a component's. */
export const MESSAGE_EDITED_MARKER = "(edited)";

/* Why this person may not edit this message, or `undefined` when they may.

   A refusal string rather than a boolean, for the same reason `amendRefusal` is
   one: the server throws it and the web can show it, so there is one sentence
   for one rule instead of a predicate here and copy somewhere else.

   Two clauses and no more.

   **The author, and only the author** (rule 1). Not the other party, not an
   observer, not an admin — narrower than ADR-0008's field rules, which admit
   both parties, because a fact is a thing about the loan that either party can
   see is wrong and a message is a thing one person said. Note that this asks
   nothing about seats: someone who wrote a message and then handed the task on
   still wrote it.

   **Until the task is archived** (rule 2), and no time window. Not
   `CLOSED_STATUSES`: the conversation deliberately stays open on a COMPLETED
   task — `addCompletedNote` exists precisely so people can keep talking about
   finished work — and letting somebody post a brand new message to a completed
   task while refusing them a typo fix in it is not a defensible pair of rules.
   Archival is where the conversation itself closes, so it is where corrections
   close too.

   Noted honestly: that leaves `CANCELLED` editable, and a cancelled task does
   refuse new messages — so on that one status the rule's letter and the
   reasoning behind it point different ways. The letter is what is written down,
   in the ADR and in #287's criteria both ("allowed at any status up to
   archival"), and a cancelled task is not a status anybody is having a
   conversation on. If it is ever decided the other way, this is the line that
   changes and nothing else.

   Takes the two fields it reads rather than a whole task, so the thread — which
   holds a narrow `Pick` — can ask it without widening itself. */
export const messageEditRefusal = (
  task: Pick<LoanTask, "status">,
  note: Pick<ReviewNote, "by">,
  user: Pick<UserIdentity, "id">
): string | undefined => {
  if (note.by.id !== user.id) return "Only the person who wrote a message can edit it";
  if (task.status === "ARCHIVED") return "Messages cannot be edited on an archived task";
  return undefined;
};

/* The same question as a predicate, for the thread deciding whether to draw the
   menu on a row. The server asks for the sentence; the UI only needs the
   yes/no, and both come off the one rule above — hiding the control is a
   courtesy, the refusal is the enforcement. */
export const canEditMessage = (
  task: Pick<LoanTask, "status">,
  note: Pick<ReviewNote, "by">,
  user: Pick<UserIdentity, "id">
): boolean => messageEditRefusal(task, note, user) === undefined;

/* An edit may not empty a message (rule 4). Deletion is its own action, with
   its own tombstone; an edit box that can be emptied is deletion by the back
   door. The Save button reads this and the server enforces it, so the two
   cannot disagree about what "blank" means — trimmed, so a box holding only
   spaces is as empty as one holding nothing. */
export const EMPTY_MESSAGE_REFUSAL = "A message cannot be emptied";

export const isEmptyMessageText = (text: string): boolean => text.trim().length === 0;

/* One message in a thread corrected, and every other message returned as-is.

   Pure, and the one place the edit's *shape* is decided, so no caller has to
   remember what an edit leaves alone. It rewrites `text` and sets `edited`. It
   does not touch `at`, `by`, `label` or `id`: rule 6 needs the timestamp frozen,
   rule 5 needs the label untouched, and the identifier is what addressed the
   row in the first place.

   Idempotent on the marker — an already-edited message stays edited rather than
   accumulating anything — and a no-op edit returns the same objects, which is
   what lets the caller skip the write and the history row entirely.

   Takes and returns the whole list rather than the one message so the server can
   run it inside `updateTask`'s closure against the thread as it is at write
   time (`docs/agents/code-guardrails.md`): a reply that landed while the edit
   was being checked survives. */
export const editMessageInThread = (
  notes: readonly ReviewNote[],
  messageId: string,
  text: string
): ReviewNote[] =>
  notes.map((note) => (note.id === messageId && note.text !== text ? { ...note, text, edited: true } : note));

/* The message this identifier names, or `undefined` when the thread has no such
   row. Named rather than inlined because three callers need it — the route's
   404, the permission check, and the history detail's "before" — and a message
   found three ways is a message three callers can disagree about. */
export const findMessageInThread = (
  task: Pick<LoanTask, "reviewNotes">,
  messageId: string
): ReviewNote | undefined => (task.reviewNotes ?? []).find((note) => note.id === messageId);
