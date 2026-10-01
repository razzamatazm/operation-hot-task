/* The live stream, opened with a one-time ticket (the server's
   stream-tickets.ts says why). A spent ticket can't reopen the stream, so the
   browser's own reconnect is no use: on any error this closes the stream and,
   after a pause, fetches a new ticket and opens it again. Framework-free, with
   the EventSource and timers passed in, so it runs under node in
   scripts/stream-ticket-sim-test.mjs. Returns the function that stops it. */

export interface LiveStreamSource {
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
  onerror: ((event: Event) => void) | null;
}

interface LiveStreamOptions {
  fetchTicket: () => Promise<string>;
  connect: (ticket: string) => LiveStreamSource;
  eventTypes: string[];
  onEvent: (type: string, data: string) => void;
  retryMs?: number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (timer: unknown) => void;
}

export const openLiveStream = ({
  fetchTicket,
  connect,
  eventTypes,
  onEvent,
  retryMs = 5000,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
}: LiveStreamOptions): (() => void) => {
  let stopped = false;
  let source: LiveStreamSource | null = null;
  let retry: unknown;

  const retryLater = (): void => {
    if (stopped) return;
    retry = schedule(start, retryMs);
  };

  function start(): void {
    retry = undefined;
    fetchTicket().then(
      (ticket) => {
        if (stopped) return;
        const opened = connect(ticket);
        source = opened;
        for (const type of eventTypes) {
          opened.addEventListener(type, (event) => onEvent(type, event.data));
        }
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
    cancel(retry);
    source?.close();
    source = null;
  };
};
