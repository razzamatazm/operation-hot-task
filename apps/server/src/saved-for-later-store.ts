import { randomUUID } from "node:crypto";
import { Autosave, SavedForLaterForm, SavedForLaterTask, isAutosaveExpired, newestSavedFirst } from "@loan-tasks/shared";
import { JsonFile } from "./json-file.js";

interface SavedForLaterData {
  items: SavedForLaterTask[];
  /* The new task form's autosave (#371), at most one per owner. In this file
     rather than one of its own so every rule about who can reach Saved for Later
     tasks, and removing them with their owner, covers it too. Absent from a file
     written before it existed, which reads as nobody having one. */
  autosaves: Autosave[];
}

/* Everyone's autosave that has not aged out by `now`. */
const unexpired = (autosaves: Autosave[], now: number): Autosave[] =>
  autosaves.filter((autosave) => !isAutosaveExpired(autosave.savedAt, now));

/* Saved for Later tasks (#343, ADR-0011), in a file of their own.

   Kept apart from the task store on purpose (rule 3). Every existing reader of
   tasks reads every stored task — maintenance, pool nags, signals, loan rename
   and merge, GET /tasks — so a "not filed" flag among them would make each of
   those responsible for skipping these, and the first one that forgot would
   leak someone's private scratch work or notify about work nobody filed. In a
   file of their own, none of them can reach one.

   Every method takes the owner, and none of them answers for anyone else. There
   is deliberately no "read everything": nothing on the server has a reason to
   see another person's, admins included (rule 2).

   Strict, not lenient: an unreadable file throws rather than reading as empty,
   because empty here means "you have nothing saved" and the next save would
   then write that over whatever the file held. */
export class SavedForLaterStore {
  private readonly file: JsonFile<SavedForLaterData>;

  constructor(filePath: string) {
    this.file = new JsonFile<SavedForLaterData>(filePath, {
      empty: () => ({ items: [], autosaves: [] }),
      decode: (parsed) => {
        const raw = parsed as Partial<SavedForLaterData> | null;
        return {
          items: Array.isArray(raw?.items) ? raw.items : [],
          autosaves: Array.isArray(raw?.autosaves) ? raw.autosaves : []
        };
      }
    });
  }

  async init(): Promise<void> {
    await this.file.init();
  }

  /* This owner's, newest saved first. The file holds them in the order they
     were saved, so reversing before the (stable) sort puts the later of two
     saved in the same instant first. */
  async list(ownerId: string): Promise<SavedForLaterTask[]> {
    const { items } = await this.file.read();
    return items
      .filter((item) => item.ownerId === ownerId)
      .reverse()
      .sort(newestSavedFirst);
  }

  /* One of this owner's, or nothing. Someone else's id finds nothing, the same
     nothing as an id that never existed, so a lookup cannot confirm that one
     does. */
  async find(ownerId: string, id: string): Promise<SavedForLaterTask | undefined> {
    const { items } = await this.file.read();
    return items.find((item) => item.id === id && item.ownerId === ownerId);
  }

  /* Save a new task for later. `clearAutosave` is the new task form putting its
     own typing aside (#371): the owner's autosave goes in the same write, so the
     one form can never be on the Task Drafts tab twice, as a Saved for Later task
     and as an autosave, the way a second request that failed would leave it. Not
     asked for by a reopened form whose record had gone, whose typing is not the
     autosave. */
  async create(
    ownerId: string,
    form: SavedForLaterForm,
    savedAt: string = new Date().toISOString(),
    options: { clearAutosave?: boolean } = {}
  ): Promise<SavedForLaterTask> {
    const item: SavedForLaterTask = { id: randomUUID(), ownerId, savedAt, form };
    await this.file.update((data) => {
      data.items.push(item);
      if (options.clearAutosave) data.autosaves = data.autosaves.filter((autosave) => autosave.ownerId !== ownerId);
      return data;
    });
    return item;
  }

  /* ── The autosave (#371) ─────────────────────────────────────
     One per owner, answered for that owner only, and gone seven days after its
     last write. Nothing sweeps the file on a timer, so age is enforced where the
     autosave is touched: a read never answers with an aged-out one, and removes
     it, and every write drops everyone's that has aged out. */

  /* This owner's autosave, or nothing: none, someone else's, or aged out. */
  async getAutosave(ownerId: string, now: number = Date.now()): Promise<Autosave | undefined> {
    const { autosaves } = await this.file.read();
    const found = autosaves.find((autosave) => autosave.ownerId === ownerId);
    if (!found) return undefined;
    if (!isAutosaveExpired(found.savedAt, now)) return found;
    await this.file.update((data) => {
      const kept = unexpired(data.autosaves, now);
      if (kept.length === data.autosaves.length) return undefined;
      data.autosaves = kept;
      return data;
    });
    return undefined;
  }

  /* Write this owner's autosave over whatever was there. Latest write wins, as
     two windows typing into two forms is the same person twice. Ages are judged
     as of this write, which is what `savedAt` says it is. */
  async keepAutosave(ownerId: string, form: SavedForLaterForm, savedAt: string = new Date().toISOString()): Promise<Autosave> {
    const autosave: Autosave = { ownerId, savedAt, form };
    const written = Date.parse(savedAt);
    const now = Number.isFinite(written) ? written : Date.now();
    await this.file.update((data) => {
      data.autosaves = [...unexpired(data.autosaves, now).filter((other) => other.ownerId !== ownerId), autosave];
      return data;
    });
    return autosave;
  }

  /* Forget this owner's autosave. True when there was one to forget. */
  async clearAutosave(ownerId: string): Promise<boolean> {
    let cleared = false;
    await this.file.update((data) => {
      const kept = data.autosaves.filter((autosave) => autosave.ownerId !== ownerId);
      cleared = kept.length !== data.autosaves.length;
      if (!cleared) return undefined;
      data.autosaves = kept;
      return data;
    });
    return cleared;
  }

  /* Save a reopened one again (#344): the same record takes the whole new form
     and a new `savedAt`, so it never becomes a copy and "saved N ago" starts
     over. Whichever save lands last is what is kept; there is nothing to compare
     against and nothing to refuse, because two devices saving the same one is
     the same person twice. Someone else's, or one that no longer exists, finds
     nothing and changes nothing.

     Any unsaved typing on it goes (#348): what was on screen is the save now. */
  async update(
    ownerId: string,
    id: string,
    form: SavedForLaterForm,
    savedAt: string = new Date().toISOString()
  ): Promise<SavedForLaterTask | undefined> {
    return this.change(ownerId, id, ({ unsaved: _unsaved, ...item }) => ({ ...item, savedAt, form }));
  }

  /* Typing on a reopened one that nobody saved (#348, ADR-0011 rule 5), kept
     beside the save rather than over it. `form` and `savedAt` do not move, so
     the row keeps its place and its "saved N ago", and Discard can still leave
     exactly what was saved. Latest write wins, like a save. One that has gone
     (created or deleted elsewhere) is not brought back by it. */
  async keepUnsaved(ownerId: string, id: string, unsaved: SavedForLaterForm): Promise<SavedForLaterTask | undefined> {
    return this.change(ownerId, id, (item) => ({ ...item, unsaved }));
  }

  /* Discard on a reopened one (#348): the unsaved typing goes and the save is
     left as it was. Nothing to clear is not an error. */
  async clearUnsaved(ownerId: string, id: string): Promise<SavedForLaterTask | undefined> {
    return this.change(ownerId, id, ({ unsaved: _unsaved, ...item }) => item);
  }

  /* One of this owner's records replaced by `next` of it, inside the file's
     queue; `undefined`, with nothing written, for someone else's or one gone. */
  private async change(
    ownerId: string,
    id: string,
    next: (item: SavedForLaterTask) => SavedForLaterTask
  ): Promise<SavedForLaterTask | undefined> {
    let changed: SavedForLaterTask | undefined;
    await this.file.update((data) => {
      const index = data.items.findIndex((item) => item.id === id && item.ownerId === ownerId);
      if (index === -1) return data;
      changed = next(data.items[index]!);
      data.items[index] = changed;
      return data;
    });
    return changed;
  }

  /* Gone for good (#344, ADR-0011 rule 4): what happens once the task it held
     has been created. True when this owner's record was removed; false for
     someone else's or one already gone, which removes nothing. */
  async remove(ownerId: string, id: string): Promise<boolean> {
    let removed = false;
    await this.file.update((data) => {
      const kept = data.items.filter((item) => !(item.id === id && item.ownerId === ownerId));
      removed = kept.length !== data.items.length;
      return { ...data, items: kept };
    });
    return removed;
  }

  /* Rule 6: it goes when its owner goes. Every one this owner held, gone, and
     how many that was, and their autosave with them (#371). Someone with none of
     either writes nothing. Only removing a person calls this; deactivating one
     does not, so reactivating them finds theirs where they left it. */
  async removeAllFor(ownerId: string): Promise<number> {
    let removed = 0;
    await this.file.update((data) => {
      const kept = data.items.filter((item) => item.ownerId !== ownerId);
      const autosaves = data.autosaves.filter((autosave) => autosave.ownerId !== ownerId);
      removed = data.items.length - kept.length;
      return removed > 0 || autosaves.length !== data.autosaves.length ? { items: kept, autosaves } : undefined;
    });
    return removed;
  }
}
