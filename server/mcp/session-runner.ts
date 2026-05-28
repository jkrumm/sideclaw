import { appendFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
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

// Per-session attribution log. Each runSession invocation appends one record
// describing tool / cwd / time window — usage-tracker's litellm collector joins
// individual bridge requests to it by ts ∈ [tsStart, tsEnd], so token rows get
// tagged with which sideclaw tool (check/review/research/implement/…) caused them.
// Format: NDJSON, one record per session, written on completion.
const ATTRIBUTION_LOG = join(
  homedir(),
  ".local",
  "share",
  "usage-tracker",
  "sideclaw-sessions.jsonl",
);

function writeAttribution(record: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(ATTRIBUTION_LOG), { recursive: true });
    appendFileSync(ATTRIBUTION_LOG, JSON.stringify(record) + "\n", "utf-8");
  } catch {
    // Attribution is best-effort — never break a session over a log write.
  }
}

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
  /**
   * Tool name for usage attribution — e.g. "check", "review", "research",
   * "implement". Written to the sideclaw-sessions.jsonl attribution log so
   * usage-tracker can tag bridge requests back to the sideclaw tool that caused
   * them. Optional but every job handler should set it.
   */
  tool?: string;
  /** Called every 15s while the subprocess runs. Use to send MCP progress notifications and reset client timeout. */
  onProgress?: (progress: number, total: number, message: string) => void;
  /**
   * Called on every stream-json event from the worker (turn complete, tool call,
   * tool result). Lets the job layer persist live progress — most importantly
   * `lastActivityAt`, from which callers derive idle time to tell a working
   * session from a wedged one. Fire-and-forget; errors are swallowed by the runner.
   */
  onActivity?: (progress: SessionProgress) => void;
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
  /**
   * True when the session completed cleanly (exit 0, not is_error, not timed out)
   * but produced nothing parseable — neither `structured_output`, a JSON `result`,
   * nor recoverable assistant text. The work may still be on disk: handlers that
   * edit files (`implement`) can treat this as a cue to reconcile against `git`
   * rather than reporting an outright failure. Never set on timeout/exit/is_error.
   */
  noOutput?: boolean;
}

/** Live progress snapshot emitted via `onActivity` as stream-json events arrive. */
export interface SessionProgress {
  /** Assistant turns observed so far. */
  turns: number;
  /** Short label of the most recent worker action, e.g. "Edit store.ts" or "Bash: bun test". */
  lastAction: string;
  /** Epoch ms of the last stream event — `Date.now() - lastActivityAt` is idle time. */
  lastActivityAt: number;
}

// The `result` event of --output-format stream-json is the final line and carries
// the same fields the old single-blob --output-format json envelope did. Reused below.
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

// One NDJSON line from `--output-format stream-json --verbose`. See
// .claude/skills/claude-cli/references/stream-format.md for the full shape.
interface StreamEvent {
  type?: "system" | "assistant" | "user" | "result" | "stream_event";
  subtype?: string;
  message?: {
    content?: Array<{
      type?: "text" | "tool_use" | "tool_result";
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
  // result-event fields (mirror ClaudeJsonEnvelope)
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  errors?: string[];
  num_turns?: number;
  total_cost_usd?: number;
}

/** Compact human label for a tool_use item, used as `lastAction`. */
function describeTool(item: { name?: string; input?: Record<string, unknown> }): string {
  const name = item.name ?? "tool";
  const input = item.input ?? {};
  if (name === "Bash" && typeof input.command === "string") {
    return `Bash: ${input.command.slice(0, 50)}`;
  }
  const path = input.file_path ?? input.path ?? input.notebook_path;
  if (typeof path === "string") {
    return `${name} ${path.split("/").pop()}`;
  }
  return name;
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

/**
 * Keep a synchronous (non-runSession) MCP handler alive past the SDK's 60s client
 * timeout by emitting a progress heartbeat every 15s. Use for direct-fetch tools
 * (read_image, generate_image, read_drawing). Returns a cleanup fn — call it in a
 * `finally`. No-op when the client didn't request progress.
 */
export function mcpHeartbeat(extra: McpExtra, label: string): () => void {
  const onProgress = mcpProgressCallback(extra);
  if (!onProgress) return () => {};
  const t0 = Date.now();
  const id = setInterval(() => {
    onProgress(0, 0, `${label} ${Math.round((Date.now() - t0) / 1000)}s`);
  }, 15_000);
  return () => clearInterval(id);
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
    tool,
    validate,
    onActivity,
  } = opts;

  const sessionUuid = randomUUID();
  const tsStart = new Date().toISOString();
  const emitAttribution = (
    outcome: "ok" | "error" | "timeout",
    extras: Record<string, unknown> = {},
  ): void => {
    writeAttribution({
      sessionId: sessionUuid,
      tool: tool ?? "unknown",
      project: cwd,
      model,
      tsStart,
      tsEnd: new Date().toISOString(),
      outcome,
      ...extras,
    });
  };

  if (!(await bridgeReachable())) {
    logger.error(
      { event: "session.bridge_down", project: cwd, url: BRIDGE_URL },
      "LiteLLM bridge unreachable",
    );
    emitAttribution("error", { reason: "bridge_down" });
    return {
      ok: false,
      error: `LiteLLM bridge unreachable at ${BRIDGE_URL}. Run 'make litellm-restart' in dotfiles (see docs/kimi-litellm-bridge.md).`,
    };
  }

  const args: string[] = [
    "-p",
    prompt,
    "--dangerously-skip-permissions",
    // stream-json (NDJSON, one event per line) instead of a single end-of-run blob,
    // so the runner can track live activity (turns / last tool / idle time) for the
    // job layer. Requires --verbose. The final `result` event is parsed identically
    // to the old --output-format json envelope.
    "--output-format",
    "stream-json",
    "--verbose",
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

  // stderr is buffered whole (it's small — diagnostics only); stdout is consumed as
  // a live NDJSON stream so we can track per-event activity and capture the result.
  const stderrPromise = new Response(proc.stderr).text();

  let envelope: ClaudeJsonEnvelope | undefined;
  let turns = 0;
  let lastAction = "starting";
  // Most recent non-empty assistant text. Kimi over the bridge frequently ends a
  // session on a tool call, leaving the `result` envelope field empty even though
  // it already emitted its JSON in an earlier text turn. We keep that text so the
  // output-extraction fallback can recover it instead of failing the whole job.
  let lastAssistantText = "";
  const emitActivity = () => {
    if (!onActivity) return;
    try {
      onActivity({ turns, lastAction, lastActivityAt: Date.now() });
    } catch {
      /* progress is best-effort — never let it break the session */
    }
  };
  emitActivity();

  const handleEvent = (ev: StreamEvent): void => {
    switch (ev.type) {
      case "assistant": {
        turns++;
        const content = ev.message?.content ?? [];
        const toolUse = content.find((c) => c.type === "tool_use");
        if (toolUse) lastAction = describeTool(toolUse);
        else if (content.some((c) => c.type === "text")) lastAction = "responding";
        const text = content
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("");
        if (text.trim()) lastAssistantText = text;
        emitActivity();
        break;
      }
      case "user": // tool results coming back
        emitActivity();
        break;
      case "system":
        if (ev.subtype === "api_retry") lastAction = "api retry";
        else if (ev.subtype === "compact_boundary") lastAction = "compacting context";
        emitActivity();
        break;
      case "result":
        envelope = ev as ClaudeJsonEnvelope;
        break;
    }
  };

  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? ""; // keep the trailing partial line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          handleEvent(JSON.parse(trimmed) as StreamEvent);
        } catch {
          /* skip non-JSON noise (shouldn't occur with stream-json) */
        }
      }
    }
    if (buf.trim()) {
      try {
        handleEvent(JSON.parse(buf.trim()) as StreamEvent);
      } catch {
        /* ignore trailing garbage */
      }
    }
  } finally {
    reader.releaseLock();
  }

  const stderr = await stderrPromise;
  clearTimeout(timeoutHandle);
  if (sigkillTimer !== null) clearTimeout(sigkillTimer);

  const exitCode = await proc.exited;
  if (heartbeatHandle !== null) clearInterval(heartbeatHandle);
  const stderrTrimmed = stderr.trim();

  if (stderrTrimmed) {
    logger.debug({ stderr: stderrTrimmed.slice(0, 1000) }, "session stderr");
  }

  logger.debug({ exitCode, timedOut, turns, lastAction }, "session stream done");

  const durationMs = Math.round(performance.now() - startMs);

  if (timedOut) {
    emitAttribution("timeout", { durationMs, turns });
    return { ok: false, error: `Session timed out after ${timeoutMs}ms` };
  }

  if (exitCode !== 0) {
    emitAttribution("error", { durationMs, turns, exitCode });
    return {
      ok: false,
      error: `Session exited with code ${exitCode}${stderrTrimmed ? `. stderr: ${stderrTrimmed}` : ""}`,
    };
  }

  if (!envelope) {
    logger.error({ event: "session.error", project: cwd }, "no result event in stream");
    emitAttribution("error", { durationMs, turns, reason: "no_envelope" });
    return { ok: false, error: "Session ended without a result event" };
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
    emitAttribution("error", { durationMs, turns: envelope.num_turns ?? turns });
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
        durationMs,
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
        emitAttribution("error", { durationMs, turns: envelope.num_turns ?? turns });
        return { ok: false, error: v.error };
      }
      logSessionEnd();
      emitAttribution("ok", { durationMs, turns: envelope.num_turns ?? turns });
      return { ok: true, data: v.value };
    }
    logSessionEnd();
    emitAttribution("ok", { durationMs, turns: envelope.num_turns ?? turns });
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
    emitAttribution("error", { durationMs, turns: envelope.num_turns ?? turns, reason: "json_parse" });
    return {
      ok: false,
      error: `result field is not valid JSON: ${raw.slice(0, 500)}`,
      noOutput: true,
    };
  }

  // Bridge fallback: the `result` field is routinely empty for Kimi sessions that
  // end on a tool call (the OpenAI→Anthropic translation drops the trailing text).
  // Recover the JSON from the last assistant text message seen in the stream before
  // declaring failure — this is the single most common false "no output" failure.
  if (lastAssistantText) {
    const recovered = extractJson<T>(lastAssistantText);
    if (recovered !== undefined) {
      logger.warn(
        { event: "session.recovered_output", project: cwd },
        "recovered output from last assistant text (empty result field)",
      );
      return finalize(recovered);
    }
  }

  logger.error({ event: "session.error", project: cwd }, "session no usable output");
  emitAttribution("error", { durationMs, turns: envelope.num_turns ?? turns, reason: "no_output" });
  return {
    ok: false,
    error: "Session produced no output (empty structured_output and result)",
    noOutput: true,
  };
}
