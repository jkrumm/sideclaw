// Shared types for the async job system.
//
// Long-running MCP tools (check / review) no longer block
// the MCP call. They submit a job to the always-on HTTP server (LaunchAgent),
// which executes it in the background and persists state to bun:sqlite. The
// orchestrating agent polls `job_status` / `job_wait` until the job reaches a
// terminal state. See server/jobs/store.ts for the durable queue.

/** Tools that run as background jobs. Each maps to a handler in server/jobs/handlers/. */
export type JobTool =
  | "check"
  | "review"
  | "excalidraw_diagram"
  | "dispatch"
  | "overview"
  | "narrative";

// Not exported — nothing outside this file needs the raw list, only the `isJobTool` guard
// built from it (fallow flagged the export itself as consumer-less; the guard is the public
// surface, this backs it).
const JOB_TOOLS: readonly JobTool[] = [
  "check",
  "review",
  "excalidraw_diagram",
  "dispatch",
  "overview",
  "narrative",
];

export function isJobTool(value: string): value is JobTool {
  return (JOB_TOOLS as readonly string[]).includes(value);
}

/**
 * Job lifecycle:
 *   pending → running → done | failed
 *   pending → cancelled              (POST /api/jobs/:id/cancel: never ran)
 *   running → cancelled              (POST /api/jobs/:id/cancel: worker SIGTERMed)
 *   running → pending                (restart recovery: check/overview/narrative/review, once)
 *   running → interrupted            (restart recovery: everything else, or a 2nd interruption)
 *
 * `pending` jobs are admitted but waiting for a concurrency slot. `interrupted`
 * is terminal and means the HTTP server restarted while the job was in flight —
 * the worker subprocess died with it, so the result is unrecoverable. See
 * `recoveryStatusFor` in store.ts for which tools get the one re-run. `cancelled`
 * is terminal and means a caller explicitly asked for it via `cancelJob` — it is
 * never counted as a failure (`failedLastHour` in `jobHealth()` only counts `failed`).
 *
 * A `running` row whose worker was killed by a SIGTERM/SIGINT drain (`server/lib/shutdown.ts`)
 * is deliberately left at `running` rather than transitioned to `failed` — `execute()`'s catch
 * block in store.ts skips `finish()` for exactly the jobs `terminateActiveSessions()` just
 * SIGTERMed (tracked via `markDrainKilled`, not merely "draining is true"), so the row reaches
 * the next boot exactly as if the process had crashed, and goes through the same
 * `pending`/`interrupted` reconciliation above instead of being counted as a real failure. A
 * genuinely unrelated failure landing in the same drain window still gets written `failed`. A
 * single-job cancel (`cancelJob`'s persisted `cancelRequestedAt`, distinct from `drainKilledIds`
 * — see `JobRecord.cancelRequestedAt`) gets the analogous treatment: the same SIGTERM'd
 * subprocess throwing is recognized as a deliberate cancel, not a real failure, and lands
 * `cancelled` instead of `failed`. Persisted (not just in-process) so a server restart between
 * the SIGTERM and `execute()`'s catch still lands the row `cancelled` on the next boot
 * (`recover()`) instead of silently resuming a job an operator asked to stop.
 */
export type JobStatus = "pending" | "running" | "done" | "failed" | "interrupted" | "cancelled";

// Not exported — same reasoning as JOB_TOOLS above: `isTerminal` is the public surface.
const TERMINAL_STATUSES: readonly JobStatus[] = ["done", "failed", "interrupted", "cancelled"];

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
  /** Execution attempts — 1 for a normal run, 2 after a boot-recovery re-queue. */
  attempts: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /**
   * Set by `cancelJob` (`server/jobs/store.ts`) the instant a `POST /api/jobs/:id/cancel` is
   * accepted for a `running` job, BEFORE the SIGTERM (`terminateSessionsForJob`) — persisted so
   * the intent survives a server restart in the gap between that signal and `execute()`'s catch
   * observing the killed worker's promise reject. `recover()` checks this on every `running` row
   * at boot and lands it `cancelled` directly, bypassing `REQUEUE_ON_RECOVER`'s ordinary
   * re-queue entirely — a cancel must never be silently resumed. Null otherwise; never cleared
   * once set (even if the job wins the race and finishes normally — see `execute()`'s success
   * path), so it stays a true historical record of "cancellation was asked for this job". */
  cancelRequestedAt: number | null;
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
  /**
   * True once `cancelJob` has accepted a cancel for this job (derived from
   * `JobRecord.cancelRequestedAt`, never a separate in-process flag) — set as soon as the
   * request lands, whether or not the `cancelled` transition has landed yet. `undefined`
   * (omitted) when no cancel was ever requested.
   */
  cancelRequested?: boolean;
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
    cancelRequested: job.cancelRequestedAt !== null ? true : undefined,
  };
}
