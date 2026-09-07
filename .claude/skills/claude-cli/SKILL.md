---
name: claude-cli
description: >
  Reference for spawning Claude Code CLI (`claude -p`) as a subprocess from Bun/TypeScript.
  Use this skill whenever writing code that spawns, wraps, or communicates with the Claude CLI
  programmatically — MCP server handlers, workflow runners, or any automation that invokes
  `claude -p`. Covers spawn patterns, NDJSON parsing, structured output, session management,
  env hygiene, and critical gotchas.
  ALWAYS consult this skill before writing subprocess spawning code for Claude CLI.
---

# Spawning Claude Code CLI — Patterns & Reference

**The executable reference is `buildSessionArgs()` in
`server/mcp/session-runner.ts`** — every sideclaw worker session goes through
it. This skill is the pattern library behind it; when the two disagree,
`session-runner.ts` is correct and this file is stale.

## When to read the references

- Building a new spawn wrapper or MCP tool handler → `references/spawn-patterns.md`
- Need the exact CLI flags → `references/cli-flags.md`
- Parsing NDJSON stream output → `references/stream-format.md`

## What sideclaw actually does (not the CLI's full option space)

- **`--output-format stream-json --verbose`**, not single-blob `json` —
  needed for live progress (`turns`, `lastAction`, `idleMs`); the `result`
  event of the stream carries the same fields the old `json` envelope did.
- **`--disallowedTools "Write,Edit,NotebookEdit"` (+ `extraDisallowedTools`)
  for read-only tools — never `--allowedTools`.** Under
  `--dangerously-skip-permissions`, `--allowedTools` restricts nothing
  (measured on CLI 2.1.220: a probe with `--allowedTools` still overwrote its
  canary; `tests/session-args.test.ts` pins the flag). `--disallowedTools` is
  the only lever that actually blocks a tool under skip-permissions.
- **`--settings '{"disableAllHooks":true}'` on every worker** — a target
  repo's own hooks would otherwise run arbitrary commands inside a session
  whose brief may be attacker-influenced. `--setting-sources user` also
  blocks hooks but drops the repo's CLAUDE.md with it.
- **Delete `CLAUDE_SESSION_ID`/`CLAUDE_PARENT_SESSION_ID`, set
  `CLAUDE_ENTRYPOINT=worker`** — bypasses nested-session detection when the
  parent process is itself a Claude Code session.
- **Never set `ANTHROPIC_API_KEY`** — switches Max subscription billing to
  API billing silently. IU routing instead injects
  `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` (`server/lib/routing.ts`).
- **No `--resume` for HITL** — session IDs can change on resume, context is
  lost after API limits, and a killed mid-execution resume corrupts the
  session. Use a fresh session with prior context injected into the prompt
  instead.

## Key flags quick reference

See `references/cli-flags.md` for the complete list.

| Flag | Purpose |
|-|-|
| `-p` / `--print` | Non-interactive mode (required) |
| `--output-format json\|stream-json\|text` | Output format — sideclaw uses `stream-json --verbose` |
| `--json-schema '<schema>'` | Validated structured output (json format only); result in `structured_output` |
| `--dangerously-skip-permissions` | All tools auto-approved — the MCP server is the trust boundary |
| `--disallowedTools "Write,Edit"` | Block specific tools — the only lever that works under skip-permissions |
| `--model haiku\|sonnet\|opus` | Model selection |
| `--max-turns N` | Limit agent loop iterations |
| `--setting-sources user,project` | Load `~/.claude/settings.json` + target repo's CLAUDE.md/rules |
| `--settings '{"disableAllHooks":true}'` | Block the target repo's own hooks from executing |
| `--effort low\|medium\|high\|max` | Thinking depth |
