// ── OpenCode harness — the second worker CLI ────────────────────────────────────────
//
// `dispatch`/`dispatch_implement` (AGENT_OC/AGENT_OC_IMPLEMENT, server/lib/routing.ts) run
// `opencode run` instead of `claude -p` — see routing.ts's module-header Harness paragraph
// for why. This module owns everything specific to that CLI: argv/config/env builders (pure,
// unit-tested directly), its NDJSON event shape (measured against real `opencode run --format
// json` output, 2026-09-24 — see tests/fixtures/opencode-events*.jsonl), the per-process
// lifecycle (`runOpencodeProcessLifecycle`) and one attempt runner (`runOpencodeAttempt`),
// invoked from `session-runner.ts`'s `runSessionAttempt` whenever `resolveHarness()` resolves
// to `"opencode"`. It returns the exact same `SessionResult<T>` shape the claude path does, so
// `runSession`'s retry/fallback loop (`planNextAttempt`), `POST /api/jobs/:id/cancel`
// (`terminateSessionsForJob`, via the shared `activeProcs` registration below), the idle
// watchdog, and `onActivity`/`onProgress`/`onSessionId` all keep working unmodified — this
// module is a second engine under the same chassis, not a parallel pipeline.
//
// Deliberately NOT `--pure` (measured 2026-09-24: hangs — see AGENTS.md's Worker routing
// section).
//
// ONLY supports `deepseek-v4.1-flash` (`DEEPSEEK_V41_FLASH`, routing.ts) — the rates, context
// limit and provider config below are that one model's, and `runOpencodeAttempt` refuses any
// other model outright rather than silently applying the wrong numbers to it.

import { randomUUID } from "node:crypto";
import type { Subprocess } from "bun";
import { getIuConfig } from "../lib/iu-openai.ts";
import { DEEPSEEK_V41_FLASH, type Backend } from "../lib/routing.ts";
import { IDLE_TIMEOUT_MS } from "../lib/idle-timeout.ts";
import {
  extractJson,
  isIdleTimedOut,
  runnerLogger,
  scrubSensitiveEnv,
  SessionCancelledError,
  trackExternalProc,
  unclassifiedOutputFailure,
  usageLane,
  writeAttribution,
  writeSessionEnv,
  type SessionOptions,
  type SessionProgress,
  type SessionResult,
} from "./session-runner.ts";

// ── Binary resolution ─────────────────────────────────────────────────────────
//
// `OPENCODE_BIN` env override first (matches every other externally-invoked binary's
// override convention in this codebase — e.g. `CLAUDE_BIN` in session-runner.ts reads
// `~/.local/bin/claude` before falling back to PATH); then `Bun.which`, which actually
// resolves PATH at call time rather than guessing a single hardcoded Homebrew prefix (the
// previous `existsSync("/opt/homebrew/...")` check silently returned bare `"opencode"` —
// relying on the CHILD process's PATH containing it — on any Intel Mac or Linux box); a
// literal `"opencode"` last so a spawn still gets a clear "command not found" rather than
// this module refusing to load when neither resolves.
const OPENCODE_BIN = process.env.OPENCODE_BIN ?? Bun.which("opencode") ?? "opencode";

// ── Named constants (no magic numbers) ──────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 15_000;
const IDLE_CHECK_INTERVAL_MS = 5_000;
const SIGKILL_GRACE_MS = 5_000;
const DB_LOCK_MAX_ATTEMPTS = 3;
/** Full jitter range for a db-lock retry's backoff — see `dbLockRetryDelayMs`. */
const DB_LOCK_RETRY_MIN_MS = 1_000;
const DB_LOCK_RETRY_JITTER_MS = 3_000;

/** `Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", env })` (no explicit `stdin`, which
 *  defaults to `"ignore"`) is what every spawn site in this file actually produces — this
 *  alias names that exact shape once instead of every caller re-deriving it, and is what
 *  `runOpencodeProcessLifecycle` accepts so a test can inject a fake object of the same shape
 *  without spawning a real process. */
export type OpencodeSubprocess = Subprocess<"ignore", "pipe", "pipe">;

// ── Pure builders ──────────────────────────────────────────────────────────────

export interface OpencodeArgsInput {
  bin: string;
  cwd: string;
  model: string;
  variant?: string;
  resumeSessionId?: string;
  prompt: string;
}

/** The full `opencode` argument vector, INCLUDING the binary as element 0. `-m iu/<model>`
 *  names the provider (`iu`, `buildOpencodeConfig` below) and the model id together —
 *  opencode has no bare `--model <id>` against a custom provider. The `--` before `prompt`
 *  is load-bearing, not decorative: measured 2026-09-24, a message starting with `-` (e.g. a
 *  brief that happens to begin "-foo bar") is parsed by opencode's own yargs CLI as an
 *  unknown FLAG without it — the command prints --help and exits 0 with no session ever
 *  starting, which this module would otherwise only see as an opaque "no output" failure. */
export function buildOpencodeArgs(input: OpencodeArgsInput): string[] {
  const { bin, cwd, model, variant, resumeSessionId, prompt } = input;
  return [
    bin,
    "run",
    "--dir",
    cwd,
    "-m",
    `iu/${model}`,
    ...(variant ? ["--variant", variant] : []),
    ...(resumeSessionId ? ["--session", resumeSessionId] : []),
    "--format",
    "json",
    "--",
    prompt,
  ];
}

export interface OpencodeConfigInput {
  model: string;
  readOnly: boolean;
}

/** Rates confirmed against the IU gateway for `deepseek-v4.1-flash`, 2026-09-24: $0.15/MTok
 *  input, $0.60/MTok output, ~$0.003/MTok cache read — see routing.ts's AGENT_OC comment.
 *  Model-specific and NOT exported: `runOpencodeAttempt` refuses to run any model other than
 *  `DEEPSEEK_V41_FLASH` on this harness (see its own guard), so these numbers are never
 *  applied to a different model's usage by construction — nothing outside this file needs
 *  them directly, only `computeOpencodeCostUsd`/`buildOpencodeConfig` below. */
const DEEPSEEK_V41_FLASH_RATE_INPUT_PER_MTOK = 0.15;
const DEEPSEEK_V41_FLASH_RATE_OUTPUT_PER_MTOK = 0.6;
const DEEPSEEK_V41_FLASH_RATE_CACHE_READ_PER_MTOK = 0.003;
/** Real context/output window for `deepseek-v4.1-flash` over the IU OpenAI-compatible
 *  route, 2026-09-24 — mirrors `GATEWAY_CONTEXT_TOKENS`'s per-model measurement convention in
 *  session-runner.ts, just declared to opencode's own config schema instead of consumed via
 *  `CLAUDE_CODE_MAX_CONTEXT_TOKENS` (a claude-harness-only env var). */
const DEEPSEEK_V41_FLASH_CONTEXT_LIMIT = 850_000;
const DEEPSEEK_V41_FLASH_OUTPUT_LIMIT = 65_536;

/** opencode's `--variant` values this route ever passes — AGENT_OC uses `"high"`,
 *  AGENT_OC_IMPLEMENT uses `"max"` (routing.ts); `"none"` is declared for completeness (a
 *  `SIDECLAW_VARIANT_<TOOL>` override could reasonably ask for it) but nothing defaults to
 *  it. `runOpencodeAttempt` refuses any variant outside this set before spawning — an
 *  undeclared variant name is silently accepted by opencode itself (falls back to the base
 *  `options`), which would otherwise mask a typo'd override as "ran, just not the effort
 *  level asked for" instead of a clear refusal. */
export const OPENCODE_DECLARED_VARIANTS = ["high", "max", "none"] as const;
export type OpencodeVariant = (typeof OPENCODE_DECLARED_VARIANTS)[number];

/** Every opencode permission key this config sets, verified against the live schema
 *  (`curl https://opencode.ai/config.json`, 2026-09-24 — `$defs.PermissionConfig`). Notably:
 *  there is no `write` key (file mutation is governed by `edit` alone — no tool is ever named
 *  `write` in a real event stream either, see tests/fixtures/opencode-events.jsonl) and no
 *  `todoread` key (only `todowrite`) — both appear in shorthand descriptions of this schema
 *  elsewhere, but the schema itself does not have them. Exported so the "no promptable key
 *  left unset" test iterates the same list `buildOpencodeConfig` populates from. */
export const OPENCODE_PERMISSION_KEYS = [
  "bash",
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "task",
  "skill",
  "lsp",
  "todowrite",
  "webfetch",
  "websearch",
  "question",
  "doom_loop",
  "external_directory",
] as const;

/** Per-run opencode config, passed via `OPENCODE_CONFIG_CONTENT` (see `buildOpencodeEnv`) —
 *  NEVER a file. `permission` is the opencode analogue of claude's `--disallowedTools`:
 *  measured 2026-09-24, the default `ask` permission is auto-REJECTED in `run`
 *  (non-interactive) mode and silently ends the session, so EVERY key in
 *  `OPENCODE_PERMISSION_KEYS` must be explicitly `allow` or `deny` — there is no "ask and it
 *  just works" in this mode, and an omitted key is exactly as broken as one it defaults to
 *  ask on. `readOnly` denies `edit` only (Bash — the `bash` key — stays allowed either way,
 *  same parity as claude's `readOnly`: Write/Edit/NotebookEdit disallowed, Bash available —
 *  see `SessionOptions.readOnly`'s doc comment).
 *
 *  `webfetch`/`websearch` are set `"allow"` here on explicit instruction (2026-09-24 review
 *  fix) despite AGENTS.md's Worker routing section stating "No WebSearch/WebFetch — workers
 *  shell out via Bash instead" for the claude harness — that rule was written before this
 *  harness existed and opencode has no Bash-only equivalent path to fetch a URL. Flagged
 *  rather than silently resolved either way: revisit if this widens the episode's exposure
 *  more than intended. */
export function buildOpencodeConfig(input: OpencodeConfigInput): Record<string, unknown> {
  const { model, readOnly } = input;
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    provider: {
      iu: {
        npm: "@ai-sdk/openai-compatible",
        name: "IU unified endpoint (OpenAI route)",
        options: {
          baseURL: "{env:IU_OPENAI_BASE}",
          apiKey: "{env:IU_KEY}",
        },
        models: {
          [model]: {
            name: "DeepSeek V4.1 Flash",
            limit: {
              context: DEEPSEEK_V41_FLASH_CONTEXT_LIMIT,
              output: DEEPSEEK_V41_FLASH_OUTPUT_LIMIT,
            },
            cost: {
              input: DEEPSEEK_V41_FLASH_RATE_INPUT_PER_MTOK,
              output: DEEPSEEK_V41_FLASH_RATE_OUTPUT_PER_MTOK,
              cache_read: DEEPSEEK_V41_FLASH_RATE_CACHE_READ_PER_MTOK,
            },
            options: { reasoningEffort: "high" },
            variants: {
              high: { reasoningEffort: "high" },
              max: { reasoningEffort: "max" },
              none: { reasoningEffort: "none" },
            },
          },
        },
      },
    },
    permission: {
      bash: "allow",
      read: "allow",
      edit: readOnly ? "deny" : "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      task: "allow",
      skill: "allow",
      lsp: "allow",
      todowrite: "allow",
      webfetch: "allow",
      websearch: "allow",
      question: "deny",
      doom_loop: "allow",
      external_directory: "deny",
    } satisfies Record<(typeof OPENCODE_PERMISSION_KEYS)[number], "allow" | "deny">,
  };
}

export interface OpencodeEnvInput {
  tool?: string;
  extraEnv?: Record<string, string>;
  iuKey: string;
  iuOpenaiBase: string;
  /** The full `OPENCODE_CONFIG_CONTENT` JSON string (`JSON.stringify(buildOpencodeConfig(...))`)
   *  — see the module header's precedence note: a repo-local `opencode.json`/`opencode.jsonc`
   *  OVERRIDES `OPENCODE_CONFIG` (a file path), but `OPENCODE_CONFIG_CONTENT` overrides the
   *  repo file. Passing the config this way, rather than writing it to a temp file and
   *  pointing `OPENCODE_CONFIG` at it, is a security requirement, not a style choice — see
   *  `buildOpencodeEnv`'s own doc comment. */
  opencodeConfigContent: string;
  /** Override for tests — defaults to `process.env`, same convention as `WorkerEnvInput`. */
  baseEnv?: Record<string, string | undefined>;
}

/** The worker's full spawn env — same credential scrub, `CLAUDE_*` session-var handling and
 *  `USAGE_LANE` tagging as `buildWorkerEnv` (session-runner.ts), via the shared
 *  `scrubSensitiveEnv`/`usageLane` exports, so usage-tracker's claude-code collector still
 *  finds a coherent env shape from either harness. `IU_KEY`/`IU_OPENAI_BASE` are what
 *  `buildOpencodeConfig`'s `{env:...}` placeholders resolve against — the API key never
 *  touches argv or disk, only this process-local env the child inherits.
 *
 *  `OPENCODE_CONFIG_CONTENT`, never `OPENCODE_CONFIG` (a file path) — measured live,
 *  2026-09-24: a repo-local `opencode.json`/`opencode.jsonc` in the worktree OVERRIDES an
 *  `OPENCODE_CONFIG` file path (a malicious repo config wins over the handler-supplied one
 *  written to a temp file — a real, exploitable precedence bug the original implementation
 *  had), but `OPENCODE_CONFIG_CONTENT` wins over the repo file every time. Passing the config
 *  as an env value rather than a file also removes the temp-file lifecycle entirely (no
 *  create/chmod/unlink, no window where a `0600` file sits on disk with the IU key baked into
 *  its `{env:...}` — wait, it never was baked in, but the file itself was still a leak
 *  surface for the config SHAPE). `extraEnv` applied last, same as `buildWorkerEnv`
 *  (dispatch's `GIT_DENY_CREDENTIALS_ENV` must win). */
export function buildOpencodeEnv(input: OpencodeEnvInput): Record<string, string> {
  const {
    tool,
    extraEnv,
    iuKey,
    iuOpenaiBase,
    opencodeConfigContent,
    baseEnv = process.env,
  } = input;

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v !== undefined) env[k] = v;
  }
  delete env.CLAUDE_SESSION_ID;
  delete env.CLAUDE_PARENT_SESSION_ID;
  env.CLAUDE_ENTRYPOINT = "worker";
  env.USAGE_LANE = usageLane(tool);
  scrubSensitiveEnv(env);
  env.IU_KEY = iuKey;
  env.IU_OPENAI_BASE = iuOpenaiBase;
  // An inherited OPENCODE_CONFIG (a file path) must not coexist with the content env var —
  // harmless given CONTENT wins, but a stale/irrelevant path left over from the parent
  // process's own env is not this worker's business to carry.
  delete env.OPENCODE_CONFIG;
  env.OPENCODE_CONFIG_CONTENT = opencodeConfigContent;
  if (extraEnv) Object.assign(env, extraEnv);
  return env;
}

/** Appended to the prompt when `SessionOptions.jsonSchema` is set — opencode has no
 *  `--json-schema` flag (unlike claude), so the schema has to be communicated in-band and the
 *  final assistant TEXT is what gets run through `extractJson` afterward, exactly like
 *  claude's own `result`-field-empty recovery path. */
export function appendJsonSchemaInstruction(
  prompt: string,
  jsonSchema: Record<string, unknown>,
): string {
  return (
    `${prompt}\n\n` +
    "────────────────────────────────────────────────────────\n" +
    "Your FINAL message must be ONLY a single JSON object — no prose before or after, no " +
    "markdown fence commentary, and never a tool call as the last message — matching exactly " +
    "this JSON Schema:\n\n" +
    `${JSON.stringify(jsonSchema, null, 2)}\n`
  );
}

/** Replace every occurrence of `secret` in `text` with a fixed placeholder. `secret` empty →
 *  no-op (never redact against an empty string, which would otherwise match everywhere).
 *  Used to strip the runtime IU key out of anything opencode's own event stream could echo
 *  back — a worker with Bash access can run `env`/`printenv` and the key is a env var in its
 *  process, so `lastAssistantText` (and anything derived from it: `rawText`, a salvaged
 *  `data`) is untrusted output until this runs. */
export function redactSecret(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("[REDACTED]");
}

// ── NDJSON event shape (measured 2026-09-24 against real `opencode run --format json`
// output — tests/fixtures/opencode-events.jsonl (a successful run) and
// tests/fixtures/opencode-events-error.jsonl (two real failing runs: a rejected apiKey, an
// unrecognized model id) are trimmed excerpts of the actual streams) ──

interface OpencodeToolState {
  status?: "completed" | "error" | string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
}

interface OpencodePart {
  type?: string; // "step-start" | "tool" | "text" | "step-finish"
  tool?: string;
  state?: OpencodeToolState;
  text?: string;
  reason?: string; // step-finish: "tool-calls" | "stop" | …
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  cost?: number;
}

/** The nested shape of a real `type: "error"` event's `error` field — measured 2026-09-24
 *  against two live failures (a rejected apiKey: `{name:"APIError", data:{message, statusCode:
 *  401, isRetryable:false, responseHeaders, responseBody, metadata}}`; an unrecognized model
 *  id: `{name:"UnknownError", data:{message, ref}}`). This is an OBJECT, not a bare string —
 *  an earlier draft of this module assumed a flat `error?: string` / top-level `message?:
 *  string`, which never matched anything real and would have left `errorMessage` always
 *  `undefined` on an actual failure. */
interface OpencodeErrorDetail {
  name?: string;
  data?: {
    message?: string;
    statusCode?: number;
    isRetryable?: boolean;
    [key: string]: unknown;
  };
}

interface OpencodeEvent {
  type?: "step_start" | "tool_use" | "text" | "step_finish" | "error";
  sessionID?: string;
  part?: OpencodePart;
  error?: OpencodeErrorDetail;
}

/** Best-effort NDJSON line parse — a malformed line is skipped, same as the claude path's own
 *  stream-json parser. Split out purely to keep the caller's loop one nesting level shallower. */
function parseOpencodeLine(trimmed: string): OpencodeEvent | undefined {
  try {
    return JSON.parse(trimmed) as OpencodeEvent;
  } catch {
    return undefined;
  }
}

/** Fires exactly once per attempt, the instant opencode's own transcript sessionID is first
 *  observed — mirrors claude path's `maybeWriteSessionEnv`/`onSessionId` pairing. Split out
 *  purely to keep the caller's loop one nesting level shallower. */
function announceOpencodeSessionId(
  sessionId: string,
  ctx: {
    iuOpenaiBase: string;
    model: string;
    backend: Backend;
    tool: string | undefined;
    onSessionId?: (sessionId: string) => void;
  },
): void {
  writeSessionEnv(sessionId, ctx.iuOpenaiBase, ctx.model, ctx.backend, ctx.tool, "opencode");
  try {
    ctx.onSessionId?.(sessionId);
  } catch {
    /* fire-and-forget, same contract as claude path */
  }
}

/** Compact human label for a tool_use part, mirroring `describeTool` in session-runner.ts —
 *  same shape of output ("bash: <cmd>", "edit <basename>"), different input shape
 *  (`part.tool`/`part.state.input` rather than claude's `name`/`input`). */
function describeOpencodeTool(part: OpencodePart): string {
  const tool = part.tool ?? "tool";
  const input = part.state?.input ?? {};
  if (tool === "bash" && typeof input.command === "string") {
    return `bash: ${input.command.slice(0, 50)}`;
  }
  const path = input.filePath ?? input.path;
  if (typeof path === "string") {
    return `${tool} ${path.split("/").pop()}`;
  }
  return tool;
}

export interface OpencodeAccum {
  turns: number;
  lastAction: string;
  lastAssistantText: string;
  sessionId?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  /** Whether the MOST RECENT `step_finish` seen so far had `part.reason === "stop"` — the
   *  final assistant turn, as opposed to a `"tool-calls"` step that continues the loop.
   *  Overwritten on every `step_finish` (not OR-accumulated), so this always reflects the
   *  LAST one by the time the stream ends. A session that ends on ANY other reason (or ends
   *  with zero `step_finish` events at all — the initial `false`) is treated as truncated:
   *  `runOpencodeAttempt` fails the attempt rather than trusting a partial `lastAssistantText`
   *  as if the model had actually finished. */
  finished: boolean;
  sawErrorEvent: boolean;
  errorMessage?: string;
}

export const INITIAL_OPENCODE_ACCUM: OpencodeAccum = {
  turns: 0,
  lastAction: "starting",
  lastAssistantText: "",
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  finished: false,
  sawErrorEvent: false,
};

/** Pure event-fold: one NDJSON line in, the next accumulator state out. No I/O, no callbacks
 *  — the imperative caller diffs `sessionId` before/after to fire `onSessionId` exactly once,
 *  same pattern as claude's own `maybeWriteSessionEnv`. */
export function reduceOpencodeEvent(state: OpencodeAccum, event: OpencodeEvent): OpencodeAccum {
  const next = { ...state };
  if (event.sessionID && !next.sessionId) next.sessionId = event.sessionID;
  const part = event.part;
  switch (event.type) {
    case "tool_use":
      if (part) next.lastAction = describeOpencodeTool(part);
      break;
    case "text":
      if (typeof part?.text === "string" && part.text.trim()) next.lastAssistantText = part.text;
      break;
    case "step_finish":
      next.turns += 1;
      if (part?.tokens) {
        next.inputTokens += part.tokens.input ?? 0;
        next.outputTokens += part.tokens.output ?? 0;
        next.reasoningTokens += part.tokens.reasoning ?? 0;
        next.cacheReadTokens += part.tokens.cache?.read ?? 0;
      }
      // Overwrite, not OR — see `OpencodeAccum.finished`'s doc comment: only the LAST
      // step_finish's reason should decide this.
      next.finished = part?.reason === "stop";
      break;
    case "error":
      next.sawErrorEvent = true;
      next.errorMessage = event.error?.data?.message ?? event.error?.name ?? next.errorMessage;
      break;
    default:
      break;
  }
  return next;
}

/** Reasoning tokens billed at the output rate, same convention as claude/Anthropic usage
 *  accounting elsewhere in this codebase (see iu-openai.ts's `normalizeUsage` doc comment). */
export function computeOpencodeCostUsd(
  accum: Pick<
    OpencodeAccum,
    "inputTokens" | "outputTokens" | "reasoningTokens" | "cacheReadTokens"
  >,
): number {
  const outputBilled = accum.outputTokens + accum.reasoningTokens;
  return (
    (accum.inputTokens / 1_000_000) * DEEPSEEK_V41_FLASH_RATE_INPUT_PER_MTOK +
    (outputBilled / 1_000_000) * DEEPSEEK_V41_FLASH_RATE_OUTPUT_PER_MTOK +
    (accum.cacheReadTokens / 1_000_000) * DEEPSEEK_V41_FLASH_RATE_CACHE_READ_PER_MTOK
  );
}

// ── Concurrency: the shared opencode.db can report itself locked under concurrent starts ──

const DB_LOCKED_RE = /database is locked/i;

/** A spawn attempt that exited non-zero, produced ZERO events, and whose stderr names the
 *  shared `~/.local/share/opencode/opencode.db` as locked — measured under concurrent
 *  dispatch episodes, 2026-09-24. Narrow on purpose: a non-zero exit that DID produce events
 *  is a real session failure, not a lock race, and must not be blindly retried (it could
 *  duplicate partial work). */
export function isDbLockedFailure(exitCode: number, eventCount: number, stderr: string): boolean {
  return exitCode !== 0 && eventCount === 0 && DB_LOCKED_RE.test(stderr);
}

/** Full jitter across `[DB_LOCK_RETRY_MIN_MS, DB_LOCK_RETRY_MIN_MS + DB_LOCK_RETRY_JITTER_MS)`
 *  — enough spread that a bounded set of concurrent dispatch episodes racing the same lock
 *  don't retry in lockstep. */
export function dbLockRetryDelayMs(): number {
  return DB_LOCK_RETRY_MIN_MS + Math.random() * DB_LOCK_RETRY_JITTER_MS;
}

// ── Per-process lifecycle ─────────────────────────────────────────────────────
//
// Extracted out of `runOpencodeAttempt` so this exact lifecycle — registration into the
// shared `activeProcs` map, the idle watchdog, the progress heartbeat, and (critically) the
// teardown guarantee — is unit-testable against a FAKE `proc` (a Bun.Subprocess-shaped
// object, same convention `tests/session-runner-cancel.test.ts`'s `fakeProc()` uses) without
// spawning a real `opencode` binary or waiting on real timers.

export interface OpencodeProcLifecycleCtx {
  jobId: string | undefined;
  cwd: string;
  model: string;
  backend: Backend;
  tool: string | undefined;
  iuOpenaiBase: string;
  onSessionId?: (sessionId: string) => void;
  onActivity?: (progress: SessionProgress) => void;
  onProgress?: (progress: number, total: number, message: string) => void;
  turnsRef: { current: number };
  /** Override for tests only — the real SIGKILL escalation grace period is
   *  `SIGKILL_GRACE_MS` (5s); a test asserting "a SIGTERM-ignoring child still gets
   *  SIGKILL" would otherwise have to burn 5 real seconds per run. */
  sigkillGraceMs?: number;
}

export interface OpencodeProcLifecycleResult {
  accum: OpencodeAccum;
  eventCount: number;
  exitCode: number;
  stderrTrimmed: string;
  killReason: "idle" | null;
  idleMsAtKill: number | null;
}

/** Runs ONE already-spawned opencode process to completion. Guarantees, regardless of how
 *  this function returns (including a `reader.read()` throw):
 *   - the process is registered into `activeProcs` (`trackExternalProc`) for the duration,
 *     and untracked the moment it actually exits (`void proc.exited.finally(untrack)` — the
 *     exact pattern `runSessionAttempt`'s own claude-path spawn uses), not merely when this
 *     function happens to reach its own cleanup code;
 *   - the idle watchdog and progress heartbeat intervals are always cleared;
 *   - the child is never left running: a `finally` around the read loop force-kills it
 *     (SIGTERM, escalating to SIGKILL after `SIGKILL_GRACE_MS` if it ignores the signal) if
 *     it hasn't already exited, whether that's because of an idle timeout OR because the read
 *     loop itself threw for some other reason;
 *   - the SIGKILL escalation timer is only cleared AFTER `proc.exited` resolves — clearing it
 *     earlier could race a kill that fires between the read loop's `finally` and the
 *     `exited` await, cancelling a legitimate pending SIGKILL before it had a chance to run. */
export async function runOpencodeProcessLifecycle(
  proc: OpencodeSubprocess,
  ctx: OpencodeProcLifecycleCtx,
): Promise<OpencodeProcLifecycleResult> {
  const errCtx = {
    tool: ctx.tool,
    model: ctx.model,
    backend: ctx.backend,
    harness: "opencode" as const,
    jobId: ctx.jobId,
  };
  const untrack = trackExternalProc(proc, ctx.jobId);
  void proc.exited.finally(untrack);

  let heartbeatTick = 0;
  const onProgress = ctx.onProgress;
  const heartbeatHandle = onProgress
    ? setInterval(() => {
        heartbeatTick++;
        onProgress(heartbeatTick, 0, `Session running (${heartbeatTick * 15}s elapsed)`);
      }, HEARTBEAT_INTERVAL_MS)
    : null;

  let accum: OpencodeAccum = INITIAL_OPENCODE_ACCUM;
  let eventCount = 0;
  let killReason: "idle" | null = null;
  let idleMsAtKill: number | null = null;
  let lastChunkAt: number | null = null;
  const spawnedAt = Date.now();
  let sigkillTimer: ReturnType<typeof setTimeout> | null = null;

  const forceKill = (): void => {
    if (proc.exitCode !== null) return;
    proc.kill("SIGTERM");
    sigkillTimer = setTimeout(() => {
      sigkillTimer = null;
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }, ctx.sigkillGraceMs ?? SIGKILL_GRACE_MS);
  };
  const kill = (reason: "idle"): void => {
    if (killReason) return;
    killReason = reason;
    idleMsAtKill = Date.now() - (lastChunkAt ?? spawnedAt);
    runnerLogger().error(
      { event: "session.timeout", project: ctx.cwd, ...errCtx, killReason, idleMsAtKill },
      "session timed out — SIGTERM (opencode)",
    );
    forceKill();
  };
  const idleWatchdog = setInterval(() => {
    if (isIdleTimedOut(Date.now(), lastChunkAt ?? spawnedAt)) kill("idle");
  }, IDLE_CHECK_INTERVAL_MS);

  const stderrPromise = new Response(proc.stderr).text();
  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  let buf = "";
  const emitActivity = () => {
    if (!ctx.onActivity) return;
    try {
      ctx.onActivity({
        turns: accum.turns,
        lastAction: accum.lastAction,
        lastActivityAt: Date.now(),
      });
    } catch {
      /* best-effort */
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lastChunkAt = Date.now();
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const ev = parseOpencodeLine(trimmed);
        if (!ev) continue;
        eventCount++;
        const prevSessionId = accum.sessionId;
        accum = reduceOpencodeEvent(accum, ev);
        if (!prevSessionId && accum.sessionId) {
          announceOpencodeSessionId(accum.sessionId, {
            iuOpenaiBase: ctx.iuOpenaiBase,
            model: ctx.model,
            backend: ctx.backend,
            tool: ctx.tool,
            onSessionId: ctx.onSessionId,
          });
        }
        ctx.turnsRef.current = accum.turns;
        emitActivity();
      }
    }
  } finally {
    reader.releaseLock();
    clearInterval(idleWatchdog);
    if (heartbeatHandle !== null) clearInterval(heartbeatHandle);
    // A reader.read() throw (or any other exception escaping the loop above) must not
    // orphan the child — same guarantee the idle watchdog's own kill() gives a wedged
    // worker, just triggered by a different failure shape. No-op if already exited.
    forceKill();
  }

  const stderrTrimmed = (await stderrPromise).trim();
  const exitCode = await proc.exited;
  // See this function's own doc comment for why this is cleared HERE, not earlier.
  if (sigkillTimer !== null) clearTimeout(sigkillTimer);

  return { accum, eventCount, exitCode, stderrTrimmed, killReason, idleMsAtKill };
}

// ── Attempt runner ─────────────────────────────────────────────────────────────

export interface OpencodeAttemptContext {
  model: string;
  backend: Backend;
  variant?: string;
}

/** One opencode session launch — the harness counterpart to `runSessionAttempt`'s claude
 *  path, called from there when `resolveHarness()` resolves `"opencode"`. Always the PRIMARY
 *  attempt: a forced (fallback) attempt is never opencode (`resolveHarness`'s doc comment),
 *  so `ctx.backend` here is always the route's own primary backend (`iu` for both AGENT_OC
 *  tiers) — there is no analogue of claude's `forced` parameter to thread through. */
export async function runOpencodeAttempt<T>(
  opts: SessionOptions<T>,
  turnsRef: { current: number },
  ctx: OpencodeAttemptContext,
): Promise<SessionResult<T>> {
  const {
    cwd,
    prompt,
    jsonSchema,
    readOnly = false,
    extraEnv,
    extraDisallowedTools,
    settingSources,
    mcpServers,
    tool,
    jobId,
    isCancelled,
    validate,
    onActivity,
    onProgress,
    resumeSessionId,
    onSessionId,
  } = opts;
  const { model, backend, variant } = ctx;

  // No caller passes this for a dispatch route — opencode's permission profile
  // (buildOpencodeConfig) has no per-tool-name allow/deny surface to extend, unlike claude's
  // `--disallowedTools`. A caller that starts doing so needs this module updated, not a
  // silently-ignored option.
  if (extraDisallowedTools && extraDisallowedTools.length > 0) {
    throw new Error(
      "runOpencodeAttempt: extraDisallowedTools is not supported on the opencode harness",
    );
  }
  // Both are claude-CLI-specific (`--setting-sources`, `--mcp-config`) and have no opencode
  // equivalent this module wires up — silently dropping them used to be invisible. dispatch
  // always passes `settingSources: "user,project"`, so this fires on every ordinary opencode
  // dispatch call; that is expected, not a bug to chase — it's just now visible at debug
  // level instead of nowhere.
  if (settingSources !== undefined) {
    runnerLogger().debug(
      { event: "session.opencode_ignored_option", option: "settingSources", value: settingSources },
      "settingSources has no effect on the opencode harness",
    );
  }
  if (mcpServers) {
    runnerLogger().debug(
      { event: "session.opencode_ignored_option", option: "mcpServers" },
      "mcpServers has no effect on the opencode harness",
    );
  }

  // Defense in depth, mirrored at the routing-table level (routing.ts's buildRoutingTable
  // cross-field validation) — this is the layer that actually matters, since it guards a
  // hand-built route (or a future routing.ts bug) too, not just a bad env override. The
  // rates/limits in buildOpencodeConfig are this ONE model's; applying them to a different
  // model's usage would silently misprice/miscap it.
  if (model !== DEEPSEEK_V41_FLASH) {
    throw new Error(
      `runOpencodeAttempt: the opencode harness only supports ${DEEPSEEK_V41_FLASH} — got "${model}"`,
    );
  }
  if (
    variant !== undefined &&
    !(OPENCODE_DECLARED_VARIANTS as readonly string[]).includes(variant)
  ) {
    throw new Error(
      `runOpencodeAttempt: unknown opencode variant "${variant}" — declared variants are ` +
        OPENCODE_DECLARED_VARIANTS.join(", "),
    );
  }

  const sessionUuid = randomUUID();
  const tsStart = new Date().toISOString();
  const errCtx = { tool, model, backend, harness: "opencode" as const, jobId };

  let iuKey: string;
  let iuOpenaiBase: string;
  try {
    const cfg = await getIuConfig();
    iuKey = cfg.key;
    iuOpenaiBase = cfg.openaiBase;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runnerLogger().error(
      { event: "session.iu_config_error", project: cwd, ...errCtx, error: message },
      "IU config unavailable (opencode)",
    );
    writeAttribution({
      sessionId: sessionUuid,
      tool: tool ?? "unknown",
      project: cwd,
      model,
      backend,
      harness: "opencode",
      tsStart,
      tsEnd: new Date().toISOString(),
      outcome: "error",
      reason: "iu_config_error",
    });
    return {
      ok: false,
      error: message,
      classificationText: message,
      backend,
      model,
      iuConfigError: true,
    };
  }

  const opencodeConfigContent = JSON.stringify(buildOpencodeConfig({ model, readOnly }));
  const env = buildOpencodeEnv({ tool, extraEnv, iuKey, iuOpenaiBase, opencodeConfigContent });

  const finalPrompt = jsonSchema ? appendJsonSchemaInstruction(prompt, jsonSchema) : prompt;
  const argv = buildOpencodeArgs({
    bin: OPENCODE_BIN,
    cwd,
    model,
    variant,
    resumeSessionId,
    prompt: finalPrompt,
  });

  runnerLogger().info(
    {
      event: "session.spawn",
      project: cwd,
      model,
      backend,
      harness: "opencode",
      readOnly,
      variant,
    },
    "session spawn (opencode)",
  );

  const startMs = performance.now();
  let accum: OpencodeAccum = INITIAL_OPENCODE_ACCUM;
  let eventCount = 0;
  let exitCode = 0;
  let stderrTrimmed = "";
  let killReason: "idle" | null = null;
  let idleMsAtKill: number | null = null;

  for (let dbAttempt = 1; dbAttempt <= DB_LOCK_MAX_ATTEMPTS; dbAttempt++) {
    if (jobId !== undefined && isCancelled?.(jobId)) {
      throw new SessionCancelledError(jobId);
    }
    const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", env });
    const streamResult = await runOpencodeProcessLifecycle(proc, {
      jobId,
      cwd,
      model,
      backend,
      tool,
      iuOpenaiBase,
      onSessionId,
      onActivity,
      onProgress,
      turnsRef,
    });
    ({ accum, eventCount, exitCode, stderrTrimmed, killReason, idleMsAtKill } = streamResult);

    if (killReason) break; // idle timeout — never retried at the db-lock layer
    if (
      isDbLockedFailure(exitCode, eventCount, stderrTrimmed) &&
      dbAttempt < DB_LOCK_MAX_ATTEMPTS
    ) {
      runnerLogger().warn(
        { event: "session.opencode_db_locked", project: cwd, ...errCtx, dbAttempt },
        "opencode db locked — retrying spawn",
      );
      await Bun.sleep(dbLockRetryDelayMs());
      if (jobId !== undefined && isCancelled?.(jobId)) {
        throw new SessionCancelledError(jobId);
      }
      continue;
    }
    break;
  }

  // The runtime IU key is a live env var inside a session with Bash access — redact it out
  // of everything that could echo it back BEFORE any of it is used to build an error message
  // or gets parsed/returned as data. See `redactSecret`'s doc comment.
  accum = {
    ...accum,
    lastAssistantText: redactSecret(accum.lastAssistantText, iuKey),
    errorMessage: accum.errorMessage ? redactSecret(accum.errorMessage, iuKey) : accum.errorMessage,
  };
  stderrTrimmed = redactSecret(stderrTrimmed, iuKey);

  const durationMs = Math.round(performance.now() - startMs);
  const costUsd = computeOpencodeCostUsd(accum);
  const costFields = {
    costUsd,
    inputTokens: accum.inputTokens,
    outputTokens: accum.outputTokens,
    // Named `thinkingTokens` here (not `reasoningTokens`) to match the claude path's own
    // attribution field name (session-runner.ts's `costFields`) — one consistent column for
    // usage-tracker regardless of which harness produced the row.
    thinkingTokens: accum.reasoningTokens,
    cacheReadTokens: accum.cacheReadTokens,
  };
  const emitAttribution = (
    outcome: "ok" | "error" | "timeout_idle",
    extras: Record<string, unknown> = {},
  ) =>
    writeAttribution({
      sessionId: sessionUuid,
      tool: tool ?? "unknown",
      project: cwd,
      model,
      backend,
      harness: "opencode",
      tsStart,
      tsEnd: new Date().toISOString(),
      outcome,
      durationMs,
      turns: accum.turns,
      ...costFields,
      ...extras,
    });

  if (killReason) {
    emitAttribution("timeout_idle", { killReason, idleMsAtKill });
    const error = `Session timed out — idle ${idleMsAtKill}ms with no stdout (budget ${IDLE_TIMEOUT_MS}ms)`;
    return { ok: false, error, classificationText: error, hadApiRetry: false, backend, model };
  }

  if (exitCode !== 0) {
    emitAttribution("error", { exitCode });
    // opencode's own `error` event, when present, is CLI/tool-sourced same standing as
    // claude's `envelope.errors[]` — safe to classify. Otherwise fall back to a generic
    // message carrying the stderr tail, same shape as claude's `classifyExitFailure`'s
    // no-envelope branch.
    const error = accum.sawErrorEvent
      ? `opencode error: ${accum.errorMessage ?? "unknown"}`
      : `opencode exited with code ${exitCode}${stderrTrimmed ? `. stderr: ${stderrTrimmed.slice(-2000)}` : ""}`;
    return {
      ok: false,
      error,
      classificationText: error,
      hadApiRetry: false,
      backend,
      model,
      ...(accum.lastAssistantText
        ? { noOutput: true as const, rawText: accum.lastAssistantText }
        : {}),
    };
  }

  // exit 0 is NOT success on its own — a real `type: "error"` event (tested,
  // tests/fixtures/opencode-events-error.jsonl) or a stream that never reached a final
  // step_finish(reason: "stop") (truncated/interrupted mid-run) can both still exit 0.
  // `noOutput: true` on both branches below so `isSalvageable` (dispatch.ts) still gets one
  // retry out of a partial `lastAssistantText`, same as every other "ran but didn't finish
  // cleanly" shape this module produces.
  if (accum.sawErrorEvent) {
    emitAttribution("error", { reason: "error_event" });
    const error = `opencode error: ${accum.errorMessage ?? "unknown"}`;
    return {
      ok: false,
      error,
      classificationText: error,
      hadApiRetry: false,
      noOutput: true,
      rawText: accum.lastAssistantText || undefined,
      backend,
      model,
    };
  }

  if (!accum.finished) {
    emitAttribution("error", { reason: "no_stop_reason" });
    const error =
      'opencode session ended without a final step_finish(reason: "stop") — likely truncated or interrupted mid-run';
    return {
      ok: false,
      error,
      classificationText: error,
      hadApiRetry: false,
      noOutput: true,
      rawText: accum.lastAssistantText || undefined,
      backend,
      model,
    };
  }

  if (!accum.lastAssistantText) {
    emitAttribution("error", { reason: "no_output" });
    const error = "opencode session produced no output (no final assistant text)";
    return {
      ok: false,
      error,
      classificationText: error,
      hadApiRetry: false,
      noOutput: true,
      backend,
      model,
    };
  }

  const parsed = extractJson<T>(accum.lastAssistantText);
  if (parsed === undefined) {
    emitAttribution("error", { reason: "json_parse" });
    return unclassifiedOutputFailure<T>(
      `final message is not valid JSON: ${accum.lastAssistantText.slice(0, 500)}`,
      accum.lastAssistantText,
      false,
      backend,
      model,
    );
  }

  if (validate) {
    const v = validate(parsed);
    if (!v.ok) {
      emitAttribution("error", { reason: "invalid_output" });
      const asText = typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
      return unclassifiedOutputFailure<T>(v.error, asText, false, backend, model);
    }
    emitAttribution("ok");
    return { ok: true, data: v.value, backend, model };
  }

  emitAttribution("ok");
  return { ok: true, data: parsed as T, backend, model };
}
