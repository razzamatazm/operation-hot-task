/* The live stream, opened with a one-time ticket (see the server's
   stream-tickets.ts). A spent ticket can't reopen it, so on any error this
   closes the stream and opens a new one with a fresh ticket, waiting longer
   after each failure. Returns the function that stops it. */

export interface LiveStreamSource {
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
  onerror: ((event: Event) => void) | null;
}

interface LiveStreamOptions {
  fetchTicket: () => Promise<string>;
  connect: (ticket: string) => LiveStreamSource;
  onTaskChanged: (data: string) => void;
  /* Changes sent before the stream opened are lost, so the board reloads. */
  onConnected: () => void;
  retryMs?: number;
  maxRetryMs?: number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (timer: unknown) => void;
}

export const openLiveStream = ({
  fetchTicket,
  connect,
  onTaskChanged,
  onConnected,
  retryMs = 5000,
  maxRetryMs = 60000,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
}: LiveStreamOptions): (() => void) => {
  let stopped = false;
  let source: LiveStreamSource | null = null;
  let retryTimer: unknown;
  let nextRetryMs = retryMs;

  const retryLater = (): void => {
    if (stopped) return;
    retryTimer = schedule(start, nextRetryMs);
    nextRetryMs = Math.min(nextRetryMs * 2, maxRetryMs);
  };

  function start(): void {
    retryTimer = undefined;
    fetchTicket().then(
      (ticket) => {
        if (stopped) return;
        const opened = connect(ticket);
        source = opened;
        opened.addEventListener("connected", () => {
          nextRetryMs = retryMs;
          onConnected();
        });
        opened.addEventListener("task.changed", (event) => onTaskChanged(event.data));
        opened.onerror = () => {
          opened.close();
          if (source === opened) source = null;
          retryLater();
        };
      },
      retryLater
    );
  }

  start();

  return () => {
    stopped = true;
    cancel(retryTimer);
    source?.close();
    source = null;
  };
};
