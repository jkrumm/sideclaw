import type { JobRecord } from "./types.ts";
import type { ProgressSink } from "./store.ts";
import { runCheck } from "./handlers/check.ts";
import { runResearch } from "./handlers/research.ts";
import { runImplement } from "./handlers/implement.ts";
import { runReview } from "./handlers/review.ts";

/** Dispatch a job to its tool handler. Returns the typed result, or throws on
 *  failure — the store turns a throw into `status: "failed"` with the message.
 *  `onProgress` persists the worker's live activity (turns / last action / idle). */
export function executeJob(job: JobRecord, onProgress: ProgressSink): Promise<unknown> {
  switch (job.tool) {
    case "check":
      return runCheck(job.params, onProgress);
    case "research":
      return runResearch(job.params, onProgress);
    case "implement":
      return runImplement(job.params, onProgress);
    case "review":
      return runReview(job.params, onProgress);
    default: {
      const exhaustive: never = job.tool;
      throw new Error(`unknown job tool: ${String(exhaustive)}`);
    }
  }
}
