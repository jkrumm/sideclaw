# MCP Tool Authoring Rules

These rules apply to all MCP tools in `server/mcp/tools/`.
Descriptions are read by LLMs, not humans — optimize for semantic precision over prose.
Full templates, worked examples and the worker-output-reliability lessons:
`docs/mcp-tool-authoring.md`.

## Registration

Always `server.registerTool()` (`server.tool()` is deprecated in SDK 1.29+),
with `title`, an LLM-facing `description` (one-line action, `WHEN TO CALL:`,
`READ-ONLY:`/`SIDE EFFECTS:`, `CWD:`, `OUTPUT:`), Zod `inputSchema`/
`outputSchema` shapes (`.describe()` on every field), and `annotations`
(`readOnlyHint`/`idempotentHint`/`destructiveHint`).

Define the output schema once as `z.object(...)`; derive both `outputSchema`
(`.shape`) and the `--json-schema` CLI flag (`z.toJSONSchema()`) from it —
never two parallel definitions. Return both `content` (text) and
`structuredContent` (typed) from the handler.

## Session Runner

Every tool spawns inner `claude -p` sessions via `runSession()`
(`server/mcp/session-runner.ts`). Model/backend always come from
`routeFor("<tool>")` (`server/lib/routing.ts`) — see CLAUDE.md's Worker
routing section and `docs/routing-and-quota.md` for the full table and
fallback rationale; never hardcode an id.

Load-bearing gotchas specific to the runner:
- **Env ordering**: the credential scrub (`SENSITIVE_ENV_RE`) runs BEFORE the
  backend switch — placing it after would delete the just-injected IU key.
- `--strict-mcp-config --mcp-config '{"mcpServers": {}}'` prevents circular MCP.
- `readOnly: true` → `--disallowedTools "Write,Edit,NotebookEdit"` (+
  `extraDisallowedTools`). **Never `--allowedTools`** — under
  `--dangerously-skip-permissions` it restricts nothing (measured on CLI
  2.1.220; `tests/session-args.test.ts` pins the flag).
- `WebSearch`/`WebFetch` are not wired into worker prompts — web access goes
  through Bash (e.g. `curl` the research-gateway).
- Delete `CLAUDE_SESSION_ID`/`CLAUDE_PARENT_SESSION_ID`, set
  `CLAUDE_ENTRYPOINT=worker`.
- `structured_output` (not `result`) holds parsed JSON when `--json-schema`
  is used.

## Worker output reliability

Worker models routinely ignore `--json-schema` or end on a tool call, so
`runSession()` recovers JSON from the last assistant text
(`session.recovered_output`) and exposes `SessionResult.noOutput`. Repo
discovery is the dominant turn-sink — accept an explicit-command param where
possible and do discovery in handler code, not the prompt. Full lessons and
patterns: `docs/mcp-tool-authoring.md`.

## Fallow Static Analysis

`fallow audit --quiet` (auto-detects base branch) — never `fallow diff`
(doesn't exist). Guard: `which fallow` and a git remote must both exist.
Treat `pass`/`warn` as passed, `fail` as failed.

## Progress Heartbeat

The MCP SDK has a 60s client timeout. Every `runSession()` call must pass
`onProgress: mcpProgressCallback(extra)` (from `session-runner.ts`) or the
client kills the connection. Parallel-session tools (`review.ts`) may use one
centralized `setInterval(15_000)` heartbeat instead. Details:
`docs/mcp-tool-authoring.md`.

## Logging

Use `logger` from `"../logger.ts"` — never `console.log`/`console.error` in
tool handlers (`console.log` corrupts MCP stdio JSON-RPC). Always include
`event`, `tool`, `project` on start/end entries. Full schema + query
patterns: `.claude/rules/logs.md` → `docs/logging.md`.

## Skill Prompts

Skill prompts live in `server/skills/<name>.md`, loaded async via
`Bun.file(skillPath).text()` — not `.toString()` (returns `"[object Blob]"`).
