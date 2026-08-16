# Git Workflow (solo dev)

- **Trivial changes** (typo, copy tweak, single-line fix, config nudge, doc
  edit): commit straight to `main` and push. No branch, no PR.
- **Major changes** (new feature, refactor touching multiple files,
  schema/contract change, anything risky or worth a code review): work on a
  dedicated branch, open a PR, let Codex review run, then
  `gh pr merge --auto --squash --delete-branch` so cleanup is automatic.
- When in doubt, lean toward a branch — easier to revert one PR than to unwind
  a bad commit on `main`.
