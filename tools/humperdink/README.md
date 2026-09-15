# Send to Hot Task (Humperdink userscript)

[`send-to-hot-task.user.js`](send-to-hot-task.user.js) adds an **Export to HT**
button to a Humperdink loan details page, in the Loan Terms header right after
the LOI button. Pressing it copies the loan — its name, the page's URL, its loan
terms and extensions, its brokers, borrowers, silent borrowers and lenders, and
every property on it with its release price — to your clipboard as JSON. Then it opens Hot Task in Teams desktop
on a new LOI Check. Where Teams lets Hot Task read the clipboard, Folder Name,
the Humperdink Link and the notes fill in by themselves. Where it doesn't,
paste (⌘V) straight away and that is the import, with nothing else to press.

The first time you press it, Chrome asks whether to open Microsoft Teams. Tick
**Always allow** and press Open, and every press after that goes straight to
Teams with no prompt. It opens Teams desktop, not Teams in the browser (#414).

The link that opens Hot Task carries no loan data, only "somebody sent a loan
from Humperdink". Teams writes every link it receives into its local log, so the
loan itself travels on your clipboard and nowhere else. If the copy fails, the
button says so and doesn't open anything.

Humperdink has no API, so the clipboard is the whole integration. Hot Task reads
your clipboard in exactly one place: the LOI Check this button opens, through
Teams, once
([ADR-0012](../../docs/adr/0012-a-humperdink-arrival-may-read-the-clipboard.md)).
It only fills the form if what it finds is a loan this button copied, and it
never files anything: you still press Create. New Task and everything else in
Hot Task never read it.

## Install it (about five minutes, once)

Send people to the install guide on loftools:
**https://loftools.thepopcorn.party/install/**. It walks through Tampermonkey,
Chrome's **Allow User Scripts** switch, and an Install button for this script
(and the TitlePro → Humperdink one, which lives in loftools).

Once installed, open any loan in Humperdink. An **Export to HT** button sits in
the Loan Terms header, right after the LOI button. It is a copy of the LOI
button with the icon and name swapped, so it lines up with Humperdink's own
buttons. The copy sizes to its own name and leaves behind everything that makes
the original the LOI button (its id, `name`, Humperdink's
`lending-controls-button` marker, and any hover, pressed or disabled state),
and a press on it goes no further than the control. If the LOI button is ever a
shape the copy doesn't recognise, a hand-built button stands in. If that header hasn't appeared within about eight seconds (a Humperdink
update that moved it, say), a dark **Export to HT** button takes the
bottom-right corner instead, so the control is never silently missing. If
Humperdink redraws the header, the button puts itself back.

## Updates

This file is the source of truth, because the tests here run it against the
app's parser. loftools (`~/repos/loftools`) serves a copy at
`/userscripts/send-to-hot-task.user.js`, and the header's `@downloadURL` and
`@updateURL` point there, so Tampermonkey checks it about daily and takes any
higher `@version`. To ship a change:

1. **Raise `@version`** here, or nobody receives it. Version 1.10.0 (#442) is
   the one that sends extensions, lenders, release prices and refinanced
   properties and respects the panel switches; a copy older than that still
   imports, just without them.
2. **Deploy Hot Task first**, then copy this file over the loftools copy
   unchanged. A copy that runs ahead of the live app opens a Teams screen the
   app may not have yet.

The payload still carries its own version number for anyone on an old copy: an
old script and a new Hot Task (or the reverse) say so instead of importing
something half-right.

## Configuration

Nothing normally needs changing. Two values are pinned in the script:

- `@match` is `https://humperdink.loneoakfund.com/Loans/Details/*`. If your
  Humperdink lives somewhere else, change that line.
- `HOT_TASK_APP_ID` is the Teams app id of the one Hot Task install, the `id`
  in `teams-app/operation-hot-task-teams/manifest.json`. It only changes if Hot
  Task is reinstalled as a new Teams app, and a test goes red if the two
  disagree.

## Use it

1. On the loan page, press **Export to HT** in the Loan Terms header. A note
   pinned under it confirms with `Copied. Opening Hot Task in Teams…`, and
   Teams desktop comes forward on Hot Task. (First time only: Chrome asks
   whether to open Teams. Tick Always allow.) If the button is dimmed, the
   contacts, properties or release prices haven't come back from Humperdink
   yet — they load after the page does, and hovering says so. Give it a second.
2. Hot Task opens a new LOI Check. Where Teams lets it read the clipboard,
   Folder Name, the Humperdink Link and the terms are already filled in.
   Otherwise paste (⌘V) straight away, and that is the import, filling the same
   fields. Anything you had already typed into Notes stays where it is — the terms
   go in below it — and pasting again replaces the block the last import wrote
   rather than stacking a second copy. If you had an unfinished new task open
   in Hot Task, it is kept on the Task Drafts tab. You can also get here by
   hand: New Task, LOI Check, click into any field, paste.
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
`loanAmount`, `LoanTerm`, `OriginationFeePoints`, `RateMonthStart1` and the rest, all
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

Each conditional panel (Extensions, Junior Financing, Seller Financing,
Disbursement Options, Interest Reserve, Partial Reconveyance) also has an on/off
**switch**, and since #442 the switch decides whether the panel travels at all.
Humperdink leaves a switched-off panel's figures sitting in its inputs, so
without it an unused panel's stale numbers would reach the note. A switch is
read by id (`toggleExtensions`, `toggleHoldBack` and so on) and is on when its
`.toggle-on` child carries `active`; a switch that has gone is reported like a
missing core id. Junior or seller financing switched on with nothing filled in
sends one `Permitted` line. Extension rows are numbered from 1
(`ExtensionMonthStart1` …), and a loan with no extensions has no row elements at
all, so a missing row 1 is normal; the notes box `extensionstextarea` is on
every loan and is reported if it goes.

The contacts and properties
([#197](https://github.com/razzamatazm/operation-hot-task/issues/197)) are not
in the page's HTML at all — Humperdink fetches them after render and paints them
into jqxGrids — so the control waits for them in the meantime: dimmed with a
hover that says why in the Loan Terms header, or reading `Loading…` as the
floating fallback. Each grid is found by its container id (`contenttableContactsGrid`,
`contenttablePropertiesGrid`), and then **everything inside it is matched on
text**: the columns by their header (`Type`, `Name`, `Address`, `Transaction`,
`Purchase Price`) and the people by their contact type (`Broker`, `Borrower`,
`Silent Borrower`, `Lender`, every row of each, grouped in that order).
Nothing counts rows or columns from a fixed position — Humperdink's row ids are
literally positional (`row0ContactsGrid`), so a scrape built on them would point
at the wrong person the first time somebody adds a contact.

Every property on the loan contributes, acquisition or refinance (#442; #197
took acquisitions only), with its street address, transaction type, purchase
price and release price. The loan-level scenario type is never consulted.

The **release price** isn't on the loan page at all. Each property's lives in
its property details, which Humperdink loads from `/Loans/NewPropertyPartial`
when somebody opens the property, keyed by two ids that only the properties
grid's row data carries. So once the properties grid has rows, the control reads
that row data through the page's jQuery and fetches each property's details in
the background, reading the `txtReleasePrice` input's value. It does this while
it is still dimmed, never during the press: copying and opening Teams both have
to happen inside the press, and a press that waited on the network would lose
that. Moving the pointer onto the button fetches them again in the background,
so a release price edited, or a property added, since the page loaded is
normally in before the press; a property the last finished fetch didn't include
is refused with "try again in a moment". Prices are matched to properties on the
whole address, so two properties on one street in different towns keep their
own. A fetch that fails, or details with no release price field, are reported
and nothing is copied.

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
