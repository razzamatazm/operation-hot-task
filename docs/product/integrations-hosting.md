# Integrations And Hosting

- v1 is standalone: no LOS/CRM integration. Loans carry an optional Humperdink
  link, which is an outbound reference only, not an integration.
- Hosting: single Azure Web App serving the API, the bot endpoint, and the
  Teams tab. Runbook and provisioning scripts in
  [../AZURE_DEPLOYMENT.md](../AZURE_DEPLOYMENT.md) (`npm run azure:*`).
- Local dev runs the same code with JSON file persistence and no Teams
  credentials.
- Inbound task creation from the in-house web app is phase 2 — see
  [target-direction.md](target-direction.md).
