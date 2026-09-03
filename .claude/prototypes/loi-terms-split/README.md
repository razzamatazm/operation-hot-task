# LOI terms split — throwaway prototype

Built during the grilling session that produced
[ADR-0008](../../../docs/adr/0008-loi-terms-are-a-field-not-a-message.md) and
issue #256. Open `index.html` directly in a browser; no build, no server.

**Do not copy this wholesale.** It is a conversation aid, not a spec, and one
part of it was explicitly rejected.

## What it got right

- The terms section as a bordered, shadowed panel sitting on the recessed
  expanded-body background, with the conversation below it as bare rows — the
  contrast carried by shape rather than by the headings.
- The empty-conversation state.
- `Edit Task` in the hamburger, and the edit form shaped like the create form.
- The unchanged Buddy Chat card at the bottom, which is what settled that the
  split is LOI-only.

## What it got wrong

- **The terms box renders a formatted label/value table with a fixed left
  column.** Rejected. Terms are **free text with line breaks as typed**, in the
  body font with tight leading. Structured terms are deferred until the direct
  import exists — see ADR-0008 rule 1.
- **The shared-record warning in the edit modal is a bold, boxed note.**
  Rejected as disproportionate. It is **one** muted line beneath both fields,
  appearing only once a value has actually been changed — see ADR-0008 rule 7.
- Messages show a permanent author/time byline. The real app reveals that on
  hover (#165); the mock can't hover.
