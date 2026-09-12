import { appendFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { z } from "zod";
import { logger as mcpLogger } from "./logger.ts";
import { appLogger } from "../logger.ts";
import { processKind } from "../lib/process-context.ts";
import { getIuConfig } from "../lib/iu-openai.ts";
import {
  isClaudeModel,
  withModel,
  type Backend,
  type RouteFallback,
  type ToolRoute,
} from "../lib/routing.ts";

// ── Constants ──────────────────────────────────────────────────────────────────

const CLAUDE_BIN = existsSync(join(homedir(), ".local/bin/claude"))
  ? join(homedir(), ".local/bin/claude")
  : "claude";

// A worker is killed by an idle watchdog (no stdout chunk for this long — "wedged", not
// "slow"; stderr does not reset it) plus an absolute ceiling, not one wall-clock timer —
// mirrors modelpick's bench/spawn.ts. A single timer cannot tell "still working" from
// "wedged": glm-5.3-flash defaults to max reasoning effort and is genuinely slow on hard
// work (minutes per turn), and a caller's own `timeoutMs` used to kill it mid-turn on that
// alone.
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
// The floor applied on top of a caller's `timeoutMs` (`Math.max(timeoutMs, CEILING_FLOOR_MS)`)
// — deliberately generous so no existing caller's ceiling ends up tighter than its old
// single wall-clock timeout.
const CEILING_FLOOR_MS = 60 * 60 * 1000;
// How often the idle watchdog checks `lastChunkAt` — cheap enough to run every tick of a
// multi-minute session without mattering to the measurement.
const IDLE_CHECK_INTERVAL_MS = 5_000;

// Worker sessions run on either the IU unified endpoint's native Anthropic transport
// (metered per token, off Max — the same recipe dotfiles' `ca`/`claude_iu` use; the
// endpoint is itself a multi-provider gateway, its error text names it "Requesty Global
// Anthropic API" — see WRAPPED_TERMINAL_RE — so a `glm-*` id resolves through
// `getIuConfig()` exactly like a plain `claude-*` id) or the inherited Claude Code OAuth
// profile (the Max subscription, Claude ids only). WHICH one a given tool uses, and where
// it falls back to, is `server/lib/routing.ts`'s table — every caller passes
// `route: routeFor("<tool>")`. A `session_env` line is written per session (see
// `writeSessionEnv`) so usage-tracker classifies worker spend correctly (IU vs Max).

export type { Backend } from "../lib/routing.ts";

/**
 * Pick the logger for the process actually running this call, not the one that happened to
 * import this module first.
 *
 * `runSession` is shared: job handlers (check/review/dispatch/overview/narrative) call it from
 * inside the always-on HTTP server process, while `otel`'s tool handler calls it directly from
 * the MCP stdio process — a module-level `import { logger } from "./logger.ts"` tagged every
 * line `source: "mcp"` regardless of which one actually ran. A post-mortem on 8 `session.timeout`
 * entries had to join them against `jobs.db` by timestamp instead of filtering on `source`,
 * which is the bug this resolves. See `process-context.ts` for why this must be read per call
 * rather than captured once at module load.
 */
function runnerLogger(): typeof appLogger {
  return processKind() === "app" ? appLogger : mcpLogger;
}

/** Global kill switch for BOTH fallback directions (`max`→`iu` on quota, `iu`→`max`
 *  on an IU transport failure): "iu" (default) keeps them on, "none" pins every
 *  session to its route's primary backend. Read once at module load — a flip needs
 *  `make reload`. */
const WORKER_FALLBACK: "iu" | "none" =
  process.env.SIDECLAW_WORKER_FALLBACK === "none" ? "none" : "iu";

const CLAUDE_LOG_DIR = join(homedir(), ".claude", "logs");

/** Env var names that look like a credential. Matched case-insensitively against the
 *  inherited environment and deleted before the worker is spawned. Deliberately broad —
 *  a false positive costs a worker a variable it almost certainly did not need, while a
 *  false negative hands a live token to a session whose prompt may be attacker-written. */
const SENSITIVE_ENV_RE =
  /(TOKEN|SECRET|PASSWORD|PASSWD|_KEY|APIKEY|API_KEY|CREDENTIAL|BEARER|SESSION_ID)/i;

/** Exempt from the scrub: the CLI's own auth path. On the `max` backend the inherited
 *  OAuth profile is how the worker authenticates at all, so scrubbing it would break
 *  every session rather than harden it. The `iu` backend sets its own ANTHROPIC_*
 *  vars after this point regardless. */
const ALWAYS_KEEP_ENV = new Set(["CLAUDE_CODE_OAUTH_TOKEN"]);

/** Mirror dotfiles' SessionStart hook: record the worker's base_url keyed by its
 * transcript sessionId so usage-tracker's classifier (base_url present → "iu",
 * null/missing → "max") tags the run correctly. Called for both the "iu" backend
 * (real base_url) and the "max" backend (explicit null — see the max branch below
 * for why null is written rather than skipped). Idempotent — safe if the hook also
 * fires. Never throws. */
function writeSessionEnv(
  sessionId: string,
  baseUrl: string | null,
  model: string,
  backend: Backend,
): void {
  try {
    mkdirSync(CLAUDE_LOG_DIR, { recursive: true });
    const now = new Date().toISOString();
    const line =
      JSON.stringify({
        ts: now,
        src: "sideclaw",
        event: "session_env",
        level: "info",
        data: { session: sessionId, base_url: baseUrl, model, backend },
      }) + "\n";
    appendFileSync(join(CLAUDE_LOG_DIR, `${now.slice(0, 10)}.jsonl`), line);
  } catch {
    /* never throw from telemetry */
  }
}

// Per-session attribution log. Each runSession invocation appends one record
// describing tool / cwd / time window — usage-tracker joins individual worker
// requests to it by ts ∈ [tsStart, tsEnd], so token rows get tagged with which
// sideclaw tool (check/review/…) caused them.
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
  /** The tool's `{ model, backend, fallback }` from `routeFor()` in
   *  `server/lib/routing.ts` — the only source of a worker's model and auth path. */
  route: ToolRoute;
  /** Per-call model override on top of `route.model` (a job's `model` param). Applied
   *  via `withModel`: a gateway id forces the backend to `iu` since Max cannot serve it. */
  model?: string;
  jsonSchema?: Record<string, unknown>;
  maxTurns?: number;
  timeoutMs?: number;
  /**
   * `--setting-sources` value. Default "project" (repo CLAUDE.md only) keeps the
   * system prompt small — most one-shot workers don't need the global rule set.
   * Use "user,project" for tools that benefit from the global code-style/typescript
   * rules (review).
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
   * Let a timeout AFTER first output still move onto the fallback lane. Default false:
   * a worker that already produced turns may have half-done its work (dispatch,
   * excalidraw), so only a silent timeout switches. Callers whose worker has no side
   * effects (overview: every tool disallowed; check: report-only, Write/Edit disallowed)
   * opt in — measured 2026-09-07, glm-5.3-flash produced 2 assistant turns on overview
   * and then hung to the 240 s cap, and the job failed with no Haiku attempt.
   */
  retryAfterOutput?: boolean;
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
   * usage-tracker can tag worker requests back to the sideclaw tool that caused
   * them. Optional but every job handler should set it.
   */
  tool?: string;
  /**
   * The async job this session runs inside, if any (`job.id` from `jobs/store.ts`). Carried
   * through purely for log correlation — every error-path log below includes it alongside
   * `tool`/`model`/`backend` so a failure line is self-describing instead of needing a
   * timestamp join against `jobs.db`. Absent for a session that isn't job-backed (e.g. `otel`,
   * which runs synchronously inside the MCP tool call).
   */
  jobId?: string;
  /**
   * Reports whether `jobId` has a pending `POST /api/jobs/:id/cancel` request. Injected
   * dependency, same shape as `ShutdownDeps` in `server/lib/shutdown.ts` — this module must
   * not import `server/jobs/store.ts` directly (store.ts already imports
   * `terminateSessionsForJob` from here; the reverse import would be a cycle). The
   * executor/handler path (`server/jobs/executor.ts` down through each handler's `runSession`
   * call) supplies `store.ts`'s `isCancelRequested` here. Absent for a session that isn't
   * job-backed, same as `jobId`. */
  isCancelled?: (jobId: string) => boolean;
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
   * Optional output validator. Some worker models ignore `--json-schema` and
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
  /** Backend the attempt that produced this result actually ran on — set
   *  regardless of ok/error, so a job handler or the retry loop can tell which
   *  auth path a given result came from (relevant once a quota fallback can
   *  switch mid-session-launch from "max" to "iu"). */
  backend?: Backend;
  /** Model the attempt actually ran on — differs from the route's primary after a
   *  fixed-model fallback (check's glm-5.3-flash → claude-haiku-4-5 on Max). */
  model?: string;
  /** The attempt never spawned a worker: IU credentials could not be resolved. The
   *  reverse fallback treats this like an IU transport failure, without a same-backend
   *  retry first (there is nothing to retry). */
  iuConfigError?: boolean;
  /** Transport/provider-sourced text ONLY (stderr, the runner's own constructed error
   *  message) — never model-generated stdout. Feeds `isQuotaError` classification;
   *  `error` stays the full human-readable text regardless. Unset on branches whose
   *  only text is the worker's own output (an unparseable `result`, a schema-validation
   *  failure) — those must never quota-classify. See `isQuotaError`'s doc comment. */
  classificationText?: string;
  /** The runner observed a stream-json `system`/`api_retry` event during this attempt —
   *  a structured signal that the CLI itself retried after a provider-side 429/529.
   *  Checked ahead of the `classificationText` regex in `planNextAttempt`. */
  hadApiRetry?: boolean;
  /** The result event's own `api_error_status` — set when the failure is the gateway/API
   *  refusing the request outright (bad model id, cost-ceiling denial) rather than a
   *  model-produced error. See the doc comment above `apiErrorStatus` in
   *  `runSessionAttempt` for the measured stream shape: this failure produces one
   *  synthetic assistant "turn" that is Claude Code's own error text, so `noOutputYet`
   *  does not catch it — `planNextAttempt` must gate on this field instead. Unset on the
   *  timeout path and on `!envelope` (no result event ever arrived to carry it). */
  apiErrorStatus?: number;
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
  total_cost_usd?: number;
  num_turns?: number;
  /** Set by the CLI when the failure is the gateway/API itself refusing the request
   *  (bad model id, cost-ceiling denial, …) rather than a model-produced error — see
   *  `apiErrorStatus`'s doc comment in `runSessionAttempt` for the measured shape. */
  api_error_status?: number | null;
  /** Token accounting on the result event — see stream-format.md's `result` shape.
   *  `output_tokens_details.thinking_tokens` is absent on some models/backends rather
   *  than zero, hence the nested optional. */
  usage?: ClaudeUsage;
}

/** Result-event `usage` block — see `.claude/skills/claude-cli/references/stream-format.md`. */
interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
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
  // result-event field: see `ClaudeJsonEnvelope.api_error_status`.
  api_error_status?: number | null;
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

export interface WorkerEnvInput {
  /** Routed tool name, tags `USAGE_LANE` as `sideclaw:<tool>` — `"unknown"` when absent. */
  tool?: string;
  backend: Backend;
  model: string;
  /** Only read on the `iu` backend. */
  anthropicBase: string;
  /** Only read on the `iu` backend. */
  iuKey: string;
  extraEnv?: Record<string, string>;
  /** Override for tests — defaults to `process.env`. Only entries with a defined value are
   *  copied, mirroring `Object.entries` skipping `undefined`. */
  baseEnv?: Record<string, string | undefined>;
}

/**
 * The `USAGE_LANE` value for a routed tool — `sideclaw:<tool>`, coarsened to the part
 * before the first `:` in `tool` itself. `review`'s sub-steps (`review:router`,
 * `review:angle`, `review:adversary`, `review:synthesis`) pass their own sub-tool label
 * through `SessionOptions.tool` for logging/attribution, but usage-tracker's `sub_tool`
 * column is a flat string with no sub-lane concept (`report.ts`'s grouping is a plain
 * `coalesce`, nothing wildcard-aware) — one lane per Max-lane worker keeps
 * `stats --by sub_tool` a single `sideclaw:review` row instead of four fragments. Single
 * chokepoint so every spawn path (all of them already route through `buildWorkerEnv`)
 * gets this for free rather than each call site coarsening its own `tool` string.
 */
export function usageLane(tool: string | undefined): string {
  const base = (tool ?? "unknown").split(":")[0];
  return `sideclaw:${base}`;
}

/** The worker's full spawn env. Split out of `runSessionAttempt` so `USAGE_LANE` and the
 *  sensitive-env scrub around it are assertable without spawning anything — same reasoning as
 *  `buildSessionArgs` above. Order matters and is preserved exactly: copy the inherited env,
 *  strip the parent's own session identity, tag `USAGE_LANE`, THEN scrub every
 *  credential-shaped key (so a name that happens to look sensitive, like `USAGE_LANE` does
 *  not, is scrubbed before the backend switch writes its own auth — see the inline comment
 *  below for why order there is load-bearing), then apply the backend/gateway/extraEnv
 *  layers, each of which can reintroduce a var the scrub removed on purpose. */
export function buildWorkerEnv(input: WorkerEnvInput): Record<string, string> {
  const { tool, backend, model, anthropicBase, iuKey, extraEnv, baseEnv = process.env } = input;

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v !== undefined) env[k] = v;
  }
  delete env.CLAUDE_SESSION_ID;
  delete env.CLAUDE_PARENT_SESSION_ID;
  env.CLAUDE_ENTRYPOINT = "worker";
  // Read by usage-tracker's claude-code collector (via hooks/notify.ts's session_env
  // log line) to attribute this Max-lane worker's cost to its routed tool.
  env.USAGE_LANE = usageLane(tool);
  // The worker env is copied from this process wholesale, so it carries whatever the
  // LaunchAgent was started with — including live credentials the worker has no reason
  // to hold. Scrub them BEFORE the switch below writes the session's own auth
  // (`ANTHROPIC_AUTH_TOKEN` matches this regex) — a credential the switch sets must
  // survive it. Measured 2026-08-31 with the scrub AFTER the switch: it deleted the
  // just-written IU key, the CLI fell through to the inherited OAuth profile, and the
  // worker died with "401 Unauthorized: Authorization parsing failed". Masked on a `max`
  // route, which serves every claude-* id via OAuth, so only an `iu` route walks the
  // broken path.
  //
  // A worker that never sees a token cannot leak one. This matters most for `dispatch`,
  // whose prompt is assembled from untrusted material — but it is the right default for
  // every worker, so it lives here rather than in one handler. `Bash` is available to
  // these sessions, so `env` is one command away. Tools that genuinely need a credential
  // pass it explicitly via `extraEnv` (review does this for the research-gateway),
  // applied after all of this and therefore still winning.
  for (const key of Object.keys(env)) {
    if (SENSITIVE_ENV_RE.test(key) && !ALWAYS_KEEP_ENV.has(key)) delete env[key];
  }
  // ANTHROPIC_API_KEY is deleted in every branch: it is rejected by claude v2.x
  // ("Not logged in") and would shadow ANTHROPIC_AUTH_TOKEN.
  delete env.ANTHROPIC_API_KEY;
  // Exhaustive over Backend: a new variant must declare its own auth handling rather
  // than inheriting another branch's credentials by omission.
  switch (backend) {
    case "iu":
      // IU native Anthropic transport — same recipe as dotfiles' claude_iu(). The
      // beta headers are an Anthropic Messages-protocol detail the CLI sends
      // regardless of which model it asks for, and the native transport passes
      // them straight through to IU's gateway unmodified.
      env.ANTHROPIC_BASE_URL = anthropicBase;
      env.ANTHROPIC_AUTH_TOKEN = iuKey;
      break;
    case "max":
      // Fall through to the inherited OAuth profile (the Max subscription). Delete
      // rather than skip — the parent env is copied wholesale above, so an inherited
      // ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN would silently shadow OAuth and push
      // the worker back onto IU despite the flag.
      delete env.ANTHROPIC_BASE_URL;
      delete env.ANTHROPIC_AUTH_TOKEN;
      break;
    default:
      backend satisfies never;
  }
  // Gateway-tier env for non-Claude ids, mirroring dotfiles' `ca` gateway branch
  // (config/zsh/claude.zsh). Three things a gateway id needs that a claude-* id does not:
  //  - every ANTHROPIC_DEFAULT_* tier pinned to the SAME id, or a CLI-internal call
  //    (title generation, compaction, a spawned subagent) asks the gateway for a
  //    claude-* default it does not serve — measured 2026-08-31 as a hard
  //    `[claude-code:unrecognized_model]` exit 1 on `generate_session_title` that
  //    killed the whole session even though the main loop was fine;
  //  - CLAUDE_CODE_MAX_CONTEXT_TOKENS matched to the model's real window via
  //    GATEWAY_CONTEXT_TOKENS — Claude Code only trusts api.anthropic.com to
  //    self-report a window, so a 1M gateway model otherwise budgets and
  //    auto-compacts at 200k, and a blanket 1M would hard-reject on smaller models;
  //  - API_TIMEOUT_MS raised — these models legitimately take minutes per turn
  //    (glm-5.3-flash measured 280–737s per benchmark turn), and the default turns
  //    slow-but-correct into a spurious timeout.
  // Claude ids keep the inherited defaults: their `[1m]` window handling lives in the
  // model id itself, and the CLI's own defaults resolve against served models.
  if (!isClaudeModel(model)) {
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
    env.ANTHROPIC_DEFAULT_FABLE_MODEL = model;
    const ctx = String(gatewayContextTokens(model));
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = ctx;
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = ctx;
    env.API_TIMEOUT_MS = "3000000";
  }
  if (extraEnv) Object.assign(env, extraEnv);

  return env;
}

// ── Retry policy ───────────────────────────────────────────────────────────────
//
// Moving a worker off Max onto the IU unified endpoint's gateway models means
// intermittent 429/503 under burst — measured, plus one transient 502 that three
// immediate retries cleared. A whole session launch (the `claude -p` subprocess) is
// expensive to redo, so retrying is bounded and narrow: only transport-level
// failures, and only before the worker has produced any output a retry could
// duplicate or corrupt.

export interface ResolvedBackend {
  backend: Backend;
  reason: "non-claude-model" | "ok";
}

/** Effective backend for a route, resolved once per session launch. Pure, no I/O.
 *
 *  A non-Claude model id is always forced onto `iu` — `max` only ever serves
 *  Anthropic's own models. `buildRoutingTable`/`withModel` (routing.ts) already
 *  guarantee this by construction for any route built through the table, so this is
 *  defense in depth for a caller that hands `runSession` a hand-built route
 *  bypassing it (as `tests/session-retry.test.ts` does directly). Every other route
 *  just runs on its configured backend.
 *
 *  This used to also read live Max subscription quota and pre-empt a `max` session
 *  onto `iu` above a ceiling, before the session even launched. Removed 2026-09-08 —
 *  false-positive triggers off a stale/misread quota reading, and every concurrent
 *  worker pre-empting at once under burst, cost the owner more than the quota it
 *  saved. Do not re-add a proactive check here: the REACTIVE fallback below (a
 *  live `max` session that actually hits a quota-flavoured failure switches its
 *  next attempt to `iu`) is the real safeguard and is unchanged. */
/** Backend fallbacks in the last hour, newest first. Visibility only — nothing reads this to
 *  throttle, gate or queue a job. It exists because the proactive quota ceilings that used to
 *  live here were removed: across the whole log history they never once fired on real Max
 *  exhaustion, only on false positives, so what replaces them is a number a human can look at
 *  rather than a gate that guesses. Process-local and unpersisted by design — jobs run their
 *  sessions in the HTTP server, so that process's count is the one worth reporting, and a
 *  restart legitimately resets it. */
const fallbackLog: { at: number; reason: string; tool: string }[] = [];
const FALLBACK_WINDOW_MS = 60 * 60 * 1000;

/** Exported only so `tests/session-retry.test.ts` can drive the window/aggregation
 *  logic directly (via `bun:test`'s `setSystemTime`) without spawning a session — no
 *  other caller outside this module should ever call it. */
export function recordFallback(reason: string, tool: string): void {
  const now = Date.now();
  fallbackLog.push({ at: now, reason, tool });
  // Prune here rather than on read: a fallback is rare, a health poll is every 30 s.
  const cutoff = now - FALLBACK_WINDOW_MS;
  while (fallbackLog.length > 0 && fallbackLog[0]!.at < cutoff) fallbackLog.shift();
}

export function backendFallbacksLastHour(): { count: number; reasons: Record<string, number> } {
  const cutoff = Date.now() - FALLBACK_WINDOW_MS;
  const recent = fallbackLog.filter((f) => f.at >= cutoff);
  const reasons: Record<string, number> = {};
  for (const f of recent) reasons[f.reason] = (reasons[f.reason] ?? 0) + 1;
  return { count: recent.length, reasons };
}

/** Consecutive failures for one `${tool}@${backend}/${model}` route, since the last
 *  success on that same route. Process-local and unpersisted, same rationale as
 *  `fallbackLog` above — a restart resets a streak along with everything else this
 *  process was mid-observing. Reset to 0 (not deleted) on success so `routeFailureStreaks`
 *  only has to filter, never distinguish "never failed" from "recovered". */
const routeStreaks = new Map<string, number>();
export const ROUTE_STREAK_LIMIT = 3;

/** Caps `routeStreaks`. The model component of a route key is not a closed set — e.g.
 *  `narrative`'s `params.model` is a caller-supplied free string — so without a bound a
 *  client that varies its model on every call grows this map forever. A Map preserves
 *  insertion order, so "oldest" below is simply the first key. */
export const ROUTE_STREAK_MAX_KEYS = 64;

function routeKey(tool: string, backend: string, model: string): string {
  return `${tool}@${backend}/${model}`;
}

/** Evict the oldest entry before inserting a genuinely NEW key at capacity. A no-op for
 *  a key already tracked — that call is an update, not a growth, and must not evict
 *  anything just because it happened to run at capacity. */
function evictOldestIfAtCapacity(key: string): void {
  if (routeStreaks.has(key) || routeStreaks.size < ROUTE_STREAK_MAX_KEYS) return;
  const oldestKey = routeStreaks.keys().next().value;
  if (oldestKey !== undefined) routeStreaks.delete(oldestKey);
}

/** Record one attempt's outcome against its route's streak. Exported only so
 *  `tests/session-retry.test.ts` can drive it directly — no other caller outside this
 *  module should ever call it. */
export function recordRouteOutcome(
  tool: string,
  backend: string,
  model: string,
  ok: boolean,
): void {
  const key = routeKey(tool, backend, model);
  evictOldestIfAtCapacity(key);
  if (ok) {
    routeStreaks.set(key, 0);
    return;
  }
  routeStreaks.set(key, (routeStreaks.get(key) ?? 0) + 1);
}

/** Non-zero streaks only — a route that has never failed, or just recovered, has
 *  nothing worth surfacing on a health poll. */
export function routeFailureStreaks(): Record<string, number> {
  const streaks: Record<string, number> = {};
  for (const [key, count] of routeStreaks) {
    if (count > 0) streaks[key] = count;
  }
  return streaks;
}

/** Test-only: wipe every tracked route, same rationale as `server/jobs/store.ts`'s
 *  `__resetForTests` for `draining` — `routeStreaks` is process-global module state, so
 *  a test asserting an exact bound (e.g. the eviction cap) needs a known-empty starting
 *  point rather than whatever earlier test files happened to leave behind. Never called
 *  from production code — a real process has exactly one of these maps for its own
 *  lifetime and never wants it wiped mid-run. */
export function __resetRouteStreaksForTests(): void {
  routeStreaks.clear();
}

export function resolveBackend(route: ToolRoute): ResolvedBackend {
  const { model, backend } = route;
  if (!isClaudeModel(model)) return { backend: "iu", reason: "non-claude-model" };
  return { backend, reason: "ok" };
}

// The IU gateway re-wraps a rate-limit/overload the same way it wraps a client
// error (see WRAPPED_TERMINAL_RE below), and Max's own OAuth path 429s with
// "usage limit"/"rate limit" language rather than a bare status code. Matched
// case-insensitively, but ONLY against transport/provider-sourced text
// (`SessionResult.classificationText` — a failed attempt's stderr and the runner's
// own constructed error message), NEVER the model's own stdout. A worker's output
// (a diff, an otel trace dump, a check report) can legitimately contain the words
// "429" or "quota" with no real exhaustion behind it, and since a match here moves
// the NEXT attempt off the already-paid `max` subscription onto the metered,
// billed-per-token `iu` lane, a false positive there is not free — it spends real
// money on a run that would have finished fine on `max`. See `runSessionAttempt`
// for which branches populate `classificationText` and which deliberately leave it
// unset. The structured `api_retry` stream-json signal (`SessionResult.hadApiRetry`
// — the CLI itself retried after a provider-side 429/529) is checked first in
// `planNextAttempt` and wins outright when present; it is not exhaustive on its own
// (a definitive quota block the CLI never got to retry emits no `api_retry` event),
// so this regex stays the fallback path rather than the only one.
const QUOTA_ERROR_RE = /hit your (usage )?limit|usage limit|rate.?limit|429|overloaded|quota/i;

/** Does this TRANSPORT-sourced text look like Max quota/rate-limit exhaustion rather
 *  than a generic transport or logic failure? Pure — feeds the reactive once-only
 *  `max` → `iu` retry in `runSession` (call with `classificationText`, never the full
 *  human-readable `error`), never the transient-transport retry
 *  (`isRetryableSessionError`), which stays backend-agnostic. */
export function isQuotaError(text: string): boolean {
  return QUOTA_ERROR_RE.test(text);
}

// Text patterns for an `iu`-backend attempt the gateway itself refused outright:
// `access_denied`, `cost-service-denial`, a bare 403. Deliberately narrower than the
// first cut of this regex, which also matched two Claude Code CLI warning lines
// (`unrecognized_model`, `connectors are disabled`) — those were confirmed 2026-09-10
// to print on EVERY IU run, including a successful one, but ALSO on a genuine zero-output
// transport failure (a 502/ECONNRESET before the first turn) that has nothing to do with
// a gateway refusal. With them in the regex, that ordinary transport failure's
// `classificationText` carried the banner too, so `isIuNeverAnswered` matched it and
// skipped the documented one same-backend retry (`planNextAttempt`'s `iu` transport
// lane) straight to the `max` fallback — a real, reachable false positive, not a
// theoretical one. Dropped rather than gated further: nothing here needs them to catch
// the shapes `apiErrorStatus` (see `runSessionAttempt`) now covers directly.
const IU_NEVER_ANSWERED_RE = /access_denied|cost-service-denial|\b403\b/i;

/** `SessionResult.apiErrorStatus` values that mean the request itself will never
 *  succeed — bad/missing auth, an unknown model id, access denied — as opposed to
 *  429/5xx, which are the existing retry ladder's territory (rate limits, transient
 *  gateway overload) and must keep going through it rather than jump straight to a
 *  backend switch. See `gatewayRefused` in `planNextAttempt`. */
const GATEWAY_REFUSED_STATUSES = new Set([400, 401, 403, 404]);

/** Does this TRANSPORT-sourced text look like the IU gateway refusing the request
 *  outright (cost ceiling, access denial) rather than a generic transport error? Pure
 *  — mirrors `isQuotaError`'s contract: callers must gate on zero output themselves. */
export function isIuNeverAnswered(text: string): boolean {
  return IU_NEVER_ANSWERED_RE.test(text);
}

/** Append the result event's own `api_error_status` (see `SessionResult.apiErrorStatus`)
 *  to an already-built classification string, so the text-based classifiers can see it
 *  too — transport/CLI-sourced, same standing as the rest of that text. A no-op when no
 *  status was observed (the timeout and `!envelope` paths, which never reached a result
 *  event). Shared by both `runSessionAttempt` return paths that can carry a status. */
function appendApiErrorStatus(text: string, status: number | undefined): string {
  return status !== undefined ? `${text} api_error_status=${status}` : text;
}

/** Classify an `is_error` result envelope for the reactive quota fallback. Pure —
 *  extracted so the zero-turn carve-out below is unit-testable without spawning a
 *  session.
 *
 *  `envelope.errors` is the CLI's own structured error array — transport-sourced,
 *  always safe to classify against. `envelope.result` is NOT, in general: on an
 *  `is_error` envelope it can still carry real model-generated text (confirmed by
 *  reading the branch that produces it — a worker ending mid-response can leave its
 *  own stdout in `result` alongside `is_error: true`), so classifying it
 *  unconditionally would send a run that would have finished fine on `max` onto the
 *  metered `iu` lane on nothing more than the word "quota" in the model's own output.
 *
 *  But a terminal Max quota/usage-limit rejection is observed to arrive in exactly
 *  this shape too: `is_error` with no `errors` array and no `result` text
 *  proven to be the model's — because it never got a turn at all. `turnsObserved`
 *  (assistant-turn count, incremented only on a stream-json `assistant` event — see
 *  `handleEvent` in `runSessionAttempt`) is a hard proof, not a heuristic: zero turns
 *  means the model produced literally nothing, of any kind, so `result` cannot be its
 *  text — whatever text is there must be transport/gateway-sourced, and is the ONLY
 *  diagnosis available (no `errors`, and with no assistant turn there was never a
 *  chance to observe an `api_retry` event either). Below that carve-out, `result`
 *  stays unclassified, same as before.
 *
 *  The asymmetry that justifies drawing the line at turns rather than, say,
 *  `lastAssistantText`: a false positive here (misclassifying real zero-turn model
 *  text as quota) costs one wasted retry on `iu`; a false negative (missing a real
 *  quota block because it doesn't fit this exact shape) means the reactive fallback
 *  — the only safeguard left since the proactive quota pre-check was removed
 *  2026-09-08 — never fires at all. That asymmetry is why the carve-out exists
 *  rather than leaving `is_error` unclassified whenever `errors` is empty. */
export function classifyErrorEnvelope(
  envelope: { errors?: string[]; result?: string },
  turnsObserved: number,
): { errMsg: string; classificationText: string | undefined } {
  const structuredError = envelope.errors?.join("; ");
  if (structuredError !== undefined) {
    return { errMsg: structuredError, classificationText: structuredError };
  }
  const result = envelope.result;
  return {
    errMsg: String(result ?? "Unknown error"),
    classificationText: turnsObserved === 0 ? result : undefined,
  };
}

/** Shared failure shape for the schema-validation and JSON-parse branches — both are
 *  "the session completed at the API level, but its own output didn't parse/validate",
 *  so neither ever sets `classificationText` (the text is the model's own stdout, not
 *  transport-sourced). `hadApiRetry` still propagates: it describes the attempt's
 *  transport behavior, independent of how the attempt's own output turned out — it
 *  used to be silently dropped on both branches while present on every other failure
 *  return. Pure and exported purely so that propagation has direct unit coverage. */
export function unclassifiedOutputFailure<T = unknown>(
  error: string,
  rawText: string,
  hadApiRetry: boolean,
  backend: Backend,
  model: string,
): SessionResult<T> {
  return { ok: false, error, noOutput: true, rawText, hadApiRetry, backend, model };
}

/** Total attempts per session, including the first — at most 2 retries. */
/** Real context window per gateway (non-Claude) model id, mirroring `_CA_CTX` in
 *  dotfiles' `config/zsh/claude.zsh` — keep the two in step. Claude Code only trusts
 *  api.anthropic.com to self-report a window, so over any custom base URL it assumes
 *  200k and auto-compacts there. This is a client-side budget, not a server limit:
 *  set it HIGHER than the real window and a clean auto-compact becomes a hard API
 *  rejection mid-session — which is why 1M is not a safe blanket default
 *  (kimi-k2.7-code hard-caps at 262144). Anything absent falls back to 200k:
 *  deliberately conservative, not measured. `modelpick`'s `bun run pick` measures
 *  these; re-run it when adding a row. */
const GATEWAY_CONTEXT_TOKENS: Record<string, number> = {
  "glm-5.3-flash": 1_000_000, // measured — still accepted at a 1.1M probe ceiling
  "DeepSeek-V4-Pro": 1_000_000, // documented (IU portal catalog), not yet probed
  "DeepSeek-V4-Flash": 1_000_000, // measured — still accepted at a 1.1M probe ceiling
  "kimi-k2.7-code": 262_144, // measured — the gateway names the number in its 400
};
const GATEWAY_CONTEXT_FALLBACK = 200_000;

export function gatewayContextTokens(model: string): number {
  return GATEWAY_CONTEXT_TOKENS[model] ?? GATEWAY_CONTEXT_FALLBACK;
}

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

const RETRY_BACKOFF_BASE_MS = 2000;
const RETRY_BACKOFF_FACTOR = 3;
const RETRY_BACKOFF_CAP_MS = 30_000;

/** Backoff delay (ms) before the retry following a failed attempt N (1-indexed). Capped
 *  exponential with full jitter — `random(0, min(cap, base * factor^(attempt-1)))` — rather
 *  than a fixed 1s/3s cadence: a bounded set of workers retrying a shared transient IU
 *  outage in lockstep re-hits the gateway at the same instant every time, which is exactly
 *  what jitter exists to break up. `MAX_SESSION_ATTEMPTS` stays 3, so this only ever runs
 *  for attempt 1 or 2. */
export function retryBackoffMs(attempt: number): number {
  const ceiling = Math.min(
    RETRY_BACKOFF_CAP_MS,
    RETRY_BACKOFF_BASE_MS * RETRY_BACKOFF_FACTOR ** (attempt - 1),
  );
  return Math.random() * ceiling;
}

// ── Runner ─────────────────────────────────────────────────────────────────────

/** Worker subprocesses alive in THIS process, mapped to the job they belong to (`undefined`
 *  for a session run outside the job system, e.g. review's adversary text call). The HTTP
 *  server's SIGTERM handler (`server/index.ts`) reads the count to decide how long to wait,
 *  then terminates what is left so a `make reload` never orphans a `claude -p` that keeps
 *  editing a worktree the boot sweep is about to delete. */
const activeProcs = new Map<ReturnType<typeof Bun.spawn>, string | undefined>();

export function activeSessionCount(): number {
  return activeProcs.size;
}

/** Test-only: register an already-constructed fake "proc" into `activeProcs` under a given
 *  jobId, so `terminateSessionsForJob`/`terminateActiveSessions` can be exercised without
 *  spawning a real `claude -p` subprocess. The caller only needs to satisfy the `exitCode`/
 *  `kill` shape those two functions actually read — cast at the call site. */
export function __registerProcForTests(
  proc: ReturnType<typeof Bun.spawn>,
  jobId: string | undefined,
): void {
  activeProcs.set(proc, jobId);
}

export function __resetActiveProcsForTests(): void {
  activeProcs.clear();
}

/** Kill every active worker subprocess and return the ids of the jobs they belonged to (a
 *  process with no `jobId` — a session run outside the job system — is silently dropped, not
 *  emitted as `undefined`). server/jobs/store.ts's `markDrainKilled` records exactly these ids
 *  before the killed subprocess's `execute()` catch can run, so a job genuinely terminated by
 *  this call can be told apart from an unrelated failure landing in the same drain window —
 *  see the comment on `execute()`'s catch block. */
export function terminateActiveSessions(): string[] {
  const jobIds: string[] = [];
  for (const [proc, jobId] of activeProcs) {
    if (proc.exitCode === null) {
      proc.kill("SIGTERM");
      if (jobId !== undefined) jobIds.push(jobId);
    }
  }
  return jobIds;
}

/** The per-job counterpart to `terminateActiveSessions()`'s "kill everything" (drain): signals
 *  only the worker subprocess(es) registered for ONE job (`POST /api/jobs/:id/cancel` →
 *  `server/jobs/store.ts`'s `cancelJob`). Same two-stage SIGTERM → 5s → SIGKILL escalation as
 *  the per-attempt timeout above (:1166-1186), but self-contained here since a cancel isn't
 *  tied to that attempt's own timeout clock. Returns whether anything was actually signalled —
 *  false if the job's worker had already exited (or the job never reached `running` with a
 *  registered proc, e.g. it was still queued). */
export function terminateSessionsForJob(jobId: string): boolean {
  let signalled = false;
  for (const [proc, id] of activeProcs) {
    if (id !== jobId || proc.exitCode !== null) continue;
    signalled = true;
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }, 5000);
  }
  if (!signalled) {
    // Not necessarily a bug: the job may still be `pending` (no proc yet — `cancelJob` handles
    // that case without ever calling this), or its worker may have exited in the gap between
    // `cancelJob` reading `running` and this call. Worth a warn either way — a cancel that
    // signalled nothing depends entirely on `runSession`'s own cancel check (top-of-loop / after
    // an attempt) to actually stop the job, rather than the SIGTERM doing it.
    runnerLogger().warn(
      { event: "session.cancel_no_proc", jobId },
      "cancel requested but no live worker subprocess was registered for this job",
    );
  }
  return signalled;
}

/** Thrown by `runSession`'s retry loop when a `POST /api/jobs/:id/cancel` was observed for this
 *  job — distinguishable from an ordinary session failure so it is never retried, never falls
 *  back to another backend, and callers that inspect the error type (none currently do;
 *  `server/jobs/store.ts`'s `execute()` catch instead consults the job row's persisted
 *  `cancelRequestedAt`, which is authoritative regardless of how a handler wraps this error) can
 *  tell the two apart. */
export class SessionCancelledError extends Error {
  constructor(jobId: string) {
    super(`session cancelled by request (job ${jobId})`);
    this.name = "SessionCancelledError";
  }
}

/** A retry that skips `resolveBackend`: the loop already decided where the next
 *  attempt goes. `rate-limited` is the `max`→`iu` quota lane, `iu-unavailable` the
 *  reverse `iu`→`max` lane. */
export interface ForcedAttempt {
  backend: Backend;
  model: string;
  reason: "rate-limited" | "iu-unavailable";
}

/** One session launch. Renamed out of `runSession` so the retry loop can wrap it —
 *  `turnsRef` is populated as soon as the worker's first assistant turn streams back,
 *  which is what lets the wrapper tell "failed before doing anything" from "failed
 *  after it may have started writing files". */
async function runSessionAttempt<T = unknown>(
  opts: SessionOptions<T>,
  turnsRef: { current: number },
  forced?: ForcedAttempt,
): Promise<SessionResult<T>> {
  const {
    cwd,
    prompt,
    jsonSchema,
    maxTurns = 30,
    timeoutMs = 10 * 60 * 1000,
    settingSources = "project",
    readOnly = false,
    mcpServers,
    extraDisallowedTools,
    extraEnv,
    tool,
    jobId,
    validate,
    onActivity,
  } = opts;
  const route = withModel(opts.route, opts.model);
  const model = forced?.model ?? route.model;

  const sessionUuid = randomUUID();
  const tsStart = new Date().toISOString();
  // Resolved before emitAttribution so nothing below depends on declaration order.
  // See the module-level comment on `resolveBackend` above. A forced retry skips it
  // outright: the caller already decided.
  const resolved: ResolvedBackend = resolveBackend(route);
  const backend: Backend = forced ? forced.backend : resolved.backend;
  // Shared identity for every log line below that reports a session failure. A post-mortem
  // on 8 `session.timeout` entries came back with `model: null, backend: null, tool: null` and
  // had to be joined against jobs.db by timestamp to find out which job each one belonged to —
  // this is what makes each line self-describing instead.
  const errCtx = { tool, model, backend, jobId, timeoutMs };
  if (forced) {
    recordFallback(forced.reason, tool);
    runnerLogger().warn(
      { event: "backend.fallback", ...errCtx, reason: forced.reason },
      forced.reason === "rate-limited"
        ? "falling back to iu after a max-quota-flavored failure"
        : "falling back to max — IU produced no output (transport failure, no credentials, or a silent timeout)",
    );
  } else {
    runnerLogger().info(
      { event: "backend.select", ...errCtx, reason: resolved.reason },
      "backend selected",
    );
  }

  const emitAttribution = (
    outcome: "ok" | "error" | "timeout_idle" | "timeout_ceiling",
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

  let anthropicBase = "";
  let iuKey = "";
  if (backend === "iu") {
    try {
      const cfg = await getIuConfig();
      anthropicBase = cfg.anthropicBase;
      iuKey = cfg.key;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runnerLogger().error(
        { event: "session.iu_config_error", project: cwd, ...errCtx, error: message },
        "IU config unavailable",
      );
      emitAttribution("error", { reason: "iu_config_error" });
      return {
        ok: false,
        error: message,
        classificationText: message,
        backend,
        model,
        iuConfigError: true,
      };
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

  const env = buildWorkerEnv({ tool, backend, model, anthropicBase, iuKey, extraEnv });

  const startMs = performance.now();
  runnerLogger().info(
    {
      event: "session.spawn",
      project: cwd,
      model,
      maxTurns,
      jsonSchema: !!jsonSchema,
      settingSources,
      readOnly,
      mcpServers: mcpServers ? Object.keys(mcpServers) : [],
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
  activeProcs.set(proc, jobId);
  void proc.exited.finally(() => activeProcs.delete(proc));

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

  // Idle watchdog (killed only once no stdout chunk has arrived for IDLE_TIMEOUT_MS) plus
  // an absolute ceiling (Math.max(timeoutMs, CEILING_FLOOR_MS)) — see the module header
  // comment on IDLE_TIMEOUT_MS for why a single wall-clock timer can't tell "still working"
  // from "wedged". Same two-stage SIGTERM → wait 5s → SIGKILL as before either way.
  let killReason: "idle" | "ceiling" | null = null;
  let idleMsAtKill: number | null = null;
  let lastChunkAt: number | null = null;
  const spawnedAt = Date.now();
  let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
  const kill = (reason: "idle" | "ceiling"): void => {
    if (killReason) return; // the other watchdog already fired
    killReason = reason;
    idleMsAtKill = Date.now() - (lastChunkAt ?? spawnedAt);
    runnerLogger().error(
      { event: "session.timeout", project: cwd, ...errCtx, killReason, idleMsAtKill },
      "session timed out — SIGTERM",
    );
    proc.kill("SIGTERM");
    sigkillTimer = setTimeout(() => {
      sigkillTimer = null;
      if (proc.exitCode === null) {
        runnerLogger().error(
          { event: "session.timeout", project: cwd, ...errCtx, killReason },
          "session still alive — SIGKILL",
        );
        proc.kill("SIGKILL");
      }
    }, 5000);
  };
  const idleWatchdog = setInterval(() => {
    if (Date.now() - (lastChunkAt ?? spawnedAt) >= IDLE_TIMEOUT_MS) kill("idle");
  }, IDLE_CHECK_INTERVAL_MS);
  const ceilingMs = Math.max(timeoutMs, CEILING_FLOOR_MS);
  const ceilingTimer = setTimeout(() => kill("ceiling"), ceilingMs);

  // stderr is buffered whole (it's small — diagnostics only); stdout is consumed as
  // a live NDJSON stream so we can track per-event activity and capture the result.
  const stderrPromise = new Response(proc.stderr).text();

  let envelope: ClaudeJsonEnvelope | undefined;
  let turns = 0;
  let lastAction = "starting";
  // Most recent non-empty assistant text. Workers sometimes end a session on a
  // tool call, leaving the `result` envelope field empty even though it already
  // emitted its JSON in an earlier text turn. We keep that text so the
  // output-extraction fallback can recover it instead of failing the whole job.
  let lastAssistantText = "";
  // Worker's real transcript session id (from the stream's system/init event, not
  // sideclaw's own `sessionUuid`). Used to tag the session_env sidecar so
  // usage-tracker joins it to the right transcript.
  let workerSessionId: string | undefined;
  // Structured signal for quota classification (see `isQuotaError`'s doc comment):
  // the CLI itself retried after a provider-side 429/529 at least once during this
  // attempt. Truer than a text match, but not exhaustive — a definitive block the
  // CLI never got to retry sets this false while still being real quota exhaustion.
  let apiRetrySeen = false;
  // Measured 2026-09-10 (job c4f0f631, `--model glm-x` reproduced by hand): a gateway
  // refusal (unknown model, cost-ceiling denial) does NOT surface as zero turns — Claude
  // Code emits one synthetic `assistant` event whose text is its OWN error rendering
  // ("There's an issue with the selected model…"), then a `result` event with
  // `is_error: true, api_error_status: 404 (or 403, …), num_turns: 1`, then exits 1. That
  // one "turn" is Claude Code narrating the refusal, not model output, so `noOutputYet`
  // (turns === 0) is the wrong gate for this failure shape — `api_error_status` is the
  // right one, and it is transport/CLI-sourced same as `apiRetrySeen`, never model stdout.
  let apiErrorStatus: number | undefined;
  let sessionEnvWritten = false;
  const maybeWriteSessionEnv = () => {
    if (sessionEnvWritten || !workerSessionId) return;
    // "max" writes an explicit null rather than skipping the line: both classify
    // as billing="max" downstream, but an explicit record is distinguishable from
    // a missing/rotated-out log entry (models.ts documents that ambiguity as a
    // known silent-default-to-max weak point) and keeps the drift audit meaningful.
    writeSessionEnv(workerSessionId, backend === "max" ? null : anthropicBase, model, backend);
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
        if (ev.subtype === "api_retry") {
          lastAction = "api retry";
          apiRetrySeen = true;
        } else if (ev.subtype === "compact_boundary") lastAction = "compacting context";
        if (!workerSessionId && ev.session_id) {
          workerSessionId = ev.session_id;
          maybeWriteSessionEnv();
        }
        emitActivity();
        break;
      case "result":
        envelope = ev as ClaudeJsonEnvelope;
        if (typeof ev.api_error_status === "number") apiErrorStatus = ev.api_error_status;
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
      lastChunkAt = Date.now(); // idle watchdog liveness — stderr never resets this
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
  clearInterval(idleWatchdog);
  clearTimeout(ceilingTimer);
  if (sigkillTimer !== null) clearTimeout(sigkillTimer);

  const exitCode = await proc.exited;
  if (heartbeatHandle !== null) clearInterval(heartbeatHandle);
  const stderrTrimmed = stderr.trim();

  // A failed worker's stderr is the post-mortem — at debug it was invisible in the
  // default log pass and every "why did check die at 03:00" ended in a shrug.
  if (stderrTrimmed) {
    const failed = killReason !== null || exitCode !== 0 || !envelope || envelope.is_error === true;
    const fields = {
      event: "session.stderr",
      project: cwd,
      ...errCtx,
      exitCode,
      stderr: stderrTrimmed.slice(0, failed ? 4000 : 1000),
    };
    if (failed) runnerLogger().warn(fields, "session stderr (failed worker)");
    else runnerLogger().debug(fields, "session stderr");
  }

  runnerLogger().debug({ exitCode, killReason, turns, lastAction }, "session stream done");

  const durationMs = Math.round(performance.now() - startMs);

  if (killReason) {
    // Outcome distinguishes the two watchdogs — "idle" is a wedged worker that produced
    // no stdout for IDLE_TIMEOUT_MS, "ceiling" is one that kept the stream alive (still
    // emitting turns, however slowly) all the way to the absolute cap.
    emitAttribution(killReason === "idle" ? "timeout_idle" : "timeout_ceiling", {
      durationMs,
      turns,
      killReason,
      idleMsAtKill,
    });
    // Both branches keep the "Session timed out" prefix `timedOutStuck` matches in
    // `planNextAttempt` — only the detail differs.
    const error =
      killReason === "idle"
        ? `Session timed out — idle ${idleMsAtKill}ms with no stdout (budget ${IDLE_TIMEOUT_MS}ms)`
        : `Session timed out — hit its ${ceilingMs}ms ceiling`;
    // `classificationText` here is always this fixed string, which QUOTA_ERROR_RE never
    // matches, and a hang produces no `api_retry` event either — a Max quota exhaustion
    // that surfaces as a stall rather than a fast is_error/429 is invisible to both
    // fallback signals, so the reactive max→iu fallback never fires for it (the
    // proactive quota pre-check used to be the backstop here; removed 2026-09-08). Not
    // fixable by guessing — a timeout has no evidence either way — so just make the
    // blind spot visible instead of silent.
    if (backend === "max" && !apiRetrySeen) {
      runnerLogger().warn(
        { event: "session.timeout_unclassified", project: cwd, ...errCtx, turns, killReason },
        "max session timed out with no quota-classification signal — possible unseen quota exhaustion",
      );
    }
    return {
      ok: false,
      error,
      classificationText: error,
      hadApiRetry: apiRetrySeen,
      backend,
      model,
    };
  }

  if (exitCode !== 0) {
    emitAttribution("error", { durationMs, turns, exitCode, apiErrorStatus });
    // exitCode + stderr are both transport/provider-sourced (CLI diagnostics, never
    // model stdout) — safe to reuse verbatim as the classification text. The result
    // event (if one arrived before the process exited) is parsed ahead of this check —
    // see `apiErrorStatus`'s doc comment above — so append it here too, transport-sourced
    // same as the rest of this string.
    const error = `Session exited with code ${exitCode}${stderrTrimmed ? `. stderr: ${stderrTrimmed}` : ""}`;
    const classificationText = appendApiErrorStatus(error, apiErrorStatus);
    return {
      ok: false,
      error,
      classificationText,
      apiErrorStatus,
      hadApiRetry: apiRetrySeen,
      backend,
      model,
    };
  }

  if (!envelope) {
    runnerLogger().error(
      { event: "session.error", project: cwd, ...errCtx },
      "no result event in stream",
    );
    emitAttribution("error", { durationMs, turns, reason: "no_envelope" });
    const error = "Session ended without a result event";
    return {
      ok: false,
      error,
      classificationText: error,
      hadApiRetry: apiRetrySeen,
      backend,
      model,
    };
  }

  runnerLogger().debug(
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

  // What this attempt actually cost — spread into every attribution record below that has
  // an `envelope` (success or failure alike; a call that errored after producing output
  // still spent money). `JSON.stringify` in `writeAttribution` drops `undefined` keys on
  // its own, so a field the envelope/backend genuinely doesn't expose (e.g. no
  // `output_tokens_details` on some models) is omitted rather than written as a false zero.
  const costFields = {
    costUsd: envelope.total_cost_usd,
    inputTokens: envelope.usage?.input_tokens,
    outputTokens: envelope.usage?.output_tokens,
    cacheReadTokens: envelope.usage?.cache_read_input_tokens,
    thinkingTokens: envelope.usage?.output_tokens_details?.thinking_tokens,
  };

  if (envelope.is_error) {
    // See `classifyErrorEnvelope`'s doc comment for the full reasoning: `errors` always
    // classifies safely; `result` only classifies in the zero-turn carve-out (the model
    // never ran, so it cannot be the source of that text) — otherwise it is used for the
    // human-readable `error` only, never `classificationText`.
    // Max of both counters, not the envelope's alone: the zero-turn carve-out below hands
    // `result` to the classifier, so it must only fire when BOTH the CLI's own count and
    // the turns we observed on the stream agree that the model never spoke.
    const turnsObserved = Math.max(envelope.num_turns ?? 0, turns);
    const { errMsg, classificationText: classifiedText } = classifyErrorEnvelope(
      envelope,
      turnsObserved,
    );
    // See `apiErrorStatus`'s doc comment above: a gateway refusal (bad model id,
    // cost-ceiling denial) lands here as `is_error: true` with exactly one turn — the
    // turn is Claude Code's own error rendering, not model output — so append the
    // envelope's own `api_error_status` to the classification text (transport-sourced,
    // same standing as the rest of `classifyErrorEnvelope`'s output).
    const classificationText = appendApiErrorStatus(classifiedText, apiErrorStatus);
    runnerLogger().error(
      {
        event: "session.error",
        project: cwd,
        ...errCtx,
        subtype: envelope.subtype,
        error: errMsg,
        apiErrorStatus,
      },
      "session is_error",
    );
    emitAttribution("error", { durationMs, turns: turnsObserved, apiErrorStatus, ...costFields });
    return {
      ok: false,
      error: errMsg,
      classificationText,
      apiErrorStatus,
      hadApiRetry: apiRetrySeen,
      backend,
      model,
    };
  }

  // total_cost_usd is populated normally on both the IU native Anthropic transport
  // and the Max/OAuth path.
  const logSessionEnd = () =>
    runnerLogger().info(
      {
        event: "session.end",
        project: cwd,
        model,
        backend,
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
        runnerLogger().error(
          { event: "session.invalid_output", project: cwd, ...errCtx, error: v.error },
          "session output failed validation",
        );
        emitAttribution("error", { durationMs, turns: envelope.num_turns ?? turns, ...costFields });
        // Carry the worker's output through as `rawText`, exactly as the unparseable
        // branches below do. A schema-validation failure means the session DID produce
        // something — it just did not fit the declared shape — so a handler salvaging a
        // long run has real material to preserve. Returning a bare error here was silently
        // discarding it on what is, for a strict schema, the LIKELIEST failure path.
        const asText = typeof value === "string" ? value : safeStringify(value);
        // No `classificationText`: the session completed at the API level (this is a
        // shape mismatch against the declared schema, not a transport failure), so
        // there is no provider-sourced text to classify and it must never quota-match.
        // See `unclassifiedOutputFailure` for why `hadApiRetry` still propagates.
        return unclassifiedOutputFailure(v.error, asText, apiRetrySeen, backend, model);
      }
      logSessionEnd();
      emitAttribution("ok", { durationMs, turns: envelope.num_turns ?? turns, ...costFields });
      return { ok: true, data: v.value, backend, model };
    }
    logSessionEnd();
    emitAttribution("ok", { durationMs, turns: envelope.num_turns ?? turns, ...costFields });
    return { ok: true, data: value, backend, model };
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
    runnerLogger().error({ raw: raw.slice(0, 500), ...errCtx }, "result JSON parse failed");
    emitAttribution("error", {
      durationMs,
      turns: envelope.num_turns ?? turns,
      reason: "json_parse",
      ...costFields,
    });
    // No `classificationText`: `raw` is the model's own stdout (a check report, a
    // diff, …) — it can legitimately contain "429" or "quota" with no real quota
    // exhaustion behind it, and must never feed the classifier. See
    // `unclassifiedOutputFailure` for why `hadApiRetry` still propagates.
    return unclassifiedOutputFailure(
      `result field is not valid JSON: ${raw.slice(0, 500)}`,
      raw,
      apiRetrySeen,
      backend,
      model,
    );
  }

  // Fallback: the `result` field is routinely empty for sessions that end on a
  // tool call. Recover the JSON from the last assistant text message seen in the
  // stream before declaring failure — this is the single most common false
  // "no output" failure.
  if (lastAssistantText) {
    const recovered = extractJson<T>(lastAssistantText);
    if (recovered !== undefined) {
      runnerLogger().warn(
        { event: "session.recovered_output", project: cwd, ...errCtx },
        "recovered output from last assistant text (empty result field)",
      );
      return finalize(recovered);
    }
  }

  runnerLogger().error(
    { event: "session.error", project: cwd, ...errCtx },
    "session no usable output",
  );
  emitAttribution("error", {
    durationMs,
    turns: envelope.num_turns ?? turns,
    reason: "no_output",
    ...costFields,
  });
  // The error text here is fixed/constructed, never the model's own stdout (that lives
  // separately in `rawText`) — safe to reuse as classification text.
  const noOutputError = "Session produced no output (empty structured_output and result)";
  return {
    ok: false,
    error: noOutputError,
    classificationText: noOutputError,
    hadApiRetry: apiRetrySeen,
    noOutput: true,
    rawText: lastAssistantText || undefined,
    backend,
    model,
  };
}

/** Run a worker session, retrying a bounded number of times on a transient
 *  transport failure. A retry only happens when both hold: `isRetryableSessionError`
 *  matches the failure, and the worker never produced an assistant turn (so it
 *  cannot have started writing files) — anything past that point is re-run at the
 *  caller's own risk, not this one's.
 *
 *  Two narrower, once-only lane switches sit ahead of that retry, both gated on the
 *  route's declared `fallback` (and the global `SIDECLAW_WORKER_FALLBACK=none` off
 *  switch) and both latched by `usedFallback` so a failure on the fallback attempt
 *  itself is never switched again:
 *
 *  - `max` → `iu`: an attempt that ran on `max`, produced no output yet, and looks like
 *    quota/rate-limit exhaustion — either `hadApiRetry` (the CLI itself retried after a
 *    provider-side 429/529) or `isQuotaError` matching `classificationText` (stderr and
 *    the runner's own constructed error text, never model stdout) — forces the next
 *    attempt onto `iu`, same model. Takes precedence over the transient retry (the same
 *    failure would otherwise also match a bare "429" in `isRetryableSessionError`).
 *  - `iu` → `max`: an attempt that ran on `iu` and failed with a transport error
 *    before producing output is first retried once on `iu` (a single 503 is the common
 *    case and should not spend Max quota); if THAT fails the same way, the next attempt
 *    runs on `max` — on `fallback.model` when the route names one (check/overview:
 *    glm-5.3-flash cannot run on Max, so Haiku does), else the same model. Missing IU
 *    credentials (`iuConfigError`) skip the same-backend retry: nothing to retry. This
 *    is what keeps "IU down, Max fine" from being a dead lane. */
// ── Retry / fallback decision (pure) ──────────────────────────────────────────

/** What `planNextAttempt` needs from a finished attempt — the subset of `SessionResult`
 *  the decision reads, so tests can build one without a session. */
export interface AttemptOutcome {
  ok: boolean;
  error?: string;
  backend?: Backend;
  iuConfigError?: boolean;
  /** See `SessionResult.classificationText` — transport/provider-sourced text only,
   *  never model stdout. Feeds the quota-classification check below. */
  classificationText?: string;
  /** See `SessionResult.hadApiRetry` — the structured `api_retry` signal, checked
   *  ahead of `classificationText`. */
  hadApiRetry?: boolean;
  /** See `SessionResult.apiErrorStatus` — a gateway/API refusal, checked instead of
   *  `noOutputYet` since this failure shape produces one synthetic "turn". */
  apiErrorStatus?: number;
}

export interface NextAttemptInput {
  result: AttemptOutcome;
  /** 1-based index of the attempt that just finished. */
  attempt: number;
  /** The worker produced no assistant turn — the only state a retry may re-run. */
  noOutputYet: boolean;
  /** `SessionOptions.retryAfterOutput`: a timeout may switch lanes even after output,
   *  because this worker has no side effects to half-finish. Off for every other lane. */
  retryAfterOutput?: boolean;
  /** A lane switch already happened in this session — never a second one. */
  usedFallback: boolean;
  /** The route's fallback after the global `SIDECLAW_WORKER_FALLBACK=none` gate. */
  fallback: RouteFallback | null;
  /** The route's (override-applied) primary model — the same-model fallback runs it. */
  routeModel: string;
}

export type NextAttemptPlan =
  | { kind: "return" }
  | { kind: "retry" }
  | { kind: "fallback"; forced: ForcedAttempt };

/** Pure: given a finished attempt, decide whether to return it, retry the same backend,
 *  or switch lanes once. Rules, in order (see `runSession`'s doc comment for the why):
 *  1. `max` + iu fallback + quota-flavoured failure → fallback to `iu`, same model.
 *  2. `iu` + max fallback + "IU never answered" → fallback to `max` on `fallback.model`
 *     (or the same model). Immediately for missing credentials, a timeout with zero
 *     events (any timeout when `retryAfterOutput` is set), or a gateway/API refusal
 *     (`apiErrorStatus`, e.g. an unrecognized model id or a cost-ceiling denial — see
 *     `gatewayRefused` below); after one same-backend retry for an ordinary transport
 *     error.
 *  3. Transient transport error → retry the same backend (bounded by MAX_SESSION_ATTEMPTS).
 *  4. Otherwise return. A fallback attempt that fails is never switched again. */
export function planNextAttempt(input: NextAttemptInput): NextAttemptPlan {
  const { result, attempt, noOutputYet, usedFallback, fallback, routeModel } = input;
  const retryAfterOutput = input.retryAfterOutput === true;
  const isLastAttempt = attempt >= MAX_SESSION_ATTEMPTS;
  const error = result.error ?? "";
  // A timeout with ZERO worker events is "IU never answered", not "the worker was slow":
  // measured 2026-09-07, glm-5.3-flash produced nothing in 480 s on overview's 10 KB
  // prompt while answering a one-line prompt in 11 s. The same day it also stalled AFTER
  // two assistant turns until the cap — so a side-effect-free worker (`retryAfterOutput`)
  // treats any timeout as stuck. Same-backend retry is pointless either way (it doubles
  // the wasted wait), so a stuck timeout goes straight to the fallback lane like a missing
  // IU credential does. The quota and transport lanes below keep the no-output guard.
  const timedOutStuck = (noOutputYet || retryAfterOutput) && error.startsWith("Session timed out");
  // Measured 2026-09-10 (job c4f0f631, `--model glm-x` reproduced by hand): a gateway
  // refusal (bad model id, cost-ceiling denial) does NOT produce zero turns — Claude
  // Code emits one synthetic assistant "turn" that is its OWN error rendering ("There's
  // an issue with the selected model…"), then a `result` event carrying
  // `api_error_status` (404 for the reproduced case, 403 for the 2026-09-10 12:23Z cost
  // denial), then exits 1. `noOutputYet` (turns === 0) never catches this shape, so
  // `apiErrorStatus` is the direct signal instead. Deliberately a CLOSED set, not `>= 400`:
  // 429 and 5xx are the existing retry ladder's territory (rate limits, transient gateway
  // overload — genuinely worth a same-backend retry, or the quota lane above), so folding
  // them in here would skip that retry on a status this codebase already knows how to
  // recover from. Only statuses that mean "this exact request will never succeed" —
  // bad/missing auth, an unknown model id, access denied — belong in this set.
  const gatewayRefused =
    typeof result.apiErrorStatus === "number" &&
    GATEWAY_REFUSED_STATUSES.has(result.apiErrorStatus);
  const switchable =
    !result.ok &&
    !usedFallback &&
    !isLastAttempt &&
    (noOutputYet || timedOutStuck || gatewayRefused);
  // The structured `api_retry` signal wins outright when present; otherwise fall back to
  // the regex over TRANSPORT-sourced text only (`classificationText`, never the full
  // `error`, which can embed the model's own stdout) — see `isQuotaError`'s doc comment.
  const quotaFlavored =
    result.hadApiRetry === true || isQuotaError(result.classificationText ?? "");

  if (switchable && result.backend === "max" && fallback?.backend === "iu" && quotaFlavored) {
    return {
      kind: "fallback",
      forced: { backend: "iu", model: routeModel, reason: "rate-limited" },
    };
  }

  const noCredentials = result.iuConfigError === true;
  // "IU never answered" — either the structured `apiErrorStatus` signal above (the
  // gateway/API itself refused the request; wins outright, no `noOutputYet` gate needed
  // since a real model turn cannot produce that field), or a gateway-level refusal
  // matched by text that only means something on a failure with zero output (see
  // `IU_NEVER_ANSWERED_RE`'s comment for why the two Claude Code CLI warning lines that
  // used to also live in that regex were dropped rather than merely gated here: they
  // print on every IU run, success or ordinary zero-output transport failure alike, and
  // the false-positive cost of skipping the transport retry on a plain 502 was real).
  // Confirmed 2026-09-10: a fast IU exit-1 on a 403 cost-denial hits neither
  // `noCredentials` nor `timedOutStuck` nor `isRetryableSessionError` (403 is not in
  // the retryable status set), so without this it fell through to "return failed"
  // at attempt 1 instead of falling back to `max`.
  const neverAnswered =
    gatewayRefused ||
    (noOutputYet && isIuNeverAnswered(result.classificationText ?? result.error ?? ""));
  const iuDown = noCredentials || timedOutStuck || isRetryableSessionError(error) || neverAnswered;
  if (
    switchable &&
    result.backend === "iu" &&
    fallback?.backend === "max" &&
    iuDown &&
    (noCredentials || timedOutStuck || neverAnswered || attempt >= 2)
  ) {
    return {
      kind: "fallback",
      forced: { backend: "max", model: fallback.model ?? routeModel, reason: "iu-unavailable" },
    };
  }

  const canRetry =
    !result.ok && !isLastAttempt && noOutputYet && !noCredentials && isRetryableSessionError(error);
  return { kind: canRetry ? "retry" : "return" };
}

/** Generic call signature for `runSessionAttempt` — a plain `let` binding can't otherwise hold
 *  a generic function's type without losing the generic. */
interface AttemptRunner {
  <T>(
    opts: SessionOptions<T>,
    turnsRef: { current: number },
    forced?: ForcedAttempt,
  ): Promise<SessionResult<T>>;
}

/** What `runSession`'s loop actually calls to launch one attempt — production always the real
 *  `runSessionAttempt` (which spawns a real `claude -p`). Test-only indirection so the loop's
 *  OWN timing (retry backoff, the cancel checks below) can be exercised with a fake attempt that
 *  returns canned results instantly, instead of needing a real subprocess. */
let attemptRunner: AttemptRunner = runSessionAttempt;

export function __setAttemptRunnerForTests(fn: AttemptRunner): void {
  attemptRunner = fn;
}

export function __resetAttemptRunnerForTests(): void {
  attemptRunner = runSessionAttempt;
}

export async function runSession<T = unknown>(opts: SessionOptions<T>): Promise<SessionResult<T>> {
  const route = withModel(opts.route, opts.model);
  const fallback = WORKER_FALLBACK === "none" ? null : route.fallback;
  let attempt = 0;
  let usedFallback = false;
  let forced: ForcedAttempt | undefined;
  while (true) {
    attempt++;
    // Checked at the TOP of every iteration — the first attempt and every retry/fallback
    // alike — not only after a failure below. The gap this closes: a cancel (`POST
    // /api/jobs/:id/cancel` → `terminateSessionsForJob`) arriving AFTER attempt N's failed
    // result was already checked (or during the retry backoff sleep at the bottom of this
    // loop) has no live subprocess to SIGTERM — the previous one already exited and left
    // `activeProcs`, the next one doesn't exist yet — so only a check right before the next
    // spawn can catch it. Without this, that attempt launches and can succeed, silently
    // overriding the cancel.
    if (opts.jobId !== undefined && opts.isCancelled?.(opts.jobId)) {
      throw new SessionCancelledError(opts.jobId);
    }
    const turnsRef = { current: 0 };
    const result = await attemptRunner(opts, turnsRef, forced);
    // One route key per attempt, primary or forced fallback alike — each backend/model
    // combination a job actually ran on gets its own streak, so a healthy `max` fallback
    // never gets buried under a struggling `iu` primary's count.
    recordRouteOutcome(
      opts.tool ?? "unknown",
      result.backend ?? "unknown",
      result.model ?? "unknown",
      result.ok,
    );
    // A cancel requested mid-attempt is what most likely made THIS attempt fail — checked
    // again immediately so a cancelled run never even computes `planNextAttempt` (and
    // possibly sleeps for a backoff) before aborting. A race where the attempt actually
    // succeeded anyway (`result.ok`) is deliberately NOT short-circuited here: `store.ts`'s
    // `execute()` lets `done` stand in that case, so this only fires for a failure.
    if (!result.ok && opts.jobId !== undefined && opts.isCancelled?.(opts.jobId)) {
      throw new SessionCancelledError(opts.jobId);
    }
    const plan = planNextAttempt({
      result,
      attempt,
      noOutputYet: turnsRef.current === 0,
      retryAfterOutput: opts.retryAfterOutput,
      usedFallback,
      fallback,
      routeModel: route.model,
    });
    if (plan.kind === "fallback") {
      usedFallback = true;
      forced = plan.forced;
      continue;
    }
    if (plan.kind === "return") {
      return { ...result, attempts: attempt, retried: attempt > 1 };
    }
    runnerLogger().warn(
      {
        event: "session.retry",
        project: opts.cwd,
        tool: opts.tool,
        model: route.model,
        jobId: opts.jobId,
        attempt,
        error: result.error,
      },
      "session failed with a transient transport error before producing output — retrying",
    );
    await Bun.sleep(retryBackoffMs(attempt));
  }
}
