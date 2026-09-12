/* The three requests behind reopening a Saved for Later task and finishing it
   (#344, ADR-0011).

   Framework-free and handed its `request` function, so what each one does when
   the server answers something unexpected can be driven against a fake server
   in `scripts/saved-for-later-board-sim-test.mjs` rather than described. App
   passes its own `apiRequest`, whose failures carry the HTTP status. Imports
   are type-only, for the reason `create-form-state.ts` keeps them that way. */
import type { SavedForLaterForm, SavedForLaterTask } from "@loan-tasks/shared";

export type SavedForLaterRequest = <T>(path: string, init: { method: string; body?: string }) => Promise<T>;

/* A 404 from these routes means the record is not there for this person: never
   saved, already created, or removed on another device. */
const isGone = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { status?: unknown }).status === 404;

/* Save for later. A new form makes a new record; a reopened form names the
   record it came from and saves onto that one, so it never becomes a copy and
   the latest save is what is kept.

   A reopened record that has gone in the meantime (created or removed from
   another device) is saved as a new one instead. The person pressed Save for
   later to keep what is on screen, and refusing that because the old copy went
   elsewhere would throw their typing away. Any other failure is a failure: it
   rejects, and nothing is posted. */
export const saveForLaterRequest = async (
  request: SavedForLaterRequest,
  form: SavedForLaterForm,
  savedId?: string
): Promise<SavedForLaterTask> => {
  const body = JSON.stringify({ form });
  if (savedId) {
    try {
      const { item } = await request<{ item: SavedForLaterTask }>(`/saved-for-later/${savedId}`, { method: "PUT", body });
      return item;
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }
  const { item } = await request<{ item: SavedForLaterTask }>("/saved-for-later", { method: "POST", body });
  return item;
};

/* What tapping a row opens. The latest save rather than the list's copy, because
   the list is loaded once and another device may have saved it again since.
   `null` when it has gone, so App can say so instead of opening a record that no
   longer exists. A server it cannot reach opens the copy on screen: that is
   still exactly what this person last saw, and saving it again is latest-wins. */
export const reopenSavedForLaterRequest = async (
  request: SavedForLaterRequest,
  item: SavedForLaterTask
): Promise<SavedForLaterTask | null> => {
  try {
    const { item: latest } = await request<{ item: SavedForLaterTask }>(`/saved-for-later/${item.id}`, { method: "GET" });
    return latest;
  } catch (error) {
    return isGone(error) ? null : item;
  }
};

/* How long a reopened form waits after the last keystroke before sending its
   typing (#348). A second rather than the browser autosave's 400ms, because
   each one is a request and a write to the server's file; still short enough
   that a closed tab loses at most the last second of typing. */
export const UNSAVED_SAVE_DEBOUNCE_MS = 1000;

/* What a reopened form should do about its unsaved typing right now (#348).
   Not the autosave's `draftAction`, whose "keep" assumes the stored copy is the
   one the form opened on. Here the form sends as it goes, so the question is
   against what it last sent:

   • `clear` when the form is back to exactly the save and something unsaved is
     out there, so a reopen shows the save again.
   • `write` when the form differs from the save and from what was last sent.
   • `keep` otherwise: nothing to send, or it has already been sent.

   The three answers come in as booleans (each a `formHasChanges` answer) so
   this module keeps its type-only imports. */
export type UnsavedAction = "write" | "keep" | "clear";

export const unsavedAction = (state: {
  differsFromSave: boolean;
  differsFromSent: boolean;
  sentExists: boolean;
}): UnsavedAction => {
  if (!state.differsFromSave) return state.sentExists ? "clear" : "keep";
  return !state.sentExists || state.differsFromSent ? "write" : "keep";
};

/* Typing on a reopened form that nobody saved (#348, ADR-0011 rule 5), sent to
   that record's unsaved slot as it is typed. Beside the save, never over it, and
   never a POST: a record created or deleted elsewhere in the meantime stays gone
   rather than coming back as a copy. True when it landed. Never throws, because
   it runs off a timer while somebody is mid-sentence and there is nothing they
   could do about a toast. */
export const keepUnsavedRequest = async (
  request: SavedForLaterRequest,
  savedId: string,
  form: SavedForLaterForm
): Promise<boolean> => {
  try {
    await request<{ item: SavedForLaterTask }>(`/saved-for-later/${savedId}/unsaved`, { method: "PUT", body: JSON.stringify({ form }) });
    return true;
  } catch {
    return false;
  }
};

/* Discard on a reopened form (#348): the unsaved typing goes and the save stays
   exactly as it was. True when nothing unsaved is left on the server, including
   when the record itself has gone, since either way there is nothing to come
   back. False when the server could not clear it, so App can say so. Never
   throws. */
export const discardUnsavedRequest = async (
  request: SavedForLaterRequest,
  savedId: string
): Promise<boolean> => {
  try {
    await request<{ item: SavedForLaterTask }>(`/saved-for-later/${savedId}/unsaved`, { method: "DELETE" });
    return true;
  } catch (error) {
    return isGone(error);
  }
};

/* Taking a Saved for Later task off the server, for good. Two callers: Create,
   once the task it held has been filed (ADR-0011 rule 4), and only after the
   create succeeded; and the row's delete control, once its owner confirmed
   (#345). True when it is off the server, including when it was already gone
   (created or deleted on another device), since either way the row should go.
   False when the server could not remove it, so App can say so and leave the
   row where it is. Never throws. */
export const removeSavedForLaterRequest = async (
  request: SavedForLaterRequest,
  savedId: string
): Promise<boolean> => {
  try {
    await request<void>(`/saved-for-later/${savedId}`, { method: "DELETE" });
    return true;
  } catch (error) {
    return isGone(error);
  }
};
