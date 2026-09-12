# sideclaw Structured Logs — ~/Library/Logs/sideclaw.jsonl

NDJSON (one JSON object per line). Both the HTTP server (`source: "app"`) and the MCP server
(`source: "mcp"`) write to the same file. Level is a string (not a numeric code).

## Schema

| Field        | Type     | Description                                          |
| ------------ | -------- | ---------------------------------------------------- |
| `time`       | string   | ISO 8601 UTC — `"2026-04-05T12:34:56.789Z"`          |
| `level`      | string   | `"debug"` \| `"info"` \| `"warn"` \| `"error"`       |
| `msg`        | string   | Human-readable summary                               |
| `pid`        | number   | OS process ID                                        |
| `source`     | string   | `"app"` (HTTP server) \| `"mcp"` (MCP process)       |
| `event`      | string?  | Structured event type — see list below               |
| `tool`       | string?  | MCP tool name: `"check"`                             |
| `jobId`      | string?  | Async job id (`jobs/store.ts`) the session ran inside, when it ran inside one — see `session.*` events |
| `project`    | string?  | Absolute cwd of target repo                          |
| `model`      | string?  | Claude model used in session                         |
| `backend`    | string?  | Worker auth path: `"iu"` \| `"max"` — see `backend.select`/`backend.fallback` |
| `durationMs` | number?  | Execution duration in ms                             |
| `costUsd`    | number?  | Session cost from claude envelope                    |
| `turns`      | number?  | `num_turns` from claude envelope                     |
| `passed`     | boolean? | Outcome for validation tools                         |
| `method`     | string?  | HTTP method                                          |
| `path`       | string?  | URL path (no query string)                           |
| `status`     | number?  | HTTP response status code                            |
| `err`        | object?  | `{ type, message, stack }` — pino stdSerializers.err |

## Event types

| Event                      | Source  | Description                                                                                                                                           |
| -------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.startup`              | app     | HTTP server started                                                                                                                                   |
| `app.request`              | app     | HTTP request completed (not emitted for `/health`, `/api/build-id`)                                                                                   |
| `mcp.startup`              | mcp     | MCP server ready                                                                                                                                      |
| `mcp.tool.start`           | mcp     | Tool invocation began                                                                                                                                 |
| `mcp.tool.end`             | mcp     | Tool invocation completed (carries `passed`, `durationMs`)                                                                                            |
| `session.spawn`            | mcp/app | `claude -p` subprocess started                                                                                                                        |
| `session.end`              | mcp/app | Session completed successfully (carries `costUsd`, `turns`, `durationMs`)                                                                             |
| `session.timeout`          | mcp/app | Idle watchdog killed a session — no stdout for `IDLE_TIMEOUT_MS` (no separate turn/wall-clock ceiling; carries `tool`, `model`, `backend`, `jobId`, `killReason`, `idleMsAtKill`)                                                                        |
| `session.timeout_unclassified` | mcp/app | **warn.** A `backend: "max"` session timed out with no quota-classification signal (no `api_retry` event, and a timeout's `classificationText` never regex-matches) — a Max quota exhaustion surfacing as a hang is invisible to the reactive fallback; visibility only, nothing acts on it (carries `tool`, `model`, `backend`, `jobId`, `turns`) |
| `session.error`            | mcp/app | Session returned `is_error` or produced no output (carries `tool`, `model`, `backend`, `jobId`)                                                       |
| `session.recovered_output` | mcp/app | `result` field was empty; JSON recovered from the last assistant text (worker ended on a tool call; carries `tool`, `model`, `backend`, `jobId`)      |
| `github.cache.hit`         | app     | Octokit request served from cache (carries `kind: "soft" \| "304"`, `url`)                                                                            |
| `github.cache.miss`        | app     | Octokit response stored to cache (carries `url`, `status`)                                                                                            |
| `job.create`               | app     | Async job submitted (carries `jobId`, `tool`)                                                                                                         |
| `job.start`                | app     | Job promoted from pending to running (carries `jobId`, `tool`, `running`, `pending`, `max`)                                                           |
| `job.done`                 | app     | Job finished successfully (carries `jobId`, `tool`, `durationMs`)                                                                                     |
| `job.fail`                 | app     | Job handler threw (carries `jobId`, `tool`, `durationMs`, `error`)                                                                                    |
| `job.cancel_requested`     | app     | `POST /api/jobs/:id/cancel` on a `running` job — flagged and SIGTERMed, transition to `cancelled` not yet landed (carries `jobId`, `tool`)              |
| `job.cancelled`            | app     | Job reached `cancelled` — immediately for a `pending` cancel, or once a `running` job's SIGTERMed worker throws (carries `jobId`, `tool`, `durationMs`, `error: "cancelled by request"`); never counted in `failedLastHour`                        |
| `job.recover`              | app     | Startup reconciliation (carries `interrupted`, `requeued`)                                                                                            |
| `mcp.tool.submit`          | mcp     | Thin MCP tool submitted a job to the HTTP server (carries `tool`, `jobId`, `status`)                                                                  |
| `routing.overrides`        | mcp/app | Logged once at startup when `SIDECLAW_MODEL_*`/`SIDECLAW_BACKEND_*` overrides are in effect — **warn** if any was refused, info otherwise (carries `overrides`, the full applied/refused list from `GET /api/routing`) |
| `routing.stale_env`        | mcp/app | **warn.** Logged once at startup if `SIDECLAW_MAX_QUOTA_CEILING`/`SIDECLAW_MAX_WEEKLY_CEILING`/`SIDECLAW_QUOTA_FILE_MAX_AGE_S` is still set in `.env` — these fed the proactive Max-quota pre-check removed 2026-09-08 and are now a silent no-op (carries `vars`, the subset that's set) |
| `backend.select`           | mcp/app | Worker auth backend resolved for a session launch (carries `tool`, `model`, `backend`, `jobId`, `reason`: `"non-claude-model"` \| `"ok"`)  |
| `backend.fallback`         | mcp/app | Reactive once-only retry from `max` onto `iu` after a quota-flavored failure (carries `tool`, `model`, `backend: "iu"`, `jobId`, `reason: "rate-limited"`)     |
| `backend.fallback` (`iu-unavailable`) | mcp/app | Reactive once-only retry from `iu` onto `max` after an IU transport failure or missing IU credentials (carries `tool`, `model` — the fallback model, e.g. Haiku for check — `backend: "max"`, `jobId`)  |
| `session.stderr`           | mcp/app | Worker stderr; **warn** when the session failed (timeout, non-zero exit, `is_error`), debug otherwise (carries `tool`, `model`, `backend`, `jobId`, `exitCode`, `stderr` ≤4 KB) |
| `session.retry`            | mcp/app | Transient transport error before any output — retrying (carries `tool`, `model`, `jobId`, `attempt`, `error`)                                            |
| `check.retry`              | app     | `check` output was prose, not schema JSON — one JSON-only retry (carries `project`, `error`)                                                              |
| `job.requeue`              | app     | Boot recovery re-queued an interrupted check/overview/narrative/review once (carries `jobId`, `tool`, `attempts`)                                        |
| `app.argo_push`            | app     | Overview pushed to Argo (carries `status`: `ok` \| `no-secret` \| `http-error` \| `network-error` \| `build-error`, `trigger`: `job` \| `timer`, `httpStatus`) |
| `app.shutdown` (begin)     | app     | A graceful drain or forced abort started (carries `running`, `workers`, `graceMs`, `forced`, `origin`) — `origin: "signal"` means a real SIGTERM/SIGINT, `origin: "http"` means a self-initiated `POST /api/shutdown` (`make reload`'s normal path); `forced: true` distinguishes a deliberate FORCE abort from a real crash |
| `app.shutdown` (escalate)  | app     | A forced request (real SIGINT, or `force=1`/`force=true` over HTTP) arrived while a graceful drain was already in progress and shortened it to an immediate abort (carries `escalate: true`, `origin` — no `running`/`workers`/`graceMs`, distinct from the begin/finish shapes above and below) |
| `app.shutdown` (shortened) | app     | A real signal (`origin: "signal"`) landed on an already-running graceful drain (typically an http-origin one) and pulled its deadline in to the signal-safe window instead of leaving it uncapped under launchd's real `ExitTimeOut` clock (carries `shortened: true`, `origin: "signal"`, `graceMs`) |
| `app.shutdown` (finish)    | app     | The drain concluded — fully drained, grace period exhausted, or a forced/escalated abort (carries `running`, `killedWorkers`, `flushMs`, `forced`, `origin` — the origin most recently responsible for the drain's outcome, e.g. `"signal"` if a real signal later shortened or escalated an http-origin drain) |
| `job.shutdown_abandoned`   | app     | A job's worker was one `terminateActiveSessions()` actually SIGTERMed this drain — its row is left `running` for the next boot's crash recovery rather than written `failed` (carries `jobId`, `tool`, `error`); an unrelated failure landing in the same drain window is NOT logged here — it goes through the normal `job.fail` path |
| `dispatch.worktree_salvaged`        | app     | A discarded dispatch worktree's dirty tree and/or unpushed commits were bundled before teardown (carries `branch`, `path`, `bytes`, `orphanCommits`, `dirty`) — see `docs/dispatch-security.md` § Worktree salvage |
| `dispatch.worktree_salvage_failed`  | app     | Worktree salvage attempt failed or produced nothing usable; teardown proceeds regardless (carries `branch`, `error`)                                     |

## Query patterns

```bash
# Live tail (pretty)
tail -f ~/Library/Logs/sideclaw.jsonl | jq .

# MCP logs only
tail -f ~/Library/Logs/sideclaw.jsonl | jq 'select(.source == "mcp")'

# All MCP tool results
jq 'select(.event == "mcp.tool.end")' ~/Library/Logs/sideclaw.jsonl

# Failed tool runs
jq 'select(.event == "mcp.tool.end" and .passed == false)' ~/Library/Logs/sideclaw.jsonl

# Session cost by project
jq -s 'group_by(.project) | map({project: .[0].project, totalCostUsd: [.[].costUsd // 0] | add, runs: length})' \
  <(jq 'select(.event == "session.end")' ~/Library/Logs/sideclaw.jsonl)

# Recent errors (last 50)
jq 'select(.level == "error")' ~/Library/Logs/sideclaw.jsonl | tail -50 | jq .

# Slow HTTP requests (>500ms)
jq 'select(.event == "app.request" and .durationMs > 500)' ~/Library/Logs/sideclaw.jsonl

# Job duration by tool (p50/p95/max) — no jobId join needed once job.done/job.fail carry it
jq -s 'group_by(.tool) | map({tool: .[0].tool, n: length, durations: (map(.durationMs) | sort)})' \
  <(jq 'select(.event == "job.done" or .event == "job.fail")' ~/Library/Logs/sideclaw.jsonl)

# Model usage breakdown
jq -s 'group_by(.model) | map({model: .[0].model, count: length})' \
  <(jq 'select(.event == "session.end")' ~/Library/Logs/sideclaw.jsonl)

# Today's entries
jq --arg d "$(date -u +%Y-%m-%d)" 'select(.time | startswith($d))' ~/Library/Logs/sideclaw.jsonl
```
