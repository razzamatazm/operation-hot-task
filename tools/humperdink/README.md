# Send to Hot Task (Humperdink userscript)

[`send-to-hot-task.user.js`](send-to-hot-task.user.js) adds a **Send to Hot
Task** button to a Humperdink loan details page. Pressing it copies the loan —
its name, the page's URL and its loan terms — to your clipboard as JSON. Over in
Hot Task, the create form's **Import from Humperdink** button takes that paste
and fills Folder Name, the Humperdink Link and the notes, and sets the task type
to LOI.

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

`@match` is pinned to `https://humperdink.loneoakfund.com/Loans/Details/*`. If
your Humperdink lives somewhere else, change that line and nothing else.

## Use it

1. On the loan page, press **Send to Hot Task**. The button confirms with
   `Copied — paste it into Hot Task`.
2. In Hot Task, open **New Task**, click into **Paste from Humperdink**, paste,
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

`scripts/humperdink-import-sim-test.mjs` carries the full id list as
`TERMS_FIELDS`, taken off a real page, so a rename shows up as a red test.

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
