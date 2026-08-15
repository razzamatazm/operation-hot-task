# Roles And Permissions

- Roles:
  - Loan officers
  - File checkers
  - Admins
- File checkers are a subset of loan officers
- Only file checkers can claim and complete Fraud Check tasks
- Fraud Check tasks run a two-phase completion (see
  [fraud-workflow.md](fraud-workflow.md)): the checker (assignee) sends
  outstanding items and approves; the requester (creator) submits items back
  and can release for any fraud checker
- `Cancelled` can be set by task creator or admin

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
  only way to take a task you couldn't otherwise claim.
- Status: `Open` → `Claimed`; a task already in flight (`Claimed`,
  `Needs Review`, Fraud's `Awaiting Items` / `Pending Approval`) swaps assignee
  in place with its status untouched. Closed tasks (`Completed` / `Archived` /
  `Cancelled`) cannot be handed off. Handing a task to whoever already holds it
  is a no-op.
- Both people are told, by DM only — see
  [notifications-bot.md](notifications-bot.md#routing). Displacing an assignee
  is never silent.
- Points need no special handling: `points` travels with the task, and the
  claims leaderboard recomputes live from the current `assignee`.
- `GET /api/users/directory` returns `roles` alongside `id`/`displayName` so the
  picker can filter to file checkers on a Fraud Check.
- `Claimed -> Needs Review` can be done by assignee or creator
- `Needs Review -> Claimed` and `Needs Review -> Completed` do not require admin

## Admin Panel (Users & Roles)

- Admin-only `Admin` tab (next to Metrics) manages the `users` table
- Per-user role toggles (`LOAN_OFFICER` / `FILE_CHECKER` / `ADMIN`) via
  `PUT /api/users/:id/roles`
- Lifecycle: add a user by email (resolved through Microsoft Graph) via
  `POST /api/users`; deactivate / reactivate via `PATCH /api/users/:id`;
  permanently remove via `DELETE /api/users/:id`
- Deactivated users keep their record + roles but are blocked at auth (403)
- Guards: cannot deactivate/remove yourself; cannot remove or demote the
  last active admin
- Newly auto-created users (default `LOAN_OFFICER`, never edited) are
  flagged in the panel so admins can promote them
