/* Giving up on a server that never answers (#468): a hung server leaves fetch
   pending forever, so Create sits on "Creating…" and autosave writes queue. */

/* Every route the web app calls answers after local file work; Teams sends run
   in the background. */
export const REQUEST_TIMEOUT_MS = 10_000;

/* The admin user-management calls wait on Microsoft before answering: adding
   by email looks the person up, and a role change, deactivate or remove that
   releases a checker's Fraud Checks sends activity notifications first. */
export const ADMIN_REQUEST_TIMEOUT_MS = 30_000;

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
