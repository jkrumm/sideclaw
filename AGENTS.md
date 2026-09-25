# sideclaw — Agent Instructions

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
make reload          # After code changes: build + self-initiated drain (POST /api/shutdown, ≤50 min — launchd's real signal-and-wait timer never engages on this path) + restart. Refuses while jobs run — FORCE=1 discards them (force=1 request, or a real SIGINT), escalating an in-progress drain if one is running. Falls back to `launchctl kill` (short window, capped by launchd's measured 60s ExitTimeOut) if the endpoint doesn't answer. Also refuses on tracked/installed plist drift (file AND launchd's live state) — see docs/deployment.md § Two shutdown paths, two windows
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
surface — see `### agents, overview, narrative`. `otel` alone runs inline via
`runSession`, never as a job — no `jobId`, no `job_wait` — by decision:
`brain/wiki/engineering/model-routing.md`.

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

### CLI — the same jobs, without an MCP client

`bin/sideclaw.ts` (`make install-cli` → `~/.local/bin/sideclaw`) is a plain
HTTP client of the routes below — **no MCP layer**, so OpenCode, Codex, a
shell, a Makefile or cron can drive the same work Claude Code drives through
MCP:

```bash
sideclaw dispatch --repo warden --tier implement --workspace in-place 'the brief'
sideclaw check --repo sideclaw          # submit + wait, progress on stderr
sideclaw review --pr 42 --json          # stdout carries ONLY the result JSON
sideclaw jobs --running · status|wait|cancel <jobId> · routing · policy · health
```

`--no-wait` prints the jobId and exits; `--json` makes stdout machine-readable
(progress stays on stderr); `--timeout` is opt-in, the default wait has no
ceiling (`.claude/rules/agent-limits.md`). Exit codes: **0** done · **1**
failed/interrupted/cancelled · **2** usage error or `dispatch refused: …` ·
**3** server unreachable. Same policy, same queue, same concurrency cap as the
MCP door — the CLI adds no capability, only reach.

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
up to `HTTP_DRAIN_GRACE_MS` (~50 min, sized to the dominant single-attempt
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

**`POST /api/jobs/:id/cancel`** cancels one job — `pending` lands `cancelled`
immediately, `running` gets a best-effort SIGTERM (`terminateSessionsForJob`)
and lands `cancelled` once the worker exits, never `failed` and never counted
in `failedLastHour`; there is no MCP tool for this, only the HTTP route. The
`cancelled` value is a widened enum on `job_status`/`job_wait`'s output schema
too, so per the MCP-schema-change rule above, an already-connected client needs
an `/mcp` reconnect (or session restart) before it can poll a cancelled job
without its Zod validation silently stripping the field.

Job lifecycle events log to `~/Library/Logs/sideclaw.jsonl` (`job.create` /
`job.start` / `job.done` / `job.fail` / `job.cancelled` / `job.recover` /
`job.requeue` / `job.shutdown_abandoned`). Inspect the queue:
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
(DeepSeek-V4-Flash on IU / Haiku on Max). `GET /api/overview[.txt]` never runs the
LLM inline — it merges the latest **completed** job result onto a fresh
snapshot, and marks a recommendation `recommendationStale: true` if the agent
has been active since. Full reconciliation/fencing detail:
`docs/agent-overview-internals.md`.

The `narrative` job writes/revises one project's Obsidian vault page from
git log + session transcripts + `voice.md` — business terms, never a
changelog; `changed: false` with no page is a correct default answer, not a
failure. Model/backend from `routeFor("narrative")` (`claude-sonnet-5[1m]` on
Max first, IU as the reverse fallback — editorial judgment, not
classification, so no cheap tier). Caps
enforced in code (`clampSections`), never trusted from the model. Full input/
output contract and gathering rules: `docs/agent-overview-internals.md`.

Higher-order tools reuse capabilities at the **code level, not via MCP
recursion**: `review` angle workers can validate external library/API claims
against the standalone **research-gateway** (a bounded bearer-auth `curl`,
gated on `RESEARCH_GATEWAY_URL`/`RESEARCH_GATEWAY_TOKEN`) and self-validate
(`check` capability) — no nested jobs, no semaphore deadlock.

### Worker routing — `server/lib/routing.ts` is the only place a model or backend is decided

Every worker session (`runSession`) and the adversary text call take
`{ model, backend, fallback, thinkingTokens }` from one per-tool table;
nothing else hardcodes an id. Handlers pass `route: routeFor("<tool>")`, the
MCP tool descriptions print the same route under `MODEL:`, and **`GET
/api/routing`** shows the effective table plus every applied or refused
override.

Live table: **`GET /api/routing`**. Overrides: `SIDECLAW_MODEL_<TOOL>=<id>`,
`SIDECLAW_BACKEND_<TOOL>=iu|max`, `SIDECLAW_THINKING_TOKENS_<TOOL>=<n>` (read
once at module load → `make reload`). Full rationale — the tiers, the
reactive fallback, why the proactive quota-ceiling pre-check was removed
2026-09-08 and must not return: `brain/wiki/engineering/model-routing.md`.

**`thinkingTokens` governs a gateway model's reasoning budget on the IU leg**
— `--effort`, `reasoning_effort` and `thinking:{type:disabled}` are all
ignored by the Requesty hop, so `MAX_THINKING_TOKENS` (mapped by the CLI onto
Anthropic's `thinking.budget_tokens`) is the only control that reaches
DeepSeek-V4-Flash or DeepSeek-V4-Pro there. Unset means the model's own `max`
default, its worst setting. The CLASSIFY tier (check, overview,
review_router) runs at 2048; AGENT (dispatch's investigate/author) and
AGENT_IMPLEMENT (implement, DeepSeek-V4-Pro) at 8192 —
`server/lib/routing.ts`'s dated comments carry the ccbench/POC evidence.
**No route runs on GLM any more** (retired 2026-09-23, owner decision; the
`GLM_FLASH` id survives only so an env override naming it still resolves), so
every non-Claude lane here is DeepSeek. `session-runner.ts`'s `buildWorkerEnv` exports `MAX_THINKING_TOKENS`
only for non-Claude models — a Claude route's `thinkingTokens` (currently none
set) would be a no-op there anyway, since thinking on Claude is controlled a
different way. JUDGE/PROSE (review, otel, narrative, excalidraw) carry no
`thinkingTokens` — they stay on Claude.

**`dispatch`/`dispatch_implement` run on a second harness, OpenCode, not
`claude -p`** (2026-09-24, `harness: "opencode"` on `ToolRoute` — AGENT_OC/
AGENT_OC_IMPLEMENT — every other tool stays `"claude"`). `opencode run` talks
to `deepseek-v4.1-flash` over the IU endpoint's **OpenAI-compatible** route
(`iu/deepseek-v4.1-flash` — a different id and transport from the IU-native-
Anthropic `DeepSeek-V4-Flash`/`DeepSeek-V4-Pro` every other gateway route
uses; `claude -p` cannot reach it at all). Measured against DeepSeek-V4-Pro on
`claude -p` (three re-run implement briefs): ~40x cheaper, ~2-4x faster, a
blind diff review preferred it on 2 of 3, lost the third on inverted
volume-floor logic in a HyperDX config — not a clean sweep, and 95-98% cache
hit vs V4-Pro's 8%. `variant` (opencode's `--variant`, a reasoning-effort
knob) is `"high"` for investigate/author, `"max"` for implement — the same
higher-stakes-write-tier split AGENT_IMPLEMENT used to encode; opencode's
model/harness combination is validated AFTER every override
(`buildRoutingTable`'s cross-field pass, routing.ts) — a Claude model always
normalizes harness back to `claude`, and `deepseek-v4.1-flash` (only
reachable via opencode) with harness `claude` is refused rather than applied.
Overrides: `SIDECLAW_HARNESS_<TOOL>=claude|opencode`, `SIDECLAW_VARIANT_<TOOL>=<v>`
(a bare `SIDECLAW_HARNESS_DISPATCH=claude` is refused on its own — pair it
with a `SIDECLAW_MODEL_DISPATCH` override naming a Claude id). A fallback
attempt (the `iu`→`max` reverse lane) always runs `claude -p` regardless of
the primary's harness — Max only ever serves a Claude id. Implementation:
`server/mcp/opencode-runner.ts` (argv/config/env builders + the NDJSON event
mapper), invoked from `session-runner.ts`'s `runSessionAttempt` via
`resolveHarness()`. Its per-run config is passed as `OPENCODE_CONFIG_CONTENT`
(a JSON string env var), **never** `OPENCODE_CONFIG` (a file path) — measured
2026-09-24, a repo-local `opencode.json`/`opencode.jsonc` OVERRIDES
`OPENCODE_CONFIG`, but `OPENCODE_CONFIG_CONTENT` overrides the repo file, so
only the CONTENT form is a safe way to hand the worker its permission
profile. That profile sets every opencode `permission` key to `allow`/`deny`
explicitly — the default `ask` is auto-REJECTED in non-interactive `run`
mode and silently ends the session, so there is no "ask and it just works"
here, unlike an interactive opencode session. **Never `--pure`** — measured
2026-09-24 to hang.

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
a named repo, so it works with that repo's own `AGENTS.md`/`CLAUDE.md`/rules/skills in
context — for an observer (Hermes) that has the state but not agent-shaped
context. One episode, one verdict, no steering (mid-run redirection is
`rd bg` + `rd say`, not this).

**Tiers.** `investigate` (read-only → verdict), `author` (read-only → verdict
+ issue), `implement` (write → verdict + branch + **draft** PR). The artifact
follows the origin: a `github.com` remote gets the GitHub API path, a
`gitlab.com` remote gets `glab` (draft MR = "Draft: " title prefix, issues via
`glab api`); any other host is refused ~25 ms into the episode, before a
worktree exists.

**Workspace** (implement only): `worktree` (default) = the isolated-worktree
path above. `in-place` = the episode edits the repo's **live checkout**
directly; the handler creates no branch, no commit, no push, no PR and
resolves no GitHub identity — the result carries outcome `applied_in_place`
and `changedFiles` (uncommitted, for the owner to review and commit). Refused
for any tier but `implement` and for `sensitive: true`; at most one in-place
episode per repo at a time. What it gives up: no worktree isolation and no
settings strip (the repo's `.claude/settings.json` `env` **does** apply —
accepted for the owner's own audited repos; `disableAllHooks` still holds).
On the opencode harness specifically, in-place instead **refuses outright**
(`assertInPlaceOpencodeConfigAllowed`, dispatch.ts) when the live repo root
carries `opencode.json`/`opencode.jsonc`/`.opencode/` — a plugin there
executes code regardless of permissions, and there is no worktree to strip
it from first; worktree tiers still get the ordinary strip/restore.
What still holds: `GIT_DENY_CREDENTIALS_ENV`, the fence, the CI-path and
added-secret scans (a hit is a warning in the verdict, not a discard — nothing
is published), the repo's own `check` before the verdict (reported, never
gating). Pre-existing uncommitted work is snapshotted before the episode and
excluded from `changedFiles`; never reverted, stashed or committed by the
handler. Never auto-resumed on boot (`interrupted` instead) — no worktree to
reconstruct and no durable snapshot to attribute a re-run against.

**`sensitive`** opens `investigate` for secret-bearing repos (`dotfiles-private`,
`homelab-private`) — refused outright at any other tier, before a worktree
exists, since a filed issue or pushed branch has no safe artifact path there.
sideclaw derives sensitivity itself from the repo policy below and ORs it with
whatever the caller still declares — a caller may opt a policy-neutral repo
into the scan, but can no longer opt a policy-marked one out of it by omitting
the field. The verdict is scanned (`assertSensitiveTierAllowed` +
`applySensitiveScan`, `dispatch.ts`) before it leaves the machine; a match
withholds `summary`/`verdict`/`evidence` behind a notice and keeps the full
text in an owner-only `~/.local/state/sideclaw/private-verdicts/<jobId>.md`
(mode `0600`) instead. `readOnly: true` removes Edit/Write but **not**
`Bash`, and the brief is attacker-influenced — this scan is the actual
boundary for a sensitive episode, not the permission profile.

**Invariants** (full rationale + the mutation-verified test suite in
`docs/dispatch-security.md`):
- **Repo policy** (`server/lib/dispatch-policy.ts`, `GET /api/dispatch-policy`)
  gates every submission before it costs anything: `cwd` must resolve to a
  repo directly under a configured root, at or under that repo's tier
  ceiling. Only `dotfiles-private`/`homelab-private` (sensitive) and
  `brain`/`hermes-agent` default below `implement`; every other repo,
  including `sideclaw`, `warden` and `dotfiles` themselves, is
  `implement`-reachable by default. `SIDECLAW_DISPATCH_CEILINGS`/`_SENSITIVE`
  can only narrow, never widen, any repo's rule (marking a repo sensitive
  clamps its ceiling with it). **`SIDECLAW_DISPATCH_ROOTS` is the exception
  — it REPLACES the roots rather than narrowing them**, so a new tree there
  is dispatch-reachable at the permissive default. Checked in both
  `server/routes/jobs.ts` (at submit) and `runDispatch` (belt and suspenders
  for a direct caller) — it is a policy boundary on repo/tier, not a sandbox.
- Every tier runs in its own worktree, torn down in a `finally`; read tiers
  even in a repo with no working origin, since it's a detached copy of HEAD.
- Read tiers also materialize untracked/gitignored files (bounded, symlinks
  never followed) — the read exposure was never about copying files *in*.
- Boot sweeps every stale worktree/branch left by a SIGKILL.
- The artifact (issue/branch/PR, on the origin's forge) is created by the
  **handler**, never by the worker session — the session holds no forge
  credential.
- `GIT_DENY_CREDENTIALS_ENV` at every tier — this host's `~/.gitconfig`
  wires a credential helper any process can use, and a read-only session
  still has `Bash`.
- `--settings '{"disableAllHooks":true}'` on every claude-harness worker, and
  `.claude/settings{,.local}.json` **and** (2026-09-24, the opencode harness)
  `opencode.json`/`opencode.jsonc`/`.opencode/` are stripped from the
  throwaway worktree before the episode and restored **from the pinned base**
  after — an audited repo's hooks/`env`/plugins must never execute inside the
  episode.
- `implement` refuses `.github/workflows` diffs and added lines matching
  `SECRET_PATTERNS`; commits `--no-verify`; opens a **draft** PR (GitHub) or
  a "Draft: " MR (GitLab) against the forge-resolved `default_branch`. The
  repo's `check` runs before the push; a red
  format/lint/typecheck/test withholds the PR (`checks_failed`), a red
  `fallow` step alone never does — it audits whole touched files, so it rides
  along in the PR body as advisory instead.
- The brief is untrusted and fenced with per-run nonce delimiters, re-asserted
  after the data block.
- Salvage retries only a serialization failure (fresh session, no `--resume`)
  and marks it `degraded: true`; a real failure throws.

### Review — multi-angle pipeline

The `review` job (`server/jobs/handlers/review.ts`) runs a 3-phase parallel
pipeline: data gathering (git diff, `fallow review --brief` with a scope-derived
`--base` — `fallowBaseFor`, never `audit`'s auto-detected merge-base, which
is wrong on this direct-to-master repo for an already-pushed scope, CodeRabbit
CLI) → angle reviews (parallel claude-sonnet-5 sessions, capped at
`ANGLE_CONCURRENCY=3`: architect, senior-dev, + conditional
frontend/backend/typescript/QA, plus router-picked content angles
security/performance/concurrency/data-migration/api-contract/resilience
against an ISO 25010 checklist, plus a non-agentic `gpt-5.6-terra` adversary
critic) → synthesis (claude-sonnet-5, classifies into
`blocking`/`improvements`/`discussions`/`testGaps`). `outcome`: `"clean"` /
`"actionable"` / `"needs-human"`. Full pipeline docs, angle tables and cost
profile: `server/skills/review/README.md`.

**OpenCodeReview (OCR):** one more phase-1 input, started right after Phase 1
confirms real changes and awaited only just before the synthesis prompt is
built, so its ~2.5 minute wall time runs parallel with the router + angle
phases instead of adding in front of them (`server/lib/ocr.ts`, route
`review_ocr` — deepseek-v4.1-flash over IU's OpenAI route with `--effort low`,
picked by a same-range bake-off, rationale in `routing.ts`; per-token, off Max; no Max fallback,
since it's an external CLI, not a `runSession` worker). Fails soft to a
one-line skip/fail block the synthesizer reads like an unavailable
fallow/CodeRabbit — never a gate, never thrown into the review. Disable with
`SIDECLAW_REVIEW_OCR=0`. The IU key is handed to the third-party `ocr` binary
via env — accepted because its agent tools are read-only (file read/find/
search via `git`, no shell tool) and it reads LLM config only from env/
`~/.opencodereview`, never the repo; a repo's own `.opencodereview/rule.json`
can inject review-rule text into the prompt, not redirect the endpoint. OCR
also runs outside `ANGLE_CONCURRENCY` — one extra IU stream per review,
accepted.

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
- Model defaults to `gemini-3.5-flash` — a non-EU vendor, fine for
  git-committed/non-sensitive content, not PII — overridable via
  `SIDECLAW_MODEL_READ_IMAGE`/`SIDECLAW_MODEL_READ_DRAWING` like every other
  routed tool (`server/lib/routing.ts`); a `SIDECLAW_BACKEND_*` override is
  refused instead, since these run over the fixed `iu-openai` transport.
- `read_image` — vision read of any image (SVGs rasterized first via headless
  Chrome, `server/lib/chrome.ts`). Sampled at the provider's default
  temperature — no `temperature` on the wire, since the gateway 503s on a
  non-default value for the gpt-5.x family and VISION may be re-pointed there.
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
