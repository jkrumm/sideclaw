dev:
	@echo "ERROR: sideclaw runs via LaunchAgent only. Use 'make reload' to apply changes." && exit 1

start:
	@echo "ERROR: sideclaw runs via LaunchAgent only. Use 'make reload' to apply changes." && exit 1

build:
	bun run build

reload: build
	@pkill -f "sideclaw/server/mcp.ts" 2>/dev/null || true
	launchctl kickstart -k gui/$$(id -u)/com.jkrumm.sideclaw-server
	@echo "sideclaw reloaded"

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
