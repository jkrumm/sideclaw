# sideclaw

Local Claude Code offload daemon for the Mac mini: an always-on HTTP server (`:7705`,
loopback only, LaunchAgent `com.jkrumm.sideclaw-server`) that hosts a durable job queue,
plus an MCP stdio server (`server/mcp.ts`) that every Claude Code session spawns to submit
work to it. Tools: `check`, `review`, `dispatch`, `overview`, `narrative`, `otel`,
`read_image`, `read_drawing`, `excalidraw_diagram`, `job_status`/`job_wait`. Each long tool
runs as a background job in a `claude -p` worker session on the model and backend the
routing table assigns it. Mini-only by design — see the dotfiles global CLAUDE.md.

## Install / reload

```bash
make install-agent   # one-time: build + install + start the LaunchAgent
make reload          # after code changes: build, self-initiated drain via POST /api/shutdown (≤50 min), restart — falls back to `launchctl kill` if the endpoint doesn't answer
FORCE=1 make reload  # forced abort now, discarding running jobs (read-only ones are re-queued once on boot)
make build           # frontend only
```

`make reload`'s normal drain is long (~50 min) because it's self-initiated — launchd's own
`ExitTimeOut` (60s, its measured hard cap regardless of the plist) never engages on that path.
Only a real signal (reboot, logout, or the fallback above) is bound by that 60s cap. Full story:
`docs/deployment.md` § Two shutdown paths, two windows.

Never start the server by hand (`bun server/index.ts`) — the LaunchAgent owns the port.
The MCP server is registered at user scope by dotfiles' `make setup`
(`claude mcp add --scope user sideclaw -- bun run ~/SourceRoot/sideclaw/server/mcp.ts`).
A tool **schema** change needs an MCP reconnect (`/mcp`), not just `make reload`.
A **plist** change (`com.jkrumm.sideclaw-server.plist`) needs `make install-agent`
(`launchctl bootstrap`) — `make reload` only signals the already-loaded job definition and
refuses if it detects the tracked plist has drifted from the installed one.

## Endpoints

| Route | Purpose |
|-|-|
| `GET /health` | liveness |
| `GET /api/routing` | effective per-tool model/backend table + applied/refused/implied overrides |
| `POST /api/jobs` · `GET /api/jobs[/:id]` | submit / list / poll jobs |
| `POST /api/jobs/:id/cancel` | cancel one job — `pending` lands `cancelled` immediately, `running` gets a best-effort SIGTERM and lands `cancelled` once the worker exits; 404 unknown id, 409 already terminal |
| `GET /api/jobs/health` | queue health for monitoring (`ok` false on ≥3 failures/h or a >15 min pending job) |
| `GET /api/agents[.txt]` | deterministic agent snapshot (no LLM), incl. `humanQueue` |
| `GET /api/overview[.txt]` | snapshot + the latest `overview` job's recommendations; `.txt` takes `?color=1&cols=N` |
| `GET /api/dispatch-policy` | effective repo allowlist/tier ceilings the `dispatch` job is gated on |
| `GET /api/dispatch-schema` | JSON schema the `dispatch` job's worker output must validate against, per tier |
| `POST /api/shutdown[?force=1]` | self-initiated graceful shutdown — what `make reload` calls instead of signaling the process; responds immediately with `{ running }`, drains asynchronously |

Logs: `~/Library/Logs/sideclaw.jsonl` (structured, both processes), `sideclaw.{log,err}` (stdio).

## `.env` keys

| Key | Purpose |
|-|-|
| `PERSONAL_REPOS_PATH`, `WORK_REPOS_PATH` | repo roots for the dashboard |
| `GITHUB_TOKEN` | fallback GitHub credential for `dispatch` artifacts (primary is `secrets-run read op://mini/github/token`) |
| `RESEARCH_GATEWAY_URL`, `RESEARCH_GATEWAY_TOKEN` | lets review angle workers validate external claims |
| `SIDECLAW_MODEL_<TOOL>`, `SIDECLAW_BACKEND_<TOOL>` | per-tool routing override (`iu` \| `max`); a gateway id never lands on `max`, and a backend override on `adversary`/`read_image`/`read_drawing` (fixed `iu-openai` transport) is refused |
| `SIDECLAW_WORKER_FALLBACK=none` | disable both fallback directions |
| `SIDECLAW_JOB_CONCURRENCY` (3) | running-job cap |
| `SIDECLAW_AGENT_STALE_HOURS` (24) | agent snapshot stale threshold |
| `ARGO_URL` | Argo API base for the overview push (default `https://argo.jkrumm.com/api`) |

The HTTP server gets `.env` from Bun's cwd auto-load; the MCP process reads the same file
through `server/lib/load-env.ts`. Every routing/backend flag is read at module load —
`make reload` applies it.

## Routing

`server/lib/routing.ts` is the single table (check/overview on `glm-5.3-flash` over IU,
review/dispatch/otel on `claude-sonnet-5[1m]` over Max with a reactive fallback, …) and
`GET /api/routing` shows what is live. Full rationale, fallback rules and every other
mechanism: `CLAUDE.md`.

## Develop

```bash
bun test              # 26 files, no network, no model calls
bun run lint          # oxlint
bun run format:check  # oxfmt
```
