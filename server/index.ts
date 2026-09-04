import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { existsSync, readFileSync } from "fs";
import { appLogger as logger, cleanupLogFile } from "./logger.ts";
import { reposRoutes } from "./routes/repos";
import { notesRoutes } from "./routes/notes";
import { eventsRoutes } from "./routes/events";
import { markdownRoutes } from "./routes/markdown";
import { usageRoutes } from "./routes/usage";
import { githubRoutes } from "./routes/github";
import { diagramsRoutes } from "./routes/diagrams";
import { actionsRoutes } from "./routes/actions";
import { kioskRoute } from "./routes/kiosk";
import { sweepStaleWorktrees } from "./jobs/handlers/dispatch-git.ts";
import { jobsRoutes } from "./routes/jobs";
import { initJobStore } from "./jobs/store";
import { executeJob } from "./jobs/executor";

const isDev = !existsSync("dist/index.html");
const indexHtml = isDev ? null : readFileSync("dist/index.html", "utf-8");
const BUILD_ID = crypto.randomUUID();

await cleanupLogFile();

const SKIP_LOG_PATHS = new Set(["/health", "/api/build-id"]);

const app = new Elysia()
  .derive(() => ({ _startMs: performance.now() }))
  .onAfterHandle(({ request, set, _startMs }) => {
    const url = new URL(request.url);
    if (SKIP_LOG_PATHS.has(url.pathname)) return;
    logger.info(
      {
        event: "app.request",
        method: request.method,
        path: url.pathname,
        status: typeof set.status === "number" ? set.status : 200,
        durationMs: Math.round(performance.now() - _startMs),
      },
      "request",
    );
  })
  .onError(({ request, error, set }) => {
    const url = new URL(request.url);
    logger.error(
      {
        event: "app.request",
        method: request.method,
        path: url.pathname,
        status: typeof set.status === "number" ? set.status : 500,
        err: error,
      },
      "request error",
    );
  })
  .get("/health", () => ({ ok: true }))
  .get("/api/build-id", () => ({ buildId: BUILD_ID }))
  .use(reposRoutes)
  .use(notesRoutes)
  .use(eventsRoutes)
  .use(markdownRoutes)
  .use(usageRoutes)
  .use(githubRoutes)
  .use(diagramsRoutes)
  .use(actionsRoutes)
  .use(kioskRoute)
  .use(jobsRoutes);

// Wire the async job system: register the executor and run startup recovery
// (in-flight jobs from a previous process → interrupted; re-promote pending).
initJobStore({ executor: executeJob });

// The filesystem half of that same recovery. A dispatch episode killed with the process
// never runs its teardown, and what it leaves behind is not confined to sideclaw's own state
// dir — the worktree is registered, and its branch created, inside the LIVE repo. Not
// awaited: a slow git call must not delay the listener, and there is nothing to wait for.
void sweepStaleWorktrees().catch((err: unknown) => {
  logger.warn({ event: "dispatch.worktree_sweep_failed", error: String(err) }, "sweep failed");
});

if (!isDev) {
  app.use(staticPlugin({ assets: "dist/assets", prefix: "/assets" })).get("*", ({ set }) => {
    set.headers["content-type"] = "text/html; charset=utf-8";
    set.headers["cache-control"] = "no-cache";
    return indexHtml;
  });
}

const PORT = parseInt(process.env.PORT ?? "7705");
app.listen(PORT);

logger.info(
  { event: "app.startup", port: PORT, dev: isDev },
  isDev ? `sideclaw API running on :${PORT} (dev)` : `sideclaw running on :${PORT}`,
);

export type App = typeof app;
