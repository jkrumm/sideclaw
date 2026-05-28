# Multi-Angle Review Pipeline

Deep code review via parallel specialist agents, synthesized into a single actionable verdict.

## How It Works

```
Phase 1 — Data Gathering (parallel shell, ~2s)
├── git diff (scope-aware)
├── fallow audit --quiet (static analysis)
├── coderabbit review --prompt-only
└── package.json (test script detection)

Phase 1.5 — Angle Routing (one Kimi-K2.6 triage session, ~10-20s)
└── Reads the diff, adds content-driven angles on top of the deterministic floor
    (skipped when the caller passes an explicit `angles` list)

Phase 2 — Angle Reviews (parallel Kimi-K2.6 sessions, capped at 3 in flight)
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
└── Single non-agentic gemini-3.5-flash call via IU OpenAI transport — the only
    cross-family reviewer in the pipeline. Always runs unless disabled.

Phase 3 — Synthesis (single Kimi-K2.6 session, ~15s)
└── Deduplicates, resolves conflicts, classifies findings
```

## Agent Selection

Selection has two layers. A **deterministic floor** is picked from changed file
extensions (instant, free, always covers the basics). A **triage router** then
adds content-driven angles that file types can't detect — it reads the diff once
on Kimi-K2.6 and returns the extra angles it judges relevant. Total angles are
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

All angle + synthesis sessions run on **Kimi-K2.6** (EU/GDPR) via the LiteLLM
bridge — IU per-token billing, zero Max quota. The adversary critic uses the
**IU OpenAI transport** (`gemini-3.5-flash`) directly — also IU per-token, also
zero Max, but a different model family so its bias profile is uncorrelated with
the Kimi reviewers.

| Component                                          | Model              |
| -------------------------------------------------- | ------------------ |
| 1 router triage session                            | Kimi-K2.6          |
| 2–8 angle sessions (3 in flight)                   | Kimi-K2.6          |
| 1 adversary critic (single HTTPS call, no agent)   | gemini-3.5-flash   |
| 1 synthesis session                                | Kimi-K2.6          |

Wall time: ~60–120s (router adds ~10-20s; phase 2 dominates and is parallel up to
`ANGLE_CONCURRENCY`; the adversary runs in parallel with phase 2 and finishes in
~5–10s, so it doesn't extend wall time). Passing an explicit `angles` list skips
the router. Set `SIDECLAW_REVIEW_ADVERSARY=false` to disable the adversary.

### Why the adversary is non-negotiable by default

Every other reviewer in this pipeline is a Kimi-K2.6 session. Same-family
reviewers share correlated blind spots — a consensus of 6 Kimi angles is not the
same signal as 5 Kimi angles + 1 cross-family critic. The adversary runs as a
single HTTPS call (no agent loop, no `claude -p`), so it costs cents and adds no
wall-time overhead while killing the implicit self-attribution bias that
same-family multi-reviewer pipelines otherwise carry.

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
