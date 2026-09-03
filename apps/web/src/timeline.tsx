import { CLOSED_STATUSES, LoanTask, TaskStatus, TaskType, statusDisplayName } from "@loan-tasks/shared";

/* ── Status timeline (expanded body) ──────────────────────── */
/* The one component lifted out of App.tsx, because it is the web surface that
   puts a status into words for a person. #247 renders it to markup and reads
   the words back; App.tsx cannot be imported into a node script, and a rule
   nothing can check is a rule that drifts. Everything else the rail needs
   comes from the shared package, so it renders on its own.

   Rail of the task's lifecycle. NEEDS_REVIEW sits on the CLAIMED step (and
   tags it); ARCHIVED reads as COMPLETED. The current in-flight step carries a
   "NOW" (or "NEEDS CORRECTIONS") chip. Removed in #106 alongside the two-column
   expanded body, restored here — the expanded body is a single stacked column
   now, so it renders as a compact horizontal rail at every width rather than
   the old tall vertical dot-list.

   Step names are the rail's own ("Opened", not "Open") except where the shared
   `statusDisplayName` has a say (#237): the claimed step on an LOI reads
   "In review", and the chip on the corrections state reads "Needs corrections"
   — never a literal here, so the bot and the web cannot drift apart on it.

   The one place those two rules would collide: an LOI sitting in corrections
   is drawn on the claimed step, so asking for the claimed name would put
   "In review" beside a "NEEDS CORRECTIONS" chip — the exact pairing ADR-0007
   rule 4 exists to stop, since by then the review has happened and the checker
   has found something. While the task is in corrections the step falls back to
   the rail's own "Claimed", which is still true of it, and the chip carries
   the news. */
const TIMELINE_LABELS: Record<string, string> = {
  OPEN: "Opened",
  CLAIMED: "Claimed",
  MERGE_DONE: "Merge done",
  MERGE_APPROVED: "Merge approved",
  // FRAUD two-phase (#39): outstanding items sent to the requester, then the
  // requester submits them back for the checker's final approval.
  AWAITING_ITEMS: "Outstanding items",
  PENDING_APPROVAL: "Final approval",
  COMPLETED: "Completed"
};
const timelineLabel = (status: TaskStatus, taskType: TaskType): string =>
  statusDisplayName(status, taskType) ?? TIMELINE_LABELS[status] ?? status;
export const Timeline = ({ task }: { task: LoanTask }) => {
  const flow: TaskStatus[] =
    task.taskType === "LOAN_DOCS"
      ? ["OPEN", "CLAIMED", "MERGE_DONE", "MERGE_APPROVED", "COMPLETED"]
      : task.taskType === "FRAUD"
        ? ["OPEN", "CLAIMED", "AWAITING_ITEMS", "PENDING_APPROVAL", "COMPLETED"]
        : ["OPEN", "CLAIMED", "COMPLETED"];
  const effective: TaskStatus =
    task.status === "NEEDS_REVIEW" ? "CLAIMED" : task.status === "ARCHIVED" ? "COMPLETED" : task.status;
  const idx = flow.indexOf(effective);
  return (
    <div className="timeline">
      {flow.map((s, i) => {
        const done = i <= idx;
        const current = i === idx && !CLOSED_STATUSES.includes(task.status);
        const dotColor = done
          ? s === "COMPLETED" && task.status === "COMPLETED"
            ? "var(--good)"
            : "var(--brand)"
          : "var(--line)";
        return (
          <div key={s} className="tl-item">
            <span className="tl-dot" style={{ background: dotColor }} />
            <div className="tl-body">
              <b style={{ color: done ? "var(--ink)" : "var(--muted)" }}>
                {s === "CLAIMED" && task.status === "NEEDS_REVIEW"
                  ? TIMELINE_LABELS.CLAIMED
                  : timelineLabel(s, task.taskType)}
              </b>
              {current && task.status === "NEEDS_REVIEW" && (
                <span className="tag tag-warn">{timelineLabel(task.status, task.taskType).toUpperCase()}</span>
              )}
              {current && task.status !== "NEEDS_REVIEW" && <span className="tag tag-brand">NOW</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
};
