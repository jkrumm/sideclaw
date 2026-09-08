# Frontend UI — kiosk mode, reaching the dashboard

The React dashboard (`src/`) is a secondary surface — the MCP tools and the
job queue are the primary interface. This covers the parts of the UI that
aren't self-evident from the component tree.

## Reaching the dashboard

Bind is loopback-only (`server/index.ts`). Reach it via Caddy's
`sideclaw.test` block (`dotfiles/config/Caddyfile`) — locally only. There is
**deliberately no tailnet door**: `~/.config/caddy-tailnet.ports` carries an
explicit `exclude sideclaw`, because the job API has no auth and a tailnet
twin would let any tag:mac/phone/tablet node `POST /api/jobs` with `dispatch
implement`. Don't add a `sideclaw.mini.jkrumm.com` block to "fix" that — it's
the gap the exclusion exists to keep closed. A few source files still name
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
