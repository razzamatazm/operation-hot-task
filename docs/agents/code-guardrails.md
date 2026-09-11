# Code Guardrails

## Shared-first

Workflow rules, status transitions, permission predicates, and action labels
live in `packages/shared`. If `apps/web` or `apps/server` needs one, import it
— don't re-derive it locally. Two independent copies of "is this overdue" is
what shipped issue #116's family of bugs.

## Never write a task built from an earlier read

Changing an existing task means `TaskStore.updateTask(id, apply)`, where `apply`
builds the new task from the `current` it is handed. `upsertTask` takes a
finished task and replaces the stored one wholesale, so a caller that reads,
changes and then writes will erase anything that landed in between — which is
exactly how two seats ticking the same checklist lost each other's ticks
(#158). Creation is the only write with no prior read, and the only one that
still calls `upsertTask`.

Guards may stay outside the closure; the value you are writing may not.

## State in a file goes through `JsonFile`, and only `JsonFile`

Every server store keeps its state in a JSON file, and every one of them is
built on `JsonFile`: it creates the file, and it runs every read and every
change for that file through one queue. A save rewrites the whole file,
truncating before it fills, so a read that skipped the queue could land in the
gap — which threw in one store and silently answered "nothing here" in another
(#331, #339). That was fixed store by store until there were seven copies of the
fix, and each fix found a store the last one had missed.

So a new store composes `JsonFile`; it does not import `node:fs`. The
read-during-write sim fails if any server module other than `JsonFile` (and the
start-up check for the built web app) imports the filesystem.

A change is `update(apply)`, and `apply` is synchronous on purpose: it cannot
await a lookup, so it cannot wait on its own queue. Work out anything you need
to look up before you call `update`, and keep only the change inside it.

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
