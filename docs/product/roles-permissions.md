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
