/* Giving up on a server that never answers (#468). A hung server, unlike a
   refusing one, leaves fetch pending forever: Create sits on "Creating…" and
   autosave writes queue behind it. Framework-free so
   scripts/request-timeout-sim-test.mjs can drive it with a request that never
   resolves. */

/* Well above the slowest route the web app calls, which answers once its
   Teams sends have gone out. */
export const REQUEST_TIMEOUT_MS = 10_000;

/* Runs `run` with a signal that aborts after `timeoutMs`. Past that it rejects
   with the same error fetch gives for an unreachable server, so every caller
   already handles it. */
export const withRequestTimeout = <T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<T> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TypeError("Failed to fetch"));
    }, timeoutMs);
  });
  return Promise.race([run(controller.signal), gaveUp]).finally(() => clearTimeout(timer));
};
