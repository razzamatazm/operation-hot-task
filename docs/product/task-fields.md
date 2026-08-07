# Create Task Fields

- Required fields:
  - Folder Name
  - Task Type: `LOI`, `Buddy Chat`, `Value`, `Fraud`, `Loan Docs`, `OOO`
  - Poop points: `1`-`5`, default `1` (see
    [claiming-scoring.md](claiming-scoring.md#poop-points-rules))
  - Timing:
    - Non-OOO: urgency (see [due-date-urgency.md](due-date-urgency.md))
    - OOO: start date and return date in `YYYY-MM-DD`, PT (start ≤ return; both
      required) — see [ooo.md](ooo.md)
  - Notes
- Optional fields:
  - Non-OOO only: Humperdink Link
  - All types: `Share Directly` — pick a person from the directory to DM
    about this task at creation time (`shareWithUserId`); the picker is
    hidden if there's no one else to share with
- Folder Name is the canonical task name
- There is no separate file name field
- OOO UI wording:
  - Folder Name label becomes `Vacation Description`
- Notes label by task type:
  - LOI: `Loan Terms and Contacts`
  - Buddy Chat: `Concerns`
  - Fraud: `Notes` — `NOTES_FIELD_LABELS.FRAUD` heads the card's free-text
    **discussion thread** (#68), not a separate outstanding-items field;
    relabeled from `Discussion` to `Notes` for consistency (#81). The
    create form (#69) uses a purpose-built `Notes` field plus an
    outstanding-items checklist seeder — see
    [fraud-workflow.md](fraud-workflow.md#structured-outstanding-items-checklist-44)
  - Value / Loan Docs / OOO: `Notes`
