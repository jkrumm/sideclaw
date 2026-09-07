# sideclaw Structured Logs

NDJSON at `~/Library/Logs/sideclaw.jsonl` — never `/tmp` (macOS sweeps
untouched `/tmp` files after 3+ days; a KeepAlive agent's fd survives the
sweep into an unlinked inode). Both the HTTP server (`source: "app"`) and the
MCP process (`source: "mcp"`) write here.

Quick filter: `jq 'select(.event == "mcp.tool.end")' ~/Library/Logs/sideclaw.jsonl`.
Full field/event schema and query patterns: `docs/logging.md`.
