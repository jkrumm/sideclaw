---
description: sideclaw git workflow — direct-to-master, no PR, no release process
---

# Git Workflow

sideclaw is a personal infra tool (config-as-code). No PR flow, no release process.

## Ship flow

`/ship` runs: `/check` → `/review` → `/commit` → `git push` — done.

## Rules

- Push directly to `master` — no branches, no PRs
- No release step after push (no GitHub Actions release, no tagging)
- `/review` is optional but welcome before committing
- Amend follow-up fixes into the previous commit rather than creating noise commits
