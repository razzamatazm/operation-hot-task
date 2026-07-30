# 0001. Loan becomes a first-class, linkable entity

Status: Accepted (design). Implementation tracked in
[#38](https://github.com/razzamatazm/operation-hot-task/issues/38).

## Context

Loan name and Humperdink link are free text duplicated on every task
(`LoanTask.folderName` / `humperdinkLink`). There's no way to search for or
reuse a loan already entered on another task, and no real relationship
tying tasks for the same loan together — see
[issue #38](https://github.com/razzamatazm/operation-hot-task/issues/38).

## Decision

- Introduce a `Loan` entity: `id`, `name`, `humperdinkLink?` (optional),
  timestamps. File-backed store for now, mirroring `TaskStore`, ahead of
  the eventual Azure SQL migration (AGENTS.md "Target Direction").
- `Task.loanId` replaces `folderName`/`humperdinkLink` as the source of
  truth for display — a **live reference**, not a snapshot. Editing a
  Loan's name/link updates every linked task immediately.
- A Loan is **required** for every non-OOO task. OOO tasks are unaffected —
  they were never loan-related (`folderName` relabels to "Vacation
  Description" and has no Humperdink link).
- **Humperdink link is the canonical unique key** for a Loan when present.
  A Loan may exist without one yet, keyed provisionally by name until a
  link is added.
- Create-task's Folder Name field becomes an inline typeahead: fuzzy
  matches (not just prefix) surface existing loans as you type, so
  near-duplicate names get caught before a duplicate Loan is created. No
  extra click to create — submitting with nothing selected creates a new
  Loan from the typed text.
- If two Loan records are later found to share the same Humperdink link,
  they are **auto-merged silently with a visible notice**: the newer
  record's tasks repoint to the original, name is kept as an alias.
- No dedicated Loans tab. Clicking a loan's name on any task filters the
  task list to that loan; that filtered view gets a small editable header
  (name + link) — the app's first post-creation edit capability, scoped to
  the Loan record only.
- Any authenticated user can edit a Loan's name/link — same trust level as
  creating a task today.
- One-time migration on ship: create a Loan per distinct existing
  `folderName` (fuzzy-deduped) and backfill `loanId` onto existing tasks,
  so there's no legacy unlinked state to carry in code.

## Consequences

- `folderName`/`humperdinkLink` move from `Task` to `Loan`; the deprecated
  `loanName`/`serverLocation` aliases (AGENTS.md) apply to the Loan's name
  going forward, not the task's.
- Editing a shared Loan record retroactively changes what every linked
  task displays, including historical ones — accepted tradeoff in exchange
  for eliminating duplicate/drifted data.
- Requires the app's first post-creation edit surface and its first
  fuzzy-match/dedup logic — both new patterns, not extensions of existing
  ones.
