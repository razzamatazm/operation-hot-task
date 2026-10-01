import { Response } from "express";

export interface StreamEvent {
  type: string;
  payload: unknown;
}

export class SseHub {
  private clients = new Set<Response>();

  addClient(res: Response): void {
    this.clients.add(res);
  }

  removeClient(res: Response): void {
    this.clients.delete(res);
  }

  broadcast(event: StreamEvent): void {
    const encoded = `event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
    for (const client of this.clients) {
      client.write(encoded);
    }
  }

  /* Shutdown: a stream never ends on its own, so server.close() would wait on it forever. */
  closeAll(): void {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();
  }

  count(): number {
    return this.clients.size;
  }
}
