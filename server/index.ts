import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { existsSync, readFileSync } from "fs";
import { appLogger as logger, cleanupLogFile } from "./logger.ts";
import { reposRoutes } from "./routes/repos";
import { queueRoutes } from "./routes/queue";
import { notesRoutes } from "./routes/notes";
import { eventsRoutes } from "./routes/events";
import { markdownRoutes } from "./routes/markdown";
import { completedRoutes } from "./routes/completed";
import { usageRoutes } from "./routes/usage";
import { githubRoutes } from "./routes/github";
import { diagramsRoutes } from "./routes/diagrams";
import { actionsRoutes } from "./routes/actions";
import { kioskRoute } from "./routes/kiosk";

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
  .use(queueRoutes)
  .use(notesRoutes)
  .use(eventsRoutes)
  .use(markdownRoutes)
  .use(completedRoutes)
  .use(usageRoutes)
  .use(githubRoutes)
  .use(diagramsRoutes)
  .use(actionsRoutes)
  .use(kioskRoute);

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
