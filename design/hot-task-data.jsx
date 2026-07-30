// Hot Task — mock data + domain model (mirrors packages/shared/src/types.ts + workflow.ts)
const TASK_TYPE_META = {
  LOI:       { label: "LOI Check",     glyph: "LOI", color: "#2c5ea0", desc: "Check a letter of intent", notesLabel: "Loan Terms and Contacts", phrase: "needs an LOI checked" },
  VALUE:     { label: "Value Check",   glyph: "VAL", color: "#2e7d4f", desc: "Verify a property value",   notesLabel: "Notes",                    phrase: "needs a Value Check" },
  FRAUD:     { label: "Fraud Check",   glyph: "FRD", color: "#b82d35", desc: "File checkers only",        notesLabel: "Outstanding Items and Notes", phrase: "needs a Fraud Check" },
  LOAN_DOCS: { label: "Loan Docs",     glyph: "DOC", color: "#c25e00", desc: "Docs with merge stages",    notesLabel: "Notes",                    phrase: "needs a set of loan docs done" },
  BUDDY_CHAT:{ label: "Buddy Chat",    glyph: "BUD", color: "#7a5ae0", desc: "Talk through concerns",     notesLabel: "Concerns",                 phrase: "needs a Buddy Chat" },
  OOO:       { label: "Out of Office", glyph: "OOO", color: "#8a847a", desc: "Coverage while out",        notesLabel: "Notes",                    phrase: "needs OOO Coverage" }
};

const URGENCY_META = {
  RED:    { label: "Urgent Now",     key: "red" },
  ORANGE: { label: "Within 1 Hour",  key: "orange" },
  YELLOW: { label: "End of Day",     key: "yellow" },
  GREEN:  { label: "Within 24 Hours",key: "green" }
};

const USERS = [
  { id: "u-tyler", displayName: "Tyler Hereford", roles: ["LOAN_OFFICER", "ADMIN"], color: "#2c5ea0" },
  { id: "u-suzie", displayName: "Suzie Lim",      roles: ["FILE_CHECKER"],          color: "#c25e00" },
  { id: "u-jerry", displayName: "Jerry Park",     roles: ["FILE_CHECKER"],          color: "#2e7d4f" },
  { id: "u-mara",  displayName: "Mara Diaz",      roles: ["LOAN_OFFICER"],          color: "#7a5ae0" }
];

const NOW = Date.now();
const mins = (n) => NOW + n * 60000;
const hrs = (n) => NOW + n * 3600000;

// Statuses: OPEN, CLAIMED, NEEDS_REVIEW, MERGE_DONE, MERGE_APPROVED, COMPLETED, CANCELLED, ARCHIVED
const SEED_TASKS = [
  {
    id: "t1", folderName: "2021 Broadway RWC LLC – Adams", taskType: "LOI",
    urgency: "ORANGE", dueAt: mins(-42), points: 3, status: "OPEN",
    notes: "Rate matrix changed this morning — double-check the spread on page 2. Borrower contact is mid-refi, CC his broker.",
    humperdinkLink: "https://humperdink/loans/2021-broadway",
    createdAt: hrs(-2), createdBy: "u-tyler", assignee: null,
    msgs: []
  },
  {
    id: "t2", folderName: "Hillsdale Plaza – Nguyen", taskType: "FRAUD",
    urgency: "RED", dueAt: mins(-15), points: 5, status: "OPEN",
    notes: "Bank statements don't match stated deposits. Two outstanding items: verify employer, re-pull credit.",
    humperdinkLink: "https://humperdink/loans/hillsdale-plaza",
    createdAt: mins(-50), createdBy: "u-mara", assignee: null,
    msgs: []
  },
  {
    id: "t3", folderName: "417 Pine St – Okafor", taskType: "LOAN_DOCS",
    urgency: "YELLOW", dueAt: hrs(3.4), points: 4, status: "MERGE_DONE",
    notes: "Full doc set. Title company wants the merged package before 4pm.",
    humperdinkLink: "https://humperdink/loans/417-pine",
    createdAt: hrs(-22), createdBy: "u-tyler", assignee: "u-suzie",
    msgs: [
      { by: "u-suzie", at: hrs(-1.2), text: "Merge is done — two signature pages were rotated, fixed both." },
      { by: "u-suzie", at: hrs(-1.1), text: "Flagging: the rider on p.14 references the OLD rate. Want me to swap it before you approve?" }
    ],
    unreadFor: "u-tyler"
  },
  {
    id: "t4", folderName: "Casa Verde Fund II – Ito", taskType: "VALUE",
    urgency: "GREEN", dueAt: hrs(18), points: 2, status: "CLAIMED",
    notes: "Comp set looks thin north of the freeway. Sanity-check the $2.1M number.",
    humperdinkLink: "https://humperdink/loans/casa-verde",
    createdAt: hrs(-5), createdBy: "u-mara", assignee: "u-suzie",
    msgs: [{ by: "u-mara", at: hrs(-4.5), text: "Appraiser said he can hop on a call after 2pm if needed." }]
  },
  {
    id: "t5", folderName: "Beacon Hill Storage – Walsh", taskType: "LOI",
    urgency: "YELLOW", dueAt: hrs(4.2), points: 1, status: "CLAIMED",
    notes: "Standard terms, repeat borrower. Contacts in the folder.",
    humperdinkLink: "https://humperdink/loans/beacon-hill",
    createdAt: hrs(-3), createdBy: "u-tyler", assignee: "u-jerry",
    msgs: []
  },
  {
    id: "t6", folderName: "Marina Gateway – Sotelo", taskType: "BUDDY_CHAT",
    urgency: "GREEN", dueAt: hrs(20), points: 2, status: "NEEDS_REVIEW",
    notes: "Concerns: borrower wants to cross-collateralize with the Fremont property. Not sure the LTV math works.",
    createdAt: hrs(-26), createdBy: "u-tyler", assignee: "u-mara",
    msgs: [
      { by: "u-mara", at: hrs(-2), text: "Talked it through — LTV works IF we carve out the Fremont second. Wrote it up, take a look." }
    ],
    unreadFor: "u-tyler"
  },
  {
    id: "t7", folderName: "OOO — Jerry Park", taskType: "OOO",
    urgency: "GREEN", dueAt: hrs(63), points: 1, status: "CLAIMED",
    notes: "Out Thu–Fri for closing in Tahoe. Suzie covering value checks; route fraud to the pool.",
    createdAt: hrs(-30), createdBy: "u-jerry", assignee: "u-suzie",
    startDate: "2026-06-11", returnDate: "2026-06-15",
    msgs: []
  },
  {
    id: "t8", folderName: "88 Mission Bay – Trent", taskType: "VALUE",
    urgency: "GREEN", dueAt: hrs(-26), points: 3, status: "COMPLETED", completedAt: hrs(-28),
    notes: "Value confirmed at $3.4M, comps attached in folder.",
    createdAt: hrs(-52), createdBy: "u-tyler", assignee: "u-suzie",
    msgs: [{ by: "u-suzie", at: hrs(-28), text: "Done — used the two May comps, ignored the outlier on 4th." }]
  },
  {
    id: "t9", folderName: "Lakeview Duplex – Brand", taskType: "LOAN_DOCS",
    urgency: "GREEN", dueAt: hrs(-50), points: 5, status: "COMPLETED", completedAt: hrs(-49),
    notes: "Gnarly one — three amendments and a vesting change.",
    createdAt: hrs(-96), createdBy: "u-mara", assignee: "u-jerry",
    msgs: []
  }
];

// ── workflow helpers (ported from packages/shared/src/workflow.ts) ──
const CLOSED = ["COMPLETED", "CANCELLED", "ARCHIVED"];
const hasRole = (u, r) => u.roles.includes(r);

function canClaim(task, user) {
  if (task.status !== "OPEN") return false;
  if (task.taskType === "FRAUD" && !hasRole(user, "FILE_CHECKER")) return false;
  return true;
}
function isAssignee(task, user) { return task.assignee === user.id; }
function isCreator(task, user) { return task.createdBy === user.id; }
function isOverdue(task, now) {
  if (CLOSED.includes(task.status)) return false;
  return task.dueAt < now;
}

/* The single most important computation in the redesign:
   whose court is the ball in, and what is the next move? */
function nextMove(task, user) {
  const t = task, me = user;
  if (t.status === "OPEN") {
    if (canClaim(t, me)) return { court: "you", who: "Up for grabs", step: "Claim it to start", action: { label: "Claim", kind: "good", to: "CLAIMED" }, pool: true };
    return { court: "pool", who: "File checkers", step: "Waiting for a claim", action: null, pool: true };
  }
  if (t.status === "CLAIMED") {
    if (isAssignee(t, me)) {
      if (t.taskType === "LOAN_DOCS") return { court: "you", who: "Your move", step: "Merge the doc set", action: { label: "Mark Merge Done", kind: "good", to: "MERGE_DONE" } };
      return { court: "you", who: "Your move", step: "Do the check, then complete", action: { label: "Complete", kind: "good", to: "COMPLETED" } };
    }
    return { court: "them", who: name(t.assignee), step: t.taskType === "LOAN_DOCS" ? "Merging docs" : "Working on it", action: null };
  }
  if (t.status === "MERGE_DONE") {
    if (isCreator(t, me)) return { court: "you", who: "Your move", step: "Review & approve the merge", action: { label: "Approve Merge", kind: "good", to: "MERGE_APPROVED" } };
    return { court: "them", who: name(t.createdBy), step: "Reviewing the merge", action: null };
  }
  if (t.status === "MERGE_APPROVED") {
    if (isAssignee(t, me)) return { court: "you", who: "Your move", step: "Finish out the docs", action: { label: "Complete", kind: "good", to: "COMPLETED" } };
    return { court: "them", who: name(t.assignee), step: "Finishing out", action: null };
  }
  if (t.status === "NEEDS_REVIEW") {
    if (isCreator(t, me)) return { court: "you", who: "Your move", step: "Review the work", action: { label: "Mark Complete", kind: "good", to: "COMPLETED" } };
    if (isAssignee(t, me)) return { court: "them", who: name(t.createdBy), step: "Reviewing your work", action: null };
    return { court: "them", who: name(t.createdBy), step: "In review", action: null };
  }
  if (t.status === "COMPLETED") {
    if (isCreator(t, me)) return { court: "done", who: "Done", step: "Archive when you're happy", action: { label: "Archive", kind: "quiet", to: "ARCHIVED" } };
    return { court: "done", who: "Done", step: "Completed " + ago(t.completedAt || t.dueAt), action: null };
  }
  return { court: "done", who: "Closed", step: t.status.toLowerCase(), action: null };
}

function name(userId) {
  const u = USERS.find((x) => x.id === userId);
  return u ? u.displayName.split(" ")[0] : "—";
}
function userById(id) { return USERS.find((u) => u.id === id); }
function initials(id) {
  const u = userById(id);
  if (!u) return "?";
  return u.displayName.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
}

function ago(ts) {
  const d = Math.max(0, Date.now() - ts);
  const m = Math.round(d / 60000);
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + "h ago";
  return Math.round(h / 24) + "d ago";
}

/* live countdown formatting: "2h 14m" | "38m" | "-1h 5m" (overdue) */
function countdown(dueAt, now) {
  const diff = dueAt - now;
  const abs = Math.abs(diff);
  const m = Math.floor(abs / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  let s;
  if (d >= 2) s = d + "d";
  else if (h >= 1) s = h + "h " + String(m % 60).padStart(2, "0") + "m";
  else s = m + "m";
  return { overdue: diff < 0, text: s };
}

function clockTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function dateTime(ts) {
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" }) + ", " + clockTime(ts);
}

const DINK_CAPTIONS = ["", "Easy money", "Mild annoyance", "Genuinely bad", "Brace yourself", "Total disaster"];

Object.assign(window, {
  TASK_TYPE_META, URGENCY_META, USERS, SEED_TASKS, CLOSED,
  canClaim, isAssignee, isCreator, isOverdue, nextMove,
  name, userById, initials, ago, countdown, clockTime, dateTime, DINK_CAPTIONS
});
