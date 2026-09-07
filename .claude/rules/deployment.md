---
description: sideclaw deployment — LaunchAgent only, never standalone
---

# sideclaw Deployment Rule

sideclaw runs **exclusively via macOS LaunchAgent**. Never start the server
directly (`make dev`/`make start` exit with an error; `bun run dev`/`bun run
start`/`bun server/index.ts` conflict with the LaunchAgent's port 7705).

Use `make build` (frontend only), `make reload` (build + drain + restart,
`FORCE=1` while jobs are running), `make install-agent` / `make
uninstall-agent`. Logs: `~/Library/Logs/sideclaw.{log,err}` — never `/tmp`
(see `.claude/rules/logs.md`). Edit the tracked `com.jkrumm.sideclaw-server.plist`,
never the live one — `make install-agent` overwrites it verbatim.

The label `com.jkrumm.sideclaw-server` and the `scripts/sideclaw-start.sh`
wrapper both dodge a macOS Background Task Management denial that otherwise
skips `RunAtLoad` after a reboot — don't "simplify" either back. Full
forensic story: `docs/deployment.md`.
