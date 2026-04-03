import type { QueueTask } from "./parse-queue";
import { insertCompleted, markAllDone } from "./db";

// In-memory cache of last-known tasks per repo (display path → tasks)
const cache = new Map<string, QueueTask[]>();

/**
 * Compare new tasks with cached tasks. If the first task was consumed
 * (stop hook pops from top), insert it into the completed_tasks table.
 * Always updates the cache afterward.
 */
export function detectCompletion(
  repoPath: string,
  newTasks: QueueTask[],
): void {
  const oldTasks = cache.get(repoPath);
  cache.set(repoPath, newTasks);

  if (!oldTasks || oldTasks.length === 0) return;

  const firstOld = oldTasks[0];

  // STOP sentinels are control flow, not real tasks
  if (firstOld.kind === "stop") return;

  // Check if the first task was consumed (gone from the new list)
  const stillExists = newTasks.some((t) => t.content === firstOld.content);
  if (!stillExists) {
    insertCompleted(repoPath, {
      content: firstOld.content,
      preview: firstOld.preview,
      kind: firstOld.kind as "task" | "slash",
    });
  }

  // Queue empty → all work consumed, nothing left to run
  if (newTasks.length === 0) {
    markAllDone(repoPath);
  }
}

/**
 * Update cache without detection. Called from PUT /api/queue
 * so the next GET doesn't falsely detect a UI deletion as completion.
 */
export function updateCache(repoPath: string, tasks: QueueTask[]): void {
  cache.set(repoPath, tasks);
}
