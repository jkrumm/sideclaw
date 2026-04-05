---
description: sideclaw deployment — LaunchAgent only, never standalone
---

# sideclaw Deployment Rule

sideclaw runs **exclusively via macOS LaunchAgent**. Never start the server directly.

## Forbidden commands

Do NOT suggest or run any of these:
- `make dev`
- `make start`
- `bun run dev`
- `bun run start`
- `bun server/index.ts`
- Any command that binds port 7705 or 7706 directly

All of the above either exit with an error (Makefile targets) or would conflict with the running LaunchAgent.

## Allowed commands

| Command | Purpose |
|-|-|
| `make build` | Build frontend to `dist/` (no server) |
| `make reload` | Build + kickstart LaunchAgent (use after code changes) |
| `make install-agent` | One-time install + start LaunchAgent |
| `make uninstall-agent` | Remove LaunchAgent |

## Validating changes

After `make reload`, check `http://sideclaw.local` in the browser.
Logs: `tail -f /tmp/sideclaw.log` / `tail -f /tmp/sideclaw.err`
