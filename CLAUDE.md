# sideclaw — Developer Notes

## Architecture

React frontend (Vite) + Bun/Elysia backend, running natively on the host.
Served on `http://sideclaw.local` (localias proxy → port 7705).

Bun loads `.env` automatically from the `sideclaw/` directory — all env vars
(`PERSONAL_REPOS_PATH`, `WORK_REPOS_PATH`, `GITHUB_TOKEN`) live there.

### GitHub API caching

All Octokit calls go through an ETag + soft-TTL cache installed as request
hooks (`server/lib/github-cache.ts`). Two layers:

1. **Soft-TTL fan-out (10s default, 5min for `/contents/`)** — repeat
   requests within the window return cached data without touching GitHub.
2. **ETag revalidation** — past soft-TTL, `If-None-Match` is sent;
   304 responses are converted back to cached payloads (free against the
   primary 5,000/hr rate limit).

Cache keys are the fully resolved request URL (`octokit.request.endpoint()`),
so per-repo isolation is enforced. Frontend polling (`GitPanel.tsx`) runs at
30s and pauses while the tab is hidden. Observe via
`jq 'select(.event | startswith("github.cache"))' /tmp/sideclaw.jsonl`.

### Disabling the GitPanel

Set `SIDECLAW_GIT_DISABLED=true` + `VITE_SIDECLAW_GIT_DISABLED=true` in `.env`
to turn off the whole git surface — GitPanel doesn't render, `/api/repo/git`
and `/api/github` return `data: null`, and `/api/actions/{chain,git}` return
503. Use this when GitHub rate-limit pressure outweighs the dashboard value.

### Disabling the QueuePanel

Set `SIDECLAW_QUEUE_DISABLED=true` + `VITE_SIDECLAW_QUEUE_DISABLED=true` in
`.env` to turn off the whole queue surface — QueuePanel doesn't render, `GET
/api/queue` and `/api/completed-tasks` return empty arrays, `PUT /api/queue`
returns 503, `/api/repo` returns `queue: []`, the SSE watcher skips
`sc-queue.md`, and repo init no longer creates the file. Use this when the
task-queue workflow (Stop-hook injection from dotfiles) isn't in play.

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

sideclaw exposes workflow tools (`check`, `review`, `research`, `implement`) plus the job-polling tools (`job_status`, `job_wait`) as an MCP server — a **separate process** from the LaunchAgent, spawned on-demand by Claude Code via stdio transport.

Entry point: `server/mcp.ts`. Thin MCP tool wrappers live in `server/mcp/tools/`; the actual execution logic + schemas live in `server/jobs/handlers/`; skill prompts in `server/skills/`.

### Async job model (durable, off the MCP transport)

The four long tools (`check`/`review`/`research`/`implement`) do **not** block the MCP call. A 13-minute worker run held open as a single MCP request destabilizes the stdio transport (and the SDK's 60s client timeout). Instead:

1. The MCP tool **submits a job** to the always-on HTTP server (`POST /api/jobs`) and returns `{ jobId, status }` immediately.
2. The HTTP server (LaunchAgent, durable) runs the job in the background and persists state to **bun:sqlite** (`/tmp/sideclaw-jobs.db`, separate from the ephemeral `/tmp/sideclaw.db`). See `server/jobs/store.ts`.
3. The caller polls **`job_wait({ jobId })`** — a long-poll (~50s, heartbeated) that returns the result the moment the job finishes, or `stillRunning: true` to call again. `job_status` is a one-shot peek.

While a job runs, `job_status`/`job_wait` also expose live worker progress derived from the worker's stream-json output: `turns`, `lastAction` (e.g. `"Edit store.ts"`), and **`idleMs`** — ms since the last worker event. `idleMs` is the wedge signal: it stays low while events flow and rises during a single long operation (e.g. a slow test run), so a *large and still-growing* `idleMs` means the session may be stuck — peek at `git status` rather than waiting indefinitely. The runner persists each snapshot via a `ProgressSink` threaded `store → executor → handler → runSession.onActivity`; `review` aggregates one shared liveness bump across its parallel angle sessions.

Why the HTTP server hosts jobs (not the MCP process): the MCP process dies on `/mcp` disconnect, but the HTTP server is launchd-managed. Jobs survive MCP reconnects; disk persistence survives an HTTP restart (in-flight jobs reconcile to `interrupted` on boot — `recover()`). A **global concurrency cap** (`SIDECLAW_JOB_CONCURRENCY`, default 3) queues excess submissions as `pending` so parallel agents can't stampede the single-backend Kimi bridge into 429s.

Job lifecycle events log to `/tmp/sideclaw.jsonl` (`job.create` / `job.start` / `job.done` / `job.fail` / `job.recover`). Inspect the queue: `curl -s localhost:7705/api/jobs | jq`.

Higher-order tools reuse capabilities at the **code level, not via MCP recursion**: `implement`/`review` workers get the Tavily key inline (research capability) and self-validate (check capability) — no nested jobs, no semaphore deadlock.

### Worker model — LiteLLM bridge (Kimi-K2.6, EU)

Every worker session runs on the **IU unified endpoint via a local LiteLLM bridge**, never on the Max subscription (Max is reserved for the orchestrator). The bridge (`dotfiles/litellm/`, LaunchAgent on `:4000`) translates Anthropic Messages → OpenAI chat/completions and routes to **Kimi-K2.6** (EU/GDPR, Azure Sweden), with LiteLLM-native failover to `claude-sonnet-4-6-eu`. `session-runner.ts` injects `ANTHROPIC_BASE_URL=http://localhost:4000` + a dummy `ANTHROPIC_AUTH_TOKEN` + `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`. Full background: `dotfiles/docs/kimi-litellm-bridge.md`.

Two constraints the bridge imposes:
- **No `WebSearch`/`WebFetch`** — they make internal Anthropic-model calls the bridge can't serve. `research` uses Tavily + `curl` + Context7 via Bash instead.
- **Read-only tools must opt in** (`readOnly: true` → `--allowedTools "Read,Bash,Grep,Glob"`). Kimi will edit files under `--dangerously-skip-permissions` otherwise. `check`/`review`/`research` are read-only; `implement` has full file access.

### Review Tool — Multi-Angle Pipeline

The `review` job (`server/jobs/handlers/review.ts`) runs a 3-phase parallel pipeline inside the HTTP server (see `server/skills/review/README.md` for full docs):

1. **Data gathering** (parallel): git diff, fallow audit, CodeRabbit CLI
2. **Angle reviews** (parallel Kimi-K2.6 sessions, capped at `ANGLE_CONCURRENCY=3` so the single-backend model doesn't 429): architect, senior-dev, + conditionally frontend (.tsx/.jsx), backend (api/server .ts), typescript (.ts), QA (if tests exist)
3. **Synthesis** (Kimi-K2.6): deduplicates, classifies into `blocking` / `improvements` / `discussions` / `testGaps`

Output `outcome`: `"clean"` (ship it), `"actionable"` (apply fixes), `"needs-human"` (has discussions).
Frontend agent loads react/tanstack rules; backend agent loads elysia rules + fetches `elysiajs.com/llms.txt`.

```bash
# Register at user scope — handled by `make setup` in ~/SourceRoot/dotfiles.
# Manual fallback:
claude mcp add --scope user sideclaw -- bun run "$HOME/SourceRoot/sideclaw/server/mcp.ts"

# Structured logs (both HTTP + MCP processes write here)
tail -f /tmp/sideclaw.jsonl | jq .
tail -f /tmp/sideclaw.jsonl | jq 'select(.source == "mcp")'
```

Inner sessions spawned by MCP tools use `claude -p` routed through the LiteLLM bridge (Kimi-K2.6, IU per-token billing — no Max quota). See `.claude/rules/mcp-tools.md` for authoring conventions.

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

