#!/usr/bin/env node
/* The live stream used to answer anyone who knew its address. A browser stream
   can't send a sign-in header, so the app trades its sign-in for a one-time
   ticket and opens the stream with that. These pin the ticket rules on the
   server and the app's reconnect loop around them.
   Run: `npm run build:sim && node --test scripts/stream-ticket-sim-test.mjs`. */
import assert from "node:assert/strict";
import test from "node:test";

import { StreamTickets } from "../apps/server/dist/stream-tickets.js";
import { openLiveStream } from "../apps/web/src/live-stream.ts";

const clock = (start = 1_700_000_000_000) => {
  const state = { now: start };
  return { state, now: () => state.now };
};

test("a ticket opens the stream once", () => {
  const tickets = new StreamTickets(60_000, clock().now);
  const ticket = tickets.issue();
  assert.equal(tickets.redeem(ticket), true);
  assert.equal(tickets.redeem(ticket), false);
});

test("a ticket past its minute is refused", () => {
  const c = clock();
  const tickets = new StreamTickets(60_000, c.now);
  const ticket = tickets.issue();
  c.state.now += 60_001;
  assert.equal(tickets.redeem(ticket), false);
});

test("a missing or made-up ticket is refused", () => {
  const tickets = new StreamTickets(60_000, clock().now);
  tickets.issue();
  assert.equal(tickets.redeem(undefined), false);
  assert.equal(tickets.redeem(""), false);
  assert.equal(tickets.redeem("made-up"), false);
  assert.equal(tickets.redeem(["array"]), false);
});

test("tickets nobody used don't pile up", () => {
  const c = clock();
  const tickets = new StreamTickets(60_000, c.now);
  for (let i = 0; i < 50; i += 1) tickets.issue();
  c.state.now += 60_001;
  tickets.issue();
  assert.equal(tickets.size(), 1);
});

/* A stand-in for the browser's EventSource and timers, driven by hand. */
const harness = ({ ticketFails = 0 } = {}) => {
  const state = { ticketCalls: 0, sources: [], timers: [], events: [] };
  let failuresLeft = ticketFails;
  const fetchTicket = async () => {
    state.ticketCalls += 1;
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      throw new Error("offline");
    }
    return `ticket-${state.ticketCalls}`;
  };
  const connect = (ticket) => {
    const source = {
      ticket,
      closed: false,
      listeners: {},
      onerror: null,
      addEventListener(type, listener) {
        this.listeners[type] = listener;
      },
      close() {
        this.closed = true;
      }
    };
    state.sources.push(source);
    return source;
  };
  const schedule = (fn, ms) => {
    const timer = { fn, ms, cancelled: false };
    state.timers.push(timer);
    return timer;
  };
  const cancel = (timer) => {
    if (timer) timer.cancelled = true;
  };
  const runTimers = async () => {
    const due = state.timers.filter((t) => !t.cancelled && !t.ran);
    for (const t of due) {
      t.ran = true;
      t.fn();
    }
    await settle();
  };
  const stop = openLiveStream({
    fetchTicket,
    connect,
    eventTypes: ["task.changed"],
    onEvent: (type, data) => state.events.push({ type, data }),
    retryMs: 5000,
    schedule,
    cancel
  });
  return { state, stop, runTimers };
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("opens the stream with a fresh ticket and passes events through", async () => {
  const h = harness();
  await settle();
  assert.equal(h.state.sources.length, 1);
  assert.equal(h.state.sources[0].ticket, "ticket-1");
  h.state.sources[0].listeners["task.changed"]({ data: '{"id":"a"}' });
  assert.deepEqual(h.state.events, [{ type: "task.changed", data: '{"id":"a"}' }]);
});

test("a dropped stream reconnects with a new ticket after a pause", async () => {
  const h = harness();
  await settle();
  const first = h.state.sources[0];
  first.onerror?.({});
  assert.equal(first.closed, true, "the browser's own retry would reuse a spent ticket, so it is stopped");
  assert.equal(h.state.timers.at(-1).ms, 5000);
  await h.runTimers();
  assert.equal(h.state.sources.length, 2);
  assert.equal(h.state.sources[1].ticket, "ticket-2");
});

test("a failed ticket request is retried after a pause", async () => {
  const h = harness({ ticketFails: 1 });
  await settle();
  assert.equal(h.state.sources.length, 0);
  await h.runTimers();
  assert.equal(h.state.sources.length, 1);
  assert.equal(h.state.sources[0].ticket, "ticket-2");
});

test("stopping closes the stream and cancels any pending reconnect", async () => {
  const h = harness();
  await settle();
  h.state.sources[0].onerror?.({});
  h.stop();
  await h.runTimers();
  assert.equal(h.state.sources.length, 1, "no reconnect after stop");
  assert.equal(h.state.sources[0].closed, true);
});

test("a ticket that lands after stopping opens nothing", async () => {
  const h = harness();
  h.stop();
  await settle();
  assert.equal(h.state.sources.length, 0);
});

test("the board opens its stream through the ticket loop", async () => {
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(new URL("../apps/web/src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /openLiveStream\(/);
  assert.match(app, /"\/stream-ticket"/);
  assert.doesNotMatch(app, /new EventSource\(`\$\{API_BASE\}\/stream`\)/);
});
