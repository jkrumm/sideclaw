dev:
	@echo "ERROR: sideclaw runs via LaunchAgent only. Use 'make reload' to apply changes." && exit 1

start:
	@echo "ERROR: sideclaw runs via LaunchAgent only. Use 'make reload' to apply changes." && exit 1

build:
	bun run build

reload: build
	@pkill -f "sideclaw/server/mcp.ts" 2>/dev/null || true
	launchctl kickstart -k gui/$$(id -u)/com.jkrumm.sideclaw
	@echo "sideclaw reloaded"

install-agent: build
	cp com.jkrumm.sideclaw.plist ~/Library/LaunchAgents/
	launchctl load ~/Library/LaunchAgents/com.jkrumm.sideclaw.plist
	@echo "sideclaw LaunchAgent installed and started"

uninstall-agent:
	launchctl unload ~/Library/LaunchAgents/com.jkrumm.sideclaw.plist
	rm ~/Library/LaunchAgents/com.jkrumm.sideclaw.plist
	@echo "sideclaw LaunchAgent removed"

.PHONY: dev start build reload install-agent uninstall-agent
