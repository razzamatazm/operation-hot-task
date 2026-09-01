# Roles And Permissions

- Roles:
  - Loan officers
  - File checkers
  - Admins
- File checkers are a subset of loan officers
- Only file checkers can claim and complete Fraud Check tasks
- **Admin is back-end access only** — see
  [ADR-0003](../adr/0003-creator-is-never-assignee.md). An admin manages users,
  roles and system config and can see every task, but holds no power over
  anyone else's work and no seat on any task: no cancelling, unclaiming,
  completing, restoring, transitioning, releasing, note-adding, points-editing
  or checklist-editing on tasks they neither created nor were assigned.
- Fraud Check tasks run a two-phase completion (see
  [fraud-workflow.md](fraud-workflow.md)): the checker (assignee) sends
  outstanding items and approves; the requester (creator) submits items back
  and can release for any fraud checker
- Loan Docs merge chain: the **assignee** marks `Merge Done`, the **creator**
  approves it (`Merge Approved`), the assignee completes. See
  [status-model.md](status-model.md)
- `Cancelled` can be set by the task creator

## You Cannot Work Your Own Task

A task's **creator is never its assignee** — it is a request for someone else to
act, so the two ends of it are always two different people. See
[ADR-0003](../adr/0003-creator-is-never-assignee.md).

- Enforced at **every** door an assignee can come through: claiming, handoff,
  handing a task to yourself, and `assigneeUserId` at creation.
- It is a property of the task (`createdBy.id !== assignee.id`), not of the
  actor, so a **third party cannot hand a task back to its creator** either.
- No task type is exempt. An OOO task's creator is the person going out and its
  assignee is the person covering — you cannot cover for yourself.
- No admin override and no escape hatch. If the only available file checker
  files a Fraud Check, nobody can work it and someone else has to file it —
  the create form warns at that point rather than failing silently at claim
  time.

## Handoff (Assigning A Task To Someone Else)

See [ADR-0002](../adr/0002-task-handoff.md) for the decision and what was
rejected. A Handoff is the only third-party way a task's assignee changes.

- **Anyone authenticated may hand a task off** — no creator/assignee/admin
  gate. The common trigger is a bystander who knows who should do the work and
  is neither creator nor assignee, which any narrower rule would block. Share
  has no permission rule either, so this is the consistent choice.
- **Eligibility is checked on the recipient, not the actor.** A Fraud Check can
  only be handed to a file checker, mirroring the claim rule. The picker filters
  to eligible people; the server rejects the rest (`canAssignTaskTo` in
  `packages/shared/src/workflow.ts`).
- Handing a task to yourself is allowed — it is just a claim, and sometimes the
  only way to take a task you couldn't otherwise claim. **Except for the
  creator**, who can never end up as assignee by any route (see above).
- Handoff is also the answer when an assignee goes quiet: anyone may hand their
  task to someone else, which is why no admin override is needed for it.
- Status: `Open` → `Claimed`; a task already in flight (`Claimed`,
  `Needs Review`, Fraud's `Awaiting Items` / `Pending Approval`) swaps assignee
  in place with its status untouched. Closed tasks (`Completed` / `Archived` /
  `Cancelled`) cannot be handed off. Handing a task to whoever already holds it
  is refused (#208) — the picker never offers the row, and the API says so rather
  than reporting success for a request that would change nothing.
- Both people are told, by DM only — see
  [notifications-bot.md](notifications-bot.md#routing). Displacing an assignee
  is never silent.
- Points need no special handling: `points` travels with the task, and the
  claims leaderboard recomputes live from the current `assignee`.
- `GET /api/users/directory` returns `roles` alongside `id`/`displayName` so the
  picker can filter to file checkers on a Fraud Check.
- `Claimed -> Needs Review` can be done by assignee or creator
- `Needs Review -> Claimed` and `Needs Review -> Completed` are creator/assignee

## Admin Panel (Users & Roles)

- Admin-only `Admin` tab (next to Metrics) manages the `users` table
- Per-user role toggles (`LOAN_OFFICER` / `FILE_CHECKER` / `ADMIN`) via
  `PUT /api/users/:id/roles`
- Lifecycle: add a user by email (resolved through Microsoft Graph) via
  `POST /api/users`; deactivate / reactivate via `PATCH /api/users/:id`;
  permanently remove via `DELETE /api/users/:id`
- Deactivated users keep their record + roles but are blocked at auth (403)
- Removing a user's `FILE_CHECKER` role, deactivating them, or removing them
  entirely **auto-releases their live Fraud Checks** back to the pool — the
  checker seat requires a live role, so the task would otherwise strand. The
  panel warns which tasks it is about to release, reading them from
  `GET /api/users/:id/fraud-checks` before it applies the change; the write
  responds with `releasedFraudChecks` (a count). All three paths call one
  `TaskService` method, which unassigns in place through the same mechanism a
  requester's manual release uses — including its channel post, one claimable
  card per released check (see
  [fraud-workflow.md](fraud-workflow.md#seats))
- Guards: cannot deactivate/remove yourself; cannot remove or demote the
  last active admin
- Newly auto-created users (default `LOAN_OFFICER`, never edited) are
  flagged in the panel so admins can promote them
