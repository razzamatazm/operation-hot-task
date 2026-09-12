import path from "node:path";

/* A store that can copy its data file somewhere, through its own `JsonFile`
   queue so the copy never lands mid-save. */
export interface BackableStore {
  backupInto(dir: string): Promise<void>;
}

/* Copy each store's data file into `<backupsDir>/<timestamp>/` before a
   start-up migration rewrites them (#370). The same folder shape
   `npm run dev:reset` backs up into, so a person looking for yesterday's data
   finds both in one place. Returns the folder. */
export const backupStores = async (
  stores: BackableStore[],
  backupsDir: string,
  now: Date = new Date()
): Promise<string> => {
  const target = path.join(backupsDir, now.toISOString().replace(/[:.]/g, "-"));
  for (const store of stores) {
    await store.backupInto(target);
  }
  return target;
};
