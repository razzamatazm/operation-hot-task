import type { Request, Response } from 'express';

export type SseEvent =
  | { type: 'request.created'; requestId: string }
  | { type: 'request.updated'; requestId: string }
  | { type: 'comment.added'; requestId: string; commentId: string }
  | { type: 'vote.recorded'; requestId: string; voteId: string }
  | { type: 'notification'; userId: string; message: string };

interface Client {
  id: number;
  res: Response;
}

const clients = new Set<Client>();
let nextId = 1;

export function attachClient(_req: Request, res: Response): void {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(': connected\n\n');

  const client: Client = { id: nextId++, res };
  clients.add(client);

  const heartbeat = setInterval(() => {
    res.write(': hb\n\n');
  }, 25_000);

  res.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(client);
  });
}

export function broadcast(event: SseEvent): void {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) {
    c.res.write(data);
  }
}

export function clientCount(): number {
  return clients.size;
}
