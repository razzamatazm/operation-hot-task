# Product Docs

Current implementation, by area. Read the one area your change touches, not
the whole folder.

## Scope

Task types: LOI checks, Buddy Chat, Value checks, Fraud checks, Loan docs, OOO
(out-of-office coverage).

What the app does: create, claim, complete, and archive tasks; track in-flight
and completed work; show urgency with stoplight-style visuals; push real-time
updates and overdue reminders through a Teams bot.

## Index

| Area | Doc |
|---|---|
| Implementation snapshot, backend API surface, architecture | [implementation-snapshot.md](implementation-snapshot.md) |
| UI surfaces (tabs, header, grid, metrics) | [ui.md](ui.md) |
| Auth and identity | [auth-identity.md](auth-identity.md) |
| Roles, permissions, admin panel | [roles-permissions.md](roles-permissions.md) |
| Create-task fields | [task-fields.md](task-fields.md) |
| Status model, reopen/restore | [status-model.md](status-model.md) |
| FRAUD two-phase workflow | [fraud-workflow.md](fraud-workflow.md) |
| Claiming, poop points, leaderboard | [claiming-scoring.md](claiming-scoring.md) |
| Due dates and urgency | [due-date-urgency.md](due-date-urgency.md) |
| OOO rules | [ooo.md](ooo.md) |
| Notifications, bot, activity feed | [notifications-bot.md](notifications-bot.md) |
| Overdue reminders, retention | [reminders-retention.md](reminders-retention.md) |
| Integrations and hosting | [integrations-hosting.md](integrations-hosting.md) |
| **Not built yet** | [target-direction.md](target-direction.md) |

Row layout and visual conventions for the task card are in
[apps/web/CLAUDE.md](../../apps/web/CLAUDE.md), which is canonical for that
component — don't restate it here.
