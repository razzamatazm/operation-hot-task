import { randomUUID } from "node:crypto";
import { SavedForLaterForm, SavedForLaterTask, newestSavedFirst } from "@loan-tasks/shared";
import { JsonFile } from "./json-file.js";

interface SavedForLaterData {
  items: SavedForLaterTask[];
}

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
      empty: () => ({ items: [] }),
      decode: (parsed) => {
        const raw = parsed as Partial<SavedForLaterData> | null;
        return { items: Array.isArray(raw?.items) ? raw.items : [] };
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

  async create(ownerId: string, form: SavedForLaterForm, savedAt: string = new Date().toISOString()): Promise<SavedForLaterTask> {
    const item: SavedForLaterTask = { id: randomUUID(), ownerId, savedAt, form };
    await this.file.update((data) => {
      data.items.push(item);
      return data;
    });
    return item;
  }

  /* Save a reopened one again (#344): the same record takes the whole new form
     and a new `savedAt`, so it never becomes a copy and "saved N ago" starts
     over. Whichever save lands last is what is kept; there is nothing to compare
     against and nothing to refuse, because two devices saving the same one is
     the same person twice. Someone else's, or one that no longer exists, finds
     nothing and changes nothing. */
  async update(
    ownerId: string,
    id: string,
    form: SavedForLaterForm,
    savedAt: string = new Date().toISOString()
  ): Promise<SavedForLaterTask | undefined> {
    let updated: SavedForLaterTask | undefined;
    await this.file.update((data) => {
      const index = data.items.findIndex((item) => item.id === id && item.ownerId === ownerId);
      if (index === -1) return data;
      updated = { ...data.items[index]!, savedAt, form };
      data.items[index] = updated;
      return data;
    });
    return updated;
  }

  /* Gone for good (#344, ADR-0011 rule 4): what happens once the task it held
     has been created. True when this owner's record was removed; false for
     someone else's or one already gone, which removes nothing. */
  async remove(ownerId: string, id: string): Promise<boolean> {
    let removed = false;
    await this.file.update((data) => {
      const kept = data.items.filter((item) => !(item.id === id && item.ownerId === ownerId));
      removed = kept.length !== data.items.length;
      return { items: kept };
    });
    return removed;
  }

  /* Rule 6: it goes when its owner goes. Every one this owner held, gone, and
     how many that was. Someone with none writes nothing. Only removing a person
     calls this; deactivating one does not, so reactivating them finds theirs
     where they left it. */
  async removeAllFor(ownerId: string): Promise<number> {
    let removed = 0;
    await this.file.update((data) => {
      const kept = data.items.filter((item) => item.ownerId !== ownerId);
      removed = data.items.length - kept.length;
      return removed > 0 ? { items: kept } : undefined;
    });
    return removed;
  }
}
