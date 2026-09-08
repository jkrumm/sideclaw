dev:
	@echo "ERROR: sideclaw runs via LaunchAgent only. Use 'make reload' to apply changes." && exit 1

start:
	@echo "ERROR: sideclaw runs via LaunchAgent only. Use 'make reload' to apply changes." && exit 1

build:
	bun run build

# Refuses while jobs are running unless FORCE=1 — a reload kills every worker session
# mid-flight (check/overview/narrative/review are re-queued once on boot; dispatch and
# excalidraw, and anything killed mid-drain regardless of tool, are left `running` for that
# same boot recovery to reconcile — server/jobs/store.ts's `execute()`).
#
# This target no longer SIGNALS the server — it POSTs to /api/shutdown (server/routes/
# shutdown.ts) and asks it to exit ITSELF. That distinction is load-bearing, not stylistic:
# launchd's ExitTimeOut is hard-capped at 60s on this host regardless of what the plist claims
# (measured 2026-09-08 — see the comment on that key in com.jkrumm.sideclaw-server.plist), so a
# real `launchctl kill SIGTERM` was always going to be SIGKILLed around the 60s mark no matter
# what the old 40-minute in-process drain window said — that window was fiction the whole time
# it was wired to a signal. A SELF-initiated exit never starts launchd's ExitTimeOut clock at
# all (only a signal launchd sent itself does), so it genuinely gets the long window
# (`HTTP_DRAIN_GRACE_MS`, server/lib/shutdown.ts, ~40 min) instead. KeepAlive restarts the
# process once it exits, same as any other exit. The old PID is still polled away below before
# `kickstart` runs — self-exit doesn't change that kickstart skips launchd's respawn throttle,
# so firing it while the old process is still draining would still land it on that process.
#
# FALLBACK: if the POST doesn't get a response (server hung, port dead, already crashed), this
# target falls back to `launchctl kill` — the OLD mechanism — rather than sitting there forever.
# That fallback hits the real SIGTERM/SIGINT handler in server/index.ts, which now uses the
# SHORT `SIGNAL_DRAIN_GRACE_MS` window (server/lib/shutdown.ts) precisely because THIS path is
# the one still bounded by launchd's real 60s cap — a hung server is already in a degraded state,
# and this fallback exists so it stays reloadable rather than a `make reload` that can no longer
# reach it silently hanging forever.
#
# The stdio MCP child is left alive by default — it's a thin HTTP client of the job queue, so
# stale handler code in it is harmless, and Claude Code marks a killed stdio server failed
# without respawning it. RESTART_MCP=1 make reload after a tool input/output schema change,
# because the SDK's Zod validation silently strips an unknown field until the client reconnects.
#
# Before any of that: refuses if the tracked plist differs from the one launchd actually has
# loaded, checked TWO ways — a file compare AND, separately, launchd's own live ExitTimeOut.
# `launchctl kill` (used only by the fallback above now, not the normal path) only signals the
# already-running job definition — it never re-reads a changed plist, only `launchctl bootstrap`
# (`make install-agent`) does. Neither check is theoretical: raising ExitTimeOut from 20
# (launchd's default) to 1860 in the tracked file did nothing on its own — `launchctl print
# gui/<uid>/com.jkrumm.sideclaw-server` kept reporting `exit timeout = 5` until `make
# install-agent` ran (a measurement from before the follow-up measurement above established
# that even a successfully-loaded ExitTimeOut is capped at 60 regardless). The FILE compare
# alone cannot catch a stale live value: `install-agent`'s `cp` runs before its `bootstrap`, so
# if bootstrap then fails (`launchctl bootstrap` errors on an already-loaded label — the normal
# case, since this service is loaded across restarts) the installed FILE is already in sync with
# the tracked one even though launchd's LIVE definition never moved — exactly the drift this
# file-only guard existed to catch, reachable through its own blind spot. `install-agent` now
# boots the current label out before re-bootstrapping (see below) so this should no longer
# happen, but the live check stays as the check that actually matters — comparing `plutil
# -convert json` output (not raw XML) so cosmetic/comment-only plist edits don't false-positive
# on the file half.
#
# FORCE=1 is not a faster version of "wait" — waiting is the normal path; measured 2026-09-08,
# 96% of real jobs outlive a short window, so FORCE=1 reliably discards in-flight work
# (recovered on the next boot exactly like a crash — see the reconciliation note above). It asks
# for the SAME forced abort the old SIGINT did (`POST /api/shutdown?force=1`, or the fallback's
# real SIGINT if the endpoint doesn't answer), never SIGKILL: SIGKILL is not catchable, so
# neither the HTTP trigger nor the SIGTERM/SIGINT handler in server/index.ts
# (server/lib/shutdown.ts's `createShutdownController`) would ever run, and without it
# `terminateActiveSessions()` never fires — a `claude -p` worker has no process group detachment
# and no parent-death signal, so it survives as an orphan that keeps writing/committing in its
# worktree after the reload believed it was gone. A forced abort that arrives while an unforced
# drain is already in progress (e.g. `FORCE=1 make reload` run against an already-draining
# server, or the fallback's SIGINT arriving mid-HTTP-drain) ESCALATES that drain to an immediate
# abort rather than being dropped — every worker is still terminated on the way out, exactly
# once. A killed dispatch leaves a worktree behind, which the boot sweep bundles to
# ~/.local/state/sideclaw/salvage/ before removing.
#
# The PID poll below has to outlast the drain: kickstart skips launchd's respawn throttle, so
# firing it while the old process is still draining lands it on that process. The true worst
# case is now HTTP_DRAIN_GRACE_MS + SHUTDOWN_FLUSH_MS (server/lib/shutdown.ts, ~40 min + 3s =
# 2403s) on the normal self-exit path — launchd's ExitTimeOut no longer bounds it at all, since
# nothing signals the process. The ceiling here (5520 half-seconds = 2760s) already carried
# comfortable slack past that number (it used to also need to outlast the plist's old 2700s
# ExitTimeOut, which is why it's this large) — tests/shutdown-window.test.ts pins it against
# HTTP_DRAIN_GRACE_MS+SHUTDOWN_FLUSH_MS now instead.
reload: build
	@tracked="com.jkrumm.sideclaw-server.plist"; \
	installed="$$HOME/Library/LaunchAgents/com.jkrumm.sideclaw-server.plist"; \
	if [ -f "$$installed" ]; then \
	  tracked_json=$$(plutil -convert json -o - "$$tracked" 2>/dev/null); \
	  installed_json=$$(plutil -convert json -o - "$$installed" 2>/dev/null); \
	  if [ -n "$$tracked_json" ] && [ "$$tracked_json" != "$$installed_json" ]; then \
	    echo "refusing to reload: $$tracked differs from the plist launchd has loaded ($$installed) — 'make reload' only signals the running job, it never re-reads the plist. Run 'make install-agent' first, then 'make reload'."; \
	    exit 1; \
	  fi; \
	fi
	@tracked_exit=$$(grep -A1 '<key>ExitTimeOut</key>' com.jkrumm.sideclaw-server.plist | grep -o '[0-9]\+'); \
	live_exit=$$(launchctl print gui/$$(id -u)/com.jkrumm.sideclaw-server 2>/dev/null | awk -F'= ' '/exit timeout = /{print $$2; exit}'); \
	if [ -n "$$tracked_exit" ] && [ -n "$$live_exit" ] && [ "$$tracked_exit" != "$$live_exit" ]; then \
	  echo "refusing to reload: launchd's LIVE ExitTimeOut ($${live_exit}s) does not match the tracked plist ($${tracked_exit}s) — 'launchctl bootstrap' never took (the file compare above cannot see this: see the comment above this target). Run 'make install-agent' first, then 'make reload'."; \
	  exit 1; \
	fi
	@if [ -z "$(FORCE)" ]; then \
	  n=$$(curl -sf --max-time 3 http://127.0.0.1:7705/api/jobs/health 2>/dev/null | jq -r '.running // 0' 2>/dev/null || echo 0); \
	  if [ "$${n:-0}" != "0" ]; then echo "refusing to reload: $$n job(s) running — waiting is normal (jobs commonly run minutes), or FORCE=1 make reload discards them"; exit 1; fi; \
	fi
	@if [ -n "$(RESTART_MCP)" ]; then \
	  pkill -f "sideclaw/server/mcp.ts" 2>/dev/null || true; \
	else \
	  echo "(MCP children left alive — RESTART_MCP=1 to restart them after a tool-schema change)"; \
	fi
	@old=$$(launchctl print gui/$$(id -u)/com.jkrumm.sideclaw-server 2>/dev/null | awk '/^[[:space:]]*pid = /{print $$3; exit}'); \
	shutdown_url="http://127.0.0.1:7705/api/shutdown$${FORCE:+?force=1}"; \
	if curl -sf --max-time 3 -X POST -H "X-Sideclaw-Shutdown: 1" "$$shutdown_url" >/dev/null 2>&1; then \
	  echo "  asked sideclaw to shut down itself (POST /api/shutdown$${FORCE:+?force=1})"; \
	else \
	  echo "  /api/shutdown did not respond — server may be hung; falling back to launchctl kill"; \
	  sig=$${FORCE:+SIGINT}; sig=$${sig:-SIGTERM}; \
	  launchctl kill $$sig gui/$$(id -u)/com.jkrumm.sideclaw-server 2>/dev/null || true; \
	fi; \
	i=0; while [ -n "$$old" ] && kill -0 "$$old" 2>/dev/null && [ $$i -lt 5520 ]; do \
	  if [ $$i -gt 0 ] && [ $$((i % 240)) -eq 0 ]; then echo "  still draining ($$((i / 2))s) — a job is finishing; ^C is safe, the drain continues"; fi; \
	  sleep 0.5; i=$$((i+1)); \
	done; \
	launchctl kickstart gui/$$(id -u)/com.jkrumm.sideclaw-server 2>/dev/null || true; \
	i=0; until curl -sf --max-time 2 http://127.0.0.1:7705/health >/dev/null 2>&1 || [ $$i -ge 40 ]; do sleep 0.5; i=$$((i+1)); done; \
	curl -sf --max-time 2 http://127.0.0.1:7705/health >/dev/null && echo "sideclaw reloaded" || { echo "sideclaw did not come back on :7705 — tail ~/Library/Logs/sideclaw.err"; exit 1; }

# The legacy `com.jkrumm.sideclaw` label is booted out and its plist removed first. Leaving it
# behind is not merely untidy: it is the label Background Task Management has denied, so a
# stale copy is a second agent racing for port 7705 that also cannot start at boot.
#
# The CURRENT label is booted out too, before the copy — not just the legacy one. Without this,
# `launchctl bootstrap` below fails on the (normal) case where the service is already loaded
# ("service already bootstrapped"), and because the `cp` above it already ran, the installed
# FILE ends up in sync with the tracked one even though launchd's LIVE definition never
# actually reloaded — silent to `reload`'s file-only drift guard, which this exact gap is what
# motivated adding the live ExitTimeOut check there too (see the comment on that target). No
# `|| true` on `bootstrap` itself: if it still fails after a clean bootout, that is a real
# problem (e.g. a plist syntax error) and this target must fail loudly, not swallow it.
#
# The OLD PID is captured and POLLED AWAY before `cp` + `bootstrap` run — `launchctl bootout` is
# a request, not a guaranteed-blocking wait, and if a job is running the old process can still
# be mid-drain (up to SIGNAL_DRAIN_GRACE_MS — this target signals the old process directly via
# `bootout`/`launchctl kill`, it never goes through POST /api/shutdown, so it's bounded by the
# short signal-side window, not HTTP_DRAIN_GRACE_MS) holding :7705 when `bootstrap` spawns the
# new instance via RunAtLoad. Racing the two means the new process's `app.listen()` fails to bind
# and it crash-loops — while every one of `bootout`/`cp`/`bootstrap` still exits 0, since none of
# them fail merely because a DIFFERENT process couldn't bind a port. Without the poll (and the
# health check at the end), this target reported "installed and started" regardless. Same ceiling
# as `reload`'s own poll (5520 half-seconds — see the comment on that target); the two are pinned
# together by tests/shutdown-window.test.ts's Makefile poll-ceiling check.
#
# Same job-in-flight guard as `reload`, for the same reason a plist fix is often urgent (e.g.
# the ExitTimeOut drift `reload`'s own comment describes) — FORCE=1 here means what it means
# there: skip the wait, send SIGINT (forced abort, not SIGKILL — see `reload`'s FORCE comment
# for why it must stay catchable) so the old process exits immediately instead of `bootout`
# relying on its own default (SIGTERM-equivalent) termination, and accept that any running job
# is abandoned for the next boot's crash recovery to pick up.
install-agent: build
	@launchctl bootout gui/$$(id -u)/com.jkrumm.sideclaw 2>/dev/null || true
	@rm -f ~/Library/LaunchAgents/com.jkrumm.sideclaw.plist
	@if [ -z "$(FORCE)" ]; then \
	  n=$$(curl -sf --max-time 3 http://127.0.0.1:7705/api/jobs/health 2>/dev/null | jq -r '.running // 0' 2>/dev/null || echo 0); \
	  if [ "$${n:-0}" != "0" ]; then echo "refusing to install-agent: $$n job(s) running — waiting is normal (jobs commonly run minutes), or FORCE=1 make install-agent discards them"; exit 1; fi; \
	fi
	@old=$$(launchctl print gui/$$(id -u)/com.jkrumm.sideclaw-server 2>/dev/null | awk '/^[[:space:]]*pid = /{print $$3; exit}'); \
	if [ -n "$(FORCE)" ] && [ -n "$$old" ]; then \
	  launchctl kill SIGINT gui/$$(id -u)/com.jkrumm.sideclaw-server 2>/dev/null || true; \
	fi; \
	launchctl bootout gui/$$(id -u)/com.jkrumm.sideclaw-server 2>/dev/null || true; \
	i=0; while [ -n "$$old" ] && kill -0 "$$old" 2>/dev/null && [ $$i -lt 5520 ]; do \
	  if [ $$i -gt 0 ] && [ $$((i % 240)) -eq 0 ]; then echo "  still draining ($$((i / 2))s) — a job is finishing; ^C is safe, the drain continues"; fi; \
	  sleep 0.5; i=$$((i+1)); \
	done
	cp com.jkrumm.sideclaw-server.plist ~/Library/LaunchAgents/
	launchctl bootstrap gui/$$(id -u) ~/Library/LaunchAgents/com.jkrumm.sideclaw-server.plist
	@i=0; until curl -sf --max-time 2 http://127.0.0.1:7705/health >/dev/null 2>&1 || [ $$i -ge 40 ]; do sleep 0.5; i=$$((i+1)); done; \
	curl -sf --max-time 2 http://127.0.0.1:7705/health >/dev/null && echo "sideclaw LaunchAgent installed and started" || { echo "sideclaw did not come back on :7705 after install — tail ~/Library/Logs/sideclaw.err"; exit 1; }

uninstall-agent:
	launchctl bootout gui/$$(id -u)/com.jkrumm.sideclaw-server
	rm ~/Library/LaunchAgents/com.jkrumm.sideclaw-server.plist
	@echo "sideclaw LaunchAgent removed"

.PHONY: dev start build reload install-agent uninstall-agent
