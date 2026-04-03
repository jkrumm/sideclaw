import { Elysia } from "elysia";
import { join } from "path";
import { promises as fs } from "fs";
import { parseQueue, serializeQueue } from "../lib/parse-queue";
import type { QueueTask } from "../lib/parse-queue";
import { toContainerPath } from "../lib/workspace";
import { detectCompletion, updateCache } from "../lib/queue-cache";

export const queueRoutes = new Elysia({ prefix: "/api" })
  .get("/queue", async ({ query, set }) => {
    const path = query.path;
    if (!path) {
      set.status = 400;
      return { ok: false, error: "Missing path query parameter" } as const;
    }

    const queuePath = join(toContainerPath(path), "sc-queue.md");

    try {
      const raw = await Bun.file(queuePath).text();
      const tasks = parseQueue(raw);
      detectCompletion(path, tasks);
      return { ok: true, data: tasks } as const;
    } catch {
      return { ok: true, data: [] as QueueTask[] } as const;
    }
  })
  .put("/queue", async ({ query, body, set }) => {
    const path = query.path;
    if (!path) {
      set.status = 400;
      return { ok: false, error: "Missing path query parameter" } as const;
    }

    const b = body as { tasks?: QueueTask[] };
    if (!b || !Array.isArray(b.tasks)) {
      set.status = 400;
      return { ok: false, error: "Body must be { tasks: QueueTask[] }" } as const;
    }

    const queuePath = join(toContainerPath(path), "sc-queue.md");
    const tmpPath = `${queuePath}.tmp`;

    const serialized = serializeQueue(b.tasks);
    await Bun.write(tmpPath, serialized);
    await fs.rename(tmpPath, queuePath);

    // Update cache so next GET doesn't falsely detect UI deletions
    updateCache(path, b.tasks);

    return { ok: true } as const;
  });
