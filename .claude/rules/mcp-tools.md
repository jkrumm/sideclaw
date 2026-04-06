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
- No `ANTHROPIC_API_KEY` — preserves Max subscription billing
- `--strict-mcp-config --mcp-config '{"mcpServers": {}}'` — prevents circular MCP (empty `{}` is invalid schema)
- `--setting-sources user,project` — loads repo's CLAUDE.md for context
- Delete `CLAUDE_SESSION_ID`, `CLAUDE_PARENT_SESSION_ID`, set `CLAUDE_ENTRYPOINT=worker`
- `structured_output` field (not `result`) holds the parsed JSON when `--json-schema` is used

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
