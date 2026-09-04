#!/usr/bin/env node
/*
 * Reset local dev data to a small, hand-shaped cast of tasks.
 *
 *   npm run dev:reset
 *   npm run dev:reset -- --data-file apps/server/data/scratch.json
 *   npm run dev:reset -- --keep   (leave existing tasks, add the cast alongside)
 *
 * Why: a dev store accumulates hundreds of throwaway tasks from test runs and
 * poking at the UI, and every one of them is between you and the thing you
 * wanted to look at. This files ~a dozen instead, one per shape worth seeing:
 * an overdue unclaimed task, a task waiting on a nag, both sides of the Loan
 * Docs merge chain, all three live phases of the Fraud round trip, an OOO, a
 * task in review, and one each of completed / cancelled / archived so the
 * closed views aren't empty either.
 *
 * Times are relative to the moment you run it, so the urgency colours, the
 * overdue nudge and the "sitting in the pool" counters all mean something.
 *
 * What it touches (all under apps/server/data, or beside --data-file):
 *   tasks.json          replaced (previous copy backed up first)
 *   loans.json          replaced — the loans the seeded tasks hang off
 *   bot-note-cards.json, bot-detail-cards.json, bot-task-threads.json,
 *   activity-feed-state.json
 *                       emptied — every entry is keyed by a task id that no
 *                       longer exists, so keeping them only strands cards
 *
 * What it deliberately leaves alone:
 *   users.json          your cast and their roles; the mock user switcher
 *   admin-settings.json the notification channel you picked
 *   bot-references.json who has messaged the bot — earned, and painful to redo
 *
 * The old tasks.json/loans.json are copied to data/backups/<timestamp>/ before
 * anything is written, so a mistaken run is recoverable.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

if (flag("help")) {
  console.log("Usage: node scripts/reset-dev-data.mjs [--data-file <path>] [--keep] [--no-backup]");
  process.exit(0);
}

const dataFile = path.resolve(process.cwd(), option("data-file") ?? "apps/server/data/tasks.json");
const dataDir = path.dirname(dataFile);
const loansFile = path.resolve(dataDir, "loans.json");

/* Card/thread/signal state is keyed by task id. Wiping tasks without wiping
   these leaves records pointing at tasks that no longer exist. */
const DERIVED_STATE = [
  ["bot-note-cards.json", "[]"],
  ["bot-detail-cards.json", "[]"],
  ["bot-task-threads.json", "[]"],
  ["activity-feed-state.json", JSON.stringify({ signals: [] }, null, 2)]
];

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const now = Date.now();
const at = (offsetMs) => new Date(now + offsetMs).toISOString();
const dateOnly = (offsetMs) => new Date(now + offsetMs).toISOString().slice(0, 10);

/* The cast. Ids match apps/server/data/users.json, so the mock user switcher in
   the web app can step into any of them. Every one of them both asks for work
   and holds some, so whoever you switch to has something to do. */
const JOHANNA = { id: "admin-1", displayName: "Johanna" };
const SUZIE = { id: "loan-officer-1", displayName: "Suzie" };
const ALEXA = { id: "file-checker-1", displayName: "Alexa" };
const HEATHER = { id: "new-1", displayName: "Heather Finn" };

const note = (by, text, offsetMs) => ({ text, by, at: at(offsetMs) });

const checklistItem = (id, text, addedBy, extra = {}) => ({
  id,
  text,
  checked: false,
  addedBy,
  addedOnPass: 1,
  ...extra
});

/* Loans the tasks hang off (ADR-0001). A couple of tasks deliberately share
   one, so the "two tasks on the same file" case is visible. */
const LOANS = [
  { id: "seed-loan-alvarez", name: "Alvarez-2201" },
  { id: "seed-loan-brennan", name: "Brennan-1187" },
  { id: "seed-loan-castillo", name: "Castillo-3340" },
  { id: "seed-loan-dunlap", name: "Dunlap-0925" },
  { id: "seed-loan-esposito", name: "Esposito-4412" },
  { id: "seed-loan-fairbanks", name: "Fairbanks-7708" },
  { id: "seed-loan-goodwin", name: "Goodwin-1502" },
  { id: "seed-loan-hollis", name: "Hollis-6034" },
  { id: "seed-loan-ingram", name: "Ingram-2276" }
];

const loanFor = (id) => LOANS.find((loan) => loan.id === id);

/* One task per shape worth looking at. Ids are readable rather than UUIDs —
   nothing validates the format, and `seed-` makes leftovers obvious. */
const TASKS = [
  {
    id: "seed-open-overdue",
    loanId: "seed-loan-alvarez",
    taskType: "LOI",
    status: "OPEN",
    urgency: "RED",
    points: 3,
    /* The one seeded LOI whose terms are typed the way a real one is: several
       short lines, which is the shape #258's terms section exists to render.
       Leave the line breaks in — a single-line seed makes the section look
       like a message with a border round it. */
    notes: [
      "Loan Amount: $2,340,000",
      "Term: 24 months + two 6-month extensions",
      "Rate: 9.75% mos 1-12, 10.50% mos 13-24",
      "Origination: 2.00 pts, due at close",
      "Broker: Dana Whitfield, Crossbeam Commercial",
      "Borrower: Elena Vasquez, Wexford Holdings LLC",
      "",
      "Borrower wants the terms confirmed before the 10am call."
    ].join("\n"),
    createdBy: SUZIE,
    createdAt: at(-3 * HOUR),
    updatedAt: at(-3 * HOUR),
    dueAt: at(-35 * MINUTE),
    pooledSince: at(-3 * HOUR)
  },
  {
    id: "seed-open-nagged",
    loanId: "seed-loan-brennan",
    taskType: "VALUE",
    status: "OPEN",
    urgency: "ORANGE",
    points: 1,
    notes: "Comps look thin on the north side — second opinion please.",
    createdBy: JOHANNA,
    createdAt: at(-50 * MINUTE),
    updatedAt: at(-50 * MINUTE),
    dueAt: at(45 * MINUTE),
    pooledSince: at(-50 * MINUTE),
    lastPoolNagAt: at(-25 * MINUTE),
    poolNagCount: 1
  },
  {
    id: "seed-claimed",
    loanId: "seed-loan-castillo",
    taskType: "LOAN_DOCS",
    status: "CLAIMED",
    urgency: "YELLOW",
    points: 2,
    notes: "Full package, wet signatures on the note.",
    createdBy: SUZIE,
    assignee: ALEXA,
    createdAt: at(-4 * HOUR),
    updatedAt: at(-2 * HOUR),
    dueAt: at(5 * HOUR)
  },
  {
    id: "seed-merge-done",
    loanId: "seed-loan-dunlap",
    taskType: "LOAN_DOCS",
    status: "MERGE_DONE",
    urgency: "YELLOW",
    points: 4,
    notes: "Docs merged, ready for your look.",
    createdBy: JOHANNA,
    assignee: SUZIE,
    createdAt: at(-2 * DAY),
    updatedAt: at(-40 * MINUTE),
    dueAt: at(3 * HOUR),
    reviewNotes: [
      note(SUZIE, "Merged — the hazard binder was the last piece.", -45 * MINUTE),
      note(JOHANNA, "Looking now.", -40 * MINUTE)
    ]
  },
  {
    id: "seed-merge-approved",
    loanId: "seed-loan-esposito",
    taskType: "LOAN_DOCS",
    status: "MERGE_APPROVED",
    urgency: "GREEN",
    points: 2,
    notes: "Standard package.",
    createdBy: SUZIE,
    assignee: HEATHER,
    createdAt: at(-3 * DAY),
    updatedAt: at(-90 * MINUTE),
    dueAt: at(6 * HOUR),
    reviewNotes: [note(SUZIE, "Approved — go ahead and close it out.", -90 * MINUTE)]
  },
  {
    id: "seed-fraud-claimed",
    loanId: "seed-loan-fairbanks",
    taskType: "FRAUD",
    status: "CLAIMED",
    urgency: "ORANGE",
    points: 3,
    notes: "Two of the bank statements look re-typed.",
    createdBy: SUZIE,
    assignee: ALEXA,
    createdAt: at(-6 * HOUR),
    updatedAt: at(-90 * MINUTE),
    dueAt: at(2 * HOUR)
  },
  {
    id: "seed-fraud-awaiting",
    loanId: "seed-loan-goodwin",
    taskType: "FRAUD",
    status: "AWAITING_ITEMS",
    urgency: "YELLOW",
    points: 5,
    notes: "First pass done, items are out with the requester.",
    createdBy: JOHANNA,
    assignee: ALEXA,
    createdAt: at(-2 * DAY),
    updatedAt: at(-2 * HOUR),
    dueAt: at(4 * HOUR),
    checklistPass: 1,
    awaitingItemsSince: at(-2 * HOUR),
    checklist: [
      checklistItem("seed-item-1", "Two months of bank statements, unedited PDFs", "checker", { checked: true }),
      checklistItem("seed-item-2", "Employer verification letter", "checker", {
        note: "Employer is a family LLC — sending the CPA letter instead."
      }),
      checklistItem("seed-item-3", "Photo ID that matches the signature block", "checker")
    ],
    reviewNotes: [note(ALEXA, "Sent the outstanding items over.", -2 * HOUR)]
  },
  {
    id: "seed-fraud-pending",
    loanId: "seed-loan-hollis",
    taskType: "FRAUD",
    status: "PENDING_APPROVAL",
    urgency: "YELLOW",
    points: 3,
    notes: "Second pass back with the checker.",
    createdBy: SUZIE,
    assignee: ALEXA,
    createdAt: at(-4 * DAY),
    updatedAt: at(-25 * MINUTE),
    dueAt: at(7 * HOUR),
    checklistPass: 2,
    awaitingItemsSince: at(-1 * DAY),
    checklist: [
      checklistItem("seed-item-4", "Signed 4506-C", "checker", { checked: true, addedOnPass: 1 }),
      checklistItem("seed-item-5", "Source of the wire from the second account", "checker", {
        checked: true,
        addedOnPass: 2
      })
    ],
    reviewNotes: [note(SUZIE, "Both items handled — back to you.", -25 * MINUTE)]
  },
  {
    id: "seed-needs-review",
    loanId: "seed-loan-ingram",
    taskType: "BUDDY_CHAT",
    status: "NEEDS_REVIEW",
    urgency: "GREEN",
    points: 1,
    notes: "Wants a sanity check on the exit strategy.",
    createdBy: HEATHER,
    assignee: SUZIE,
    createdAt: at(-1 * DAY),
    updatedAt: at(-3 * HOUR),
    dueAt: at(20 * HOUR),
    reviewNotes: [note(SUZIE, "Talked it through — one open question on the takeout lender.", -3 * HOUR)]
  },
  {
    id: "seed-ooo",
    taskType: "OOO",
    status: "OPEN",
    urgency: "GREEN",
    points: 0,
    notes: "Out for a long weekend — anything urgent goes to Suzie.",
    folderName: "Heather out Thu–Mon",
    createdBy: HEATHER,
    createdAt: at(-1 * DAY),
    updatedAt: at(-1 * DAY),
    startDate: dateOnly(2 * DAY),
    returnDate: dateOnly(6 * DAY),
    dueAt: at(6 * DAY),
    pooledSince: at(-1 * DAY)
  },
  {
    id: "seed-completed",
    loanId: "seed-loan-alvarez",
    taskType: "LOI",
    status: "COMPLETED",
    urgency: "GREEN",
    points: 2,
    notes: "Terms matched the term sheet.",
    createdBy: JOHANNA,
    assignee: SUZIE,
    createdAt: at(-2 * DAY),
    updatedAt: at(-1 * DAY),
    dueAt: at(-1 * DAY),
    completedAt: at(-1 * DAY),
    reviewNotes: [note(SUZIE, "All clean, nothing to flag.", -1 * DAY)]
  },
  {
    id: "seed-cancelled",
    loanId: "seed-loan-brennan",
    taskType: "LOI",
    status: "CANCELLED",
    urgency: "YELLOW",
    points: 1,
    notes: "Duplicate of the one Suzie already filed.",
    createdBy: ALEXA,
    createdAt: at(-3 * DAY),
    updatedAt: at(-3 * DAY + 20 * MINUTE),
    dueAt: at(-3 * DAY + 8 * HOUR),
    cancelledAt: at(-3 * DAY + 20 * MINUTE)
  },
  {
    id: "seed-archived",
    loanId: "seed-loan-castillo",
    taskType: "VALUE",
    status: "ARCHIVED",
    urgency: "GREEN",
    points: 3,
    notes: "Value came in at 1.4M.",
    createdBy: SUZIE,
    assignee: ALEXA,
    createdAt: at(-9 * DAY),
    updatedAt: at(-7 * DAY),
    dueAt: at(-8 * DAY),
    completedAt: at(-8 * DAY),
    archivedAt: at(-7 * DAY)
  }
];

/* Fill in what every task needs but the definitions above shouldn't repeat:
   the folder name and Humperdink link cached off the loan (absent on OOO,
   which has no loan behind it), and the `loanName` compatibility alias. */
const materialize = (seed) => {
  const loan = seed.loanId ? loanFor(seed.loanId) : undefined;
  if (seed.loanId && !loan) {
    throw new Error(`Task ${seed.id} references unknown loan ${seed.loanId}`);
  }
  const folderName = seed.folderName ?? loan?.name;
  if (!folderName) {
    throw new Error(`Task ${seed.id} has neither a folder name nor a loan`);
  }
  const task = { ...seed, folderName };
  if (loan) {
    task.loanName = loan.name;
    task.humperdinkLink = `https://humperdink.example.com/loans/${loan.id}`;
  }
  return task;
};

const tasks = TASKS.map(materialize);

/* Enough history that the panel isn't blank: the filing, and the move that put
   the task where it is now. Actions match the ones the server writes. */
const history = [];
let sequence = 0;
const historyEvent = (task, action, detail, iso) => ({
  id: `seed-history-${(sequence += 1)}`,
  taskId: task.id,
  action,
  at: iso,
  by: action === "TASK_CREATED" ? task.createdBy : (task.assignee ?? task.createdBy),
  detail
});

for (const task of tasks) {
  history.push(historyEvent(task, "TASK_CREATED", `Created ${task.taskType} task`, task.createdAt));
  if (task.assignee) {
    history.push(historyEvent(task, "TASK_CLAIMED", `Claimed by ${task.assignee.displayName}`, task.updatedAt));
  }
  if (task.status !== "OPEN" && task.status !== "CLAIMED") {
    history.push(historyEvent(task, "TASK_STATUS_CHANGED", `-> ${task.status}`, task.updatedAt));
  }
}

const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJson = (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");

/* Repo-relative where that reads clearly, absolute when the target is outside
   it (a scratch --data-file under /tmp, say). */
const show = (file) => {
  const relative = path.relative(process.cwd(), file);
  return relative.startsWith("..") ? file : relative;
};

const existingTasks = await readJson(dataFile, { tasks: [], history: [] });
const existingLoans = await readJson(loansFile, { loans: [] });

if (!flag("no-backup")) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const backupDir = path.resolve(dataDir, "backups", stamp);
  await fs.mkdir(backupDir, { recursive: true });
  await writeJson(path.join(backupDir, "tasks.json"), existingTasks);
  await writeJson(path.join(backupDir, "loans.json"), existingLoans);
  console.log(`Backed up ${existingTasks.tasks?.length ?? 0} tasks to ${show(backupDir)}`);
}

const keep = flag("keep");
/* --keep re-seeds without clearing: drop any previous cast by id so a second
   run doesn't double it, then append. */
const survivingTasks = keep
  ? (existingTasks.tasks ?? []).filter((task) => !String(task.id).startsWith("seed-"))
  : [];
const survivingHistory = keep
  ? (existingTasks.history ?? []).filter((event) => !String(event.taskId).startsWith("seed-"))
  : [];
const survivingLoans = keep
  ? (existingLoans.loans ?? []).filter((loan) => !String(loan.id).startsWith("seed-loan-"))
  : [];

await fs.mkdir(dataDir, { recursive: true });
await writeJson(dataFile, {
  tasks: [...survivingTasks, ...tasks],
  history: [...survivingHistory, ...history]
});
await writeJson(loansFile, {
  loans: [
    ...survivingLoans,
    ...LOANS.map((loan) => ({ ...loan, createdAt: at(-10 * DAY), updatedAt: at(-10 * DAY) }))
  ]
});

if (!keep) {
  for (const [name, empty] of DERIVED_STATE) {
    await writeJson(path.join(dataDir, name), JSON.parse(empty));
  }
}

const byStatus = tasks.reduce((counts, task) => {
  counts[task.status] = (counts[task.status] ?? 0) + 1;
  return counts;
}, {});

console.log(`Wrote ${tasks.length} tasks to ${show(dataFile)}`);
console.log(
  Object.entries(byStatus)
    .map(([status, count]) => `  ${status}: ${count}`)
    .join("\n")
);
if (!keep) {
  console.log("Cleared bot card / thread / activity-signal state. Users, admin settings and bot references untouched.");
}
/* No restart needed: the store re-reads the file on every call, so a running
   dev server serves the new board on the next refresh. */
console.log("Refresh the tab — a running dev server picks this up without a restart.");
