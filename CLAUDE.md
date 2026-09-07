# sideclaw — Developer Notes

## Architecture

React frontend (Vite) + Bun/Elysia backend, running natively on the host.
Served on `http://sideclaw.local` (localias proxy → port 7705).

Bun loads `.env` automatically from the `sideclaw/` directory — all env vars
(`PERSONAL_REPOS_PATH`, `WORK_REPOS_PATH`, `GITHUB_TOKEN`) live there.

### GitHub API caching

All Octokit calls go through an ETag + soft-TTL cache installed as request
hooks (`server/lib/github-cache.ts`). Two layers:

1. **Soft-TTL fan-out (10s default, 5min for `/contents/`)** — repeat
   requests within the window return cached data without touching GitHub.
2. **ETag revalidation** — past soft-TTL, `If-None-Match` is sent;
   304 responses are converted back to cached payloads (free against the
   primary 5,000/hr rate limit).

Cache keys are the fully resolved request URL (`octokit.request.endpoint()`),
so per-repo isolation is enforced. Frontend polling (`GitPanel.tsx`) runs at
30s and pauses while the tab is hidden. Observe via
`jq 'select(.event | startswith("github.cache"))' ~/Library/Logs/sideclaw.jsonl`.

### Enabling the GitPanel

The git surface is **off by default** — opt in per `.env`.

Set `SIDECLAW_GIT_ENABLED=true` + `VITE_SIDECLAW_GIT_ENABLED=true` in `.env`
to turn on the whole git surface — GitPanel renders, `/api/repo/git` and
`/api/github` return live data, and `/api/actions/{chain,git}` are active.
Left unset, the git surface stays off (`data: null`, actions return 503),
which avoids GitHub rate-limit pressure.

## Running sideclaw

**sideclaw runs exclusively via LaunchAgent. Never start it standalone.**

- `make dev` and `make start` are intentionally broken — they exit with an error.
- Do NOT run `bun run dev`, `bun run start`, `bun server/index.ts`, or anything that starts a server directly.
- Port 7705 is owned by the LaunchAgent. Starting a second process there causes conflicts.

```bash
make build           # Build frontend to dist/ (no server start)
make reload          # After code changes: build + kickstart LaunchAgent
make install-agent   # One-time: build + install + start LaunchAgent
make uninstall-agent # Remove LaunchAgent

tail -f ~/Library/Logs/sideclaw.log   # stdout
tail -f ~/Library/Logs/sideclaw.err   # stderr
```

The LaunchAgent starts automatically on login and restarts on crash.

**Logs live in `~/Library/Logs`, never `/tmp`.** A KeepAlive agent opens its
stdio exactly once, at spawn. macOS's periodic cleanup sweeps `/tmp` files
untouched for 3+ days, so after a sweep the process keeps writing into an
unlinked inode: `lsof` still shows the fd, `ls` says the file is gone, and every
line written since is unrecoverable — which is how sideclaw ended up with no
post-mortem at all. The paths live in `com.jkrumm.sideclaw-server.plist`, and
`make install-agent` copies that file verbatim over the live one, so changing
the live plist by hand is silently reverted on the next install. Change the
tracked file.

**The label is `com.jkrumm.sideclaw-server` and the program is a wrapper script
— both are Background Task Management workarounds, not style.** macOS computes
an *effective* disposition for every launch item, and on this host two separate
denials applied: `/opt/homebrew/bin/bun` as an executable, and the identifier
`8.com.jkrumm.sideclaw`. Either one alone is enough to make launchd skip the
`RunAtLoad` spawn — which is what "sideclaw doesn't come up after a power cut"
actually was, reproduced across three reboots on 2026-08-06 (one no-start, two
starting ~3 minutes late, against ~18s for every allowed agent on the machine).
Measured, not inferred: a throwaway agent running only `bun --version` under a
never-seen label registered `[enabled, allowed]` and BTM immediately resolved it
to `[enabled, disallowed]`; the same probe through a shell script resolved to
`[enabled, allowed]`. The identifier half is stickier than it looks — deleting
the plist, re-adding it, and re-adding it under a different *filename* all came
back disallowed, so only a new **Label** clears it. Hence
`scripts/sideclaw-start.sh` (dodges the bun denial) plus the `-server` label
(dodges the identifier denial). Reverting either brings the boot failure back.
It also makes the entry legible as `sideclaw-start.sh` rather than an anonymous
`bun` in System Settings → Login Items, which is how it plausibly got denied in
the first place. Verify after any change to the plist:

```bash
log show --last 2m --info | grep -A3 sideclaw-server.plist | grep effectiveItemDisposition
# want: result=[enabled, allowed, ...]
```

## MCP Server

sideclaw exposes workflow tools (`check`, `review`, `dispatch`, `overview`) plus the job-polling tools (`job_status`, `job_wait`) as an MCP server — a **separate process** from the LaunchAgent, spawned on-demand by Claude Code via stdio transport. `GET /api/agents` (below) is HTTP-only, deliberately outside this MCP surface — see `### agents`.

Entry point: `server/mcp.ts`. Thin MCP tool wrappers live in `server/mcp/tools/`; the actual execution logic + schemas live in `server/jobs/handlers/`; skill prompts in `server/skills/`.

**Deploying schema changes:** `make reload` only restarts the launchd HTTP server (job execution + skill-prompt reads, which load from disk per-run). It does NOT restart the MCP process — that's owned by the calling Claude Code session. So an edited tool **input/output schema** (e.g. a new `commands`/`validateCmd` field on `*_INPUT`) is not visible to a connected client until its MCP reconnects; until then the SDK's Zod validation silently **strips** the unknown field before it reaches the handler. After changing a tool schema, reconnect `/mcp` (or restart the session) — not just `make reload`. Skill-prompt and handler-logic edits need only `make reload`.

### Async job model (durable, off the MCP transport)

The long tools (`check`/`review`/`dispatch`/`overview`) do **not** block the MCP call. A 13-minute worker run held open as a single MCP request destabilizes the stdio transport (and the SDK's 60s client timeout). Instead:

1. The MCP tool **submits a job** to the always-on HTTP server (`POST /api/jobs`) and returns `{ jobId, status }` immediately.
2. The HTTP server (LaunchAgent, durable) runs the job in the background and persists state to **bun:sqlite** (`~/.local/share/sideclaw/jobs.db`). Not `/tmp` — macOS's periodic cleanup sweeps files there untouched for 3+ days, and a long-running agent then writes into an unlinked inode. See `server/jobs/store.ts`.
3. The caller polls **`job_wait({ jobId })`** — a long-poll (~50s, heartbeated) that returns the result the moment the job finishes, or `stillRunning: true` to call again. `job_status` is a one-shot peek.

While a job runs, `job_status`/`job_wait` also expose live worker progress derived from the worker's stream-json output: `turns`, `lastAction` (e.g. `"Edit store.ts"`), and **`idleMs`** — ms since the last worker event. `idleMs` is the wedge signal: it stays low while events flow and rises during a single long operation (e.g. a slow test run), so a *large and still-growing* `idleMs` means the session may be stuck — peek at `git status` rather than waiting indefinitely. The runner persists each snapshot via a `ProgressSink` threaded `store → executor → handler → runSession.onActivity`; `review` aggregates one shared liveness bump across its parallel angle sessions.

Why the HTTP server hosts jobs (not the MCP process): the MCP process dies on `/mcp` disconnect, but the HTTP server is launchd-managed. Jobs survive MCP reconnects; disk persistence survives an HTTP restart (in-flight jobs reconcile to `interrupted` on boot — `recover()`). A **global concurrency cap** (`SIDECLAW_JOB_CONCURRENCY`, default 3) queues excess submissions as `pending` so parallel agents can't trip the IU unified endpoint's rate limits.

Job lifecycle events log to `~/Library/Logs/sideclaw.jsonl` (`job.create` / `job.start` / `job.done` / `job.fail` / `job.recover`). Inspect the queue: `curl -s localhost:7705/api/jobs | jq`.

### agents

`GET /api/agents` and `GET /api/agents.txt` (`server/lib/agents.ts`, `server/routes/agents.ts`)
are a **deterministic, read-only, no-LLM** snapshot of every Claude Code agent on this Mac
mini, grouped by project — the single producer behind an agent overview rendered by Hermes, an
Argo dashboard, a brain page and a herdr pane. Unlike `check`/`review`/`dispatch` it is plain
synchronous HTTP, not a job: no queue, no worker session, answers in one request.

- **Sources, merged by Claude sessionId:** `herdr agent list` (panes) + `herdr workspace list`
  (workspace_id → project label), `claude agents --json` (Claude's own registry, including
  `claude --bg` daemons with no herdr pane), and this server's own dispatch job store
  (`listJobRecords`). A herdr pane and a `claude agents` entry sharing a sessionId collapse
  into one entry; herdr's identity wins (source stays `"herdr"`), both raw statuses are kept.
- **Per-agent `state`** (`needs_you > working > stale > idle > done > unknown`, see
  `deriveState()`'s doc comment) is the only field consumers should branch on — `herdrStatus`/
  `claudeStatus` are raw passthrough for debugging, not a second source of truth.
  `SIDECLAW_AGENT_STALE_HOURS` (default 24) sets the stale threshold.
  A dispatch job's own needs-human verdict is **not** distinguished into `needs_you` — that
  signal isn't cheaply available without a tool-specific parse of `job.result`, so a dispatch
  entry only ever resolves to working/done/unknown (noted, not fixed, in this pass).
- **Session transcript reads are tail-only, progressively** (`readSessionTail` →
  `readTranscriptTailFile`): transcripts reach 16 MB, so only the tail of
  `~/.claude/projects/<encoded cwd>/<sessionId>.jsonl` is read (cwd encoded by replacing every
  non-alphanumeric character with `-`), never the whole file — **512 KB, growing to 8 MB when
  the tail lands inside an oversized line** (e.g. an extended-thinking signature blob larger
  than the window, which otherwise pushes every parseable assistant/user line out of it).
  A missing transcript yields nulls, never a thrown error. File **mtime is never used** as an
  activity signal: Claude Code touches an idle session's transcript file (measured — a session
  last active 2026-09-04 had today's mtime), so mtime tracks process residency, not the user.
- **No MCP tool for this** — HTTP-only for now. A read-only MCP tool would cost every session a
  deferred tool name for something no session needs to call itself; the intended callers are
  external services polling over HTTP.
- **`?color=1` (also `?ansi=1`) on `/api/agents.txt` and `/api/overview.txt`** opts into an
  ANSI-coloured render (SGR only) — the herdr `overview` pane runs `watch --color` against it.
  Plain output with no query is byte-identical to before the flag existed.
- Binds on `0.0.0.0` like the rest of the LaunchAgent HTTP server, so **port 7705 must stay
  ungranted in the tailnet ACL** — this endpoint carries no auth of its own.
- Pure units (`encodeProjectDir`, `parseTranscriptTail`, `deriveState`, `mergeAgents`,
  `renderText`) are covered by `tests/agents.test.ts` — no subprocess, no mocks, per repo
  convention.
- `buildSnapshot` (the single producer above) lives in `server/lib/agents.ts` itself — the
  `overview` job below calls it in-process, not over HTTP, to avoid looping back into its own
  server.

### overview

The `overview` job (`server/jobs/handlers/overview.ts`, MCP tool + `GET /api/overview` /
`GET /api/overview.txt` in `server/routes/agents.ts`) enriches the deterministic `agents`
snapshot above with **one LLM recommendation per agent** — a batched, single-call, prompt-only
triage pass, unlike `check`/`review`/`dispatch` it never touches a repo or a file: every fact
the worker needs (project git status, agent state, transcript excerpts) is already assembled
into the prompt by the handler.

- **The recommendation enum**, one value per agent, from evidence only: `answer` (blocked on a
  question/dialog/permission — reply to it), `continue` (idle mid-task, clear next step, safe
  to send "continue"), `ship` (done but uncommitted/unpushed/ahead of origin — commit/push),
  `review` (pushed, needs a code review or human QA), `merge` (a PR/branch is ready to merge),
  `close` (finished, nothing pending), `stale` (abandoned/superseded, no clear next step),
  `watch` (actively working, nothing to do — **the default when the model is unsure**). Each
  entry also carries `standing` (≤120 chars, present tense, what the agent is actually doing),
  `blocker` (≤80 chars or null) and `confidence` (`high`/`medium`/`low`).
- **Model default is `CHECK_MODEL`** (`claude-haiku-4-5`, `session-runner.ts`) — this is
  classification over a prompt, not code judgment, the same reasoning that put `check` on the
  cheap tier. Override via the job's `model` input param; any id (Claude or not) still routes
  through `SIDECLAW_WORKER_BACKEND` like every other worker.
- **One batched `runSession` call for the whole fleet**, not one per agent — cheaper and lets
  the model reason about relative priority across agents. `readOnly: true` plus
  `extraDisallowedTools: ["Bash", "Read", "Grep", "Glob"]` make it prompt-only: the worker
  cannot read a file or shell out, only reason over what the handler already gave it.
  `maxTurns: 3`, 120s timeout — there is no discovery to do.
- **Nonce-fenced facts, same pattern as dispatch's brief hardening** (`buildPrompt` in
  `overview.ts`): the facts block quotes transcript excerpts (a user's prompts, an assistant's
  own replies), which is model-generated text the worker's own session did not produce this
  run, so it is fenced with a per-run random delimiter (`newFenceNonce`) and the constraints
  are re-asserted AFTER the data block, not just before it.
- **Reconciliation is two separate passes.** At job-completion time, `reconcileOverview` merges
  the worker's per-agent verdicts onto the snapshot's own agent ids: an id the worker invented
  is dropped (logged `overview.unknown_agent_id`); an id present in the snapshot but omitted by
  the worker is synthesized to `recommendation: "watch"`, `standing: null`,
  `confidence: "low"`, `synthesized: true` rather than silently missing. Separately, at request
  time, `mergeOverviewIntoSnapshot` merges the *latest cached* job result onto a *fresh*
  snapshot for `GET /api/overview` — see below.
- **`GET /api/overview` / `GET /api/overview.txt` never run the LLM inline.** They take a fresh
  deterministic snapshot and merge the newest **completed** `overview` job's result onto it by
  agent id (`latestJobResult("overview")` in `server/jobs/store.ts`, re-validated against
  `OVERVIEW_OUTPUT` — a schema-drifted old cached job degrades to "no cached overview", never a
  500). An agent that has been active more recently than the cached job ran
  (`cached.generatedAt < agent.lastActivityAt`) gets its recommendation fields nulled and
  `recommendationStale: true` instead of presenting a stale verdict as current — call the
  `overview` job again to refresh it. JSON response: `{ ok, data: { ...snapshot,
  overview: { generatedAt, model, ageMs } | null } }`, with `recommendation`/`standing`/
  `blocker`/`confidence`/`recommendationStale` merged directly onto each agent object.
- **`renderText` (agents.ts) takes an optional `enrichment` map + `overview` meta** rather than
  a duplicated renderer: called with no `opts` (the plain `/api/agents.txt` path) it is
  byte-identical to before enrichment existed. With enrichment, the state icon is replaced by
  the recommendation icon (`answer`→`?!`, `continue`→`→`, `ship`→`⇧`, `review`→`⚑`, `merge`→`⇄`,
  `close`→`✓`, `stale`→`·`, `watch`→`●`), a non-null `standing` gets an indented second line
  (≤110 chars, truncated), and the header gains `· overview <age>` / `· overview none`. The
  header line itself is deliberately **not** run through the shared 110-char `clampLine` (that
  cap exists to bound externally-influenced agent text, not the handler's own bounded summary
  line) — clamping it would silently drop the overview suffix on every call, since the base
  header (~100 chars) plus the suffix (~15-18 chars) already exceeds 110.
- Pure units (`buildAgentFacts`, `buildPrompt`, `newFenceNonce`, `reconcileOverview`,
  `mergeOverviewIntoSnapshot`, plus `renderText`'s enrichment path) are covered by
  `tests/overview.test.ts` — no subprocess, no mocks, mutation-verified on the unknown-id-drop
  and the standing-line-truncation bound.

Higher-order tools reuse capabilities at the **code level, not via MCP recursion**: `review` angle workers can validate external library/API claims against the standalone **research-gateway** (a bounded bearer-auth `curl`, gated on `RESEARCH_GATEWAY_URL`/`RESEARCH_GATEWAY_TOKEN`) and self-validate (check capability) — no nested jobs, no semaphore deadlock.

### Worker model — backend selection: IU (default) / Max

Worker sessions run on **Claude via the IU unified endpoint's native Anthropic transport** by default (the same recipe dotfiles' `ca`/`claude_iu` use) — metered IU per-token billing, off Max. `session-runner.ts` selects the backend by `SIDECLAW_WORKER_BACKEND`, for every model id: `"iu"` (default) resolves the IU key/base via `getIuConfig()` and injects `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` directly. Each IU-native session writes a `session_env` line to `~/.claude/logs/<date>.jsonl` (mirroring the dotfiles SessionStart hook) so usage-tracker classifies worker spend as IU, not Max.

**`SIDECLAW_WORKER_BACKEND`** (`.env`, default `iu`) is a per-installation escape hatch onto the Max subscription: set it to `max` and plain `claude-*` worker sessions delete `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` instead of injecting the IU ones, so the CLI falls through to the inherited OAuth profile — Max subscription rate-limit budget, not metered API tokens. A non-Claude model id is overridden back to `"iu"` regardless of the flag, since Max only ever serves Anthropic's own models. Read once at module load from `sideclaw/.env`, so flipping it requires **`make reload`** (not just a code edit) to take effect. On the `max` backend, `session_env` is still written but with an explicit `base_url: null` (not skipped) — usage-tracker's classifier (`models.ts`) reads `base_url` present → `iu`, `null`/missing → `max`, so this is how a Max-backend run gets attributed `billing="max"`.

#### Dynamic Max→IU quota fallback

On `SIDECLAW_WORKER_BACKEND=max`, every claude-* session's backend is now decided per launch rather than statically: `resolveBackend(model)` (`session-runner.ts`) reads live Max quota and calls the pure `chooseBackend({ configured, model, quota, ceilingFiveHour, ceilingSevenDay, fallback })`, in order — non-Claude id → `iu` (unconditional, no quota read); `SIDECLAW_WORKER_FALLBACK=none` → stay on `configured`; quota `source: "unknown"` → stay on `configured` (never block a session on missing data); five-hour utilization `>= SIDECLAW_MAX_QUOTA_CEILING` (default `90`) or seven-day `>= SIDECLAW_MAX_WEEKLY_CEILING` (default `95`) → `iu`; otherwise stay on `configured`. The model id **never changes** across the fallback — only the auth env does — so worker quality is constant and only billing moves (usage-tracker already classifies by `base_url`, unaffected by this). `SIDECLAW_WORKER_FALLBACK` (`iu` default | `none`) is the off switch, same "read once, needs `make reload`" rule as `SIDECLAW_WORKER_BACKEND`.

**Quota sources** (`server/lib/quota.ts`), cheapest first: the statusline's own cache (`/tmp/claude_sl/usage_api.json`, written by dotfiles' `fetch_usage.py` every ~60s) if fresh (`SIDECLAW_QUOTA_FILE_MAX_AGE_S`, default `600`s — goes stale with no interactive Claude Code session around to render the statusline); else the live `api.anthropic.com/api/oauth/usage`, bearer = the same OAuth token Claude Code keeps in the macOS Keychain (`Claude Code-credentials`), cached in-memory 60s (the endpoint 429s per-token within a few requests/min — a 429 or any other failure returns the last good reading, never blanks it). A locked keychain (headless session, no GUI) makes the API path return `source: "unknown"`, which per rule 3 above just keeps the configured backend — a dynamic fallback that silently can't read quota fails toward "do nothing new," not toward blocking work.

**Reactive retry, on top of the proactive check:** if a `max`-backend attempt produces no worker output yet (same `turnsRef.current === 0` guard the transient-transport retry uses) and fails with text `isQuotaError` recognizes (`hit your usage limit`, `rate limit`, a bare `429`, `overloaded`, `quota`), `runSession` forces exactly one retry onto `iu` (logs `backend.fallback`, reason `rate-limited`) — this catches quota exhaustion the proactive check missed (stale/absent quota reading) without waiting for the next session. It never retries a second time: a quota-flavored failure on the `iu` retry itself is not retried again. Every session logs `backend.select` (or `backend.fallback` for the forced retry) with `tool`/`model`/`backend`/`reason`, plus the two percentages when `reason: "quota"`; `SessionResult.backend` and `overview`'s job output both carry the backend actually used.

Tests: `tests/backend-select.test.ts` (chooseBackend's full rule matrix incl. both ceiling boundaries, `parseQuotaFile`/`parseQuotaApi`, `isQuotaError`); `tests/session-retry.test.ts` covers `resolveBackend`'s IO-free non-Claude short circuit.

**Caveat:** `check`/`review`/`dispatch` run as jobs inside the launchd HTTP server, which loads `sideclaw/.env` via Bun — `SIDECLAW_WORKER_BACKEND` (like every other `SIDECLAW_*` var) applies reliably there. `otel` calls `runSession` directly in the MCP process (`server/mcp/tools/otel.ts`), which Bun starts with the *calling session's* cwd and may not pick up `sideclaw/.env` — for `otel`, the var would need to be exported in the environment instead. Pre-existing limitation, not specific to this flag.

**`otel` also injects the real ClickStack/HyperDX MCP** (`--mcp-config`'s `mcpServers.hyperdx`, `type: "http"`, bearer = the HyperDX user access key) into its own worker session instead of running query.py-only — `runSession`'s `mcpServers`/`extraDisallowedTools` fields (`session-runner.ts`) exist for this. Key resolution fails soft, per environment: local reads `~/.config/hyperdx/local.env`; prod tries `HYPERDX_PROD_ACCESS_KEY` then `secrets-run read op://vps/clickstack/AGENT_ACCESS_KEY` (never a bare `op` — hangs headless). No key → the worker still runs, just without the MCP. `readOnly: true` plus the mutating `clickstack_save_*`/`delete_*`/`patch_dashboard` tool names in `extraDisallowedTools` keep the worker query-only. The output's `hyperdx: "connected" | "unavailable (<reason>)"` field is set by the tool handler from its own resolution result, never echoed from the worker's JSON — provenance the caller can trust regardless of what the model noticed about its own tool set.

Two constraints carried over regardless of backend:
- **No `WebSearch`/`WebFetch`** — not wired into worker prompts. For web/library facts, workers shell out via Bash instead — `review` angle workers `curl` the research-gateway (async submit + poll) to validate external claims.
- **Read-only tools must opt in** (`readOnly: true` → `--disallowedTools "Write,Edit,NotebookEdit"`). Workers will edit files under `--dangerously-skip-permissions` otherwise. It must be `--disallowedTools`: skip-permissions bypasses the permission system an *allowlist* feeds, so the original `--allowedTools` spelling restricted nothing (measured on CLI 2.1.220 — a probe overwrote its canary). `check`/`review` are read-only; `dispatch` is read-only in its `investigate`/`author` tiers and deliberately writable in `implement`.

### Dispatch Tool — bounded episodes inside another repo

The `dispatch` job (`server/jobs/handlers/dispatch.ts`, prompts in `server/skills/dispatch/`)
hands ONE episode to a Claude Code session running inside a named repo, so it works with that
repo's own `CLAUDE.md`, `.claude/rules/` and `.claude/skills/` in context. It exists because an
observer that has the state (Hermes on the mini) cannot use Claude-shaped context, and a
session that has the context cannot watch for work. One episode, one verdict, no steering
— mid-run redirection is `rd bg` + `rd say`, not this.

- **Tiers.** `investigate` (read-only → verdict), `author` (read-only → verdict + GitHub
  issue), `implement` (write → verdict + branch + **draft** PR).
  Prompts are `skills/dispatch/_common.md` + one tier file; the shared injection-hardening
  preamble lives in `_common.md` precisely so three copies cannot drift apart.
- **EVERY tier runs in its own worktree**, torn down in the same `finally`. For the read
  tiers this is isolation, not restriction — it costs no capability, only the directory the
  session starts in. The reason it is not implement-only: `readOnly: true` disables Edit and
  Write but **not** `Bash`, and the brief is attacker-influenced (anyone can open an issue on
  a public repo, and its body reaches an episode's context), so a read tier in the live
  checkout was one injected `sed -i` away from editing a repo other agents work in and that
  deploys on push. Read tiers get `createReadWorktree` — a detached copy of **HEAD**, needing
  no identity, no fetch and no GitHub API, which is what keeps `investigate` working in a
  repo whose origin is not GitHub or absent. Implement keeps its branch cut from the
  authoritative default. `DispatchWorktree.pushable` distinguishes them as a property of the
  object rather than a re-derived tier check, because `salvage` pushes whatever the session
  left behind and must never publish a read tier's leftovers. Narrow claim: this isolates the
  **working tree**. The worktree shares `.git`, and nothing confines the session's `Bash` to
  the filesystem below it.
- **Read tiers also see untracked and gitignored content, not just HEAD.** `git worktree add`
  only ever materializes tracked content — a side effect of the command, not a deliberate
  guard, since the write exposure above is about a *write* landing in the live checkout and
  copying files *in* doesn't touch that. `createReadWorktree` calls `copyUntrackedFiles`
  (`dispatch-git.ts`) right after the worktree is created: `git ls-files --others -z` (no
  `--exclude-standard`, so gitignored content is included, not filtered) enumerates the live
  checkout, and each candidate is cloned in via `fs.copyFileSync(..., COPYFILE_FICLONE)` —
  Node/Bun's own "try a COW clone, fall back to a plain copy" primitive, near-free on the
  common case where the worktree root and the checkout share a volume. `implement` is
  untouched — `createWorktree` never calls it, because its branch must carry nothing beyond
  what the episode itself commits. Three exclusions: any path with a `.claude` segment is
  refused unconditionally (an untracked `.claude/settings.local.json` would walk straight past
  `stripProjectSettings` and reopen the `GIT_DENY_CREDENTIALS_ENV` hole through a side door —
  security, not cost); `node_modules`/`.venv`/`venv`/`dist`/`build`/`target`/`.next`/`.turbo`/
  `.cache`/`coverage`/`.git` segments are skipped as pure cost control; and the whole copy is
  bounded (100 MB / 5,000 files) with a loud `logger.warn` naming the count/bytes skipped if
  the bound is hit — no silent truncation. Best effort end to end: any failure degrades to
  "fewer files present", never to a failed episode. **The stat is an `lstatSync`, and that is
  load-bearing:** `statSync` follows a symlink, so an untracked `link -> ~/.ssh/id_ed25519`
  would report as a regular file and its *target's* content would be cloned in as a real file.
  The episode's `Bash` is unconfined and could read that path directly either way, so it is no
  new capability — but a read tier's whole job is to sweep the tree it was handed, and
  materializing a secret *inside* that tree gets it into a verdict with nobody intending it.
  Every non-regular entry is skipped; the link target is not this copy's business. `_common.md`'s workspace section states
  the split per tier rather than a blanket "absent" — `implement`'s fresh-cut worktree still
  has nothing beyond history.
- **Boot sweeps stale worktrees** (`sweepStaleWorktrees`, called from `server/index.ts`
  beside `initJobStore`). The `finally` teardown covers every exit path *inside* the process;
  a SIGKILL has none, and that is the ordinary case — launchd restarts on crash and
  `make reload` kickstarts deliberately. What leaks is not just a directory under sideclaw's
  state dir: the `.git/worktrees` registration and the `dispatch/…` branch land in the **live
  repo**, visible in the user's `git branch`. Each leftover is self-describing (a linked
  worktree's `.git` is a file naming the main repo; that gitdir's HEAD names the branch), so
  the sweep needs no bookkeeping that would itself have to survive the crash. Unconditional
  at boot is safe because launchd keeps one instance — at startup every directory under the
  root is abandoned by definition.
- **The artifact is created by the HANDLER, never by the session** (`dispatch-git.ts`). That
  is the security argument for the write tiers, not an implementation detail: the session
  holds no GitHub credential, so no brief — however injected — reaches GitHub through it. It
  also makes "never merges, never pushes to a default branch" a property of `pushBranch`
  (explicit default-branch check, `dispatch/` namespace check, single-branch refspec, no
  force flag anywhere) rather than a line in a prompt.
- **Worker sessions get git's credential helper taken away** (`GIT_DENY_CREDENTIALS_ENV`,
  applied at **every** tier). Non-obvious and load-bearing: `~/.gitconfig` on this host
  includes `~/.gitconfig-headless`, which wires the GitHub helper to the offline secrets
  cache — so any process running as this user can push with no secret of its own, and a
  read-only session still has `Bash`. Scrubbing `SENSITIVE_ENV_RE` does nothing about it,
  because the credential never travels through the environment. So the config is removed
  (`GIT_CONFIG_GLOBAL=/dev/null`) and the fallback paths (terminal prompt, askpass, ssh) are
  closed. Identity is re-supplied explicitly so a session that commits anyway still succeeds.
- **The audited repo's *executable* config never loads** — two separate defences, because the
  hole had two halves and only one is fixable with a flag. The episode is supposed to load the
  repo's CLAUDE.md, rules and skills; that is the point of dispatching. It must not also load
  the repo's `.claude/settings.json`, and by default it did. Both measured on CLI 2.1.220
  (2026-08-03) with canaries in a scratch repo, under the exact flag vector sideclaw uses:
  - **Hooks executed.** A `SessionStart` hook ran *before the model took a turn*, and a
    `PreToolUse` hook ran on the worker's first Bash call — arbitrary commands, supplied by
    the repo being audited, in a session whose brief is attacker-influenced. Same
    "repo-controlled code is not a check" argument that makes the dispatch commit
    `--no-verify`, one layer up. Fixed by `WORKER_SETTINGS` (`--settings
    '{"disableAllHooks":true}'`) on **every** sideclaw worker, not just dispatch.
    `--setting-sources user` also stops it but takes the repo's CLAUDE.md with it (measured:
    the codeword probe answered `NONE`), and `--settings '{"hooks":{}}'` merges, so the repo's
    hooks still fired. `disableAllHooks` is the only lever that separates them.
  - **`env` overrode the handler's environment.** A repo shipping
    `{"env":{"GIT_CONFIG_GLOBAL":"/repo/wins"}}` got exactly that inside the session's Bash —
    i.e. `GIT_DENY_CREDENTIALS_ENV`, the bullet directly above, undone by one line in the
    audited repo. No flag fixes this while the project source is loaded, so the file is
    removed instead: `stripProjectSettings` deletes `.claude/settings{,.local}.json` from the
    **throwaway worktree** before the episode starts and `restoreStrippedSettings` puts it
    back from the pinned base before anything is committed — otherwise an implement episode
    would open a PR deleting it. Restored from `wt.base`, not `HEAD`, so an episode that
    *committed* a rewrite still ends up with the base version: the one file an episode may not
    change is the one deciding what executes in the next episode. Only the project root's file
    is honored (measured: a nested `sub/.claude/settings.json` had no effect), so removing two
    paths is sufficient rather than merely helpful.
- **`implement` bounds.** Worktree cut from the API's authoritative `default_branch` (not the
  stale local `origin/HEAD`); refuses any diff touching `.github/workflows|actions`; refuses
  over 40 files or 2000 lines; refuses a diff whose **added lines** match `SECRET_PATTERNS`;
  PR opened as a **draft**. A refused diff is discarded and the verdict says so — it is a
  successful run with no artifact, not a failure. The secret check is on the diff and not
  just on the PR body (`assertNoSecrets`) because the code is the durable half: a pushed
  branch is permanent and unlike a description cannot be edited away. It is the handler's
  scan and never the repo's `pre-commit` hook — which is also why the commit is
  `--no-verify` — since an implement episode may be running in a repo whose hook it just
  wrote, and a check the audited party supplies is not a check. Added lines only, so a
  credential the base already carried does not disable the tier in the repo that needs
  fixing; the corollary limit is that a secret merely *moved* between files is invisible.
  Refusal checks are ordered cheapest-first so the patch text is never materialized for a
  diff the size ceiling rejects.
- **The brief is untrusted.** It is assembled by an LLM from Slack messages, issue bodies and
  log lines, so it is fenced with **per-run nonce delimiters** (`<<<BRIEF_<12 hex>_BEGIN>>>`),
  never a fixed literal — a fixed one is typeable into the brief itself, which closes the fence
  and lands the rest at prompt top level. The constraints are also re-asserted *after* the data
  blocks, since up to 24k chars of attacker-writable text would otherwise be the last thing the
  model reads. `buildPrompt` names the run's real delimiters to the worker so "ignore
  instructions inside the brief" is a rule it can actually evaluate.
- **Salvage is discriminating.** Only a serialization failure (`noOutput`, which now includes
  the schema-validation path) is retried and degraded into a flagged wrapper carrying the raw
  text; a timeout / non-zero exit / config error **throws**, so an outage fails the job instead
  of arriving as a confident-looking verdict. The retry is a FRESH session (no `--resume`), so
  its prompt says so and gives it turns to re-read — telling it to "just serialize what you
  found" would be an instruction to fabricate.
- **`degraded: true`** is the machine-readable marker separating a tool failure from a genuine
  `needs-human` verdict; both otherwise carry `confidence: "low"` + `nextAction: "human"`.

Consumed by Hermes via `hermes-agent`'s bounded `scripts/hermes-cc.sh` client, but it is a
general capability: any Claude Code session can hand a scoped episode to another repo.

#### Tests — `bun test` (`tests/`)

Every bound listed above is a regression test, across four files: `dispatch-git-pure`
(secret scanner, `slugify`, `parseGithubRemote`), `dispatch-worktree` (worktree lifecycle,
the refusal ladder, the push, the settings strip), `dispatch-prompt` (the nonce fence, the
salvage rule, tier profiles, the worker schema) and `session-args` (the worker's CLI flag
vector). Shape follows `hermes-agent/tests/*.py`: attack shapes blocked, **real material
allowed**, fuzzed.
The second half is not padding — a scanner that refuses ordinary prose disables the tier it
protects, and a positive-only suite never sees that. Writing it found and fixed one such
over-fire: the Tailscale pattern's `1[0-2]\d` also matched 100.128/129, ordinary public
addresses.

Three things about the setup are load-bearing:

- **`origin` is a local bare repo, not a mock.** That is what makes `pushBranch` testable at
  all — the single-branch refspec, the absence of a force flag and "master did not move" are
  properties of the real git invocation, and the diverged-branch case proves the push fails
  rather than overwrites. Nothing in the suite reaches the network or needs a credential.
- **`WORKTREE_ROOT` is read per call** (`worktreeRoot()`, overridable by
  `SIDECLAW_WORKTREE_ROOT`, never set in production). `sweepStaleWorktrees` deletes *every*
  directory under that root on the stated assumption that one instance of this server exists;
  a test run is a second process, so against the real root it would tear down a live episode's
  worktree. `tests/setup.ts` (bunfig `[test].preload`) moves the default off it for the whole
  run and silences the shared app logger; each fixture narrows it to its own temp dir.
- **Several functions are exported only because they are the units worth testing** —
  `buildSessionArgs` (split out of `runSession`), `buildPrompt`, `isSalvageable`, `TIERS`,
  `WORKER_OUTPUT`. `runDispatch` cannot be tested without spawning a model, and the flags and
  the fence are exactly the parts whose absence is invisible at runtime.
- **The suite is mutation-verified, not merely green.** 28 mutations of the bounds — dropping
  `--no-renames`, making a read worktree pushable, removing each `pushBranch` refusal, adding
  `--force`, reordering the refusal ladder, scanning removed lines as added, raising either
  ceiling, skipping the post-failure worktree cleanup, removing the hook kill, reverting
  `--disallowedTools` to the silently-broken `--allowedTools`, no-oping the settings
  strip/restore, restoring from `HEAD` instead of the pinned base, replacing the per-run nonce
  with a literal, dropping the post-data re-assertion, making every failure salvageable,
  loosening the worker schema to `z.object` — were each applied and each turned the suite red.
  Re-run that check after changing a bound: a test that cannot fail is not a test.

### Review Tool — Multi-Angle Pipeline

The `review` job (`server/jobs/handlers/review.ts`) runs a 3-phase parallel pipeline inside the HTTP server (see `server/skills/review/README.md` for full docs):

1. **Data gathering** (parallel): git diff, fallow audit, CodeRabbit CLI
2. **Angle reviews** (parallel claude-sonnet-5 sessions, capped at `ANGLE_CONCURRENCY=3` so the IU endpoint's rate limits aren't tripped): architect, senior-dev, + conditionally frontend (.tsx/.jsx), backend (api/server .ts), typescript (.ts), QA (if tests exist), plus router-picked content angles (security, performance, concurrency, data-migration, api-contract, resilience) — the router prompt carries an ISO 25010 coverage checklist so crash/deploy-path dimensions aren't missed
3. **Synthesis** (claude-sonnet-5): deduplicates, classifies into `blocking` / `improvements` / `discussions` / `testGaps`

Output `outcome`: `"clean"` (ship it), `"actionable"` (apply fixes), `"needs-human"` (has discussions).
Frontend agent loads react/tanstack rules; backend agent loads elysia rules + fetches `elysiajs.com/llms.txt`.

**External-fact validation (optional):** when `RESEARCH_GATEWAY_URL` + `RESEARCH_GATEWAY_TOKEN` are set in `.env`, each angle prompt gets a bounded `curl` recipe (and the bearer via `extraEnv`) so a reviewer can validate an external library/API/version claim against the research-gateway before filing it. Unconfigured → the block is empty and review runs unchanged.

**Synthesis salvage:** the synthesizer occasionally emits prose instead of the schema JSON. Synthesis now retries once with a JSON-only directive, then falls back to a `needs-human` verdict that preserves the raw synthesizer text in a discussions entry (via `SessionResult.rawText`) — a multi-minute run is never discarded as a bare parse error.

### Multimodal tools — direct IU OpenAI transport (synchronous)

`read_image` and `read_drawing` are **not** `runSession()` worker sessions and **not** async jobs. They are plain `fetch` calls to the IU unified endpoint's **OpenAI transport** (`/openai/v1/...`) — stateless, synchronous MCP tools (single call well under the 60s SDK timeout; a `mcpHeartbeat` in `session-runner.ts` keeps the client alive past 15s). Billed IU per-token, zero Max, no `session-runner` / `claude -p` / read-only allowlist.

- **Credentials** (`server/lib/iu-openai.ts`): IU key + base from Keychain (`claude-sdk-api-key`, `claude-sdk-base-url`) or `IU_API_KEY`/`IU_BASE_URL` env. The OpenAI base is derived by replacing the base's trailing `/anthropic` → `/openai/v1` (never hardcoded). `iuFetch` retries 503/429/5xx with backoff; fails fast on 410 (dead model — e.g. `dall-e-3`).
- **Model (fixed, not a residency knob):** vision = `gemini-3.5-flash` (fast, strong on dense diagrams). Routes to a **non-EU vendor** — fine for git-committed/non-sensitive content, not PII.
- **`read_image`** — vision read of any image. SVGs are rasterized first (`server/lib/image.ts`).
- **`read_drawing`** — composite: rasterize+read the `.svg` AND deterministically parse the paired `.excalidraw` JSON (`server/lib/excalidraw.ts` — the structural ground truth: frames, bindings, groups), merged into one synthesis (`server/skills/read-drawing.md`). The dotfiles `/read-drawing` skill's `claude_iu` Haiku path is retired in favor of this.
- **`generate_image` was retired 2026-07** — superseded by the `image-gen` gateway, which adds the contract validation and library/sidecar this tool never had.
- **SVG rasterizer:** headless Chrome (`server/lib/chrome.ts` `findChrome`, shared with kiosk) — the only method that resolves web fonts faithfully without cropping. `resvg`/`rsvg-convert`/`qlmanage`/`svglib` all failed the bake-off.
- **Telemetry:** these bypass `session-runner`, so nothing writes their usage to the normal attribution log. `recordIuUsage` appends an NDJSON line per call to `~/.local/share/usage-tracker/sideclaw-iu.jsonl` (override with `SIDECLAW_IU_USAGE_LOG`) plus `~/Library/Logs/sideclaw.jsonl` events. The usage-tracker's `sideclaw-iu` collector ingests that file (`server/routes/usage.ts` is only Max-quota %, not a token ledger).
- **Reasoning tokens are derived, not reported.** The gateway returns only `prompt_tokens`/`completion_tokens`/`total_tokens` — no `completion_tokens_details` — and for Gemini the thinking spend sits *outside* `completion_tokens` (`total = prompt + candidates + thoughts`), billed at the output rate. `normalizeUsage` recovers it as `total - input - output`; the leftover is 0 for non-thinking models, so nothing is double-counted. It is not a rounding detail: a 133-token answer routinely hides ~3k thinking tokens, so dropping it understated cost several-fold. `IU_USAGE_SCHEMA` in `server/lib/iu-openai.ts` is the single source of truth for both `IuUsage` and every tool's `usage` output field — import it, don't re-declare the shape.

```bash
# Register at user scope — handled by `make setup` in ~/SourceRoot/dotfiles.
# Manual fallback:
claude mcp add --scope user sideclaw -- bun run "$HOME/SourceRoot/sideclaw/server/mcp.ts"

# Structured logs (both HTTP + MCP processes write here)
tail -f ~/Library/Logs/sideclaw.jsonl | jq .
tail -f ~/Library/Logs/sideclaw.jsonl | jq 'select(.source == "mcp")'
```

Inner sessions spawned by MCP tools use `claude -p` routed via `session-runner.ts` (claude-sonnet-5 / claude-haiku-4-5): IU per-token billing by default, or the Max subscription when `SIDECLAW_WORKER_BACKEND=max`. See `.claude/rules/mcp-tools.md` for authoring conventions.

## Git Workflow

Direct-to-master repo — no PRs, no releases.

```
/review   → optional code review before committing
/commit   → commit, then push to master directly
/ship     → review → commit → push (skips PR and release steps)
```

Never create feature branches or PRs for this repo.

## Fullscreen (kiosk mode)

The DiagramPanel fullscreen button tries the native browser Fullscreen API first.
In WebKit-based browsers (e.g. CMUX) that don't expose it, the frontend calls
`GET /api/open-kiosk?url=<current-url>` — the Elysia backend spawns Chrome with
`--kiosk --user-data-dir=/tmp/sideclaw-kiosk` on the host. Tries regular Chrome,
Chromium, then Playwright Chrome for Testing. Falls back to CSS focus mode if
no binary is found. **Exit kiosk:** `Cmd+Q`.

## Project Skills

Project-specific skills live in `.claude/skills/` (tracked in git, unlike most repos).
Settings files (`.claude/settings.json`, `.claude/settings.local.json`) remain gitignored.

| Skill | Purpose |
|-|-|
| `claude-cli` | Reference for spawning `claude -p` subprocesses from Bun/TypeScript |

## Validating UI Changes

In dev: changes reflect immediately via Vite HMR at the dev server port.
In prod: `make build` + reload `http://sideclaw.local` in browser.
Use the Chrome MCP extension for visual validation via screenshots.

