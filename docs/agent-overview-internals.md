# agents / overview / narrative — implementation detail

Full design rationale for the three `GET /api/agents*` producers. CLAUDE.md
keeps the contract (endpoints, key fields, caps, model routing); this is the
"why" behind the merge/enrichment/prompt-fencing mechanics — read on demand
when touching `server/lib/agents.ts`, `server/jobs/handlers/{overview,
narrative}.ts`.

## agents — the deterministic snapshot

`GET /api/agents` and `GET /api/agents.txt` (`server/lib/agents.ts`,
`server/routes/agents.ts`) are a **deterministic, read-only, no-LLM** snapshot
of every Claude Code agent on this Mac mini, grouped by project — the single
producer behind an agent overview rendered by Hermes, an Argo dashboard, a
brain page and a herdr pane. Unlike `check`/`review`/`dispatch` it is plain
synchronous HTTP, not a job: no queue, no worker session, answers in one
request.

- **Sources, merged by Claude sessionId:** `herdr agent list` (panes) +
  `herdr workspace list` (workspace_id → project label), `claude agents --json`
  (Claude's own registry, including `claude --bg` daemons with no herdr
  pane), and this server's own dispatch job store (`listJobRecords`). A herdr
  pane and a `claude agents` entry sharing a sessionId collapse into one
  entry; herdr's identity wins (source stays `"herdr"`), both raw statuses
  are kept.
- **Per-agent `state`** (`needs_you > working > stale > idle > done >
  unknown`, see `deriveState()`'s doc comment) is the only field consumers
  should branch on — `herdrStatus`/`claudeStatus` are raw passthrough for
  debugging, not a second source of truth. `SIDECLAW_AGENT_STALE_HOURS`
  (default 24) sets the stale threshold. A dispatch job's own needs-human
  verdict is **not** distinguished into `needs_you` — that signal isn't
  cheaply available without a tool-specific parse of `job.result`, so a
  dispatch entry only ever resolves to working/done/unknown (noted, not
  fixed, in this pass).
- **Session transcript reads are tail-only, progressively**
  (`readSessionTail` → `readTranscriptTailFile`): transcripts reach 16 MB, so
  only the tail of `~/.claude/projects/<encoded cwd>/<sessionId>.jsonl` is
  read (cwd encoded by replacing every non-alphanumeric character with `-`),
  never the whole file — **512 KB, growing to 8 MB when the tail lands
  inside an oversized line** (e.g. an extended-thinking signature blob larger
  than the window, which otherwise pushes every parseable assistant/user
  line out of it). A missing transcript yields nulls, never a thrown error.
  File **mtime is never used** as an activity signal: Claude Code touches an
  idle session's transcript file (measured — a session last active
  2026-09-04 had today's mtime), so mtime tracks process residency, not the
  user.
- **No MCP tool for this** — HTTP-only for now. A read-only MCP tool would
  cost every session a deferred tool name for something no session needs to
  call itself; the intended callers are external services polling over HTTP.
- **`?color=1` (also `?ansi=1`) on `/api/agents.txt` and `/api/overview.txt`**
  opts into an ANSI-coloured render (SGR only) — the herdr `overview` pane
  runs `watch --color` against it. Plain output with no query is
  byte-identical to before the flag existed.
- **`?cols=N` (40–200, default 110)** re-derives every visible-width budget
  from a narrower terminal width — a phone-width `watch` pane. Title/standing
  caps shrink with it, the project line drops `[N agents]` below cols 90, and
  the header splits into two lines below cols 100. Omitting `cols` keeps the
  legacy fixed 110-char clamp untouched.
- The server binds **`127.0.0.1` only** (`server/index.ts`), so this endpoint
  is reachable from this machine alone — it carries no auth of its own, and
  there is **no tailnet door**: `~/.config/caddy-tailnet.ports` explicitly
  `exclude sideclaw`, precisely because that missing auth would let any
  tailnet node `POST /api/jobs` with `dispatch implement` otherwise. Don't
  restore a `sideclaw.mini.jkrumm.com` block.
- **`humanQueue`** (top-level in the snapshot): every pending
  `ask-human.sh` request (`~/.local/state/human-queue/*.req` with no `.res`,
  `readHumanQueue` in `agents.ts`), as `{ id, askedAt, question, cmd }`,
  newest first. `renderText` shows it as a `needs you (human queue: N)` block
  right under the header. Deterministic data — it is **never** part of the
  `overview` LLM prompt (`buildAgentFacts` reads only `projects`).
- **Snapshot cache, 45 s** (`cachedBuildSnapshot`, `server/lib/overview-payload.ts`):
  the herdr pane, Hermes and the Argo push all poll within seconds of each
  other and share one build. 45 s, not 20 — the measured poll interval is
  ~31 s, so the old TTL expired before the next caller arrived and the cache
  never hit.
- **Argo push** (`server/lib/argo-push.ts`): after every completed `overview`
  job and every 10 min, `POST ${ARGO_URL:-https://argo.jkrumm.com/api}/agents/overview`
  with the same JSON `GET /api/overview` returns (plus `machine: "mini"`,
  `generatedAt`), bearer from `secrets-run read op://common/api/SECRET`
  (cached in memory; a failed resolve is not cached). Never fatal — one
  `app.argo_push` log line with `status`.
- Pure units (`encodeProjectDir`, `parseTranscriptTail`, `deriveState`,
  `mergeAgents`, `renderText`) are covered by `tests/agents.test.ts` — no
  subprocess, no mocks, per repo convention.
- `buildSnapshot` (the single producer above) lives in `server/lib/agents.ts`
  itself — the `overview` job below calls it in-process, not over HTTP, to
  avoid looping back into its own server.

## overview — the LLM triage pass

The `overview` job (`server/jobs/handlers/overview.ts`, MCP tool +
`GET /api/overview` / `GET /api/overview.txt` in `server/routes/agents.ts`)
enriches the deterministic `agents` snapshot above with **one LLM
recommendation per agent** — a batched, single-call, prompt-only triage pass,
unlike `check`/`review`/`dispatch` it never touches a repo or a file: every
fact the worker needs (project git status, agent state, transcript excerpts)
is already assembled into the prompt by the handler.

- **The recommendation enum**, one value per agent, from evidence only:
  `answer` (blocked on a question/dialog/permission — reply to it),
  `continue` (idle mid-task, clear next step, safe to send "continue"),
  `ship` (done but uncommitted/unpushed/ahead of origin — commit/push),
  `review` (pushed, needs a code review or human QA), `merge` (a PR/branch is
  ready to merge), `close` (finished, nothing pending), `stale`
  (abandoned/superseded, no clear next step), `watch` (actively working,
  nothing to do — **the default when the model is unsure**). Each entry also
  carries `standing` (≤120 chars, present tense, what the agent is actually
  doing), `blocker` (≤80 chars or null) and `confidence` (`high`/`medium`/`low`).
- **Model/backend come from `routeFor("overview")`** — glm-5.3-flash on IU,
  Haiku-on-Max as the reverse lane — this is classification over a prompt,
  not code judgment, the same reasoning that put `check` on the cheap tier.
  Override via the job's `model` input param (`withModel`); a gateway id can
  never land on Max.
- **One batched `runSession` call for the whole fleet**, not one per agent —
  cheaper and lets the model reason about relative priority across agents.
  `readOnly: true` plus `extraDisallowedTools: ["Bash", "Read", "Grep",
  "Glob"]` make it prompt-only: the worker cannot read a file or shell out,
  only reason over what the handler already gave it. `maxTurns: 3`, 120s
  timeout — there is no discovery to do.
- **Nonce-fenced facts, same pattern as dispatch's brief hardening**
  (`buildPrompt` in `overview.ts`): the facts block quotes transcript
  excerpts (a user's prompts, an assistant's own replies), which is
  model-generated text the worker's own session did not produce this run, so
  it is fenced with a per-run random delimiter (`newFenceNonce`) and the
  constraints are re-asserted AFTER the data block, not just before it.
- **Reconciliation is two separate passes.** At job-completion time,
  `reconcileOverview` merges the worker's per-agent verdicts onto the
  snapshot's own agent ids: an id the worker invented is dropped (logged
  `overview.unknown_agent_id`); an id present in the snapshot but omitted by
  the worker is synthesized to `recommendation: "watch"`, `standing: null`,
  `confidence: "low"`, `synthesized: true` rather than silently missing.
  Separately, at request time, `mergeOverviewIntoSnapshot` merges the
  *latest cached* job result onto a *fresh* snapshot for `GET /api/overview`.
- **`GET /api/overview` / `GET /api/overview.txt` never run the LLM inline.**
  They take a fresh deterministic snapshot and merge the newest **completed**
  `overview` job's result onto it by agent id (`latestJobResult("overview")`
  in `server/jobs/store.ts`, re-validated against `OVERVIEW_OUTPUT` — a
  schema-drifted old cached job degrades to "no cached overview", never a
  500). An agent that has been active more recently than the cached job ran
  (`cached.generatedAt < agent.lastActivityAt`) gets its recommendation
  fields nulled and `recommendationStale: true` instead of presenting a stale
  verdict as current — call the `overview` job again to refresh it. JSON
  response: `{ ok, data: { ...snapshot, overview: { generatedAt, model,
  ageMs } | null } }`, with `recommendation`/`standing`/`blocker`/
  `confidence`/`recommendationStale` merged directly onto each agent object.
- **`renderText` (agents.ts) takes an optional `enrichment` map + `overview`
  meta** rather than a duplicated renderer: called with no `opts` (the plain
  `/api/agents.txt` path) it is byte-identical to before enrichment existed.
  With enrichment, the state icon is replaced by the recommendation icon
  (`answer`→`?!`, `continue`→`→`, `ship`→`⇧`, `review`→`⚑`, `merge`→`⇄`,
  `close`→`✓`, `stale`→`·`, `watch`→`●`), a non-null `standing` gets an
  indented second line (≤110 chars, truncated), and the header gains
  `· overview <age>` / `· overview none`. The header line itself is
  deliberately **not** run through the shared 110-char `clampLine` (that cap
  exists to bound externally-influenced agent text, not the handler's own
  bounded summary line) — clamping it would silently drop the overview
  suffix on every call, since the base header (~100 chars) plus the suffix
  (~15-18 chars) already exceeds 110.
- Pure units (`buildAgentFacts`, `buildPrompt`, `newFenceNonce`,
  `reconcileOverview`, `mergeOverviewIntoSnapshot`, plus `renderText`'s
  enrichment path) are covered by `tests/overview.test.ts` — no subprocess,
  no mocks, mutation-verified on the unknown-id-drop and the
  standing-line-truncation bound.

## Warden block — the ledger, folded into the overview

`server/lib/warden-board.ts`'s `fetchWardenBoard()` normalizes warden's
`GET /board` (`http://127.0.0.1:7734`, loopback-only, unauthenticated,
read-only — `~/SourceRoot/warden/docs/api.md`) into the shape
`overview-payload.ts` and `renderText` consume: `counts` per non-terminal
chain state, `open` (the sum of those counts), and up to 20 items
(`updated_at DESC`, `itemsTruncated` when more existed), each carrying one
`inFlightJob` id (`validation_job ?? implement_job ?? dispatch_job ?? null`).
A 2 s `AbortSignal.timeout` bounds the call, and it **never throws** — an
unreachable/non-2xx/malformed warden resolves to `{ ok: false, error }`
rather than delaying or failing the overview it's folded into.

`buildOverviewPayload` fetches it alongside the agents snapshot, cached
under the same 45 s TTL (`cachedFetchWardenBoard`, mirroring
`cachedBuildSnapshot`) — a herdr pane and Hermes polling the overview back
to back never pay for two live warden round trips. It rides on the
`OverviewPayload.warden` field, so **Argo's push receives it automatically**
inside the same JSON `pushOverviewToArgo` already sends — no second payload
shape. `GET /api/agents`/`/api/agents.txt` never fetch it; only the
`overview` routes and the Argo push do.

`renderText` (`server/lib/agents.ts`) takes it as `opts.warden` and just
calls `renderWardenBlock` (`server/lib/warden-board.ts`) for the block after
the agent roster — a header (`warden · <open> open · needs_human <n> ·
merge_blocked <n> · in flight <n>`, in-flight =
investigating+implementing+validating+liveness_pending) then up to 8 item
lines, `needs_human` and `merge_blocked` sharing bucket 0 (a human is needed
for either), then in-flight states, then the rest, plus a trailing `… N
more` line once more items exist than the 8-line cap — colour puts
`needs_human`/`merge_blocked` in the "needs you" red and in-flight in
"working" green. Every warden-sourced string (`state`/`repo`/`title`, and
the unreachable-board `error`) passes through `stripControlBytes` before
rendering — warden's ledger carries attacker-influenced text (an alert or a
GitHub issue title). `opts.warden` omitted (old snapshots, the plain
`/api/agents.txt` path) drops the block entirely; `{ ok: false }` renders
the single line `warden · unreachable (<error>)`. Tests:
`tests/warden-board.test.ts` (the fetch/parse boundary, stubbed `fetch`, the
cache TTL) and `tests/agents.test.ts` (the render — ordering, truncation,
the `… N more` line, colour, the control-byte strip, the no-`opts.warden`
no-op).

## narrative — the vault-page writer

The `narrative` job (`server/jobs/handlers/narrative.ts`, prompt in
`server/skills/narrative.md`) writes or revises ONE project's narrative page
for the Obsidian vault: what the project is, where it stands, how it got
here — business terms, never a changelog. Built for Hermes to run on a daily
cron across tracked projects (or on an explicit "update this project's
narrative"), never inline in an interactive session.

- **Contract is fixed — Hermes builds against it.** Input `{ cwd, project,
  previousPage, since, model? }`; output `{ project, changed, reason,
  summary, page, sections, inputs, model, backend? }`. `previousPage` is the
  full existing markdown (or `null` on a first run); `since` is an ISO cutoff
  (`null` bootstraps from history). `page` and `summary` are `null` when
  `changed` is `false` — that is success, not a degraded result.
- **Less is more, by design.** If nothing substantive happened (only
  formatting/deps/docs-only/chores), the job returns `changed: false` with no
  page — enforced at two levels: the deterministic gate below (zero commits
  and zero sessions never even calls the model) and the skill prompt's
  explicit instruction that "nothing changed" is a correct, default-ish
  answer, not a failure to justify.
- **Deterministic gathering happens in the handler, before the model runs** —
  same argument as `overview`/`dispatch`: discovery is the dominant
  turn-sink, so the worker gets pre-assembled facts, never repo tools. Three
  sources, each capped:
  - **Commits** — `git log --no-merges`, format `%h %cI %s%n%b`, oldest
    dropped once the total exceeds **30 KB**. Bootstrap (`since: null`)
    intersects a **120-commit** limit with a **180-day** `--since` — git
    applies both as AND, which is exactly "whichever is smaller".
  - **Session prose** — `~/.claude/projects/<encodeProjectDir(cwd)>/*.jsonl`
    newer than `since` (bootstrap: newest 12 files, no date filter), each
    read via a **1 MB tail slice** (never the full, up to 16 MB, transcript —
    same discipline as `agents.ts`'s `readTranscriptTailFile`, just a fixed
    slice rather than a progressive one since this only needs prose, not a
    timestamp). Per session: the **last 3** assistant text blocks ≥200 chars
    (closing summaries) plus the session's `ai-title`; files under 4 KB are
    skipped outright, and a file yielding neither a title nor a long block
    consumes no budget. Newest sessions first, capped at **40 KB** total.
  - **`voice.md`** (`/Users/jkrumm/SourceRoot/brain/voice.md`, capped 12 KB) —
    the vault's prose rules, included **verbatim, outside the untrusted-data
    fence** (it's user-authored, trusted, and functions as part of the rules,
    not data to reason about).
- **Nonce-fenced like `overview`** (`buildNarrativePrompt`): commits, session
  excerpts and the previous page are all untrusted text that ultimately
  originated inside a coding session (a commit message, a transcript
  excerpt, a prior model-written page), so they're wrapped in one
  `<<<NARRATIVE_<nonce>_BEGIN/END>>>` block and the constraints are
  re-asserted AFTER the data, same as `overview`'s
  `newFenceNonce`/`buildPrompt` (duplicated locally rather than imported —
  the handlers are otherwise uncoupled).
- **Caps are enforced in code, not trusted from the model**: `clampSections`
  truncates `whatItIs` (≤450 chars), `whereItStands` (≤5×160),
  `openQuestions` (≤3×140), and `howItGotHere` (≤8×180 — kept entries are the
  **most recent** 8, since the list is oldest→newest and the current arc
  matters more than the earliest history). `stripInventedLinks` removes any
  `[[wikilink]]` the model invents (unwrapped to its display text — a link to
  a page that doesn't exist is a vault lint ERROR) and strips HTML comments;
  markdown itself is never escaped.
- **Malformed JSON gets exactly one retry**, same discipline as `review`'s
  synthesis salvage and `check`'s `noOutput` retry: a fresh call with a
  hardened JSON-only directive appended, then the job throws — never a
  degraded-but-confident-looking verdict.
- **Rendering is deterministic** (`renderNarrativePage`): frontmatter carries
  `type: project-narrative`, `description` (the first sentence of
  `whatItIs`, ≤160 chars), `tags: [project, engineering, narrative]`,
  `timestamp` (`YYYY-MM-DD`), `repo` (cwd basename), `revised_from` (`since`
  or `"bootstrap"`), `generated_by: sideclaw/narrative`. String frontmatter
  values are double-quoted (`yamlString`) since generated prose routinely
  contains a colon-space, which breaks an unquoted YAML flow scalar. The
  `## Open questions` section is omitted entirely when the model returned
  none — not an empty heading.
- **Model/backend come from `routeFor("narrative")`** — `claude-sonnet-5[1m]`
  on IU, same model on Max as the reverse lane — this is editorial judgment
  over a prompt, not classification, the opposite reasoning from
  `overview`'s cheap tier. A daily cron pass across several projects spends
  real tokens, so callers should not invoke it speculatively.
- Pure units (`clampSections`, `stripInventedLinks`, `extractSessionProse`,
  `buildNarrativePrompt`, `renderNarrativePage`) are covered by
  `tests/narrative.test.ts` — no subprocess, no mocks, mutation-verified on
  the `howItGotHere` recency cap, the wikilink strip, and the tool-result/
  user-line exclusion in prose extraction, same convention as
  `overview`/`dispatch`.
