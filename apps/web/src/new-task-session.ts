/* One fresh New Task form's life (#467): opening on the newer Autosave, writing
   it as the person types, and every way the form ends. A plain object handed
   its request function, storage and clock, with a thin React hook wrapper at
   the bottom. App and the form only call it. */
import type { Autosave, SavedForLaterTask } from "@loan-tasks/shared";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { autosaveCopy, clearDraft, draftAction, newerAutosave, readDraftCopy, writeDraft } from "./create-form-draft";
import type { DraftStorage } from "./create-form-draft";
import { formHasChanges, initialCreateForm } from "./create-form-state";
import type { CreateFormValues } from "./create-form-state";
import {
  UNSAVED_SAVE_DEBOUNCE_MS,
  browserTimers,
  forgetAutosaveRequest,
  keepAutosaveRequest,
  loadAutosaveRequest,
  saveForLaterRequest
} from "./saved-for-later-requests";
import type { RequestTimers, SavedForLaterRequest } from "./saved-for-later-requests";

export interface NewTaskSessionClock extends RequestTimers {
  now(): number;
}

export interface NewTaskSessionDeps {
  /* The person who opened the session. Every write goes out as them and lands
     on their copies only; App starts a new session when the person changes. */
  owner: string;
  request: SavedForLaterRequest;
  storage: DraftStorage | null;
  clock?: NewTaskSessionClock;
  /* The owner's Autosave as the session last learned it, for the Task Drafts
     tab's Autosaved row. Null once it is forgotten. */
  onAutosave?: (autosave: Autosave | null) => void;
  onSavedForLater?: (item: SavedForLaterTask) => void;
}

export type NewTaskEndingKind = "create" | "saveForLater" | "discard" | "startFresh" | "cancel";

export type NewTaskSessionState =
  | { phase: "closed" }
  | { phase: "opening" }
  | {
      phase: "open";
      values: CreateFormValues;
      /* Opened on an Autosave, until Start fresh: the "saved your progress" note. */
      restored: boolean;
      /* Cancel or Escape asked whether to leave. */
      asking: boolean;
      /* The ending under way, if any. */
      ending: NewTaskEndingKind | null;
    };

export type NewTaskEnding =
  | { kind: "create"; file: () => Promise<void> }
  | { kind: "saveForLater"; values?: CreateFormValues }
  | { kind: "discard" }
  | { kind: "startFresh" }
  | { kind: "cancel"; pendingItemText?: string };

type EndResult<E extends NewTaskEnding> = E extends { kind: "saveForLater" }
  ? SavedForLaterTask
  : E extends { kind: "cancel" }
    ? "asked" | "closed"
    : void;

export interface NewTaskSession {
  readonly owner: string;
  getState(): NewTaskSessionState;
  subscribe(listener: () => void): () => void;
  /* Resolves true once the form is open. `held` is the Autosave App already
     has, used when the server doesn't answer in time. `unless` is asked once
     the Autosave is in; true leaves the form shut (another form got there). */
  open(options?: { held?: Autosave | null; unless?: () => boolean }): Promise<boolean>;
  edit(values: CreateFormValues): void;
  end<E extends NewTaskEnding>(ending: E): Promise<EndResult<E>>;
  /* Keep editing: the leave question comes down. */
  resume(): void;
  /* Shut without forgetting anything, and stop writing. */
  close(): void;
  /* Whether the form differs from a blank one, the yardstick for Cancel asking
     and for Save for later being offered. */
  hasTyping(pendingItemText?: string): boolean;
}

const browserClock: NewTaskSessionClock = { ...browserTimers, now: () => Date.now() };

const CLOSED: NewTaskSessionState = { phase: "closed" };

export const createNewTaskSession = ({
  owner,
  request,
  storage,
  clock = browserClock,
  onAutosave,
  onSavedForLater
}: NewTaskSessionDeps): NewTaskSession => {
  let state: NewTaskSessionState = CLOSED;
  const listeners = new Set<() => void>();
  /* Bumped by every open and close, so a load or timer from an earlier open
     cannot act on a later one. */
  let generation = 0;
  let fresh = initialCreateForm();
  /* What this open measures "moved since open" against: the restored values,
     or the blank after Start fresh. */
  let openedWith = fresh;
  /* Whether an Autosave is out there, as far as this session knows. */
  let onDisk = false;
  let timer: unknown = null;
  /* Writes, one after another, so an older one never lands after a newer one. */
  let writes: Promise<unknown> = Promise.resolve();

  const set = (next: NewTaskSessionState): void => {
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const patch = (next: Partial<Extract<NewTaskSessionState, { phase: "open" }>>): void => {
    if (state.phase === "open") set({ ...state, ...next });
  };
  const stopTimer = (): void => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };
  const shut = (): void => {
    generation += 1;
    stopTimer();
    set(CLOSED);
  };

  const keep = (values: CreateFormValues): void => {
    onDisk = true;
    writes = writes
      .then(async () => {
        if (await keepAutosaveRequest(request, values)) clearDraft(storage, owner);
        else writeDraft(storage, owner, values, clock.now());
      })
      .catch(() => {});
  };

  const forget = (): void => {
    clearDraft(storage, owner);
    onDisk = false;
    writes = writes
      .then(async () => {
        onAutosave?.(null);
        await forgetAutosaveRequest(request);
      })
      .catch(() => {});
  };

  const tick = (): void => {
    timer = null;
    if (state.phase !== "open" || state.ending) return;
    const action = draftAction({
      changedFromBlank: formHasChanges(fresh, state.values),
      movedSinceOpen: formHasChanges(openedWith, state.values),
      onDisk
    });
    if (action === "write") keep(state.values);
    else if (action === "clear") forget();
  };

  const schedule = (): void => {
    stopTimer();
    timer = clock.setTimeout(tick, UNSAVED_SAVE_DEBOUNCE_MS);
  };

  /* An ending that files or saves: no more writes start, the one out lands
     first, and a failure puts the form back as it was. */
  const settleThen = async <T>(kind: NewTaskEndingKind, act: () => Promise<T>): Promise<T> => {
    stopTimer();
    patch({ ending: kind, asking: false });
    await writes;
    try {
      return await act();
    } catch (error) {
      patch({ ending: null });
      schedule();
      throw error;
    }
  };

  const session: NewTaskSession = {
    owner,
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async open({ held = null, unless } = {}) {
      if (state.phase !== "closed") return false;
      generation += 1;
      const mine = generation;
      set({ phase: "opening" });
      const { reached, item } = await loadAutosaveRequest(request, undefined, clock);
      if (mine !== generation) return false;
      const now = clock.now();
      const best = newerAutosave(autosaveCopy(reached ? item : held, now), readDraftCopy(storage, owner, now));
      onAutosave?.(best ? { ownerId: owner, savedAt: new Date(best.savedAt).toISOString(), form: best.values } : null);
      if (unless?.()) {
        shut();
        return false;
      }
      fresh = initialCreateForm();
      openedWith = best?.values ?? fresh;
      onDisk = best !== null;
      set({ phase: "open", values: openedWith, restored: best !== null, asking: false, ending: null });
      return true;
    },

    edit(values) {
      if (state.phase !== "open") return;
      patch({ values });
      schedule();
    },

    async end<E extends NewTaskEnding>(asked: E): Promise<EndResult<E>> {
      type R = EndResult<E>;
      const ending: NewTaskEnding = asked;
      if (state.phase !== "open") throw new Error("The New Task form is not open.");
      const values = state.values;
      switch (ending.kind) {
        case "cancel":
          if (!formHasChanges(fresh, values, ending.pendingItemText)) {
            shut();
            return "closed" as R;
          }
          patch({ asking: true });
          return "asked" as R;
        case "startFresh":
          stopTimer();
          openedWith = initialCreateForm();
          forget();
          patch({ values: openedWith, restored: false, asking: false });
          return undefined as R;
        case "discard":
          stopTimer();
          patch({ ending: "discard" });
          forget();
          await writes;
          shut();
          return undefined as R;
        case "create":
          await settleThen("create", ending.file);
          forget();
          shut();
          return undefined as R;
        case "saveForLater": {
          const saved = await settleThen("saveForLater", () => saveForLaterRequest(request, ending.values ?? values));
          clearDraft(storage, owner);
          onDisk = false;
          onAutosave?.(null);
          onSavedForLater?.(saved);
          shut();
          return saved as R;
        }
      }
    },

    resume() {
      patch({ asking: false });
    },

    close() {
      if (state.phase !== "closed") shut();
    },

    hasTyping(pendingItemText = "") {
      return state.phase === "open" && formHasChanges(fresh, state.values, pendingItemText);
    }
  };
  return session;
};

/* ── React ──────────────────────────────────────────────── */

/* One session per person, made when they are first seen and closed when the
   person changes (the dev user picker). The deps are read once, at creation, so
   a later render's callbacks can never act for the new person. Closed by
   comparing with the last one rather than in an effect cleanup, which StrictMode
   and a dev hot reload also run, and which would shut a form mid-typing. */
export const useNewTaskSession = (deps: NewTaskSessionDeps): NewTaskSession => {
  const session = useMemo(() => createNewTaskSession(deps), [deps.owner]);
  const previous = useRef<NewTaskSession | null>(null);
  useEffect(() => {
    if (previous.current && previous.current !== session) previous.current.close();
    previous.current = session;
  }, [session]);
  return session;
};

const noSubscribe = (): (() => void) => () => {};

/* The session's state, or `closed` for a form with no session. A selector that
   returns a primitive re-renders only when that changes; the form, which holds
   its values here, selects the whole state. */
export const useNewTaskSessionState = <T,>(
  session: NewTaskSession | undefined,
  select: (state: NewTaskSessionState) => T
): T => {
  const snapshot = (): T => select(session ? session.getState() : CLOSED);
  return useSyncExternalStore(session ? session.subscribe : noSubscribe, snapshot, snapshot);
};
