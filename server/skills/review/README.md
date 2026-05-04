# Multi-Angle Review Pipeline

Deep code review via parallel specialist agents, synthesized into a single actionable verdict.

## How It Works

```
Phase 1 — Data Gathering (parallel shell, ~2s)
├── git diff (scope-aware)
├── fallow audit --quiet (static analysis)
├── coderabbit review --prompt-only
└── package.json (test script detection)

Phase 2 — Angle Reviews (parallel haiku sessions, ~30-60s)
├── Architect          ← always
├── Senior Dev         ← always
├── Frontend Expert    ← if .tsx/.jsx/.css in diff
├── Backend Expert     ← if api/**/*.ts or server/**/*.ts in diff
├── TypeScript Expert  ← if .ts/.tsx in diff
└── QA Engineer        ← if project has test script

Phase 3 — Synthesis (single sonnet session, ~15s)
└── Deduplicates, resolves conflicts, classifies findings
```

## Agent Selection

Detection is automatic based on changed file extensions:

| Agent | Trigger | Focus |
|-|-|-|
| Architect | always | Structure, coupling, deep modules, ports & adapters, DDD, layer violations |
| Senior Dev | always | Readability, complexity, nesting, Sandi Metz rules, KISS, dead code |
| Frontend | `.tsx/.jsx/.css` | React patterns, re-renders, a11y, UX, SEO, TanStack Query/Router/Start |
| Backend | `api/**/*.ts`, `server/**/*.ts` | Elysia patterns (method chaining, encapsulation, guards), API design, validation |
| TypeScript | `.ts/.tsx` | Type safety, generics, async, race conditions, null safety |
| QA | `test` script in package.json | Test coverage gaps (unit/integration/e2e), edge cases, regression risk |

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

| Category | Meaning | Who acts |
|-|-|-|
| `blocking` | Bugs, security, type errors, data loss | Must fix — implementation agent |
| `improvements` | Code quality, readability, small refactors | Recommended fix — implementation agent |
| `discussions` | Big refactors, arch changes, tech choices | Human decides |
| `testGaps` | Missing test coverage | Implementation agent writes tests |

### Outcome Values

| Outcome | Means | Action |
|-|-|-|
| `clean` | Zero findings | Ship it |
| `actionable` | Has blocking/improvements/testGaps, no discussions | Apply fixes, then ship |
| `needs-human` | Has discussions | Human reviews discussions first |

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

| Component | Model | Cost |
|-|-|-|
| 2-6 angle sessions (parallel) | haiku | ~$0.01-0.03 |
| 1 synthesis session | sonnet | ~$0.02 |
| **Total** | | **~$0.03-0.05 per review** |

Wall time: ~45-90s (phases 2+3 dominate, phase 2 is parallel).

## MCP Integration

Called via the `review` MCP tool:

```
mcp__sideclaw__review({
  cwd: "/path/to/repo",
  scope: "uncommitted",        // or "head", "HEAD~3", "path/to/file.ts"
  context: "add retry logic"   // optional — helps catch goal mismatches
})
```

The `/review` skill and `/ship` orchestrator both invoke this tool.

## File Structure

```
server/skills/review/
├── README.md          ← this file
├── architect.md       ← architecture angle prompt
├── senior-dev.md      ← code quality angle prompt
├── frontend.md        ← React/frontend angle prompt
├── backend.md         ← Elysia/backend angle prompt
├── typescript.md      ← type safety angle prompt
├── qa.md              ← QA/testing angle prompt
└── synthesis.md       ← synthesis/classification prompt

server/mcp/tools/review.ts  ← pipeline orchestration + output schema
```
