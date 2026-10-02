import type { DraftStorage } from "./create-form-draft";

/* The last task list the board saw, painted while sign-in and the first fetch
   run. Tied to the build that saved it, whose fields an older copy may lack. */
export const TASK_CACHE_KEY = "hot-task:board-tasks";
export const TASK_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const readTaskCache = <T>(storage: DraftStorage | null, build: string, now: number): T[] => {
  try {
    const raw = storage?.getItem(TASK_CACHE_KEY);
    if (!raw) return [];
    const stored = JSON.parse(raw) as { build?: unknown; savedAt?: unknown; tasks?: unknown };
    if (stored.build !== build || typeof stored.savedAt !== "number" || !Array.isArray(stored.tasks)) return [];
    if (now - stored.savedAt > TASK_CACHE_MAX_AGE_MS) return [];
    return stored.tasks as T[];
  } catch {
    return [];
  }
};

export const writeTaskCache = <T>(storage: DraftStorage | null, build: string, tasks: T[], now: number): void => {
  try {
    storage?.setItem(TASK_CACHE_KEY, JSON.stringify({ build, savedAt: now, tasks }));
  } catch {
    /* storage full or locked: the board just loads without it next time */
  }
};
