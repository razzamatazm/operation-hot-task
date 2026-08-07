# UI/UX sweep — implementation brief

Source: `/triage` session on 2026-08-07, working from a batch of screenshots of
the unified task grid and FRAUD task cards. Eight issues filed, all
`ready-for-agent`. This doc groups them into batches for parallel subagent
work — read the "Parallelism notes" before assigning agents.

All full agent briefs live on the issues themselves (`gh issue view <n>`).
This doc is the dispatch plan, not a duplicate of the specs.

## Issues

| # | Title | Primary files |
|---|-------|----------------|
| [#91](https://github.com/razzamatazm/operation-hot-task/issues/91) | Collapsed task row + quick-action button squeeze/cut off at medium-narrow widths | `apps/web/src/styles.css` (`.task-card-grouped*`) |
| [#92](https://github.com/razzamatazm/operation-hot-task/issues/92) | Expanded card: notes should stay beside the status timeline at narrow widths | `apps/web/src/styles.css` (`.expand-cols`, timeline), `apps/web/src/App.tsx` (Timeline component) |
| [#93](https://github.com/razzamatazm/operation-hot-task/issues/93) | Rename Owner/From → Assigner/Assignee, remove duplicate display, bold self when attached | `apps/web/src/App.tsx` (`TaskCard` collapsed row + expand-strip), `apps/web/src/styles.css` |
| [#94](https://github.com/razzamatazm/operation-hot-task/issues/94) | FRAUD checklist: remove blue turn-cue banner; show note author's real name | `apps/web/src/App.tsx` (`FraudChecklist`), `apps/web/src/styles.css` |
| [#95](https://github.com/razzamatazm/operation-hot-task/issues/95) | FRAUD checklist: checker can resolve items during requester's turn | `packages/shared/src/checklist.ts` (`canEditChecklist`) |
| [#96](https://github.com/razzamatazm/operation-hot-task/issues/96) | FRAUD checklist: revert unresolved-items-float-to-top reordering | `packages/shared/src/checklist.ts` (`sortChecklist`), `docs/product/fraud-workflow.md` |
| [#97](https://github.com/razzamatazm/operation-hot-task/issues/97) | FRAUD: remove duplicate action button (quick action vs expanded body) | `apps/web/src/App.tsx` (`TaskCard` fraud action rendering) |
| [#98](https://github.com/razzamatazm/operation-hot-task/issues/98) | FRAUD tasks don't auto-expand in Awaiting Items / Pending Approval like other in-flight statuses do | `apps/web/src/App.tsx` (`TaskCard` `defaultOpen`/`involvedInFlight`) |

## Parallelism notes

Almost everything lives in `apps/web/src/App.tsx` and `styles.css`, so "which
issues can run at the same time" is really "which issues touch the same
render block." Batches below are ordered by dependency/conflict risk, not
priority — run each batch's issues concurrently (one subagent per issue,
`isolation: worktree` recommended since they land on the same files), merge
the batch, then move to the next batch.

**Batch 1 — independent files, fully parallel (3 agents):**
- #95 (checklist.ts: `canEditChecklist`)
- #96 (checklist.ts: `sortChecklist`)
- #97 (App.tsx: fraud action button rendering)

#95 and #96 both touch `checklist.ts` but different functions — low
conflict, safe to run together. #97 touches a distinct section of
`TaskCard` (the `fraudActions.map` block) with no overlap with the other
two.

**Batch 2 — same component, sequential-safe pairing (2 agents):**
- #91 (collapsed grouped row CSS)
- #93 (collapsed row people labels + expand-strip JSX)

Both touch the collapsed grouped row, but #91 is CSS-only (responsive
breakpoints) and #93 is JSX + label CSS — run in parallel, expect a small
manual merge in `styles.css` if both add rules near the same selectors.

**Batch 3 — FraudChecklist component, run together or sequentially (1–2
agents):**
- #94 (turn-cue removal + note-label rewrite, both inside `FraudChecklist`)

Single component, single agent — don't split #94 further, the turn-cue
banner and the note-label change are adjacent JSX in the same function.

**Batch 4 — depends on Batch 2 being merged (expand-state logic):**
- #92 (expand-cols/timeline responsive layout)
- #98 (auto-expand on viewer's turn)

Both touch `TaskCard`'s expand behavior/layout. #98 is a one-line addition
to the existing `involvedInFlight` status set (state-logic, `defaultOpen`
computation), #92 is layout CSS + Timeline component — low overlap, safe in
parallel, but run after Batch 2 merges since #93 also edits the
expand-strip that sits next to both of these.

**Sequencing summary:** Batch 1 → Batch 2 → Batch 3 (can overlap with Batch
2) → Batch 4. If running everything as one big parallel fan-out is
preferred instead, expect merge conflicts concentrated in `App.tsx`'s
`TaskCard` function and `styles.css`'s task-card-grouped/expand-cols rules —
worth it only if isolation + a final consolidation pass is budgeted for.

## Cross-cutting flags for whoever picks these up

- **#93**: bold rule confirmed — your own name is bold in whichever slot
  it appears (Assigner or Assignee) whenever you're attached to the task,
  no further ambiguity.
- **#98**: turned out not to be a product reversal. The app already
  auto-expands in-flight tasks for the involved creator/assignee
  (`CLAIMED`/`NEEDS_REVIEW`/`MERGE_DONE`/`MERGE_APPROVED`) — the
  `apps/web/CLAUDE.md` "rows never auto-expand" note is stale. The fix is
  just adding the two missing FRAUD statuses (`AWAITING_ITEMS`,
  `PENDING_APPROVAL`) to that same existing list, plus correcting the
  stale doc note.
- **#96** reverses a documented ordering rule in
  `docs/product/fraud-workflow.md` ("Ordering" section under the
  structured checklist) — that doc needs updating as part of the fix, not
  just the code.
- Every issue that touches FRAUD checklist behavior should re-read
  `docs/product/fraud-workflow.md` first — it's dense and several of these
  issues change rules documented there.
