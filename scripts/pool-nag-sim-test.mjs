#!/usr/bin/env node
/*
 * Issue #207 — the pool nag: asking the room to pick up an unclaimed task.
 *
 * The mechanism itself shipped once inside #185 and was pulled back out, because
 * review found two ways a repeating, public, addressed-to-everybody channel post
 * misfires. Both are the point of this suite, and both are asserted from the
 * outside — `runMaintenance`'s `nagged` count and the events an observing
 * notifier actually received — rather than by reading the predicate, because the
 * failure mode in each case is "a card lands in the channel", not "a boolean is
 * wrong".
 *
 *   Blocker 1: `isPoolNagDue` falls back to `createdAt` when `lastPoolNagAt` is
 *   absent, and it is absent on every task written before this feature existed.
 *   The first maintenance pass after deploy therefore reads the whole open queue
 *   as overdue for a nag and posts one card per task at once. `theBlocker` below
 *   pins that behaviour deliberately, so the backfill that fixes it can never be
 *   quietly deleted without a test going red.
 *
 *   Blocker 2: there are two doors back to OPEN and only one of them stamped the
 *   clock. Each door already posts a fresh claimable card, which IS nag zero —
 *   so an unstamped door lets a nag fire seconds later repeating the post the
 *   room has only just read.
 *
 * Every service-level check runs inside `withFrozenTime` at a Wednesday
 * mid-morning against the REAL 8:30-17:30 window, for the reason
 * claim-deadline-sim-test.mjs records: `isWithinBusinessHours` rejects the
 * weekend before it looks at configured hours, so a suite that reads the wall
 * clock is a test of what day it happened to run on.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  MAX_POOL_NAGS,
  UNCLAIMED_ALERT_MS,
  inPoolSince,
  isPoolNagDue,
  isUnclaimedTooLong
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

const CREATOR = { id: "creator-1", displayName: "Dana Requester", roles: ["LOAN_OFFICER"] };
const CHECKER = { id: "checker-1", displayName: "Casey Checker", roles: ["FILE_CHECKER"] };

/* Wednesday 2026-03-11, Pacific — a weekday clear of the DST boundary. 10:00 is
   well inside the window; 18:30 is after close and 07:00 before open, for the
   two checks that care. */
const AT_1000 = "2026-03-11T10:00:00-07:00";
const AT_1025 = "2026-03-11T10:25:00-07:00";
const AT_1050 = "2026-03-11T10:50:00-07:00";
const AFTER_CLOSE = "2026-03-11T18:30:00-07:00";

const withFrozenTime = async (iso, fn) => {
  const fixedMs = new Date(iso).getTime();
  const RealDate = Date;

  class MockDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(fixedMs);
      } else {
        super(...args);
      }
    }

    static now() {
      return fixedMs;
    }
  }

  globalThis.Date = MockDate;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
};

const setup = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pool-nag-sim-"));
  const store = new TaskStore(path.join(dir, "tasks.json"));
  await store.init();
  const events = [];
  const notifier = { notify: async (event) => { events.push(event); }, canReachDm: async () => true };
  const service = new TaskService(store, notifier, new SseHub(), config);
  return { service, store, events };
};

const patch = async (store, taskId, apply) => store.updateTask(taskId, (current) => ({ task: apply(current) }));

const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();

const nagsIn = (events) => events.filter((event) => event.target === "CHANNEL_NAG");

/* A task in the shape the data file holds them in today: open, unclaimed, well
   past the twenty-minute mark, and with no `lastPoolNagAt` because the field did
   not exist when it was written. */
const legacyOpenTask = async (service, store, folderName, minutes = 90) => {
  const task = await service.createTask(
    { folderName, taskType: "VALUE", notes: "n", urgency: "GREEN" },
    CREATOR
  );
  await patch(store, task.id, (current) => {
    const { lastPoolNagAt: _stamp, poolNagCount: _count, ...rest } = current;
    return { ...rest, createdAt: minutesAgo(minutes) };
  });
  return task;
};

let passed = 0;
const check = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

console.log("The pool nag — #207");

/* ------------------------------------------------------------- the predicate */

const openTask = (over = {}) => ({
  id: "t1",
  folderName: "Folder",
  taskType: "VALUE",
  status: "OPEN",
  urgency: "GREEN",
  createdBy: CREATOR,
  createdAt: new Date("2026-03-11T09:00:00-07:00").toISOString(),
  updatedAt: new Date("2026-03-11T09:00:00-07:00").toISOString(),
  dueAt: new Date("2026-03-12T09:00:00-07:00").toISOString(),
  ...over
});

const NOW = new Date(AT_1000);

await check("an hour-old unclaimed task is due a nag", async () => {
  assert.equal(isPoolNagDue(openTask(), NOW, config), true);
});

await check("a task nagged within the last twenty minutes is not", async () => {
  assert.equal(
    isPoolNagDue(openTask({ lastPoolNagAt: new Date("2026-03-11T09:50:00-07:00").toISOString() }), NOW, config),
    false
  );
});

await check("OOO is never nagged — it is a vacation notice, not a request for hands", async () => {
  assert.equal(isPoolNagDue(openTask({ taskType: "OOO" }), NOW, config), false);
});

await check("a task with a holder is not the pool's problem", async () => {
  assert.equal(isPoolNagDue(openTask({ assignee: CHECKER }), NOW, config), false);
});

await check("a task that has left OPEN is not nagged", async () => {
  assert.equal(isPoolNagDue(openTask({ status: "COMPLETED" }), NOW, config), false);
});

await check("nothing is nagged outside business hours", async () => {
  assert.equal(isPoolNagDue(openTask(), new Date(AFTER_CLOSE), config), false);
});

await check("the nag stops at the ceiling rather than repeating forever", async () => {
  assert.equal(isPoolNagDue(openTask({ poolNagCount: MAX_POOL_NAGS - 1 }), NOW, config), true);
  assert.equal(isPoolNagDue(openTask({ poolNagCount: MAX_POOL_NAGS }), NOW, config), false);
  assert.equal(isPoolNagDue(openTask({ poolNagCount: MAX_POOL_NAGS + 4 }), NOW, config), false);
});

await check("the channel cadence and the creator's row read one constant", async () => {
  // Not a tautology: the two predicates are separate functions, and the point of
  // the shared constant is that the creator cannot be watching a calm row while
  // the room is being pestered. Straddle the threshold and they must agree.
  const justUnder = new Date(NOW.getTime() - UNCLAIMED_ALERT_MS + 60_000).toISOString();
  const justOver = new Date(NOW.getTime() - UNCLAIMED_ALERT_MS - 60_000).toISOString();

  assert.equal(isPoolNagDue(openTask({ createdAt: justUnder }), NOW, config), false);
  assert.equal(isUnclaimedTooLong(openTask({ createdAt: justUnder }), NOW), false);

  assert.equal(isPoolNagDue(openTask({ createdAt: justOver }), NOW, config), true);
  assert.equal(isUnclaimedTooLong(openTask({ createdAt: justOver }), NOW), true);
});

/* ------------------------------------------- blocker 1: the first pass after deploy */

await check("THE BLOCKER: without the backfill, every legacy open task nags at once", async () =>
  withFrozenTime(AT_1000, async () => {
    const { service, store, events } = await setup();
    await legacyOpenTask(service, store, "Legacy One");
    await legacyOpenTask(service, store, "Legacy Two");
    await legacyOpenTask(service, store, "Legacy Three");

    const result = await service.runMaintenance();

    /* Pinned on purpose. This is what ships if the boot backfill is removed:
       three tasks that have been sitting quietly for an hour and a half all
       shout at the channel on the first maintenance pass, because an absent
       stamp reads as "never nagged" and their `createdAt` is long past. */
    assert.equal(result.nagged, 3);
    assert.equal(nagsIn(events).length, 3);
  })
);

await check("after the backfill, the same queue says nothing on the first pass", async () =>
  withFrozenTime(AT_1000, async () => {
    const { service, store, events } = await setup();
    await legacyOpenTask(service, store, "Legacy One");
    await legacyOpenTask(service, store, "Legacy Two");
    await legacyOpenTask(service, store, "Legacy Three");

    const backfilled = await service.backfillPoolNagClock();
    assert.equal(backfilled.stamped, 3, "all three were open, unclaimed and unstamped");

    const result = await service.runMaintenance();
    assert.equal(result.nagged, 0, "their clock starts at the backfill, not at creation");
    assert.equal(nagsIn(events).length, 0, "and the channel hears nothing");
  })
);

await check("the backfill delays the nag, it does not cancel it", async () => {
  const { service, store, events } = await setup();
  await withFrozenTime(AT_1000, async () => {
    await legacyOpenTask(service, store, "Legacy One");
    await legacyOpenTask(service, store, "Legacy Two");
    await service.backfillPoolNagClock();
    await service.runMaintenance();
  });

  await withFrozenTime(AT_1025, async () => {
    const result = await service.runMaintenance();
    assert.equal(result.nagged, 2, "twenty-five minutes past the backfill, both are due");
    assert.equal(nagsIn(events).length, 2);
  });
});

await check("a restart does not delay the first nag of a task too young to have earned one", async () => {
  /* The backfill runs on every boot, not only the first, so it has to leave
     alone anything that has not yet earned a nag. Without the age check a task
     filed minutes before a deploy has its clock reset by the restart, and a
     busy deploy window starves its first nag entirely. */
  const { service, store, events } = await setup();
  let fresh;
  await withFrozenTime(AT_1000, async () => {
    fresh = await service.createTask(
      { folderName: "Filed Just Now", taskType: "VALUE", notes: "n", urgency: "GREEN" },
      CREATOR
    );
  });

  // A restart twelve minutes later, while the task is still too young to nag.
  await withFrozenTime("2026-03-11T10:12:00-07:00", async () => {
    const backfilled = await service.backfillPoolNagClock();
    assert.equal(backfilled.stamped, 0, "nothing to suppress, so nothing is stamped");
    assert.equal((await store.findTask(fresh.id)).lastPoolNagAt, undefined, "its clock is untouched");
  });

  // So it still nags on its original schedule rather than twenty minutes later.
  await withFrozenTime(AT_1025, async () => {
    assert.equal((await service.runMaintenance()).nagged, 1, "the restart cost it nothing");
    assert.match(nagsIn(events)[0].message, /still unclaimed after 25 minutes/);
  });
});

await check("the backfill is idempotent, and leaves the second boot alone", async () =>
  withFrozenTime(AT_1000, async () => {
    const { service, store } = await setup();
    await legacyOpenTask(service, store, "Legacy One");

    assert.equal((await service.backfillPoolNagClock()).stamped, 1);
    assert.equal((await service.backfillPoolNagClock()).stamped, 0, "nothing left without a stamp");
  })
);

await check("the backfill touches only what the nag would look at", async () =>
  withFrozenTime(AT_1000, async () => {
    const { service, store } = await setup();

    const ooo = await service.createTask(
      { folderName: "Vacation", taskType: "OOO", notes: "n", startDate: "2026-03-16", returnDate: "2026-03-20" },
      CREATOR
    );
    const claimed = await legacyOpenTask(service, store, "Already Taken");
    await service.claimTask(claimed.id, CHECKER);
    await service.settleBackgroundWork();

    assert.equal((await service.backfillPoolNagClock()).stamped, 0);
    assert.equal((await store.findTask(ooo.id)).lastPoolNagAt, undefined, "a holiday is not stamped");
    assert.equal((await store.findTask(claimed.id)).lastPoolNagAt, undefined, "nor is a task with a holder");
  })
);

await check("a task filed after the backfill nags on the normal cadence", async () => {
  const { service, store, events } = await setup();
  let filed;
  await withFrozenTime(AT_1000, async () => {
    await service.backfillPoolNagClock();
    filed = await service.createTask(
      { folderName: "Filed Today", taskType: "VALUE", notes: "n", urgency: "GREEN" },
      CREATOR
    );
    assert.equal((await service.runMaintenance()).nagged, 0, "brand new, nobody has had a chance yet");
  });

  await withFrozenTime(AT_1025, async () => {
    // Twenty-five minutes old and still nobody's: this is the feature working.
    const result = await service.runMaintenance();
    assert.equal(result.nagged, 1);
    assert.equal(nagsIn(events).length, 1);
    assert.match(nagsIn(events)[0].message, /still unclaimed after 25 minutes/);
    assert.equal((await store.findTask(filed.id)).poolNagCount, 1);
  });
});

/* -------------------------------------------------------- blocker 1: the ceiling */

await check("a task stops nagging once it has spent its ceiling", async () => {
  const { service, store, events } = await setup();
  let task;
  await withFrozenTime(AT_1000, async () => {
    task = await legacyOpenTask(service, store, "Nobody Wants This");
    // One short of the ceiling, last nagged long enough ago to be due again.
    await patch(store, task.id, (current) => ({
      ...current,
      poolNagCount: MAX_POOL_NAGS - 1,
      lastPoolNagAt: minutesAgo(30)
    }));

    assert.equal((await service.runMaintenance()).nagged, 1, "the last one it is owed");
    assert.equal((await store.findTask(task.id)).poolNagCount, MAX_POOL_NAGS);
  });

  await withFrozenTime(AT_1050, async () => {
    assert.equal((await service.runMaintenance()).nagged, 0, "and never again for this spell in the pool");
    assert.equal(nagsIn(events).length, 1);
  });
});

await check("a task that finds a holder gets a fresh ceiling if it comes back", async () => {
  const { service, store } = await setup();
  await withFrozenTime(AT_1000, async () => {
    const task = await legacyOpenTask(service, store, "Round Trip");
    await patch(store, task.id, (current) => ({
      ...current,
      poolNagCount: MAX_POOL_NAGS,
      lastPoolNagAt: minutesAgo(30)
    }));

    await service.claimTask(task.id, CHECKER);
    await service.settleBackgroundWork();
    const claimed = await store.findTask(task.id);
    assert.equal(claimed.poolNagCount, undefined, "an exhausted count is not carried back into the pool");
    assert.equal(claimed.lastPoolNagAt, undefined, "and neither is the stamp");
  });
});

/* ------------------------------------------------- blocker 2: the two reopen doors */

await check("THE BLOCKER: unclaiming does not let a nag repeat the reopen post", async () => {
  const { service, store, events } = await setup();
  await withFrozenTime(AT_1000, async () => {
    const task = await legacyOpenTask(service, store, "Handed Back");
    await service.claimTask(task.id, CHECKER);
    await service.unclaimTask(task.id, CHECKER);
    // The notification fan-out is backgrounded (#119), so an assertion about
    // what the channel received has to wait for it rather than race it.
    await service.settleBackgroundWork();

    // The channel has just been re-alerted with a fresh claimable card. That
    // post is nag zero; a nag now would say the same thing twice.
    assert.equal(
      events.filter((event) => event.target === "CHANNEL_REOPENED").length,
      1,
      "the reopen post is the thing a nag would be duplicating"
    );
    assert.equal((await service.runMaintenance()).nagged, 0);
    assert.equal(nagsIn(events).length, 0);
    assert.ok((await store.findTask(task.id)).lastPoolNagAt, "the door stamped the clock");
  });

  await withFrozenTime(AT_1025, async () => {
    assert.equal((await service.runMaintenance()).nagged, 1, "twenty minutes later it is a fair ask again");
  });
});

await check("THE BLOCKER: the status door back to OPEN stamps the clock too", async () => {
  const { service, store, events } = await setup();
  await withFrozenTime(AT_1000, async () => {
    const task = await legacyOpenTask(service, store, "Reopened");
    /* Closed with nobody on it — the state a FRAUD check released for any
       checker lands in when it is approved from PENDING_APPROVAL unassigned.
       That is the one that reaches the OPEN branch below rather than falling
       back to CLAIMED, and it is the door `unclaimTask` does not cover. */
    await patch(store, task.id, (current) => {
      const { assignee: _assignee, ...rest } = current;
      return { ...rest, status: "COMPLETED", completedAt: minutesAgo(5) };
    });

    const reopened = await service.transitionStatus(task.id, "OPEN", CREATOR);
    await service.settleBackgroundWork();
    assert.equal(reopened.status, "OPEN", "no assignee to retain, so it really is back in the pool");
    assert.equal(
      events.filter((event) => event.target === "CHANNEL_REOPENED").length,
      1,
      "which means the channel got its fresh claimable card — nag zero"
    );

    assert.equal((await service.runMaintenance()).nagged, 0, "so the nag does not immediately repeat it");
    assert.equal(nagsIn(events).length, 0);
  });

  await withFrozenTime(AT_1025, async () => {
    assert.equal((await service.runMaintenance()).nagged, 1);
  });
});

await check("a reopen does not buy a task another six asks", async () =>
  withFrozenTime(AT_1000, async () => {
    const { service, store } = await setup();
    const task = await legacyOpenTask(service, store, "Round And Round");
    /* Unassigned and closed with its ceiling already spent. Resetting the count
       on this door would make COMPLETED -> OPEN an unbounded nag: cycle the task
       and the room gets another six asks every time. Claiming is what earns a
       fresh ceiling, because that is the only door where somebody actually took
       the work. */
    await patch(store, task.id, (current) => {
      const { assignee: _assignee, ...rest } = current;
      return { ...rest, status: "COMPLETED", completedAt: minutesAgo(5), poolNagCount: MAX_POOL_NAGS };
    });

    const reopened = await service.transitionStatus(task.id, "OPEN", CREATOR);
    await service.settleBackgroundWork();
    assert.equal(reopened.status, "OPEN");
    assert.equal((await store.findTask(task.id)).poolNagCount, MAX_POOL_NAGS, "the ceiling survives the reopen");
  })
);

await check("a task handed back says how long it has been up for grabs, not how old it is", async () => {
  /* #210. The nag used to count from `createdAt`, so a task filed two days ago,
     worked on, and handed back announced "still unclaimed after 2880 minutes"
     twenty-five minutes after it returned to the pool. True of the task, false
     of the sentence it is in. */
  const { service, store, events } = await setup();
  let task;
  await withFrozenTime(AT_1000, async () => {
    // Filed two days ago and claimed, so `createdAt` is nowhere near the truth.
    task = await legacyOpenTask(service, store, "Old Folder", 2 * 24 * 60);
    await service.claimTask(task.id, CHECKER);
    await service.unclaimTask(task.id, CHECKER);
    await service.settleBackgroundWork();
  });

  await withFrozenTime(AT_1025, async () => {
    assert.equal((await service.runMaintenance()).nagged, 1);
    assert.match(
      nagsIn(events)[0].message,
      /still unclaimed after 25 minutes/,
      "counted from re-entering the pool, not from when it was filed"
    );
  });

  const stored = await store.findTask(task.id);
  assert.ok(stored.pooledSince, "the door stamped when it went back");
  assert.notEqual(inPoolSince(stored), stored.createdAt, "and that is what the accessor answers");
});

await check("the creator's row counts the same clock as the channel", async () => {
  const { service, store } = await setup();
  let task;
  await withFrozenTime(AT_1000, async () => {
    task = await legacyOpenTask(service, store, "Handed Back Fresh", 2 * 24 * 60);
    await service.claimTask(task.id, CHECKER);
    await service.unclaimTask(task.id, CHECKER);
    await service.settleBackgroundWork();
  });

  /* Five minutes back in the pool. Reading `createdAt` the row would shout
     "unclaimed for 2 days" and go red immediately; the room, meanwhile, has not
     been asked once. The two surfaces share the threshold AND the anchor. */
  await withFrozenTime("2026-03-11T10:05:00-07:00", async () => {
    const fresh = await store.findTask(task.id);
    assert.equal(isUnclaimedTooLong(fresh, new Date()), false, "five minutes is not too long");
    assert.equal(isPoolNagDue(fresh, new Date(), config), false, "and the room is not asked either");
  });

  await withFrozenTime(AT_1025, async () => {
    const aged = await store.findTask(task.id);
    assert.equal(isUnclaimedTooLong(aged, new Date()), true, "twenty-five minutes is");
    assert.equal(isPoolNagDue(aged, new Date(), config), true, "and both surfaces turn together");
  });
});

await check("a task nobody ever claimed still counts from when it was filed", async () => {
  // The fallback: no `pooledSince` means it never left, so `createdAt` is right.
  const filed = openTask({ createdAt: new Date("2026-03-11T09:00:00-07:00").toISOString() });
  assert.equal(inPoolSince(filed), filed.createdAt);
  assert.equal(isUnclaimedTooLong(filed, NOW), true);
});

await check("the creator's back-to-the-pool door is nag zero too", async () => {
  /* #208 added a third way a task lands back in the pool: the creator taking it
     off a stalled holder. It posts the same CHANNEL_REOPENED card as the other
     two, so it is nag zero for the same reason — and because it shares
     `sendBackToPool`, it inherited the stamp rather than having to remember it.
     This check is what would fail if that seam were ever split apart. */
  const { service, store, events } = await setup();
  let task;
  await withFrozenTime(AT_1000, async () => {
    task = await legacyOpenTask(service, store, "Stalled On");
    await service.claimTask(task.id, CHECKER);
    await service.returnToPool(task.id, CREATOR);
    await service.settleBackgroundWork();

    assert.equal(
      events.filter((event) => event.target === "CHANNEL_REOPENED").length,
      1,
      "the room already has a fresh claimable card"
    );
    assert.ok((await store.findTask(task.id)).lastPoolNagAt, "so the clock is stamped");
    assert.equal((await service.runMaintenance()).nagged, 0, "and no nag repeats it");
  });

  await withFrozenTime(AT_1025, async () => {
    assert.equal((await service.runMaintenance()).nagged, 1, "twenty minutes on, asking again is fair");
  });
});

await check("reopening onto a retained assignee is nobody's pool problem", async () =>
  withFrozenTime(AT_1000, async () => {
    const { service, store, events } = await setup();
    const task = await legacyOpenTask(service, store, "Still Theirs");
    await service.claimTask(task.id, CHECKER);
    await patch(store, task.id, (current) => ({ ...current, status: "COMPLETED", completedAt: minutesAgo(5) }));

    const reopened = await service.transitionStatus(task.id, "OPEN", CREATOR);
    await service.settleBackgroundWork();
    assert.equal(reopened.status, "CLAIMED", "the assignee is retained, so it never reaches the pool");
    assert.equal(events.filter((event) => event.target === "CHANNEL_REOPENED").length, 0);
    assert.equal((await service.runMaintenance()).nagged, 0);
  })
);

console.log(`\n${passed} checks passed`);
