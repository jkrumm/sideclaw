import type { JobRecord } from "./types.ts";
import { runCheck } from "./handlers/check.ts";
import { runResearch } from "./handlers/research.ts";
import { runImplement } from "./handlers/implement.ts";
import { runReview } from "./handlers/review.ts";

/** Dispatch a job to its tool handler. Returns the typed result, or throws on
 *  failure — the store turns a throw into `status: "failed"` with the message. */
export function executeJob(job: JobRecord): Promise<unknown> {
  switch (job.tool) {
    case "check":
      return runCheck(job.params);
    case "research":
      return runResearch(job.params);
    case "implement":
      return runImplement(job.params);
    case "review":
      return runReview(job.params);
    default: {
      const exhaustive: never = job.tool;
      throw new Error(`unknown job tool: ${String(exhaustive)}`);
    }
  }
}
