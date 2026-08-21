# Target Direction

Not yet implemented — do not present as current state. Everything else under
`docs/product/` describes what exists today.

- **Relational DB (expected Azure SQL)** for task state and audit history.
  Persistence today is JSON files under `apps/server/data/` — see
  [implementation-snapshot.md](implementation-snapshot.md).
- **Inbound task creation from the in-house web app** via API/button click
  (phase 2). v1 has no LOS/CRM integration.

Shipped, previously listed here: the Teams tab, the notification bot, Entra ID
SSO, the Azure Web App deployment, and all of
[#137](https://github.com/razzamatazm/operation-hot-task/issues/137) (tickets
#138-#146 — creator is never assignee, admin as back-end access only, and the
two checklist rules) exist. See
[auth-identity.md](auth-identity.md), [notifications-bot.md](notifications-bot.md),
and [../AZURE_DEPLOYMENT.md](../AZURE_DEPLOYMENT.md).
