import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { getIuConfig, recordIuUsage, type IuUsage } from "./iu-openai.ts";
import { trackExternalProc } from "../mcp/session-runner.ts";
import { IDLE_TIMEOUT_MS } from "./idle-timeout.ts";
import { routeFor } from "./routing.ts";
import { isPathScope, splitRange } from "./scope.ts";
import { appLogger as logger } from "../logger.ts";

// ── OpenCodeReview (alibaba/open-code-review, `ocr` on PATH) ─────────────────────────────
//
// One more phase-1 review INPUT, like fallow/CodeRabbit — never a gate. A POC on this repo's
// last 4 commits found 5 real, verified issues the 12-angle pipeline missed (cross-file
// consistency, config drift, precise line anchors); it missed the deeper runtime bugs the
// angles caught. `runOcrReview` therefore NEVER throws into the review — a failure degrades
// to a one-line block the synthesizer reads as "no input from this reviewer", the same shape
// an unavailable fallow/CodeRabbit already produces.
//
// Liveness is an idle watchdog only (`.claude/rules/agent-limits.md`): no stdout/stderr byte
// for IDLE_TIMEOUT_MS (5 min) kills it, never a wall-clock ceiling — `--timeout 0` disables
// ocr's own per-subtask deadline so this is the only one in effect. A 3-7 minute wall time on
// a ~1.8k-line diff is normal, not stuck.

const OCR_SIGKILL_GRACE_MS = 5_000;
const OCR_IDLE_CHECK_INTERVAL_MS = 5_000;
const OCR_STDERR_TAIL_CHARS = 2_048;
const SUGGESTION_TRUNCATE_CHARS = 300;
const COMMENT_TRUNCATE_CHARS = 1_500;
const WARNING_TRUNCATE_CHARS = 300;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
const STDERR_LINE_FOR_PROMPT_CHARS = 300;

export interface OcrComment {
  path: string;
  content: string;
  start_line: number;
  end_line: number;
  existing_code?: string;
  suggestion_code?: string;
  thinking?: string;
}

export interface OcrSummary {
  files_reviewed: number;
  comments: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  /** Go duration string, e.g. "2m51s". */
  elapsed: string;
}

export type OcrStatus =
  | "complete"
  | "success"
  | "completed_with_warnings"
  | "completed_with_errors"
  | "skipped";

export interface OcrResult {
  status: OcrStatus;
  /** Absent on some failure shapes — `ocr` doesn't always get far enough to report which
   *  model it was using. */
  llm?: { model: string };
  message?: string;
  summary?: OcrSummary;
  /** Go's `nil` slice serializes as JSON `null`, not `[]` — tolerate both, and an absent key. */
  comments?: OcrComment[] | null;
  warnings?: unknown[] | null;
}

/** Mode flags for `ocr review`, derived from the same scope vocabulary `review.ts` already
 *  validates (`validateScope`/`SAFE_SCOPE`) before this ever runs. `refBaseOid` (set only in
 *  `pr`/`branch` ref mode, where `scope` is a synthetic `pr:N`/`branch:x` label) always wins
 *  over `scope` — the worktree's checked-out ref has no meaningful "uncommitted"/"head" shape
 *  of its own. `null` means "skip OCR for this scope" — a file-path scope has no
 *  merge-base-shaped OCR equivalent (ocr reviews a diff range, not a single-file audit). */
export function ocrModeArgs(scope: string, refBaseOid?: string): string[] | null {
  if (refBaseOid) return ["--from", refBaseOid, "--to", "HEAD"];
  if (scope === "uncommitted") return [];
  if (scope === "head") return ["--commit", "HEAD"];
  const range = splitRange(scope);
  if (range) {
    if (!range.from) return null;
    return ["--from", range.from, "--to", range.to || "HEAD"]; // `main..` = `main..HEAD` in git
  }
  if (isPathScope(scope)) return null; // file path — no OCR mode
  return ["--from", scope, "--to", "HEAD"]; // bare ref
}

/** ocr's review-pass preset. Model-agnostic on purpose: it sets how many review passes ocr
 *  runs, not a model knob. Measured on deepseek-v4.1-flash: one pass instead of the default
 *  two cut ~6.5 to ~2.7 minutes with no loss of real findings (routing.ts's review_ocr). */
export const OCR_EFFORT = "low";

/** The `ocr review` argv after the binary. Pure, so the flags that matter for wall time
 *  (`--timeout 0`, `--effort`) are pinned by a test rather than by review. */
export function ocrArgs(input: {
  modeArgs: string[];
  repo: string;
  outFile: string;
  bgFile?: string;
}): string[] {
  const args = [
    "review",
    ...input.modeArgs,
    "--repo",
    input.repo,
    "--format",
    "json",
    "--audience",
    "human",
    "--timeout",
    "0",
    "--effort",
    OCR_EFFORT,
    "-o",
    input.outFile,
  ];
  if (input.bgFile) args.push("--background-file", input.bgFile);
  return args;
}

/** Which IU transport a model id answers on, as `ocr`'s `OCR_LLM_PROTOCOL`. Probed
 *  2026-09-24 with `ocr llm test`: GPT ids answer on both OpenAI routes but need Responses
 *  to keep reasoning items across ocr's tool loop; Claude, the `DeepSeek-V4-*` gateway ids
 *  and MiniMax answer on the Anthropic route; everything else (deepseek-v4.1-flash, Gemini)
 *  only on OpenAI Chat Completions. */
export type OcrProtocol = "anthropic" | "openai" | "openai-responses";

export function ocrProtocolFor(model: string): OcrProtocol {
  if (/^gpt-/i.test(model)) return "openai-responses";
  if (/^(claude-|DeepSeek-V4-|minimax-)/i.test(model)) return "anthropic";
  return "openai"; // an unknown family fails soft at run time; the `review.ocr` log names it
}

/** Protocol and base URL, decided together so the pairing can't drift. */
export function ocrTransportFor(
  model: string,
  iu: { anthropicBase: string; openaiBase: string },
): { protocol: OcrProtocol; url: string } {
  const protocol = ocrProtocolFor(model);
  return { protocol, url: protocol === "anthropic" ? iu.anthropicBase : iu.openaiBase };
}

/** Maps a clean `ocr` run's own `OcrSummary` onto a `recordIuUsage` call — pulled out as a
 *  pure function (rather than inlined at the one call site) so the mapping is unit-tested
 *  independent of spawning the real binary: `input_tokens`/`output_tokens`/`total_tokens` go
 *  into `usage` (reasoningTokens always 0 — ocr reports no thinking split), `cache_read_tokens`
 *  is duplicated onto both `usage.cacheReadTokens` and the top-level override (the latter
 *  wins), `cache_write_tokens` has no `IuUsage` field so it's a top-level override only, and
 *  `costUsd` is always `null` — ocr's own summary reports no cost. */
export function ocrSummaryToUsage(summary: OcrSummary | undefined): {
  usage: IuUsage;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: null;
} {
  const cacheReadTokens = summary?.cache_read_tokens ?? 0;
  return {
    usage: {
      inputTokens: summary?.input_tokens ?? 0,
      outputTokens: summary?.output_tokens ?? 0,
      reasoningTokens: 0,
      totalTokens: summary?.total_tokens ?? 0,
      cacheReadTokens,
      costUsd: null,
    },
    cacheReadTokens,
    cacheWriteTokens: summary?.cache_write_tokens ?? 0,
    costUsd: null,
  };
}

// ── Failure-path usage recovery ──────────────────────────────────────────────────────────
//
// `ocr` only writes its `OcrSummary` on a clean run. An idle kill, a non-zero exit, an
// unparseable JSON output, or an early abort all still spent real tokens, but leave nothing
// in this process to report — the spend would otherwise be silently lost. `ocr` itself keeps
// a session log per run at `~/.opencodereview/sessions/<slug>/<sessionId>.jsonl`
// (`OCR_SESSIONS_ROOT`/`ocrSessionSlug`) that carries the same usage a clean run's summary
// would have, one `{"type":"llm_response"}` line per LLM turn. Recovery is best-effort and
// must never throw into the review — see `recordOcrFailureUsage`.

const OCR_SESSIONS_ROOT = join(homedir(), ".opencodereview", "sessions");

/** ocr's session-log directory slug for a repo path: the absolute path with every `/` turned
 *  into `-`, then the resulting leading `-` dropped (e.g. `/Users/jkrumm/SourceRoot/sideclaw`
 *  -> `Users-jkrumm-SourceRoot-sideclaw`). In ref/PR/branch mode `--repo` is the WORKTREE
 *  path, not the original repo — callers must pass the same path they gave `ocr --repo`. */
export function ocrSessionSlug(repoPath: string): string {
  return repoPath.replaceAll("/", "-").replace(/^-/, "");
}

export interface OcrSessionUsageSum {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

const ZERO_OCR_SESSION_USAGE: OcrSessionUsageSum = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
};

function numField(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Pure fold over one ocr session-log file's lines (already split on `\n`) — sums every
 *  `{"type":"llm_response"}` line's `usage`. Tolerant of blank lines, unrelated event types
 *  and unparseable/malformed JSON (skipped, never throws) — this reads a 3rd-party log after
 *  a failure, not a shape sideclaw controls. */
export function sumOcrSessionUsage(lines: string[]): OcrSessionUsageSum {
  const sum = { ...ZERO_OCR_SESSION_USAGE };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const rec = parsed as Record<string, unknown>;
    if (rec.type !== "llm_response") continue;
    const usage = rec.usage;
    if (!usage || typeof usage !== "object") continue;
    const u = usage as Record<string, unknown>;
    sum.inputTokens += numField(u.prompt_tokens);
    sum.outputTokens += numField(u.completion_tokens);
    sum.cacheReadTokens += numField(u.cache_read_tokens);
    sum.cacheWriteTokens += numField(u.cache_write_tokens);
  }
  sum.totalTokens = sum.inputTokens + sum.outputTokens;
  return sum;
}

/** A timestamp field ocr may report either as epoch millis (number) or an ISO string —
 *  undocumented which, so both are accepted. `undefined` for anything else. */
function toEpochMs(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return ms;
  }
  return undefined;
}

/** Locates and sums every ocr session-log file for this repo whose run overlaps the failed
 *  attempt: `session_start.timestamp` at or after `startedAtMs - 2000` (a small backward slop
 *  for clock skew between this process and the `ocr` child) and `session_start.cwd` matching
 *  `repoPath` exactly. Never throws — a missing directory, an unreadable file, or a session
 *  log with no parseable `session_start` line all resolve to "nothing found", the same shape
 *  as a run that genuinely spent zero tokens before failing. */
async function findOcrSessionUsage(
  repoPath: string,
  startedAtMs: number,
): Promise<OcrSessionUsageSum> {
  const dir = join(OCR_SESSIONS_ROOT, ocrSessionSlug(repoPath));
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { ...ZERO_OCR_SESSION_USAGE };
  }

  const cutoff = startedAtMs - 2_000;
  const totals = { ...ZERO_OCR_SESSION_USAGE };
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    let text: string;
    try {
      text = await Bun.file(join(dir, entry)).text();
    } catch {
      continue;
    }
    const lines = text.split("\n");
    const firstLine = lines.find((l) => l.trim());
    if (!firstLine) continue;
    let start: Record<string, unknown>;
    try {
      start = JSON.parse(firstLine) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (start.type !== "session_start") continue;
    const startedTs = toEpochMs(start.timestamp);
    if (startedTs === undefined || startedTs < cutoff) continue;
    if (start.cwd !== repoPath) continue;

    const fileSum = sumOcrSessionUsage(lines);
    totals.inputTokens += fileSum.inputTokens;
    totals.outputTokens += fileSum.outputTokens;
    totals.cacheReadTokens += fileSum.cacheReadTokens;
    totals.cacheWriteTokens += fileSum.cacheWriteTokens;
    totals.totalTokens += fileSum.totalTokens;
  }
  return totals;
}

/** Best-effort recovery + recording of token spend for an ocr run that failed before (or
 *  instead of) producing its own `OcrSummary` — idle kill, non-zero exit, unparseable JSON
 *  output, or an early abort. NEVER throws: telemetry on a failure path must not turn into a
 *  second failure that shadows the real one. */
async function recordOcrFailureUsage(input: {
  repoPath: string;
  startedAtMs: number;
  model: string;
  durationMs: number;
}): Promise<void> {
  try {
    const recovered = await findOcrSessionUsage(input.repoPath, input.startedAtMs);
    await recordIuUsage({
      tool: "review_ocr",
      model: input.model,
      usage: {
        inputTokens: recovered.inputTokens,
        outputTokens: recovered.outputTokens,
        reasoningTokens: 0,
        totalTokens: recovered.totalTokens,
        cacheReadTokens: recovered.cacheReadTokens,
        costUsd: null,
      },
      cacheWriteTokens: recovered.cacheWriteTokens,
      latencyMs: input.durationMs,
      outcome: "error",
    });
  } catch (err) {
    logger.warn(
      { event: "review.ocr", tool: "review_ocr", project: input.repoPath, error: String(err) },
      "ocr failure-path usage recovery failed",
    );
  }
}

/** Compact markdown rendering of one OCR run, fed into the synthesis prompt's `[OCR_RESULTS]`
 *  placeholder the same way the fallow/CodeRabbit blocks already are. Pure, never throws.
 *  Zero comments still renders `warnings` and a non-`complete`/`success` `status` — a
 *  `completed_with_errors` run with no comments is a partial failure, not "nothing found". */
export function renderOcrBlock(result: OcrResult): string {
  const comments = result.comments ?? [];
  const warningsList = result.warnings ?? [];
  const warningsBlock =
    warningsList.length > 0
      ? `\n\nWarnings:\n${warningsList.map((w) => `- ${truncate(typeof w === "string" ? w : JSON.stringify(w), WARNING_TRUNCATE_CHARS)}`).join("\n")}`
      : "";

  if (comments.length === 0) {
    const reason = result.message ? ` (${result.message})` : "";
    return `OpenCodeReview: no comments — status ${result.status}${reason}.${warningsBlock}`;
  }

  const summary = result.summary;
  const header =
    `OpenCodeReview — model ${result.llm?.model ?? "unknown"}` +
    (result.status === "complete" || result.status === "success"
      ? ""
      : `, status ${result.status}`) +
    (summary
      ? `, ${summary.files_reviewed} file(s) reviewed, ${summary.comments} comment(s), ${summary.elapsed} elapsed`
      : "");
  const lines = comments.map((c) => {
    const loc = c.start_line === c.end_line ? `${c.start_line}` : `${c.start_line}-${c.end_line}`;
    let line = `- ${c.path}:${loc} — ${truncate(c.content, COMMENT_TRUNCATE_CHARS)}`;
    if (c.suggestion_code) {
      line += `\n  suggestion: ${truncate(c.suggestion_code, SUGGESTION_TRUNCATE_CHARS)}`;
    }
    return line;
  });
  return `${header}\n\n${lines.join("\n")}${warningsBlock}`;
}

function skippedBlock(reason: string): string {
  return `OpenCodeReview: skipped (${reason})`;
}

function failedBlock(reason: string): string {
  return `OpenCodeReview: failed (${reason})`;
}

/** Strip the IU bearer key out of anything derived from `ocr`'s own stderr before it lands in
 *  a log line or (further truncated) the synthesis prompt — `OCR_LLM_TOKEN` is handed to a
 *  third-party binary via env, and a crash/panic could in principle echo its own env back. */
function redact(text: string, key: string | undefined): string {
  return key ? text.replaceAll(key, "[redacted]") : text;
}

/** The synthesis prompt gets only the last non-empty stderr line, already redacted, truncated
 *  to a bounded length — never the full (possibly multi-KB) tail that only the logs see. */
function truncateForPrompt(line: string): string {
  const trimmed = line.trim();
  return trimmed ? trimmed.slice(0, STDERR_LINE_FOR_PROMPT_CHARS) : "no stderr";
}

export interface RunOcrReviewOptions {
  cwd: string;
  scope: string;
  refBaseOid?: string;
  context?: string;
  jobId?: string;
  onActivity?: (label: string) => void;
  /** Aborted by the caller when the review exits early (throw, all-angles-failed) so the
   *  child never outlives the worktree it reads, nor keeps billing tokens nobody will read. */
  signal?: AbortSignal;
}

export interface RunOcrReviewResult {
  /** Rendered for the synthesis prompt's `[OCR_RESULTS]` placeholder — always populated,
   *  never a raw throw, whether OCR ran, was skipped, or failed mid-run. */
  block: string;
  /** True only once the `ocr` child process was actually spawned — false for every skip
   *  path (disabled, not on PATH, no OCR-shaped mode, IU credentials unavailable). Lets a
   *  caller log/attribute without re-deriving the same enable checks this function already
   *  made. */
  ran: boolean;
}

/** Run `ocr review` as one more phase-1 review input, alongside fallow/CodeRabbit — NEVER
 *  throws, so a caller can always treat the resolved `{ block, ran }` as ready for the
 *  synthesis prompt. Skipped (logged) when `SIDECLAW_REVIEW_OCR=0`, `ocr` is not on PATH,
 *  the scope has no OCR-shaped mode (`ocrModeArgs` → `null`), or IU credentials cannot be
 *  resolved. */
export async function runOcrReview(opts: RunOcrReviewOptions): Promise<RunOcrReviewResult> {
  const startMs = performance.now();
  // Wall-clock counterpart to `startMs` (a monotonic clock, useless for matching against
  // ocr's own session-log timestamps) — only used by the failure-path usage recovery below.
  const startedAtMs = Date.now();

  // Declared before the try so the `finally` can always reach them, regardless of which
  // guard clause or catch returned first — the same lifecycle-tracking shape
  // `runSessionAttempt` (session-runner.ts) uses for its own subprocess.
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let idleInterval: ReturnType<typeof setInterval> | undefined;
  let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let untrack: (() => void) | undefined;
  let tmpDir: string | undefined;
  let stderrTail = "";
  let lastActivityLine = "";
  let lastActivityAt = Date.now();
  let killedForIdle = false;

  // Shared by the idle watchdog, the abort listener and the `finally` — one escalation path
  // (SIGTERM → OCR_SIGKILL_GRACE_MS → SIGKILL), not three copies of it. Idempotent: a no-op
  // once `proc` has already exited (or was never spawned).
  const terminate = (): void => {
    if (!proc || proc.exitCode !== null) return;
    proc.kill("SIGTERM");
    sigkillTimer = setTimeout(() => {
      if (proc && proc.exitCode === null) proc.kill("SIGKILL");
    }, OCR_SIGKILL_GRACE_MS);
  };

  try {
    if (process.env.SIDECLAW_REVIEW_OCR === "0") {
      logger.info(
        { event: "review.ocr", tool: "review_ocr", project: opts.cwd },
        "ocr skipped — SIDECLAW_REVIEW_OCR=0",
      );
      return { block: skippedBlock("SIDECLAW_REVIEW_OCR=0"), ran: false };
    }

    const ocrBin = Bun.which("ocr");
    if (!ocrBin) {
      logger.warn(
        { event: "review.ocr", tool: "review_ocr", project: opts.cwd },
        "ocr skipped — not found on PATH",
      );
      return { block: skippedBlock("ocr not found on PATH"), ran: false };
    }

    const modeArgs = ocrModeArgs(opts.scope, opts.refBaseOid);
    if (modeArgs === null) {
      logger.info(
        { event: "review.ocr", tool: "review_ocr", project: opts.cwd, scope: opts.scope },
        "ocr skipped — scope has no OCR-shaped mode",
      );
      return {
        block: skippedBlock("scope is a file path, which ocr has no equivalent mode for"),
        ran: false,
      };
    }

    let iuConfig: Awaited<ReturnType<typeof getIuConfig>>;
    try {
      iuConfig = await getIuConfig();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { event: "review.ocr", tool: "review_ocr", project: opts.cwd, error: msg },
        "ocr skipped — IU credentials unavailable",
      );
      return { block: skippedBlock(`IU credentials unavailable: ${msg}`), ran: false };
    }

    const model = routeFor("review_ocr").model;
    const transport = ocrTransportFor(model, iuConfig);

    // A private per-run directory, not two loose files in the shared tmp root — both the
    // JSON output and the background-context file may carry repo/diff content, so they get
    // their own 0700 directory rather than sitting next to every other process's scratch
    // files. `mkdtemp`'s own POSIX `mkdtemp(3)` already creates at 0700; the `chmod` is
    // belt-and-braces, not a correction.
    tmpDir = await mkdtemp(join(tmpdir(), "sideclaw-ocr-"));
    await chmod(tmpDir, 0o700);
    const outFile = join(tmpDir, "result.json");
    const bgFile = opts.context ? join(tmpDir, "background.md") : undefined;
    if (bgFile) {
      await writeFile(bgFile, opts.context ?? "", { encoding: "utf-8", mode: 0o600 });
    }

    const args = ocrArgs({ modeArgs, repo: opts.cwd, outFile, bgFile });

    // Minimal env, deliberately not a copy of process.env — same reasoning
    // buildWorkerEnv's scrub applies to a worker session: a spawned CLI has no reason to hold
    // whatever credentials this LaunchAgent process happens to carry.
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      OCR_LLM_URL: transport.url,
      OCR_LLM_TOKEN: iuConfig.key,
      OCR_LLM_PROTOCOL: transport.protocol,
      OCR_LLM_MODEL: model,
      OCR_ENABLE_TELEMETRY: "0",
    };
    if (process.env.LANG) env.LANG = process.env.LANG;

    proc = Bun.spawn([ocrBin, ...args], {
      stdin: "ignore",
      cwd: opts.cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    untrack = trackExternalProc(proc, opts.jobId);

    onAbort = (): void => terminate();
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    idleInterval = setInterval(() => {
      if (!killedForIdle && Date.now() - lastActivityAt >= IDLE_TIMEOUT_MS) {
        killedForIdle = true;
        terminate();
      }
    }, OCR_IDLE_CHECK_INTERVAL_MS);

    const readStderr = async (): Promise<void> => {
      if (!proc?.stderr) return;
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lastActivityAt = Date.now();
        const chunk = decoder.decode(value, { stream: true });
        // Redact BEFORE truncating, so a key straddling the cut can't survive half-masked.
        stderrTail = redact(stderrTail + chunk, iuConfig.key).slice(-OCR_STDERR_TAIL_CHARS);
        buf += chunk;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          lastActivityLine = redact(trimmed, iuConfig.key);
          opts.onActivity?.(`ocr: ${lastActivityLine.slice(0, 120)}`);
        }
      }
    };
    // stdout carries little in -o mode, but it must still be drained so the pipe never backs
    // up and blocks the child — and any byte on it is activity too.
    const readStdout = async (): Promise<void> => {
      if (!proc?.stdout) return;
      const reader = proc.stdout.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
        lastActivityAt = Date.now();
      }
    };

    await Promise.all([readStderr(), readStdout()]);
    const exitCode = await proc.exited;
    const durationMs = Math.round(performance.now() - startMs);

    if (opts.signal?.aborted) {
      await recordOcrFailureUsage({ repoPath: opts.cwd, startedAtMs, model, durationMs });
      return { block: skippedBlock("review exited early"), ran: true };
    }

    if (killedForIdle) {
      logger.warn(
        {
          event: "review.ocr",
          tool: "review_ocr",
          project: opts.cwd,
          status: "idle",
          durationMs,
          stderrTail,
        },
        "ocr killed — idle watchdog",
      );
      await recordOcrFailureUsage({ repoPath: opts.cwd, startedAtMs, model, durationMs });
      return {
        block: failedBlock(
          `idle — no output for ${Math.round(IDLE_TIMEOUT_MS / 1000)}s, last: ${truncateForPrompt(lastActivityLine)}`,
        ),
        ran: true,
      };
    }

    if (exitCode !== 0) {
      logger.warn(
        {
          event: "review.ocr",
          tool: "review_ocr",
          project: opts.cwd,
          status: `exit_${exitCode}`,
          durationMs,
          stderrTail,
        },
        "ocr exited non-zero",
      );
      await recordOcrFailureUsage({ repoPath: opts.cwd, startedAtMs, model, durationMs });
      return {
        block: failedBlock(`exit ${exitCode}: ${truncateForPrompt(lastActivityLine)}`),
        ran: true,
      };
    }

    const raw = await Bun.file(outFile).text();
    let parsed: OcrResult;
    try {
      parsed = JSON.parse(raw) as OcrResult;
    } catch (err) {
      logger.warn(
        { event: "review.ocr", tool: "review_ocr", project: opts.cwd, error: String(err) },
        "ocr output did not parse as JSON",
      );
      await recordOcrFailureUsage({ repoPath: opts.cwd, startedAtMs, model, durationMs });
      return { block: failedBlock("output did not parse as JSON"), ran: true };
    }

    const usageArgs = ocrSummaryToUsage(parsed.summary);
    await recordIuUsage({ tool: "review_ocr", model, latencyMs: durationMs, ...usageArgs });

    logger.info(
      {
        event: "review.ocr",
        tool: "review_ocr",
        project: opts.cwd,
        model,
        protocol: transport.protocol,
        effort: OCR_EFFORT,
        status: parsed.status,
        comments: parsed.comments?.length ?? 0,
        totalTokens: parsed.summary?.total_tokens ?? 0,
        durationMs,
      },
      "ocr review done",
    );

    // ocr's comments quote repo content and model output — redact defensively there too.
    return { block: redact(renderOcrBlock(parsed), iuConfig.key), ran: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { event: "review.ocr", tool: "review_ocr", project: opts.cwd, error: msg, stderrTail },
      "ocr review failed",
    );
    return { block: failedBlock(msg), ran: proc !== undefined };
  } finally {
    if (idleInterval) clearInterval(idleInterval);
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
    // Kill BEFORE untrack: a process still using `tmpDir`/`opts.cwd` when this function
    // returns is exactly the race the caller's own abort+await (review.ts's `finally`)
    // exists to prevent — never rely on the caller alone to have already stopped it.
    if (proc) {
      terminate();
      if (proc.exitCode === null) await proc.exited;
    }
    // Cleared only once the child has exited — `terminate()` above may have just re-armed it.
    if (sigkillTimer) clearTimeout(sigkillTimer);
    untrack?.();
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
