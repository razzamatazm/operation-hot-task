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

/* Once the task it held has been created, the Saved for Later task is gone for
   good (ADR-0011 rule 4). Called only after the create succeeded. True when it
   is off the server, including when it was already gone; false when the
   server could not remove it, so App can say the task was filed but the saved
   copy is still listed. Never throws: the task exists either way. */
export const clearCreatedSavedForLaterRequest = async (
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
