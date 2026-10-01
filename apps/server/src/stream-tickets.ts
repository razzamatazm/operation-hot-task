import { randomBytes } from "node:crypto";

/* One-time tickets for the live stream, which EventSource can't send a bearer
   header to. One use, short life, so a ticket in a request log is already
   spent. In memory: fine while the app runs on a single instance. */
export class StreamTickets {
  private tickets = new Map<string, number>();

  constructor(
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now
  ) {}

  issue(): string {
    this.dropExpired();
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(ticket, this.now() + this.ttlMs);
    return ticket;
  }

  redeem(ticket: unknown): boolean {
    if (typeof ticket !== "string") return false;
    const expiresAt = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return expiresAt !== undefined && expiresAt > this.now();
  }

  size(): number {
    return this.tickets.size;
  }

  private dropExpired(): void {
    const now = this.now();
    for (const [ticket, expiresAt] of this.tickets) {
      if (expiresAt <= now) this.tickets.delete(ticket);
    }
  }
}
