# Worker routing — backend selection and fallback

Full rationale behind `server/lib/routing.ts` and `resolveBackend`. CLAUDE.md
keeps the per-tool table and the top-level rule; this is the "why" — read on
demand when touching routing or the fallback retry logic.

## Backends

**`iu`** injects `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` from
`getIuConfig()` (the IU unified endpoint's native Anthropic transport, metered
per token, serves Claude *and* gateway ids — a gateway id additionally gets
every `ANTHROPIC_DEFAULT_*_MODEL` pinned to itself, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`
from `GATEWAY_CONTEXT_TOKENS`, `API_TIMEOUT_MS` raised, mirroring dotfiles'
`ca`); **`max`** deletes those vars so the CLI falls through to the inherited
OAuth profile — Claude ids only, a gateway id is refused back to `iu` at
table-build time.

Three routes — `adversary`, `read_image`, `read_drawing` — never reach
`runSession()` at all: they call the IU OpenAI transport directly
(`server/lib/iu-openai.ts`) and consume only `.model`. Their `backend`/
`fallback` fields are informational defaults only (always `iu`, never
overridable). `GET /api/routing` marks them `transport: "iu-openai"` (every
other route is `transport: "session"`), and a `SIDECLAW_BACKEND_<TOOL>`
override on one of the three is refused rather than silently accepted and
displayed with no effect.

Overrides: `SIDECLAW_MODEL_<TOOL>=<id>`, `SIDECLAW_BACKEND_<TOOL>=iu|max`
(`<TOOL>` = route key upper-cased), read once at module load → `make reload`;
`SIDECLAW_WORKER_FALLBACK=none` pins every tool to its primary. A job's
`model` param (`overview`, `narrative`, `dispatch`) is applied with
`withModel` — a Claude override also becomes the fallback model, a gateway
override forces `iu`. The effective override list (applied + refused) is
logged once at startup by each entrypoint (`logRoutingOverrides` —
`info`, or `warn` if it contains a refusal) so a typo'd `.env` entry is
visible without curling `/api/routing`. The same entrypoints also call
`logStaleQuotaEnvVars`, a `warn` if a real `.env` still sets one of the three
retired quota env vars below (`SIDECLAW_MAX_QUOTA_CEILING`,
`SIDECLAW_MAX_WEEKLY_CEILING`, `SIDECLAW_QUOTA_FILE_MAX_AGE_S`) — they are a
silent no-op otherwise.

Every session writes a `session_env` line to `~/.claude/logs/<date>.jsonl`
with `base_url` (real on `iu`, explicit `null` on `max`), `model` and
`backend`, plus an attribution record to
`~/.local/share/usage-tracker/sideclaw-sessions.jsonl` carrying the same —
usage-tracker classifies by `base_url` present → `iu`, `null`/missing →
`max`, and bills the run to the model actually used.

## Fallback, both directions — once per session, never twice, purely reactive

`resolveBackend(route)` runs per launch, pure and synchronous: a non-Claude
id → `iu` unconditionally (defense in depth — `buildRoutingTable`/`withModel`
already guarantee this by construction for any route built through the
table, but a hand-built route bypassing it, as the tests do directly, must
still never slip a gateway id onto `max`); every other route just stays on
its configured backend.

This used to also read live Max subscription quota before every `max`
launch and pre-empt onto `iu` above a ceiling (90% five-hour / 95% seven-day,
via the statusline's cached usage file or the live Keychain-backed OAuth API).
**Removed 2026-09-08** — false-positive triggers off a stale/misread quota
reading, and every concurrent worker pre-empting at once under burst, cost
the owner more money and disruption than the quota it saved. Do not re-add a
proactive check here: the reactive fallback below is the actual safeguard and
is unchanged.

**Reactive retries in `runSession`**, both gated on the route's declared
`fallback` and on "no worker output yet" (`turnsRef.current === 0`), both
latched so the fallback attempt itself is never switched again:

- **`max` → `iu`**: an attempt classified as quota/rate-limit exhaustion
  forces the next attempt onto `iu`, same model (`backend.fallback`, reason
  `rate-limited`). Takes precedence over the transient-transport retry. Two
  signals feed the classification, checked in order:
  1. `SessionResult.hadApiRetry` — the runner observed a stream-json
     `system`/`api_retry` event during the attempt, i.e. the CLI itself
     retried after a provider-side 429/529. The truer signal when present,
     but not exhaustive on its own — a hard, definitive quota block the CLI
     never got a chance to retry produces no `api_retry` event at all, so it
     cannot be the only path.
  2. Otherwise, `isQuotaError` regex-matches `SessionResult.classificationText`
     — stderr and the runner's own constructed error text ONLY, **never**
     model-generated stdout. A worker's own output (a diff, an otel trace
     dump, a check report) can legitimately contain the words "429" or
     "quota" with no real exhaustion behind it; matching against it would
     switch a run that would have finished fine on the already-paid `max`
     subscription onto the metered, billed-per-token `iu` lane for nothing.
     `classificationText` is therefore populated only on the branches whose
     text is transport/provider-sourced (stderr, the constructed timeout/
     exit-code/no-envelope messages, `envelope.errors`) and left unset on the
     branches that embed real worker output (an unparseable `result` field, a
     schema-validation failure) — those can never quota-classify. The
     `is_error` branch is a narrow exception, not a third case: when
     `envelope.errors` is absent it falls back to `envelope.result`, but only
     when the session produced zero assistant turns (`classifyErrorEnvelope`)
     — with no turn at all the model never ran, so `result` cannot be its
     text and must be transport/gateway-sourced; at least one turn leaves it
     unset, same as the other worker-output branches. This is the one
     remaining diagnosis a terminal Max quota/usage-limit rejection carries
     when it arrives as `is_error` with no structured `errors` array and no
     observed `api_retry` — without it the reactive fallback cannot see that
     shape of quota exhaustion at all. See `runSessionAttempt` in
     `session-runner.ts` for exactly which branch sets which.
- A `backend: "max"` session that times out is never quota-classified by
  either signal above (its `classificationText` is a fixed string
  `QUOTA_ERROR_RE` never matches, and a hang produces no `api_retry` event).
  That gap is not resolved — a timeout carries no evidence either way — but
  is logged (`session.timeout_unclassified`, warn) so it is visible instead
  of silent.
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
`tests/routing.test.ts` (table, tiers, overrides, `withModel`,
`logRoutingOverrides`/`logStaleQuotaEnvVars` against a fake logger),
`tests/backend-select.test.ts` (`isQuotaError`'s regex matrix),
`tests/session-retry.test.ts` (`resolveBackend`'s pure short circuits,
`planNextAttempt`'s retry/fallback/classification decision including the
regression guard that model-output text alone never quota-classifies,
`classifyErrorEnvelope`'s zero-turn carve-out, `unclassifiedOutputFailure`'s
`hadApiRetry` propagation, `backendFallbacksLastHour`/`recordFallback`'s
1-hour window), `tests/jobs-health.test.ts` (`GET /api/jobs/health` carries
`backendFallbacks`).
