/* The first task list goes out beside /me, so the live stream can deliver a
   task change between the server reading the list and the list landing.
   Taking the list wholesale would roll that change back until the next one.
   Every change rewrites `updatedAt`, so the newer copy of each task wins. */
export const mergeTaskSnapshot = <T extends { id: string; updatedAt: string }>(current: T[], snapshot: T[]): T[] => {
  if (current.length === 0) return snapshot;
  const streamed = new Map(current.map((task) => [task.id, task]));
  const merged = snapshot.map((task) => {
    const live = streamed.get(task.id);
    streamed.delete(task.id);
    return live && live.updatedAt > task.updatedAt ? live : task;
  });
  return [...streamed.values(), ...merged].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
};
