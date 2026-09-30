/* ── Filling the LOI Check from the clipboard (#415, ADR-0012) ──

   On a Humperdink arrival, and only there, the tab asks Teams for the
   clipboard. Send to Hot Task put the loan on it a moment ago, so where Teams
   can read it the form fills itself with no ⌘V. Moving an unfinished new task
   aside before that form opens (#413) is the New Task session's.

   The clipboard as teams-js hands it over: `isSupported()` asks whether this
   Teams host offers the capability, and `read()` resolves a Blob. Passed in
   rather than imported, so the reader runs against a fake in
   `scripts/humperdink-arrival-clipboard-sim-test.mjs`. */
import { parseHumperdinkPayload } from "@loan-tasks/shared";

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
