# Multi-Angle Review Pipeline

Deep code review via parallel specialist agents, synthesized into a single actionable verdict.

## How It Works

```
Phase 1 — Data Gathering (parallel shell, ~2s)
├── git diff (scope-aware; "uncommitted" also splices in untracked files)
├── fallow audit --quiet (static analysis)
├── coderabbit review --prompt-only
└── package.json (test script detection)

Phase 1.5 — Angle Routing (one claude-sonnet-5 triage session, ~10-20s)
└── Reads the diff, adds content-driven angles on top of the deterministic floor
    (skipped when the caller passes an explicit `angles` list)

Phase 2 — Angle Reviews (parallel claude-sonnet-5 sessions, capped at 3 in flight)
├── Architect           ← always (floor)
├── Senior Dev          ← always (floor)
├── Frontend Expert     ← if .tsx/.jsx/.css in diff (floor)
├── Backend Expert      ← if api/**/*.ts or server/**/*.ts in diff (floor)
├── TypeScript Expert   ← if .ts/.tsx in diff (floor)
├── QA Engineer         ← if project has test script (floor)
├── Security Reviewer   ← router, if the diff touches auth/secrets/input/etc.
├── Performance         ← router, if the diff has hot paths / scaling cost
├── Concurrency         ← router, if the diff has races / shared state / fan-out
├── Data & Migration    ← router, if the diff touches schema/migrations/data
└── API Contract        ← router, if the diff changes public API shape

Phase 2b (parallel sidecar) — Adversary Critic
└── Single non-agentic gpt-5.6-terra call via IU OpenAI transport — the only
    cross-family reviewer in the pipeline. Always runs unless disabled.

Phase 3 — Synthesis (single claude-sonnet-5 session, ~15s)
└── Deduplicates, resolves conflicts, classifies findings
```

## Agent Selection

Selection has two layers. A **deterministic floor** is picked from changed file
extensions (instant, free, always covers the basics). A **triage router** then
adds content-driven angles that file types can't detect — it reads the diff once
on claude-sonnet-5 and returns the extra angles it judges relevant. Total angles are
capped at `MAX_ANGLES` (8); the floor is kept first, router extras fill the rest.

Pass an explicit `angles` array to force a fixed set and skip the router (useful
when re-running a review). The baseline architect + senior-dev are always kept.

### Floor (deterministic, by file extension)

| Agent      | Trigger                         | Focus                                                                            |
| ---------- | ------------------------------- | -------------------------------------------------------------------------------- |
| Architect  | always                          | Structure, coupling, deep modules, ports & adapters, DDD, layer violations       |
| Senior Dev | always                          | Readability, complexity, nesting, Sandi Metz rules, KISS, dead code              |
| Frontend   | `.tsx/.jsx/.css`                | React patterns, re-renders, a11y, UX, SEO, TanStack Query/Router/Start           |
| Backend    | `api/**/*.ts`, `server/**/*.ts` | Elysia patterns (method chaining, encapsulation, guards), API design, validation |
| TypeScript | `.ts/.tsx`                      | Type safety, generics, async, race conditions, null safety                       |
| QA         | `test` script in package.json   | Test coverage gaps (unit/integration/e2e), edge cases, regression risk           |

### Router (content-driven, picked by `router.md` from the diff)

| Agent            | Picked when the diff…                                                          |
| ---------------- | ------------------------------------------------------------------------------ |
| Security         | touches auth, secrets, crypto, input validation, injection, file/env handling  |
| Performance      | adds hot paths, N+1 queries, unbounded work, scaling-sensitive rendering       |
| Concurrency      | adds races, shared mutable state, `Promise.all` fan-out, retries/idempotency   |
| Data & Migration | changes schema, migrations, ORM models, backfills, serialization formats       |
| API Contract     | changes public API shape, request/response schema, versioning, error contracts |

External tools run in parallel with agents:

- **fallow audit** — dead code, complexity, duplication (if installed + remote)
- **CodeRabbit CLI** — additional static analysis (if installed)

## Output Schema

```json
{
  "outcome": "clean | actionable | needs-human",
  "blocking":     [{ "file", "line?", "message", "angle" }],
  "improvements": [{ "file", "line?", "message", "angle" }],
  "discussions":  [{ "file", "line?", "message", "angle" }],
  "testGaps":     ["file — type: scenarios"],
  "summary":      "2-3 sentence assessment"
}
```

### Three-Tier Action Classification

| Category       | Meaning                                    | Who acts                               |
| -------------- | ------------------------------------------ | -------------------------------------- |
| `blocking`     | Bugs, security, type errors, data loss     | Must fix — implementation agent        |
| `improvements` | Code quality, readability, small refactors | Recommended fix — implementation agent |
| `discussions`  | Big refactors, arch changes, tech choices  | Human decides                          |
| `testGaps`     | Missing test coverage                      | Implementation agent writes tests      |

### Outcome Values

| Outcome       | Means                                              | Action                          |
| ------------- | -------------------------------------------------- | ------------------------------- |
| `clean`       | Zero findings                                      | Ship it                         |
| `actionable`  | Has blocking/improvements/testGaps, no discussions | Apply fixes, then ship          |
| `needs-human` | Has discussions                                    | Human reviews discussions first |

## Rule Loading

Each agent loads project context via `--setting-sources user,project`:

- `CLAUDE.md` and `.claude/rules/` at the repo root
- User-level rules with `paths:` frontmatter auto-load based on file types

### Framework-Specific Rules

**Frontend Expert** loads (when triggered):

- `dotfiles/rules/react-best-practices.md` — 69 Vercel React rules
- `dotfiles/rules/tanstack-query.md` — query keys, caching, mutations
- `dotfiles/rules/tanstack-router.md` — type-safe routing, loaders
- `dotfiles/rules/tanstack-start.md` — server functions, SSR, middleware

**Backend Expert** loads (when triggered):

- `dotfiles/rules/elysia.md` — method chaining, encapsulation, validation
- `elysiajs.com/llms.txt` — fetched live for latest API patterns
- Selective reference files from `dotfiles/reference/elysia/` based on what the diff touches

## Cost Profile

All angle + synthesis sessions run on **claude-sonnet-5** via the IU unified
endpoint's native Anthropic transport — IU per-token billing, zero Max quota. The
adversary critic uses the **IU OpenAI transport** (`gpt-5.6-terra`) directly —
also IU per-token, also zero Max, but a different model family so its bias
profile is uncorrelated with the claude-sonnet-5 reviewers.

| Component                                        | Model           |
| ------------------------------------------------ | --------------- |
| 1 router triage session                          | claude-sonnet-5 |
| 2–8 angle sessions (3 in flight)                 | claude-sonnet-5 |
| 1 adversary critic (single HTTPS call, no agent) | gpt-5.6-terra   |
| 1 synthesis session                              | claude-sonnet-5 |

`gpt-5.6-terra` is a reasoning model — it thinks before answering, so it is
slower (~50s) and pricier ($2.50/$15 per 1M, ~$0.08 a review) than the
`gemini-3.5-flash` it replaced, but it is a stronger critic and still a single
call with no agent loop. Two wiring rules are easy to get wrong:

- **`temperature` must not be sent.** It accepts only the default (1) and 400s
  on anything else — and the IU gateway relays that 400 as a _retryable-looking_
  503, so a stray `temperature: 0` burns every `iuFetch` attempt and then fails
  soft, silently dropping the adversary from every review while the pipeline
  still reports green.
- **`reasoning_effort` must be sent.** Omitting it is not a neutral default: it
  behaves as `"none"`, so the model answers with zero thinking while still
  billing at the reasoning tier. The adversary runs at `"high"`
  (`ADVERSARY_EFFORT`). Measured on a real 7.5K-char diff, effort decides how
  deep the critique reaches — `none`/`medium` stopped at a surface offset bug,
  `high` found the subtler token-derivation bug ~50 lines further in; `xhigh`
  doubled the thinking tokens without finding more.

Reasoning tokens bill at the output rate and are folded inside
`completion_tokens`; `normalizeUsage` splits them back out so the ledger shows
real thinking spend (a ~170-token critique carries ~4.3k reasoning tokens)
without counting a token twice.

Wall time: ~60–120s (router adds ~10-20s; phase 2 dominates and is parallel up to
`ANGLE_CONCURRENCY`; the adversary runs in parallel with phase 2, still inside
phase 2's window). Passing an explicit `angles` list skips
the router. Set `SIDECLAW_REVIEW_ADVERSARY=false` to disable the adversary.

### Why the adversary is non-negotiable by default

Every other reviewer in this pipeline is a claude-sonnet-5 session. Same-family
reviewers share correlated blind spots — a consensus of 6 claude-sonnet-5 angles
is not the same signal as 5 claude-sonnet-5 angles + 1 cross-family critic. The adversary runs as a
single HTTPS call (no agent loop, no `claude -p`), so it costs cents and runs
inside phase 2's existing window while killing the implicit self-attribution
bias that same-family multi-reviewer pipelines otherwise carry.

## MCP Integration

Called via the `review` MCP tool:

```
mcp__sideclaw__review({
  cwd: "/path/to/repo",
  scope: "uncommitted",        // or "head", "HEAD~3", "path/to/file.ts"
  context: "add retry logic",  // optional — helps catch goal mismatches
  angles: ["security", "qa"]   // optional — force a fixed set, skip the router
})
```

The `/review` skill and `/ship` orchestrator both invoke this tool.

### Untracked files

Under `scope: "uncommitted"`, untracked non-ignored files (`git ls-files
--others --exclude-standard`) are spliced into the diff as added-file hunks via
`git diff --no-index -- /dev/null <file>`, and listed among the changed files so
angle gating sees them. Plain `git diff` omits them, which made a brand-new file
invisible to the pipeline: the agentic angle workers could still `Read` it off
disk, but the adversary is a single non-agentic call that sees only the diff
text — so a changed file importing a new module handed it an import with no
target and it filed a phantom "file missing / build break" blocking finding.

The other scopes review committed history and deliberately do **not** splice
untracked files in — there, a new file is already part of the commit, and
working-tree files are outside what the caller asked to review.

## File Structure

```
server/skills/review/
├── README.md          ← this file
├── router.md          ← triage router prompt (picks content-driven angles)
├── architect.md       ← architecture angle prompt (floor)
├── senior-dev.md      ← code quality angle prompt (floor)
├── frontend.md        ← React/frontend angle prompt (floor)
├── backend.md         ← Elysia/backend angle prompt (floor)
├── typescript.md      ← type safety angle prompt (floor)
├── qa.md              ← QA/testing angle prompt (floor)
├── security.md        ← security angle prompt (router)
├── performance.md     ← performance angle prompt (router)
├── concurrency.md     ← concurrency angle prompt (router)
├── data-migration.md  ← data & migration angle prompt (router)
├── api-contract.md    ← API contract angle prompt (router)
├── adversary.md       ← adversary critic prompt (cross-family, IU OpenAI transport)
└── synthesis.md       ← synthesis/classification prompt

server/mcp/tools/review.ts  ← pipeline orchestration + output schema
```
