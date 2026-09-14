/* Arriving from Humperdink moves an unfinished new task aside (#413).

   Each person has one autosave slot for an unfinished new task form (ADR-0011
   rule 5), and any typing into a new task form writes over it. A Humperdink
   arrival opens a new LOI Check about the loan on the clipboard, which is a
   different task. So before that form opens, an autosave worth keeping becomes a
   Saved for Later task: the same write Save for later makes, which clears the
   slot in that one request, so it shows once on the Task Drafts tab.

   "Worth keeping" is the autosave's own yardstick, `formHasChanges` against a
   blank-slate open. The autosave is whichever of the server's copy and this
   browser's offline copy was written last, the one New Task would open on, so
   typing the server never got is the typing that moves.

   The answer is one of three:

   - `moved`: it is a Saved for Later task now, and both copies are gone.
   - `none`: there was nothing worth keeping, so nothing was made.
   - `held`: the move didn't happen, or nobody can say it did. The server could
     not be asked (there may be an autosave out there), the save failed, or it
     did not answer in time. Both copies are left exactly as they were, and the
     form that opens must not touch either (`leaveAutosaveAlone` on `TaskForm`),
     so nothing typed into it can overwrite the old task. Losing the old task is
     the one outcome that isn't allowed.

   Never throws and never toasts: a move that didn't land leaves nothing for the
   person to do, and the old task is still where they left it.

   Framework-free and handed its request function and storage, so it runs
   against a fake server in `scripts/humperdink-arrival-autosave-sim-test.mjs`.

   The clipboard fill that arrival's form runs (#415) is at the bottom. */
import { parseHumperdinkPayload } from "@loan-tasks/shared";
import type { SavedForLaterTask } from "@loan-tasks/shared";
import { autosaveCopy, clearDraft, newerAutosave, readDraftCopy } from "./create-form-draft";
import type { DraftStorage } from "./create-form-draft";
import { formHasChanges, initialCreateForm } from "./create-form-state";
import { AUTOSAVE_LOAD_TIMEOUT_MS, loadAutosaveRequest, saveForLaterRequest } from "./saved-for-later-requests";
import type { SavedForLaterRequest } from "./saved-for-later-requests";

export type AutosaveMove = { kind: "none" } | { kind: "moved"; saved: SavedForLaterTask } | { kind: "held" };

/* `timeoutMs` bounds each of the two requests, so a hanging server can't hold
   the arrival's form shut. The same two seconds New Task waits on the autosave. */
export const moveAutosaveAside = async (
  request: SavedForLaterRequest,
  storage: DraftStorage | null,
  userId: string,
  options: { now?: number; timeoutMs?: number } = {}
): Promise<AutosaveMove> => {
  const timeoutMs = options.timeoutMs ?? AUTOSAVE_LOAD_TIMEOUT_MS;
  const { reached, item } = await loadAutosaveRequest(request, timeoutMs);
  if (!reached) return { kind: "held" };

  const now = options.now ?? Date.now();
  const kept = newerAutosave(autosaveCopy(item, now), readDraftCopy(storage, userId, now));
  if (!kept || !formHasChanges(initialCreateForm(), kept.values)) return { kind: "none" };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const saving = saveForLaterRequest(request, kept.values);
  try {
    const saved = await Promise.race([saving, gaveUp]);
    if (!saved) {
      /* Held, but the save is still out. If it lands later, the task is on
         Task Drafts and the server's slot is empty, so the offline copy goes
         then, rather than coming back as an Autosaved row beside it. The held
         form never writes that copy, so nothing newer can be lost with it. */
      saving.then(() => clearDraft(storage, userId), () => {});
      return { kind: "held" };
    }
    /* The server cleared its slot in that write. The offline copy goes too, or
       it would come back as an Autosaved row beside the draft it just became. */
    clearDraft(storage, userId);
    return { kind: "moved", saved };
  } catch {
    return { kind: "held" };
  } finally {
    clearTimeout(timer);
  }
};

/* ── Filling the LOI Check from the clipboard (#415, ADR-0012) ──

   On a Humperdink arrival, and only there, the tab asks Teams for the
   clipboard. Send to Hot Task put the loan on it a moment ago, so where Teams
   can read it the form fills itself with no ⌘V.

   The clipboard as teams-js hands it over: `isSupported()` asks whether this
   Teams host offers the capability, and `read()` resolves a Blob. Passed in
   rather than imported, so the reader runs against a fake in
   `scripts/humperdink-arrival-clipboard-sim-test.mjs`. */
export interface ArrivalClipboard {
  isSupported: () => boolean;
  read: () => Promise<Blob>;
}

/* The clipboard's `text/plain` text if it is a Send to Hot Task payload, and
   null for everything else: no clipboard, a host that doesn't support it, a
   read that is refused or throws, another kind of data, or text that isn't a
   payload. A clipboard holding something else is not an error on this arrival,
   so this never throws and never toasts, and text that isn't a payload is not
   handed on to be kept anywhere. Focus stays in the form's request field either
   way, so ⌘V still imports. */
export const readArrivalClipboard = async (clipboard: ArrivalClipboard | null | undefined): Promise<string | null> => {
  try {
    if (!clipboard || !clipboard.isSupported()) return null;
    const blob: unknown = await clipboard.read();
    if (!(blob instanceof Blob) || !/^text\/plain(;|$)/i.test(blob.type)) return null;
    const text = await blob.text();
    return parseHumperdinkPayload(text).ok ? text : null;
  } catch {
    return null;
  }
};

/* What the arrival's form does with what was read, each time either the text or
   the loans list changes:

   - `wait`: nothing read yet, or the loans list hasn't loaded. The import runs
     against the same loans a manual paste would see, so it waits for them.
   - `drop`: the person has already started on the form (pasted, or typed) by
     the time the loans came back. What they did is kept, and the read is let go.
   - `apply`: run the form's own paste import on it. */
export const arrivalPasteStep = ({
  paste,
  loansLoaded,
  untouched
}: {
  paste: string | null;
  loansLoaded: boolean;
  untouched: boolean;
}): "wait" | "drop" | "apply" => {
  if (paste === null || !loansLoaded) return "wait";
  return untouched ? "apply" : "drop";
};
