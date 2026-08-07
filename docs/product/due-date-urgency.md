# Due Date And Urgency

- Due date is tracked backend-only and is not shown as a dedicated field in
  the main tab UI. Exception: the claimer's DM_CLAIM card does surface a
  `due` field — see
  [notifications-bot.md](notifications-bot.md#routing).
- Default urgency for all non-OOO task types is `Green`
- Urgency meanings:
  - `Green`: due in 24 real hours from creation; if the due time lands on a weekend, roll to Monday
  - `Yellow`: needed by end of business day
  - `Orange`: needed within 1 hour
  - `Red`: urgent now
- User-facing urgency labels use timeframe wording:
  - `Within 24 Hours`
  - `End of Day`
  - `Within 1 Hour`
  - `Urgent Now`
- Color is visual styling only
