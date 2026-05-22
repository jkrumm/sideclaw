import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";
import { logger } from "./logger.ts";

// ── Constants ──────────────────────────────────────────────────────────────────

const CLAUDE_BIN = existsSync(join(homedir(), ".local/bin/claude"))
  ? join(homedir(), ".local/bin/claude")
  : "claude";

// All worker sessions route through the LiteLLM bridge (dotfiles litellm/), which
// translates Anthropic Messages → OpenAI chat/completions against the IU unified
// endpoint. Primary model Kimi-K2.6 (EU/GDPR), with claude-sonnet-4-6-eu failover
// configured inside LiteLLM. The Max subscription is never used by workers — it is
// reserved for the orchestrator. See docs/kimi-litellm-bridge.md in dotfiles.
const BRIDGE_URL = process.env.SIDECLAW_BRIDGE_URL ?? "http://localhost:4000";
// LiteLLM runs unauthenticated (localhost-bound), but claude requires a non-empty
// auth token — send a static dummy the proxy ignores.
const BRIDGE_TOKEN = process.env.SIDECLAW_BRIDGE_TOKEN ?? "sk-litellm-master-key";
const DEFAULT_MODEL = "Kimi-K2.6";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SessionOptions<T = unknown> {
  cwd: string;
  prompt: string;
  /** Bridge model id (LiteLLM model_name): "Kimi-K2.6" | "claude-sonnet-4-6-eu" | "gpt-5-mini". */
  model?: string;
  jsonSchema?: object;
  maxTurns?: number;
  timeoutMs?: number;
  /**
   * `--setting-sources` value. Default "project" (repo CLAUDE.md only) keeps the
   * uncached system prompt small — bridge calls lose prompt caching, so global
   * rules are paid on every turn. Use "user,project" for tools that benefit from
   * the global code-style/typescript rules (review, implement).
   */
  settingSources?: string;
  /**
   * Read-only worker: removes Edit/Write/NotebookEdit from the tool set via
   * `--allowedTools`. Kimi is eager and will "helpfully" edit files under
   * `--dangerously-skip-permissions` (it once auto-fixed lint during a `check`),
   * so check/review/research must opt in. Bash stays available (needed to run
   * validators / curl), so prompts must also instruct "report only".
   */
  readOnly?: boolean;
  /** Extra env vars merged into the worker (e.g. TAVILY_API_KEY for research). */
  extraEnv?: Record<string, string>;
  /** Called every 15s while the subprocess runs. Use to send MCP progress notifications and reset client timeout. */
  onProgress?: (progress: number, total: number, message: string) => void;
  /**
   * Optional output validator. Kimi over the bridge ignores `--json-schema` and
   * emits prose-fenced JSON that `extractJson` casts WITHOUT type-checking, so
   * schema drift (e.g. a field of the wrong type) otherwise slips through to the
   * MCP `outputSchema` boundary and fails the call opaquely. When provided, the
   * extracted data (from `structured_output` or the result fence) is validated
   * here first — a failure becomes a clear `{ ok: false }`. Build from the tool's
   * Zod schema via `zodValidator(MY_OUTPUT)`.
   */
  validate?: (data: unknown) => { ok: true; value: T } | { ok: false; error: string };
}

/** Build a `SessionOptions.validate` from a Zod schema. Returns the parsed value or a flattened issue string. */
export function zodValidator<T>(
  schema: z.ZodType<T>,
): (data: unknown) => { ok: true; value: T } | { ok: false; error: string } {
  return (data) => {
    const r = schema.safeParse(data);
    if (r.success) return { ok: true, value: r.data };
    const issues = r.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: `output failed schema validation: ${issues}` };
  };
}

export interface SessionResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// Shape of claude --output-format json envelope
interface ClaudeJsonEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string; // text result (often "" when --json-schema is used)
  structured_output?: unknown; // parsed JSON object when --json-schema is provided
  errors?: string[];
  session_id?: string;
  total_cost_usd?: number; // unreliable through the bridge — see logSessionEnd
  num_turns?: number;
}

// ── Progress helper ────────────────────────────────────────────────────────────

/** Minimal shape of the MCP tool handler `extra` param — avoids importing SDK types. */
interface McpExtra {
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: {
    method: string;
    params: Record<string, unknown>;
  }) => Promise<void>;
}

/** Build an onProgress callback from MCP extra. Returns undefined if the client didn't request progress. */
export function mcpProgressCallback(extra: McpExtra): SessionOptions["onProgress"] | undefined {
  const token = extra._meta?.progressToken;
  if (token === undefined) return undefined;
  return (progress, total, message) => {
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress, total, message },
      })
      .catch(() => {}); // best-effort, don't crash if client disconnected
  };
}

// ── Lenient JSON extraction ───────────────────────────────────────────────────
//
// Workers sometimes ignore --json-schema and emit text that contains a ```json
// fence followed by prose commentary. The strict "whole string must be JSON"
// parser then rejects what is semantically a successful result. This extractor
// tries, in order:
//   1. parse the whole trimmed string
//   2. parse the contents of the first ```json fenced block
//   3. parse the contents of the first ``` (unlabeled) fenced block
//   4. brace-scan for the first top-level {...} that parses (skipping strings)
// Returns the parsed value, or undefined if nothing parses.

function extractJson<T>(raw: string): T | undefined {
  const text = raw.trim();

  const tryParse = (s: string): T | undefined => {
    try {
      return JSON.parse(s) as T;
    } catch {
      return undefined;
    }
  };

  let parsed = tryParse(text);
  if (parsed !== undefined) return parsed;

  const jsonFence = text.match(/```json\s*\n([\s\S]*?)\n```/);
  if (jsonFence) {
    parsed = tryParse(jsonFence[1].trim());
    if (parsed !== undefined) return parsed;
  }

  const anyFence = text.match(/```[a-zA-Z]*\s*\n([\s\S]*?)\n```/);
  if (anyFence) {
    parsed = tryParse(anyFence[1].trim());
    if (parsed !== undefined) return parsed;
  }

  // Brace scan: find the first balanced {...} that parses, respecting strings.
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        parsed = tryParse(text.slice(start, i + 1));
        if (parsed !== undefined) return parsed;
        return undefined;
      }
    }
  }
  return undefined;
}

// ── Bridge health ────────────────────────────────────────────────────────────

/** Quick liveness probe so a down bridge produces a clear error, not an opaque claude failure. */
async function bridgeReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BRIDGE_URL}/health/liveliness`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Runner ─────────────────────────────────────────────────────────────────────

export async function runSession<T = unknown>(opts: SessionOptions<T>): Promise<SessionResult<T>> {
  const {
    cwd,
    prompt,
    model = DEFAULT_MODEL,
    jsonSchema,
    maxTurns = 30,
    timeoutMs = 10 * 60 * 1000,
    settingSources = "project",
    readOnly = false,
    extraEnv,
    validate,
  } = opts;

  if (!(await bridgeReachable())) {
    logger.error(
      { event: "session.bridge_down", project: cwd, url: BRIDGE_URL },
      "LiteLLM bridge unreachable",
    );
    return {
      ok: false,
      error: `LiteLLM bridge unreachable at ${BRIDGE_URL}. Run 'make litellm-restart' in dotfiles (see docs/kimi-litellm-bridge.md).`,
    };
  }

  const args: string[] = [
    "-p",
    prompt,
    "--dangerously-skip-permissions",
    "--output-format",
    "json",
    "--setting-sources",
    settingSources,
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers": {}}',
    "--max-turns",
    String(maxTurns),
    "--model",
    model,
  ];

  // Read-only tools: allowlist read + run tools only, so Edit/Write/NotebookEdit
  // are unavailable even under --dangerously-skip-permissions. Bash stays (needed
  // to run validators / curl); prompts enforce "report only" for Bash-level writes.
  if (readOnly) {
    args.push("--allowedTools", "Read,Bash,Grep,Glob");
  }

  if (jsonSchema) {
    args.push("--json-schema", JSON.stringify(jsonSchema));
  }

  // Route the worker through the LiteLLM bridge. ANTHROPIC_API_KEY is deleted: it
  // is rejected by claude v2.x ("Not logged in") and would shadow ANTHROPIC_AUTH_TOKEN.
  // CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 is required or the IU gateway 400s on
  // Anthropic beta headers.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.ANTHROPIC_BASE_URL = BRIDGE_URL;
  env.ANTHROPIC_AUTH_TOKEN = BRIDGE_TOKEN;
  env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_SESSION_ID;
  delete env.CLAUDE_PARENT_SESSION_ID;
  env.CLAUDE_ENTRYPOINT = "worker";
  if (extraEnv) Object.assign(env, extraEnv);

  const startMs = performance.now();
  logger.info(
    {
      event: "session.spawn",
      project: cwd,
      model,
      maxTurns,
      jsonSchema: !!jsonSchema,
      settingSources,
      readOnly,
      bridge: BRIDGE_URL,
    },
    "session spawn",
  );

  const proc = Bun.spawn([CLAUDE_BIN, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  // Progress heartbeat: keeps MCP client timeout alive during long-running sessions
  const HEARTBEAT_INTERVAL_MS = 15_000;
  let heartbeatTick = 0;
  const { onProgress } = opts;
  const heartbeatHandle = onProgress
    ? setInterval(() => {
        heartbeatTick++;
        const elapsedSec = heartbeatTick * 15;
        onProgress(heartbeatTick, 0, `Session running (${elapsedSec}s elapsed)`);
      }, HEARTBEAT_INTERVAL_MS)
    : null;

  // Two-stage timeout: SIGTERM → wait 5s → SIGKILL
  let timedOut = false;
  let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    logger.error({ event: "session.timeout", project: cwd }, "session timed out — SIGTERM");
    proc.kill("SIGTERM");
    sigkillTimer = setTimeout(() => {
      sigkillTimer = null;
      if (proc.exitCode === null) {
        logger.error({ event: "session.timeout", project: cwd }, "session still alive — SIGKILL");
        proc.kill("SIGKILL");
      }
    }, 5000);
  }, timeoutMs);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  clearTimeout(timeoutHandle);
  if (sigkillTimer !== null) clearTimeout(sigkillTimer);

  const exitCode = await proc.exited;
  if (heartbeatHandle !== null) clearInterval(heartbeatHandle);
  const stderrTrimmed = stderr.trim();

  if (stderrTrimmed) {
    logger.debug({ stderr: stderrTrimmed.slice(0, 1000) }, "session stderr");
  }

  logger.debug(
    { exitCode, timedOut, stdoutLen: stdout.length, stdoutHead: stdout.slice(0, 500) },
    "session raw stdout",
  );

  if (timedOut) {
    return { ok: false, error: `Session timed out after ${timeoutMs}ms` };
  }

  if (exitCode !== 0) {
    return {
      ok: false,
      error: `Session exited with code ${exitCode}${stderrTrimmed ? `. stderr: ${stderrTrimmed}` : ""}`,
    };
  }

  let envelope: ClaudeJsonEnvelope;
  try {
    envelope = JSON.parse(stdout.trim()) as ClaudeJsonEnvelope;
  } catch {
    logger.error({ stdout: stdout.slice(0, 500) }, "envelope parse failed");
    return { ok: false, error: `Failed to parse JSON output: ${stdout.slice(0, 500)}` };
  }

  logger.debug(
    {
      type: envelope.type,
      subtype: envelope.subtype,
      is_error: envelope.is_error,
      hasStructuredOutput: envelope.structured_output !== undefined,
      turns: envelope.num_turns,
      costUsd: envelope.total_cost_usd,
    },
    "envelope received",
  );

  if (envelope.is_error) {
    const errMsg = envelope.errors?.join("; ") ?? String(envelope.result ?? "Unknown error");
    logger.error(
      { event: "session.error", project: cwd, subtype: envelope.subtype, error: errMsg },
      "session is_error",
    );
    return { ok: false, error: errMsg };
  }

  // total_cost_usd is unreliable through the bridge (claude reads Anthropic usage
  // fields the OpenAI→Anthropic translation does not populate). Real spend is
  // visible in LiteLLM's logs, not here — kept only for rough comparison.
  const logSessionEnd = () =>
    logger.info(
      {
        event: "session.end",
        project: cwd,
        model,
        durationMs: Math.round(performance.now() - startMs),
        costUsd: envelope.total_cost_usd,
        turns: envelope.num_turns,
      },
      "session end",
    );

  // Validate (if a validator was supplied) before returning, then log session end.
  // extractJson casts without type-checking, so this is the only gate that catches
  // worker output that drifts from the declared schema.
  const finalize = (value: T): SessionResult<T> => {
    if (validate) {
      const v = validate(value);
      if (!v.ok) {
        logger.error(
          { event: "session.invalid_output", project: cwd, error: v.error },
          "session output failed validation",
        );
        return { ok: false, error: v.error };
      }
      logSessionEnd();
      return { ok: true, data: v.value };
    }
    logSessionEnd();
    return { ok: true, data: value };
  };

  // --json-schema puts the parsed object in structured_output; fall back to result string
  if (envelope.structured_output !== undefined) {
    return finalize(envelope.structured_output as T);
  }

  const raw = envelope.result;
  if (typeof raw === "string" && raw.trim()) {
    const data = extractJson<T>(raw);
    if (data !== undefined) {
      return finalize(data);
    }
    logger.error({ raw: raw.slice(0, 500) }, "result JSON parse failed");
    return { ok: false, error: `result field is not valid JSON: ${raw.slice(0, 500)}` };
  }

  logger.error({ event: "session.error", project: cwd }, "session no usable output");
  return { ok: false, error: "Session produced no output (empty structured_output and result)" };
}
