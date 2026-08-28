import { appendFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { z } from "zod";
import { logger } from "./logger.ts";
import { getIuConfig } from "../lib/iu-openai.ts";

// ── Constants ──────────────────────────────────────────────────────────────────

const CLAUDE_BIN = existsSync(join(homedir(), ".local/bin/claude"))
  ? join(homedir(), ".local/bin/claude")
  : "claude";

// Worker sessions run on Claude via the IU unified endpoint's native Anthropic
// transport (off Max, IU per-token) — the same recipe dotfiles' `ca`/`claude_iu`
// use. This is the hot path for plain `claude-*` model ids. The LiteLLM bridge
// (dotfiles litellm/), which translates Anthropic Messages → OpenAI chat/completions
// against DeepSeek, is retained but dormant by default — it only engages when a
// `DeepSeek*` or `*-eu` model id is passed (see `useBridge` below). For plain
// `claude-*` ids, SIDECLAW_WORKER_BACKEND selects between IU (default) and Max
// (inherited OAuth) — see `CONFIGURED_WORKER_BACKEND` below. A `session_env` line is written
// per non-bridge session (see `writeSessionEnv`) so usage-tracker classifies
// worker spend correctly (IU vs Max).
const BRIDGE_URL = process.env.SIDECLAW_BRIDGE_URL ?? "http://localhost:4000";
// LiteLLM runs unauthenticated (localhost-bound), but claude requires a non-empty
// auth token — send a static dummy the proxy ignores.
const BRIDGE_TOKEN = process.env.SIDECLAW_BRIDGE_TOKEN ?? "sk-litellm-master-key";

type Backend = "bridge" | "iu" | "max";

/** Configured worker auth backend for plain `claude-*` model ids — the raw flag, not
 *  the effective per-session backend (a bridge-routed model id overrides it; see
 *  `backend` in runSession). "iu" (default) injects the IU key/base; "max" injects
 *  nothing so the CLI falls through to the inherited OAuth profile (the Max
 *  subscription). Read once at module load, so a flag flip requires `make reload`. */
const CONFIGURED_WORKER_BACKEND: Exclude<Backend, "bridge"> =
  process.env.SIDECLAW_WORKER_BACKEND === "max" ? "max" : "iu";
// Worker model tiers — single source of truth. Call sites import these instead of
// hardcoding ids so a tier change is one edit. Both are plain `claude-*` ids, so
// they skip the bridge and route via CONFIGURED_WORKER_BACKEND (IU or Max).
export const WORKER_MODEL = "claude-sonnet-5[1m]"; // reasoning tier: review, otel, excalidraw
export const CHECK_MODEL = "claude-haiku-4-5"; // fast/cheap tier: mechanical validation (check)
const DEFAULT_MODEL = WORKER_MODEL;

const CLAUDE_LOG_DIR = join(homedir(), ".claude", "logs");

/** Env var names that look like a credential. Matched case-insensitively against the
 *  inherited environment and deleted before the worker is spawned. Deliberately broad —
 *  a false positive costs a worker a variable it almost certainly did not need, while a
 *  false negative hands a live token to a session whose prompt may be attacker-written. */
const SENSITIVE_ENV_RE =
  /(TOKEN|SECRET|PASSWORD|PASSWD|_KEY|APIKEY|API_KEY|CREDENTIAL|BEARER|SESSION_ID)/i;

/** Exempt from the scrub: the CLI's own auth path. On the `max` backend the inherited
 *  OAuth profile is how the worker authenticates at all, so scrubbing it would break
 *  every session rather than harden it. The `iu`/`bridge` backends set their own
 *  ANTHROPIC_* vars after this point regardless. */
const ALWAYS_KEEP_ENV = new Set(["CLAUDE_CODE_OAUTH_TOKEN"]);

/** Mirror dotfiles' SessionStart hook: record the worker's base_url keyed by its
 * transcript sessionId so usage-tracker's classifier (base_url present → "iu",
 * null/missing → "max") tags the run correctly. Called for both the "iu" backend
 * (real base_url) and the "max" backend (explicit null — see the max branch below
 * for why null is written rather than skipped). Idempotent — safe if the hook also
 * fires. Never throws. */
function writeSessionEnv(sessionId: string, baseUrl: string | null): void {
  try {
    mkdirSync(CLAUDE_LOG_DIR, { recursive: true });
    const now = new Date().toISOString();
    const line =
      JSON.stringify({
        ts: now,
        src: "sideclaw",
        event: "session_env",
        level: "info",
        data: { session: sessionId, base_url: baseUrl },
      }) + "\n";
    appendFileSync(join(CLAUDE_LOG_DIR, `${now.slice(0, 10)}.jsonl`), line);
  } catch {
    /* never throw from telemetry */
  }
}

// Per-session attribution log. Each runSession invocation appends one record
// describing tool / cwd / time window — usage-tracker's litellm collector joins
// individual bridge requests to it by ts ∈ [tsStart, tsEnd], so token rows get
// tagged with which sideclaw tool (check/review/…) caused them.
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
  /** Model id. Plain "claude-*" ids (e.g. "claude-sonnet-5[1m]", "claude-haiku-4-5")
   * route via the IU native Anthropic transport. "DeepSeek-V4-Pro" | "DeepSeek-V4-Flash"
   * | "*-eu" ids route through the (dormant-by-default) LiteLLM bridge — see `useBridge`. */
  model?: string;
  jsonSchema?: Record<string, unknown>;
  maxTurns?: number;
  timeoutMs?: number;
  /**
   * `--setting-sources` value. Default "project" (repo CLAUDE.md only) keeps the
   * uncached system prompt small — bridge calls lose prompt caching, so global
   * rules are paid on every turn. Use "user,project" for tools that benefit from
   * the global code-style/typescript rules (review).
   */
  settingSources?: string;
  /**
   * Read-only worker: removes Edit/Write/NotebookEdit from the tool set via
   * `--disallowedTools`. Workers are eager and will "helpfully" edit files under
   * `--dangerously-skip-permissions` (Kimi once auto-fixed lint during a `check`),
   * so check/review/dispatch must opt in. Bash stays available (needed to run
   * validators / curl / git), so prompts must also instruct "report only".
   *
   * NB `--allowedTools` does NOT work here and was the original, silently-broken
   * implementation — skip-permissions bypasses the permission system an allowlist
   * feeds, so Write stayed available. See the flag construction below.
   */
  readOnly?: boolean;
  /**
   * MCP servers to expose to the worker, in `claude --mcp-config`'s `mcpServers` shape
   * (e.g. `{ hyperdx: { type: "http", url, headers } }`). Merged under `--strict-mcp-config`,
   * so this is the *entire* server set the worker sees — never the repo's own `.mcp.json`.
   * Omitted (default): the worker gets `{"mcpServers": {}}`, i.e. none, matching every
   * caller before this field existed.
   */
  mcpServers?: Record<string, unknown>;
  /**
   * Extra tool names appended to the `readOnly` disallow list (e.g. an MCP server's
   * mutating tools — `mcp__hyperdx__clickstack_save_*`). Ignored when `readOnly` is false;
   * a writable session has no disallow list to append to. Tool names must be exact, per
   * the same caveat as the base `readOnly` list below — no glob support confirmed for
   * MCP-namespaced tool names.
   */
  extraDisallowedTools?: string[];
  /** Extra env vars merged into the worker (e.g. RESEARCH_GATEWAY_URL/TOKEN for review). */
  extraEnv?: Record<string, string>;
  /**
   * Tool name for usage attribution — e.g. "check", "review".
   * Written to the sideclaw-sessions.jsonl attribution log so
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
   * Optional output validator. Models over the bridge ignore `--json-schema` and
   * emit prose-fenced JSON that `extractJson` casts WITHOUT type-checking, so
   * schema drift (e.g. a field of the wrong type) otherwise slips through to the
   * MCP `outputSchema` boundary and fails the call opaquely. When provided, the
   * extracted data (from `structured_output` or the result fence) is validated
   * here first — a failure becomes a clear `{ ok: false }`. Build from the tool's
   * Zod schema via `zodValidator(MY_OUTPUT)`.
   */
  validate?: (data: unknown) => { ok: true; value: T } | { ok: false; error: string };
}

/** JSON-stringify for diagnostics only. Never throws — a value that cannot be serialized
 *  (a cycle, a BigInt) must not turn a salvageable failure into an unhandled one. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
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
   * nor recoverable assistant text. The work may still be on disk: a file-editing
   * handler could treat this as a cue to reconcile against `git`
   * rather than reporting an outright failure. Never set on timeout/exit/is_error.
   */
  noOutput?: boolean;
  /**
   * The worker's raw final text when output could not be parsed/validated into `T`
   * (set alongside `noOutput`). Untruncated, unlike the truncated copy in `error`.
   * Lets a handler salvage a degraded-but-non-empty result (e.g. a synthesis that
   * emitted prose instead of JSON) instead of discarding minutes of work.
   */
  rawText?: string;
  /** Total attempts made, including the first. 1 unless a transient transport
   *  failure was retried — see `isRetryableSessionError`. */
  attempts?: number;
  /** True if an earlier attempt failed and was retried before this result. */
  retried?: boolean;
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
  // system-event field: the worker's real transcript session id (init event).
  session_id?: string;
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
 * (read_image, read_drawing). Returns a cleanup fn — call it in a
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

// ── CLI argument vector ────────────────────────────────────────────────────────

/**
 * Extra settings layer applied to EVERY worker session, on top of whatever
 * `--setting-sources` loads.
 *
 * A worker must not execute a repository's hooks, and by default it does. Measured on CLI
 * 2.1.220 (2026-08-03) with a canary in a scratch repo's `.claude/settings.json`: under the
 * exact flag vector below, a `SessionStart` hook fired before the model took a turn and a
 * `PreToolUse` hook fired on the worker's first Bash call. That is arbitrary command
 * execution supplied by the audited repo — the same "repo-controlled code is not a check"
 * argument that makes the dispatch commit `--no-verify`, one layer up. `-p`'s own help text
 * says the workspace-trust dialog is skipped in non-interactive mode, so nothing else stops it.
 *
 * `--setting-sources user` removes the hooks but also removes the repo's CLAUDE.md (measured:
 * the codeword probe answered NONE), and that context is the entire reason dispatch exists.
 * `--settings '{"hooks":{}}'` does NOT help — it merges, and the repo's hooks still fired.
 * `disableAllHooks` is the one lever that separates them: hooks dead, CLAUDE.md still loaded,
 * Bash unaffected.
 */
export const WORKER_SETTINGS = JSON.stringify({ disableAllHooks: true });

export interface SessionArgsInput {
  prompt: string;
  settingSources: string;
  maxTurns: number;
  model: string;
  readOnly: boolean;
  jsonSchema?: Record<string, unknown>;
  mcpServers?: Record<string, unknown>;
  extraDisallowedTools?: string[];
}

/** The full `claude` argument vector for a worker session. Split out from `runSession` so the
 *  flags that constrain a worker are assertable without spawning anything — several of them
 *  are load-bearing security bounds whose absence is invisible at runtime. */
export function buildSessionArgs(input: SessionArgsInput): string[] {
  const {
    prompt,
    settingSources,
    maxTurns,
    model,
    readOnly,
    jsonSchema,
    mcpServers,
    extraDisallowedTools,
  } = input;

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
    // Repo-supplied hooks must never execute in a worker. See WORKER_SETTINGS.
    "--settings",
    WORKER_SETTINGS,
    "--strict-mcp-config",
    "--mcp-config",
    mcpServers ? JSON.stringify({ mcpServers }) : '{"mcpServers": {}}',
    "--max-turns",
    String(maxTurns),
    "--model",
    model,
  ];

  // Read-only tools: remove the editing tools outright.
  //
  // This MUST be `--disallowedTools`, not `--allowedTools`. Measured on CLI 2.1.220
  // (2026-08-02): under `--dangerously-skip-permissions`, `--allowedTools
  // "Read,Bash,Grep,Glob"` restricts NOTHING — skip-permissions bypasses the
  // permission system that an allowlist feeds, so Write and Edit stay available and
  // succeed. A probe run with the old flag overwrote its canary file; the same probe
  // with `--disallowedTools` got "the call was rejected as disabled" and the canary
  // survived. So every `readOnly: true` caller — check, review, dispatch — was
  // read-only by the worker's goodwill alone, which is exactly what the flag existed
  // to stop being true.
  //
  // Bash deliberately stays (validators, git, curl), so a determined worker can still
  // write via shell redirection; prompts carry the "report only" rule for that. The
  // point of this flag is removing the *easy, default* path to a mutation, not
  // sandboxing. Tool names must be exact — an unknown one only logs "matches no known
  // tool" and is silently ignored (MultiEdit is not a real tool name here).
  if (readOnly) {
    args.push(
      "--disallowedTools",
      ["Write", "Edit", "NotebookEdit", ...(extraDisallowedTools ?? [])].join(","),
    );
  }

  if (jsonSchema) {
    // claude CLI's --json-schema validator treats a top-level "$schema" key as an
    // unresolvable $ref ("no schema with key or ref ..."), rejecting the payload
    // outright. z.toJSONSchema() always emits "$schema", so strip it here — the
    // single point where the flag is serialized — rather than at each call site.
    let schemaWithoutMeta: unknown = jsonSchema;
    if (!Array.isArray(jsonSchema)) {
      const { $schema: _$schema, ...rest } = jsonSchema;
      schemaWithoutMeta = rest;
    }
    args.push("--json-schema", JSON.stringify(schemaWithoutMeta));
  }

  return args;
}

// ── Retry policy ───────────────────────────────────────────────────────────────
//
// Moving a worker off Max onto the IU unified endpoint's gateway models means
// intermittent 429/503 under burst — measured, plus one transient 502 that three
// immediate retries cleared. A whole session launch (the `claude -p` subprocess) is
// expensive to redo, so retrying is bounded and narrow: only transport-level
// failures, and only before the worker has produced any output a retry could
// duplicate or corrupt.

/** Total attempts per session, including the first — at most 2 retries. */
export const MAX_SESSION_ATTEMPTS = 3;

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
// Deliberately not "any 3-digit number" — that would false-positive on an unrelated
// exit code or turn count sitting in the same error string. 400/401 are matched and
// explicitly excluded rather than left to fall through, so a deterministic client
// error can never retry by accident.
const CONNECTION_ERROR_RE =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EHOSTUNREACH|fetch failed|socket hang up/i;

/** Is this session-launch failure worth retrying? Transport-level only: HTTP
 *  429/502/503/504 and connection-level errors are transient; everything else —
 *  including 400/401 — is deterministic and a retry just burns turns and money.
 *  Pure: no network, no process, so it is unit-testable on its own. */
// The IU gateway re-wraps an upstream client error as its own 503 and puts the
// real status in the text — a bad request comes back as
// `503 [Requesty Global Anthropic API StatusCode: BadRequest]`. Matching the
// leading 503 alone would therefore retry a deterministic failure twice for
// nothing, so the wrapped status is checked first and wins.
const WRAPPED_TERMINAL_RE = /StatusCode:\s*(?:BadRequest|Unauthorized|Forbidden|NotFound)/i;

export function isRetryableSessionError(message: string): boolean {
  if (WRAPPED_TERMINAL_RE.test(message)) return false;
  const statusMatch = message.match(/\b(400|401|429|502|503|504)\b/);
  if (statusMatch) return RETRYABLE_STATUS.has(Number(statusMatch[1]));
  return CONNECTION_ERROR_RE.test(message);
}

/** Backoff delay (ms) before the retry following a failed attempt N (1-indexed).
 *  1s, then 3s — the same exponential cadence iuFetch uses for transient IU errors. */
export function retryBackoffMs(attempt: number): number {
  return 1000 * 3 ** (attempt - 1);
}

// ── Runner ─────────────────────────────────────────────────────────────────────

/** One session launch. Renamed out of `runSession` so the retry loop can wrap it —
 *  `turnsRef` is populated as soon as the worker's first assistant turn streams back,
 *  which is what lets the wrapper tell "failed before doing anything" from "failed
 *  after it may have started writing files". */
async function runSessionAttempt<T = unknown>(
  opts: SessionOptions<T>,
  turnsRef: { current: number },
): Promise<SessionResult<T>> {
  const {
    cwd,
    prompt,
    model = DEFAULT_MODEL,
    jsonSchema,
    maxTurns = 30,
    timeoutMs = 10 * 60 * 1000,
    settingSources = "project",
    readOnly = false,
    mcpServers,
    extraDisallowedTools,
    extraEnv,
    tool,
    validate,
    onActivity,
  } = opts;

  const sessionUuid = randomUUID();
  const tsStart = new Date().toISOString();
  // DeepSeek*/Kimi* and *-eu model ids route through the (dormant-by-default)
  // LiteLLM bridge; plain "claude-*" ids route via IU or Max per the configured
  // backend. Mirrors usage-tracker's isBridgeRouted(). The model id always wins for
  // bridge routing — a DeepSeek id can't run on Max, so the flag never overrides it.
  // Resolved before emitAttribution so nothing below depends on declaration order.
  const useBridge = !model.startsWith("claude") || model.endsWith("-eu");
  const backend: Backend = useBridge ? "bridge" : CONFIGURED_WORKER_BACKEND;

  const emitAttribution = (
    outcome: "ok" | "error" | "timeout",
    extras: Record<string, unknown> = {},
  ): void => {
    writeAttribution({
      sessionId: sessionUuid,
      tool: tool ?? "unknown",
      project: cwd,
      model,
      backend,
      tsStart,
      tsEnd: new Date().toISOString(),
      outcome,
      ...extras,
    });
  };

  if (useBridge && !(await bridgeReachable())) {
    logger.error(
      { event: "session.bridge_down", project: cwd, url: BRIDGE_URL },
      "LiteLLM bridge unreachable",
    );
    emitAttribution("error", { reason: "bridge_down" });
    return {
      ok: false,
      error: `LiteLLM bridge unreachable at ${BRIDGE_URL}. Run 'make litellm-restart' in dotfiles (see docs/deepseek-litellm-bridge.md).`,
    };
  }

  let anthropicBase = "";
  let iuKey = "";
  if (backend === "iu") {
    try {
      const cfg = await getIuConfig();
      anthropicBase = cfg.anthropicBase;
      iuKey = cfg.key;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { event: "session.iu_config_error", project: cwd, error: message },
        "IU config unavailable",
      );
      emitAttribution("error", { reason: "iu_config_error" });
      return { ok: false, error: message };
    }
  }

  const args = buildSessionArgs({
    prompt,
    settingSources,
    maxTurns,
    model,
    readOnly,
    jsonSchema,
    mcpServers,
    extraDisallowedTools,
  });

  // ANTHROPIC_API_KEY is deleted in both branches: it is rejected by claude v2.x
  // ("Not logged in") and would shadow ANTHROPIC_AUTH_TOKEN.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  // Exhaustive over Backend: a new variant must declare its own auth handling rather
  // than inheriting another branch's credentials by omission.
  switch (backend) {
    case "bridge":
      // CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 is required or the IU gateway 400s
      // on Anthropic beta headers when routed through the bridge.
      env.ANTHROPIC_BASE_URL = BRIDGE_URL;
      env.ANTHROPIC_AUTH_TOKEN = BRIDGE_TOKEN;
      env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
      break;
    case "iu":
      // IU native Anthropic transport — same recipe as dotfiles' claude_iu(). Do not
      // set CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS here; that was a bridge-only
      // workaround and dropping it on the native path is the protocol-fidelity win.
      env.ANTHROPIC_BASE_URL = anthropicBase;
      env.ANTHROPIC_AUTH_TOKEN = iuKey;
      break;
    case "max":
      // Fall through to the inherited OAuth profile (the Max subscription). Delete
      // rather than skip — the parent env is copied wholesale above, so an inherited
      // ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN would silently shadow OAuth and push
      // the worker back onto IU (or the bridge) despite the flag.
      delete env.ANTHROPIC_BASE_URL;
      delete env.ANTHROPIC_AUTH_TOKEN;
      delete env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS;
      break;
    default:
      backend satisfies never;
  }
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_SESSION_ID;
  delete env.CLAUDE_PARENT_SESSION_ID;
  // The worker env is copied from this process wholesale, so it carries whatever the
  // LaunchAgent was started with — including live credentials the worker has no reason
  // to hold. Scrub them: a worker that never sees a token cannot leak one, and every
  // tool that genuinely needs one passes it explicitly via `extraEnv` (review does this
  // for the research-gateway), which is applied AFTER this and therefore still wins.
  //
  // This matters most for `dispatch`, whose prompt is assembled from untrusted material
  // — but it is the right default for every worker, so it lives here rather than in one
  // handler. `Bash` is available to these sessions, so `env` is one command away.
  for (const key of Object.keys(env)) {
    if (SENSITIVE_ENV_RE.test(key) && !ALWAYS_KEEP_ENV.has(key)) delete env[key];
  }
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
      mcpServers: mcpServers ? Object.keys(mcpServers) : [],
      useBridge,
      backend,
      baseUrl: env.ANTHROPIC_BASE_URL,
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
  // Most recent non-empty assistant text. Bridge workers frequently end a
  // session on a tool call, leaving the `result` envelope field empty even though
  // it already emitted its JSON in an earlier text turn. We keep that text so the
  // output-extraction fallback can recover it instead of failing the whole job.
  let lastAssistantText = "";
  // Worker's real transcript session id (from the stream's system/init event, not
  // sideclaw's own `sessionUuid`). Used to tag the IU-native session_env sidecar
  // so usage-tracker joins it to the right transcript.
  let workerSessionId: string | undefined;
  let sessionEnvWritten = false;
  const maybeWriteSessionEnv = () => {
    if (backend === "bridge" || sessionEnvWritten || !workerSessionId) return;
    // "max" writes an explicit null rather than skipping the line: both classify
    // as billing="max" downstream, but an explicit record is distinguishable from
    // a missing/rotated-out log entry (models.ts documents that ambiguity as a
    // known silent-default-to-max weak point) and keeps the drift audit meaningful.
    writeSessionEnv(workerSessionId, backend === "max" ? null : anthropicBase);
    sessionEnvWritten = true;
  };
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
        turnsRef.current = turns;
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
        if (!workerSessionId && ev.session_id) {
          workerSessionId = ev.session_id;
          maybeWriteSessionEnv();
        }
        emitActivity();
        break;
      case "result":
        envelope = ev as ClaudeJsonEnvelope;
        if (!workerSessionId && ev.session_id) {
          workerSessionId = ev.session_id;
          maybeWriteSessionEnv();
        }
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

  // Fallback: if no system/result event carried session_id during the stream,
  // check the envelope one more time before giving up on IU-native telemetry.
  if (!workerSessionId && envelope?.session_id) {
    workerSessionId = envelope.session_id;
    maybeWriteSessionEnv();
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

  // total_cost_usd is unreliable when routed through the bridge (claude reads
  // Anthropic usage fields the OpenAI→Anthropic translation does not populate;
  // real spend there is visible in LiteLLM's logs instead). On the IU native
  // Anthropic transport the envelope's cost/usage fields are populated normally.
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
        // Carry the worker's output through as `rawText`, exactly as the unparseable
        // branches below do. A schema-validation failure means the session DID produce
        // something — it just did not fit the declared shape — so a handler salvaging a
        // long run has real material to preserve. Returning a bare error here was silently
        // discarding it on what is, for a strict schema, the LIKELIEST failure path.
        const asText = typeof value === "string" ? value : safeStringify(value);
        return { ok: false, error: v.error, noOutput: true, rawText: asText };
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
    emitAttribution("error", {
      durationMs,
      turns: envelope.num_turns ?? turns,
      reason: "json_parse",
    });
    return {
      ok: false,
      error: `result field is not valid JSON: ${raw.slice(0, 500)}`,
      noOutput: true,
      rawText: raw,
    };
  }

  // Bridge fallback: the `result` field is routinely empty for bridge sessions that
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
    rawText: lastAssistantText || undefined,
  };
}

/** Run a worker session, retrying a bounded number of times on a transient
 *  transport failure. A retry only happens when both hold: `isRetryableSessionError`
 *  matches the failure, and the worker never produced an assistant turn (so it
 *  cannot have started writing files) — anything past that point is re-run at the
 *  caller's own risk, not this one's. */
export async function runSession<T = unknown>(opts: SessionOptions<T>): Promise<SessionResult<T>> {
  let attempt = 0;
  while (true) {
    attempt++;
    const turnsRef = { current: 0 };
    const result = await runSessionAttempt(opts, turnsRef);
    const isLastAttempt = attempt >= MAX_SESSION_ATTEMPTS;
    const canRetry =
      !result.ok &&
      !isLastAttempt &&
      turnsRef.current === 0 &&
      isRetryableSessionError(result.error ?? "");
    if (!canRetry) {
      return { ...result, attempts: attempt, retried: attempt > 1 };
    }
    logger.warn(
      { event: "session.retry", project: opts.cwd, attempt, error: result.error },
      "session failed with a transient transport error before producing output — retrying",
    );
    await Bun.sleep(retryBackoffMs(attempt));
  }
}
