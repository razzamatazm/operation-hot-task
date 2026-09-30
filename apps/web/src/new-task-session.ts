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
  filedForgetOwed,
  newerAutosave,
  oweFiledForget,
  readDraftCopy,
  readUnsavedCopy,
  typedOver,
  writeDraft,
  writeUnsavedCopy
} from "./create-form-draft";
import type { AutosaveCopy, UnsavedCopyBase } from "./create-form-draft";
import type { DraftStorage } from "./create-form-draft";
import { formHasChanges, initialCreateForm } from "./create-form-state";
import type { CreateFormValues } from "./create-form-state";
import {
  AUTOSAVE_LOAD_TIMEOUT_MS,
  UNSAVED_SAVE_DEBOUNCE_MS,
  browserTimers,
  discardUnsavedRequest,
  forgetAutosaveRequest,
  keepUnsavedRequest,
  loadAutosaveRequest,
  removeSavedForLaterRequest,
  reopenSavedForLaterRequest,
  saveForLaterRequest,
  stampedKeepAutosaveRequest
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
      /* The Fraud seeder's half-typed item, which Save for later folds in. */
      pendingItem: string;
    };

export type NewTaskEnding =
  | { kind: "create"; file: () => Promise<void> }
  | { kind: "saveForLater" }
  | { kind: "discard" }
  | { kind: "startFresh" }
  | { kind: "cancel" };

type EndResult<E extends NewTaskEnding> = E extends { kind: "saveForLater" }
  ? SavedForLaterTask
  : E extends { kind: "cancel" }
    ? "asked" | "closed"
    : void;

export interface NewTaskSession {
  readonly owner: string;
  getState(): NewTaskSessionState;
  subscribe(listener: () => void): () => void;
  /* Resolves true once the form is open, on the newer Autosave. A server that
     doesn't answer in time leaves the one this session last reported. False
     when a form is already up or another got there first. */
  open(): Promise<boolean>;
  /* Opens on a Task Draft's latest copy, or on `item` when the server can't be
     reached. */
  reopen(item: SavedForLaterTask): Promise<ReopenOutcome>;
  /* A Humperdink arrival (#412, #413, #420): puts aside a fresh form opened
     while the tab loaded, moves a worthwhile Autosave to Task Drafts, calls
     `load`, then opens a blank LOI Check. An open press waits for it. */
  arrive(options: { load: () => void }): Promise<ArrivalOutcome>;
  /* A form typed into while nobody was known, carried into this session. It
     never writes or forgets the Autosave. */
  adopt(values: CreateFormValues, pendingItem?: string): void;
  edit(values: CreateFormValues): void;
  notePendingItem(text: string): void;
  /* Open and unchanged since it opened (or since Start fresh). */
  untouched(): boolean;
  /* `busy`: another ending is still out, and this one did nothing (#496). */
  end<E extends NewTaskEnding>(ending: E): Promise<EndResult<E> | "busy">;
  /* Keep editing: the leave question comes down. */
  resume(): void;
  /* Shut and stop writing, forgetting only a form typed back to blank. */
  close(): void;
  /* Whether the form differs from a blank one, the yardstick for Cancel asking
     and for Save for later being offered. */
  hasTyping(): boolean;
  /* The Task Drafts tab's Autosaved row: the newer Autosave, reported through
     `onAutosave`. */
  refreshAutosave(): Promise<void>;
  /* The Autosaved row's delete. True once it is gone. */
  deleteAutosave(): Promise<boolean>;
  /* A Task Draft row's delete. True once it is gone. */
  deleteDraft(item: Pick<SavedForLaterTask, "id">): Promise<boolean>;
  /* The person changed: nothing more is reported to App. */
  retire(): void;
}

/* The form as Save for later keeps it: a Fraud Check's half-typed item folded
   into its list, as Create folds it. */
const withPendingItem = (values: CreateFormValues, pendingItemText: string): CreateFormValues => {
  const item = values.taskType === "FRAUD" ? pendingItemText.trim() : "";
  return item ? { ...values, initialItems: [...values.initialItems, item] } : values;
};

const browserClock: NewTaskSessionClock = { ...browserTimers, now: () => Date.now() };

const CLOSED: NewTaskSessionState = { phase: "closed" };

/* Whether the server still holds the record a browser copy was written on. */
const sameBase = (base: UnsavedCopyBase, latest: SavedForLaterTask): boolean =>
  typedOver(
    base.unsaved === undefined ? { savedAt: Date.parse(base.savedAt) } : { savedAt: Date.parse(base.savedAt), unsaved: base.unsaved },
    { savedAt: Date.parse(latest.savedAt), unsaved: latest.unsaved ?? null }
  );

/* What a form does about its typing now, one rule for the Autosave and a
   reopened record's unsaved slot: typing back to `base` clears a copy out
   there, typing that differs from the copy out there is written, and anything
   else is left, so opening a copy never restarts its clock. */
const writeStep = (base: CreateFormValues, stored: CreateFormValues | null, values: CreateFormValues): "write" | "keep" | "clear" => {
  if (!formHasChanges(base, values)) return stored ? "clear" : "keep";
  return !stored || formHasChanges(stored, values) ? "write" : "keep";
};

/* Before a Humperdink arrival's LOI Check opens (#413), a worthwhile Autosave
   becomes a Task Draft, in the one write Save for later makes, which clears the
   slot too. `held`: the server couldn't be asked, the save failed or didn't
   answer in time, and both copies stay exactly where they were. */
type AutosaveMove = { kind: "none" } | { kind: "moved" } | { kind: "held" };

const moveAutosaveAside = async (
  request: SavedForLaterRequest,
  storage: DraftStorage | null,
  owner: string,
  clock: NewTaskSessionClock,
  filed: boolean
): Promise<AutosaveMove> => {
  const { reached, item } = await loadAutosaveRequest(request, AUTOSAVE_LOAD_TIMEOUT_MS, clock);
  if (!reached) return { kind: "held" };
  const now = clock.now();
  const kept = newerAutosave(autosaveCopy(filed ? null : item, now), readDraftCopy(storage, owner, now));
  if (!kept || !formHasChanges(initialCreateForm(), kept.values)) return { kind: "none" };
  let timer: unknown;
  const gaveUp = new Promise<null>((resolve) => {
    timer = clock.setTimeout(() => resolve(null), AUTOSAVE_LOAD_TIMEOUT_MS);
  });
  const saving = saveForLaterRequest(request, kept.values);
  try {
    if (!(await Promise.race([saving, gaveUp]))) {
      /* Still out: if it lands later, the slot is empty and the task is on Task
         Drafts, so the offline copy goes then rather than coming back beside it. */
      saving.then(() => clearDraft(storage, owner), () => {});
      return { kind: "held" };
    }
    clearDraft(storage, owner);
    return { kind: "moved" };
  } catch {
    return { kind: "held" };
  } finally {
    clock.clearTimeout(timer);
  }
};

export const createNewTaskSession = (deps: NewTaskSessionDeps): NewTaskSession => {
  const { owner, request, storage, clock = browserClock } = deps;
  /* Once the person changes, nothing still out reports back to App. */
  let retired = false;
  const tell =
    <A extends unknown[]>(pick: (deps: NewTaskSessionDeps) => ((...args: A) => void) | undefined) =>
    (...args: A): void => {
      if (!retired) pick(deps)?.(...args);
    };
  const onSavedForLater = tell((d) => d.onSavedForLater);
  const onSavedForLaterLatest = tell((d) => d.onSavedForLaterLatest);
  const onSavedForLaterUnsaved = tell((d) => d.onSavedForLaterUnsaved);
  const onSavedForLaterGone = tell((d) => d.onSavedForLaterGone);
  const notify = tell((d) => d.notify);
  /* The owner's Autosave as last reported, what an open falls back on when the
     server doesn't answer in time. */
  let lastAutosave: Autosave | null = null;
  const reportAutosave = tell((d) => d.onAutosave);
  const onAutosave = (autosave: Autosave | null): void => {
    lastAutosave = autosave;
    reportAutosave(autosave);
  };
  let state: NewTaskSessionState = CLOSED;
  const listeners = new Set<() => void>();
  /* Bumped by every open and close, so a load or timer from an earlier open
     cannot act on a later one. */
  let generation = 0;
  let fresh = initialCreateForm();
  /* What this open measures "moved since open" against: the restored values,
     or the blank after Start fresh. */
  let openedWith = fresh;
  /* The Autosave out there, on the server or offline, as far as this session
     knows, or null for none. */
  let stored: CreateFormValues | null = null;
  let mode: NewTaskMode = { kind: "fresh" };
  /* A reopened record's unsaved typing as last sent, or null for none. */
  let sent: CreateFormValues | null = null;
  /* The record as the server last held it, for a browser copy of typing it
     didn't take (#476); and whether this browser holds one. */
  let base: UnsavedCopyBase = { savedAt: "" };
  let copied = false;
  /* The server's stamp on the Autosave it holds, null for none, undefined when
     not known: what an offline copy is written over (#470). */
  let serverAt: number | null | undefined;
  let timer: unknown = null;
  /* Writes, one after another, so an older one never lands after a newer one. */
  let writes: Promise<unknown> = Promise.resolve();
  /* An arrival under way, which an open waits behind. */
  let arriving: Promise<unknown> | null = null;
  /* Each Task Draft's newest reopen: an older one landing late says nothing. */
  const reopens = new Map<string, number>();
  let presses = 0;
  /* Nobody known yet (#478): Teams sign-in is out, and requests may already go
     out as the person whose Autosave this session never loaded. */
  const known = owner !== "";
  /* A form carried over from sign-in, which never loaded the Autosave either. */
  let carriedFromSignIn = false;
  /* An arrival whose move didn't land has no seat on the Autosave. */
  const seated = (): boolean => known && !carriedFromSignIn && !(mode.kind === "arrival" && mode.held);
  /* A forget that has not landed (#472, #471), kept here as well as in
     storage so it holds where storage is locked down. */
  let forgetOwed = false;
  /* Owed-forget retries still out; one that gave up can outlive a later one. */
  let retrying = 0;
  /* Writes and forgets in the order asked, so a write asked before the latest
     forget can neither put an offline copy back nor settle what it owes. */
  let asked = 0;
  let forgotAt = 0;
  const owed = (): boolean => forgetOwed || filedForgetOwed(storage, owner);
  const owe = (value: boolean): void => {
    forgetOwed = value;
    oweFiledForget(storage, owner, value);
  };

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
    stored = values;
    const mine = ++asked;
    writes = writes
      .then(async () => {
        /* While a timed-out forget is still out, a server write could land
           before it and be deleted, so the typing stays offline. */
        const { landed, savedAt } = retrying === 0 ? await stampedKeepAutosaveRequest(request, values) : { landed: false, savedAt: undefined };
        if (mine < forgotAt) return;
        if (landed) {
          serverAt = savedAt;
          clearDraft(storage, owner);
          if (owed()) owe(false);
        } else writeDraft(storage, owner, values, clock.now(), serverAt);
      })
      .catch(() => {});
  };

  /* Owed until it lands, so typing thrown away never opens again, even when
     the server can't be reached. */
  const forget = (): void => {
    if (!seated()) return;
    const mine = (forgotAt = ++asked);
    clearDraft(storage, owner);
    stored = null;
    serverAt = null;
    owe(true);
    writes = writes
      .then(async () => {
        onAutosave(null);
        if ((await forgetAutosaveRequest(request)) && mine === forgotAt && owed()) owe(false);
      })
      .catch(() => {});
  };

  /* A reopened record's typing goes to its unsaved slot. What was sent moves
     when a send goes out; one that fails puts it back unless a newer one went. */
  const sendUnsaved = (record: SavedForLaterTask, values: CreateFormValues): void => {
    const before = sent;
    const action = writeStep(record.form, before, values);
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
          onSavedForLaterUnsaved(record.id, next);
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
    if (await removeSavedForLaterRequest(request, id)) onSavedForLaterGone(id);
    else notify(failed, "warn");
  };

  const tick = (): void => {
    timer = null;
    if (state.phase !== "open" || state.ending) return;
    if (mode.kind === "reopened") {
      sendUnsaved(mode.record, state.values);
      return;
    }
    if (!seated()) return;
    const action = writeStep(fresh, stored, state.values);
    if (action === "write") keep(state.values);
    else if (action === "clear") forget();
  };

  /* A form typed back to blank and shut before its clear went out still
     forgets its Autosave. */
  const shutEmptied = (): void => {
    if (state.phase === "open" && !state.ending && stored && !formHasChanges(fresh, state.values)) forget();
    shut();
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

  /* Sends a filed task's owed forget again, after any write still out, waiting
     no longer than an open waits on the Autosave. True while the server's copy
     may still be the filed task. */
  const retryOwedForget = async (): Promise<boolean> => {
    if (!owed()) return false;
    let settled = false;
    retrying += 1;
    const mine = asked;
    const retry = writes.then(async () => {
      if ((await forgetAutosaveRequest(request)) && forgotAt <= mine) owe(false);
      settled = true;
    });
    retry.then(
      () => (retrying -= 1),
      () => (retrying -= 1)
    );
    let timer: unknown;
    const gaveUp = new Promise<void>((resolve) => {
      timer = clock.setTimeout(resolve, AUTOSAVE_LOAD_TIMEOUT_MS);
    });
    /* A retry that never answers must not hold every later write behind it. */
    writes = Promise.race([retry.catch(() => {}), gaveUp]);
    try {
      await Promise.race([retry, gaveUp]);
    } finally {
      clock.clearTimeout(timer);
    }
    return !settled || owed();
  };

  /* The newer of the server's Autosave and this browser's offline copy. A
     server that wasn't reached leaves the one last reported in the running. */
  const newestAutosave = (reached: boolean, item: Autosave | null, filed: boolean): { best: AutosaveCopy | null; offline: AutosaveCopy | null } => {
    const now = clock.now();
    const offline = readDraftCopy(storage, owner, now);
    const server = filed ? null : reached ? item : lastAutosave;
    return { best: newerAutosave(autosaveCopy(server, now), offline, reached), offline };
  };
  const reportNewest = (best: AutosaveCopy | null): void =>
    onAutosave(best ? { ownerId: owner, savedAt: new Date(best.savedAt).toISOString(), form: best.values } : null);

  const opened = (next: NewTaskMode, values: CreateFormValues, options: { restored?: boolean; pendingItem?: string } = {}): void => {
    carriedFromSignIn = false;
    mode = next;
    set({ phase: "open", mode, values, restored: options.restored ?? false, asking: false, ending: null, pendingItem: options.pendingItem ?? "" });
  };

  const session: NewTaskSession = {
    owner,
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async open() {
      if (arriving) await arriving;
      if (state.phase !== "closed") return false;
      generation += 1;
      const mine = generation;
      set({ phase: "opening" });
      const filed = known && (await retryOwedForget());
      if (mine !== generation) return false;
      const { reached, item } = known && !filed ? await loadAutosaveRequest(request, undefined, clock) : { reached: false, item: null };
      if (mine !== generation) return false;
      const { best, offline } = known ? newestAutosave(reached, item, filed) : { best: null, offline: null };
      /* Unreached, the server is as the offline copy last knew it: a write
         landing from here would have removed that copy. */
      const stamp = item ? Date.parse(item.savedAt) : null;
      serverAt = filed ? null : !reached ? offline?.over : Number.isNaN(stamp) ? undefined : stamp;
      if (known) reportNewest(best);
      fresh = initialCreateForm();
      openedWith = best?.values ?? fresh;
      stored = best?.values ?? null;
      opened({ kind: "fresh" }, openedWith, { restored: best !== null });
      return true;
    },

    async reopen(item) {
      const mine = generation;
      const press = ++presses;
      reopens.set(item.id, press);
      let reached = false;
      const noteReached: SavedForLaterRequest = async (path, init) => {
        const answer = await request(path, init);
        reached = true;
        return answer as never;
      };
      const latest = await reopenSavedForLaterRequest(noteReached, item);
      if (reopens.get(item.id) !== press) return "skipped";
      reopens.delete(item.id);
      /* The row hears what the fetch found even when the form has moved on (#497). */
      if (!latest) {
        clearUnsavedCopy(storage, owner, item.id);
        onSavedForLaterGone(item.id);
        notify("That Task Draft is gone. It was created or removed somewhere else.", "warn");
        return "gone";
      }
      onSavedForLaterLatest(latest);
      /* Closed, or New Task pressed or still loading: the first form to land wins. */
      if (mine !== generation || state.phase === "open") return "skipped";
      generation += 1;
      /* This browser's copy, while the server still holds what it was written
         on. Without the server, `latest` is the board's copy, which may lag
         the server's unsaved typing: only a newer save outranks the copy. */
      const kept = readUnsavedCopy(storage, owner, latest.id);
      const copy = kept && sameBase(kept.base, latest) ? kept.values : null;
      if (kept && !copy && reached) clearUnsavedCopy(storage, owner, latest.id);
      const source = copy ?? latest.unsaved ?? latest.form;
      fresh = initialCreateForm();
      openedWith = { ...source, initialItems: [...source.initialItems] };
      stored = null;
      sent = latest.unsaved ?? null;
      if (reached) base = { savedAt: latest.savedAt, unsaved: sent };
      else base = copy && kept ? kept.base : { savedAt: latest.savedAt };
      copied = kept !== null && (copy !== null || !reached);
      const { unsaved: _, ...saved } = latest;
      const record = copy ? (formHasChanges(latest.form, copy) ? { ...saved, unsaved: copy } : saved) : latest;
      opened({ kind: "reopened", record }, openedWith);
      if (copy) sendUnsaved(latest, copy);
      return "opened";
    },

    async arrive({ load }) {
      const run = (async (): Promise<ArrivalOutcome> => {
        if (state.phase === "open") {
          if (mode.kind !== "fresh" || state.ending) {
            load();
            return "dropped";
          }
          if (!session.hasTyping()) shut();
          else {
            try {
              await session.end({ kind: "saveForLater" });
            } catch {
              notify("Couldn't open the Humperdink task. Your form is still here.", "error");
              load();
              return "dropped";
            }
          }
        }
        const moved = known ? await moveAutosaveAside(request, storage, owner, clock, owed()) : { kind: "held" as const };
        if (retired) return "skipped";
        load();
        /* A New Task that opened while the move was out keeps the screen; one
           still loading gives way. */
        if (state.phase === "open") return "skipped";
        generation += 1;
        fresh = initialCreateForm({ taskType: "LOI" });
        openedWith = fresh;
        stored = null;
        opened({ kind: "arrival", held: moved.kind === "held" }, openedWith);
        return "opened";
      })();
      arriving = run;
      try {
        return await run;
      } finally {
        if (arriving === run) arriving = null;
      }
    },

    adopt(values, pendingItem = "") {
      if (state.phase !== "closed") return;
      generation += 1;
      fresh = initialCreateForm();
      openedWith = fresh;
      stored = null;
      opened({ kind: "fresh" }, values, { pendingItem });
      carriedFromSignIn = true;
    },

    edit(values) {
      if (state.phase !== "open") return;
      patch({ values });
      schedule();
    },

    notePendingItem(text) {
      patch({ pendingItem: text });
    },

    untouched() {
      return state.phase === "open" && !formHasChanges(openedWith, state.values);
    },

    async end<E extends NewTaskEnding>(asked: E): Promise<EndResult<E> | "busy"> {
      type R = EndResult<E>;
      const ending: NewTaskEnding = asked;
      if (state.phase !== "open") throw new Error("The New Task form is not open.");
      /* The ending out decides whether the form closes or stays. */
      if (state.ending) return "busy";
      const { values, pendingItem } = state;
      /* This ending's own form: another may open while it is out, and must not
         be deleted, saved over or shut by it. */
      const current = mode;
      const mine = generation;
      const shutMine = (): void => {
        if (generation === mine) shut();
      };
      switch (ending.kind) {
        case "cancel":
          if (current.kind !== "reopened" && !session.hasTyping()) {
            shutEmptied();
            return "closed" as R;
          }
          patch({ asking: true });
          return "asked" as R;
        case "startFresh":
          if (current.kind === "reopened") return undefined as R;
          stopTimer();
          openedWith = initialCreateForm();
          forget();
          patch({ values: openedWith, restored: false, asking: false, pendingItem: "" });
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
          if (!known) {
            /* The form swallows a failed Create, leaving word to whoever failed it. */
            notify("Still signing in. Try Create again in a moment.", "error");
            throw new Error("Still signing in. Try Create again in a moment.");
          }
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
          if (!known) throw new Error("Still signing in. Try Save for later again in a moment.");
          const form = withPendingItem(values, pendingItem);
          if (current.kind === "reopened") {
            const { id } = current.record;
            const saved = await settleThen(mine, "saveForLater", () => saveForLaterRequest(request, form, id));
            dropCopy(id);
            onSavedForLater(saved, id);
            shutMine();
            return saved as R;
          }
          const clearsAutosave = seated();
          const saved = await settleThen(mine, "saveForLater", () => saveForLaterRequest(request, form, undefined, clearsAutosave));
          if (clearsAutosave) {
            clearDraft(storage, owner);
            stored = null;
            if (owed()) owe(false);
            onAutosave(null);
          }
          onSavedForLater(saved);
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
      if (state.phase !== "closed") shutEmptied();
      else generation += 1;
    },

    hasTyping() {
      return state.phase === "open" && formHasChanges(fresh, state.values, state.pendingItem);
    },

    async refreshAutosave() {
      if (!known) return;
      const { reached, item } = await loadAutosaveRequest(request, undefined, clock);
      reportNewest(newestAutosave(reached, item, owed()).best);
    },

    async deleteAutosave() {
      const removed = await forgetAutosaveRequest(request);
      if (removed) owe(false);
      if (retired) return false;
      if (!removed) {
        notify("Couldn't delete the autosaved task. Try again.", "error");
        return false;
      }
      clearDraft(storage, owner);
      onAutosave(null);
      return true;
    },

    async deleteDraft({ id }) {
      const removed = await removeSavedForLaterRequest(request, id);
      if (retired) return false;
      if (!removed) {
        notify("Couldn't delete that Task Draft. Try again.", "error");
        return false;
      }
      clearUnsavedCopy(storage, owner, id);
      onSavedForLaterGone(id);
      return true;
    },

    retire() {
      retired = true;
    }
  };
  return session;
};

/* When the person changes, the old session closes and says nothing more, and
   once sign-in names the person, typing from a form opened before that, the
   Fraud seeder's half-typed item with it, moves into their session rather
   than closing with the old one (#478). */
export const handOver = (from: NewTaskSession, to: NewTaskSession): void => {
  const state = from.getState();
  if (from.owner === "" && state.phase === "open" && !state.ending && from.hasTyping()) to.adopt(state.values, state.pendingItem);
  from.close();
  from.retire();
};

/* ── React ──────────────────────────────────────────────── */

/* One session per person, made when they are first seen and handed over from
   when the person changes (the dev user picker, or sign-in). The deps are read
   once, at creation. Handed over by comparing with the last one rather than in
   an effect cleanup, which StrictMode and a dev hot reload also run, and which
   would shut a form mid-typing. */
export const useNewTaskSession = (deps: NewTaskSessionDeps): NewTaskSession => {
  const session = useMemo(() => createNewTaskSession(deps), [deps.owner]);
  const previous = useRef<NewTaskSession | null>(null);
  useEffect(() => {
    if (previous.current && previous.current !== session) handOver(previous.current, session);
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
