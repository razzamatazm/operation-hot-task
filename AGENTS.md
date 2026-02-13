# AGENTS.md

## Project
Loan Tasks Teams App for internal company use.

Core task types:
- LOI checks
- Value checks
- Fraud checks
- Loan docs

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
  - Loan Name
  - Task Type (`LOI`, `Value`, `Fraud`, `Loan Docs`)
  - Due Date
  - Urgency (`Green`, `Yellow`, `Red`)
  - Notes
- Optional create-task fields:
  - Humperdink Link (URL)
  - Server Location (free-text file server path; no validation required)
- Due Date/Urgency behavior:
  - Auto defaults by task type, editable by user
- Default due date by task type:
  - `LOI`: 1 hour from creation
  - `Value`: next business day
  - `Fraud`: end of current business day
  - `Loan Docs`: 1 hour from creation
- Default urgency:
  - All task types default to `Green` (editable)
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
- Notifications:
  - In-app notifications
  - Teams bot direct messages
  - Teams bot channel posts
  - Channel post target: dedicated Tasks channel (to be configured per Team)
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

### Open Questions Queue
- None currently.
