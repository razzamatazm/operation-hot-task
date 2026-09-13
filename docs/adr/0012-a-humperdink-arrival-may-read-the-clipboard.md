# 0012. A Humperdink arrival may read the clipboard, through Teams

Status: Accepted, and built (#415, under #411). Overturns the position #194 took,
that Hot Task never reads the clipboard itself. Narrowly amends ADR-0011 rule 5,
as #413 recorded there.

## Context

Humperdink has no API, so a loan crosses into Hot Task on the clipboard. The
Send to Hot Task userscript copies the loan as a versioned JSON payload, and
pasting that into an LOI Check's paste box is the import (#194, #409).

#194 decided Hot Task would never read the clipboard on its own: the human
presses paste. The reason given was that clipboard-read permission inside the
Teams webview is the kind of thing that works in development and fails in
production. That was a guess about reliability, not a finding.

Since then the press has grown a second half. The userscript copies the loan and
then opens Teams desktop on a Humperdink arrival link (#412, #414), a deep link
whose `subEntityId` is the fixed sentinel `new:humperdink` and which carries no
loan data. The tab opens a new LOI Check with the paste box focused. The person
has just pressed one button in Humperdink, lands on a form about that loan, and
still has to press ⌘V. teams-js offers `clipboard.isSupported()` and
`clipboard.read()`, so where the Teams host supports it that last step can go.

## Decision

**On a Humperdink arrival, and nowhere else, the tab reads the clipboard through
Teams and runs the paste box's own import on it.**

1. **Only on the arrival.** The read happens once, when the LOI Check the
   arrival link opens is mounted (a development build mounts twice under React
   StrictMode and drops the first answer). New Task, a reopened Task Draft, Edit
   Task and every other route never read it.
2. **Through Teams, where Teams says it can.** If `clipboard.isSupported()` is
   true, the tab calls `clipboard.read()` and takes the `text/plain` blob. It
   never calls the browser's own clipboard API.
3. **The paste box is the guard.** The text is applied only if
   `parseHumperdinkPayload` accepts it, and through the same import a paste
   uses, not a second copy of it. Anything else (no support, a refused read,
   another kind of data, text that isn't a payload) changes nothing, says
   nothing, and keeps nothing. The paste box keeps its focus, so ⌘V still
   imports.
4. **It waits for the loans list.** The import runs only once the loans list
   has loaded, the same data a manual paste sees, so the task still joins the
   loan that URL already names ([ADR-0001](0001-loan-entity.md)).
5. **It fills an untouched form only.** If the person has already pasted or
   typed by the time it would apply, what they did stands.
6. **Nothing is filed until Create.** The fill is a form filling itself. The
   person reads it and presses Create under their own sign-in.

**What stays the same.** There is still no write endpoint for Humperdink, no
credential in the userscript, and no CORS surface. The link still carries no
loan data. The Teams manifest is unchanged: `clipboard.isSupported()` asks the
host's runtime whether it offers the clipboard capability, and the manifest
schema (v1.19) has no clipboard permission to declare.

**The autosave rule from #413 still holds** (ADR-0011 rule 5). Before the
arrival's form opens, an autosave worth keeping has been moved to Task Drafts,
or the form has been kept off the autosave because the move didn't land. So
whatever the clipboard fills in can't write over someone's earlier unfinished
task. ADR-0011's rejection of turning every abandoned form into a Saved for
Later task still stands: only an autosave that already exists moves, and only
when a Humperdink arrival would replace it.

## Considered and rejected

**Keeping #194's position, paste only.** Safe and already built. Rejected: the
arrival is one explicit press that means "put this loan in Hot Task", and asking
for a second press on the form that press opened buys nothing the payload check
doesn't already give.

**Reading the clipboard on any opening of the create form.** Rejected: New Task
means "file something", not "file what's on my clipboard", and reading on every
opening would pick up whatever happened to be there.

**Carrying the loan in the link instead.** Rejected in #411: Teams writes every
deep link it receives into its local log, so borrower details must never travel
in a URL.

**Toasting when the read fails or finds no payload.** Rejected: on this arrival
a clipboard holding something else is normal, the paste box already says what
to do, and a toast would be an error about nothing the person did.

## Consequences

**Whether the fill runs depends on the Teams host.** It is built and tested
against teams-js 2.48.1, where the clipboard capability is marked beta. There is
no staging Teams app, so what Teams desktop on macOS actually does is checked by
a person after deploy, in all three states (Hot Task on screen, Teams on another
page, Teams quit). Where it doesn't run, the arrival behaves exactly as #412 left
it, one paste away.

**A future change to the arrival must keep the guard.** The payload check and
the untouched-form rule are what make an automatic read harmless. A second
reader, or a fill that skips the parser, needs its own decision.
