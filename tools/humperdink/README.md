# Send to Hot Task (Humperdink userscript)

[`send-to-hot-task.user.js`](send-to-hot-task.user.js) adds a **Send to Hot
Task** button to a Humperdink loan details page. Pressing it copies the loan —
its name, the page's URL, its loan terms, its broker and borrower, and any
property it is acquiring — to your clipboard as JSON, and opens Hot Task in a
new tab with the create form already showing. There, the create form's **Import
from Humperdink** button takes that paste and fills Folder Name, the Humperdink
Link and the notes, and sets the task type to LOI.

Opening Hot Task is convenience, not capability. The link it opens carries no
data — the loan travels on the clipboard — so everything still works if you
ignore the new tab and navigate to Hot Task yourself.

Humperdink has no API, so the clipboard is the whole integration. Hot Task never
reads your clipboard on its own: you press paste. Clipboard-read permission
inside the Teams webview is the kind of thing that works in dev and fails in
production, so it is deliberately not used.

## Install it (about two minutes, once)

1. Install [Tampermonkey](https://www.tampermonkey.net/) in the browser you keep
   Humperdink open in (Edge and Chrome both work).
2. Open the Tampermonkey dashboard → **+** (Create a new script).
3. Delete the template it gives you, paste in the whole of
   `send-to-hot-task.user.js`, and press **Ctrl/Cmd + S**.
4. Open any loan in Humperdink. A dark **Send to Hot Task** button sits in the
   bottom-right corner.

Everyone installs it themselves — there is no central deployment and nothing to
roll out. Updating means pasting the current file over the old one, which is why
the payload carries a version number: an old script and a new Hot Task (or the
reverse) tell you so instead of importing something half-right.

## The two lines you may have to change

Both are near the top of the file, and nothing else in it is configuration.

- `@match` is pinned to `https://humperdink.loneoakfund.com/Loans/Details/*`.
  If your Humperdink lives somewhere else, change that line.
- `HOT_TASK_APP_ID` is your Teams app id for Hot Task, which is what lets the
  button open the create form for you. It is the `id` at the top of the Teams
  manifest (`teams-app/manifest.json` once it's built for your tenant) — the
  same value the server runs as `TEAMS_APP_ID`. Ask whoever deployed Hot Task
  if you don't have it.

  Leaving it blank is fine: the button then copies and says so, and you go to
  Hot Task yourself. The paste is what carries the loan, and it works from a
  create form opened any way you like.

## Use it

1. On the loan page, press **Send to Hot Task**. The button confirms with
   `Copied — opening Hot Task` and a new tab opens on the create form. If it
   reads `Loading…` instead, the contacts and properties haven't come back from
   Humperdink yet — they load after the page does. Give it a second.

   Two other things it may say, both meaning the copy worked and only the
   shortcut didn't: `Copied — paste it into Hot Task` (no `HOT_TASK_APP_ID` set)
   and `Copied — couldn't open Hot Task. Go there and paste.` (your browser
   blocked the new tab — allow popups for Humperdink, or just switch to Teams).
2. In the Hot Task tab, click into **Paste from Humperdink**, paste,
   and press **Import from Humperdink**. Folder Name, the Humperdink Link and
   the terms fill in, the task type becomes LOI, and the button reads
   `Imported`. Anything you had already typed into Notes stays where it is —
   the terms go in below it — and re-importing replaces the block the last
   import wrote rather than stacking a second copy.
3. Fill in the rest as usual and press Create. The task links itself to the
   existing loan for that URL — the link is the canonical key for a loan
   ([ADR-0001](../../docs/adr/0001-loan-entity.md)) — so importing the same loan
   twice does not create a second one.

If the button reports a problem instead of copying, it means the page wasn't
what it expected. Nothing goes on the clipboard in that case, deliberately: a
half-filled create form is worse than none, because there is no way to tell
which half is wrong.

## When Humperdink's markup shifts

Nothing is scraped by CSS selector. The loan name comes off the page title
(`<LoanName> - Details`) and the link off the address bar, both of which survive
Humperdink reshuffling its markup.

The loan terms
([#196](https://github.com/razzamatazm/operation-hot-task/issues/196)) are read
by **element id** off the Loan Terms panel and the toggle panels under it —
`loanAmount`, `LTV`, `OriginationFeePoints`, `RateMonthStart1` and the rest, all
listed at the top of the script. Ids are Humperdink's own and are far steadier
than the nested tables around them, but they are still Humperdink's to change,
so this is the part that needs maintaining. Two rules keep a markup shift
visible rather than silent:

- A core field whose **element** has gone means Humperdink moved something. The
  button says which ids it couldn't find and copies nothing.
- A field whose element is there and **empty** just means this loan doesn't use
  it, and it is left out of the note. Zero counts as empty: Humperdink pre-fills
  its unused panels with `0.00%` and `$0.00`, and a note full of zeroed labels
  is worse than no note.

The contacts and properties
([#197](https://github.com/razzamatazm/operation-hot-task/issues/197)) are not
in the page's HTML at all — Humperdink fetches them after render and paints them
into jqxGrids — so the control waits for them and reads `Loading…` in the
meantime. Each grid is found by its container id (`contenttableContactsGrid`,
`contenttablePropertiesGrid`), and then **everything inside it is matched on
text**: the columns by their header (`Type`, `Name`, `Address`, `Transaction`,
`Purchase Price`) and the people by their contact type (`Broker`, `Borrower`).
Nothing counts rows or columns from a fixed position — Humperdink's row ids are
literally positional (`row0ContactsGrid`), so a scrape built on them would point
at the wrong person the first time somebody adds a contact.

Only properties whose transaction reads as an acquisition contribute, and only
their street address and purchase price. The loan-level scenario type is
deliberately never consulted: one loan can buy some properties and refinance
others, so the per-property signal is the authoritative one.

A grid that is still empty when the control gives up waiting is **refused**, not
imported as an absence. Humperdink offers no "loaded, and there are none"
signal, so an empty grid and a slow one look identical from a userscript — and
an LOI note that quietly lost its borrower is worse than one that didn't get
made. In practice every loan an LOI is filed against has a borrower and a
property; if that ever stops being true, this is the rule to revisit.

`scripts/humperdink-import-sim-test.mjs` carries the full id list as
`TERMS_FIELDS` and both grids' headers as `CONTACT_HEADERS` /
`PROPERTY_HEADERS`, all taken off a real page, so a rename shows up as a red
test.

For maintenance work, use a saved copy of a real loan details page as the
selector reference. The page is ~1.3 MB of HTML plus a few hundred asset files
and is customer data, so it is not committed here — save your own from the
browser (**Save page as → Webpage, Complete**) and keep it outside the repo.

## Changing the payload

The shape is `HumperdinkPayload` in
[`packages/shared/src/humperdink.ts`](../../packages/shared/src/humperdink.ts),
which also writes down the versioning rules: additive fields keep the version,
and only a break bumps it. The constants are duplicated in the userscript
because a Tampermonkey script cannot import from this workspace;
[`scripts/humperdink-import-sim-test.mjs`](../../scripts/humperdink-import-sim-test.mjs)
runs this actual file against the actual parser, so the two copies cannot drift
without a test going red.
