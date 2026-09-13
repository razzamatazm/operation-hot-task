import { CLOSED_STATUSES, LoanTask, TaskStatus, TaskType, statusDisplayName } from "@loan-tasks/shared";

/* PROTOTYPE (throwaway) — see `status-tracker-desktop-prototype.tsx`. */
import { DesktopTracker, desktopVariant } from "./status-tracker-desktop-prototype";

/* ── Status timeline (expanded body) ──────────────────────── */
/* The one component lifted out of App.tsx, because it is the web surface that
   puts a status into words for a person. #247 renders it to markup and reads
   the words back; App.tsx cannot be imported into a node script, and a rule
   nothing can check is a rule that drifts. Everything else the rail needs
   comes from the shared package, so it renders on its own.

   Where the task is in its flow, as one line over a segmented bar (2026-09-13):
   the step it is on, the step after it, and one segment per step filled up to
   the one it is on. It used to draw every step with a dot, a name and a `NOW`
   chip on the current one, and a five-step flow could not fit that on a phone,
   so a Fraud Check or Loan Docs card opened on a rail two or three lines deep.
   Chosen over two other variants driven on the real card, branch
   `prototype/status-tracker`. NEEDS_REVIEW sits on the CLAIMED step, ARCHIVED
   reads as COMPLETED, and a status in no flow (CANCELLED) names itself over an
   empty bar.

   Step names are the rail's own ("Opened", not "Open") except where the shared
   `statusDisplayName` has a say (#237): the claimed step on an LOI reads
   "In review", and the corrections state reads "Needs corrections". Never a
   literal here, so the bot and the web cannot drift apart on it.

   The one place those two rules would collide: an LOI sitting in corrections
   is drawn on the claimed step, and naming that step would say "In review",
   the reading ADR-0007 rule 4 exists to stop, since by then the review has
   happened and the checker has found something. So in corrections the line
   names the state instead of the step, in the step name's place rather than
   beside it. Beside it was a chip, and the chip is what wrapped an LOI's three
   steps onto a second line. */
const TIMELINE_LABELS: Record<string, string> = {
  OPEN: "Opened",
  CLAIMED: "Claimed",
  MERGE_DONE: "Merge done",
  MERGE_APPROVED: "Merge approved",
  // FRAUD two-phase (#39): outstanding items sent to the requester, then the
  // requester submits them back for the checker's final approval.
  AWAITING_ITEMS: "Outstanding items",
  PENDING_APPROVAL: "Final approval",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled"
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
  const step = flow[idx];
  const tone =
    step === undefined
      ? "off"
      : effective === "COMPLETED"
        ? "finished"
        : task.status === "NEEDS_REVIEW"
          ? "corrections"
          : "live";
  const now =
    step !== undefined && tone !== "corrections"
      ? timelineLabel(step, task.taskType)
      : timelineLabel(task.status, task.taskType);
  const following = step !== undefined && !CLOSED_STATUSES.includes(task.status) ? flow[idx + 1] : undefined;
  /* PROTOTYPE (throwaway). With `?variant=A|B|C` a desktop layout renders from
     720px up and this shipped tracker below it. Delete with
     `status-tracker-desktop-prototype.tsx`. */
  const protoVariant = desktopVariant();
  if (protoVariant !== null) {
    return (
      <DesktopTracker
        variant={protoVariant}
        model={{
          labels: flow.map((s) => timelineLabel(s, task.taskType)),
          idx,
          tone,
          now,
          next: following ? timelineLabel(following, task.taskType) : undefined
        }}
      >
        {shippedTracker()}
      </DesktopTracker>
    );
  }
  return shippedTracker();
  function shippedTracker() {
  return (
    <div className={`timeline timeline-${tone}`}>
      <div className="timeline-head">
        <span className="timeline-now">{now}</span>
        {following && (
          <span className="timeline-next">
            <span className="timeline-next-label">Next</span>
            <span className="timeline-next-name">{timelineLabel(following, task.taskType)}</span>
          </span>
        )}
      </div>
      {/* The segments are the only place the count lives, so the bar says it
          in words to a screen reader. */}
      <div
        className="timeline-bar"
        role={step === undefined ? undefined : "img"}
        aria-label={step === undefined ? undefined : `Step ${idx + 1} of ${flow.length}`}
        aria-hidden={step === undefined ? true : undefined}
      >
        {flow.map((s, i) => (
          <span
            key={s}
            className={`timeline-seg${i < idx || (i === idx && tone !== "corrections") ? " timeline-seg-on" : ""}${
              i === idx && tone === "corrections" ? " timeline-seg-flag" : ""
            }`}
          />
        ))}
      </div>
    </div>
  );
  }
};
