# Production Spawn Patterns

Battle-tested patterns extracted from ruflo/claude-flow and adapted for Bun.

## Bun.spawn — Complete Wrapper

```typescript
import { existsSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME ?? "";
const CLAUDE_BIN = existsSync(join(HOME, ".local/bin/claude"))
  ? join(HOME, ".local/bin/claude")
  : "claude";

interface SpawnResult {
  success: boolean;
  output: string;
  sessionId?: string;
  cost?: number;
  error?: string;
  exitCode: number;
}

async function spawnClaude(opts: {
  prompt: string;
  cwd: string;
  model?: "haiku" | "sonnet" | "opus";
  outputFormat?: "text" | "json" | "stream-json";
  jsonSchema?: object;
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  appendSystemPrompt?: string;
  settingSources?: string;
}): Promise<SpawnResult> {
  const args: string[] = ["-p", opts.prompt, "--dangerously-skip-permissions"];

  if (opts.model) args.push("--model", opts.model);
  if (opts.outputFormat) args.push("--output-format", opts.outputFormat);
  if (opts.jsonSchema) args.push("--json-schema", JSON.stringify(opts.jsonSchema));
  if (opts.maxTurns) args.push("--max-turns", String(opts.maxTurns));
  if (opts.maxBudgetUsd) args.push("--max-budget-usd", String(opts.maxBudgetUsd));
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  if (opts.settingSources) args.push("--setting-sources", opts.settingSources);

  // Env hygiene
  const env = { ...process.env };
  delete env.CLAUDE_SESSION_ID;
  delete env.CLAUDE_PARENT_SESSION_ID;
  env.CLAUDE_ENTRYPOINT = "worker";

  const proc = Bun.spawn([CLAUDE_BIN, ...args], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  // Timeout with two-stage kill
  const timeoutMs = opts.timeoutMs ?? 120_000;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* already dead */ }
    }, 5000);
  }, timeoutMs);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  clearTimeout(timeout);

  if (timedOut) {
    return { success: false, output: stdout, error: `Timed out after ${timeoutMs}ms`, exitCode };
  }

  // Parse result based on format
  if (opts.outputFormat === "json" && stdout.trim()) {
    try {
      const result = JSON.parse(stdout);
      return {
        success: !result.is_error,
        output: result.structured_output ?? result.result ?? stdout,
        sessionId: result.session_id,
        cost: result.total_cost_usd,
        error: result.is_error ? (result.errors?.join("; ") ?? "Unknown error") : undefined,
        exitCode,
      };
    } catch {
      return { success: exitCode === 0, output: stdout, exitCode };
    }
  }

  return {
    success: exitCode === 0,
    output: stdout,
    error: exitCode !== 0 ? (stderr.trim() || `Exit code ${exitCode}`) : undefined,
    exitCode,
  };
}
```

## NDJSON Stream Parser (Bun)

For real-time progress tracking with `--output-format stream-json`:

```typescript
interface StreamEvent {
  type: "system" | "assistant" | "user" | "result" | "stream_event";
  subtype?: string;
  session_id?: string;
  message?: {
    content?: Array<{
      type: "text" | "tool_use" | "tool_result";
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
  // result fields
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  duration_ms?: number;
  total_cost_usd?: number;
  num_turns?: number;
}

async function* parseNDJsonStream(
  stdout: ReadableStream<Uint8Array>
): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder();
  const reader = stdout.getReader();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line) as StreamEvent;
      } catch { /* skip unparseable */ }
    }
  }

  // Flush remaining buffer
  if (buffer.trim()) {
    try {
      yield JSON.parse(buffer) as StreamEvent;
    } catch { /* ignore */ }
  }
}

// Usage:
const proc = Bun.spawn([CLAUDE_BIN, "-p", prompt, "--output-format", "stream-json", ...], {
  cwd, stdout: "pipe", stderr: "pipe", env,
});

let sessionId: string | undefined;
for await (const event of parseNDJsonStream(proc.stdout)) {
  if (event.type === "system" && event.subtype === "init") {
    sessionId = event.session_id;
  }
  if (event.type === "assistant") {
    // Process tool calls, text responses
  }
  if (event.type === "result") {
    // Final event
    return {
      success: !event.is_error,
      output: event.structured_output ?? event.result,
      sessionId,
      cost: event.total_cost_usd,
    };
  }
}
```

## MCP Server with @modelcontextprotocol/sdk (Bun)

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "sideclaw",
  version: "1.0.0",
});

// ALL logging via console.error — console.log corrupts MCP stdio
console.error("[sideclaw-mcp] Starting...");

server.tool(
  "check",
  "Run validation (format, lint, typecheck, test, analyze) against a repo",
  { cwd: z.string().describe("Absolute path to the repo") },
  async ({ cwd }) => {
    const result = await spawnClaude({
      prompt: "... check skill prompt ...",
      cwd,
      model: "haiku",
      outputFormat: "json",
      jsonSchema: { /* check output schema */ },
      maxTurns: 30,
      settingSources: "user,project",
    });

    return {
      content: [{ type: "text", text: JSON.stringify(result.output) }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

Register: `claude mcp add --scope user sideclaw -- bun run /path/to/sideclaw/server/mcp.ts`

Tools appear in Claude Code as `mcp__sideclaw__check`.

## Context Injection Pattern (for HITL)

Instead of `--resume`, inject full context from previous steps:

```typescript
const shipState = {
  step: "reviewing",
  previousSteps: [
    { step: "analyzing", result: "Direct-to-master repo detected" },
    { step: "committing", result: "Created commit: feat(api): add user endpoint" },
  ],
  humanFeedback: ["User confirmed commit message"],
};

const prompt = `
You are continuing a ship workflow. Here is the current state:

## Previous Steps
${shipState.previousSteps.map(s => `- ${s.step}: ${s.result}`).join("\n")}

## Human Feedback
${shipState.humanFeedback.map(f => `- ${f}`).join("\n")}

## Current Step: ${shipState.step}
Run the code review and return structured findings.

${JSON.stringify(outputSchema)}
`;

const result = await spawnClaude({ prompt, cwd, model: "sonnet", ... });
```

This is more tokens per call but completely reliable — no session state to corrupt,
no cache invalidation, no ID changes.

## Process Pool (Concurrent Spawns)

```typescript
class ProcessPool {
  private active = new Map<string, { proc: ReturnType<typeof Bun.spawn>; timeout: Timer }>();

  async spawn(id: string, opts: Parameters<typeof spawnClaude>[0]): Promise<SpawnResult> {
    const result = spawnClaude(opts);
    // Track for cleanup
    return result;
  }

  async shutdown() {
    for (const [id, { proc, timeout }] of this.active) {
      clearTimeout(timeout);
      proc.kill("SIGTERM");
    }
    // Wait for exits
    await Promise.all([...this.active.values()].map(({ proc }) => proc.exited));
    this.active.clear();
  }
}
```

## Exit Codes

| Code | Meaning |
|-|-|
| 0 | Success |
| 1 | General error |
| 137 | Killed by SIGKILL (128 + 9) |
| 143 | Killed by SIGTERM (128 + 15) |
