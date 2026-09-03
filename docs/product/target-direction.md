# Target Direction

Not yet implemented — do not present as current state. Everything else under
`docs/product/` describes what exists today.

- **Relational DB (expected Azure SQL)** for task state and audit history.
  Persistence today is JSON files under `apps/server/data/` — see
  [implementation-snapshot.md](implementation-snapshot.md).
- **A real inbound task-creation API** for the in-house web app — a `POST` that
  creates a task headlessly, needing a per-user credential on staff machines.
  Only worth building if the volume ever justifies it. What exists today is the
  clipboard hop described in
  [integrations-hosting.md](integrations-hosting.md): a userscript copies the
  loan, the human pastes it into the create form and presses Create.

Shipped, previously listed here: the Teams tab, the notification bot, Entra ID
SSO, the Azure Web App deployment, all of
[#137](https://github.com/razzamatazm/operation-hot-task/issues/137) (tickets
#138-#146 — creator is never assignee, admin as back-end access only, and the
two checklist rules),
[#160](https://github.com/razzamatazm/operation-hot-task/issues/160) (amending a
filed task's notes and urgency, [ADR-0006](../adr/0006-amend-task-ask.md)), and
the whole LOI corrections loop (#236-#239,
[ADR-0007](../adr/0007-loi-corrections-loop.md)) exist.
See [auth-identity.md](auth-identity.md),
[notifications-bot.md](notifications-bot.md),
[task-fields.md](task-fields.md), and
[../AZURE_DEPLOYMENT.md](../AZURE_DEPLOYMENT.md).
