import { CLOSED_STATUSES, LoanTask, TaskStatus, TaskType, statusDisplayName } from "@loan-tasks/shared";

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

   A wide card names every step under its own segment instead, and the line
   steps out of view there (see styles.css). Chosen over an inline strip and a
   filled track, branch `prototype/status-tracker-desktop`. The markup is the
   same at every width; only the stylesheet decides which half is drawn.

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
          in words to a screen reader. Each segment carries its step's name,
          which only a wide card draws (2026-09-13): the bar is an image, so the
          names are never read, and the line above says the same thing aloud at
          every width. The step the task is on takes the line's own word, so a
          task in corrections names the state here too, never the step. */}
      <div
        className="timeline-bar"
        role={step === undefined ? undefined : "img"}
        aria-label={step === undefined ? undefined : `Step ${idx + 1} of ${flow.length}`}
        aria-hidden={step === undefined ? true : undefined}
      >
        {flow.map((s, i) => (
          <span
            key={s}
            className={`timeline-step${i < idx ? " timeline-step-done" : i === idx ? " timeline-step-here" : ""}`}
          >
            <span
              className={`timeline-seg${i < idx || (i === idx && tone !== "corrections") ? " timeline-seg-on" : ""}${
                i === idx && tone === "corrections" ? " timeline-seg-flag" : ""
              }`}
            />
            <span className="timeline-step-name">{i === idx ? now : timelineLabel(s, task.taskType)}</span>
          </span>
        ))}
      </div>
    </div>
  );
};
