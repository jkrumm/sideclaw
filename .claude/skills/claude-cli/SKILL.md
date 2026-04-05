---
name: claude-cli
description: >
  Reference for spawning Claude Code CLI (`claude -p`) as a subprocess from Bun/TypeScript.
  Use this skill whenever writing code that spawns, wraps, or communicates with the Claude CLI
  programmatically — MCP server handlers, workflow runners, chain-runner implementations,
  or any automation that invokes `claude -p`. Covers spawn patterns, NDJSON parsing,
  structured output, session management, env hygiene, and critical gotchas.
  ALWAYS consult this skill before writing subprocess spawning code for Claude CLI.
---

# Spawning Claude Code CLI — Patterns & Reference

This skill encodes production-proven patterns for wrapping `claude -p` in Bun/TypeScript,
learned from ruflo/claude-flow (30k+ stars, battle-tested) and the official CLI documentation.

## When to Read References

- **Building a new spawn wrapper or MCP tool handler** → read this file + `references/spawn-patterns.md`
- **Need the exact CLI flags** → read `references/cli-flags.md`
- **Parsing NDJSON stream output** → read `references/stream-format.md`
- **Quick check on a specific gotcha** → check the Gotchas table below

---

## Core Spawn Pattern (Bun)

The existing `chain-runner.ts` in sideclaw uses `Bun.spawn`. This is the idiomatic pattern:

```typescript
const env = { ...process.env };

// REQUIRED: Prevent nested session detection
delete env.CLAUDE_SESSION_ID;
delete env.CLAUDE_PARENT_SESSION_ID;
env.CLAUDE_ENTRYPOINT = "worker";

const proc = Bun.spawn(["claude", "-p", prompt, "--dangerously-skip-permissions"], {
  cwd: targetRepoPath,
  stdout: "pipe",
  stderr: "pipe",
  env,
});
```

For Node.js `child_process.spawn` (if needed):

```typescript
const child = spawn("claude", ["--print", prompt], {
  cwd: targetRepoPath,
  env,
  stdio: ["ignore", "pipe", "pipe"],  // stdin MUST be "ignore", not "pipe"
  windowsHide: true,
});
```

### Why `stdin: "ignore"`

With Node's `spawn`, using `stdio: ["pipe", "pipe", "pipe"]` causes `claude --print` to hang
waiting for stdin EOF. Setting stdin to `"ignore"` closes it at spawn time. Bun's `Bun.spawn`
doesn't have this issue because it doesn't open stdin by default.

### Why delete session env vars

Claude CLI detects `CLAUDE_SESSION_ID` and `CLAUDE_PARENT_SESSION_ID` in the environment.
If present (because the parent process IS a Claude Code session), the child refuses to start
with a "nested session" error. Setting `CLAUDE_ENTRYPOINT=worker` plus deleting these vars
bypasses the check.

---

## Env Variables — What to Set, What to Delete

```typescript
// MUST SET
env.CLAUDE_ENTRYPOINT = "worker";  // Bypass nested session detection

// MUST DELETE
delete env.CLAUDE_SESSION_ID;
delete env.CLAUDE_PARENT_SESSION_ID;

// MUST NOT SET (unless you want API billing instead of subscription)
// delete env.ANTHROPIC_API_KEY;  // Don't inject — let CLI use subscription auth

// OPTIONAL
env.ANTHROPIC_MODEL = "haiku";  // Override model (or use --model flag)
```

---

## Output Format Strategies

### Strategy 1: `--output-format json` (Recommended for structured results)

Single JSON object after completion. Use with `--json-schema` for validated output.

```typescript
const proc = Bun.spawn([
  "claude", "-p", prompt,
  "--dangerously-skip-permissions",
  "--output-format", "json",
], { cwd, stdout: "pipe", stderr: "pipe", env });

const text = await new Response(proc.stdout).text();
const result = JSON.parse(text);
// result.result — final text
// result.session_id — for --resume
// result.structured_output — if --json-schema was used
// result.is_error — boolean
// result.total_cost_usd — cost
```

### Strategy 2: `--output-format stream-json` (For progress tracking)

NDJSON stream — one JSON object per line. See `references/stream-format.md` for event types.

```typescript
const proc = Bun.spawn([
  "claude", "-p", prompt,
  "--dangerously-skip-permissions",
  "--output-format", "stream-json",
], { cwd, stdout: "pipe", stderr: "pipe", env });

let sessionId: string | undefined;
let buffer = "";
const decoder = new TextDecoder();
const reader = proc.stdout.getReader();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value);
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";  // Keep incomplete line

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "system" && event.subtype === "init") {
        sessionId = event.session_id;
      }
      if (event.type === "result") {
        // Final event — check event.subtype for "success" or error variants
      }
    } catch { /* skip unparseable lines */ }
  }
}
```

### Strategy 3: `--output-format text` (Simplest — for fire-and-forget)

Plain text output. Just the final response, no metadata.

### Strategy 4: Structured output via `--json-schema`

Forces Claude to produce validated JSON matching a schema. Only works with `--output-format json`.
Result appears in `structured_output` field.

```typescript
const schema = JSON.stringify({
  type: "object",
  properties: {
    passed: { type: "boolean" },
    errors: { type: "array", items: { type: "string" } },
  },
  required: ["passed", "errors"],
});

const proc = Bun.spawn([
  "claude", "-p", prompt,
  "--dangerously-skip-permissions",
  "--output-format", "json",
  "--json-schema", schema,
], { cwd, stdout: "pipe", stderr: "pipe", env });
```

If validation fails after retries: `result.subtype === "error_max_structured_output_retries"`.
Keep schemas simple — deeply nested schemas with many required fields fail more often.

### Strategy 5: Prompt-based JSON extraction (Fallback)

When `--json-schema` isn't available (e.g., with `stream-json`), instruct Claude in the prompt
to output JSON and parse it from the text response:

```typescript
function extractJson(output: string): unknown {
  try {
    // Try code block first
    const block = output.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (block) return JSON.parse(block[1].trim());
    // Try any JSON object/array
    const json = output.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (json) return JSON.parse(json[0]);
    // Direct parse
    return JSON.parse(output.trim());
  } catch {
    return null;
  }
}
```

---

## Timeout & Kill Pattern

Always implement a two-stage kill: SIGTERM first, SIGKILL after 5s as backup.

```typescript
const TIMEOUT_MS = 120_000;  // 2 minutes for most tools, longer for complex tasks

const timeout = setTimeout(() => {
  proc.kill("SIGTERM");
  setTimeout(() => {
    try { proc.kill("SIGKILL"); } catch { /* already dead */ }
  }, 5000);
}, TIMEOUT_MS);

const exitCode = await proc.exited;
clearTimeout(timeout);
```

---

## Session Management

### Capture session_id

From `--output-format json`: `result.session_id`
From `--output-format stream-json`: first event where `type === "system" && subtype === "init"` has `session_id`

### Resume a session (for HITL)

```typescript
Bun.spawn([
  "claude", "-p", "--resume", sessionId, feedbackPrompt,
  "--dangerously-skip-permissions",
  "--output-format", "json",
], { cwd, stdout: "pipe", stderr: "pipe", env });
```

**Known issues with `--resume` (avoid for critical HITL):**
- Cache invalidation: resuming forces full re-cache of context (burns rate limits)
- Session ID may change on resume (issue #10806)
- Context loss after API limits (issue #3138)
- Corrupted sessions if killed mid-execution (issue #18880)

**Preferred HITL alternative: Context injection**
Instead of resuming, start a fresh `claude -p` with the full context of previous steps
injected into the prompt. More tokens, but more reliable.

### Disable session persistence

For ephemeral one-shot operations:
```
--no-session-persistence
```

---

## Permission Modes

| Flag | Effect |
|-|-|
| `--dangerously-skip-permissions` | All tools auto-approved (equivalent to `bypassPermissions`) |
| `--permission-mode dontAsk` | Denies everything not in allow rules (fully non-interactive) |
| `--permission-mode auto` | Classifier-based approval (requires API plan) |

For MCP-spawned subprocesses: always use `--dangerously-skip-permissions`.
The MCP server is the trust boundary — inner sessions should execute freely.

---

## Model Selection

```
--model haiku     # Fast, cheap — validation, formatting, mechanical tasks
--model sonnet    # Balanced — code review, implementation, analysis
--model opus      # Deep reasoning — architecture, complex debugging
```

Or via env: `env.ANTHROPIC_MODEL = "haiku"`

---

## Settings & Context Loading

```
--setting-sources user,project   # Load ~/.claude/settings.json + .claude/settings.json
                                 # MUST include "project" to load CLAUDE.md
```

For inner sessions spawned by MCP tools, use `--setting-sources user,project` so the
subprocess picks up the target repo's CLAUDE.md and rules. Without this, the inner session
has no repo-specific context.

---

## Critical Gotchas

| Mistake | Impact | Fix |
|-|-|-|
| Leave `CLAUDE_SESSION_ID` in env | Child exits with "nested session" error | Delete it + set `CLAUDE_ENTRYPOINT=worker` |
| Set `ANTHROPIC_API_KEY` in env | Switches from subscription to API billing silently | Don't inject it |
| Use `stdio: ["pipe",...]` with Node spawn | Process hangs on stdin EOF | Use `["ignore", "pipe", "pipe"]` |
| `console.log()` in MCP server | Corrupts JSON-RPC stdio stream | Use `console.error()` for all logging |
| Only SIGTERM on timeout | Process may not die | Add SIGKILL after 5s |
| Resolve promise twice (close + error events) | Unhandled rejection | Use `let resolved = false` guard |
| Parse NDJSON without buffering | Fails on partial lines | Keep last element of `split("\n")` in buffer |
| Use `--resume` for critical HITL | Session ID changes, cache invalidated, context loss | Use context injection instead |
| Use `--bare` flag | Skips OAuth — forces API key auth | Don't use with subscription |
| Skip `--setting-sources` | Inner session doesn't load CLAUDE.md | Set `user,project` |

---

## Billing

- **Subscription (Max/Pro)**: Default when `ANTHROPIC_API_KEY` is NOT set. The `claude` CLI
  uses OAuth from the user's login.
- **API billing**: Activated when `ANTHROPIC_API_KEY` IS set. Pay-per-token.
- **`--bare` mode**: Forces API key auth (skips OAuth/keychain).

For MCP server subprocess spawning: never set `ANTHROPIC_API_KEY` in the child env.
This ensures all spawned sessions use the Max subscription.

---

## Key Flags Quick Reference

See `references/cli-flags.md` for the complete flag list with types, defaults, and details.

| Flag | Purpose |
|-|-|
| `-p` / `--print` | Non-interactive mode (required) |
| `--output-format json\|stream-json\|text` | Output format |
| `--json-schema '<schema>'` | Validated structured output (json format only) |
| `--dangerously-skip-permissions` | All tools auto-approved |
| `--model haiku\|sonnet\|opus` | Model selection |
| `--max-turns N` | Limit agent loop iterations |
| `--max-budget-usd N` | Spending cap per invocation |
| `--no-session-persistence` | Don't save session to disk |
| `--resume <session_id>` | Continue a previous session |
| `--setting-sources user,project` | Load CLAUDE.md and settings |
| `--append-system-prompt "text"` | Add to system prompt |
| `--allowedTools "Bash" "Read"` | Auto-approve specific tools |
| `--disallowedTools "Agent"` | Block specific tools entirely |
| `--verbose` | Full turn-by-turn output |
| `--effort low\|medium\|high\|max` | Thinking depth |
