# Frontend UI — GitHub caching, GitPanel, kiosk mode

The React dashboard (`src/`) is a secondary surface — the MCP tools and the
job queue are the primary interface. This covers the parts of the UI that
aren't self-evident from the component tree.

## GitHub API caching

All Octokit calls go through an ETag + soft-TTL cache installed as request
hooks (`server/lib/github-cache.ts`). Two layers:

1. **Soft-TTL fan-out (10s default, 5min for `/contents/`)** — repeat
   requests within the window return cached data without touching GitHub.
2. **ETag revalidation** — past soft-TTL, `If-None-Match` is sent; 304
   responses are converted back to cached payloads (free against the primary
   5,000/hr rate limit).

Cache keys are the fully resolved request URL (`octokit.request.endpoint()`),
so per-repo isolation is enforced. Frontend polling (`GitPanel.tsx`) runs at
30s and pauses while the tab is hidden. Observe via
`jq 'select(.event | startswith("github.cache"))' ~/Library/Logs/sideclaw.jsonl`.

## Enabling the GitPanel

The git surface is **off by default** — opt in per `.env`.

Set `SIDECLAW_GIT_ENABLED=true` + `VITE_SIDECLAW_GIT_ENABLED=true` in `.env`
to turn on the whole git surface — GitPanel renders, `/api/repo/git` and
`/api/github` return live data, and `/api/actions/{chain,git}` are active.
Left unset, the git surface stays off (`data: null`, actions return 503),
which avoids GitHub rate-limit pressure.

## Reaching the dashboard

Bind is loopback-only (`server/index.ts`). Reach it via Caddy's
`sideclaw.test` block (`dotfiles/config/Caddyfile`) or, from another tailnet
device, `https://sideclaw.mini.jkrumm.com`. A few source files still name
`http://sideclaw.local`/allow it as a host (`vite.config.ts`, `kiosk.ts`,
`excalidraw-hydrate.ts`) — that was a localias-proxy convention; localias
isn't installed on this host, so treat `.local` as legacy and unreachable,
not as the real door.

## Fullscreen (kiosk mode)

The DiagramPanel fullscreen button tries the native browser Fullscreen API
first. In WebKit-based browsers (e.g. CMUX) that don't expose it, the
frontend calls `GET /api/open-kiosk?url=<current-url>` — the Elysia backend
spawns Chrome with `--kiosk --user-data-dir=/tmp/sideclaw-kiosk` on the host.
Tries regular Chrome, Chromium, then Playwright Chrome for Testing. Falls
back to CSS focus mode if no binary is found. **Exit kiosk:** `Cmd+Q`.

## Validating UI changes

In dev: changes reflect immediately via Vite HMR at the dev server port. In
prod: `make build` + reload the dashboard in browser. For automated visual
validation (console/network/DOM/screenshots), use the dotfiles `/browse`
skill (chrome-devtools MCP, deferred, haiku subagent) rather than driving
chrome-devtools directly in this session.
