# AGENTS.md

## Project
Loan Tasks Teams App for internal company use.

Core task types:
- LOI checks
- Value checks
- Fraud checks
- Loan docs
- OOO (out of office coverage)

Primary goals:
- Create, claim, complete, and archive tasks
- Track in-progress and completed work
- Show urgency with stoplight colors
- Send real-time updates and overdue reminders

## Working Agreement
- Ask discovery questions one at a time.
- Do not proceed to implementation-critical assumptions without user confirmation.
- Record confirmed decisions in this file as the source of truth.

## Proposed Technical Direction (Default Unless Changed)
- Microsoft Teams app with:
  - Tab for task management UI
  - Bot for notifications/reminders
- Microsoft Entra ID SSO for identity
- Backend API + scheduler on Azure
- Relational DB (Azure SQL) for task state and audit history

## Workflow Direction
- General statuses include:
  - `Open`
  - `Claimed`
  - `Needs Review`
  - `Cancelled`
  - `Completed`
  - `Archived`
- Loan Docs lifecycle has extra merge stages:
  - `Open -> Claimed -> Merge Done -> Merge Approved -> Completed -> Archived`

## Decision Log
### Confirmed
- Teams surface: Tab + Bot
- Roles:
  - Loan officers
  - File checkers (subset of loan officers)
  - Admins
- Permission constraint:
  - Only file checkers can claim/complete Fraud Check tasks
- Required create-task fields:
  - Folder Name
  - Task Type (`LOI`, `Value`, `Fraud`, `Loan Docs`, `OOO`)
  - Timing:
    - Non-OOO: Urgency (`Green`, `Yellow`, `Orange`, `Red`)
    - OOO: Return Date (`YYYY-MM-DD`, PT)
  - OOO description label:
    - For OOO tasks, Folder Name is presented as `Vacation Description`
  - Notes
  - Notes label by task type (UI wording only; stored field remains `notes`):
    - LOI: `Loan Terms and Contacts`
    - Fraud: `Outstanding Items and Notes`
    - Value / Loan Docs / OOO: `Notes`
- Optional create-task fields:
  - Non-OOO only: Humperdink Link (URL)
  - Folder Name is the canonical task name (no separate file name field)
- Due Date/Urgency behavior:
  - Due date is tracked backend-only (not shown in user-facing UI)
  - Auto due date is derived from urgency level
- Default urgency:
  - All task types default to `Green` (editable)
- Urgency definitions:
  - `Green`: due in 24 real hours from creation (if due time lands on weekend, roll to Monday)
  - `Yellow`: needed by end of business day
  - `Orange`: needed within 1 hour
  - `Red`: urgent (drop-everything / immediate)
- Urgency display policy:
  - User-facing labels use timeframe-only wording (`Within 24 Hours`, `End of Day`, `Within 1 Hour`, `Urgent Now`)
  - Color remains visual styling only (no color word in label text)
- Workflow statuses:
  - Added `Needs Review` and `Cancelled`
- Loan Docs workflow:
  - `Open -> Claimed -> Merge Done -> Merge Approved -> Completed -> Archived`
- Transition permissions:
  - `Claimed -> Needs Review` can be done by assignee or task creator
  - `Needs Review -> Claimed` and `Needs Review -> Completed` do not require admin
  - `Cancelled` can be set by task creator or admin
- Claiming:
  - First-come-first-serve
  - Unclaim is allowed
  - Claim tasks section is hidden when there are no claimable tasks
- Front page recent activity:
  - Active tab includes a bottom section showing the most recent 30 tasks
  - Ordering in that section: active statuses first (`Open`, `Claimed`, `Needs Review`, `Merge Done`, `Merge Approved`), then closed statuses (`Completed`, `Cancelled`, `Archived`)
  - Within each group, tasks are sorted by newest created timestamp first
  - Presented as a compact spreadsheet-style table (Task Name, Status, Type, Creator, Assignee, Date Created, Date Completed)
  - Clicking a recent activity row expands inline detailed task view beneath that row
  - `Date Completed` shows `—` unless `completedAt` exists
- Notifications:
  - In-app notifications
  - Teams bot direct messages
  - Teams bot channel posts
  - Channel post target: dedicated Tasks channel (to be configured per Team)
  - New task created: broadcast to channel (plus in-app event)
  - Task claimed/unclaimed: post channel update; claimer also gets DM confirmation on claim
  - `Merge Done` and `Completed`: DM task creator
  - `Merge Approved`: DM task assignee
  - Notes: DM counterpart user (assignee -> creator, creator -> assignee)
  - Reminders: DM assignee, except `Loan Docs` waiting on merge approval (`Merge Done`) where reminder DM goes to creator
  - v1 bot scope: notifications/reminders + quick add (`/bot new`)
  - Bot quick add flow:
    - Ask Folder Name
    - Ask task type (`LOI Check`, `Value Check`, `Loan Docs`, `Fraud Check`, `OOO - Out of Office`)
    - If task type is non-OOO, ask urgency (`Within 24 Hours`, `End of Day`, `Within 1 Hour`, `Urgent Now`)
    - If task type is OOO, ask return date (`YYYY-MM-DD`, PT)
    - Ask notes (with quick option for no additional notes)
    - If task type is non-OOO, ask Humperdink Link (must be valid URL or skipped)
    - Show final review step with field-level edits
    - Show explicit final create confirmation before task submission
    - Support `/bot back` to return to prior step during quick add
- Overdue reminders:
  - Every 1 hour
  - Only during business hours
  - Business hours: 8:30 AM to 5:30 PM, Los Angeles time (`America/Los_Angeles`)
  - Stop reminders when status is `Completed`, `Archived`, or `Cancelled`
- Data retention/compliance:
  - Archived tasks retained for 3 months
  - No additional compliance constraints specified for v1
- Integrations:
  - v1 is standalone (no LOS/CRM integration)
  - Planned phase 2: allow in-house web app to create tasks via API/button click
- Hosting:
  - Local-first implementation
  - Azure-ready deployment target
- Teams branding:
  - App display name in Teams: `Operation Hot Task`
  - App icons: paper-on-fire concept (color + outline variants)
- OOO task type:
  - Added task type: `OOO` (Out of Office)
  - OOO uses return-date model instead of urgency input
  - Return date is user-entered date-only and interpreted in `America/Los_Angeles`
  - OOO dueAt is computed at `8:30 AM PT` on the return date
  - OOO return date must resolve to a future due time
  - OOO auto-completes from active statuses when return due time is reached
  - OOO uses existing people model:
    - Creator = out-of-office person
    - Assignee = covering person when claimed
  - OOO keeps standard claim/unclaim flow (`Open`/`Claimed`)
- Teams app attention indicator:
  - Left-rail icon dot is not used
  - Teams activity feed notifications are used instead
  - Activity feed uses `systemDefault` activity type for v1
  - Activity feed state alerts trigger on state-change and hourly reminder cadence (business hours)
  - Bounce-back condition for alerts is `Needs Review`
  - Pickup scope for alerts is tasks claimable by the user
  - Due condition for alerts is overdue-only (`dueAt` in the past)

### Open Questions Queue
- None currently.
