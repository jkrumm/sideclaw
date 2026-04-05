# sideclaw Structured Logs — /tmp/sideclaw.jsonl

NDJSON (one JSON object per line). Both the HTTP server (`source: "app"`) and the MCP server
(`source: "mcp"`) write to the same file. Level is a string (not a numeric code).

## Schema

| Field | Type | Description |
|-|-|-|
| `time` | string | ISO 8601 UTC — `"2026-04-05T12:34:56.789Z"` |
| `level` | string | `"debug"` \| `"info"` \| `"warn"` \| `"error"` |
| `msg` | string | Human-readable summary |
| `pid` | number | OS process ID |
| `source` | string | `"app"` (HTTP server) \| `"mcp"` (MCP process) |
| `event` | string? | Structured event type — see list below |
| `tool` | string? | MCP tool name: `"check"` |
| `project` | string? | Absolute cwd of target repo |
| `model` | string? | Claude model used in session |
| `durationMs` | number? | Execution duration in ms |
| `costUsd` | number? | Session cost from claude envelope |
| `turns` | number? | `num_turns` from claude envelope |
| `passed` | boolean? | Outcome for validation tools |
| `method` | string? | HTTP method |
| `path` | string? | URL path (no query string) |
| `status` | number? | HTTP response status code |
| `err` | object? | `{ type, message, stack }` — pino stdSerializers.err |

## Event types

| Event | Source | Description |
|-|-|-|
| `app.startup` | app | HTTP server started |
| `app.request` | app | HTTP request completed (not emitted for `/health`, `/api/build-id`) |
| `mcp.startup` | mcp | MCP server ready |
| `mcp.tool.start` | mcp | Tool invocation began |
| `mcp.tool.end` | mcp | Tool invocation completed (carries `passed`, `durationMs`) |
| `session.spawn` | mcp | `claude -p` subprocess started |
| `session.end` | mcp | Session completed successfully (carries `costUsd`, `turns`, `durationMs`) |
| `session.timeout` | mcp | Session hit timeout |
| `session.error` | mcp | Session returned `is_error` or produced no output |

## Query patterns

```bash
# Live tail (pretty)
tail -f /tmp/sideclaw.jsonl | jq .

# MCP logs only
tail -f /tmp/sideclaw.jsonl | jq 'select(.source == "mcp")'

# All MCP tool results
jq 'select(.event == "mcp.tool.end")' /tmp/sideclaw.jsonl

# Failed tool runs
jq 'select(.event == "mcp.tool.end" and .passed == false)' /tmp/sideclaw.jsonl

# Session cost by project
jq -s 'group_by(.project) | map({project: .[0].project, totalCostUsd: [.[].costUsd // 0] | add, runs: length})' \
  <(jq 'select(.event == "session.end")' /tmp/sideclaw.jsonl)

# Recent errors (last 50)
jq 'select(.level == "error")' /tmp/sideclaw.jsonl | tail -50 | jq .

# Slow HTTP requests (>500ms)
jq 'select(.event == "app.request" and .durationMs > 500)' /tmp/sideclaw.jsonl

# Model usage breakdown
jq -s 'group_by(.model) | map({model: .[0].model, count: length})' \
  <(jq 'select(.event == "session.end")' /tmp/sideclaw.jsonl)

# Today's entries
jq --arg d "$(date -u +%Y-%m-%d)" 'select(.time | startswith($d))' /tmp/sideclaw.jsonl
```
