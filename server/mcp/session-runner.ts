import { appendFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { z } from "zod";
import { logger } from "./logger.ts";
import { getIuConfig } from "../lib/iu-openai.ts";
import { readMaxQuota, type MaxQuota } from "../lib/quota.ts";
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

/** Global kill switch for BOTH fallback directions (`max`→`iu` on quota, `iu`→`max`
 *  on an IU transport failure): "iu" (default) keeps them on, "none" pins every
 *  session to its route's primary backend. Read once at module load — a flip needs
 *  `make reload`. */
const WORKER_FALLBACK: "iu" | "none" =
  process.env.SIDECLAW_WORKER_FALLBACK === "none" ? "none" : "iu";

/** Five-hour-window utilization percent (0-100) at or above which a `max`
 *  session falls back to `iu`. */
const MAX_QUOTA_CEILING = Number(process.env.SIDECLAW_MAX_QUOTA_CEILING ?? 90);
/** Seven-day-window utilization percent (0-100) at or above which a `max`
 *  session falls back to `iu`. */
const MAX_WEEKLY_CEILING = Number(process.env.SIDECLAW_MAX_WEEKLY_CEILING ?? 95);

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

/** Input to `chooseBackend` — everything the pure decision needs, with no I/O of
 *  its own so it is trivially unit-testable. `configured` and `quota` are passed
 *  in rather than read from module state/network, for the same reason. */
export interface ChooseBackendInput {
  configured: Backend;
  model: string;
  quota: MaxQuota;
  ceilingFiveHour: number;
  ceilingSevenDay: number;
  fallback: "iu" | "none";
}

export interface ChooseBackendResult {
  backend: Backend;
  reason: "non-claude-model" | "fallback-disabled" | "quota-unknown" | "quota" | "ok";
}

/** Pure backend decision — no network, no clock beyond what `quota` already
 *  carries. Rules, in order:
 *
 *  1. A non-Claude model id always goes to `iu` — `max` only ever serves
 *     Anthropic's own models, so a gateway id there is rejected outright. This
 *     subsumes the old sync `resolveBackend`'s only rule.
 *  2. `fallback === "none"` disables the dynamic check — stay on `configured`.
 *  3. Unknown quota (`quota.source === "unknown"`, i.e. neither the statusline
 *     cache nor the live API produced a fresh reading) never blocks — stay on
 *     `configured` rather than guess.
 *  4. Either window at or above its ceiling (`>=`, so the ceiling itself
 *     already trips it) falls back to `iu`.
 *  5. Otherwise stay on `configured` — healthy quota is not a reason to move
 *     an `iu`-configured install onto `max`, only to keep a `max`-configured
 *     one there. */
export function chooseBackend(input: ChooseBackendInput): ChooseBackendResult {
  const { configured, model, quota, ceilingFiveHour, ceilingSevenDay, fallback } = input;
  if (!model.startsWith("claude")) return { backend: "iu", reason: "non-claude-model" };
  if (fallback === "none") return { backend: configured, reason: "fallback-disabled" };
  if (quota.source === "unknown") return { backend: configured, reason: "quota-unknown" };
  const fiveHourExceeded = quota.fiveHourPct !== null && quota.fiveHourPct >= ceilingFiveHour;
  const sevenDayExceeded = quota.sevenDayPct !== null && quota.sevenDayPct >= ceilingSevenDay;
  if (fiveHourExceeded || sevenDayExceeded) return { backend: "iu", reason: "quota" };
  return { backend: configured, reason: "ok" };
}

/** Effective backend for a route, resolved once per session launch.
 *
 *  Reads live Max quota (network + Keychain) ONLY when it could actually change
 *  the answer: the route's primary is `max`, its model is a claude-* id and it
 *  declares an `iu` fallback — every other case is decided by `chooseBackend`'s
 *  cheap, I/O-free rules 1/2 and short-circuits before touching `readMaxQuota()`.
 *  This is what keeps an `iu`-routed tool (check, overview, narrative) from paying
 *  a quota lookup on every session. */
export async function resolveBackend(
  route: ToolRoute,
): Promise<ChooseBackendResult & { quota?: MaxQuota }> {
  const { model, backend, fallback } = route;
  if (!isClaudeModel(model)) return { backend: "iu", reason: "non-claude-model" };
  if (backend !== "max") return { backend, reason: "ok" };
  const fallbackMode: "iu" | "none" =
    WORKER_FALLBACK === "none" || fallback?.backend !== "iu" ? "none" : "iu";
  if (fallbackMode === "none") return { backend: "max", reason: "fallback-disabled" };

  const quota = await readMaxQuota();
  const choice = chooseBackend({
    configured: "max",
    model,
    quota,
    ceilingFiveHour: MAX_QUOTA_CEILING,
    ceilingSevenDay: MAX_WEEKLY_CEILING,
    fallback: fallbackMode,
  });
  return { ...choice, quota };
}

// The IU gateway re-wraps a rate-limit/overload the same way it wraps a client
// error (see WRAPPED_TERMINAL_RE below), and Max's own OAuth path 429s with
// "usage limit"/"rate limit" language rather than a bare status code. Matched
// case-insensitively over whatever text a failed attempt produced (stderr +
// stdout + the constructed error message all funnel into `SessionResult.error`).
// Deliberately broad — a false positive costs one extra retry on `iu`, which is
// cheap; a false negative means a real quota exhaustion never falls back.
const QUOTA_ERROR_RE = /hit your (usage )?limit|usage limit|rate.?limit|429|overloaded|quota/i;

/** Does this failed-attempt text look like Max quota/rate-limit exhaustion
 *  rather than a generic transport or logic failure? Pure — feeds the reactive
 *  once-only `max` → `iu` retry in `runSession`, never the transient-transport
 *  retry (`isRetryableSessionError`), which stays backend-agnostic. */
export function isQuotaError(text: string): boolean {
  return QUOTA_ERROR_RE.test(text);
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

/** Backoff delay (ms) before the retry following a failed attempt N (1-indexed).
 *  1s, then 3s — the same exponential cadence iuFetch uses for transient IU errors. */
export function retryBackoffMs(attempt: number): number {
  return 1000 * 3 ** (attempt - 1);
}

// ── Runner ─────────────────────────────────────────────────────────────────────

/** Worker subprocesses alive in THIS process. The HTTP server's SIGTERM handler
 *  (`server/index.ts`) reads the count to decide how long to wait, then terminates
 *  what is left so a `make reload` never orphans a `claude -p` that keeps editing a
 *  worktree the boot sweep is about to delete. */
const activeProcs = new Set<ReturnType<typeof Bun.spawn>>();

export function activeSessionCount(): number {
  return activeProcs.size;
}

export function terminateActiveSessions(): number {
  let n = 0;
  for (const proc of activeProcs) {
    if (proc.exitCode === null) {
      proc.kill("SIGTERM");
      n++;
    }
  }
  return n;
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
    validate,
    onActivity,
  } = opts;
  const route = withModel(opts.route, opts.model);
  const model = forced?.model ?? route.model;

  const sessionUuid = randomUUID();
  const tsStart = new Date().toISOString();
  // Resolved before emitAttribution so nothing below depends on declaration order.
  // `chooseBackend`'s full rule set (model id, fallback flag, quota ceilings) —
  // see the module-level comment on `resolveBackend`/`chooseBackend` above. A
  // forced retry skips it outright: the caller already decided.
  const resolved: ChooseBackendResult & { quota?: MaxQuota } = forced
    ? { backend: forced.backend, reason: "quota" }
    : await resolveBackend(route);
  const backend: Backend = resolved.backend;
  if (forced) {
    logger.warn(
      { event: "backend.fallback", tool, model, backend, reason: forced.reason },
      forced.reason === "rate-limited"
        ? "falling back to iu after a max-quota-flavored failure"
        : "falling back to max — IU produced no output (transport failure, no credentials, or a silent timeout)",
    );
  } else {
    logger.info(
      {
        event: "backend.select",
        tool,
        model,
        backend,
        reason: resolved.reason,
        ...(resolved.reason === "quota" && resolved.quota
          ? { fiveHourPct: resolved.quota.fiveHourPct, sevenDayPct: resolved.quota.sevenDayPct }
          : {}),
      },
      "backend selected",
    );
  }

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
      return { ok: false, error: message, backend, model, iuConfigError: true };
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

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  delete env.CLAUDE_SESSION_ID;
  delete env.CLAUDE_PARENT_SESSION_ID;
  env.CLAUDE_ENTRYPOINT = "worker";
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
  activeProcs.add(proc);
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
  // Most recent non-empty assistant text. Workers sometimes end a session on a
  // tool call, leaving the `result` envelope field empty even though it already
  // emitted its JSON in an earlier text turn. We keep that text so the
  // output-extraction fallback can recover it instead of failing the whole job.
  let lastAssistantText = "";
  // Worker's real transcript session id (from the stream's system/init event, not
  // sideclaw's own `sessionUuid`). Used to tag the session_env sidecar so
  // usage-tracker joins it to the right transcript.
  let workerSessionId: string | undefined;
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

  // A failed worker's stderr is the post-mortem — at debug it was invisible in the
  // default log pass and every "why did check die at 03:00" ended in a shrug.
  if (stderrTrimmed) {
    const failed = timedOut || exitCode !== 0 || !envelope || envelope.is_error === true;
    const fields = {
      event: "session.stderr",
      tool,
      project: cwd,
      model,
      backend,
      exitCode,
      stderr: stderrTrimmed.slice(0, failed ? 4000 : 1000),
    };
    if (failed) logger.warn(fields, "session stderr (failed worker)");
    else logger.debug(fields, "session stderr");
  }

  logger.debug({ exitCode, timedOut, turns, lastAction }, "session stream done");

  const durationMs = Math.round(performance.now() - startMs);

  if (timedOut) {
    emitAttribution("timeout", { durationMs, turns });
    return { ok: false, error: `Session timed out after ${timeoutMs}ms`, backend, model };
  }

  if (exitCode !== 0) {
    emitAttribution("error", { durationMs, turns, exitCode });
    return {
      ok: false,
      error: `Session exited with code ${exitCode}${stderrTrimmed ? `. stderr: ${stderrTrimmed}` : ""}`,
      backend,
      model,
    };
  }

  if (!envelope) {
    logger.error({ event: "session.error", project: cwd }, "no result event in stream");
    emitAttribution("error", { durationMs, turns, reason: "no_envelope" });
    return { ok: false, error: "Session ended without a result event", backend, model };
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
    return { ok: false, error: errMsg, backend, model };
  }

  // total_cost_usd is populated normally on both the IU native Anthropic transport
  // and the Max/OAuth path.
  const logSessionEnd = () =>
    logger.info(
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
        return { ok: false, error: v.error, noOutput: true, rawText: asText, backend, model };
      }
      logSessionEnd();
      emitAttribution("ok", { durationMs, turns: envelope.num_turns ?? turns });
      return { ok: true, data: v.value, backend, model };
    }
    logSessionEnd();
    emitAttribution("ok", { durationMs, turns: envelope.num_turns ?? turns });
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
      backend,
      model,
    };
  }

  // Fallback: the `result` field is routinely empty for sessions that end on a
  // tool call. Recover the JSON from the last assistant text message seen in the
  // stream before declaring failure — this is the single most common false
  // "no output" failure.
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
 *  - `max` → `iu`: an attempt that ran on `max`, produced no output yet, and failed
 *    with text `isQuotaError` recognizes (Max quota/rate-limit exhaustion, not a
 *    generic transport blip) forces the next attempt onto `iu`, same model. Takes
 *    precedence over the transient retry (the same failure would otherwise also match
 *    a bare "429" in `isRetryableSessionError`).
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
 *     (or the same model). Immediately for missing credentials or a timeout with zero
 *     events (any timeout when `retryAfterOutput` is set); after one same-backend retry
 *     for an ordinary transport error.
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
  const switchable =
    !result.ok && !usedFallback && !isLastAttempt && (noOutputYet || timedOutStuck);

  if (switchable && result.backend === "max" && fallback?.backend === "iu" && isQuotaError(error)) {
    return {
      kind: "fallback",
      forced: { backend: "iu", model: routeModel, reason: "rate-limited" },
    };
  }

  const noCredentials = result.iuConfigError === true;
  const iuDown = noCredentials || timedOutStuck || isRetryableSessionError(error);
  if (
    switchable &&
    result.backend === "iu" &&
    fallback?.backend === "max" &&
    iuDown &&
    (noCredentials || timedOutStuck || attempt >= 2)
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

export async function runSession<T = unknown>(opts: SessionOptions<T>): Promise<SessionResult<T>> {
  const route = withModel(opts.route, opts.model);
  const fallback = WORKER_FALLBACK === "none" ? null : route.fallback;
  let attempt = 0;
  let usedFallback = false;
  let forced: ForcedAttempt | undefined;
  while (true) {
    attempt++;
    const turnsRef = { current: 0 };
    const result = await runSessionAttempt(opts, turnsRef, forced);
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
    logger.warn(
      { event: "session.retry", project: opts.cwd, attempt, error: result.error },
      "session failed with a transient transport error before producing output — retrying",
    );
    await Bun.sleep(retryBackoffMs(attempt));
  }
}
