# Integrations And Hosting

- No LOS/CRM integration. Loans carry an optional Humperdink link, which is an
  outbound reference — Hot Task never calls Humperdink and Humperdink never
  calls Hot Task.
- Hosting: single Azure Web App serving the API, the bot endpoint, and the
  Teams tab. Runbook and provisioning scripts in
  [../AZURE_DEPLOYMENT.md](../AZURE_DEPLOYMENT.md) (`npm run azure:*`).
- Local dev runs the same code with JSON file persistence and no Teams
  credentials.
- **Humperdink → create form, via the clipboard.** A self-installed userscript
  ([tools/humperdink/](../../tools/humperdink/)) puts a **Send to Hot Task**
  button on a loan details page; it copies the loan's name and page URL as a
  versioned JSON payload. The create form's **Import from Humperdink** button
  takes that paste and fills Folder Name and the Humperdink Link. Because the
  link is the canonical key for a loan
  ([ADR-0001](../adr/0001-loan-entity.md)), the created task joins the loan
  that URL already names rather than minting a duplicate.

  This is not an API integration and deliberately isn't one. There is no
  credential in the userscript, no write endpoint exposed to the browser, and
  no CORS surface: the human presses Create inside Teams under their existing
  SSO session, and a bad scrape is visible and correctable before anything is
  persisted. Hot Task does not read the clipboard either — the human presses
  paste. Clipboard-read permission inside the Teams webview works in dev and
  fails in production.
- A real inbound write API remains phase 2 — see
  [target-direction.md](target-direction.md).
