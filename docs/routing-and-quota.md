# Worker routing — backend selection and quota fallback

Full rationale behind `server/lib/routing.ts` and `resolveBackend`. CLAUDE.md
keeps the per-tool table and the top-level rule; this is the "why" — read on
demand when touching routing, quota or the fallback retry logic.

## Backends

**`iu`** injects `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` from
`getIuConfig()` (the IU unified endpoint's native Anthropic transport, metered
per token, serves Claude *and* gateway ids — a gateway id additionally gets
every `ANTHROPIC_DEFAULT_*_MODEL` pinned to itself, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`
from `GATEWAY_CONTEXT_TOKENS`, `API_TIMEOUT_MS` raised, mirroring dotfiles'
`ca`); **`max`** deletes those vars so the CLI falls through to the inherited
OAuth profile — Claude ids only, a gateway id is refused back to `iu` at
table-build time.

Overrides: `SIDECLAW_MODEL_<TOOL>=<id>`, `SIDECLAW_BACKEND_<TOOL>=iu|max`
(`<TOOL>` = route key upper-cased), read once at module load → `make reload`;
`SIDECLAW_WORKER_FALLBACK=none` pins every tool to its primary. A job's
`model` param (`overview`, `narrative`, `dispatch`) is applied with
`withModel` — a Claude override also becomes the fallback model, a gateway
override forces `iu`.

Every session writes a `session_env` line to `~/.claude/logs/<date>.jsonl`
with `base_url` (real on `iu`, explicit `null` on `max`), `model` and
`backend`, plus an attribution record to
`~/.local/share/usage-tracker/sideclaw-sessions.jsonl` carrying the same —
usage-tracker classifies by `base_url` present → `iu`, `null`/missing →
`max`, and bills the run to the model actually used.

## Fallback, both directions — once per session, never twice

`resolveBackend(route)` runs per launch: a non-Claude id → `iu`
unconditionally; an `iu` route → `iu` with no quota read; a `max` route with
an `iu` fallback reads live Max quota and calls the pure `chooseBackend({
configured: "max", model, quota, ceilingFiveHour, ceilingSevenDay, fallback
})` — `SIDECLAW_WORKER_FALLBACK=none` → stay; `quota.source: "unknown"` →
stay (never block on missing data); five-hour ≥ `SIDECLAW_MAX_QUOTA_CEILING`
(90) or seven-day ≥ `SIDECLAW_MAX_WEEKLY_CEILING` (95) → `iu`. The model id
never changes across this hop — only billing moves.

**Quota sources** (`server/lib/quota.ts`), cheapest first: the statusline's
own cache (`/tmp/claude_sl/usage_api.json`, written by dotfiles'
`fetch_usage.py` **whenever an interactive Claude Code session renders its
statusline** — statusline-driven, not a LaunchAgent, so it goes stale the
moment no interactive session is open; trusted for
`SIDECLAW_QUOTA_FILE_MAX_AGE_S`, default 600 s); else the live
`api.anthropic.com/api/oauth/usage`, bearer = the OAuth token Claude Code
keeps in the macOS Keychain (`Claude Code-credentials`), cached in-memory 60 s
(the endpoint 429s per-token — a failure returns the last good reading, never
blanks it). A locked keychain makes the API path return `source: "unknown"`,
which keeps the configured backend.

**Reactive retries in `runSession`**, both gated on the route's declared
`fallback` and on "no worker output yet" (`turnsRef.current === 0`), both
latched so the fallback attempt itself is never switched again:

- **`max` → `iu`**: a failure whose text `isQuotaError` recognizes (`hit your
  usage limit`, `rate limit`, a bare `429`, `overloaded`, `quota`) forces the
  next attempt onto `iu`, same model (`backend.fallback`, reason
  `rate-limited`). Takes precedence over the transient-transport retry.
- **`iu` → `max`**: a transport failure (`isRetryableSessionError`:
  429/502/503/504, connection errors) is first retried once on `iu` — a
  single 503 is the common case and must not spend Max quota — and if that
  fails the same way the next attempt runs on `max`, on `fallback.model` when
  the route fixes one (`check`/`overview` → Haiku, since glm cannot run on
  Max) or the same model (`backend.fallback`, reason `iu-unavailable`).
  Missing IU credentials (`iuConfigError`) and a **timeout with zero worker
  events** skip the same-backend retry and go straight to it; a session with
  `retryAfterOutput: true` (`check`, `overview` — no side effects to
  half-finish) treats **any** timeout that way (measured 2026-09-07:
  glm-5.3-flash gave overview's 10 KB prompt no event in 480 s, and another
  run stalled after 2 turns until the cap — so overview's cap is 2 min and
  the whole job stays ≈3 min with the Haiku lane). This is what keeps "IU
  down, Max fine" from being a dead lane.

`SessionResult.backend` and `.model` carry what actually ran;
`overview`/`narrative` job output carries `backend` too. Tests:
`tests/routing.test.ts` (table, overrides, `withModel`),
`tests/backend-select.test.ts` (`chooseBackend`'s full matrix, quota parsers,
`isQuotaError`), `tests/session-retry.test.ts` (`resolveBackend`'s IO-free
short circuits, retry classification).
