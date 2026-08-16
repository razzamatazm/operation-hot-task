# Working In This Repo

## Source of truth

[AGENTS.md](../../AGENTS.md) and the docs it links are the working record of
confirmed product decisions and current implementation state. If a doc and the
code disagree, the code is current — fix the doc as part of your change.

## Questions vs judgment calls

- **Implementation and architecture calls are yours.** Make them, state the
  key ones in plain language, and keep going.
- **Business intent is not yours to invent.** If a change depends on a product
  rule that isn't already captured in these docs — who may do what, what a
  status means, what a user should see — ask. One question at a time.

## Recording decisions

- Confirmed product/workflow decision → the relevant doc under
  `docs/product/`.
- New or contested domain term → [CONTEXT.md](../../CONTEXT.md).
- Decision with real trade-offs and a rejected alternative → a new ADR in
  [docs/adr/](../adr/).
- Applies to literally every task → the root `AGENTS.md`. This is rare.

## Current vs planned

`docs/product/` describes what exists. Only
[target-direction.md](../product/target-direction.md) describes what doesn't.
Keep the line clean in both directions: don't describe planned work as built,
and don't leave shipped work sitting in the target doc.
