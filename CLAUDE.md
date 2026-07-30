# CLAUDE.md

Design / UI reference for `apps/web` lives in
[apps/web/CLAUDE.md](apps/web/CLAUDE.md). Product rules, workflow, and
backend contracts live in [AGENTS.md](AGENTS.md) — read that first for
non-visual decisions.

## Git Workflow (solo dev)

- **Trivial changes** (typo, copy tweak, single-line fix, config nudge, doc
  edit): commit straight to `main` and push. No branch, no PR.
- **Major changes** (new feature, refactor touching multiple files,
  schema/contract change, anything risky or worth a code review): work on a
  dedicated branch, open a PR, let Codex review run, then
  `gh pr merge --auto --squash --delete-branch` so cleanup is automatic.
- When in doubt, lean toward a branch — easier to revert one PR than to
  unwind a bad commit on `main`.

## Agent skills

### Issue tracker

Issues and PRDs live in this repo's GitHub Issues, managed via the `gh` CLI.
See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical triage roles map 1:1 to label strings (`needs-triage`,
`needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`).
See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root.
See `docs/agents/domain.md`.
