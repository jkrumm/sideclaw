// Shared types for the async job system.
//
// Long-running MCP tools (implement / check / research / review) no longer block
// the MCP call. They submit a job to the always-on HTTP server (LaunchAgent),
// which executes it in the background and persists state to bun:sqlite. The
// orchestrating agent polls `job_status` / `job_wait` until the job reaches a
// terminal state. See server/jobs/store.ts for the durable queue.

/** Tools that run as background jobs. Each maps to a handler in server/jobs/handlers/. */
export type JobTool = "implement" | "check" | "research" | "review";

export const JOB_TOOLS: readonly JobTool[] = ["implement", "check", "research", "review"];

export function isJobTool(value: string): value is JobTool {
  return (JOB_TOOLS as readonly string[]).includes(value);
}

/**
 * Job lifecycle:
 *   pending → running → done | failed
 *   pending/running → interrupted   (only on process restart recovery)
 *
 * `pending` jobs are admitted but waiting for a concurrency slot. `interrupted`
 * is terminal and means the HTTP server restarted while the job was in flight —
 * the worker subprocess died with it, so the result is unrecoverable.
 */
export type JobStatus = "pending" | "running" | "done" | "failed" | "interrupted";

export const TERMINAL_STATUSES: readonly JobStatus[] = ["done", "failed", "interrupted"];

export function isTerminal(status: JobStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Live progress of a running job, updated as the worker emits stream-json events.
 * Its main purpose is `lastActivityAt`: callers derive idle time from it to tell a
 * worker that is actively working from one that has wedged (no events for minutes).
 */
export interface JobProgress {
  /** Assistant turns observed so far. */
  turns: number;
  /** Short label of the worker's most recent action, e.g. "Edit store.ts". */
  lastAction: string;
  /** Epoch ms of the last worker stream event. */
  lastActivityAt: number;
}

/** A persisted job. Mirrors a row in the `jobs` table (params/result stored as JSON text). */
export interface JobRecord {
  id: string;
  tool: JobTool;
  /** Tool input as passed by the caller. Validated by the handler's input schema at execution. */
  params: Record<string, unknown>;
  status: JobStatus;
  /** Typed tool output once `status === "done"`. Null otherwise. */
  result: unknown | null;
  /** Failure message once `status === "failed" | "interrupted"`. Null otherwise. */
  error: string | null;
  /** Live progress while running; last snapshot is retained after terminal. Null until first event. */
  progress: JobProgress | null;
  /** Execution attempts (currently always 0→1; retries are a future phase). */
  attempts: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/** Public-facing view returned to MCP callers — adds derived elapsed + idle time. */
export interface JobView {
  id: string;
  tool: JobTool;
  status: JobStatus;
  result: unknown | null;
  error: string | null;
  progress: JobProgress | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Wall time so far (running) or total (terminal), in ms. */
  elapsedMs: number;
  /**
   * ms since the worker's last stream event, while running. Null when not running
   * or before the first event. A large/growing value during `running` is the wedge
   * signal — the session may be stuck rather than working.
   */
  idleMs: number | null;
}

export function toJobView(job: JobRecord): JobView {
  const end = job.finishedAt ?? Date.now();
  const start = job.startedAt ?? job.createdAt;
  const idleMs =
    job.status === "running" && job.progress
      ? Math.max(0, Date.now() - job.progress.lastActivityAt)
      : null;
  return {
    id: job.id,
    tool: job.tool,
    status: job.status,
    result: job.result,
    error: job.error,
    progress: job.progress,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedMs: Math.max(0, end - start),
    idleMs,
  };
}
