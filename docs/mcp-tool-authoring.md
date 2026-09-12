# MCP tool authoring — patterns and worked examples

Full examples backing `.claude/rules/mcp-tools.md`. Read this when adding a
new tool under `server/mcp/tools/`; the rule file stays a short skeleton for
every-session context, this is the reference to copy from.

## Registration template

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

`server.registerTool()` always — `server.tool()` is deprecated in SDK 1.29+.

## Tool description skeleton

The description is shown to the calling LLM in its tool list:

```
Run X and return structured Y.

WHEN TO CALL: before committing, before PR, or when validating Z.
READ-ONLY: never modifies files. Safe to retry.
CWD: absolute path of the target repo — not necessarily this session's CWD.
OUTPUT: check `passed` first. If false, inspect `steps[n].errors` for error lines.
```

Cover: one-line action, `WHEN TO CALL:`, `READ-ONLY:`/`SIDE EFFECTS:`, `CWD:`
(if applicable), `OUTPUT:`, and any silent skip/default behavior.

`.describe()` on every Zod field, with format/constraints/examples where
non-obvious:

```typescript
cwd: z.string().describe(
  "Absolute path to the git repo root. Must be an existing git repository. Supports git worktrees."
)
```

## Output schema — single source of truth

Define the output schema once as `z.object(...)` and derive both the MCP
contract and the `--json-schema` CLI flag from it — never two parallel
definitions:

```typescript
const MY_OUTPUT = z.object({
  passed: z.boolean().describe("..."),
});

outputSchema: MY_OUTPUT.shape,                 // MCP typed contract
const MY_JSON_SCHEMA = z.toJSONSchema(MY_OUTPUT); // claude --json-schema flag
```

`z.toJSONSchema()` is built into Zod v4 — no extra package needed. Return
both `content` (text blob, for older clients/humans) and `structuredContent`
(typed object, what modern MCP clients receive) from the handler.

## Worker output reliability — hard-won lessons

Applies to every `runSession()`-based tool, not just the one that first hit
it — design new tools with these baked in.

1. **Worker output can arrive malformed.** Some worker models ignore
   `--json-schema` (`structured_output` stays empty) and routinely end a
   session on a tool call, leaving `result` empty even on
   `subtype: "success"` — reads like a hard failure while the work is
   actually done. `runSession()` already recovers JSON from the last
   assistant text (`session.recovered_output`) — new tools get this for
   free. `SessionResult.noOutput` distinguishes clean-exit-but-unparseable
   from a real failure; write-capable tools should branch on it — `dispatch`
   degrades a `noOutput` result into a flagged wrapper carrying the raw text
   rather than reconstructing state from `git status` (see
   `docs/dispatch-security.md`'s salvage rule). Every skill's Output section
   should say: your very last message is the JSON, never a tool call.
2. **Don't make the worker discover what the caller can pass in.**
   Repo/environment discovery is the dominant turn-sink and the main cause
   of slow, wandering sessions on non-Node repos — there is no turn or
   wall-clock limit to cap against (idle watchdog only), so an undirected
   worker just runs longer instead of erroring out. Accept an
   explicit-command param as a fast path (`check`'s `commands`,
   `implement`'s `validateCmd`); when present, skip discovery entirely —
   build a minimal prompt that forbids `which`/`git remote -v`/ecosystem
   sniffing/`fallow`. Prefer doing discovery in handler code (deterministic parallel
   `shell()` calls) over asking the worker — why `review` never had this
   time-sink: it gathers diff/fallow/coderabbit itself.
3. **Keep skills ecosystem-agnostic.** Don't hardwire Node/`package.json`
   assumptions into prompts or angle-gating. Known residual: `review` still
   gates the QA angle on `package.json` existing.
4. **Schema changes need an MCP reconnect, not just `make reload`** — see
   CLAUDE.md's MCP Server section.

## Progress heartbeat (timeout prevention)

The MCP SDK has a 60-second default client timeout
(`DEFAULT_REQUEST_TIMEOUT_MSEC`). Pass `onProgress: mcpProgressCallback(extra)`
into every `runSession()` call:

```typescript
import { runSession, mcpProgressCallback } from "../session-runner.ts";

async ({ cwd }, extra) => {
  const result = await runSession<MyOutput>({
    cwd,
    prompt,
    onProgress: mcpProgressCallback(extra),
  });
};
```

`mcpProgressCallback()` no-ops if the client didn't request progress. The
heartbeat fires every 15s. **Every tool that calls `runSession()` must pass
`onProgress`** or the client times out at 60s and kills the server.

**Parallel sessions** (e.g. `review.ts`) may use one centralized
`setInterval(15_000)` heartbeat instead of per-session `onProgress`, wrapped
in `try-finally` to guarantee cleanup.
