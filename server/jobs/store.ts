import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appLogger as logger } from "../logger.ts";
import { terminateSessionsForJob } from "../mcp/session-runner.ts";
import {
  isTerminal,
  type JobProgress,
  type JobRecord,
  type JobStatus,
  type JobTool,
  type JobView,
  toJobView,
} from "./types.ts";

// ── Durable job queue (bun:sqlite) ───────────────────────────────────────────
//
// Hosted in the always-on HTTP server (LaunchAgent), NOT the ephemeral MCP
// process. Jobs survive `/mcp` reconnects (the MCP server dying doesn't touch
// this process) and HTTP-server restarts (state is persisted to disk; in-flight
// jobs are reconciled to `interrupted` on boot since their worker subprocess
// died with the previous process).
//
// Jobs must persist across process restarts, so they get CREATE TABLE IF NOT
// EXISTS rather than a drop-and-recreate — outside /tmp, since macOS's periodic
// daily cleanup sweeps files there untouched for 3+ days, and WAL mode only
// bumps the base file's mtime on checkpoint, not per-write. Lives in
// ~/.local/share/sideclaw/.

const DB_PATH =
  process.env.SIDECLAW_JOBS_DB ?? join(homedir(), ".local", "share", "sideclaw", "jobs.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

// Global ceiling on concurrently-running jobs. Kept low: workers hit the IU
// unified endpoint's rate limits under burst, and `review` itself fans out to
// ANGLE_CONCURRENCY (3) inner sessions per job. Excess submissions wait as
// `pending` and promote as slots free — this is admission control that stops
// an agent firing N parallel jobs from tripping the endpoint's rate limits.
const MAX_CONCURRENT = parseInt(process.env.SIDECLAW_JOB_CONCURRENCY ?? "3", 10);

// Retention: keep terminal jobs queryable for a while after they finish, then GC.
const PRUNE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TERMINAL_ROWS = 200;

/** Persist a live progress snapshot for a running job. Passed to the executor. */
export type ProgressSink = (progress: JobProgress) => void;

/** Executes a job to completion. Returns the typed result, or throws on failure. */
export type JobExecutor = (job: JobRecord, onProgress: ProgressSink) => Promise<unknown>;

interface JobRow {
  id: string;
  tool: string;
  params: string;
  status: string;
  result: string | null;
  error: string | null;
  progress: string | null;
  attempts: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  cancel_requested_at: number | null;
  session_id: string | null;
  worktree_meta: string | null;
}

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 5000");
db.run(`
  CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,
    tool        TEXT NOT NULL,
    params      TEXT NOT NULL,
    status      TEXT NOT NULL,
    result      TEXT,
    error       TEXT,
    progress    TEXT,
    attempts    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    started_at  INTEGER,
    finished_at INTEGER
  )
`);
db.run("CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at)");

// Migration for dbs created before the `progress` column existed (the db file
// persists across restarts within a /tmp lifetime). Ignore if already present.
try {
  db.run("ALTER TABLE jobs ADD COLUMN progress TEXT");
} catch {
  /* column already exists */
}

// Migration for dbs created before `cancelJob`'s `cancel_requested_at` column existed. Same
// pattern as `progress` above — ignored if already present. Persisted (not just the in-process
// `cancelRequested` set below) so a `POST /api/jobs/:id/cancel` survives a server restart
// between the SIGTERM and `execute()`'s catch observing it: `recover()` checks this column on
// every `running` row at boot and lands it `cancelled` directly, rather than silently resuming
// a job an operator asked to stop.
try {
  db.run("ALTER TABLE jobs ADD COLUMN cancel_requested_at INTEGER");
} catch {
  /* column already exists */
}

// Migration for dbs created before boot-recovery resume support. `session_id` is the worker's
// real transcript id (`session-runner.ts`'s `onSessionId`, via `updateJobSessionId` below);
// `worktree_meta` is the dispatch handler's `DispatchWorktree`, JSON-encoded (via
// `updateJobWorktreeMeta`). Both are set only for `dispatch` — every other tool leaves them
// null for the row's whole life. Same ignore-if-present pattern as the two migrations above.
try {
  db.run("ALTER TABLE jobs ADD COLUMN session_id TEXT");
} catch {
  /* column already exists */
}
try {
  db.run("ALTER TABLE jobs ADD COLUMN worktree_meta TEXT");
} catch {
  /* column already exists */
}

// Single-row marker: written the instant a SIGTERM/SIGINT drain begins (`setDraining()`), read
// and cleared once by the NEXT process's boot. This is what lets `evaluateJobHealth` grant
// `BOOT_HEALTH_GRACE_MS` only after an orderly shutdown, not after every restart uniformly —
// see `recoveredFromDrain` below and the comment on `evaluateJobHealth`. A crash (SIGKILL, OOM,
// an unhandled fault before the signal handler runs) never reaches `setDraining()`, so it never
// writes this row, and the next boot correctly gets no grace — the exact case a blanket
// "always exempt for 5 minutes" rule was masking (a crash-looping process restarting faster
// than the grace window could ever let it expire).
db.run(`
  CREATE TABLE IF NOT EXISTS drain_completed (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    drained_at INTEGER NOT NULL
  )
`);

// In-memory mirror of which jobs are actively executing in THIS process. The DB
// `status` column is the source of truth for persistence; this set drives the
// concurrency gate cheaply without re-querying on every promotion tick.
const runningIds = new Set<string>();

let executor: JobExecutor | null = null;
/** Set on SIGTERM: a job finishing inside the grace window must not pull the next pending
 *  row into `running`, where the deadline would kill it and burn its one re-queue. Pending
 *  rows simply wait for the restarted process. */
let draining = false;

export function setDraining(): void {
  draining = true;
}

/** Records that this process ran its shutdown path to the END. Called from
 *  `server/lib/shutdown.ts`'s `finish()`, never from `setDraining()`: a marker written when the
 *  drain *starts* would also be there after a SIGKILL, an OOM or a hang mid-drain, and the next
 *  boot would grant the pending-queue health grace to exactly the crash loop the grace is
 *  supposed to expose. Reaching `finish()` is the narrowest available proof that the previous
 *  exit was orderly — it covers a grace-expiry exit too, which is still an orderly one. */
export function markDrainCompleted(): void {
  db.run("INSERT OR REPLACE INTO drain_completed (id, drained_at) VALUES (1, ?)", [Date.now()]);
}

/** Ids of jobs whose worker subprocess `terminateActiveSessions()` (`server/mcp/session-runner
 *  .ts`) has just SIGTERMed, recorded by `server/lib/shutdown.ts`'s `finish()` synchronously —
 *  before the killed subprocess's promise can settle and reach `execute()`'s catch below. Lets
 *  that catch tell a job genuinely killed by this drain from an unrelated failure landing in
 *  the same window; see the comment there. Entries are removed once consumed, so this never
 *  grows across a process's lifetime. */
const drainKilledIds = new Set<string>();

export function markDrainKilled(jobIds: string[]): void {
  for (const id of jobIds) drainKilledIds.add(id);
}

/** Fast in-process mirror of `running` jobs a caller has asked to cancel (`cancelJob`, below).
 *  The DB row's `cancel_requested_at` column is the durable, authoritative record (what
 *  `recover()` reads at boot, and what `toJobView` derives `cancelRequested` from) — this set
 *  exists only so the two hot paths below never hit sqlite: `execute()`'s catch here (a
 *  SIGTERM'd worker throwing lands the job `cancelled` instead of `failed` when its id is in
 *  this set, the single-job analogue of `drainKilledIds` above) and, via `isCancelRequested`
 *  passed as `SessionOptions.isCancelled` to every `runSession()` call, `session-runner.ts`'s
 *  retry loop, which checks it before EVERY attempt — a DB read there would mean one per retry
 *  iteration. Entries are removed once consumed: either by that catch finishing the job
 *  `cancelled`, or by the success path below when the session wins the race and completes
 *  anyway (the flag is stale at that point, not a real cancel) — `cancel_requested_at` itself is
 *  never cleared in either case, staying a true historical record. */
const cancelRequested = new Set<string>();

/** The predicate handed to `SessionOptions.isCancelled` (`server/mcp/session-runner.ts`) via
 *  each job handler — session-runner.ts must never import this module directly (this module
 *  already imports `terminateSessionsForJob` from there; the reverse would be a cycle). */
export function isCancelRequested(id: string): boolean {
  return cancelRequested.has(id);
}

let onDone: ((job: JobRecord) => void) | null = null;

/** Test-only: resets the module-singleton drain state (`draining`, `drainKilledIds`,
 *  `cancelRequested`, `runningIds`, the registered `executor`/`onDone`) AND wipes every row from
 *  the `jobs` table. Needed because `tests/setup.ts` points every test file at ONE shared
 *  sqlite file and this module is imported once for the whole `bun test` run — `draining` (and,
 *  since they were added, `drainKilledIds`/`cancelRequested`/`runningIds`) is plain module-scope
 *  state with no per-test isolation otherwise, and a test that drives a real job through
 *  `execute()` (the only way to test its catch block), or that seeds a `running` job whose fake
 *  executor deliberately never resolves, both sets that state AND leaves a row behind that would
 *  otherwise break every later test file's "empty store" assumptions (e.g. `jobHealth against an
 *  empty store` in tests/jobs-health.test.ts, which reads `runningIds.size` via `queueStats()`).
 *  No test currently depends on a job row (or an in-flight `execute()` promise) surviving across
 *  test files, so a full wipe is safe; if one ever does, it should not be using this reset. Never
 *  called from production code — there is exactly one process per real drain, and it never
 *  wants its own job table wiped. */
export function __resetForTests(): void {
  draining = false;
  drainKilledIds.clear();
  cancelRequested.clear();
  runningIds.clear();
  executor = null;
  onDone = null;
  db.run("DELETE FROM jobs");
}

/** When THIS process started. A restart — whether from a crash, a `make reload` drain, or
 *  `FORCE=1`'s forced abort — can leave a backlog of `pending` rows whose `created_at`
 *  predates the restart by nearly a full drain window (`HTTP_DRAIN_GRACE_MS`, or the shorter
 *  `SIGNAL_DRAIN_GRACE_MS` when a real signal drove it): `draining` itself always resets
 *  to `false` on a fresh process (module-scope state, not persisted), so it cannot signal "we
 *  just came back from one" the way it signals "one is in progress". `BOOT_HEALTH_GRACE_MS`
 *  below grants a grace window off this timestamp — but ONLY when `recoveredFromDrain` (below)
 *  says the previous process actually got as far as an orderly shutdown; see that comment for
 *  why a flat, unconditional grant here was the bug. */
const bootedAt = Date.now();

/** True if the `drain_completed` row (written by `markDrainCompleted()`, from the shutdown
 *  controller's `finish()`) was present when THIS process booted — i.e. the PREVIOUS process ran
 *  its shutdown path to the end before it died, whichever origin drove it (a real SIGTERM/SIGINT,
 *  or `make reload`'s self-initiated HTTP drain),
 *  as opposed to a crash (SIGKILL, OOM, an unhandled fault before the signal handler ever ran).
 *  Read once and the row deleted immediately, so a later crash-loop restart — which never calls
 *  `setDraining()` again — does not inherit a stale "yes" from an old drain days ago.
 *
 *  This exists because `BOOT_HEALTH_GRACE_MS` used to apply unconditionally after EVERY
 *  restart, keyed only on `sinceBootMs`. That masked exactly the failure mode the health route
 *  is supposed to surface: a process crash-looping faster than the grace window (5 min) can
 *  ever expire always looks freshly booted, so a real, growing `pending` backlog stayed
 *  permanently invisible behind "just restarted, give it a minute." A `pending → running`
 *  backlog explained by `promote()` legitimately refusing to advance during an orderly drain
 *  deserves the grace; a backlog explained by the process never surviving long enough to work
 *  through the queue does not — it deserves the alarm the health route exists to raise. */
const recoveredFromDrain = (() => {
  const row = db
    .query<{ drained_at: number }, []>("SELECT drained_at FROM drain_completed WHERE id = 1")
    .get();
  if (row) db.run("DELETE FROM drain_completed WHERE id = 1");
  return row !== null;
})();

/** How long after boot `evaluateJobHealth` ignores `oldestPendingAgeMs`, and only when
 *  `recoveredFromDrain` is true — long enough for the `MAX_CONCURRENT`-wide queue to work
 *  through a typical post-restart backlog from a cold start, not tied to the drain windows
 *  (that bounds how OLD a backlog can be when this process inherits it, not how fast this fresh
 *  process clears it). Without this, the first few minutes after every ordinary reload report
 *  `ok: false` for a pending job that is simply old, not wedged — the same false alarm
 *  `draining` already exists to prevent, just on the side of the restart where `draining` is no
 *  longer true to ask. */
export const BOOT_HEALTH_GRACE_MS = 5 * 60 * 1000;

/** Tools whose interrupted run is re-queued ONCE on boot (attempts 1 → 2) by re-running from
 *  scratch. All are read-only and idempotent — re-running costs tokens, never correctness.
 *  `dispatch` is deliberately absent: it has its OWN recovery path below
 *  (`dispatchRecoveryStatusFor`, applied in `recover()` before this function is ever consulted
 *  for a dispatch row) because a from-scratch re-run is only sometimes the right call — an
 *  `implement` episode may already have pushed a branch or opened a PR, and a session with a
 *  recorded `session_id` can be RESUMED in its own worktree instead of restarted.
 *  `excalidraw_diagram` writes a file and has no resume path of its own, so it stays
 *  `interrupted` for the caller to decide, same as before. */
const REQUEUE_ON_RECOVER: ReadonlySet<JobTool> = new Set<JobTool>([
  "check",
  "overview",
  "narrative",
  "review",
]);
const MAX_RECOVER_ATTEMPTS = 2;

/** Pure boot-recovery decision for a `running` row whose worker died with the previous
 *  process. Exported for tests. Never called for `dispatch` in production — see
 *  `dispatchRecoveryStatusFor` below — but left total over `JobTool` rather than narrowed,
 *  since a `dispatch` row calling this directly (as a test may, to pin the "no unconditional
 *  requeue" boundary) must still get a real, honest answer instead of a runtime guard failing. */
export function recoveryStatusFor(tool: JobTool, attempts: number): "pending" | "interrupted" {
  if (!REQUEUE_ON_RECOVER.has(tool)) return "interrupted";
  return attempts < MAX_RECOVER_ATTEMPTS ? "pending" : "interrupted";
}

/** `dispatch`'s own boot-recovery decision — three-way, unlike every other tool's binary
 *  pending/interrupted, because a dispatch row's worker may have died at one of two very
 *  different points: before it produced its first stream event (nothing has happened — no
 *  session id was ever recorded) or after (a `session_id` was captured, and the worktree it was
 *  working in is still on disk).
 *
 *  - `"resume"`: a `session_id` is recorded AND its worktree still exists on disk — the handler
 *    reopens that exact worktree and resumes the transcript (`runSession`'s `resumeSessionId`)
 *    instead of starting over, so investigation work already done is not thrown away.
 *  - `"fresh"`: no `session_id` (killed before the worker ever produced an event — nothing to
 *    resume) or the worktree is gone (e.g. deleted out from under the row by something other
 *    than this reconciliation) — re-run from scratch, same as `REQUEUE_ON_RECOVER` tools.
 *  - `"interrupted"`: `MAX_RECOVER_ATTEMPTS` already spent, resume or fresh alike — never an
 *    unbounded retry loop.
 *
 *  Pure and exported for tests; `hasSessionId`/`worktreeExists` are passed in rather than read
 *  here so the disk check (`existsSync`) stays at the one call site in `recover()`. */
export type DispatchRecoveryDecision = "resume" | "fresh" | "interrupted";

export function dispatchRecoveryStatusFor(
  attempts: number,
  hasSessionId: boolean,
  worktreeExists: boolean,
): DispatchRecoveryDecision {
  if (attempts >= MAX_RECOVER_ATTEMPTS) return "interrupted";
  return hasSessionId && worktreeExists ? "resume" : "fresh";
}

// ── Row mapping ──────────────────────────────────────────────────────────────

function rowToRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    tool: row.tool as JobTool,
    params: JSON.parse(row.params) as Record<string, unknown>,
    status: row.status as JobStatus,
    result: row.result === null ? null : JSON.parse(row.result),
    error: row.error,
    progress: row.progress === null ? null : (JSON.parse(row.progress) as JobProgress),
    attempts: row.attempts,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    cancelRequestedAt: row.cancel_requested_at,
    sessionId: row.session_id,
    worktreeMeta: row.worktree_meta === null ? null : JSON.parse(row.worktree_meta),
  };
}

function fetchRow(id: string): JobRow | null {
  return db.query<JobRow, [string]>("SELECT * FROM jobs WHERE id = ?").get(id) ?? null;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Wire the executor and run startup recovery + prune. Call once at HTTP server boot.
 *  `onDone` fires after a job's `done` row is committed (so `latestJobResult` already
 *  sees it) — the Argo push hooks in here. */
export function initJobStore(opts: {
  executor: JobExecutor;
  onDone?: (job: JobRecord) => void;
}): void {
  executor = opts.executor;
  onDone = opts.onDone ?? null;
  recover();
  prune();
  promote();
}

/** Submit a new job. Returns its id immediately; execution starts when a slot is free. */
export function createJob(tool: JobTool, params: Record<string, unknown>): JobView {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.run(
    "INSERT INTO jobs (id, tool, params, status, attempts, created_at) VALUES (?, ?, ?, 'pending', 0, ?)",
    [id, tool, JSON.stringify(params), now],
  );
  logger.info({ event: "job.create", jobId: id, tool }, "job created");
  promote();
  // Re-read so the view reflects any immediate promotion to running.
  const row = fetchRow(id);
  return toJobView(row ? rowToRecord(row) : fallbackRecord(id, tool, params, now));
}

export function getJob(id: string): JobView | null {
  const row = fetchRow(id);
  return row ? toJobView(rowToRecord(row)) : null;
}

/** Cancel one job by id (`POST /api/jobs/:id/cancel`). Unknown id → 404; already-terminal
 *  (including a previous cancel) → 409, `cancelled` is never counted toward `failedLastHour`.
 *
 *  `pending`: never ran, so it is marked `cancelled` immediately via the normal `finish()` path
 *  (log event, prune, promote — same as any other terminal transition) and returned terminal.
 *
 *  `running`: this only *requests* the cancel — `cancel_requested_at` is persisted on the row
 *  BEFORE the best-effort SIGTERM (`terminateSessionsForJob`, `server/mcp/session-runner.ts`),
 *  so the request survives a restart even if it lands in the gap before `execute()`'s catch
 *  observes the killed worker's rejected promise (`recover()` below lands such a row
 *  `cancelled` directly on the next boot). A repeat call on an already-requested `running` job
 *  is a no-op — it must never re-signal or re-arm the SIGKILL escalation timer a second time.
 *  The response reflects only the request, via the view's `cancelRequested: true` — the row
 *  itself is still `running` at this instant. */
export function cancelJob(
  id: string,
): { ok: true; job: JobView } | { ok: false; status: 404 | 409; error: string } {
  const row = fetchRow(id);
  if (!row) return { ok: false, status: 404, error: "job not found" };
  const record = rowToRecord(row);

  if (isTerminal(record.status)) {
    return { ok: false, status: 409, error: `job already ${record.status}` };
  }

  if (record.status === "pending") {
    finish(record, "cancelled", { error: "cancelled by request" });
    const updated = fetchRow(id);
    return { ok: true, job: toJobView(updated ? rowToRecord(updated) : record) };
  }

  // running, already requested — no duplicate SIGTERM/SIGKILL timer.
  if (record.cancelRequestedAt !== null) {
    return { ok: true, job: { ...toJobView(record), cancelRequested: true } };
  }

  const now = Date.now();
  db.run("UPDATE jobs SET cancel_requested_at = ? WHERE id = ?", [now, id]);
  cancelRequested.add(id);
  const signalled = terminateSessionsForJob(id);
  logger.info(
    { event: "job.cancel_requested", jobId: id, tool: record.tool, signalled },
    "job cancel requested",
  );
  return { ok: true, job: { ...toJobView(record), cancelRequested: true } };
}

export function listJobs(limit = 50): JobView[] {
  const rows = db
    .query<JobRow, [number]>("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?")
    .all(limit);
  return rows.map((r) => toJobView(rowToRecord(r)));
}

/**
 * Same query as `listJobs`, but returns the full `JobRecord` (including `params`) rather than
 * the MCP-facing `JobView`, which drops it. Added for `server/lib/agents.ts`: the agent
 * overview needs `params.cwd`/`params.tier` off dispatch jobs, which `JobView` has no field for.
 */
export function listJobRecords(limit = 50): JobRecord[] {
  const rows = db
    .query<JobRow, [number]>("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?")
    .all(limit);
  return rows.map((r) => rowToRecord(r));
}

/**
 * The newest `done` job's result for a tool, or null if none exists (or exists but has no
 * result — shouldn't happen for `done`, defensive). Added for `GET /api/overview`: it needs
 * the last completed `overview` job's cached recommendations to merge onto a fresh
 * deterministic snapshot, without re-running the LLM on every request.
 */
export function latestJobResult(tool: JobTool): { result: unknown; finishedAt: number } | null {
  const row = db
    .query<JobRow, [string]>(
      "SELECT * FROM jobs WHERE tool = ? AND status = 'done' ORDER BY finished_at DESC LIMIT 1",
    )
    .get(tool);
  if (!row || row.result === null) return null;
  return { result: JSON.parse(row.result), finishedAt: row.finished_at ?? row.created_at };
}

/** Snapshot of queue depth — for monitoring/logging. */
export function queueStats(): { running: number; pending: number; max: number } {
  const pending =
    db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'").get()
      ?.n ?? 0;
  return { running: runningIds.size, pending, max: MAX_CONCURRENT };
}

// ── Health (GET /api/jobs/health — read by dotfiles' devhost-health) ─────────

const FAILED_LAST_HOUR_LIMIT = 3;
const OLDEST_PENDING_LIMIT_MS = 15 * 60 * 1000;

export interface JobHealthStats {
  running: number;
  pending: number;
  failedLastHour: number;
  interruptedLastHour: number;
  /** Age of the oldest `pending` row, or null when nothing is queued. */
  oldestPendingAgeMs: number | null;
  lastFailure: { tool: JobTool; at: number; error: string | null } | null;
  /** True while a SIGTERM/SIGINT drain is in progress (`setDraining()` below) — `promote()`
   *  refuses new `pending → running` transitions during a drain, so the queue backs up as a
   *  direct, expected side effect of an orderly reload, not a fault. */
  draining: boolean;
  /** Milliseconds since this process started (`bootedAt` above). Purely informational unless
   *  `recoveredFromDrain` is also true — see that field and `BOOT_HEALTH_GRACE_MS`. */
  sinceBootMs: number;
  /** True if the row `setDraining()` writes to `drain_completed` was present when this process
   *  booted, i.e. the previous process reached an orderly SIGTERM/SIGINT drain before dying,
   *  as opposed to a crash. Gates `sinceBootMs`'s grace — see `BOOT_HEALTH_GRACE_MS`'s doc
   *  comment in store.ts for why an ungated grace masked a crash-looping process. */
  recoveredFromDrain: boolean;
}

export type JobHealth = JobHealthStats & { ok: boolean };

/** Pure verdict over the stats. Exported for tests. A pending job older than 15 min
 *  means the queue is wedged (the concurrency gate never freed a slot) — UNLESS a drain is in
 *  progress (the same symptom is queue latency `promote()` is deliberately imposing, not a
 *  wedge) or this process booted within `BOOT_HEALTH_GRACE_MS` of an orderly drain
 *  (`recoveredFromDrain`, the same latency, inherited from a shutdown that legitimately paused
 *  `promote()` rather than caused by a wedge) — devhost-health must not page for a reload in
 *  flight OR just finished. A restart with NO preceding orderly drain gets no such pass: that is
 *  precisely the crash-loop case where a real backlog must stay visible, not be re-exempted
 *  every time the process comes back up faster than the grace window can expire. Three failures
 *  in an hour means a worker lane is dead, not one flaky run, and that check applies regardless
 *  of either grace. */
export function evaluateJobHealth(stats: JobHealthStats): JobHealth {
  const pendingAgeExempt =
    stats.draining ||
    (stats.recoveredFromDrain && stats.sinceBootMs < BOOT_HEALTH_GRACE_MS) ||
    stats.oldestPendingAgeMs === null ||
    stats.oldestPendingAgeMs <= OLDEST_PENDING_LIMIT_MS;
  const ok = stats.failedLastHour < FAILED_LAST_HOUR_LIMIT && pendingAgeExempt;
  return { ok, ...stats };
}

export function jobHealth(now = Date.now()): JobHealth {
  const hourAgo = now - 60 * 60 * 1000;
  const count = (status: string) =>
    db
      .query<{ n: number }, [string, number]>(
        "SELECT COUNT(*) AS n FROM jobs WHERE status = ? AND finished_at >= ?",
      )
      .get(status, hourAgo)?.n ?? 0;
  const oldestPending = db
    .query<{ created_at: number }, []>(
      "SELECT created_at FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1",
    )
    .get();
  const lastFailed = db
    .query<JobRow, []>(
      "SELECT * FROM jobs WHERE status = 'failed' ORDER BY finished_at DESC LIMIT 1",
    )
    .get();
  return evaluateJobHealth({
    ...queueStats(),
    failedLastHour: count("failed"),
    interruptedLastHour: count("interrupted"),
    oldestPendingAgeMs: oldestPending ? Math.max(0, now - oldestPending.created_at) : null,
    lastFailure: lastFailed
      ? {
          tool: lastFailed.tool as JobTool,
          at: lastFailed.finished_at ?? lastFailed.created_at,
          error: lastFailed.error,
        }
      : null,
    draining,
    sinceBootMs: now - bootedAt,
    recoveredFromDrain,
  });
}

// ── Scheduler ────────────────────────────────────────────────────────────────

/** Promote pending jobs to running while concurrency slots remain — never while draining. */
function promote(): void {
  if (!executor || draining) return;
  while (runningIds.size < MAX_CONCURRENT) {
    const row = db
      .query<JobRow, []>(
        "SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1",
      )
      .get();
    if (!row) return;

    const now = Date.now();
    db.run(
      "UPDATE jobs SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ?",
      [now, row.id],
    );
    runningIds.add(row.id);
    const job = rowToRecord({
      ...row,
      status: "running",
      started_at: now,
      attempts: row.attempts + 1,
    });
    logger.info(
      { event: "job.start", jobId: job.id, tool: job.tool, ...queueStats() },
      "job started",
    );
    void execute(job);
  }
}

async function execute(job: JobRecord): Promise<void> {
  const exec = executor;
  if (!exec) return;
  try {
    const result = await exec(job, (progress) => updateProgress(job.id, progress));
    // A cancel may have been requested while this job was running but lost the race against
    // a session that was already finishing normally (`cancelJob` below) — let `done` stand,
    // same as any other successful run, and just clear the now-stale flag rather than leave
    // it around for a job id sqlite will never reuse.
    cancelRequested.delete(job.id);
    finish(job, "done", { result });
  } catch (err) {
    // A cancel was requested for this job (`cancelJob`, below → `terminateSessionsForJob`) —
    // the SIGTERM is what made this throw, whatever message a handler wrapped it in (dispatch's
    // salvage catch, for one, rewraps every error). Checked first and independent of `draining`:
    // a deliberate single-job cancel must land `cancelled`, not be swept into either the
    // drain-abandon branch below (which leaves the row `running` for next boot) or a real
    // `failed`.
    if (cancelRequested.delete(job.id)) {
      finish(job, "cancelled", { error: "cancelled by request" });
      return;
    }
    // A drain (SIGTERM/SIGINT, `server/lib/shutdown.ts`) sets `draining` before it does
    // anything else, and `promote()` above refuses every `pending → running` transition for
    // the rest of this process's life once it's set — so a `running` row seen here WHILE
    // `draining` is true can only be one that predates the drain. But `draining` alone does not
    // mean THIS job's failure was caused by it: a genuinely unrelated bug can throw at any
    // moment, including one that happens to fall inside a 40-minute drain window. `drainKilledIds`
    // (populated by `markDrainKilled`, called synchronously from `finish()` before the killed
    // subprocess's promise can settle) is the precise signal — it names exactly the jobs whose
    // worker `terminateActiveSessions()` just SIGTERMed, not merely "some job, sometime, while
    // draining was true".
    if (draining && drainKilledIds.has(job.id)) {
      // Leave the row untouched at `running` rather than writing `failed` here: the process
      // always restarts (KeepAlive) shortly after this signal, and the NEXT boot's ordinary
      // crash-recovery (`recover()`, below) already has exactly the right reconciliation for
      // "a running row whose worker died with the previous process" — requeue once for the
      // idempotent tools (`REQUEUE_ON_RECOVER`), `interrupted` for the rest
      // (`recoveryStatusFor`). Writing `failed` here instead bypasses that path entirely (the
      // row is already terminal before the restart, so `recover()` never sees it), which
      // burns the job's one-time requeue for nothing and inflates `failedLastHour` for
      // `GET /api/jobs/health` on every ordinary reload that happens to catch a job mid-flight
      // — the exact false-alarm class that route exists to avoid.
      drainKilledIds.delete(job.id);
      runningIds.delete(job.id);
      logger.warn(
        {
          event: "job.shutdown_abandoned",
          jobId: job.id,
          tool: job.tool,
          error: err instanceof Error ? err.message : String(err),
        },
        "job abandoned mid-drain — left running for next boot's crash recovery",
      );
      return;
    }
    // Either not draining, or draining but this job's own subprocess was never one
    // `terminateActiveSessions()` signaled — a real, independent failure. Report it as one:
    // masking it as "abandoned mid-drain" would hide a genuine bug behind the next reload's
    // drain window and silently discard `failedLastHour`'s only signal for it.
    const message = err instanceof Error ? err.message : String(err);
    finish(job, "failed", { error: message });
  }
}

/** Persist a running job's latest progress snapshot. Cheap, fire-and-forget from the worker stream. */
function updateProgress(id: string, progress: JobProgress): void {
  db.run("UPDATE jobs SET progress = ? WHERE id = ? AND status = 'running'", [
    JSON.stringify(progress),
    id,
  ]);
}

/** Persist the worker's real transcript session id the instant it's known (`session-runner.ts`'s
 *  `onSessionId`, threaded down through `executeJob` → `runDispatch`). `WHERE status = 'running'`
 *  guards the same race `updateProgress` above does — a late-arriving write racing a `finish()`
 *  that already landed the row terminal must not resurrect it. Only ever called for `dispatch`
 *  today, but not tool-gated here: this module has no reason to know which tools resume. */
export function updateJobSessionId(id: string, sessionId: string): void {
  db.run("UPDATE jobs SET session_id = ? WHERE id = ? AND status = 'running'", [sessionId, id]);
}

/** Persist the dispatch handler's `DispatchWorktree` the instant the worktree is created — well
 *  before the worker session even starts, so a process killed before any stream event still
 *  leaves enough on the row for `sweepStaleWorktrees()` to be told to skip it (see
 *  `protectedWorktreePaths` below), even though `recover()` will not treat that particular row
 *  as resumable without a `session_id` too (see `dispatchRecoveryStatusFor`). Stored as the full
 *  object, not just its `path` — see `JobRecord.worktreeMeta`'s doc comment for why `base` must
 *  survive a resume unchanged rather than be re-derived. */
export function updateJobWorktreeMeta(id: string, meta: Record<string, unknown>): void {
  db.run("UPDATE jobs SET worktree_meta = ? WHERE id = ? AND status = 'running'", [
    JSON.stringify(meta),
    id,
  ]);
}

/**
 * Worktree paths a `running` dispatch row still owns, read BEFORE `initJobStore`'s `recover()`
 * runs — `server/index.ts` calls this ahead of `sweepStaleWorktrees()` so the sweep can skip
 * them. A row only counts as protected once it has BOTH a `session_id` and a `worktree_meta`:
 * the same pair `dispatchRecoveryStatusFor` requires for a "resume" decision — a row with a
 * worktree but no session id yet is going to be recovered "fresh" (worktree discarded), so
 * protecting its directory from the sweep would just leave it for `discardWorktree` to remove
 * one call later instead of the sweep doing it now.
 */
export function protectedWorktreePaths(): string[] {
  const rows = db
    .query<{ worktree_meta: string }, []>(
      `SELECT worktree_meta FROM jobs
       WHERE status = 'running' AND tool = 'dispatch'
         AND session_id IS NOT NULL AND worktree_meta IS NOT NULL`,
    )
    .all();
  const paths: string[] = [];
  for (const row of rows) {
    try {
      const meta = JSON.parse(row.worktree_meta) as { path?: unknown };
      if (typeof meta.path === "string") paths.push(meta.path);
    } catch {
      /* a malformed row protects nothing rather than throwing at boot */
    }
  }
  return paths;
}

const EVENT_BY_STATUS: Record<
  Extract<JobStatus, "done" | "failed" | "cancelled">,
  "job.done" | "job.fail" | "job.cancelled"
> = {
  done: "job.done",
  failed: "job.fail",
  cancelled: "job.cancelled",
};

/** Pure computation of the `job.done`/`job.fail`/`job.cancelled` log fields. Exported so the
 *  join key (`tool` + `durationMs`, added so a duration-by-tool table no longer needs a
 *  three-way `job.start`/`job.done`/`job.fail` join by hand — see docs/deployment.md § Drain
 *  window sizing) can be tested without going through sqlite or pino. */
export function jobFinishLogFields(
  job: Pick<JobRecord, "id" | "tool" | "startedAt" | "createdAt">,
  status: Extract<JobStatus, "done" | "failed" | "cancelled">,
  outcome: { error?: string },
  now: number,
): {
  event: "job.done" | "job.fail" | "job.cancelled";
  jobId: string;
  tool: JobTool;
  durationMs: number;
  error: string | undefined;
} {
  return {
    event: EVENT_BY_STATUS[status],
    jobId: job.id,
    tool: job.tool,
    durationMs: now - (job.startedAt ?? job.createdAt),
    error: outcome.error,
  };
}

/** Job record + explicit finish reason, not just an id — `job.done`/`job.fail` need `tool` and
 *  a duration to be joinable/analyzable without a three-way log join (that's how the
 *  docs/deployment.md § Two shutdown paths, two windows table had to be built: `job.start` joined to
 *  `job.done`/`job.fail` on `jobId` alone, per-tool, by hand). */
function finish(
  job: JobRecord,
  status: Extract<JobStatus, "done" | "failed" | "cancelled">,
  outcome: { result?: unknown; error?: string },
): void {
  const now = Date.now();
  db.run("UPDATE jobs SET status = ?, result = ?, error = ?, finished_at = ? WHERE id = ?", [
    status,
    outcome.result === undefined ? null : JSON.stringify(outcome.result),
    outcome.error ?? null,
    now,
    job.id,
  ]);
  runningIds.delete(job.id);
  logger.info(jobFinishLogFields(job, status, outcome, now), `job ${status}`);
  if (status === "done" && onDone) {
    const row = fetchRow(job.id);
    if (row) {
      try {
        onDone(rowToRecord(row));
      } catch (err) {
        logger.warn({ event: "job.done_hook_failed", jobId: job.id, error: String(err) }, "hook");
      }
    }
  }
  prune();
  promote();
}

// ── Recovery & retention ─────────────────────────────────────────────────────

/** On boot, any `running` row is a leftover from a dead process — its worker
 *  subprocess is gone.
 *
 *  A row whose `cancel_requested_at` is set (`cancelJob`) is landed `cancelled` directly,
 *  BEFORE the ordinary requeue/interrupt logic below ever sees it — an operator asked for this
 *  job to stop, and the process dying between the SIGTERM and `execute()`'s catch observing it
 *  must never look like an ordinary crash-recovery candidate. Without this check a
 *  `REQUEUE_ON_RECOVER` tool (check/overview/narrative/review) would silently resume the exact
 *  job the cancel was trying to stop.
 *
 *  Otherwise, `dispatch` rows go through `dispatchRecoveryStatusFor` (below) — resume in place,
 *  re-run from scratch, or interrupted, depending on whether a `session_id` and its worktree
 *  survived. Every other tool: idempotent read-only ones (`REQUEUE_ON_RECOVER`) on their first
 *  attempt go back to `pending` and run again (attempts 1 → 2 on promotion); everything else —
 *  a second interruption, or a tool with side effects — is marked `interrupted`. `pending` rows
 *  never started; they are simply promoted. */
function recover(): void {
  const now = Date.now();
  const running = db.query<JobRow, []>("SELECT * FROM jobs WHERE status = 'running'").all();
  let interrupted = 0;
  let requeued = 0;
  let resumed = 0;
  let cancelled = 0;
  for (const row of running) {
    if (row.cancel_requested_at !== null) {
      db.run(
        "UPDATE jobs SET status = 'cancelled', error = 'cancelled by request', finished_at = ? WHERE id = ?",
        [now, row.id],
      );
      cancelled++;
      logger.info(
        { event: "job.cancelled", jobId: row.id, tool: row.tool },
        "cancel was requested before this restart — landed cancelled on boot, never resumed",
      );
      continue;
    }
    if ((row.tool as JobTool) === "dispatch") {
      const worktreePath =
        row.worktree_meta !== null
          ? ((JSON.parse(row.worktree_meta) as { path?: unknown }).path ?? null)
          : null;
      const decision = dispatchRecoveryStatusFor(
        row.attempts,
        row.session_id !== null,
        typeof worktreePath === "string" && existsSync(worktreePath),
      );
      if (decision === "interrupted") {
        db.run(
          "UPDATE jobs SET status = 'interrupted', error = 'HTTP server restarted while job was running', finished_at = ? WHERE id = ?",
          [now, row.id],
        );
        interrupted++;
        continue;
      }
      if (decision === "resume") {
        // Keep session_id/worktree_meta as-is — their presence IS the resume marker the
        // dispatch handler reads back off `job.sessionId`/`job.worktreeMeta` at promotion.
        db.run(
          "UPDATE jobs SET status = 'pending', progress = NULL, started_at = NULL, error = NULL WHERE id = ?",
          [row.id],
        );
        resumed++;
        logger.warn(
          {
            event: "job.requeue",
            jobId: row.id,
            tool: row.tool,
            attempts: row.attempts,
            resume: true,
          },
          "interrupted dispatch re-queued for resume — worktree and transcript preserved",
        );
        continue;
      }
      // "fresh" — clear both markers so the handler creates a new worktree, same as an
      // ordinary first attempt.
      db.run(
        `UPDATE jobs SET status = 'pending', progress = NULL, started_at = NULL, error = NULL,
           session_id = NULL, worktree_meta = NULL WHERE id = ?`,
        [row.id],
      );
      requeued++;
      logger.warn(
        {
          event: "job.requeue",
          jobId: row.id,
          tool: row.tool,
          attempts: row.attempts,
          resume: false,
        },
        "interrupted dispatch re-queued from scratch — no session id was ever recorded",
      );
      continue;
    }
    const next = recoveryStatusFor(row.tool as JobTool, row.attempts);
    if (next === "pending") {
      db.run(
        "UPDATE jobs SET status = 'pending', progress = NULL, started_at = NULL, error = NULL WHERE id = ?",
        [row.id],
      );
      requeued++;
      logger.warn(
        { event: "job.requeue", jobId: row.id, tool: row.tool, attempts: row.attempts },
        "interrupted job re-queued once",
      );
    } else {
      db.run(
        "UPDATE jobs SET status = 'interrupted', error = 'HTTP server restarted while job was running', finished_at = ? WHERE id = ?",
        [now, row.id],
      );
      interrupted++;
    }
  }
  const pending =
    db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'").get()
      ?.n ?? 0;
  if (interrupted > 0 || pending > 0 || cancelled > 0 || resumed > 0) {
    logger.info(
      { event: "job.recover", interrupted, requeued, resumed, cancelled, pending },
      "job recovery on startup",
    );
  }
}

function prune(): void {
  const cutoff = Date.now() - PRUNE_TTL_MS;
  db.run(
    "DELETE FROM jobs WHERE status IN ('done','failed','interrupted','cancelled') AND finished_at IS NOT NULL AND finished_at < ?",
    [cutoff],
  );
  // Hard cap on retained terminal rows (keep newest).
  db.run(
    `DELETE FROM jobs WHERE status IN ('done','failed','interrupted','cancelled') AND id NOT IN (
       SELECT id FROM jobs WHERE status IN ('done','failed','interrupted','cancelled')
       ORDER BY finished_at DESC LIMIT ?
     )`,
    [MAX_TERMINAL_ROWS],
  );
}

function fallbackRecord(
  id: string,
  tool: JobTool,
  params: Record<string, unknown>,
  now: number,
): JobRecord {
  return {
    id,
    tool,
    params,
    status: "pending",
    result: null,
    error: null,
    progress: null,
    attempts: 0,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    cancelRequestedAt: null,
    sessionId: null,
    worktreeMeta: null,
  };
}
