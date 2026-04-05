---
description: sideclaw git workflow — direct-to-master, no PR, no release process, no check step
---

# Git Workflow

sideclaw is a personal infra tool (config-as-code). No PR flow, no release process, no validation step.

## Ship flow

`/ship` runs: `/review` → `/commit` → `git push` — done.

Skip `/check` entirely — there is no lint, format, or typecheck configured in this repo.

## Rules

- Push directly to `master` — no branches, no PRs
- No release step after push (no GitHub Actions release, no tagging)
- `/review` is optional but welcome before committing
- Amend follow-up fixes into the previous commit rather than creating noise commits
