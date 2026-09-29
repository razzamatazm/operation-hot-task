#!/usr/bin/env node
/*
 * Issue #457 — the office closes at 15:30 on Fridays.
 *
 * The config below is the shape every other sim test and production use: one
 * uniform close, no per-day entry. Friday's early close has to arrive anyway,
 * because it is the built-in default and production sets no new setting.
 *
 * Every instant is stated explicitly, so the suite means the same thing on any
 * day it runs. 2026 US DST starts Sunday 8 March and ends Sunday 1 November, so
 * the Fridays either side of each change are checked in both offsets.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  computeClaimAnchoredDueAt,
  computeDueAtFromUrgency,
  isOfficeOpen,
  isPoolNagDue,
  isWithinBusinessHours,
  nextOfficeOpen,
  officeHoursOn,
  shouldSendReminder
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

const pacific = (iso) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  })
    .formatToParts(new Date(iso))
    .reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
const pacificStamp = (iso) => {
  const p = pacific(iso);
  return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

console.log("Friday closes at 15:30 — #457");

/* PDT Fridays (-07:00): 13 March, just after spring-forward; 30 October, just
   before fall-back. PST Fridays (-08:00): 6 March, 6 November. */
const FRIDAYS = [
  ["2026-03-06", "-08:00", "PST, before spring-forward"],
  ["2026-03-13", "-07:00", "PDT, after spring-forward"],
  ["2026-10-30", "-07:00", "PDT, before fall-back"],
  ["2026-11-06", "-08:00", "PST, after fall-back"]
];
const on = (date, offset, hhmm) => new Date(`${date}T${hhmm}:00${offset}`);

/* ------------------------------------------------------------ is it open */

for (const [date, offset, label] of FRIDAYS) {
  await check(`Friday ${date} (${label}): open at 15:29 and 15:30, closed at 15:31`, async () => {
    assert.equal(isWithinBusinessHours(on(date, offset, "15:29"), config), true);
    assert.equal(isWithinBusinessHours(on(date, offset, "15:30"), config), true, "close is inclusive, as on every day");
    assert.equal(isWithinBusinessHours(on(date, offset, "15:31"), config), false);
    assert.equal(isWithinBusinessHours(on(date, offset, "17:00"), config), false);
  });
}

await check("Monday to Thursday still close at the configured 17:30", async () => {
  for (const date of ["2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12"]) {
    assert.equal(isWithinBusinessHours(on(date, "-07:00", "17:30"), config), true, date);
    assert.equal(isWithinBusinessHours(on(date, "-07:00", "17:31"), config), false, date);
    assert.equal(isWithinBusinessHours(on(date, "-07:00", "15:45"), config), true, date);
  }
});

await check("the uniform close setting still moves Monday to Thursday, not Friday", async () => {
  const later = { ...config, businessEndHour: 18, businessEndMinute: 0 };
  assert.equal(isWithinBusinessHours(on("2026-03-11", "-07:00", "17:45"), later), true);
  assert.equal(isWithinBusinessHours(on("2026-03-13", "-07:00", "15:45"), later), false);
});

await check("a per-day entry overrides the built-in Friday", async () => {
  const lateFriday = { ...config, businessEndByWeekday: { Fri: { hour: 17, minute: 30 } } };
  assert.equal(isWithinBusinessHours(on("2026-03-13", "-07:00", "17:00"), lateFriday), true);
  const earlyThursday = { ...config, businessEndByWeekday: { Thu: { hour: 12, minute: 0 } } };
  assert.equal(isWithinBusinessHours(on("2026-03-12", "-07:00", "12:30"), earlyThursday), false);
  assert.equal(isWithinBusinessHours(on("2026-03-13", "-07:00", "15:45"), earlyThursday), false, "and Friday keeps its early close");
});

await check("the schedule answers every question the same way", async () => {
  assert.deepEqual(officeHoursOn({ year: 2026, month: 3, day: 13 }, config), {
    open: { hour: 8, minute: 30 },
    close: { hour: 15, minute: 30 }
  });
  assert.equal(officeHoursOn({ year: 2026, month: 3, day: 14 }, config), undefined, "Saturday is closed");
  assert.equal(isOfficeOpen(on("2026-03-13", "-07:00", "15:31"), config), false);
  assert.equal(
    pacificStamp(nextOfficeOpen(on("2026-03-13", "-07:00", "15:31"), config)),
    "Mon 2026-03-16 08:30",
    "after Friday's close, the office next opens Monday morning"
  );
});

/* ------------------------------------------------------------ the nags */

const openTask = (at, over = {}) => ({
  id: "t1",
  folderName: "Folder",
  taskType: "VALUE",
  status: "OPEN",
  urgency: "GREEN",
  createdBy: { id: "creator", displayName: "Creator" },
  createdAt: new Date(at.getTime() - 60 * 60_000).toISOString(),
  updatedAt: new Date(at.getTime() - 60 * 60_000).toISOString(),
  dueAt: new Date(at.getTime() + 24 * 60 * 60_000).toISOString(),
  ...over
});

await check("no pool nag or overdue reminder is due after 15:30 on a Friday", async () => {
  for (const [date, offset] of FRIDAYS) {
    const before = on(date, offset, "15:25");
    assert.equal(isPoolNagDue(openTask(before), before, config), true, `${date}: still nags before close`);
    for (const hhmm of ["15:31", "16:00", "17:00", "17:30"]) {
      const at = on(date, offset, hhmm);
      assert.equal(isPoolNagDue(openTask(at), at, config), false, `${date} ${hhmm}: pool nag`);
      const overdue = openTask(at, {
        status: "CLAIMED",
        assignee: { id: "a", displayName: "A" },
        dueAt: new Date(at.getTime() - 60 * 60_000).toISOString()
      });
      assert.equal(shouldSendReminder(overdue, at, config), false, `${date} ${hhmm}: reminder`);
    }
  }
});

const boot = async (tasks) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-close-sim-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.init();
  await store.replaceTasks(tasks);
  const events = [];
  const notifier = { notify: async (event) => { events.push(event); }, canReachDm: async () => true };
  const service = new TaskService(store, notifier, new SseHub(), config);
  return { service, store, events };
};

await check("a sweep after Friday's close spends no nag asks and sends no reminders", async () => {
  const at = on("2026-03-13", "-07:00", "16:00");
  const pooled = openTask(at, { id: "pooled", poolNagCount: 2, lastPoolNagAt: on("2026-03-13", "-07:00", "14:00").toISOString() });
  const overdue = openTask(at, {
    id: "overdue",
    status: "CLAIMED",
    assignee: { id: "a", displayName: "A" },
    dueAt: on("2026-03-13", "-07:00", "14:00").toISOString()
  });
  const { service, store, events } = await boot([pooled, overdue]);

  const result = await service.runMaintenance(at);
  await service.settleBackgroundWork();

  assert.equal(result.nagged, 0);
  assert.equal(result.reminded, 0);
  assert.equal((await store.findTask("pooled")).poolNagCount, 2, "no ask spent");
  assert.equal((await store.findTask("overdue")).lastReminderAt, undefined);
  assert.equal(events.filter((e) => e.target === "CHANNEL_NAG" || e.type === "TASK_REMINDER").length, 0);

  // Control: the same queue at 15:00 the same Friday is chased as normal.
  const { service: earlier } = await boot([pooled, overdue]);
  const control = await earlier.runMaintenance(on("2026-03-13", "-07:00", "15:00"));
  assert.equal(control.nagged, 1);
  assert.equal(control.reminded, 1);
});

/* ------------------------------------------------------------ YELLOW */

await check("YELLOW filed Friday 14:00 is due Friday 15:30", async () => {
  for (const [date, offset] of FRIDAYS) {
    const due = computeDueAtFromUrgency("YELLOW", on(date, offset, "14:00"), config);
    assert.equal(pacificStamp(due), `Fri ${date} 15:30`);
  }
});

await check("YELLOW filed Friday 16:00, or over the weekend, is due at Monday's close", async () => {
  assert.equal(pacificStamp(computeDueAtFromUrgency("YELLOW", on("2026-03-13", "-07:00", "16:00"), config)), "Mon 2026-03-16 17:30");
  assert.equal(pacificStamp(computeDueAtFromUrgency("YELLOW", on("2026-03-14", "-07:00", "11:00"), config)), "Mon 2026-03-16 17:30");
  // Across both DST changes: filed in one offset, due in the other.
  assert.equal(pacificStamp(computeDueAtFromUrgency("YELLOW", on("2026-03-06", "-08:00", "16:00"), config)), "Mon 2026-03-09 17:30");
  assert.equal(pacificStamp(computeDueAtFromUrgency("YELLOW", on("2026-10-30", "-07:00", "16:00"), config)), "Mon 2026-11-02 17:30");
});

await check("YELLOW filed Thursday 19:00 rolls onto Friday 15:30", async () => {
  assert.equal(pacificStamp(computeDueAtFromUrgency("YELLOW", on("2026-03-12", "-07:00", "19:00"), config)), "Fri 2026-03-13 15:30");
  assert.equal(pacificStamp(computeDueAtFromUrgency("YELLOW", on("2026-03-05", "-08:00", "19:00"), config)), "Fri 2026-03-06 15:30");
});

await check("YELLOW on Monday to Thursday is unchanged", async () => {
  assert.equal(pacificStamp(computeDueAtFromUrgency("YELLOW", on("2026-03-12", "-07:00", "14:00"), config)), "Thu 2026-03-12 17:30");
  assert.equal(pacificStamp(computeDueAtFromUrgency("YELLOW", on("2026-03-11", "-07:00", "19:00"), config)), "Thu 2026-03-12 17:30");
});

/* ------------------------------------------------------------ the claim clamp */

await check("a Friday 15:00 claim clamps to Friday 15:30", async () => {
  for (const [date, offset] of FRIDAYS) {
    const claimedAt = on(date, offset, "15:00");
    assert.equal(pacificStamp(computeClaimAnchoredDueAt("ORANGE", claimedAt, config)), `Fri ${date} 15:30`, `${date} ORANGE`);
    assert.equal(pacificStamp(computeClaimAnchoredDueAt("YELLOW", claimedAt, config)), `Fri ${date} 15:30`, `${date} YELLOW`);
  }
});

await check("RED keeps its 15-minute window at Friday's close, unclamped", async () => {
  assert.equal(pacificStamp(computeClaimAnchoredDueAt("RED", on("2026-03-13", "-07:00", "15:25"), config)), "Fri 2026-03-13 15:40");
});

await check("a claim after Friday's close anchors to Monday's open", async () => {
  assert.equal(pacificStamp(computeClaimAnchoredDueAt("ORANGE", on("2026-03-13", "-07:00", "16:00"), config)), "Mon 2026-03-16 09:30");
  assert.equal(pacificStamp(computeClaimAnchoredDueAt("ORANGE", on("2026-10-30", "-07:00", "16:00"), config)), "Mon 2026-11-02 09:30");
});

await check("a Thursday claim still clamps to 17:30", async () => {
  assert.equal(pacificStamp(computeClaimAnchoredDueAt("ORANGE", on("2026-03-12", "-07:00", "17:00"), config)), "Thu 2026-03-12 17:30");
});

console.log(`\n${passed} checks passed`);
