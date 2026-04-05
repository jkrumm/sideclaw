import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { logger } from "./logger.ts";

// ── Constants ──────────────────────────────────────────────────────────────────

const CLAUDE_BIN = existsSync(join(homedir(), ".local/bin/claude"))
  ? join(homedir(), ".local/bin/claude")
  : "claude";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SessionOptions {
  cwd: string;
  prompt: string;
  model?: string;
  jsonSchema?: object;
  maxTurns?: number;
  timeoutMs?: number;
  /** Called every 15s while the subprocess runs. Use to send MCP progress notifications and reset client timeout. */
  onProgress?: (progress: number, total: number, message: string) => void;
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
  total_cost_usd?: number;
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

// ── Runner ─────────────────────────────────────────────────────────────────────

export async function runSession<T = unknown>(opts: SessionOptions): Promise<SessionResult<T>> {
  const {
    cwd,
    prompt,
    model = "claude-haiku-4-5-20251001",
    jsonSchema,
    maxTurns = 30,
    timeoutMs = 10 * 60 * 1000,
  } = opts;

  const args: string[] = [
    "-p",
    prompt,
    "--dangerously-skip-permissions",
    "--output-format",
    "json",
    "--setting-sources",
    "user,project",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers": {}}',
    "--max-turns",
    String(maxTurns),
    "--model",
    model,
  ];

  if (jsonSchema) {
    args.push("--json-schema", JSON.stringify(jsonSchema));
  }

  // Env hygiene: strip parent session identifiers, mark as worker
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  delete env.CLAUDE_SESSION_ID;
  delete env.CLAUDE_PARENT_SESSION_ID;
  env.CLAUDE_ENTRYPOINT = "worker";
  // No ANTHROPIC_API_KEY — preserves Max subscription billing

  const startMs = performance.now();
  logger.info(
    { event: "session.spawn", project: cwd, model, maxTurns, jsonSchema: !!jsonSchema },
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

  // --json-schema puts the parsed object in structured_output; fall back to result string
  if (envelope.structured_output !== undefined) {
    logSessionEnd();
    return { ok: true, data: envelope.structured_output as T };
  }

  const raw = envelope.result;
  if (typeof raw === "string" && raw.trim()) {
    try {
      // Strip markdown code block fences the model sometimes adds around JSON
      const stripped = raw.replace(/^```(?:json)?\n?([\s\S]*?)\n?```\s*$/, "$1").trim();
      const data = JSON.parse(stripped) as T;
      logSessionEnd();
      return { ok: true, data };
    } catch {
      logger.error({ raw: raw.slice(0, 500) }, "result JSON parse failed");
      return { ok: false, error: `result field is not valid JSON: ${raw.slice(0, 500)}` };
    }
  }

  logger.error({ event: "session.error", project: cwd }, "session no usable output");
  return { ok: false, error: "Session produced no output (empty structured_output and result)" };
}
