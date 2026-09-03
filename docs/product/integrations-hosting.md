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
  button on a loan details page; it copies the loan's name, page URL, loan
  terms, its broker and borrower, and any property it is acquiring, as a
  versioned JSON payload. The create form's **Import from
  Humperdink** button takes that paste and fills Folder Name, the Humperdink
  Link and the notes, and sets the task type to LOI. The terms are read by
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

  **The control also lands you where you can paste.** Pressing it copies the
  payload *and* opens Hot Task in a new tab with the create form already
  showing, so the next thing you do is press Import from Humperdink. That is a
  Teams deep link carrying **no data at all** — the loan is on the clipboard —
  built off the same `teamsTaskDeepLink` every other surface uses, with an
  opt-in `openCreateForm: true` in its `context` JSON beside `subEntityId`. Its
  own field, never a sentinel inside the task id: the builder is shared with the
  web app's "Copy link", and a link pasted into a chat must not open a create
  form for whoever clicks it. Every existing link is byte-for-byte unchanged,
  and arriving by any other route lands on the normal board.
  - **Cold tab and warm tab are one path.** Hot Task doesn't opt into Teams tab
    caching, so Teams loads the tab's content frame fresh for every deep link
    tap whether or not the tab was already open, and the intent arrives at the
    mount-time `app.getContext()` either way — the same assumption the
    task-focus deep link has always run on.
  - **The link is convenience, not capability, and it degrades in three
    places.** The userscript carries the Teams app id as a constant an installer
    fills in (see the README beside it); left blank, the control copies and says
    so, exactly as before. A refused clipboard opens nothing — landing on an
    empty create form with nothing to paste is worse than staying put. A blocked
    popup is reported rather than silently swallowed. And the create form itself
    still takes the paste when opened by any route.

  This is not an API integration and deliberately isn't one. There is no
  credential in the userscript, no write endpoint exposed to the browser, and
  no CORS surface: the human presses Create inside Teams under their existing
  SSO session, and a bad scrape is visible and correctable before anything is
  persisted. Hot Task does not read the clipboard either — the human presses
  paste. Clipboard-read permission inside the Teams webview works in dev and
  fails in production.
- A real inbound write API remains phase 2 — see
  [target-direction.md](target-direction.md).
