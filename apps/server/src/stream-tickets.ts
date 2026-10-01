import { randomBytes } from "node:crypto";

/* One-time passes for the live stream. A browser EventSource can't send the
   SSO bearer header, so a signed-in caller trades it for a ticket and opens
   /stream?ticket=... with that. A ticket is random, works once, and lapses
   after `ttlMs`, so one that lands in a request log is already spent. Held in
   memory, which holds while the app runs on a single instance. */
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
