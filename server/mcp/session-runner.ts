import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { resolveAuthMode, type AuthMode, type ResolvedAuthMode } from "../lib/quota.ts";
import { logger } from "./logger.ts";

// ── Constants ──────────────────────────────────────────────────────────────────

const CLAUDE_BIN = existsSync(join(homedir(), ".local/bin/claude"))
  ? join(homedir(), ".local/bin/claude")
  : "claude";

const CLAUDE_OFFLOAD_DIR = join(homedir(), ".claude-offload");

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SessionOptions {
  cwd: string;
  prompt: string;
  model?: string;
  jsonSchema?: object;
  maxTurns?: number;
  timeoutMs?: number;
  /**
   * Auth strategy for the spawned worker.
   * - `"max"`: inherit parent Max subscription (no env injection).
   * - `"iu"`: inject ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL + CLAUDE_CONFIG_DIR
   *   to route to the custom IU-hosted Anthropic-compatible endpoint.
   * - `"auto"` (default): consult `/tmp/claude_sl/usage_api.json`; pick `iu` when
   *   peak 5h/7d utilization >= 70%, else `max`. Missing/stale cache → `max`.
   */
  authMode?: AuthMode;
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

// ── Keychain helpers ───────────────────────────────────────────────────────────

async function readKeychain(service: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["security", "find-generic-password", "-s", service, "-w"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return null;
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (err) {
    logger.error(
      { event: "keychain.read_fail", service, error: String(err) },
      "keychain read threw",
    );
    return null;
  }
}

// ── IU env injection ───────────────────────────────────────────────────────────

interface IuEnv {
  ANTHROPIC_AUTH_TOKEN: string;
  ANTHROPIC_BASE_URL: string;
  CLAUDE_CONFIG_DIR: string;
}

async function buildIuEnv(): Promise<IuEnv | null> {
  const [token, baseUrl] = await Promise.all([
    readKeychain("claude-sdk-api-key"),
    readKeychain("claude-sdk-base-url"),
  ]);
  if (!token || !baseUrl) {
    logger.error(
      {
        event: "iu_env.unavailable",
        hasToken: !!token,
        hasBaseUrl: !!baseUrl,
      },
      "IU keychain entries missing — falling back to max",
    );
    return null;
  }
  try {
    if (!existsSync(CLAUDE_OFFLOAD_DIR)) {
      mkdirSync(CLAUDE_OFFLOAD_DIR, { recursive: true });
    }
  } catch (err) {
    logger.error(
      { event: "iu_env.dir_create_fail", dir: CLAUDE_OFFLOAD_DIR, error: String(err) },
      "failed to create CLAUDE_CONFIG_DIR — falling back to max",
    );
    return null;
  }
  return {
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_BASE_URL: baseUrl,
    CLAUDE_CONFIG_DIR: CLAUDE_OFFLOAD_DIR,
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
    authMode = "auto",
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

  // Resolve auth mode (auto → max/iu based on quota cache) and build env.
  const resolved = await resolveAuthMode(authMode);
  let resolvedMode: ResolvedAuthMode = resolved.mode;
  let authReason = resolved.reason;

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }

  if (resolvedMode === "iu") {
    const iuEnv = await buildIuEnv();
    if (iuEnv) {
      env.ANTHROPIC_AUTH_TOKEN = iuEnv.ANTHROPIC_AUTH_TOKEN;
      env.ANTHROPIC_BASE_URL = iuEnv.ANTHROPIC_BASE_URL;
      env.CLAUDE_CONFIG_DIR = iuEnv.CLAUDE_CONFIG_DIR;
      // Defensive: ANTHROPIC_API_KEY would be rejected by claude v2.x ("Not logged in"),
      // and any inherited value would shadow ANTHROPIC_AUTH_TOKEN.
      delete env.ANTHROPIC_API_KEY;
    } else {
      // Keychain or dir setup failed — fall back to max rather than crash.
      resolvedMode = "max";
      authReason = `${authReason}; iu setup failed — fell back to max`;
    }
  }
  // For "max" mode: no env injection — preserves Max subscription billing via inherited OAuth.

  delete env.CLAUDE_SESSION_ID;
  delete env.CLAUDE_PARENT_SESSION_ID;
  env.CLAUDE_ENTRYPOINT = "worker";

  const startMs = performance.now();
  logger.info(
    {
      event: "session.spawn",
      project: cwd,
      model,
      maxTurns,
      jsonSchema: !!jsonSchema,
      authMode: resolvedMode,
      authReason,
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
