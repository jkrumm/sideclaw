# sideclaw MCP Workflow Gateway — PRD

## Problem

Claude Code skills today are scattered across `claude-local/skills/` with no enforcement layer. Any Claude Code session can bypass workflow rules, skip validation, or produce inconsistent output. Specific issues:

- **No structured output** — skills return free-text, making programmatic consumption unreliable
- **No lifecycle tracking** — no way to know if a workflow is pending, running, waiting for input, or done
- **No human-in-the-loop** — ship workflow can't pause for CodeRabbit review or release confirmation
- **No enforcement** — skills are advisory; sessions can run raw git/gh commands directly
- **Naming inconsistencies** — browse vs chrome, otel vs observe, read-drawing vs read-diagram
- **Missing metadata** — skills that should run in isolation lack `context: fork` declarations (the only options are: no context = inline in main conversation, or `context: fork` = isolated subagent with fresh context). Model references are inconsistent across skills.
- **Duplicate maintenance** — skills in claude-local serve both as instructions and execution, with no separation

## Solution

Sideclaw becomes the **workflow gateway** via an MCP server. Workflow skills (check, review, ship and sub-skills) move from claude-local into sideclaw, exposed as MCP tools with structured output contracts, lifecycle states, and HITL gates.

### Architecture

```
Claude Code session (any repo)
  → calls MCP tool (e.g. "check")
  → sideclaw MCP server (stdio, spawned as child process by Claude Code)
  → spawns `claude -p` subprocess via Bun.spawn (uses Max subscription billing)
  → skill instructions injected as prompt, --json-schema enforces structured output
  → structured result returned to caller
  → if HITL needed (Phase 3): step completes, question returned, caller responds, next step runs with context injection
```

### Key Decisions

- **Raw `Bun.spawn` over Agent SDK**: The Agent SDK (`@anthropic-ai/claude-agent-sdk`) requires API billing. Raw `claude -p` subprocess spawning uses Max subscription automatically. Sideclaw already has `chain-runner.ts` proving this pattern works. Reference patterns in `.claude/skills/claude-cli/` (local, not tracked in git).
- **No `--resume` for HITL**: The `--resume` flag has multiple known bugs (cache invalidation #42338, session ID changes #10806, context loss #3138). Instead, use context injection — each step gets the full history of previous steps and human feedback in the prompt. More tokens but reliable.
- **Structured output via `--json-schema`**: Use `--output-format json` + `--json-schema` for validated JSON output. Falls back to prompt-based JSON extraction if schema validation fails.
- **Auth via subscription**: Never set `ANTHROPIC_API_KEY` in subprocess env. The `claude` binary uses OAuth from the user's Max subscription login.
- **Single ship tool**: One smart `ship` tool that discovers repo rules (CLAUDE.md, .claude/rules/ or git-workflow.md) and decides the workflow (direct-to-master vs PR flow) internally.
- **Skills in sideclaw**: Skill prompts and output schemas live in `sideclaw/server/skills/`, not claude-local. MCP is the only execution path.
- **Reusable core**: The execution layer (session management, structured output parsing) is shared between MCP (now), API endpoints (later), and UI (later).
- **MCP registration**: User scope via `claude mcp add --scope user sideclaw -- bun run server/mcp.ts`.

### Repo Path & Worktree Handling

Every MCP tool accepts `cwd` as the target repo path. The calling Claude Code session passes its own working directory. This must handle:

- **Main repo**: `/Users/johannes.krumm/SourceRoot/sideclaw` — standard case
- **Git worktrees**: `/Users/johannes.krumm/SourceRoot/sideclaw/.worktrees/feature-x` — the session runner operates in the worktree's cwd. Git commands naturally work in worktrees.
- **Path validation**: The MCP server validates that `cwd` exists and is a git repo before spawning a session. Returns structured error if not.
- **No workspace detection needed**: With `--setting-sources user,project`, Claude Code auto-discovers CLAUDE.md files by walking up from CWD. No need for PERSONAL_REPOS_PATH/WORK_REPOS_PATH in the session runner.
- **Inner session settings**: Pass `--setting-sources user,project` so inner sessions load the repo's CLAUDE.md and rules (needed for repo-specific conventions and git workflow detection). Claude Code walks up from CWD to find parent CLAUDE.md files (e.g., SourceRoot/CLAUDE.md).
- **No circular MCP**: Inner sessions must NOT load the sideclaw MCP server (infinite loop). Use `--strict-mcp-config --mcp-config '{}'` to ensure no MCP servers are loaded in inner sessions.

## Non-Goals

- Replacing non-workflow skills (grill, implement, ralph, research, etc.) — those stay in claude-local
- Building a full agent orchestration framework — this is a thin wrapper, not claude-flow
- Multi-user or remote access — local only, single user
- Replacing the sideclaw dashboard — MCP is a parallel interface, not a replacement

---

## Dependencies

```bash
# MCP server framework
bun add @modelcontextprotocol/sdk zod
```

No Agent SDK needed — subprocess spawning uses `Bun.spawn` with the `claude` CLI directly.

**Runtime requirements:**
- Claude Code CLI installed (`~/.local/bin/claude`) with Max subscription authenticated
- Bun runtime (already used by sideclaw)

---

## Phases

### Phase 1: MCP Foundation + Check POC

**Goal:** Prove the architecture end-to-end with the simplest workflow skill. After this phase, you can invoke `check` from any Claude Code session via MCP and get structured pass/fail results.

**Scope:**

1. Install dependencies (`@modelcontextprotocol/sdk`, `zod`)
2. Create MCP server entry point (`server/mcp.ts`) using `@modelcontextprotocol/sdk` with stdio transport
3. Implement the session runner: a reusable module that wraps `Bun.spawn` with `claude -p` and proper flags (cwd, model, --dangerously-skip-permissions, --output-format json, --json-schema, --setting-sources). Evolve from existing `server/lib/chain-runner.ts`.
4. Implement `check` as the first MCP tool with structured input/output schemas
5. Write the check skill prompt (`server/skills/check.md`) — migrated from claude-local, updated for structured JSON output
6. Register the MCP server in Claude Code: `claude mcp add --scope user sideclaw -- bun run /path/to/sideclaw/server/mcp.ts`
7. Validate end-to-end: open a Claude Code session in any repo, call the check MCP tool, verify structured result

**Check tool contract:**
- Input: `{ cwd: string }`
- Output (enforced via `--json-schema` CLI flag):
  ```typescript
  {
    passed: boolean,
    steps: Array<{
      name: string,       // "format" | "lint" | "typecheck" | "test" | "analyze"
      passed: boolean,
      errors?: string[]   // file:line error descriptions
    }>,
    summary: string       // one-line human-readable summary
  }
  ```
- Steps discovered from package.json: format, lint, typecheck, test
- Final step: fallow static analysis against origin HEAD (dead code, duplication in changed files)
- Rule: REPORT all errors in changed files, including pre-existing ones. Do not dismiss errors as "pre-existing" or "from before my changes." The check tool reports only — it does not fix code. But it must surface everything so the implementing agent or developer can fix them.

**Session runner requirements:**
- Wraps `Bun.spawn` with `claude -p` and env hygiene (delete CLAUDE_SESSION_ID, CLAUDE_PARENT_SESSION_ID, set CLAUDE_ENTRYPOINT=worker)
- Accepts: `{ cwd, prompt, model, jsonSchema, maxTurns, timeoutMs }`
- Uses `--dangerously-skip-permissions` for unattended execution
- Uses `--setting-sources user,project` so inner session loads repo CLAUDE.md + rules
- Uses `--output-format json` + `--json-schema` for structured output
- Does NOT set `ANTHROPIC_API_KEY` in env (preserves subscription billing)
- Sets `--max-turns 30` to prevent runaway sessions
- Two-stage timeout: SIGTERM then SIGKILL after 5s
- Returns parsed JSON result or structured error
- All logging via `console.error()` (NOT `console.log()` — corrupts MCP stdio)

**MCP server requirements:**
- Uses `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js` + `StdioServerTransport`
- Tool schemas defined with Zod
- Returns `{ content: [{ type: "text", text: JSON.stringify(result) }] }` from tool handlers
- No `console.log()` anywhere — stderr only for diagnostics

**Deliverables:**
- `server/mcp.ts` — MCP server entry point
- `server/mcp/session-runner.ts` — reusable SDK session wrapper
- `server/mcp/tools/check.ts` — check tool definition + handler
- `server/skills/check.md` — check skill prompt
- MCP registered via `claude mcp add --scope user`
- Working end-to-end: Claude Code session → MCP check → structured result

---

### Phase 2: Review Tool

**Goal:** Add code review with structured findings and fresh-context isolation.

**Scope:**
- Implement `review` as MCP tool with severity-categorized findings
- Migrate review skill prompt from claude-local, add structured output instructions
- Integrate CodeRabbit CLI (if available) as part of the review
- Fresh context per invocation (each review is an independent `claude -p` invocation)

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
- Model: sonnet (review needs deeper reasoning than haiku)

**Deliverables:**
- `server/mcp/tools/review.ts` — review tool definition + handler
- `server/skills/review.md` — review skill prompt with structured output instructions
- Validation: run against a repo with known issues, verify findings are structured and actionable

---

### Phase 3: Ship Workflow with HITL

**Goal:** Orchestrated deployment workflow with lifecycle tracking, human-in-the-loop gates, and smart repo detection.

**Scope:**
- Implement `ship` as a stateful MCP tool with step-by-step workflow and context injection between steps (no `--resume`, no Agent SDK)
- Ship agent reads repo rules (CLAUDE.md, `.claude/rules/`) to determine workflow
- Lifecycle states: `analyzing` → `committing` → `cleaning_up` → `reviewing` → `creating_pr` / `pushing` → `iterating` → `merging` → `releasing` → `done` (commit-cleanup is integral — always runs when branch has 3+ commits)
- HITL gates surface structured questions to the caller when human decision is needed
- Context injection: each step gets full history of previous steps + human feedback in the prompt (no --resume, proven reliable by ruflo pattern)
- No AI attributions anywhere: no CodeRabbit mentions, no Claude mentions, no tool mentions in commits, PRs, or descriptions

**Ship tool contract:**
- Input: `{ cwd: string, feedback?: string, workflowId?: string }` 
  - First call: no workflowId (starts workflow)
  - Follow-up calls: workflowId + feedback (resumes paused workflow)
- Output:
  ```typescript
  {
    status: "done" | "needs_input" | "running" | "error",
    step: string,           // current lifecycle step
    progress: string,       // human-readable progress description
    questions?: Question[], // present to human when status is "needs_input"
    workflowId?: string,     // pass back to resume
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
1. Read repo's `.claude/rules/` for git-workflow declarations (e.g., "push directly to master")
2. Check CLAUDE.md for direct-to-master repo lists
3. Accept caller hints as override
4. Default to PR flow if no signal found

**Ship sub-workflows (internal to the ship agent, not exposed as separate MCP tools):**
- **Commit**: detect uncommitted changes, generate conventional commit
- **Commit-cleanup**: squash/group noisy commits (if branch has 3+ commits)
- **Review**: run code review (inline or via review MCP tool)
- **PR create**: create PR with proper description, no AI attribution
- **PR iterate**: poll CodeRabbit feedback, surface blocking items as HITL questions, fix or dismiss
- **Push**: direct push for direct-to-master repos
- **Release**: discover and trigger release mechanism (GitHub Actions, npm scripts, or skip)

**HITL scenarios:**
- CodeRabbit finds blocking issues → "Fix these 3 items or dismiss?" (with item details)
- CodeRabbit subjective suggestions → "Apply any of these?" (numbered list)
- Release confirmation → "Release v1.2.3? (GitHub Action detected)"
- CI failure → "CI failed on job X: [error]. Fix or investigate?"
- Branch naming → "Branch name 'fix-thing' doesn't describe the PR. Rename?"

**Deliverables:**
- `server/mcp/tools/ship.ts` — ship tool definition + handler with session state
- `server/skills/ship.md` — ship orchestration prompt
- `server/skills/commit.md` — commit sub-skill prompt
- `server/skills/commit-cleanup.md` — commit cleanup sub-skill prompt
- `server/skills/pr.md` — PR sub-skill prompt
- Session state storage (in-memory map, keyed by workflowId)
- Validation: run full ship flow on a test branch with HITL interaction

---

### Phase 4: Skill Cleanup & Migration

**Goal:** Rename inconsistent skills, fix metadata, remove duplicates from claude-local, update all references.

**Scope — Renames in claude-local:**

| Current directory | New directory | New description |
|-|-|-|
| `browse` | `chrome` | Chrome DevTools debugging via subagent |
| `otel` | `observe` | Observability debugging (traces, logs, metrics) |
| `read-drawing` | `read-diagram` | Interpret Excalidraw diagrams |
| `git-cleanup` | `commit-cleanup` | Squash and group branch commits |
| `code-quality` | (delete) | Already deprecated |

**Scope — Metadata fixes in claude-local:**
- Add `context: fork` to skills that need isolation: analyze, read-diagram, observe (there is no `context: subprocess` — only `context: fork` for isolated subagent or no context for inline)
- Fix model references where inconsistent
- Update all internal cross-references (skills that mention other skills by old names)

**Scope — Removals from claude-local:**
- Delete `check/` — now MCP-only via sideclaw
- Delete `review/` — now MCP-only via sideclaw
- Delete `ship/` — now MCP-only via sideclaw
- Delete `commit/` — now sub-skill of ship in sideclaw
- Delete `pr/` — now sub-skill of ship in sideclaw
- Delete `git-cleanup/` (renamed to commit-cleanup, now in sideclaw)

**Scope — Reference updates:**
- Update `SourceRoot/CLAUDE.md` skill table: remove migrated skills, add MCP tools section, note that check/review/ship are MCP-only
- Add aggressive guidance: "Always use MCP tools instead of running lint, format, typecheck, test, or fallow directly (unless explicitly validating a specific unit test). Always use MCP for review. Always use MCP for ship and all git operations (commit, push, PR, merge, release). Do not run these as raw skills, direct CLI commands, or inline git/gh operations."
- Update any skill that references migrated skills by old names (e.g., ship referencing `/check`)
- Update sideclaw CLAUDE.md to document the MCP server

**Deliverables:**
- Renamed skill directories in claude-local
- Deleted migrated skill directories
- Updated CLAUDE.md files (SourceRoot + sideclaw)
- Updated cross-references in remaining skills
- Validation: all remaining skills have correct metadata, no broken references

---

### Phase 5: API Layer & UI Integration

**Goal:** Expose MCP tool functionality via Elysia API endpoints and wire into the sideclaw dashboard.

**Scope — API endpoints:**
- `POST /api/workflow/check` — trigger check, return structured result
- `POST /api/workflow/review` — trigger review, return findings
- `POST /api/workflow/ship` — start ship workflow
- `POST /api/workflow/ship/:workflowId` — continue ship with feedback
- `GET /api/workflow/ship/:workflowId` — get current ship state
- `GET /api/workflow/ship/:workflowId/stream` — SSE stream of ship progress

**Scope — Shared execution layer:**
- Refactor session-runner so both MCP tools and API endpoints use the same core
- Session state accessible from both MCP and API contexts

**Scope — UI enhancements:**
- Upgrade ChainDrawer to understand lifecycle states (show step progression)
- HITL question presentation: render questions as interactive UI elements (buttons, selects, text inputs)
- Ship workflow dashboard: visual pipeline (commit → cleanup → review → PR → iterate → merge → release) with current step highlighted
- Structured output display: check results as pass/fail table, review findings as severity-grouped list

**Deliverables:**
- `server/routes/workflow.ts` — API endpoints
- Updated ChainDrawer component with lifecycle awareness
- HITL question UI components
- Ship pipeline visualization
- Validation: full workflow from sideclaw UI with HITL interaction

---

## Success Criteria

1. A Claude Code session in any repo can call `check`, `review`, or `ship` via MCP and get structured results
2. Ship workflow pauses for human input and resumes correctly
3. Ship detects repo workflow rules and chooses direct-to-master vs PR automatically
4. No workflow skills remain in claude-local — MCP is the single path
5. All remaining claude-local skills have correct names, metadata, and cross-references
6. Sideclaw dashboard can trigger and monitor workflows with HITL interaction

## Technical Risks

- **`--json-schema` reliability**: Claude may fail to produce valid JSON matching complex schemas. Mitigation: keep schemas simple (flat, few required fields), validate returned JSON, retry once on failure. Fall back to prompt-based JSON extraction.
- **MCP stdio lifecycle**: MCP servers are spawned per Claude Code session as child processes, not long-running services. The sideclaw Elysia server (LaunchAgent) and the MCP server are separate processes — they share the codebase but run independently.
- **Nested session detection**: Spawning `claude -p` from within an MCP server (which itself was spawned by Claude Code) requires env hygiene — delete `CLAUDE_SESSION_ID`, `CLAUDE_PARENT_SESSION_ID`, set `CLAUDE_ENTRYPOINT=worker`. Proven pattern from ruflo.
- **Auth state**: If the CLI's OAuth session expires, all MCP tools fail. Mitigation: session runner catches auth errors and returns clear error messages.
- **Context injection token cost**: Each ship step re-sends the full history of previous steps. For a 7-step workflow, the last step includes all prior context. Mitigation: keep step summaries concise; use haiku for mechanical steps.
- **Inner session CLAUDE.md loading**: With `--setting-sources user,project`, the inner session loads repo rules. Needed for git workflow detection but the inner session may see conflicting instructions. Mitigation: the skill prompt takes precedence; CLAUDE.md provides context only.
- **No `console.log()`**: Any stdout output from the MCP server corrupts the JSON-RPC stream. All logging must use `console.error()`. This affects debugging — use stderr-based logging throughout.
- **Circular MCP**: Inner `claude -p` sessions must not load the sideclaw MCP server (infinite loop). Use `--strict-mcp-config --mcp-config '{}'` to ensure zero MCP servers in inner sessions.
