import type { JobRecord } from "./types.ts";
import type { ProgressSink } from "./store.ts";
import { runCheck } from "./handlers/check.ts";
import { runReview } from "./handlers/review.ts";
import { runExcalidrawDiagram } from "./handlers/excalidraw-diagram.ts";

/** Dispatch a job to its tool handler. Returns the typed result, or throws on
 *  failure — the store turns a throw into `status: "failed"` with the message.
 *  `onProgress` persists the worker's live activity (turns / last action / idle). */
export function executeJob(job: JobRecord, onProgress: ProgressSink): Promise<unknown> {
  switch (job.tool) {
    case "check":
      return runCheck(job.params, onProgress);
    case "review":
      return runReview(job.params, onProgress);
    case "excalidraw_diagram":
      return runExcalidrawDiagram(job.params, onProgress);
    default: {
      const exhaustive: never = job.tool;
      throw new Error(`unknown job tool: ${String(exhaustive)}`);
    }
  }
}
