/* One New Task form's life (#467): opening on the newer Autosave, writing
   it as the person types, and every way the form ends. A reopened Task Draft
   runs through it too (#469), with its typing kept on its own record, and so
   does a Humperdink arrival's LOI Check (#473). A plain object handed
   its request function, storage and clock, with a thin React hook wrapper at
   the bottom. App and the form only call it. */
import type { Autosave, SavedForLaterTask } from "@loan-tasks/shared";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  autosaveCopy,
  clearDraft,
  clearUnsavedCopy,
  draftAction,
  newerAutosave,
  readDraftCopy,
  readUnsavedCopy,
  writeDraft,
  writeUnsavedCopy
} from "./create-form-draft";
import type { UnsavedCopyBase } from "./create-form-draft";
import type { DraftStorage } from "./create-form-draft";
import { formHasChanges, initialCreateForm } from "./create-form-state";
import type { CreateFormValues } from "./create-form-state";
import { moveAutosaveAside } from "./humperdink-arrival";
import {
  UNSAVED_SAVE_DEBOUNCE_MS,
  browserTimers,
  discardUnsavedRequest,
  forgetAutosaveRequest,
  keepAutosaveRequest,
  keepUnsavedRequest,
  loadAutosaveRequest,
  removeSavedForLaterRequest,
  reopenSavedForLaterRequest,
  saveForLaterRequest,
  unsavedAction
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
  /* A Task Draft saved; `replaced` is the record a reopened form came from. */
  onSavedForLater?: (item: SavedForLaterTask, replaced?: string) => void;
  /* A reopened record's latest copy, fetched on the way in. */
  onSavedForLaterLatest?: (item: SavedForLaterTask) => void;
  /* A reopened record's unsaved typing landed, or cleared (null), for the
     Task Drafts row's marker (#475). */
  onSavedForLaterUnsaved?: (id: string, unsaved: CreateFormValues | null) => void;
  /* A record that is off the server: gone on reopen, created, or discarded. */
  onSavedForLaterGone?: (id: string) => void;
  /* Word for the person about an ending that went through only in part, or
     about a form an arrival could not put aside. */
  notify?: (message: string, variant: "warn" | "error") => void;
}

/* A fresh New Task form, a reopened Task Draft (#469), or a Humperdink
   arrival's LOI Check (#473). `held`: the old Autosave could not be moved to
   Task Drafts, so this form never writes or forgets the Autosave. */
export type NewTaskMode =
  | { kind: "fresh" }
  | { kind: "reopened"; record: SavedForLaterTask }
  | { kind: "arrival"; held: boolean };

export type ReopenOutcome = "opened" | "gone" | "skipped";

/* `dropped`: a form was open that could not be put aside, and stays. */
export type ArrivalOutcome = "opened" | "dropped" | "skipped";

export type NewTaskEndingKind = "create" | "saveForLater" | "discard" | "startFresh" | "cancel";

export type NewTaskSessionState =
  | { phase: "closed" }
  | { phase: "opening" }
  | {
      phase: "open";
      mode: NewTaskMode;
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
  /* Opens on a Task Draft's latest copy, or on `item` when the server can't be
     reached. `unless` as for `open`. */
  reopen(item: SavedForLaterTask, options?: { unless?: () => boolean }): Promise<ReopenOutcome>;
  /* A Humperdink arrival (#412, #413, #420): puts aside a fresh form opened
     while the tab loaded, moves a worthwhile Autosave to Task Drafts, calls
     `load`, then opens a blank LOI Check. An open press waits for it. `unless`
     is asked after the move; true opens nothing and skips `load`. */
  arrive(options: { load: () => void; unless?: () => boolean }): Promise<ArrivalOutcome>;
  /* A form typed into while nobody was known, carried into this session. It
     never writes or forgets the Autosave. */
  adopt(values: CreateFormValues): void;
  edit(values: CreateFormValues): void;
  /* The Fraud seeder's half-typed item, which Save for later folds in. */
  notePendingItem(text: string): void;
  /* Open and unchanged since it opened (or since Start fresh). */
  untouched(): boolean;
  end<E extends NewTaskEnding>(ending: E): Promise<EndResult<E>>;
  /* Keep editing: the leave question comes down. */
  resume(): void;
  /* Shut without forgetting anything, and stop writing. */
  close(): void;
  /* Whether the form differs from a blank one, the yardstick for Cancel asking
     and for Save for later being offered. */
  hasTyping(pendingItemText?: string): boolean;
}

/* The form as Save for later keeps it: a Fraud Check's half-typed item folded
   into its list, as Create folds it. */
export const withPendingItem = (values: CreateFormValues, pendingItemText: string): CreateFormValues => {
  const item = values.taskType === "FRAUD" ? pendingItemText.trim() : "";
  return item ? { ...values, initialItems: [...values.initialItems, item] } : values;
};

const browserClock: NewTaskSessionClock = { ...browserTimers, now: () => Date.now() };

const CLOSED: NewTaskSessionState = { phase: "closed" };

/* Whether the server still holds the record a browser copy was written on. */
const sameBase = (base: UnsavedCopyBase, latest: SavedForLaterTask): boolean => {
  if (base.savedAt !== latest.savedAt) return false;
  if (base.unsaved === undefined) return true;
  return base.unsaved && latest.unsaved ? !formHasChanges(base.unsaved, latest.unsaved) : !base.unsaved && !latest.unsaved;
};

export const createNewTaskSession = ({
  owner,
  request,
  storage,
  clock = browserClock,
  onAutosave,
  onSavedForLater,
  onSavedForLaterLatest,
  onSavedForLaterUnsaved,
  onSavedForLaterGone,
  notify
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
  let mode: NewTaskMode = { kind: "fresh" };
  /* A reopened record's unsaved typing as last sent, or null for none. */
  let sent: CreateFormValues | null = null;
  /* The record as the server last held it, for a browser copy of typing it
     didn't take (#476); and whether this browser holds one. */
  let base: UnsavedCopyBase = { savedAt: "" };
  let copied = false;
  let timer: unknown = null;
  /* Writes, one after another, so an older one never lands after a newer one. */
  let writes: Promise<unknown> = Promise.resolve();
  let pendingItem = "";
  /* An arrival under way, which an open waits behind. */
  let arriving: Promise<unknown> | null = null;
  /* Nobody known yet (#478): Teams sign-in is out, and requests may already go
     out as the person whose Autosave this session never loaded. */
  const known = owner !== "";
  /* A form carried over from sign-in, which never loaded the Autosave either. */
  let carried = false;
  /* An arrival whose move didn't land has no seat on the Autosave. */
  const seated = (): boolean => known && !carried && !(mode.kind === "arrival" && mode.held);

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
    if (!seated()) return;
    clearDraft(storage, owner);
    onDisk = false;
    writes = writes
      .then(async () => {
        onAutosave?.(null);
        await forgetAutosaveRequest(request);
      })
      .catch(() => {});
  };

  /* A reopened record's typing goes to its unsaved slot. What was sent moves
     when a send goes out; one that fails puts it back unless a newer one went. */
  const sendUnsaved = (record: SavedForLaterTask, values: CreateFormValues): void => {
    const before = sent;
    const action = unsavedAction({
      differsFromSave: formHasChanges(record.form, values),
      differsFromSent: before !== null && formHasChanges(before, values),
      sentExists: before !== null
    });
    if (action === "keep") {
      /* Nothing to send; the copy goes once the server is known to hold this. */
      writes = writes.then(() => {
        if (copied && base.unsaved !== undefined && !formHasChanges(base.unsaved ?? record.form, values)) dropCopy(record.id);
      });
      return;
    }
    const next = action === "write" ? values : null;
    sent = next;
    writes = writes
      .then(async () => {
        if (next ? await keepUnsavedRequest(request, record.id, next) : await discardUnsavedRequest(request, record.id)) {
          base = { savedAt: record.savedAt, unsaved: next };
          dropCopy(record.id);
          onSavedForLaterUnsaved?.(record.id, next);
          return;
        }
        if (sent === next) sent = before;
        writeUnsavedCopy(storage, owner, record.id, { values, base });
        copied = true;
      })
      .catch(() => {});
  };

  const dropCopy = (id: string): void => {
    clearUnsavedCopy(storage, owner, id);
    copied = false;
  };

  const removeRecord = async (id: string, failed: string): Promise<void> => {
    if (await removeSavedForLaterRequest(request, id)) onSavedForLaterGone?.(id);
    else notify?.(failed, "warn");
  };

  const tick = (): void => {
    timer = null;
    if (state.phase !== "open" || state.ending) return;
    if (mode.kind === "reopened") {
      sendUnsaved(mode.record, state.values);
      return;
    }
    if (!seated()) return;
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
  const settleThen = async <T>(mine: number, kind: NewTaskEndingKind, act: () => Promise<T>): Promise<T> => {
    stopTimer();
    patch({ ending: kind, asking: false });
    await writes;
    try {
      return await act();
    } catch (error) {
      if (generation === mine) {
        patch({ ending: null });
        schedule();
      }
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
      if (arriving) await arriving;
      if (state.phase !== "closed") return false;
      generation += 1;
      const mine = generation;
      set({ phase: "opening" });
      const { reached, item } = known ? await loadAutosaveRequest(request, undefined, clock) : { reached: false, item: null };
      if (mine !== generation) return false;
      const now = clock.now();
      const best = known ? newerAutosave(autosaveCopy(reached ? item : held, now), readDraftCopy(storage, owner, now)) : null;
      if (known) onAutosave?.(best ? { ownerId: owner, savedAt: new Date(best.savedAt).toISOString(), form: best.values } : null);
      if (unless?.()) {
        shut();
        return false;
      }
      fresh = initialCreateForm();
      openedWith = best?.values ?? fresh;
      onDisk = best !== null;
      pendingItem = "";
      carried = false;
      mode = { kind: "fresh" };
      set({ phase: "open", mode, values: openedWith, restored: best !== null, asking: false, ending: null });
      return true;
    },

    async reopen(item, { unless } = {}) {
      const mine = generation;
      let reached = false;
      const noteReached: SavedForLaterRequest = async (path, init) => {
        const answer = await request(path, init);
        reached = true;
        return answer as never;
      };
      const latest = await reopenSavedForLaterRequest(noteReached, item);
      if (mine !== generation) return "skipped";
      if (!latest) {
        clearUnsavedCopy(storage, owner, item.id);
        onSavedForLaterGone?.(item.id);
        notify?.("That Task Draft is gone. It was created or removed somewhere else.", "warn");
        return "gone";
      }
      onSavedForLaterLatest?.(latest);
      /* A New Task still loading gives way: the first form to land wins. */
      if (state.phase === "open" || unless?.()) return "skipped";
      generation += 1;
      /* This browser's copy, while the server still holds what it was written
         on. Without the server, `latest` is the board's copy, which may lag
         the server's unsaved typing: only a newer save outranks the copy. */
      const stored = readUnsavedCopy(storage, owner, latest.id);
      const copy = stored && sameBase(stored.base, latest) ? stored.values : null;
      if (stored && !copy && reached) clearUnsavedCopy(storage, owner, latest.id);
      const source = copy ?? latest.unsaved ?? latest.form;
      fresh = initialCreateForm();
      openedWith = { ...source, initialItems: [...source.initialItems] };
      onDisk = false;
      pendingItem = "";
      sent = latest.unsaved ?? null;
      if (reached) base = { savedAt: latest.savedAt, unsaved: sent };
      else base = copy && stored ? stored.base : { savedAt: latest.savedAt };
      copied = stored !== null && (copy !== null || !reached);
      const { unsaved: _, ...saved } = latest;
      const record = copy ? (formHasChanges(latest.form, copy) ? { ...saved, unsaved: copy } : saved) : latest;
      carried = false;
      mode = { kind: "reopened", record };
      set({ phase: "open", mode, values: openedWith, restored: false, asking: false, ending: null });
      if (copy) sendUnsaved(latest, copy);
      return "opened";
    },

    async arrive({ load, unless }) {
      const run = (async (): Promise<ArrivalOutcome> => {
        if (state.phase === "open") {
          if (mode.kind !== "fresh" || state.ending) {
            load();
            return "dropped";
          }
          if (!session.hasTyping(pendingItem)) shut();
          else {
            try {
              await session.end({ kind: "saveForLater", values: withPendingItem(state.values, pendingItem) });
            } catch {
              notify?.("Couldn't open the Humperdink task. Your form is still here.", "error");
              load();
              return "dropped";
            }
          }
        }
        const moved = known ? await moveAutosaveAside(request, storage, owner, { now: clock.now(), timers: clock }) : { kind: "held" as const };
        if (unless?.()) return "skipped";
        load();
        /* A New Task that opened while the move was out keeps the screen; one
           still loading gives way. */
        if (state.phase === "open") return "skipped";
        generation += 1;
        fresh = initialCreateForm({ taskType: "LOI" });
        openedWith = fresh;
        onDisk = false;
        pendingItem = "";
        carried = false;
        mode = { kind: "arrival", held: moved.kind === "held" };
        set({ phase: "open", mode, values: openedWith, restored: false, asking: false, ending: null });
        return "opened";
      })();
      arriving = run;
      try {
        return await run;
      } finally {
        if (arriving === run) arriving = null;
      }
    },

    adopt(values) {
      if (state.phase !== "closed") return;
      generation += 1;
      fresh = initialCreateForm();
      openedWith = fresh;
      onDisk = false;
      pendingItem = "";
      carried = true;
      mode = { kind: "fresh" };
      set({ phase: "open", mode, values, restored: false, asking: false, ending: null });
    },

    edit(values) {
      if (state.phase !== "open") return;
      patch({ values });
      schedule();
    },

    notePendingItem(text) {
      pendingItem = text;
    },

    untouched() {
      return state.phase === "open" && !formHasChanges(openedWith, state.values);
    },

    async end<E extends NewTaskEnding>(asked: E): Promise<EndResult<E>> {
      type R = EndResult<E>;
      const ending: NewTaskEnding = asked;
      if (state.phase !== "open") throw new Error("The New Task form is not open.");
      const values = state.values;
      /* This ending's own form: another may open while it is out, and must not
         be deleted, saved over or shut by it. */
      const current = mode;
      const mine = generation;
      const shutMine = (): void => {
        if (generation === mine) shut();
      };
      switch (ending.kind) {
        case "cancel":
          if (current.kind !== "reopened" && !formHasChanges(fresh, values, ending.pendingItemText)) {
            shut();
            return "closed" as R;
          }
          patch({ asking: true });
          return "asked" as R;
        case "startFresh":
          if (current.kind === "reopened") return undefined as R;
          stopTimer();
          openedWith = initialCreateForm();
          forget();
          patch({ values: openedWith, restored: false, asking: false });
          return undefined as R;
        case "discard":
          stopTimer();
          patch({ ending: "discard" });
          if (current.kind === "reopened") {
            await writes;
            dropCopy(current.record.id);
            await removeRecord(current.record.id, "Couldn't delete that Task Draft. It's still on Task Drafts.");
            shutMine();
            return undefined as R;
          }
          forget();
          await writes;
          shutMine();
          return undefined as R;
        case "create":
          await settleThen(mine, "create", ending.file);
          if (current.kind === "reopened") {
            dropCopy(current.record.id);
            await removeRecord(current.record.id, "Task created, but its Task Draft couldn't be removed.");
            shutMine();
            return undefined as R;
          }
          forget();
          shutMine();
          return undefined as R;
        case "saveForLater": {
          if (current.kind === "reopened") {
            const { id } = current.record;
            const saved = await settleThen(mine, "saveForLater", () => saveForLaterRequest(request, ending.values ?? values, id));
            dropCopy(id);
            onSavedForLater?.(saved, id);
            shutMine();
            return saved as R;
          }
          const clearsAutosave = seated();
          const saved = await settleThen(mine, "saveForLater", () => saveForLaterRequest(request, ending.values ?? values, undefined, clearsAutosave));
          if (clearsAutosave) {
            clearDraft(storage, owner);
            onDisk = false;
            onAutosave?.(null);
          }
          onSavedForLater?.(saved);
          shutMine();
          return saved as R;
        }
      }
    },

    resume() {
      patch({ asking: false });
    },

    close() {
      /* Closed too while a Task Draft is loading, so it never opens. */
      if (state.phase !== "closed") shut();
      else generation += 1;
    },

    hasTyping(pendingItemText = "") {
      return state.phase === "open" && formHasChanges(fresh, state.values, pendingItemText);
    }
  };
  return session;
};

/* Once sign-in names the person, typing from a form opened before that moves
   into their session rather than closing with the old one (#478). */
export const carrySignInForm = (from: NewTaskSession, to: NewTaskSession): void => {
  const state = from.getState();
  if (from.owner !== "" || state.phase !== "open" || state.ending || !from.hasTyping()) return;
  to.adopt(state.values);
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
    if (previous.current && previous.current !== session) carrySignInForm(previous.current, session);
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
