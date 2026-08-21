# Target Direction

Not yet implemented — do not present as current state. Everything else under
`docs/product/` describes what exists today.

- **Relational DB (expected Azure SQL)** for task state and audit history.
  Persistence today is JSON files under `apps/server/data/` — see
  [implementation-snapshot.md](implementation-snapshot.md).
- **Inbound task creation from the in-house web app** via API/button click
  (phase 2). v1 has no LOS/CRM integration.
- **Decided, documented, not yet built** (tracked by
  [#137](https://github.com/razzamatazm/operation-hot-task/issues/137), tickets
  #138-#146). Unusually, these rules are written up in the product docs as if
  current, because they are the target an agent implements against — the code
  is what changes, not the docs. Remove this entry once the last two land.
  - Warning the filer of a Fraud Check when no eligible checker but themselves
    exists (#142) — [roles-permissions.md](roles-permissions.md#you-cannot-work-your-own-task)
  - Auto-releasing a demoted or deactivated checker's live Fraud Checks (#145)
    — [fraud-workflow.md](fraud-workflow.md#seats)

Shipped, previously listed here: the Teams tab, the notification bot, Entra ID
SSO, and the Azure Web App deployment all exist. See
[auth-identity.md](auth-identity.md), [notifications-bot.md](notifications-bot.md),
and [../AZURE_DEPLOYMENT.md](../AZURE_DEPLOYMENT.md).
