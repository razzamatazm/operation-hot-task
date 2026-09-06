# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Loan operations staff at a small internal team, working inside Microsoft Teams
through the workday. Three roles, org-wide rather than per task:

- **Loan officers** — file the short-lived asks and work each other's.
- **File checkers** — a subset of loan officers, the only people who may claim
  and complete a Fraud Check.
- **Admins** — manage people, roles and system config. Back-end access only:
  an admin sees every task and holds no power over anyone else's work.

The job on any given task is narrow and short-lived: get one specific piece of
work done by somebody else, and know at a glance whose turn it currently is.
Everyone is both a requester and a worker depending on the task.

## Product Purpose

Before this app, these asks lived in busy Teams chat threads. Three things went
wrong there and this product exists to fix them:

- asks got lost in the shuffle;
- nobody could tell whose turn it was, so work stalled without anyone noticing;
- nobody could see who had quietly taken on everything.

Success is that no task sits unclaimed or stalled without someone knowing, and
that the distribution of who is carrying what is visible to the room.

## Positioning

The organising idea is **whose court** — every task reports whose move it is
*from the viewing person's perspective*, and the group a task sits in never
disagrees with the button it offers. Chat threads cannot do this; general task
trackers answer "who is assigned", which is a different and weaker question.

Two supporting commitments a neighbouring tool would not make:

- **A task is a request for somebody else.** Its creator is never its assignee,
  at every door, with no admin override.
- **Idle teammates see live work without being nagged by it.** Someone else's
  in-flight task is visible on purpose, so the pull to pick something up is
  felt, but it carries no attention signal at all.

## Operating Context

- Lives as a tab inside Microsoft Teams, alongside a bot that sends direct
  messages and posts claimable cards into a channel. Teams' own chrome names
  the app, so the app bar carries no title of its own.
- Six kinds of task: LOI checks, Buddy Chat, Value checks, Fraud checks, Loan
  docs, and out-of-office coverage.
- Three of them pass the ball back and forth rather than running straight
  through: a Fraud Check's two phases, the Loan Docs merge chain, and the LOI
  corrections loop.
- Loans come in from the in-house loan system by clipboard, not by API: a
  userscript copies a loan off its page and opens the create form, and a human
  presses paste and Create under their own sign-in.
- Hosted as a single Azure Web App serving the tab, the API, and the bot.
  Local development runs the same code against JSON files with no Teams
  credentials.
- **Rollout state (as of 2026-09-05):** live and in daily use, but by a small
  team and recently. A batch of features is about to land. Design work should
  treat the current interface as real and inhabited, not as a prototype nobody
  would miss.

## Capabilities and Constraints

Built and in use:

- File, claim, hand off, return to the pool, complete, cancel, and archive
  tasks; one unified list per viewer, readable either grouped by whose court it
  is or as a flat list.
- A standing Instructions box on every type but a Fraud Check, separate from the
  conversation beside it, correctable in place and frozen once the task closes.
- Urgency and deadlines, overdue nagging by bot, and a retention window after
  which closed tasks drop off the board.
- Poop points and a claims ranking, inside the admin-only Metrics tab.
- An admin panel for people and roles, which releases a departing checker's live
  Fraud Checks back to the pool rather than stranding them.
- Sign-in through the company Microsoft account in production; a local
  identity switcher in development only, disabled whenever real sign-in is
  configured.

Constraints and deliberate absences:

- No integration with any loan origination or CRM system, and no inbound API
  that writes tasks. The clipboard hop is the integration, on purpose.
- Persistence today is JSON files. A relational database is direction, not
  built, and must not be described as existing.
- Teams, Graph, bot, and inbound credentials are never configured locally.
- Vocabulary is settled and load-bearing — court, section, chain owner, party,
  seat, role, resolve, instructions, terms, amend, handoff. It lives in
  `CONTEXT.md` and is not restated or re-coined here.

## Brand Commitments

- Internal tool with no marketing surface, no public site, and no sales story.
  There is nothing to persuade anyone of; the product is used, not sold.
- No in-app brand lockup. Teams already shows the name above the tab, so an
  in-app one is duplication.
- The app's visual world and the reasoning behind it are already recorded, and
  are design authority rather than product truth.

## Evidence on Hand

- Real, maintained product documentation: `AGENTS.md`, `CONTEXT.md`, the
  `docs/product/` folder by area, and architecture decision records under
  `docs/adr/`.
- Seeded development data covering one task of each interesting shape. No real
  production task data is available locally.
- No customers, testimonials, benchmarks, pricing, case studies, press, or
  usage statistics exist. Do not invent any — this product has no such surface
  and never will.

## Product Principles

1. **Whose move it is is the organising fact.** Where a task appears and what it
   offers are the same answer, computed per viewer, and they never disagree.
2. **Two ends, two people.** A task is a request for somebody else to act, and
   the product enforces that everywhere rather than trusting anyone to observe
   it.
3. **Visible, not demanding.** Work that is not yours to move should be seeable
   without competing for your attention.
4. **Nothing actionable behind the fold, and the view never moves itself.** A
   row shows its primary action while collapsed, and no status change, message,
   or refresh opens or closes anything the person did not open.
5. **A closed task is a record.** Once finished, it stops being editable rather
   than staying quietly correctable.

## Accessibility & Inclusion

No screen-reader or keyboard-only requirement has been established for this
audience. The real constraints are physical:

- Small laptop screens are common; the interface must hold up when there is
  less width than a desk monitor.
- Phone use happens through the Teams mobile webview, where zoom is
  deliberately off, so type and hit targets must be right at that size rather
  than pinch-fixable.
