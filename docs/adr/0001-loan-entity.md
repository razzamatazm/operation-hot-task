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
  (See the 2026-07-31 addendum: the "visible notice" is now a transient
  toast rather than a persistent chip.)
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

## Addendum (2026-07-31): auto-merge notice is a transient toast

The "auto-merged silently with a visible notice" decision above originally
shipped as a persistent, manually-dismissible chip (`.loan-merge-notice`).
With the shared toast host in place (#60), the auto-merge notice now surfaces
as a **normal auto-dismiss toast** (`variant: "info"`, default duration) via
the toast-migration wave. This softens the original "persistent visible
notice" intent to a transient one — a deliberate choice: the merge is
already reflected in the filtered loan view the user lands on, so the notice
only needs to explain *why*, not persist. The underlying merge behavior
(repoint tasks, keep name as alias) is unchanged.

## Addendum (2026-09-04, #266): two of the decisions above are superseded

[ADR-0008](0008-loi-terms-are-a-field-not-a-message.md) rule 5 replaces two
clauses of this ADR. Recorded here rather than by editing them, so the reasoning
that produced them stays readable.

**"Any authenticated user can edit a Loan's name/link" is withdrawn.** The
comparison it rests on — "same trust level as creating a task" — turned out to
be the wrong one. Filing a task adds a row of your own; renaming a loan rewrites
the row on every task pointing at it, other people's and finished ones included,
which this ADR's own Consequences section calls out as the accepted tradeoff.
The tradeoff is still accepted, but it is now paid by the two people with a stake
in the task the edit is made from: **the task's creator or its current
assignee**, at a non-closed status, and nobody else. Not an observer, not an
unclaimed file checker, and not an admin — ADR-0003's rule holds here as
everywhere. A loan edit therefore names the task it was made from, and the server
checks that the task is on that loan and that the caller is a party to it.

**"That filtered view gets a small editable header" is withdrawn too.** The
header stands outside any task, so under the rule above there is nobody to check,
and a surface that cannot carry the rule cannot carry the edit. It is now a
read-only heading with the loan's name and its Humperdink link. The ability went
rather than the rule being softened for it: the alternative was one editing
surface with a rule and another without, which is the drift the narrowing exists
to close. The name and link are still corrected from `Edit Task` on any task on
the loan — one click from the list directly beneath that header.

Creating a loan is unchanged. Filing a task still mints one, joins an existing
one by name or link, and fills in a link the loan was missing, for anybody who
may file a task. The rule is about *changing* an existing loan.

## Addendum (2026-09-11, #370): the link key is the loan's Details page

"Humperdink link is the canonical unique key" above meant the URL as pasted,
give or take host case, `www.` and a trailing slash. But a Humperdink loan has a
page per tab, each with its own URL (`/Loans/Details/329366-SL`,
`/Loans/Docs/329366-SL`, `/Loans/DueDiligence/329366-SL`,
`/Loans/Funding/329366-SL`), so one loan could be two keys: a link copied from
the Docs tab never matched the same loan held under its Details link, never
raised the merge question, and missed in search.

**The key is now the Details page.** Any link of the form
`<Humperdink host>/Loans/<one page segment>/<digits>-<letters>` is rewritten to
`https://humperdink.loneoakfund.com/Loans/Details/<ID>` (id upper-cased), with
host case, `www.`, a trailing slash, surrounding spaces, a query string and a
fragment all ignored. Only the Humperdink host is rewritten. A link that does
not match that shape exactly is left as it was. The rule is
`canonicalHumperdinkLink` in `packages/shared`, and `normalizeLinkKey` applies
it, so filing, the edit-time merge question, search and the backfill's
clustering all agree.

- **Stored in that form** on the loan and on each task's copy, whenever a link
  is saved: filing a task, `Edit Task`, and the inbound import.
- **The merge question asks on the canonical link**, and it also asks when the
  saved link is one another record already holds, even if this record's own
  link did not move. That case exists only because of the next point.
- **Existing records are rewritten once, at server start-up**, after copying
  `tasks.json` and `loans.json` into `data/backups/<timestamp>/`. The rewrite is
  idempotent: a start-up with nothing to rewrite takes no backup and writes
  nothing. It adds no history row and does not touch `updatedAt`, because it
  changes the shape of a record rather than acting on a task.
- **Records that collide after the rewrite are not merged.** Each collision is
  logged at every start-up while it lasts, naming the records, and the merge
  question handles it the next time a link is saved onto either record. The edit
  form sends a link only when its text changed, so in the app that means pasting
  the loan's link from another Humperdink tab; re-pasting the identical Details
  link sends nothing. Merging them automatically would absorb one
  loan's tasks into another with nobody asked, which ADR-0008 rule 7 refuses;
  whether to do that anyway is a separate decision.
