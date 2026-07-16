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

### Enabling the GitPanel

Both git and queue surfaces are **off by default** — opt in per `.env`.

Set `SIDECLAW_GIT_ENABLED=true` + `VITE_SIDECLAW_GIT_ENABLED=true` in `.env`
to turn on the whole git surface — GitPanel renders, `/api/repo/git` and
`/api/github` return live data, and `/api/actions/{chain,git}` are active.
Left unset, the git surface stays off (`data: null`, actions return 503),
which avoids GitHub rate-limit pressure.

### Enabling the QueuePanel

Set `SIDECLAW_QUEUE_ENABLED=true` + `VITE_SIDECLAW_QUEUE_ENABLED=true` in
`.env` to turn on the whole queue surface — QueuePanel renders, `GET
/api/queue` and `/api/completed-tasks` return live data, `PUT /api/queue`
writes, `/api/repo` includes the queue, the SSE watcher tracks `sc-queue.md`,
and repo init creates the file. Left unset, the queue surface stays off
(empty arrays, `PUT` returns 503). Enable it when the task-queue workflow
(Stop-hook injection from dotfiles) is in play.

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

sideclaw exposes workflow tools (`check`, `review`) plus the job-polling tools (`job_status`, `job_wait`) as an MCP server — a **separate process** from the LaunchAgent, spawned on-demand by Claude Code via stdio transport.

Entry point: `server/mcp.ts`. Thin MCP tool wrappers live in `server/mcp/tools/`; the actual execution logic + schemas live in `server/jobs/handlers/`; skill prompts in `server/skills/`.

**Deploying schema changes:** `make reload` only restarts the launchd HTTP server (job execution + skill-prompt reads, which load from disk per-run). It does NOT restart the MCP process — that's owned by the calling Claude Code session. So an edited tool **input/output schema** (e.g. a new `commands`/`validateCmd` field on `*_INPUT`) is not visible to a connected client until its MCP reconnects; until then the SDK's Zod validation silently **strips** the unknown field before it reaches the handler. After changing a tool schema, reconnect `/mcp` (or restart the session) — not just `make reload`. Skill-prompt and handler-logic edits need only `make reload`.

### Async job model (durable, off the MCP transport)

The long tools (`check`/`review`) do **not** block the MCP call. A 13-minute worker run held open as a single MCP request destabilizes the stdio transport (and the SDK's 60s client timeout). Instead:

1. The MCP tool **submits a job** to the always-on HTTP server (`POST /api/jobs`) and returns `{ jobId, status }` immediately.
2. The HTTP server (LaunchAgent, durable) runs the job in the background and persists state to **bun:sqlite** (`/tmp/sideclaw-jobs.db`, separate from the ephemeral `/tmp/sideclaw.db`). See `server/jobs/store.ts`.
3. The caller polls **`job_wait({ jobId })`** — a long-poll (~50s, heartbeated) that returns the result the moment the job finishes, or `stillRunning: true` to call again. `job_status` is a one-shot peek.

While a job runs, `job_status`/`job_wait` also expose live worker progress derived from the worker's stream-json output: `turns`, `lastAction` (e.g. `"Edit store.ts"`), and **`idleMs`** — ms since the last worker event. `idleMs` is the wedge signal: it stays low while events flow and rises during a single long operation (e.g. a slow test run), so a *large and still-growing* `idleMs` means the session may be stuck — peek at `git status` rather than waiting indefinitely. The runner persists each snapshot via a `ProgressSink` threaded `store → executor → handler → runSession.onActivity`; `review` aggregates one shared liveness bump across its parallel angle sessions.

Why the HTTP server hosts jobs (not the MCP process): the MCP process dies on `/mcp` disconnect, but the HTTP server is launchd-managed. Jobs survive MCP reconnects; disk persistence survives an HTTP restart (in-flight jobs reconcile to `interrupted` on boot — `recover()`). A **global concurrency cap** (`SIDECLAW_JOB_CONCURRENCY`, default 3) queues excess submissions as `pending` so parallel agents can't trip the IU unified endpoint's rate limits.

Job lifecycle events log to `/tmp/sideclaw.jsonl` (`job.create` / `job.start` / `job.done` / `job.fail` / `job.recover`). Inspect the queue: `curl -s localhost:7705/api/jobs | jq`.

Higher-order tools reuse capabilities at the **code level, not via MCP recursion**: `review` angle workers can validate external library/API claims against the standalone **research-gateway** (a bounded bearer-auth `curl`, gated on `RESEARCH_GATEWAY_URL`/`RESEARCH_GATEWAY_TOKEN`) and self-validate (check capability) — no nested jobs, no semaphore deadlock.

### Worker model — backend selection: IU (default) / Max / bridge

Worker sessions run on **Claude via the IU unified endpoint's native Anthropic transport** by default (the same recipe dotfiles' `ca`/`claude_iu` use) — metered IU per-token billing, off Max. `session-runner.ts` selects the backend by model id: plain `claude-*` ids (default `claude-sonnet-5[1m]`, `check` uses `claude-haiku-4-5`) resolve the IU key/base via `getIuConfig()` and inject `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` directly — no `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` (that flag was a bridge-only workaround). Each IU-native session writes a `session_env` line to `~/.claude/logs/<date>.jsonl` (mirroring the dotfiles SessionStart hook) so usage-tracker classifies worker spend as IU, not Max.

**`SIDECLAW_WORKER_BACKEND`** (`.env`, default `iu`) is a per-installation escape hatch onto the Max subscription: set it to `max` and plain `claude-*` worker sessions delete `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` instead of injecting the IU ones, so the CLI falls through to the inherited OAuth profile — Max subscription rate-limit budget, not metered API tokens. It only affects plain `claude-*` ids; `DeepSeek*`/`*-eu` ids always route to the bridge regardless of the flag. Read once at module load from `sideclaw/.env`, so flipping it requires **`make reload`** (not just a code edit) to take effect. On the `max` backend, `session_env` is still written but with an explicit `base_url: null` (not skipped) — usage-tracker's classifier (`models.ts`) reads `base_url` present → `iu`, `null`/missing → `max`, so this is how a Max-backend run gets attributed `billing="max"`.

The **LiteLLM bridge** (`dotfiles/litellm/`, LaunchAgent on `:4000`, DeepSeek-V4-Pro/Flash via Azure Spain with failover to `claude-sonnet-4-6-eu`) is retained but off the hot path — it only engages when a `DeepSeek*` or `*-eu` model id is passed. Full background: `dotfiles/docs/deepseek-litellm-bridge.md`.

**Caveat:** `check`/`review` run as jobs inside the launchd HTTP server, which loads `sideclaw/.env` via Bun — `SIDECLAW_WORKER_BACKEND` (like every other `SIDECLAW_*` var) applies reliably there. `otel` calls `runSession` directly in the MCP process (`server/mcp/tools/otel.ts`), which Bun starts with the *calling session's* cwd and may not pick up `sideclaw/.env` — for `otel`, the var would need to be exported in the environment instead. Pre-existing limitation, not specific to this flag.

Two constraints carried over regardless of backend:
- **No `WebSearch`/`WebFetch`** — not wired into worker prompts. For web/library facts, workers shell out via Bash instead — `review` angle workers `curl` the research-gateway (async submit + poll) to validate external claims.
- **Read-only tools must opt in** (`readOnly: true` → `--allowedTools "Read,Bash,Grep,Glob"`). Workers will edit files under `--dangerously-skip-permissions` otherwise. `check`/`review` are all read-only.

### Review Tool — Multi-Angle Pipeline

The `review` job (`server/jobs/handlers/review.ts`) runs a 3-phase parallel pipeline inside the HTTP server (see `server/skills/review/README.md` for full docs):

1. **Data gathering** (parallel): git diff, fallow audit, CodeRabbit CLI
2. **Angle reviews** (parallel claude-sonnet-5 sessions, capped at `ANGLE_CONCURRENCY=3` so the IU endpoint's rate limits aren't tripped): architect, senior-dev, + conditionally frontend (.tsx/.jsx), backend (api/server .ts), typescript (.ts), QA (if tests exist)
3. **Synthesis** (claude-sonnet-5): deduplicates, classifies into `blocking` / `improvements` / `discussions` / `testGaps`

Output `outcome`: `"clean"` (ship it), `"actionable"` (apply fixes), `"needs-human"` (has discussions).
Frontend agent loads react/tanstack rules; backend agent loads elysia rules + fetches `elysiajs.com/llms.txt`.

**External-fact validation (optional):** when `RESEARCH_GATEWAY_URL` + `RESEARCH_GATEWAY_TOKEN` are set in `.env`, each angle prompt gets a bounded `curl` recipe (and the bearer via `extraEnv`) so a reviewer can validate an external library/API/version claim against the research-gateway before filing it. Unconfigured → the block is empty and review runs unchanged.

**Synthesis salvage:** the synthesizer occasionally emits prose instead of the schema JSON. Synthesis now retries once with a JSON-only directive, then falls back to a `needs-human` verdict that preserves the raw synthesizer text in a discussions entry (via `SessionResult.rawText`) — a multi-minute run is never discarded as a bare parse error.

### Multimodal tools — direct IU OpenAI transport (synchronous)

`read_image`, `read_drawing`, and `generate_image` are **not** bridge worker sessions and **not** async jobs. They are plain `fetch` calls to the IU unified endpoint's **OpenAI transport** (`/openai/v1/...`) — stateless, synchronous MCP tools (single call well under the 60s SDK timeout; a `mcpHeartbeat` in `session-runner.ts` keeps the client alive past 15s). Billed IU per-token, zero Max, zero bridge worker, no `session-runner` / `claude -p` / read-only allowlist.

- **Credentials** (`server/lib/iu-openai.ts`): IU key + base from Keychain (`claude-sdk-api-key`, `claude-sdk-base-url`) or `IU_API_KEY`/`IU_BASE_URL` env. The OpenAI base is derived by replacing the base's trailing `/anthropic` → `/openai/v1` (never hardcoded). `iuFetch` retries 503/429/5xx with backoff; fails fast on 410 (dead model — e.g. `dall-e-3`).
- **Models (fixed, not residency knobs):** vision = `gemini-3.5-flash` (fast, strong on dense diagrams), image gen = `gpt-image-2`. Both route to a **non-EU vendor** — fine for git-committed/non-sensitive content, not PII.
- **`read_image`** — vision read of any image. SVGs are rasterized first (`server/lib/image.ts`).
- **`read_drawing`** — composite: rasterize+read the `.svg` AND deterministically parse the paired `.excalidraw` JSON (`server/lib/excalidraw.ts` — the structural ground truth: frames, bindings, groups), merged into one synthesis (`server/skills/read-drawing.md`). The dotfiles `/read-drawing` skill's `claude_iu` Haiku path is retired in favor of this.
- **`generate_image`** — `gpt-image-2`, decodes `b64_json`, writes a PNG.
- **SVG rasterizer:** headless Chrome (`server/lib/chrome.ts` `findChrome`, shared with kiosk) — the only method that resolves web fonts faithfully without cropping. `resvg`/`rsvg-convert`/`qlmanage`/`svglib` all failed the bake-off.
- **Telemetry:** these bypass the LiteLLM bridge, so the usage-tracker's litellm collector never sees them. `recordIuUsage` appends an NDJSON line per call to `~/.local/share/usage-tracker/sideclaw-iu.jsonl` (litellm-collector-compatible shape; override with `SIDECLAW_IU_USAGE_LOG`) plus `/tmp/sideclaw.jsonl` events. The usage-tracker's `sideclaw-iu` collector ingests that file (`server/routes/usage.ts` is only Max-quota %, not a token ledger).
- **Reasoning tokens are derived, not reported.** The gateway returns only `prompt_tokens`/`completion_tokens`/`total_tokens` — no `completion_tokens_details` — and for Gemini the thinking spend sits *outside* `completion_tokens` (`total = prompt + candidates + thoughts`), billed at the output rate. `normalizeUsage` recovers it as `total - input - output`; the leftover is 0 for non-thinking models, so nothing is double-counted. It is not a rounding detail: a 133-token answer routinely hides ~3k thinking tokens, so dropping it understated cost several-fold. `IU_USAGE_SCHEMA` in `server/lib/iu-openai.ts` is the single source of truth for both `IuUsage` and every tool's `usage` output field — import it, don't re-declare the shape.

```bash
# Register at user scope — handled by `make setup` in ~/SourceRoot/dotfiles.
# Manual fallback:
claude mcp add --scope user sideclaw -- bun run "$HOME/SourceRoot/sideclaw/server/mcp.ts"

# Structured logs (both HTTP + MCP processes write here)
tail -f /tmp/sideclaw.jsonl | jq .
tail -f /tmp/sideclaw.jsonl | jq 'select(.source == "mcp")'
```

Inner sessions spawned by MCP tools use `claude -p` routed via `session-runner.ts` (claude-sonnet-5 / claude-haiku-4-5): IU per-token billing by default, or the Max subscription when `SIDECLAW_WORKER_BACKEND=max`. See `.claude/rules/mcp-tools.md` for authoring conventions.

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

