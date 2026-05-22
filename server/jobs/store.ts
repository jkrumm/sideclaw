import { Database } from "bun:sqlite";
import { appLogger as logger } from "../logger.ts";
import { type JobRecord, type JobStatus, type JobTool, type JobView, toJobView } from "./types.ts";

// ── Durable job queue (bun:sqlite) ───────────────────────────────────────────
//
// Hosted in the always-on HTTP server (LaunchAgent), NOT the ephemeral MCP
// process. Jobs survive `/mcp` reconnects (the MCP server dying doesn't touch
// this process) and HTTP-server restarts (state is persisted to disk; in-flight
// jobs are reconciled to `interrupted` on boot since their worker subprocess
// died with the previous process).
//
// A separate db file from /tmp/sideclaw.db: that one DROPs its table on every
// startup (ephemeral completed_tasks). Jobs must persist across process restarts
// within a /tmp lifetime, so they get their own file and CREATE TABLE IF NOT EXISTS.

const DB_PATH = process.env.SIDECLAW_JOBS_DB ?? "/tmp/sideclaw-jobs.db";

// Global ceiling on concurrently-running jobs. Kept low: workers route through a
// single-backend Kimi-K2.6 bridge that 429s under burst, and `review` itself
// fans out to ANGLE_CONCURRENCY (3) inner sessions per job. Excess submissions
// wait as `pending` and promote as slots free — this is admission control that
// stops an agent firing N parallel implements from stampeding the bridge.
const MAX_CONCURRENT = parseInt(process.env.SIDECLAW_JOB_CONCURRENCY ?? "3", 10);

// Retention: keep terminal jobs queryable for a while after they finish, then GC.
const PRUNE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TERMINAL_ROWS = 200;

/** Executes a job to completion. Returns the typed result, or throws on failure. */
export type JobExecutor = (job: JobRecord) => Promise<unknown>;

interface JobRow {
  id: string;
  tool: string;
  params: string;
  status: string;
  result: string | null;
  error: string | null;
  attempts: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
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
    attempts    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    started_at  INTEGER,
    finished_at INTEGER
  )
`);
db.run("CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at)");

// In-memory mirror of which jobs are actively executing in THIS process. The DB
// `status` column is the source of truth for persistence; this set drives the
// concurrency gate cheaply without re-querying on every promotion tick.
const runningIds = new Set<string>();

let executor: JobExecutor | null = null;

// ── Row mapping ──────────────────────────────────────────────────────────────

function rowToRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    tool: row.tool as JobTool,
    params: JSON.parse(row.params) as Record<string, unknown>,
    status: row.status as JobStatus,
    result: row.result === null ? null : JSON.parse(row.result),
    error: row.error,
    attempts: row.attempts,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function fetchRow(id: string): JobRow | null {
  return db.query<JobRow, [string]>("SELECT * FROM jobs WHERE id = ?").get(id) ?? null;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Wire the executor and run startup recovery + prune. Call once at HTTP server boot. */
export function initJobStore(opts: { executor: JobExecutor }): void {
  executor = opts.executor;
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

export function listJobs(limit = 50): JobView[] {
  const rows = db
    .query<JobRow, [number]>("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?")
    .all(limit);
  return rows.map((r) => toJobView(rowToRecord(r)));
}

/** Snapshot of queue depth — for monitoring/logging. */
export function queueStats(): { running: number; pending: number; max: number } {
  const pending =
    db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'").get()
      ?.n ?? 0;
  return { running: runningIds.size, pending, max: MAX_CONCURRENT };
}

// ── Scheduler ────────────────────────────────────────────────────────────────

/** Promote pending jobs to running while concurrency slots remain. */
function promote(): void {
  if (!executor) return;
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
    const result = await exec(job);
    finish(job.id, "done", { result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finish(job.id, "failed", { error: message });
  }
}

function finish(
  id: string,
  status: Extract<JobStatus, "done" | "failed">,
  outcome: { result?: unknown; error?: string },
): void {
  const now = Date.now();
  db.run("UPDATE jobs SET status = ?, result = ?, error = ?, finished_at = ? WHERE id = ?", [
    status,
    outcome.result === undefined ? null : JSON.stringify(outcome.result),
    outcome.error ?? null,
    now,
    id,
  ]);
  runningIds.delete(id);
  logger.info(
    { event: status === "done" ? "job.done" : "job.fail", jobId: id, error: outcome.error },
    `job ${status}`,
  );
  prune();
  promote();
}

// ── Recovery & retention ─────────────────────────────────────────────────────

/** On boot, any `running` row is a leftover from a dead process — its worker
 *  subprocess is gone, so the result is unrecoverable. Mark it `interrupted`.
 *  `pending` rows never started; leave them to be promoted. */
function recover(): void {
  const now = Date.now();
  const res = db.run(
    "UPDATE jobs SET status = 'interrupted', error = 'HTTP server restarted while job was running', finished_at = ? WHERE status = 'running'",
    [now],
  );
  const interrupted = res.changes;
  const pending =
    db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'").get()
      ?.n ?? 0;
  if (interrupted > 0 || pending > 0) {
    logger.info(
      { event: "job.recover", interrupted, requeued: pending },
      "job recovery on startup",
    );
  }
}

function prune(): void {
  const cutoff = Date.now() - PRUNE_TTL_MS;
  db.run(
    "DELETE FROM jobs WHERE status IN ('done','failed','interrupted') AND finished_at IS NOT NULL AND finished_at < ?",
    [cutoff],
  );
  // Hard cap on retained terminal rows (keep newest).
  db.run(
    `DELETE FROM jobs WHERE status IN ('done','failed','interrupted') AND id NOT IN (
       SELECT id FROM jobs WHERE status IN ('done','failed','interrupted')
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
    attempts: 0,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
  };
}
