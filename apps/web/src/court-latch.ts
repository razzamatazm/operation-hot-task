/* Which tasks are pinned to "Needs you" because the viewer opened them there.

   The message pull (CONTEXT.md) lifts a task carrying an unread reply into the
   recipient's "Needs you", even when they don't own the current section.
   Opening that task is the gesture that marks the note seen, which drops the
   pull, which recomputes the court, which moves the row into a different
   section — under a viewer who is mid-read. #161 removed auto-open for exactly
   this reason; this is the same defect from the other side. The row did not
   move itself: the list moved, and the viewer's own click was the trigger.

   The rule this module owns: a task the viewer opened out of the pull stays in
   the section they found it in until they close it again. One entry per open
   pulled task, taken on expand and released on collapse, so the map cannot
   outlive the cards it pins.

   Deliberately NOT persisted. A hold answers "the viewer is reading this right
   now", which a tab reload ends; `expandOverrides` survives a reload precisely
   because it answers a different question. A reload legitimately re-sorts.

   Type-only imports keep this module runnable under node's TS type stripping,
   matching `expand-state.ts` next door. */

/* Task id → held. Absent means not held; the value is always `true` so the
   map reads the same way `expandedTaskIds` reads its input. */
export type CourtHolds = Record<string, true>;

/* Take a hold. Returns `prev` untouched when the task is already held, so a
   repeated expand costs neither a render nor a re-sort. */
export const holdCourt = (prev: CourtHolds, taskId: string): CourtHolds =>
  prev[taskId] ? prev : { ...prev, [taskId]: true };

/* Release one or many — the collapse path, and the bulk write behind Collapse
   all (#177), which must drop every hold it closes or the list would keep rows
   pinned to a section with no open card to justify it. Returns `prev`
   untouched when nothing changes, matching `collapseTasks`. */
export const releaseCourt = (prev: CourtHolds, taskIds: string[]): CourtHolds => {
  let changed = false;
  const next = { ...prev };
  for (const id of taskIds) {
    if (next[id]) {
      delete next[id];
      changed = true;
    }
  }
  return changed ? next : prev;
};

/* The question `buildCourtSections` asks per task. Named rather than inlined
   so the section builder and the card's action slot cannot drift apart about
   what "held" means — both need it, for the same reason. */
export const isCourtHeld = (holds: CourtHolds, taskId: string): boolean => holds[taskId] === true;
