# Code Guardrails

## Shared-first

Workflow rules, status transitions, permission predicates, and action labels
live in `packages/shared`. If `apps/web` or `apps/server` needs one, import it
— don't re-derive it locally. Two independent copies of "is this overdue" is
what shipped issue #116's family of bugs.

## Changing a product rule touches four places

1. `packages/shared` — types + workflow predicate
2. `apps/server` — validation and service logic
3. `apps/web` — labels, affordances, gating
4. `docs/product/` — the relevant doc, once the decision is confirmed

## Credentials

Teams credentials, Graph credentials, bot credentials, and inbound integration
auth are **not** configured in local dev. Code paths that need them must
degrade, and tests must not assume them. Local dev falls back to `x-user-*`
headers — see [../product/auth-identity.md](../product/auth-identity.md).

## Compatibility aliases

`loanName` and `serverLocation` are legacy fields still present in
`packages/shared/src/types.ts` and read by existing data. Preserve them where
they already exist; don't add new call sites.

## Lint is a typecheck

`npm run lint` is `tsc --noEmit` per workspace. There is no `exhaustive-deps`
rule, so React hook dependency and referential-stability discipline is manual
— see the `TaskCard` memo notes in
[../../apps/web/CLAUDE.md](../../apps/web/CLAUDE.md).
