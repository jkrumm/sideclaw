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

# Bootstrap the isolated CLAUDE_CONFIG_DIR used when sideclaw routes workers
# to the IU endpoint via ANTHROPIC_AUTH_TOKEN. A separate dir is required so
# the cached Max OAuth bearer in ~/.claude/ does not override env-based auth.
claude-offload:
	@mkdir -p $$HOME/.claude-offload
	@[ -f $$HOME/.claude-offload/settings.json ] || echo '{}' > $$HOME/.claude-offload/settings.json
	@echo "claude-offload ready at $$HOME/.claude-offload"

.PHONY: dev start build reload install-agent uninstall-agent claude-offload
