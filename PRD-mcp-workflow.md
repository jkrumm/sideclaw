# sideclaw MCP Workflow Gateway — PRD

## Problem

Claude Code skills today are scattered across `dotfiles/skills/` with no enforcement layer. Any Claude Code session can bypass workflow rules, skip validation, or produce inconsistent output. Specific issues:

- **No structured output** — skills return free-text, making programmatic consumption unreliable
- **No lifecycle tracking** — no way to know if a workflow is pending, running, waiting for input, or done
- **No human-in-the-loop** — ship workflow can't pause for CodeRabbit review or release confirmation
- **No enforcement** — skills are advisory; sessions can run raw git/gh commands directly
- **Naming inconsistencies** — browse vs chrome, otel vs observe, read-drawing vs read-diagram
- **Missing metadata** — skills that should run in isolation lack `context: fork` declarations. Model references are inconsistent across skills.
- **Duplicate maintenance** — skills in dotfiles serve both as instructions and execution, with no separation

## Solution

Sideclaw becomes the **workflow gateway** via an MCP server. Workflow skills (check, review, ship and sub-skills) move from dotfiles into sideclaw, exposed as MCP tools with structured output contracts, lifecycle states, and HITL gates.

### Architecture (proven in Phase 1)

```
Claude Code session (any repo)
  → calls MCP tool (e.g. mcp__sideclaw__check)
  → sideclaw MCP server (stdio, spawned as child process by Claude Code)
  → spawns `claude -p` subprocess via Bun.spawn (Max subscription billing)
  → skill prompt from server/skills/*.md injected, --json-schema enforces output
  → structured result returned as both content (text) + structuredContent (typed)
  → if HITL needed: step completes, question returned, caller responds, next step runs with context injection
```

### Established Patterns (from Phase 1)

These patterns are codified in `.claude/rules/mcp-tools.md` and `.claude/rules/logs.md`. Implementing agents MUST read those rules before adding tools.

- **Single Zod source of truth**: One Zod schema → derive both MCP tool contract + `--json-schema` flag. Never manually sync schemas.
- **Tool registration**: Use `server.registerTool()` (custom wrapper), not `.tool()` directly. See existing `check.ts` for the exact pattern.
- **Dual response**: Return both `content` (text summary) and `structuredContent` (typed JSON) from handlers.
- **Tool descriptions**: Optimize for LLM comprehension — include WHEN TO CALL, READ-ONLY/SIDE EFFECTS, CWD meaning, and OUTPUT description.
- **Session runner**: `server/mcp/session-runner.ts` handles all subprocess spawning. Pre-configured: env hygiene, strict MCP isolation (`--strict-mcp-config --mcp-config '{"mcpServers": {}}'`), `--setting-sources user,project`, no API key.
- **Structured logging**: All events to `/tmp/sideclaw.jsonl` via pino. Every tool start/end logs `{ event, tool, project, durationMs, passed }`.
- **No `console.log()`**: Corrupts MCP stdio. Use the project logger (`server/mcp/logger.ts`), never bare console calls.
- **Skill prompts**: Loaded async from `server/skills/*.md` via `Bun.file(path).text()`. Separate from tool implementation.

### Key Decisions

- **Raw `Bun.spawn` over Agent SDK**: Agent SDK requires API billing. Raw `claude -p` uses Max subscription.
- **No `--resume` for HITL**: Known bugs (cache invalidation, session ID changes, context loss). Use context injection instead.
- **Structured output via `--json-schema`**: `--output-format json` + `--json-schema`. Session runner strips markdown fences and parses `structured_output` field.
- **Auth via subscription**: Never set `ANTHROPIC_API_KEY` in subprocess env.
- **Two process types**: chain-runner (HTTP API, SSE streaming for dashboard) and session-runner (MCP tools, structured JSON results). Both coexist.

### Repo Path & Worktree Handling

Every MCP tool accepts `cwd` as the target repo path. The calling Claude Code session passes its own working directory.

- **Path validation**: MCP server validates `cwd` exists and is a git repo before spawning.
- **Worktrees**: Session runner operates in the worktree's cwd. Git commands work naturally.
- **Inner session settings**: `--setting-sources user,project` — Claude Code walks up from CWD to find CLAUDE.md files. No PERSONAL_REPOS_PATH needed.
- **No circular MCP**: `--strict-mcp-config --mcp-config '{"mcpServers": {}}'` ensures zero MCP servers in inner sessions.

## Non-Goals

- Replacing non-workflow skills (grill, implement, ralph, research, etc.) — those stay in dotfiles
- Building a full agent orchestration framework — this is a thin wrapper, not claude-flow
- Multi-user or remote access — local only, single user
- Replacing the sideclaw dashboard — MCP is a parallel interface, not a replacement

---

## Dependencies

```bash
bun add @modelcontextprotocol/sdk zod pino
```

**Runtime:** Claude Code CLI (`~/.local/bin/claude`) with Max subscription, Bun runtime.

---

## Phase 1: MCP Foundation + Check POC — COMPLETE

**Delivered:**
- `server/mcp.ts` — MCP entry point (stdio transport)
- `server/mcp/session-runner.ts` — reusable `Bun.spawn` wrapper with env hygiene, timeout, JSON parsing
- `server/mcp/tools/check.ts` — check tool (Zod schema, annotations, structured logging)
- `server/mcp/logger.ts` — pino wrapper for MCP context
- `server/skills/check.md` — skill prompt (discovers scripts from package.json, optional fallow)
- `.claude/rules/mcp-tools.md` — authoritative tool authoring guide
- `.claude/rules/logs.md` — structured logging schema (NDJSON)
- MCP registered at user scope

**Check tool:** Input `{ cwd }` → Output `{ passed, steps[], summary }`. Model: haiku. Max 30 turns, 10-minute timeout. Steps: format, lint, typecheck, test, fallow (all discovered, all optional).

---

## Phase 2: Review Tool

**Goal:** Add code review with structured findings and fresh-context isolation.

**Scope:**
- Add `review` tool following the check tool pattern (Zod schema, `server.registerTool()`, dual response, structured logging)
- Write `server/skills/review.md` — review prompt with structured output instructions
- Integrate CodeRabbit CLI (if available, guard with `which coderabbit`)
- Fresh context per invocation (each review is an independent `claude -p` call)
- Model: sonnet (review needs deeper reasoning than haiku)

**Review tool contract:**
- Input: `{ cwd: string, scope?: "uncommitted" | "head" | string }` (default: uncommitted changes)
- Output:
  ```typescript
  {
    blocking: Finding[],      // bugs, security, type errors — must fix
    warnings: Finding[],      // KISS violations, error handling — should fix
    suggestions: Finding[],   // simplifications, style — nice to fix
    testGaps: string[],       // missing test coverage areas
    summary: string
  }
  ```
- Where `Finding = { file: string, line?: number, message: string, rule?: string }`

**Deliverables:**
- `server/mcp/tools/review.ts` — follow check.ts patterns exactly
- `server/skills/review.md` — migrated from dotfiles, adapted for structured JSON
- Validation: run against a repo with known issues, verify structured findings

---

## Phase 3: Ship Workflow with HITL

**Goal:** Orchestrated deployment workflow with lifecycle tracking, human-in-the-loop gates, and smart repo detection.

**Scope:**
- Add `ship` tool as a stateful MCP tool with step-by-step workflow
- Context injection between steps (no `--resume`, no Agent SDK) — each step is a fresh `claude -p` with full history injected
- Ship agent reads repo rules (CLAUDE.md, `.claude/rules/`) to determine workflow (direct-to-master vs PR)
- Lifecycle states: `analyzing` → `committing` → `cleaning_up` → `reviewing` → `creating_pr` / `pushing` → `iterating` → `merging` → `releasing` → `done`
- HITL gates surface structured questions; caller responds with feedback
- No AI attributions anywhere in commits, PRs, or descriptions

**Ship tool contract:**
- Input: `{ cwd: string, feedback?: string, workflowId?: string }`
  - First call: no workflowId (starts workflow)
  - Follow-up calls: workflowId + feedback (continues paused workflow)
- Output:
  ```typescript
  {
    status: "done" | "needs_input" | "running" | "error",
    step: string,
    progress: string,
    questions?: Question[],
    workflowId?: string,
    result?: {
      committed: boolean,
      pr_url?: string,
      merged: boolean,
      released: boolean,
      pushed_to?: string
    }
  }
  ```
- Where `Question = { id: string, text: string, options?: string[], type: "confirm" | "choose" | "freeform" }`

**Smart workflow detection:**
1. Read repo's `.claude/rules/` for git-workflow declarations
2. Check CLAUDE.md for direct-to-master repo lists
3. Accept caller hints as override
4. Default to PR flow if no signal found

**Ship sub-workflows (internal, not separate MCP tools):**
- **Commit**: detect uncommitted changes, generate conventional commit
- **Commit-cleanup**: squash/group noisy commits (if branch has 3+ commits)
- **Review**: run code review (inline or invoke review MCP tool)
- **PR create**: create PR, no AI attribution
- **PR iterate**: poll CodeRabbit, surface blocking items as HITL questions
- **Push**: direct push for direct-to-master repos
- **Release**: discover and trigger release mechanism or skip

**HITL scenarios:**
- CodeRabbit blocking issues → "Fix these 3 items or dismiss?"
- CodeRabbit suggestions → "Apply any of these?" (numbered list)
- Release confirmation → "Release v1.2.3?"
- CI failure → "CI failed on job X. Fix or investigate?"

**Deliverables:**
- `server/mcp/tools/ship.ts` — follow established patterns + in-memory workflow state
- `server/skills/ship.md` — orchestration prompt
- `server/skills/commit.md` — commit sub-skill prompt
- `server/skills/commit-cleanup.md` — commit cleanup sub-skill prompt
- `server/skills/pr.md` — PR sub-skill prompt
- Workflow state storage (in-memory map, keyed by workflowId)

---

## Phase 4: Skill Cleanup & Migration

**Goal:** Rename inconsistent skills, fix metadata, remove duplicates from dotfiles, update all references.

**Renames in dotfiles:**

| Current | New | Reason |
|-|-|-|
| `browse` | `chrome` | Matches actual tool (Chrome DevTools) |
| `otel` | `observe` | More flexible, not tied to OTEL |
| `read-drawing` | `read-diagram` | Consistent naming |
| `git-cleanup` | `commit-cleanup` | Matches diagram and ship workflow |
| `code-quality` | (delete) | Deprecated, replaced by MCP check |

**Metadata fixes in dotfiles:**
- Add `context: fork` to: analyze, read-diagram, observe
- Fix model references where inconsistent
- Update cross-references to use new skill names

**Removals from dotfiles (now MCP-only via sideclaw):**
- `check/`, `review/`, `ship/`, `commit/`, `pr/`, `git-cleanup/`

**Reference updates:**
- Update `SourceRoot/CLAUDE.md`: remove migrated skills, add MCP tools section
- Add aggressive guidance: "Always use MCP tools for validation (lint, format, typecheck, test, fallow), review, ship, and all git operations (commit, push, PR, merge, release). Do not run these as raw skills or direct CLI/git commands."
- Update remaining skills that reference migrated skills by old names

---

## Phase 5: API Layer & UI Integration

**Goal:** Expose MCP tool functionality via Elysia API endpoints and wire into the sideclaw dashboard.

**API endpoints:**
- `POST /api/workflow/check` — trigger check, return structured result
- `POST /api/workflow/review` — trigger review, return findings
- `POST /api/workflow/ship` — start ship workflow
- `POST /api/workflow/ship/:workflowId` — continue ship with feedback
- `GET /api/workflow/ship/:workflowId` — get current ship state
- `GET /api/workflow/ship/:workflowId/stream` — SSE stream of ship progress

**Shared execution layer:**
- Refactor session-runner so both MCP tools and API endpoints use the same core
- Workflow state accessible from both MCP and API contexts

**UI enhancements:**
- Upgrade ChainDrawer for lifecycle state progression
- HITL question presentation (buttons, selects, text inputs)
- Ship pipeline visualization (commit → cleanup → review → PR → iterate → merge → release)
- Structured output display (check: pass/fail table, review: severity-grouped list)

---

## Success Criteria

1. Claude Code session in any repo can call check, review, or ship via MCP and get structured results
2. Ship workflow pauses for human input and resumes correctly via context injection
3. Ship detects repo workflow rules and chooses direct-to-master vs PR automatically
4. No workflow skills remain in dotfiles — MCP is the single path
5. All remaining dotfiles skills have correct names, metadata, and cross-references
6. Sideclaw dashboard can trigger and monitor workflows with HITL interaction

## Technical Risks

- **`--json-schema` reliability**: Keep schemas simple and flat. Session runner retries once on parse failure, falls back to prompt-based JSON extraction.
- **Nested session detection**: Proven solved — env hygiene + `CLAUDE_ENTRYPOINT=worker` (codified in session-runner.ts).
- **Circular MCP**: Proven solved — `--strict-mcp-config --mcp-config '{"mcpServers": {}}'` (codified in session-runner.ts).
- **Auth state**: If CLI OAuth expires, all MCP tools fail. Session runner surfaces auth errors clearly.
- **Context injection token cost**: Each ship step re-sends full history. Mitigation: concise step summaries, haiku for mechanical steps.
- **Inner session CLAUDE.md**: `--setting-sources user,project` loads repo rules. Skill prompt takes precedence; CLAUDE.md provides context.
