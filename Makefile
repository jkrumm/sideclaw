dev:
	@echo "ERROR: sideclaw runs via LaunchAgent only. Use 'make reload' to apply changes." && exit 1

start:
	@echo "ERROR: sideclaw runs via LaunchAgent only. Use 'make reload' to apply changes." && exit 1

build:
	bun run build

# Refuses while jobs are running unless FORCE=1 — a reload kills every worker session
# mid-flight (check/overview/narrative/review are re-queued once on boot, dispatch and
# excalidraw are marked interrupted). SIGTERM rather than `kickstart -k`: the server drains
# running jobs for up to 20 s (server/index.ts) and exits; KeepAlive restarts it. The old
# PID is polled away first so the kickstart that skips launchd's respawn throttle never
# lands on the process that is still draining. The stdio MCP child is left alive by default —
# it's a thin HTTP client of the job queue, so stale handler code in it is harmless, and Claude
# Code marks a killed stdio server failed without respawning it. RESTART_MCP=1 make reload
# after a tool input/output schema change, because the SDK's Zod validation silently strips an
# unknown field until the client reconnects.
reload: build
	@if [ -z "$(FORCE)" ]; then \
	  n=$$(curl -sf --max-time 3 http://127.0.0.1:7705/api/jobs/health 2>/dev/null | jq -r '.running // 0' 2>/dev/null || echo 0); \
	  if [ "$${n:-0}" != "0" ]; then echo "refusing to reload: $$n job(s) running — wait, or FORCE=1 make reload"; exit 1; fi; \
	fi
	@if [ -n "$(RESTART_MCP)" ]; then \
	  pkill -f "sideclaw/server/mcp.ts" 2>/dev/null || true; \
	else \
	  echo "(MCP children left alive — RESTART_MCP=1 to restart them after a tool-schema change)"; \
	fi
	@old=$$(launchctl print gui/$$(id -u)/com.jkrumm.sideclaw-server 2>/dev/null | awk '/^[[:space:]]*pid = /{print $$3; exit}'); \
	launchctl kill SIGTERM gui/$$(id -u)/com.jkrumm.sideclaw-server 2>/dev/null || true; \
	i=0; while [ -n "$$old" ] && kill -0 "$$old" 2>/dev/null && [ $$i -lt 50 ]; do sleep 0.5; i=$$((i+1)); done; \
	launchctl kickstart gui/$$(id -u)/com.jkrumm.sideclaw-server 2>/dev/null || true; \
	i=0; until curl -sf --max-time 2 http://127.0.0.1:7705/health >/dev/null 2>&1 || [ $$i -ge 40 ]; do sleep 0.5; i=$$((i+1)); done; \
	curl -sf --max-time 2 http://127.0.0.1:7705/health >/dev/null && echo "sideclaw reloaded" || { echo "sideclaw did not come back on :7705 — tail ~/Library/Logs/sideclaw.err"; exit 1; }

# The legacy `com.jkrumm.sideclaw` label is booted out and its plist removed
# first. Leaving it behind is not merely untidy: it is the label Background
# Task Management has denied, so a stale copy is a second agent racing for
# port 7705 that also cannot start at boot.
install-agent: build
	@launchctl bootout gui/$$(id -u)/com.jkrumm.sideclaw 2>/dev/null || true
	@rm -f ~/Library/LaunchAgents/com.jkrumm.sideclaw.plist
	cp com.jkrumm.sideclaw-server.plist ~/Library/LaunchAgents/
	launchctl bootstrap gui/$$(id -u) ~/Library/LaunchAgents/com.jkrumm.sideclaw-server.plist
	@echo "sideclaw LaunchAgent installed and started"

uninstall-agent:
	launchctl bootout gui/$$(id -u)/com.jkrumm.sideclaw-server
	rm ~/Library/LaunchAgents/com.jkrumm.sideclaw-server.plist
	@echo "sideclaw LaunchAgent removed"

.PHONY: dev start build reload install-agent uninstall-agent
