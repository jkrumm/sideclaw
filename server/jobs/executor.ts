import type { JobRecord } from "./types.ts";
import type { ProgressSink } from "./store.ts";
import { isCancelRequested, updateJobSessionId, updateJobWorktreeMeta } from "./store.ts";
import { runCheck } from "./handlers/check.ts";
import { runReview } from "./handlers/review.ts";
import { runExcalidrawDiagram } from "./handlers/excalidraw-diagram.ts";
import { runDispatch } from "./handlers/dispatch.ts";
import { runOverview } from "./handlers/overview.ts";
import { runNarrative } from "./handlers/narrative.ts";

/** Dispatch a job to its tool handler. Returns the typed result, or throws on
 *  failure — the store turns a throw into `status: "failed"` with the message.
 *  `onProgress` persists the worker's live activity (turns / last action / idle).
 *
 *  `isCancelRequested` (store.ts) is threaded down through every handler into its
 *  `runSession()` calls as `SessionOptions.isCancelled` — this is the one place that boundary
 *  crosses: `server/mcp/session-runner.ts` must never import `store.ts` directly (store.ts
 *  already imports `terminateSessionsForJob` from there; the reverse would be a cycle), so the
 *  predicate is injected here instead, same shape store.ts's own `ShutdownDeps`-style DI uses
 *  elsewhere. */
export function executeJob(job: JobRecord, onProgress: ProgressSink): Promise<unknown> {
  switch (job.tool) {
    case "check":
      return runCheck(job.params, onProgress, job.id, isCancelRequested);
    case "review":
      return runReview(job.params, onProgress, job.id, isCancelRequested);
    case "excalidraw_diagram":
      return runExcalidrawDiagram(job.params, onProgress, job.id, isCancelRequested);
    case "dispatch":
      // `job.sessionId`/`job.worktreeMeta` are non-null only when `store.ts`'s `recover()`
      // landed this row `pending` with a "resume" decision (`dispatchRecoveryStatusFor`) — a
      // fresh job (or one recovered "fresh") always starts with both null, so `resume` below is
      // undefined and `runDispatch` takes its ordinary from-scratch path. The two `on*` sinks
      // are wired unconditionally: they no-op harmlessly (`UPDATE ... WHERE status = 'running'`
      // matches nothing) if this job never gets resumed, and dispatch.ts is what decides when
      // to call them.
      return runDispatch(job.params, onProgress, job.id, isCancelRequested, {
        resume:
          job.sessionId && job.worktreeMeta
            ? { sessionId: job.sessionId, worktreeMeta: job.worktreeMeta }
            : undefined,
        onSessionId: (sessionId) => updateJobSessionId(job.id, sessionId),
        onWorktreeReady: (meta) => updateJobWorktreeMeta(job.id, meta),
      });
    case "overview":
      return runOverview(job.params, onProgress, job.id, isCancelRequested);
    case "narrative":
      return runNarrative(job.params, onProgress, job.id, isCancelRequested);
    default: {
      const exhaustive: never = job.tool;
      throw new Error(`unknown job tool: ${String(exhaustive)}`);
    }
  }
}
