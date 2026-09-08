# sideclaw — Developer Notes

## Architecture

React frontend (Vite) + Bun/Elysia backend, running natively on the host,
loopback-only on `:7705`. Reached via Caddy: `https://sideclaw.test` locally
— **no tailnet door, deliberately**. `~/.config/caddy-tailnet.ports` carries
an explicit `exclude sideclaw`: the job API has no auth, so a tailnet twin
would let any tag:mac/phone/tablet node `POST /api/jobs` with `dispatch
implement`. Don't remove that exclusion. (A few source files still reference
`http://sideclaw.local`, a localias-proxy convention; localias isn't
installed here — treat it as dead, see `docs/ui-and-caching.md`.)

Bun loads `.env` automatically from the `sideclaw/` directory — all env vars
(`PERSONAL_REPOS_PATH`, `WORK_REPOS_PATH`, `GITHUB_TOKEN`, `SIDECLAW_*`,
`RESEARCH_GATEWAY_*`) live there, listed in `README.md`. That auto-load is
cwd-based, so the **MCP process** (spawned with the calling session's cwd)
imports `server/lib/load-env.ts` first thing in `mcp.ts` to read the same
file — existing environment always wins over the file.

Frontend UI (kiosk fullscreen, validating UI changes): `docs/ui-and-caching.md`.

## Running sideclaw

**sideclaw runs exclusively via LaunchAgent. Never start it standalone.**

- `make dev` and `make start` are intentionally broken — they exit with an error.
- Do NOT run `bun run dev`, `bun run start`, `bun server/index.ts`, or anything that starts a server directly.
- Port 7705 is owned by the LaunchAgent. Starting a second process there causes conflicts.

```bash
make build           # Build frontend to dist/ (no server start)
make reload          # After code changes: build + self-initiated drain (POST /api/shutdown, ≤40 min — launchd's real signal-and-wait timer never engages on this path) + restart. Refuses while jobs run — FORCE=1 discards them (force=1 request, or a real SIGINT), escalating an in-progress drain if one is running. Falls back to `launchctl kill` (short window, capped by launchd's measured 60s ExitTimeOut) if the endpoint doesn't answer. Also refuses on tracked/installed plist drift (file AND launchd's live state) — see docs/deployment.md § Two shutdown paths, two windows
make install-agent   # One-time: build + install + start LaunchAgent
make uninstall-agent # Remove LaunchAgent

tail -f ~/Library/Logs/sideclaw.log   # stdout
tail -f ~/Library/Logs/sideclaw.err   # stderr
```

The LaunchAgent starts automatically on login and restarts on crash.

**Logs live in `~/Library/Logs`, never `/tmp`** — a KeepAlive agent opens its
stdio once at spawn, and macOS's periodic cleanup sweeps untouched `/tmp`
files after 3+ days, leaving the process writing into an unlinked inode
(sideclaw lost a post-mortem to exactly this once). The paths live in
`com.jkrumm.sideclaw-server.plist`; `make install-agent` copies that file
verbatim over the live one, so change the tracked file, never the live one.

**The label is `com.jkrumm.sideclaw-server` and the program is a wrapper
script (`scripts/sideclaw-start.sh`), not `bun` directly — both are macOS
Background Task Management workarounds, not style.** Reverting either brings
back "sideclaw doesn't come up after a power cut" (measured across three
reboots 2026-08-06). Verify after any plist change:

```bash
log show --last 2m --info | grep -A3 sideclaw-server.plist | grep effectiveItemDisposition
# want: result=[enabled, allowed, ...]
```

Full forensic story (why BTM denies this specific label/executable):
`docs/deployment.md`.

## MCP Server

sideclaw exposes workflow tools (`check`, `review`, `dispatch`, `overview`,
`narrative`, `otel`) plus the synchronous multimodal tools (`read_image`,
`read_drawing`, `excalidraw_diagram`) plus the job-polling tools
(`job_status`, `job_wait`) as an MCP server — a **separate process** from the
LaunchAgent, spawned on-demand by Claude Code via stdio transport.
`GET /api/agents` (below) is HTTP-only, deliberately outside this MCP
surface — see `### agents, overview, narrative`.

Entry point: `server/mcp.ts`. Thin MCP tool wrappers live in
`server/mcp/tools/`; the actual execution logic + schemas live in
`server/jobs/handlers/`; skill prompts in `server/skills/`.

**Deploying schema changes:** `make reload` only restarts the launchd HTTP
server (job execution + skill-prompt reads, which load from disk per-run). It
does NOT restart the MCP process — that's owned by the calling Claude Code
session. So an edited tool **input/output schema** (e.g. a new
`commands`/`validateCmd` field) is not visible to a connected client until
its MCP reconnects; until then the SDK's Zod validation silently **strips**
the unknown field before it reaches the handler. After changing a tool
schema, reconnect `/mcp` (or restart the session) — not just `make reload`.
Skill-prompt and handler-logic edits need only `make reload`.

### Async job model (durable, off the MCP transport)

The long tools (`check`/`review`/`dispatch`/`overview`/`narrative`) do
**not** block the MCP call. A 13-minute worker run held open as a single MCP
request destabilizes the stdio transport (and the SDK's 60s client timeout).
Instead:

1. The MCP tool **submits a job** to the always-on HTTP server
   (`POST /api/jobs`) and returns `{ jobId, status }` immediately.
2. The HTTP server (LaunchAgent, durable) runs the job in the background and
   persists state to **bun:sqlite** (`~/.local/share/sideclaw/jobs.db`), not
   `/tmp` for the same sweep reason as the logs (`server/jobs/store.ts`). The
   server binds **`127.0.0.1:7705` only** — every consumer (herdr pane,
   Hermes, the MCP child, `fetch_usage.py`, devhost-health) is local and the
   API carries no auth of its own.
3. The caller polls **`job_wait({ jobId })`** — a long-poll (~50s,
   heartbeated) that returns the result the moment the job finishes, or
   `stillRunning: true` to call again. `job_status` is a one-shot peek.
   An explicit `maxWaitMs` may go up to **29 min**, turning a `review`'s ~9
   round trips into one — but only because this server's `~/.claude.json`
   entry carries a matching `timeout` (1800000). **The two are one setting in
   two files**: without the client half, a long wait is aborted at 60s as a
   hard error, where the 50s default would have returned a clean
   `stillRunning`. Leave the default alone; raise it per call.

While a job runs, `job_status`/`job_wait` also expose live worker progress
derived from the worker's stream-json output: `turns`, `lastAction` (e.g.
`"Edit store.ts"`), and **`idleMs`** — ms since the last worker event. A
*large and still-growing* `idleMs` means the session may be stuck — peek at
`git status` rather than waiting indefinitely.

Why the HTTP server hosts jobs (not the MCP process): the MCP process dies on
`/mcp` disconnect, but the HTTP server is launchd-managed. Jobs survive MCP
reconnects; disk persistence survives an HTTP restart: on boot `recover()`
re-queues an interrupted `check`/`overview`/`narrative`/`review` **once**
(all read-only and idempotent) and marks everything else `interrupted`
(`dispatch` is never auto re-run — an `implement` episode may already have
pushed). `make reload` refuses while jobs are running unless `FORCE=1` (which
asks for the same forced abort as always — never SIGKILL, which isn't
catchable and would skip `terminateActiveSessions()` entirely, orphaning
`claude -p` workers that keep writing/committing after the reload believed it
had stopped them). Otherwise `make reload` now asks the server to shut itself
down (`POST /api/shutdown`, `server/routes/shutdown.ts`) instead of signaling
it: launchd's `ExitTimeOut` only engages when launchd itself sends the signal
and waits, so a self-initiated exit never starts that clock and can drain for
up to `HTTP_DRAIN_GRACE_MS` (~40 min, sized to the dominant single-attempt
worst case, not the full double-timeout-fallback chain). A real SIGTERM/SIGINT
(reboot, logout, launchd itself, or `reload`'s own fallback when the HTTP
endpoint doesn't answer) instead gets `SIGNAL_DRAIN_GRACE_MS` (45s) — launchd's
`ExitTimeOut` is hard-capped at 60s on this host regardless of what the plist
says (measured 2026-09-08), so that path has to stay short. Full story of both
windows: `docs/deployment.md` § Two shutdown paths, two windows. A forced
abort (`force=1`/SIGINT) arriving mid-drain escalates it to an immediate
abort rather than being dropped. A job whose worker is one the drain
actually terminated is left `running` for the next boot's ordinary
crash-recovery, not written `failed` — an unrelated failure that merely
lands in the same drain window still is. `make reload` also refuses
outright if the tracked plist has drifted from the one launchd has loaded —
checked both as a file compare and against launchd's own live
`exit timeout` — `launchctl kill` never re-reads a changed plist, only
`launchctl bootstrap` (`make install-agent`, which boots the current label
out first so that bootstrap reliably takes, waits for the old PID to
actually exit before copying the plist and bootstrapping, and now fails
loudly — rather than reporting success unconditionally — if the new
instance never comes up on `:7705`) does. A **global concurrency
cap** (`SIDECLAW_JOB_CONCURRENCY`, default 3) queues excess submissions as
`pending` so parallel agents can't trip the IU unified endpoint's rate
limits — while draining, that queue backs up too, which `GET
/api/jobs/health`'s `draining: true` flag distinguishes from a wedged queue.

Job lifecycle events log to `~/Library/Logs/sideclaw.jsonl` (`job.create` /
`job.start` / `job.done` / `job.fail` / `job.recover` / `job.requeue` /
`job.shutdown_abandoned`). Inspect the queue:
`curl -s localhost:7705/api/jobs | jq`.
**`GET /api/jobs/health`** → `{ ok, running, pending, failedLastHour,
interruptedLastHour, oldestPendingAgeMs, lastFailure, draining, sinceBootMs,
recoveredFromDrain }`, `ok: false` when ≥3 jobs failed in the last hour, or
the oldest pending job has waited >15 min **and neither grace applies**: a
drain intentionally stalls promotion, so queue backup alone never trips it
while one is in flight (`draining: true`); the same backlog also gets a
`BOOT_HEALTH_GRACE_MS` (5 min) pass right after a restart, but **only** when
`recoveredFromDrain` is true — i.e. the previous process ran its shutdown
path to the **end** (a persisted marker written by `markDrainCompleted()` when
the drain finishes, read and cleared once on the next boot), not merely
`sinceBootMs` being small. Written at the drain's *start* it would also survive
a mid-drain SIGKILL and hand the grace to the very crash loop it exposes. A
raw crash never sets that marker, so a
crash-looping process gets no grace — the backlog stays visible on every
restart instead of permanently hiding behind "just booted." dotfiles'
devhost-health reads it. A failed worker's stderr is logged at
**warn** (`session.stderr`) so a post-mortem exists.

### agents, overview, narrative — one snapshot, one triage pass, one vault writer

`GET /api/agents[.txt]` (`server/lib/agents.ts`) is a **deterministic,
read-only, no-LLM** snapshot of every Claude Code agent on this Mac mini,
grouped by project, merged across `herdr agent list`, `claude agents --json`
and the dispatch job store by sessionId — the single producer behind an
agent overview rendered by Hermes, an Argo dashboard, a brain page and a
herdr pane. `?color=1`/`?ansi=1` and `?cols=N` (40–200, default 110) support
the herdr phone-width pane. `humanQueue` (top-level) surfaces pending
`ask-human.sh` requests, never fed into the LLM prompt. `state` (`needs_you >
working > stale > idle > done > unknown`, `SIDECLAW_AGENT_STALE_HOURS`
default 24) is the only field consumers should branch on. Full merge/tail-read
mechanics: `docs/agent-overview-internals.md`.

The `overview` job enriches that snapshot with **one LLM recommendation per
agent** (`answer`/`continue`/`ship`/`review`/`merge`/`close`/`stale`/`watch`,
each with `standing`/`blocker`/`confidence`) — one batched, prompt-only call
(`readOnly: true`, no repo tools), model/backend from `routeFor("overview")`
(glm-5.3-flash on IU / Haiku on Max). `GET /api/overview[.txt]` never runs the
LLM inline — it merges the latest **completed** job result onto a fresh
snapshot, and marks a recommendation `recommendationStale: true` if the agent
has been active since. Full reconciliation/fencing detail:
`docs/agent-overview-internals.md`.

The `narrative` job writes/revises one project's Obsidian vault page from
git log + session transcripts + `voice.md` — business terms, never a
changelog; `changed: false` with no page is a correct default answer, not a
failure. Model/backend from `routeFor("narrative")` (`claude-sonnet-5[1m]` on
both lanes — editorial judgment, not classification, so no cheap tier). Caps
enforced in code (`clampSections`), never trusted from the model. Full input/
output contract and gathering rules: `docs/agent-overview-internals.md`.

Higher-order tools reuse capabilities at the **code level, not via MCP
recursion**: `review` angle workers can validate external library/API claims
against the standalone **research-gateway** (a bounded bearer-auth `curl`,
gated on `RESEARCH_GATEWAY_URL`/`RESEARCH_GATEWAY_TOKEN`) and self-validate
(`check` capability) — no nested jobs, no semaphore deadlock.

### Worker routing — `server/lib/routing.ts` is the only place a model or backend is decided

Every worker session (`runSession`) and the adversary text call take
`{ model, backend, fallback }` from one per-tool table; nothing else
hardcodes an id. Handlers pass `route: routeFor("<tool>")`, the MCP tool
descriptions print the same route under `MODEL:`, and **`GET /api/routing`**
shows the effective table plus every applied or refused override.

| Tool | Primary | Fallback |
|-|-|-|
| `check`, `overview`, `review`'s router | `glm-5.3-flash` on **iu** (the CLASSIFY tier) | `claude-haiku-4-5` on max (IU transport failure before first output, or any timeout — `retryAfterOutput`) |
| `narrative`, `excalidraw` | `claude-sonnet-5[1m]` on **iu** (the PROSE tier) | same model on max |
| `review` (angles, synthesis), `dispatch`, `otel` | `claude-sonnet-5[1m]` on **max** (the JUDGE tier) | same model on iu (a quota-flavoured failure) |
| `review` adversary | `gpt-5.6-terra` on iu (direct IU OpenAI text call — fixed `iu-openai` transport, `backend`/`fallback` informational only, a `SIDECLAW_BACKEND_ADVERSARY` override is refused) | none |
| `read_image`, `read_drawing` | `gemini-3.5-flash` on iu (the VISION tier — same fixed `iu-openai` transport and override refusal) | none |

Overrides: `SIDECLAW_MODEL_<TOOL>=<id>`, `SIDECLAW_BACKEND_<TOOL>=iu|max`
(read once at module load → `make reload`; the applied/refused list is logged
once at startup — `info`, or `warn` if anything was refused);
`SIDECLAW_WORKER_FALLBACK=none` pins every tool to its primary. Fallback runs
**both directions**, purely **reactively** — `max`→`iu` on a quota-flavoured
failure, `iu`→`max` on a transport failure after one same-backend retry —
each latched so a fallback attempt is never switched again. A proactive
Max-quota-ceiling pre-check used to also feed the `max`→`iu` hop before a
session even launched; removed 2026-09-08 (false-positive triggers and
stampede behavior under burst cost more than the quota it saved) — do not
re-add it. Full backend-selection rationale, the classification signals and
the retry ladder: `docs/routing-and-quota.md`.

**`otel` also injects the real ClickStack/HyperDX MCP** (bearer-authed
`http` server) into its own worker session — key resolution fails soft
(local `.env`, then `HYPERDX_PROD_ACCESS_KEY`, then `secrets-run` — never a
bare `op`, hangs headless); `readOnly: true` plus mutating tool names in
`extraDisallowedTools` keep it query-only.

Two constraints carried over regardless of backend:
- **No `WebSearch`/`WebFetch`** — workers shell out via Bash instead
  (`review` angle workers `curl` the research-gateway, async submit + poll).
- **Read-only tools must opt in** (`readOnly: true` →
  `--disallowedTools "Write,Edit,NotebookEdit"`). **It must be
  `--disallowedTools`, never `--allowedTools`** — under
  `--dangerously-skip-permissions` an allowlist restricts nothing (measured
  on CLI 2.1.220 — a probe overwrote its canary). `check`/`review` are
  read-only; `dispatch` is read-only in `investigate`/`author`, writable
  only in `implement`.

### Dispatch — bounded episodes inside another repo

The `dispatch` job hands ONE episode to a Claude Code session running inside
a named repo, so it works with that repo's own `CLAUDE.md`/rules/skills in
context — for an observer (Hermes) that has the state but not Claude-shaped
context. One episode, one verdict, no steering (mid-run redirection is
`rd bg` + `rd say`, not this).

**Tiers.** `investigate` (read-only → verdict), `author` (read-only → verdict
+ GitHub issue), `implement` (write → verdict + branch + **draft** PR).

**`sensitive: true`** opens `investigate` for secret-bearing repos
(`dotfiles-private`, `homelab-private`) — refused outright at any other tier,
before a worktree exists, since a filed issue or pushed branch has no safe
artifact path there. The verdict is scanned (`assertSensitiveTierAllowed` +
`applySensitiveScan`, `dispatch.ts`) before it leaves the machine; a match
withholds `summary`/`verdict`/`evidence` behind a notice and keeps the full
text in an owner-only `~/.local/state/sideclaw/private-verdicts/<jobId>.md`
(mode `0600`) instead. `readOnly: true` removes Edit/Write but **not**
`Bash`, and the brief is attacker-influenced — this scan is the actual
boundary for a sensitive episode, not the permission profile.

**Invariants** (full rationale + the mutation-verified test suite in
`docs/dispatch-security.md`):
- Every tier runs in its own worktree, torn down in a `finally`; read tiers
  even in a repo with no working origin, since it's a detached copy of HEAD.
- Read tiers also materialize untracked/gitignored files (bounded, symlinks
  never followed) — the read exposure was never about copying files *in*.
- Boot sweeps every stale worktree/branch left by a SIGKILL.
- The GitHub artifact (issue/branch/PR) is created by the **handler**, never
  by the worker session — the session holds no GitHub credential.
- `GIT_DENY_CREDENTIALS_ENV` at every tier — this host's `~/.gitconfig`
  wires a credential helper any process can use, and a read-only session
  still has `Bash`.
- `--settings '{"disableAllHooks":true}'` on every worker, and
  `.claude/settings{,.local}.json` are stripped from the throwaway worktree
  before the episode and restored **from the pinned base** after — an
  audited repo's hooks/`env` must never execute inside the episode.
- `implement` refuses `.github/workflows` diffs, >40 files/2000 lines, or
  added lines matching `SECRET_PATTERNS`; commits `--no-verify`; opens a
  **draft** PR from the API's `default_branch`.
- The brief is untrusted and fenced with per-run nonce delimiters, re-asserted
  after the data block.
- Salvage retries only a serialization failure (fresh session, no `--resume`)
  and marks it `degraded: true`; a real failure throws.

### Review — multi-angle pipeline

The `review` job (`server/jobs/handlers/review.ts`) runs a 3-phase parallel
pipeline: data gathering (git diff, fallow audit, CodeRabbit CLI) → angle
reviews (parallel claude-sonnet-5 sessions, capped at `ANGLE_CONCURRENCY=3`:
architect, senior-dev, + conditional frontend/backend/typescript/QA, plus
router-picked content angles security/performance/concurrency/
data-migration/api-contract/resilience against an ISO 25010 checklist, plus a
non-agentic `gpt-5.6-terra` adversary critic) → synthesis (claude-sonnet-5,
classifies into `blocking`/`improvements`/`discussions`/`testGaps`).
`outcome`: `"clean"` / `"actionable"` / `"needs-human"`. Full pipeline docs,
angle tables and cost profile: `server/skills/review/README.md`.

**External-fact validation (optional):** with `RESEARCH_GATEWAY_URL` +
`RESEARCH_GATEWAY_TOKEN` set, each angle prompt gets a bounded `curl` recipe
to validate an external library/API/version claim before filing it.

**Synthesis salvage:** the synthesizer occasionally emits prose instead of
schema JSON. It retries once with a JSON-only directive, then falls back to a
`needs-human` verdict preserving the raw text (`SessionResult.rawText`) — a
multi-minute run is never discarded as a bare parse error.

### Multimodal tools — direct IU OpenAI transport (synchronous)

`read_image` and `read_drawing` are **not** `runSession()` worker sessions
and **not** async jobs — plain `fetch` calls to the IU unified endpoint's
**OpenAI transport** (`/openai/v1/...`), stateless, single call well under
the 60s SDK timeout. Billed IU per-token, zero Max.

- Credentials (`server/lib/iu-openai.ts`): Keychain (`claude-sdk-api-key`,
  `claude-sdk-base-url`) or `IU_API_KEY`/`IU_BASE_URL` env; OpenAI base
  derived from the Anthropic base (`/anthropic` → `/openai/v1`).
- Model fixed at `gemini-3.5-flash` — a non-EU vendor, fine for
  git-committed/non-sensitive content, not PII.
- `read_image` — vision read of any image (SVGs rasterized first via headless
  Chrome, `server/lib/chrome.ts`).
- `read_drawing` — composite: rasterize+read the `.svg` AND deterministically
  parse the paired `.excalidraw` JSON, merged into one synthesis. Retires the
  dotfiles `/read-drawing` skill's `claude_iu` Haiku path.
- `generate_image` was retired 2026-07 in favor of the `image-gen` gateway.
- These bypass `session-runner`, so usage is logged separately:
  `~/.local/share/usage-tracker/sideclaw-iu.jsonl` (`recordIuUsage`), ingested
  by usage-tracker's `sideclaw-iu` collector. Reasoning tokens (Gemini bills
  thinking spend outside `completion_tokens`) are derived via
  `normalizeUsage`, not reported by the gateway — dropping this understated
  cost several-fold.

```bash
# Register at user scope — handled by `make setup` in ~/SourceRoot/dotfiles.
# Manual fallback:
claude mcp add --scope user sideclaw -- bun run "$HOME/SourceRoot/sideclaw/server/mcp.ts"

# Structured logs (both HTTP + MCP processes write here)
tail -f ~/Library/Logs/sideclaw.jsonl | jq .
tail -f ~/Library/Logs/sideclaw.jsonl | jq 'select(.source == "mcp")'
```

Inner sessions spawned by MCP tools use `claude -p` via `session-runner.ts`,
model and backend per tool from `server/lib/routing.ts` (`GET /api/routing`).
See `.claude/rules/mcp-tools.md` for authoring conventions.

## Git Workflow

Direct-to-master repo — no PRs, no releases.

```
/review   → optional code review before committing
/commit   → commit, then push to master directly
/ship     → review → commit → push (skips PR and release steps)
```

Never create feature branches or PRs for this repo.

## Project Skills

Project-specific skills live in `.claude/skills/` (tracked in git, unlike most repos).
Settings files (`.claude/settings.json`, `.claude/settings.local.json`) remain gitignored.

| Skill | Purpose |
|-|-|
| `claude-cli` | Reference for spawning `claude -p` subprocesses from Bun/TypeScript |
