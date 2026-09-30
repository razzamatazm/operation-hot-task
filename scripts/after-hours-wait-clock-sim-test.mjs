#!/usr/bin/env node
/*
 * Issue #459 — the pool nag counts office minutes, not wall time.
 *
 * A task pooled after hours gets the same twenty quiet minutes once the office
 * opens as one pooled mid-morning. Every instant is stated explicitly, so the
 * suite means the same thing on any day it runs. 2026 US DST starts Sunday
 * 8 March and ends Sunday 1 November.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  UNCLAIMED_ALERT_MS,
  computeClaimAnchoredDueAt,
  computeDueAtFromUrgency,
  isOfficeOpen,
  isPoolNagDue,
  officeMsBetween
} from "../packages/shared/dist/index.js";
import { TaskStore } from "../apps/server/dist/store.js";
import { SseHub } from "../apps/server/dist/sse.js";
import { TaskService } from "../apps/server/dist/task-service.js";

const config = {
  businessTimezone: "America/Los_Angeles",
  businessStartHour: 8,
  businessStartMinute: 30,
  businessEndHour: 17,
  businessEndMinute: 30,
  archiveRetentionDays: 90
};

const MIN = 60_000;
const on = (date, offset, hhmm) => new Date(`${date}T${hhmm}:00${offset}`);
/* PDT dates: Tuesday 10 March to Monday 16 March 2026. */
const pdt = (date, hhmm) => on(date, "-07:00", hhmm);
const TUE = "2026-03-10";
const WED = "2026-03-11";
const FRI = "2026-03-13";
const MON = "2026-03-16";

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

console.log("The pool nag counts office minutes — #459");

/* ------------------------------------------------------------ the measure */

await check("office minutes: a span inside one open day is its wall length", async () => {
  assert.equal(officeMsBetween(pdt(TUE, "10:00"), pdt(TUE, "10:20"), config), 20 * MIN);
  assert.equal(officeMsBetween(pdt(TUE, "07:00"), pdt(TUE, "08:40"), config), 10 * MIN, "before open counts nothing");
  assert.equal(officeMsBetween(pdt(TUE, "17:00"), pdt(TUE, "19:00"), config), 30 * MIN, "after close counts nothing");
});

await check("office minutes: nothing for an empty or backwards span", async () => {
  assert.equal(officeMsBetween(pdt(TUE, "10:00"), pdt(TUE, "10:00"), config), 0);
  assert.equal(officeMsBetween(pdt(TUE, "11:00"), pdt(TUE, "10:00"), config), 0);
});

await check("office minutes: overnight counts only the open ends", async () => {
  assert.equal(officeMsBetween(pdt(TUE, "19:00"), pdt(WED, "08:50"), config), 20 * MIN);
  assert.equal(officeMsBetween(pdt(TUE, "17:20"), pdt(WED, "08:40"), config), 20 * MIN);
  assert.equal(officeMsBetween(pdt(TUE, "10:00"), pdt(WED, "10:00"), config), 9 * 60 * MIN, "one full open day");
});

await check("office minutes: a weekend counts nothing, and Friday stops at 15:30", async () => {
  assert.equal(officeMsBetween(pdt(FRI, "15:25"), pdt(MON, "08:45"), config), 20 * MIN);
  assert.equal(officeMsBetween(pdt(FRI, "15:00"), pdt(FRI, "17:30"), config), 30 * MIN, "Friday's early close");
  assert.equal(officeMsBetween(pdt("2026-03-14", "09:00"), pdt("2026-03-15", "17:00"), config), 0, "Saturday to Sunday");
});

await check("office minutes: a per-day override moves Friday's close", async () => {
  const lateFriday = { ...config, businessEndByWeekday: { Fri: { hour: 17, minute: 30 } } };
  assert.equal(officeMsBetween(pdt(FRI, "15:00"), pdt(FRI, "17:30"), lateFriday), 150 * MIN);
});

await check("office minutes: a DST change over the weekend costs or adds nothing", async () => {
  // Spring forward, Sunday 8 March: PST Friday to PDT Monday.
  assert.equal(officeMsBetween(on("2026-03-06", "-08:00", "15:00"), on("2026-03-09", "-07:00", "09:00"), config), 60 * MIN);
  // Fall back, Sunday 1 November: PDT Friday to PST Monday.
  assert.equal(officeMsBetween(on("2026-10-30", "-07:00", "15:00"), on("2026-11-02", "-08:00", "09:00"), config), 60 * MIN);
  // A whole Monday either side of each change is still nine hours.
  assert.equal(officeMsBetween(on("2026-03-09", "-07:00", "00:00"), on("2026-03-10", "-07:00", "00:00"), config), 9 * 60 * MIN);
  assert.equal(officeMsBetween(on("2026-11-02", "-08:00", "00:00"), on("2026-11-03", "-08:00", "00:00"), config), 9 * 60 * MIN);
});

/* ------------------------------------------------------------ one boundary */

/* The open check and the measure share one interval: open from the opening
   instant up to, not including, the closing instant. */
await check("open at the opening instant and up to the last millisecond before close, closed at close", async () => {
  for (const [date, close] of [[TUE, "17:30"], [FRI, "15:30"]]) {
    const closes = pdt(date, close);
    assert.equal(isOfficeOpen(pdt(date, "08:30"), config), true, `${date} opening instant`);
    assert.equal(isOfficeOpen(new Date(pdt(date, "08:30").getTime() - 1), config), false, `${date} before open`);
    assert.equal(isOfficeOpen(new Date(closes.getTime() - 1), config), true, `${date} close - 1ms`);
    assert.equal(isOfficeOpen(closes, config), false, `${date} closing instant`);
    assert.equal(officeMsBetween(new Date(closes.getTime() - 1), closes, config), 1, "the measure counts that last millisecond");
    assert.equal(officeMsBetween(closes, new Date(closes.getTime() + MIN), config), 0, "and nothing in the closing minute");
  }
});

/* End-of-day deadlines use the same boundary: from the closing instant on,
   "today's close" has passed, so Yellow rolls to the next office day's close. */
const at = (date, hhmm, seconds) => new Date(pdt(date, hhmm).getTime() + seconds * 1000);
const yellow = (now) => computeDueAtFromUrgency("YELLOW", now, config);

await check("Yellow set Friday 15:29:59 is due that close; at 15:30:00 or 15:30:20 it is Monday's close", async () => {
  assert.equal(yellow(at(FRI, "15:29", 59)), pdt(FRI, "15:30").toISOString());
  assert.equal(yellow(at(FRI, "15:30", 0)), pdt(MON, "17:30").toISOString());
  assert.equal(yellow(at(FRI, "15:30", 20)), pdt(MON, "17:30").toISOString());
});

await check("Yellow set Tuesday 17:30:20 is due Wednesday's close, not the close that just passed", async () => {
  assert.equal(yellow(at(TUE, "17:29", 59)), pdt(TUE, "17:30").toISOString());
  assert.equal(yellow(at(TUE, "17:30", 20)), pdt(WED, "17:30").toISOString());
});

await check("a claim in the closing minute anchors to the next opening; a window ending in it clamps to close", async () => {
  assert.equal(computeClaimAnchoredDueAt("YELLOW", at(FRI, "15:30", 20), config), pdt(MON, "17:30").toISOString());
  assert.equal(computeClaimAnchoredDueAt("YELLOW", at(TUE, "17:30", 20), config), pdt(WED, "17:30").toISOString());
  assert.equal(computeClaimAnchoredDueAt("ORANGE", at(TUE, "16:30", 20), config), pdt(TUE, "17:30").toISOString());
});

/* ------------------------------------------------------------ the predicate */

const openTask = (pooledAt, over = {}) => ({
  id: "t1",
  folderName: "Folder",
  taskType: "VALUE",
  status: "OPEN",
  urgency: "GREEN",
  createdBy: { id: "creator", displayName: "Creator" },
  createdAt: pooledAt.toISOString(),
  updatedAt: pooledAt.toISOString(),
  dueAt: new Date(pooledAt.getTime() + 48 * 60 * MIN).toISOString(),
  ...over
});

await check("pooled 17:20 on a 17:30 day: first nag due 08:40 next morning", async () => {
  const task = openTask(pdt(TUE, "17:20"));
  assert.equal(isPoolNagDue(task, pdt(WED, "08:35"), config), false);
  assert.equal(isPoolNagDue(task, pdt(WED, "08:40"), config), true);
});

await check("pooled at 10:00: due at 10:20, as before", async () => {
  const task = openTask(pdt(TUE, "10:00"));
  assert.equal(isPoolNagDue(task, pdt(TUE, "10:19"), config), false);
  assert.equal(isPoolNagDue(task, pdt(TUE, "10:20"), config), true);
  assert.equal(UNCLAIMED_ALERT_MS, 20 * MIN);
});

/* ------------------------------------------------------------ the sweep */

const boot = async (tasks) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "after-hours-wait-clock-sim-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.init();
  await store.replaceTasks(tasks);
  const events = [];
  const notifier = { notify: async (event) => { events.push(event); }, canReachDm: async () => true };
  const service = new TaskService(store, notifier, new SseHub(), config);
  return { service, store, events };
};
const nagsIn = (events) => events.filter((event) => event.target === "CHANNEL_NAG");

/* The sweep's real cadence: every five minutes from `from` up to and including `to`. */
const sweepEvery5 = async (service, from, to) => {
  let nagged = 0;
  for (let at = from.getTime(); at <= to.getTime(); at += 5 * MIN) {
    nagged += (await service.runMaintenance(new Date(at))).nagged;
  }
  await service.settleBackgroundWork();
  return nagged;
};

await check("pooled Tuesday 19:00: not nagged at 08:30 or 08:45 Wednesday, nagged at 08:50 saying 20 minutes", async () => {
  const { service, store, events } = await boot([openTask(pdt(TUE, "19:00"))]);
  assert.equal(await sweepEvery5(service, pdt(TUE, "19:05"), pdt(WED, "08:45")), 0, "nothing overnight or before 08:50");
  assert.equal((await store.findTask("t1")).poolNagCount ?? 0, 0, "no ask spent overnight");

  assert.equal((await service.runMaintenance(pdt(WED, "08:50"))).nagged, 1);
  await service.settleBackgroundWork();
  assert.match(nagsIn(events)[0].message, /^Nobody's taken .* after 20 minutes, who's got it\?$/);
});

await check("pooled Tuesday 10:00: nagged at 10:20, unchanged", async () => {
  const { service } = await boot([openTask(pdt(TUE, "10:00"))]);
  assert.equal(await sweepEvery5(service, pdt(TUE, "10:00"), pdt(TUE, "10:15")), 0);
  assert.equal((await service.runMaintenance(pdt(TUE, "10:20"))).nagged, 1);
});

await check("pooled Friday 15:25: nothing over the weekend, first nag Monday 08:45", async () => {
  const { service, store, events } = await boot([openTask(pdt(FRI, "15:25"))]);
  assert.equal(await sweepEvery5(service, pdt(FRI, "15:25"), pdt(MON, "08:40")), 0);
  assert.equal((await store.findTask("t1")).poolNagCount ?? 0, 0, "no ask counted in between");
  assert.equal(nagsIn(events).length, 0);

  assert.equal((await service.runMaintenance(pdt(MON, "08:45"))).nagged, 1);
  await service.settleBackgroundWork();
  assert.match(nagsIn(events)[0].message, /^Nobody's taken .* after 20 minutes, who's got it\?$/);
});

await check("pooled Friday 15:10:30: 19.5 office minutes by close, so the nag waits for Monday 08:30:30", async () => {
  /* Decided behaviour: the office is closed from 15:30:00, so no pass after it
     can nag, and 19.5 minutes is under the threshold. The 30 seconds left over
     are owed Monday morning, and the first pass at or after 08:30:30 nags. */
  const task = openTask(new Date(pdt(FRI, "15:10").getTime() + 30_000));
  assert.equal(isPoolNagDue(task, pdt(FRI, "15:30"), config), false, "19:30 accrued at close");
  assert.equal(isPoolNagDue(task, new Date(pdt(FRI, "15:30").getTime() + 30_000), config), false, "15:30:30 is closed");
  assert.equal(isPoolNagDue(task, pdt(MON, "08:30"), config), false, "still 30 seconds short at opening");
  assert.equal(isPoolNagDue(task, new Date(pdt(MON, "08:30").getTime() + 30_000), config), true);

  const { service, events } = await boot([task]);
  assert.equal(await sweepEvery5(service, pdt(FRI, "15:15"), pdt(MON, "08:30")), 0);
  assert.equal((await service.runMaintenance(pdt(MON, "08:35"))).nagged, 1);
  await service.settleBackgroundWork();
  assert.match(nagsIn(events)[0].message, /^Nobody's taken .* after 20 minutes, who's got it\?$/);
});

await check("nagged at 17:20: the next nag is not due at 08:30, and is at 08:40", async () => {
  const task = openTask(pdt(TUE, "15:00"), { poolNagCount: 1, lastPoolNagAt: pdt(TUE, "17:20").toISOString() });
  const { service, store, events } = await boot([task]);
  assert.equal(await sweepEvery5(service, pdt(TUE, "17:25"), pdt(WED, "08:35")), 0);
  assert.equal((await store.findTask("t1")).poolNagCount, 1);

  assert.equal((await service.runMaintenance(pdt(WED, "08:40"))).nagged, 1);
  await service.settleBackgroundWork();
  assert.equal((await store.findTask("t1")).poolNagCount, 2);
  assert.match(nagsIn(events)[0].message, /^Nobody's taken .* after 40 minutes, who's got it\?$/);
});

await check("a reopened task with spent asks still quotes the lower, office-minute mark", async () => {
  // #455's edge: the count says 60, but the task has been back in the pool for
  // twenty office minutes since an overnight reopen.
  const task = openTask(pdt(TUE, "08:30"), {
    poolNagCount: 2,
    pooledSince: pdt(TUE, "19:00").toISOString(),
    lastPoolNagAt: pdt(TUE, "19:00").toISOString()
  });
  const { service, events } = await boot([task]);
  assert.equal((await service.runMaintenance(pdt(WED, "08:50"))).nagged, 1);
  await service.settleBackgroundWork();
  assert.match(nagsIn(events)[0].message, /^Nobody's taken .* after 20 minutes, who's got it\?$/);
});

/* ------------------------------------------------------------ the backfill */

await check("a boot before opening does not stamp a task pooled the previous evening", async () => {
  const evening = openTask(pdt(TUE, "19:00"), { id: "evening" });
  const morning = openTask(pdt(TUE, "10:00"), { id: "morning" });
  const { service, store } = await boot([evening, morning]);

  const { stamped } = await service.backfillPoolNagClock(pdt(WED, "07:00"));
  assert.equal(stamped, 1, "only the task that already has office minutes behind it");
  assert.equal((await store.findTask("evening")).lastPoolNagAt, undefined);
  assert.equal((await store.findTask("morning")).lastPoolNagAt, pdt(WED, "07:00").toISOString());

  // So the evening task still gets its first nag at 08:50, not 20 minutes later.
  assert.equal(await sweepEvery5(service, pdt(WED, "07:05"), pdt(WED, "08:45")), 0);
  await service.runMaintenance(pdt(WED, "08:50"));
  assert.equal((await store.findTask("evening")).poolNagCount, 1);
});

console.log(`\n${passed} checks passed`);
