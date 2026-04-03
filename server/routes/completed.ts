import { Elysia } from "elysia";
import { getCompleted } from "../lib/db";

export const completedRoutes = new Elysia({ prefix: "/api" }).get(
  "/completed-tasks",
  ({ query, set }) => {
    const path = query.path;
    if (!path) {
      set.status = 400;
      return { ok: false, error: "Missing path query parameter" } as const;
    }

    const tasks = getCompleted(path);
    return { ok: true, data: tasks } as const;
  },
);
