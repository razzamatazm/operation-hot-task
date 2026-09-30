/* Accordion expansion state, framework-free.

   One rule, one owner. A card is expanded if and only if the viewer expanded
   it (#161): there is no default-open rule, nothing derives expansion from
   status or notes, and nothing clears an override behind the viewer's back.
   One exception (#452): a card collapses once when the board sees its task
   close — see `newlyClosedIds`. The module exists because two consumers ask the same question and must
   agree — `TaskCard` decides whether to render itself open, and the list
   header's "Collapse all" control (#177) needs to know which cards in view are
   open so it can sit quiet when there is nothing to collapse.

   Plain TS with no JSX keeps this module runnable under node's TS type
   stripping (shared resolves to its built dist), which is how `scripts/expand-state-sim-test.mjs` exercises it. */
import { CLOSED_STATUSES } from "@loan-tasks/shared";
import type { LoanTask, TaskStatus } from "@loan-tasks/shared";

/* Per-user manual overrides: task id → true (the viewer opened it) / false
   (the viewer closed it). An absent entry means closed, same as `false`; the
   distinction survives only because that is what a fresh map looks like.
   Persisted to localStorage by `App`. */
export type ExpandOverrides = Record<string, boolean>;

/* The card's rendered state. The whole rule: the viewer's own choice, or
   collapsed. Kept as a named function rather than inlined at both call sites
   so the card and the header cannot drift apart about what "open" means, and
   so the rule has one place to be read and tested. */
export const isTaskExpanded = (override: boolean | undefined): boolean => override ?? false;

/* Whether a key on the card's header row toggles it (#504). Only a key aimed
   at the row itself: the task menu, its items (portaled, but still bubbling
   through React), and the action buttons all sit inside the row, and taking
   their Enter/Space here cancelled their own click. */
export const headerKeyToggles = (key: string, target: unknown, row: unknown): boolean =>
  target === row && (key === "Enter" || key === " ");

/* Which of `tasks` are open right now, in list order — the input to that
   list's Collapse all. The caller passes exactly the collection its list
   renders, so the tab / loan-filter / grouping scoping is already done and
   "in view" needs no second filter here.

   Deliberately walks the list rather than the override map: the map is global
   across every list and holds entries for tasks the caller isn't rendering, so
   its keys are the wrong scope. One pass of hash lookups over the rendered
   page — no note scanning, no status logic — which is cheap enough at these
   list sizes to run unmemoized on every render, including the 30s clock tick. */
export const expandedTaskIds = (
  tasks: Pick<LoanTask, "id">[],
  overrides: ExpandOverrides
): string[] => tasks.filter((t) => isTaskExpanded(overrides[t.id])).map((t) => t.id);

/* Force `taskIds` closed in one merged map — the bulk write behind Collapse
   all. Returns `prev` untouched when nothing would change, so a no-op press
   costs neither a render nor a storage write.

   Note: the override map grows by one entry per task ever touched and is never
   pruned. At the list sizes this app renders (a few hundred tasks under the
   closed-row TTL) that is a few KB of localStorage; if the list ever grows
   past that, prune here rather than at the call sites. */
export const collapseTasks = (prev: ExpandOverrides, taskIds: string[]): ExpandOverrides => {
  let changed = false;
  const next = { ...prev };
  for (const id of taskIds) {
    if (next[id] !== false) {
      next[id] = false;
      changed = true;
    }
  }
  return changed ? next : prev;
};

/* Tasks that went from an open status to a closed one since `prev`, the
   status snapshot the board took on its last look. A task missing from the
   snapshot has no "before", so a first sight — page load, a user switch —
   never counts, and a closed-to-closed move (Completed → Archived) isn't a
   close. Firing only on the change is what lets the viewer reopen the card
   afterwards and have it stay open. */
export const newlyClosedIds = (
  prev: ReadonlyMap<string, TaskStatus>,
  tasks: Pick<LoanTask, "id" | "status">[]
): string[] =>
  tasks
    .filter((t) => {
      const before = prev.get(t.id);
      return before !== undefined && !CLOSED_STATUSES.includes(before) && CLOSED_STATUSES.includes(t.status);
    })
    .map((t) => t.id);

/* Collapse the cards of tasks that just closed. Only cards that are open get
   written, so closing a task whose card was never touched adds no entry and
   leaves the map (and storage) as it was. */
export const collapseNewlyClosed = (prev: ExpandOverrides, closedIds: string[]): ExpandOverrides =>
  collapseTasks(
    prev,
    closedIds.filter((id) => isTaskExpanded(prev[id]))
  );
