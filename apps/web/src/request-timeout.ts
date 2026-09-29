/* Giving up on a server that never answers (#468): a hung server leaves fetch
   pending forever, so Create sits on "Creating…" and autosave writes queue. */

/* Every route the web app calls answers after local file work; Teams sends run
   in the background. The exception is an admin role change that releases a
   checker's Fraud Checks, which waits on Graph and can run past this. */
export const REQUEST_TIMEOUT_MS = 10_000;

/* Runs `run` with a signal that aborts after `timeoutMs`, rejecting with the
   error fetch gives for an unreachable server so every caller already handles
   it. */
export const withRequestTimeout = <T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<T> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TypeError("Failed to fetch"));
      controller.abort();
    }, timeoutMs);
  });
  return Promise.race([run(controller.signal), gaveUp]).finally(() => clearTimeout(timer));
};
