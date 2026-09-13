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
  ([tools/humperdink/](../../tools/humperdink/)) puts an **Export to HT**
  button in a loan details page's Loan Terms header (or, if that header never
  appears, a floating **Send to Hot Task** button in the corner); it copies the
  loan's name, page URL, loan terms, its brokers, borrowers and silent
  borrowers, and any property it is acquiring, as a versioned JSON payload.
  Pasting that into an LOI Check's paste box is the import (#409): it fills
  Folder Name, the Humperdink Link and the notes, and sets the task type to
  LOI. The terms are read by
  element id off Humperdink's Loan Terms panel; a **core** field whose element
  has gone is reported and nothing is copied, while a field that is merely empty
  is simply left out, so an unremarkable loan doesn't produce a note full of
  empty labels. The contacts and properties are not in the page's HTML —
  Humperdink fetches them after render — so the button reads `Loading…` until
  they arrive, and matches them on header and contact-type *text* rather than on
  row position. Only properties whose transaction reads as an acquisition
  contribute, and only their street address and purchase price; the loan-level
  scenario type is never consulted, because one loan can buy some properties and
  refinance others. Because the link is the canonical key for a loan
  ([ADR-0001](../adr/0001-loan-entity.md)), the created task joins the loan
  that URL already names rather than minting a duplicate.

  **The control copies, then opens Hot Task in Teams desktop** (#414). Once the
  payload is on the clipboard, still inside the same press, the userscript
  navigates to the Humperdink arrival link (#412): a Teams deep link whose
  `subEntityId` is the fixed sentinel `new:humperdink`, in the `msteams:` form,
  carrying no loan data, because Teams logs every deep link it receives. It is
  never the `https://teams.microsoft.com/l/…` form, which detours through
  Microsoft's launcher page; the team uses Teams desktop only. The Teams app id
  is written into the userscript from the one live install's manifest, and a
  test holds the two together. The first press asks in Chrome whether to open
  Teams; ticking Always allow makes later presses go straight there. A failed
  copy says so and opens nothing. #198 once opened the create form in a new
  tab through an https link; that was dropped and this replaces it.

  On the arrival link the tab opens a new LOI Check with the paste box
  focused, never focuses or claims a task, and files nothing until Create. The
  filer pastes, and the paste is the import. An unfinished new task in the
  person's autosave is moved to Task Drafts before that form opens (#413), and
  if the move fails the form leaves the autosave untouched, so an arrival never
  overwrites it.

  This is not an API integration and deliberately isn't one. There is no
  credential in the userscript, no write endpoint exposed to the browser, and
  no CORS surface: the human presses Create inside Teams under their existing
  SSO session, and a bad scrape is visible and correctable before anything is
  persisted. Hot Task does not read the clipboard either — the human presses
  paste. Clipboard-read permission inside the Teams webview works in dev and
  fails in production.
- A real inbound write API remains phase 2 — see
  [target-direction.md](target-direction.md).
