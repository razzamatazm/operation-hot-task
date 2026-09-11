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
}
