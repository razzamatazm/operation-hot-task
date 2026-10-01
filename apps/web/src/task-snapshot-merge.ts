/* The first task list goes out beside /me, so the live stream can deliver a
   task change between the server reading the list and the list landing.
   Taking the list wholesale would roll that change back until the next one.
   The streamed copy wins unless the list's is strictly newer: some changes,
   such as a loan rename reaching its tasks, leave `updatedAt` alone. */
export const mergeTaskSnapshot = <T extends { id: string; updatedAt: string }>(current: T[], snapshot: T[]): T[] => {
  if (current.length === 0) return snapshot;
  const streamed = new Map(current.map((task) => [task.id, task]));
  const merged = snapshot.map((task) => {
    const live = streamed.get(task.id);
    streamed.delete(task.id);
    return live && live.updatedAt >= task.updatedAt ? live : task;
  });
  return [...streamed.values(), ...merged].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
};

/* The reload each stream connect triggers. The board's copies may be stale,
   so only changes streamed while a reload is in flight may override its list,
   and a reload that lands after a newer one has settled, either way, is dropped. */
export const createStreamReload = <T extends { id: string; updatedAt: string }>({
  load,
  apply,
  fail
}: {
  load: () => Promise<T[]>;
  apply: (tasks: T[]) => void;
  fail: (error: unknown) => void;
}) => {
  const streamedDuringReloads = new Set<Map<string, T>>();
  let started = 0;
  let newestSettled = 0;
  let stopped = false;
  return {
    reload: (): void => {
      const seq = ++started;
      const streamed = new Map<string, T>();
      streamedDuringReloads.add(streamed);
      load()
        .then(
          (tasks) => {
            if (stopped || seq < newestSettled) return;
            newestSettled = seq;
            apply(mergeTaskSnapshot([...streamed.values()], tasks));
          },
          (error) => {
            if (stopped || seq < newestSettled) return;
            newestSettled = seq;
            fail(error);
          }
        )
        .finally(() => streamedDuringReloads.delete(streamed));
    },
    streamed: (task: T): void => {
      for (const streamed of streamedDuringReloads) streamed.set(task.id, task);
    },
    stop: (): void => {
      stopped = true;
    }
  };
};
