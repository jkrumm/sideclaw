#!/usr/bin/env bun
// Harness-agnostic command-line front end to the sideclaw HTTP job API
// (server/routes/). A plain HTTP client — no dependency on the MCP layer — so
// any tool (OpenCode, Codex, a shell, cron) can submit and wait on jobs without
// a Claude Code MCP client. Talks to `SIDECLAW_URL ?? http://127.0.0.1:7705`.
//
// The argv → request-body mapping and the exit-code mapping are exported pure
// functions so tests/cli.test.ts can pin them without spawning a server; the
// only I/O here is fetch, the git-root probe, and `--context @file` reads.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isTerminal, type JobStatus } from "../server/jobs/types";
import type { DispatchOutput } from "../server/jobs/handlers/dispatch.ts";
import type { CheckOutput } from "../server/jobs/handlers/check.ts";
import type { ReviewOutput } from "../server/jobs/handlers/review.ts";

const DEFAULT_URL = "http://127.0.0.1:7705";
const POLL_MS = 2000;
// A transient poll failure (e.g. the `make reload` restart window) is retried with backoff
// rather than aborting the whole wait — the job itself is durable server-side.
const MAX_POLL_RETRIES = 10;
const POLL_RETRY_BASE_MS = 2000;
const POLL_RETRY_CAP_MS = 10000;

// ── Errors (message → exit code) ─────────────────────────────────────────────────

class CliError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** Usage error or policy refusal → exit 2. */
class CliUsageError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = "CliUsageError";
  }
}

/** The server answered but with an error (bad status, malformed body, unknown job) → exit 1. */
class CliServerError extends CliError {
  constructor(message: string) {
    super(message, 1);
    this.name = "CliServerError";
  }
}

/** The server could not be reached at all (connection refused, DNS, …) → exit 3. */
class CliUnreachableError extends CliError {
  constructor(message: string) {
    super(message, 3);
    this.name = "CliUnreachableError";
  }
}

/** Internal-only: a bounded poll's deadline passed — never surfaced past `waitForJob`. */
class PollDeadlineError extends Error {}

// ── Parsed-command model ─────────────────────────────────────────────────────────

export type RepoSpec =
  | { kind: "default" }
  | { kind: "path"; path: string }
  | { kind: "name"; name: string };

export type ContextSpec = { kind: "text"; text: string } | { kind: "file"; path: string };

export const DISPATCH_TIERS = ["investigate", "author", "implement"] as const;
export type DispatchTier = (typeof DISPATCH_TIERS)[number];

export const DISPATCH_WORKSPACES = ["worktree", "in-place"] as const;
export type DispatchWorkspace = (typeof DISPATCH_WORKSPACES)[number];

export interface DispatchCommand {
  kind: "dispatch";
  brief: string;
  repo: RepoSpec;
  tier?: DispatchTier;
  workspace?: DispatchWorkspace;
  model?: string;
  context?: ContextSpec;
  sensitive: boolean;
}

export interface CheckCommand {
  kind: "check";
  repo: RepoSpec;
  commands?: string[];
}

export interface ReviewCommand {
  kind: "review";
  repo: RepoSpec;
  scope?: string;
  pr?: number;
  branch?: string;
}

export interface JobsCommand {
  kind: "jobs";
  running: boolean;
}

export interface JobRefCommand {
  kind: "status" | "wait" | "cancel";
  jobId: string;
}

export interface SimpleCommand {
  kind: "routing" | "policy" | "health";
}

export interface HelpCommand {
  kind: "help";
  topic?: string;
}

export type ParsedCommand =
  | DispatchCommand
  | CheckCommand
  | ReviewCommand
  | JobsCommand
  | JobRefCommand
  | SimpleCommand
  | HelpCommand;

export interface GlobalOptions {
  json: boolean;
  noWait: boolean;
  quiet: boolean;
  timeoutSec?: number;
}

export interface Parsed {
  command: ParsedCommand;
  options: GlobalOptions;
}

// ── Argument parsing (pure) ──────────────────────────────────────────────────────

function parsePositiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CliUsageError(`${flag} must be a positive integer, got: ${raw}`);
  }
  return n;
}

export function parseArgs(argv: string[]): Parsed {
  const options: GlobalOptions = { json: false, noWait: false, quiet: false };
  const rest: string[] = [];
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--no-wait") {
      options.noWait = true;
      continue;
    }
    if (arg === "--quiet") {
      options.quiet = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg.startsWith("--timeout=")) {
      options.timeoutSec = parsePositiveInt(arg.slice("--timeout=".length), "--timeout");
      continue;
    }
    if (arg === "--timeout") {
      const value = argv[i + 1];
      if (value === undefined) throw new CliUsageError("--timeout requires a value (seconds)");
      options.timeoutSec = parsePositiveInt(value, "--timeout");
      i++;
      continue;
    }
    rest.push(arg);
  }

  const name = rest[0];
  if (help) return { command: { kind: "help", topic: name }, options };
  if (name === undefined) throw new CliUsageError("no command given (see 'sideclaw --help')");
  if (name === "help") return { command: { kind: "help", topic: rest[1] }, options };

  switch (name) {
    case "dispatch":
      return { command: parseDispatch(rest.slice(1)), options };
    case "check":
      return { command: parseCheck(rest.slice(1)), options };
    case "review":
      return { command: parseReview(rest.slice(1)), options };
    case "jobs":
      return { command: parseJobs(rest.slice(1)), options };
    case "status":
    case "wait":
    case "cancel":
      return { command: { kind: name, jobId: oneJobId(rest.slice(1), name) }, options };
    case "routing":
    case "policy":
    case "health":
      noArgs(rest.slice(1), name);
      return { command: { kind: name }, options };
    default:
      throw new CliUsageError(`unknown command: ${name}`);
  }
}

/** Flag parser shared by the subcommands: `--flag` / `--flag=value` / `--flag value`. */
function parseFlags(
  args: string[],
  spec: Record<string, "boolean" | "value">,
  command: string,
): { flags: Map<string, string | true>; positionals: string[] } {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const flag = eq === -1 ? arg : arg.slice(0, eq);
      const def = spec[flag];
      if (def === undefined) throw new CliUsageError(`sideclaw ${command}: unknown flag ${flag}`);
      if (def === "boolean") {
        if (eq !== -1) throw new CliUsageError(`sideclaw ${command}: flag ${flag} takes no value`);
        flags.set(flag, true);
      } else {
        let value: string;
        if (eq !== -1) {
          value = arg.slice(eq + 1);
        } else {
          const next = args[i + 1];
          if (next === undefined) {
            throw new CliUsageError(`sideclaw ${command}: flag ${flag} requires a value`);
          }
          value = next;
          i++;
        }
        flags.set(flag, value);
      }
    } else if (arg.startsWith("-") && arg !== "-") {
      throw new CliUsageError(`sideclaw ${command}: unknown flag ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

function flagValue(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function parseRepo(value: string | undefined): RepoSpec {
  if (value === undefined || value.length === 0) return { kind: "default" };
  if (isAbsolute(value)) return { kind: "path", path: value };
  if (value.includes("/") || value === "." || value === "..") {
    throw new CliUsageError(`--repo must be a bare repo name or an absolute path, got: ${value}`);
  }
  return { kind: "name", name: value };
}

function oneJobId(args: string[], command: string): string {
  if (args.length !== 1 || (args[0] ?? "") === "") {
    throw new CliUsageError(`sideclaw ${command} requires exactly one <jobId>`);
  }
  return args[0] as string;
}

function noArgs(args: string[], command: string): void {
  if (args.length > 0) throw new CliUsageError(`sideclaw ${command} takes no arguments`);
}

function parseDispatch(args: string[]): DispatchCommand {
  const { flags, positionals } = parseFlags(
    args,
    {
      "--repo": "value",
      "--tier": "value",
      "--workspace": "value",
      "--model": "value",
      "--context": "value",
      "--sensitive": "boolean",
    },
    "dispatch",
  );
  const brief = positionals.join(" ").trim();
  if (brief.length === 0) throw new CliUsageError("sideclaw dispatch requires a <brief>");

  const command: DispatchCommand = {
    kind: "dispatch",
    brief,
    repo: parseRepo(flagValue(flags, "--repo")),
    sensitive: flags.has("--sensitive"),
  };

  const tier = flagValue(flags, "--tier");
  if (tier !== undefined) {
    if (!(DISPATCH_TIERS as readonly string[]).includes(tier)) {
      throw new CliUsageError(
        `sideclaw dispatch: --tier must be one of ${DISPATCH_TIERS.join("|")}, got: ${tier}`,
      );
    }
    command.tier = tier as DispatchTier;
  }

  const workspace = flagValue(flags, "--workspace");
  if (workspace !== undefined) {
    if (!(DISPATCH_WORKSPACES as readonly string[]).includes(workspace)) {
      throw new CliUsageError(
        `sideclaw dispatch: --workspace must be one of ${DISPATCH_WORKSPACES.join("|")}, got: ${workspace}`,
      );
    }
    command.workspace = workspace as DispatchWorkspace;
  }

  const model = flagValue(flags, "--model");
  if (model !== undefined) command.model = model;

  const context = flagValue(flags, "--context");
  if (context !== undefined) {
    command.context = context.startsWith("@")
      ? { kind: "file", path: context.slice(1) }
      : { kind: "text", text: context };
  }
  return command;
}

function parseCheck(args: string[]): CheckCommand {
  const { flags, positionals } = parseFlags(
    args,
    { "--repo": "value", "--commands": "value" },
    "check",
  );
  if (positionals.length > 0)
    throw new CliUsageError("sideclaw check takes no positional arguments");

  const command: CheckCommand = { kind: "check", repo: parseRepo(flagValue(flags, "--repo")) };
  const commands = flagValue(flags, "--commands");
  if (commands !== undefined) {
    const list = commands
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (list.length > 0) command.commands = list;
  }
  return command;
}

function parseReview(args: string[]): ReviewCommand {
  const { flags, positionals } = parseFlags(
    args,
    { "--repo": "value", "--scope": "value", "--pr": "value", "--branch": "value" },
    "review",
  );
  if (positionals.length > 0)
    throw new CliUsageError("sideclaw review takes no positional arguments");

  const scope = flagValue(flags, "--scope");
  const prRaw = flagValue(flags, "--pr");
  const branch = flagValue(flags, "--branch");
  const given = [scope !== undefined, prRaw !== undefined, branch !== undefined].filter(
    Boolean,
  ).length;
  if (given > 1) {
    throw new CliUsageError("sideclaw review: --scope, --pr and --branch are mutually exclusive");
  }

  const command: ReviewCommand = { kind: "review", repo: parseRepo(flagValue(flags, "--repo")) };
  if (scope !== undefined) command.scope = scope;
  if (prRaw !== undefined) command.pr = parsePositiveInt(prRaw, "--pr");
  if (branch !== undefined) command.branch = branch;
  return command;
}

function parseJobs(args: string[]): JobsCommand {
  const { flags, positionals } = parseFlags(args, { "--running": "boolean" }, "jobs");
  if (positionals.length > 0)
    throw new CliUsageError("sideclaw jobs takes no positional arguments");
  return { kind: "jobs", running: flags.has("--running") };
}

// ── Mapping (pure) ───────────────────────────────────────────────────────────────

export type JobCommand = DispatchCommand | CheckCommand | ReviewCommand;

export interface RequestBody {
  tool: "dispatch" | "check" | "review";
  params: Record<string, unknown>;
}

/** The exact POST /api/jobs body a parsed command sends, given the resolved repo
 *  path and (for dispatch) the resolved context text. */
export function requestBody(
  command: JobCommand,
  resolved: { cwd: string; context?: string },
): RequestBody {
  switch (command.kind) {
    case "dispatch": {
      const params: Record<string, unknown> = { cwd: resolved.cwd, brief: command.brief };
      if (command.tier !== undefined) params.tier = command.tier;
      if (command.workspace !== undefined) params.workspace = command.workspace;
      if (command.model !== undefined) params.model = command.model;
      if (resolved.context !== undefined) params.context = resolved.context;
      if (command.sensitive) params.sensitive = true;
      return { tool: "dispatch", params };
    }
    case "check": {
      const params: Record<string, unknown> = { cwd: resolved.cwd };
      if (command.commands !== undefined) params.commands = command.commands;
      return { tool: "check", params };
    }
    case "review": {
      const params: Record<string, unknown> = { cwd: resolved.cwd };
      if (command.scope !== undefined) params.scope = command.scope;
      if (command.pr !== undefined) params.pr = command.pr;
      if (command.branch !== undefined) params.branch = command.branch;
      return { tool: "review", params };
    }
  }
}

export interface RepoResolution {
  cwd: string;
  roots: string[];
  gitRoot: (cwd: string) => string | null;
}

/** Resolve a `--repo` spec to an absolute repo path. A bare name resolves against
 *  the dispatch roots (GET /api/dispatch-policy); the default is the git root of
 *  the current directory. */
export function resolveRepoSpec(spec: RepoSpec, opts: RepoResolution): string {
  if (spec.kind === "path") return resolve(spec.path);
  if (spec.kind === "name") {
    for (const root of opts.roots) {
      const candidate = resolve(root, spec.name);
      if (existsSync(candidate)) return candidate;
    }
    const searched = opts.roots.map((r) => resolve(r, spec.name)).join(", ");
    throw new CliUsageError(
      `--repo ${spec.name}: no such repo under the dispatch roots (searched ${searched})`,
    );
  }
  const root = opts.gitRoot(opts.cwd);
  if (root === null) {
    throw new CliUsageError("not inside a git repository — pass --repo <name|path>");
  }
  return root;
}

/** Resolve a `--context` spec to its text: a leading `@` reads a file, anything
 *  else is passed through verbatim. */
export function resolveContext(
  spec: ContextSpec | undefined,
  read: (path: string) => string,
): string | undefined {
  if (spec === undefined) return undefined;
  if (spec.kind === "text") return spec.text;
  try {
    return read(spec.path);
  } catch (err) {
    throw new CliUsageError(
      `could not read --context file ${spec.path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Exit code for a job that reached a terminal state: 0 done, 1 failed/interrupted/
 *  cancelled, 2 a policy refusal (`dispatch refused: …` surfaced as a job error). */
export function exitCodeFor(status: JobStatus, error: string | null): number {
  if (status === "done") return 0;
  if (status === "failed" || status === "interrupted" || status === "cancelled") {
    return error !== null && error.startsWith("dispatch refused:") ? 2 : 1;
  }
  return 1;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  if (h > 0) return `${h}h${m}m${s}s`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

// ── Rendering (readable output for humans) ───────────────────────────────────────

export function renderVerdictResult(r: DispatchOutput): string {
  const lines: string[] = [r.summary, "", r.verdict];
  lines.push(`confidence: ${r.confidence}`);
  lines.push(`outcome: ${r.outcome}`);
  lines.push(`nextAction: ${r.nextAction}`);
  lines.push(`recommendation: ${r.recommendation}`);
  if (typeof r.artifactUrl === "string") lines.push(`artifact: ${r.artifactUrl}`);
  if (typeof r.branch === "string") lines.push(`branch: ${r.branch}`);
  if (Array.isArray(r.changedFiles) && r.changedFiles.length > 0) {
    lines.push(`changed: ${r.changedFiles.join(", ")}`);
  }
  return lines.join("\n");
}

export function renderCheckResult(r: CheckOutput): string {
  const lines = [r.summary];
  for (const step of r.steps) {
    const detail =
      Array.isArray(step.errors) && step.errors.length > 0 ? ` — ${step.errors.join(" | ")}` : "";
    lines.push(`  [${step.passed ? "ok" : "FAIL"}] ${step.name}${detail}`);
  }
  return lines.join("\n");
}

export function renderReviewResult(r: ReviewOutput): string {
  const lines = [r.summary];
  for (const finding of r.blocking.slice(0, 8)) {
    lines.push(`  - [blocking] ${finding.file}: ${finding.message}`);
  }
  return lines.join("\n");
}

function isDispatchOutput(r: Record<string, unknown>): r is DispatchOutput {
  return typeof r.verdict === "string";
}

function isCheckOutput(r: Record<string, unknown>): r is CheckOutput {
  return typeof r.passed === "boolean" && Array.isArray(r.steps);
}

function isReviewOutput(r: Record<string, unknown>): r is ReviewOutput {
  return typeof r.outcome === "string" && ("blocking" in r || "improvements" in r);
}

/** Renderer table, tried in order — the first matching shape wins. A server ahead of the
 *  CLI (an unknown output shape) degrades to the raw-JSON fallback rather than throwing. */
const RESULT_RENDERERS: ReadonlyArray<{
  matches: (r: Record<string, unknown>) => boolean;
  render: (r: Record<string, unknown>) => string;
}> = [
  { matches: isDispatchOutput, render: (r) => renderVerdictResult(r as DispatchOutput) },
  { matches: isCheckOutput, render: (r) => renderCheckResult(r as CheckOutput) },
  { matches: isReviewOutput, render: (r) => renderReviewResult(r as ReviewOutput) },
];

export function renderResult(result: unknown): string {
  if (result === null || result === undefined) return "(no result)";
  if (typeof result !== "object") return String(result);
  const r = result as Record<string, unknown>;
  for (const { matches, render } of RESULT_RENDERERS) {
    if (matches(r)) return render(r);
  }
  return JSON.stringify(result, null, 2);
}

// ── HTTP client (the only I/O against the server) ────────────────────────────────

/** The narrow fetch shape the CLI needs — narrower than `typeof fetch` so a test mock
 *  is a plain function, not a cast through `unknown`. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface HttpResponse {
  status: number;
  data: unknown;
}

async function request(
  fetchFn: FetchLike,
  base: string,
  path: string,
  init?: RequestInit,
): Promise<HttpResponse> {
  let res: Response;
  try {
    res = await fetchFn(base + path, init);
  } catch (err) {
    // An abort we issued ourselves (a bounded poll's own deadline) is not "unreachable" —
    // let it propagate so the caller can tell the two apart.
    if (err instanceof Error && err.name === "AbortError") throw err;
    throw new CliUnreachableError(
      `sideclaw server unreachable at ${base} — it runs as a LaunchAgent; start it with 'make install-agent' in ~/SourceRoot/sideclaw`,
    );
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

interface JobView {
  id: string;
  tool: string;
  status: JobStatus;
  result: unknown;
  error: string | null;
  progress: { turns: number; lastAction: string } | null;
  elapsedMs: number;
  idleMs: number | null;
}

async function submitJob(fetchFn: FetchLike, base: string, body: RequestBody): Promise<string> {
  const r = await request(fetchFn, base, "/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.status === 200) {
    const data = r.data as { ok?: boolean; job?: { id?: string } };
    const id = data.job?.id;
    if (data.ok === true && typeof id === "string") return id;
  }
  const data = r.data as { error?: string };
  const message = data.error ?? `job submit failed with status ${r.status}`;
  if (message.startsWith("dispatch refused:")) throw new CliUsageError(message);
  throw r.status >= 400 && r.status < 500
    ? new CliUsageError(message)
    : new CliServerError(message);
}

async function fetchJob(
  fetchFn: FetchLike,
  base: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<JobView> {
  const r = await request(
    fetchFn,
    base,
    `/api/jobs/${encodeURIComponent(jobId)}`,
    signal ? { signal } : undefined,
  );
  if (r.status === 404) throw new CliServerError(`job not found: ${jobId}`);
  if (r.status !== 200) throw new CliServerError(`job status fetch failed (${r.status})`);
  const data = r.data as { ok?: boolean; job?: JobView };
  if (data.ok !== true || data.job === undefined)
    throw new CliServerError("job status fetch failed");
  return data.job;
}

/** Poll bounded by an overall deadline: aborts the request once the remaining time runs
 *  out, and throws `PollDeadlineError` (never the generic "unreachable" error) for both
 *  an abort and a deadline already passed before the request was even made. No `deadline`
 *  means unbounded — the plain `fetchJob`, no `AbortController` involved. */
async function fetchJobBounded(
  fetchFn: FetchLike,
  base: string,
  jobId: string,
  deadline: number | undefined,
): Promise<JobView> {
  if (deadline === undefined) return fetchJob(fetchFn, base, jobId);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new PollDeadlineError();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    return await fetchJob(fetchFn, base, jobId, controller.signal);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new PollDeadlineError();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPolicy(fetchFn: FetchLike, base: string): Promise<{ roots: string[] }> {
  const r = await request(fetchFn, base, "/api/dispatch-policy");
  if (r.status !== 200) throw new CliServerError(`could not read dispatch policy (${r.status})`);
  const data = r.data as { ok?: boolean; roots?: unknown };
  if (data.ok !== true || !Array.isArray(data.roots)) {
    throw new CliServerError("dispatch policy returned no roots");
  }
  return { roots: data.roots.filter((x): x is string => typeof x === "string") };
}

// ── Progress (stderr, human-only) ────────────────────────────────────────────────

function progressLine(job: JobView): string {
  const elapsed = formatDuration(job.elapsedMs);
  if (job.status === "pending") return `[${elapsed}] queued`;
  const turns = job.progress?.turns ?? 0;
  const action = job.progress?.lastAction ?? "starting";
  const idle = job.idleMs !== null ? formatDuration(job.idleMs) : "—";
  return `[${elapsed}] turns=${turns} ${action} idle=${idle}`;
}

function progressSig(job: JobView): string {
  return `${job.status}|${job.progress?.turns ?? 0}|${job.progress?.lastAction ?? ""}`;
}

// ── Execution ────────────────────────────────────────────────────────────────────

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
}

export interface CliContext {
  fetchFn: FetchLike;
  gitRoot: (cwd: string) => string | null;
  cwd: string;
  env: Record<string, string | undefined>;
  /** Overrides the real `setTimeout`-based delay — tests inject an instant resolver so a
   *  poll interval or a retry backoff doesn't cost real wall-clock time. Defaults to `sleep`. */
  sleepFn?: (ms: number) => Promise<void>;
}

/** Run the CLI against an injected fetch/gitRoot — the seam tests use to avoid a
 *  live server. Returns the process exit code. */
export async function run(argv: string[], ctx: CliContext, io: CliIo): Promise<number> {
  const base = (ctx.env.SIDECLAW_URL ?? DEFAULT_URL).replace(/\/+$/, "");
  try {
    const { command, options } = parseArgs(argv);
    return await execute(command, options, ctx, io, base);
  } catch (err) {
    if (err instanceof CliError) {
      io.err(`sideclaw: ${err.message}\n`);
      if (err.code === 2) io.err("Try 'sideclaw --help'.\n");
      return err.code;
    }
    io.err(`sideclaw: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function execute(
  command: ParsedCommand,
  options: GlobalOptions,
  ctx: CliContext,
  io: CliIo,
  base: string,
): Promise<number> {
  if (command.kind === "help") {
    io.out(helpText(command.topic));
    return 0;
  }

  switch (command.kind) {
    case "dispatch":
    case "check":
    case "review": {
      const cwd = await resolveCwd(ctx, base, command);
      const contextText =
        command.kind === "dispatch"
          ? resolveContext(command.context, (p) => readFileSync(p, "utf8"))
          : undefined;
      const body = requestBody(command, { cwd, context: contextText });
      const jobId = await submitJob(ctx.fetchFn, base, body);
      if (options.noWait) {
        if (options.json) io.out(`${JSON.stringify({ jobId }, null, 2)}\n`);
        else io.out(`${jobId}\n`);
        return 0;
      }
      return waitForJob(ctx, io, base, jobId, options);
    }
    case "wait":
      return waitForJob(ctx, io, base, command.jobId, options);
    case "status": {
      const job = await fetchJob(ctx.fetchFn, base, command.jobId);
      if (options.json) io.out(`${JSON.stringify(job, null, 2)}\n`);
      else io.out(`${renderJob(job)}\n`);
      return isTerminal(job.status) ? exitCodeFor(job.status, job.error) : 0;
    }
    case "jobs": {
      const r = await request(ctx.fetchFn, base, "/api/jobs");
      if (r.status !== 200) throw new CliServerError(`could not list jobs (${r.status})`);
      const data = r.data as { ok?: boolean; jobs?: JobView[] };
      const jobs = (data.jobs ?? []).filter((j) => !command.running || !isTerminal(j.status));
      if (options.json) io.out(`${JSON.stringify(jobs, null, 2)}\n`);
      else io.out(`${renderJobs(jobs)}\n`);
      return 0;
    }
    case "cancel": {
      const r = await request(
        ctx.fetchFn,
        base,
        `/api/jobs/${encodeURIComponent(command.jobId)}/cancel`,
        {
          method: "POST",
        },
      );
      if (r.status === 200) {
        const data = r.data as { job?: JobView };
        if (options.json) io.out(`${JSON.stringify(data.job ?? null, null, 2)}\n`);
        else io.out(`cancelled ${command.jobId}\n`);
        return 0;
      }
      const data = r.data as { error?: string };
      throw new CliServerError(data.error ?? `cancel failed (${r.status})`);
    }
    case "health": {
      const r = await request(ctx.fetchFn, base, "/api/jobs/health");
      if (r.status !== 200) throw new CliServerError(`health check failed (${r.status})`);
      if (options.json) io.out(`${JSON.stringify(r.data, null, 2)}\n`);
      else io.out(`${renderHealth(r.data as Record<string, unknown>)}\n`);
      return 0;
    }
    case "routing": {
      const r = await request(ctx.fetchFn, base, "/api/routing");
      if (r.status !== 200) throw new CliServerError(`could not read routing table (${r.status})`);
      if (options.json) io.out(`${JSON.stringify(r.data, null, 2)}\n`);
      else io.out(`${renderRouting(r.data)}\n`);
      return 0;
    }
    case "policy": {
      const r = await request(ctx.fetchFn, base, "/api/dispatch-policy");
      if (r.status !== 200)
        throw new CliServerError(`could not read dispatch policy (${r.status})`);
      if (options.json) io.out(`${JSON.stringify(r.data, null, 2)}\n`);
      else io.out(`${renderPolicy(r.data)}\n`);
      return 0;
    }
  }
}

async function resolveCwd(ctx: CliContext, base: string, command: JobCommand): Promise<string> {
  if (command.repo.kind !== "name") {
    return resolveRepoSpec(command.repo, { cwd: ctx.cwd, roots: [], gitRoot: ctx.gitRoot });
  }
  const policy = await fetchPolicy(ctx.fetchFn, base);
  return resolveRepoSpec(command.repo, { cwd: ctx.cwd, roots: policy.roots, gitRoot: ctx.gitRoot });
}

function timeoutMessage(jobId: string, timeoutSec: number): string {
  return `sideclaw: timed out after ${timeoutSec}s — job ${jobId} still running\n`;
}

async function waitForJob(
  ctx: CliContext,
  io: CliIo,
  base: string,
  jobId: string,
  options: GlobalOptions,
): Promise<number> {
  const start = Date.now();
  const wait = ctx.sleepFn ?? sleep;
  let lastSig: string | null = null;
  let lastStatus: JobStatus | null = null;
  let pollFailures = 0;
  const showProgress = !options.quiet && !options.json;
  const deadline = () =>
    options.timeoutSec !== undefined ? start + options.timeoutSec * 1000 : undefined;

  for (;;) {
    const before = deadline();
    if (before !== undefined && Date.now() >= before) {
      io.err(timeoutMessage(jobId, options.timeoutSec as number));
      return 1;
    }

    let job: JobView;
    try {
      job = await fetchJobBounded(ctx.fetchFn, base, jobId, before);
    } catch (err) {
      if (err instanceof PollDeadlineError) {
        io.err(timeoutMessage(jobId, options.timeoutSec as number));
        return 1;
      }
      // Only a transient transport failure is retried — a real server error (bad status,
      // malformed body) means retrying would just fail the same way.
      if (err instanceof CliUnreachableError && pollFailures < MAX_POLL_RETRIES) {
        pollFailures++;
        if (pollFailures === 1) io.err(`sideclaw: poll failed (${err.message}) — retrying…\n`);
        await wait(Math.min(POLL_RETRY_BASE_MS * 2 ** (pollFailures - 1), POLL_RETRY_CAP_MS));
        continue;
      }
      throw err;
    }
    if (pollFailures > 0) {
      io.err(`sideclaw: poll recovered after ${pollFailures} failed attempt(s)\n`);
      pollFailures = 0;
    }

    // Re-check the deadline after the fetch resolves: a slow poll that only returns once
    // the deadline has already passed must not be accepted as the result, terminal or not.
    const after = deadline();
    if (after !== undefined && Date.now() >= after) {
      io.err(timeoutMessage(jobId, options.timeoutSec as number));
      return 1;
    }

    if (showProgress && (job.status === "pending" || job.status === "running")) {
      const sig = progressSig(job);
      if (sig !== lastSig || job.status !== lastStatus) {
        lastSig = sig;
        lastStatus = job.status;
        io.err(`${progressLine(job)}\n`);
      }
    }
    if (isTerminal(job.status)) {
      if (job.status !== "done" && job.error !== null) {
        io.err(`sideclaw: job ${job.id} ${job.status}: ${job.error}\n`);
      }
      if (options.json) io.out(`${JSON.stringify(job.result, null, 2)}\n`);
      else io.out(`${renderResult(job.result)}\n`);
      return exitCodeFor(job.status, job.error);
    }
    await wait(POLL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

// ── Readable rendering for the inspect commands ──────────────────────────────────

function renderJob(job: JobView): string {
  const lines = [`${job.id}  ${job.tool}  ${job.status}  ${formatDuration(job.elapsedMs)}`];
  if (job.progress !== null) {
    lines.push(`turns=${job.progress.turns} lastAction=${job.progress.lastAction}`);
  }
  if (job.error !== null) lines.push(`error: ${job.error}`);
  if (job.status === "done" && job.result !== null && job.result !== undefined) {
    lines.push("", renderResult(job.result));
  }
  return lines.join("\n");
}

function renderJobs(jobs: JobView[]): string {
  if (jobs.length === 0) return "(no jobs)";
  return jobs
    .map((j) => `${j.id}  ${j.tool}  ${j.status}  ${formatDuration(j.elapsedMs)}`)
    .join("\n");
}

function renderHealth(data: Record<string, unknown>): string {
  const lines = [
    `ok: ${data.ok === true ? "yes" : "no"}`,
    `running: ${String(data.running ?? 0)}  pending: ${String(data.pending ?? 0)}`,
    `failedLastHour: ${String(data.failedLastHour ?? 0)}  interruptedLastHour: ${String(data.interruptedLastHour ?? 0)}`,
  ];
  if (data.draining === true) lines.push("draining: yes");
  if (Array.isArray(data.warnings) && data.warnings.length > 0) {
    lines.push(`warnings (${data.warnings.length}):`);
    for (const warning of data.warnings) lines.push(`  - ${String(warning)}`);
  }
  return lines.join("\n");
}

function renderRouting(data: unknown): string {
  const routes =
    (data as { routes?: Record<string, { model?: string; backend?: string }> }).routes ?? {};
  return Object.entries(routes)
    .map(([name, route]) => `${name}: ${route.model ?? "?"} (${route.backend ?? "?"})`)
    .join("\n");
}

function renderPolicy(data: unknown): string {
  const d = data as {
    roots?: string[];
    rules?: Record<string, { ceiling?: string; sensitive?: boolean }>;
  };
  const lines = ["roots:"];
  for (const root of d.roots ?? []) lines.push(`  ${root}`);
  lines.push("rules:");
  for (const [repo, rule] of Object.entries(d.rules ?? {})) {
    lines.push(`  ${repo}: ${rule.ceiling ?? "?"}${rule.sensitive === true ? " (sensitive)" : ""}`);
  }
  return lines.join("\n");
}

// ── Help ─────────────────────────────────────────────────────────────────────────

const USAGE = `sideclaw — plain HTTP client for the sideclaw job server

Usage:
  sideclaw dispatch [flags] <brief...>        hand one episode to a repo
  sideclaw check [--repo R] [--commands "a,b"]   run validation in a repo
  sideclaw review [--repo R] [--scope S | --pr N | --branch B]   multi-angle review
  sideclaw jobs [--running]                   list recent jobs
  sideclaw status <jobId>                     one-shot job state
  sideclaw wait <jobId>                       block until a job reaches a terminal state
  sideclaw cancel <jobId>                     cancel a pending/running job
  sideclaw routing                            the model/backend table (GET /api/routing)
  sideclaw policy                             the dispatch repo policy (GET /api/dispatch-policy)
  sideclaw health                             queue health (GET /api/jobs/health)

Global flags (any subcommand):
  --json          emit only JSON on stdout, nothing else
  --no-wait       submit and print the jobId, exit 0 (dispatch/check/review)
  --quiet         suppress the progress lines on stderr
  --timeout <s>   stop waiting after N seconds (default: no ceiling)
  -h, --help      show help

Exit codes:
  0 job done · 1 job failed/interrupted/cancelled · 2 usage error or policy refusal · 3 server unreachable
`;

const DISPATCH_HELP = `sideclaw dispatch [flags] <brief...>

Flags:
  --repo <name|path>    repo to run in: a bare name under a dispatch root, or an absolute
                        path (default: the git root of the current directory)
  --tier <tier>         investigate | author | implement (default investigate)
  --workspace <ws>      worktree | in-place (default worktree, implement tier only)
  --model <id>          model override (e.g. claude-opus-5[1m])
  --context <text|@file>  raw supporting material, passed as data (leading @ reads a file)
  --sensitive           mark the repo secret-bearing; the server refuses this outside the
                        investigate tier — the CLI does not validate it client-side
`;

const CHECK_HELP = `sideclaw check [--repo <name|path>] [--commands "cmd1,cmd2"]

  --commands is a comma-separated list run verbatim (skips ecosystem discovery).
`;

const REVIEW_HELP = `sideclaw review [--repo <name|path>] [--scope S | --pr N | --branch B]

  --scope, --pr and --branch are mutually exclusive: --scope reviews local state,
  --pr/--branch review a ref fetched from origin.
`;

function helpText(topic: string | undefined): string {
  if (topic === "dispatch") return DISPATCH_HELP;
  if (topic === "check") return CHECK_HELP;
  if (topic === "review") return REVIEW_HELP;
  return USAGE;
}

// ── Entry point ──────────────────────────────────────────────────────────────────

function gitRoot(cwd: string): string | null {
  const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return null;
  const out = new TextDecoder().decode(proc.stdout).trim();
  return out.length > 0 ? out : null;
}

if (import.meta.main) {
  process.exitCode = await run(
    process.argv.slice(2),
    { fetchFn: fetch, gitRoot, cwd: process.cwd(), env: process.env },
    {
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    },
  );
}
