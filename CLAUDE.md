# sideclaw — Developer Notes

## Architecture

React frontend (Vite) + Bun/Elysia backend, running natively on the host.
Served on `http://sideclaw.local` (localias proxy → port 7705).

Bun loads `.env` automatically from the `sideclaw/` directory — all env vars
(`PERSONAL_REPOS_PATH`, `WORK_REPOS_PATH`, `GITHUB_TOKEN`) live there.

## Running sideclaw

**sideclaw runs exclusively via LaunchAgent. Never start it standalone.**

- `make dev` and `make start` are intentionally broken — they exit with an error.
- Do NOT run `bun run dev`, `bun run start`, `bun server/index.ts`, or anything that starts a server directly.
- Port 7705 is owned by the LaunchAgent. Starting a second process there causes conflicts.

```bash
make build           # Build frontend to dist/ (no server start)
make reload          # After code changes: build + kickstart LaunchAgent
make install-agent   # One-time: build + install + start LaunchAgent
make uninstall-agent # Remove LaunchAgent

tail -f /tmp/sideclaw.log   # stdout
tail -f /tmp/sideclaw.err   # stderr
```

The LaunchAgent starts automatically on login and restarts on crash.

## MCP Server

sideclaw exposes workflow tools (check, review, ship) as an MCP server — a **separate process** from the LaunchAgent, spawned on-demand by Claude Code via stdio transport.

Entry point: `server/mcp.ts`. Tools live in `server/mcp/tools/`, skill prompts in `server/skills/`.

### Review Tool — Multi-Angle Pipeline

The `review` tool runs a 3-phase parallel pipeline (see `server/skills/review/README.md` for full docs):

1. **Data gathering** (parallel): git diff, fallow audit, CodeRabbit CLI
2. **Angle reviews** (parallel haiku sessions): architect, senior-dev, + conditionally frontend (.tsx/.jsx), backend (api/server .ts), typescript (.ts), QA (if tests exist)
3. **Synthesis** (sonnet): deduplicates, classifies into `blocking` / `improvements` / `discussions` / `testGaps`

Output `outcome`: `"clean"` (ship it), `"actionable"` (apply fixes), `"needs-human"` (has discussions).
Frontend agent loads react/tanstack rules; backend agent loads elysia rules + fetches `elysiajs.com/llms.txt`.

```bash
# Register at user scope (one-time, already done)
claude mcp add --scope user sideclaw -- bun run /Users/johannes.krumm/SourceRoot/sideclaw/server/mcp.ts

# Structured logs (both HTTP + MCP processes write here)
tail -f /tmp/sideclaw.jsonl | jq .
tail -f /tmp/sideclaw.jsonl | jq 'select(.source == "mcp")'
```

Inner sessions spawned by MCP tools use `claude -p` with `--setting-sources user,project` and Max subscription billing (no API key). See `.claude/rules/mcp-tools.md` for authoring conventions.

## Git Workflow

Direct-to-master repo — no PRs, no releases.

```
/review   → optional code review before committing
/commit   → commit, then push to master directly
/ship     → review → commit → push (skips PR and release steps)
```

Never create feature branches or PRs for this repo.

## Fullscreen (kiosk mode)

The DiagramPanel fullscreen button tries the native browser Fullscreen API first.
In WebKit-based browsers (e.g. CMUX) that don't expose it, the frontend calls
`GET /api/open-kiosk?url=<current-url>` — the Elysia backend spawns Chrome with
`--kiosk --user-data-dir=/tmp/sideclaw-kiosk` on the host. Tries regular Chrome,
Chromium, then Playwright Chrome for Testing. Falls back to CSS focus mode if
no binary is found. **Exit kiosk:** `Cmd+Q`.

## Project Skills

Project-specific skills live in `.claude/skills/` (tracked in git, unlike most repos).
Settings files (`.claude/settings.json`, `.claude/settings.local.json`) remain gitignored.

| Skill | Purpose |
|-|-|
| `claude-cli` | Reference for spawning `claude -p` subprocesses from Bun/TypeScript |

## Validating UI Changes

In dev: changes reflect immediately via Vite HMR at the dev server port.
In prod: `make build` + reload `http://sideclaw.local` in browser.
Use the Chrome MCP extension for visual validation via screenshots.

