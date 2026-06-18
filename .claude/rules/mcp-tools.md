# MCP Tool Authoring Rules

These rules apply to all MCP tools in `server/mcp/tools/`.
Descriptions are read by LLMs, not humans — optimize for semantic precision over prose.

## Registration API

Always use `server.registerTool()` — `server.tool()` is deprecated in SDK 1.29+.

```typescript
server.registerTool("name", {
  title: "Human-readable title",
  description: "...",      // LLM-facing — see below
  inputSchema: { ... },    // Zod shape (not z.object())
  outputSchema: { ... },   // Zod shape — enables typed structuredContent return
  annotations: {
    readOnlyHint: true,    // does not modify state
    idempotentHint: true,  // safe to retry
    destructiveHint: false,
  },
}, handler);
```

## Tool Description

The description is shown to the calling LLM in its tool list. Include:

1. **One-line action** — what it does, not how
2. `WHEN TO CALL:` — trigger conditions (makes invocation decision easier)
3. `READ-ONLY:` or `SIDE EFFECTS:` — safety profile
4. `CWD:` (if applicable) — clarify what path to pass, especially for multi-repo use
5. `OUTPUT:` — key fields to inspect and what they mean
6. Any silent skip / default behavior the caller should know about

Example pattern:
```
Run X and return structured Y.

WHEN TO CALL: before committing, before PR, or when validating Z.
READ-ONLY: never modifies files. Safe to retry.
CWD: absolute path of the target repo — not necessarily this session's CWD.
OUTPUT: check `passed` first. If false, inspect `steps[n].errors` for error lines.
```

## Parameter Descriptions

`.describe()` on every Zod field. Include format, constraints, and examples where non-obvious:

```typescript
cwd: z.string().describe(
  "Absolute path to the git repo root. Must be an existing git repository. Supports git worktrees."
)
```

## Output Schema (outputSchema)

Define `outputSchema` as a Zod shape — the SDK validates and exposes this as the typed tool contract.
Return both `content` (text blob) and `structuredContent` (typed object) from the handler:

```typescript
return {
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data as Record<string, unknown>,
};
```

`structuredContent` is what modern MCP clients receive as the typed result.
`content` is the text fallback for older clients and human display.

## Output Schema — Single Source of Truth

Define the output schema once as `z.object(...)` and derive both the MCP contract and the `--json-schema` CLI flag from it. Never maintain two parallel schema definitions.

```typescript
const MY_OUTPUT = z.object({
  passed: z.boolean().describe("..."),
  // ...
});

// MCP typed contract — use .shape for ZodRawShapeCompat
outputSchema: MY_OUTPUT.shape,

// claude --json-schema flag — derived, never drifts
const MY_JSON_SCHEMA = z.toJSONSchema(MY_OUTPUT);
```

`z.toJSONSchema()` is built into Zod v4 — no extra package needed.

## Fallow Static Analysis

`fallow audit` is the correct command for changed-file analysis (auto-detects base branch):

```bash
fallow audit --quiet   # runs dead-code + complexity + duplication on changed files
```

Guard before running:
1. `which fallow` — skip if not installed
2. `git remote -v | grep -q .` — skip if no remote (fallow audit needs a git base ref)

Treat verdict "pass" or "warn" as passed. Treat verdict "fail" as a failed step.
`fallow diff` does not exist — it's `fallow audit`.

## Session Runner

All tools spawn inner `claude -p` sessions via `runSession()` from `server/mcp/session-runner.ts`.

Key requirements (already handled by the runner):
- **All workers route through the LiteLLM bridge** (`:4000`), never the Max subscription. The runner injects `ANTHROPIC_BASE_URL=http://localhost:4000` + a dummy `ANTHROPIC_AUTH_TOKEN` (LiteLLM is unauthenticated, but claude requires a non-empty token) + `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`, and deletes `ANTHROPIC_API_KEY`. Default model `DeepSeek-V4-Pro` (failover `claude-sonnet-4-6-eu` inside LiteLLM). A bridge liveness check fails fast with a clear error if `:4000` is down.
- `--strict-mcp-config --mcp-config '{"mcpServers": {}}'` — prevents circular MCP (empty `{}` is invalid schema)
- `--setting-sources` defaults to `project` (small uncached system prompt — bridge calls have no prompt caching); pass `settingSources: "user,project"` where global rules matter (`review`, `implement`)
- `readOnly: true` → `--allowedTools "Read,Bash,Grep,Glob"` so Edit/Write are unavailable. Required for read-only tools (`check`/`review`) — bridge workers edit files under `--dangerously-skip-permissions` otherwise
- `extraEnv` merges extra vars into the worker (e.g. `TAVILY_API_KEY` for `review`)
- `WebSearch`/`WebFetch` do not work through the bridge (internal Anthropic-model calls) — do web access via Bash (Tavily/curl/Context7)
- Delete `CLAUDE_SESSION_ID`, `CLAUDE_PARENT_SESSION_ID`, set `CLAUDE_ENTRYPOINT=worker`
- `structured_output` field (not `result`) holds the parsed JSON when `--json-schema` is used. `total_cost_usd` is unreliable through the bridge — read real spend from LiteLLM logs

## Worker Output Reliability & Worker Discipline

Hard-won lessons from the bridge worker model. They apply to **every** `runSession()`-based
tool, not just the one that first hit them — design new tools with these baked in.

### 1. Worker output is bridge-fragile — never trust the envelope blindly

Models over the bridge **ignore `--json-schema`** (so `structured_output` is always empty) and
routinely **end a session on a tool call**, which leaves the `result` envelope field empty even
on `subtype: "success"`. The session looks like a hard failure (`"Session produced no output"`)
while the work is actually complete. This is generic — it has hit `implement`, and will hit
`review` (its router/angle/synthesis sessions) identically.

Mitigations, in order of where they live:
- **Runner-level (covers all tools, already in place):** `runSession()` accumulates the last
  assistant text and recovers the JSON from it when `result` is empty (logs
  `session.recovered_output`). New tools get this for free — do not re-implement output parsing.
- **Distinguish "no parseable output" from real failure:** `SessionResult.noOutput` is set only
  on clean-exit-but-unparseable (never on timeout/exit/is_error). File-editing tools should
  branch on it.
- **For file-editing tools, reconcile against ground truth.** Disk is authoritative, not the
  worker's self-report. `implement` snapshots `git status` before the run and, on `noOutput`,
  reconstructs `applied`/`filesChanged` from the working-tree delta and marks the report
  `UNVERIFIED` (logs `implement.git_recovery`). Any new write-capable tool must do the same —
  a worker's "I changed nothing" / "failed" claim is not trustworthy on its own.
- **Prompt the worker to end on a text turn.** Every skill's Output section must say: *your very
  last message is the JSON, never a tool call* (run final validation, read its result, THEN emit
  JSON). This reduces the empty-`result` rate at the source.

### 2. Don't make the worker discover what the caller can pass in

Repo/environment discovery (finding the test runner, the venv, the lint command) is the dominant
turn-sink and the main cause of 20-min timeouts on non-Node repos. For any tool that runs repo
tooling inside the worker:
- Accept an **explicit-command param** as a fast path (`check`'s `commands`, `implement`'s
  `validateCmd`). When present, run exactly those and skip discovery entirely — and prove it:
  build a **minimal prompt that loads no discovery skill** and forbids `which`/`git remote -v`/
  ecosystem sniffing/`fallow`, and cap `maxTurns` tight (commands + a few). A discovery
  instruction left anywhere in the prompt will be obeyed even in fast-path mode.
- Prefer doing discovery in **handler code** (deterministic parallel `shell()` calls) over asking
  the worker to do it — this is why `review` never had the time-sink: it gathers diff/fallow/
  coderabbit itself and hands the worker the results.

### 3. Keep skills ecosystem-agnostic

Don't hardwire Node/`package.json` assumptions into skill prompts or angle-gating. `check` was
Node-only until it learned Python/uv, Make, Rust, Go. **Known residual: `review` still gates the
QA angle on `package.json` existing** — it won't add a QA reviewer for a Python/Go test suite.
Generalize test/ecosystem detection when touching that path.

### 4. Schema changes need an MCP reconnect, not just `make reload`

`make reload` restarts only the launchd HTTP server (job execution + per-run skill-prompt reads).
The MCP process is owned by the calling Claude Code session, so an edited `*_INPUT`/`*_OUTPUT`
schema (a new field) is invisible until the client reconnects `/mcp` — until then the SDK's Zod
validation **silently strips** the unknown field before the handler sees it. Skill-prompt and
handler-logic edits are live after `make reload`; schema edits are not. (Also in the repo CLAUDE.md.)

## Progress Heartbeat (timeout prevention)

The MCP SDK has a **60-second default client timeout** (`DEFAULT_REQUEST_TIMEOUT_MSEC`). Any tool that spawns a `claude -p` session will exceed this. The session runner sends `notifications/progress` every 15 seconds to reset the client timeout.

This is handled centrally — pass `onProgress: mcpProgressCallback(extra)` when calling `runSession()`:

```typescript
import { runSession, mcpProgressCallback } from "../session-runner.ts";

// In the tool handler — accept `extra` as second arg:
async ({ cwd }, extra) => {
  const result = await runSession<MyOutput>({
    cwd,
    prompt,
    // ...
    onProgress: mcpProgressCallback(extra),
  });
};
```

`mcpProgressCallback()` checks for `_meta.progressToken` and returns `undefined` if the client didn't request progress (safe no-op). The heartbeat fires every 15s with elapsed time. Errors are caught silently (client may disconnect before the session ends).

**Every tool that calls `runSession()` must pass `onProgress`.** Without it, the MCP client will time out after 60s and kill the server.

**Exception — parallel sessions:** Tools that spawn multiple `runSession()` calls in parallel (e.g., `review.ts`) may use a centralized handler-level heartbeat instead of per-session `onProgress`. Create a `setInterval(15_000)` that sends `notifications/progress` via `mcpProgressCallback(extra)`, wrap the entire pipeline in `try-finally` to guarantee cleanup, and document the pattern in a code comment.

## Logging

Use `logger` from `"../logger.ts"` (which resolves to `server/mcp/logger.ts` from tool files).
Never use `console.error()` or `console.log()` in tool handlers:
- `console.log()` corrupts MCP stdio JSON-RPC
- `console.error()` is safe for the terminal but bypasses the structured log file

```typescript
import { logger } from "../logger.ts";

const startMs = performance.now();
logger.info({ event: "mcp.tool.start", tool: "check", project: cwd }, "check starting");
// ... run session ...
logger.info({ event: "mcp.tool.end", tool: "check", project: cwd, passed: true, durationMs: Math.round(performance.now() - startMs) }, "check done");
```

Logs append to `/tmp/sideclaw.jsonl`. See `.claude/rules/logs.md` for full schema + query patterns.
Always include `event`, `tool`, `project` on tool start/end entries.

## Skill Prompts

Skill prompts live in `server/skills/<name>.md`. Load async:
```typescript
return Bun.file(skillPath).text(); // not .toString() — that returns "[object Blob]"
```
