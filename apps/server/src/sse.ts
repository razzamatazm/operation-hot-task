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

  count(): number {
    return this.clients.size;
  }
}
