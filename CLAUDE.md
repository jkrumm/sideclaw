# sideclaw — Developer Notes

## Architecture

React frontend (Vite) + Bun/Elysia backend, running natively on the host.
Served on `http://sideclaw.local` (localias proxy → port 7705).

Bun loads `.env` automatically from the `sideclaw/` directory — all env vars
(`PERSONAL_REPOS_PATH`, `WORK_REPOS_PATH`, `GITHUB_TOKEN`) live there.

## Development

```bash
make dev    # Vite on :7705 (HMR) + API on :7706 — both via http://sideclaw.local
make build  # Build frontend to dist/
make start  # Prod: Elysia serves everything on :7705
```

**Dev:** Vite runs on :7705 and proxies `/api` to Elysia on :7706. Full HMR,
`sideclaw.local` works as-is. Server hot-reloads via `bun --watch`.

**Prod:** Elysia serves `dist/` + API on :7705 directly.

## Production (always-on)

```bash
make install-agent   # one-time: build + install + start LaunchAgent
make reload          # after code changes: build + kickstart
make uninstall-agent # remove LaunchAgent

tail -f /tmp/sideclaw.log   # stdout
tail -f /tmp/sideclaw.err   # stderr
```

The LaunchAgent starts automatically on login and restarts on crash.

## Fullscreen (kiosk mode)

The DiagramPanel fullscreen button tries the native browser Fullscreen API first.
In WebKit-based browsers (e.g. CMUX) that don't expose it, the frontend calls
`GET /api/open-kiosk?url=<current-url>` — the Elysia backend spawns Chrome with
`--kiosk --user-data-dir=/tmp/sideclaw-kiosk` on the host. Tries regular Chrome,
Chromium, then Playwright Chrome for Testing. Falls back to CSS focus mode if
no binary is found. **Exit kiosk:** `Cmd+Q`.

## Validating UI Changes

In dev: changes reflect immediately via Vite HMR at the dev server port.
In prod: `make build` + reload `http://sideclaw.local` in browser.
Use the Chrome MCP extension for visual validation via screenshots.

