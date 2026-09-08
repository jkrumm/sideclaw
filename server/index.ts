import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { existsSync, readFileSync } from "fs";
import { appLogger as logger, cleanupLogFile } from "./logger.ts";
import { reposRoutes } from "./routes/repos";
import { notesRoutes } from "./routes/notes";
import { eventsRoutes } from "./routes/events";
import { markdownRoutes } from "./routes/markdown";
import { usageRoutes } from "./routes/usage";
import { diagramsRoutes } from "./routes/diagrams";
import { kioskRoute } from "./routes/kiosk";
import { agentsRoutes } from "./routes/agents";
import { routingRoutes } from "./routes/routing";
import { sweepStaleWorktrees } from "./jobs/handlers/dispatch-git.ts";
import { jobsRoutes } from "./routes/jobs";
import { initJobStore, queueStats, setDraining } from "./jobs/store";
import { executeJob } from "./jobs/executor";
import { pushOverviewToArgo } from "./lib/argo-push.ts";
import { activeSessionCount, terminateActiveSessions } from "./mcp/session-runner.ts";

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
  .use(diagramsRoutes)
  .use(kioskRoute)
  .use(jobsRoutes)
  .use(agentsRoutes)
  .use(routingRoutes);

// Wire the async job system: register the executor and run startup recovery
// (in-flight jobs from a previous process → re-queued once or interrupted; re-promote
// pending). A completed `overview` job pushes the merged overview to Argo — the hook
// fires after the `done` row is committed, so the push sees this job's result.
initJobStore({
  executor: executeJob,
  onDone: (job) => {
    if (job.tool === "overview") void pushOverviewToArgo("job");
  },
});

// The other half of that push: a 10-minute timer, so Argo's view ages out even when no
// overview job runs (a quiet fleet is a fact worth pushing too).
const ARGO_PUSH_INTERVAL_MS = 10 * 60 * 1000;
setInterval(() => void pushOverviewToArgo("timer"), ARGO_PUSH_INTERVAL_MS);

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
// Loopback only. Every consumer is local — the herdr overview pane, Hermes, the MCP child
// per session, fetch_usage.py's POST, devhost-health — and nothing here carries auth of
// its own, so a tailnet-reachable bind would be an unauthenticated job submitter one ACL
// grant away. The tailnet door is Caddy's `sideclaw.mini.jkrumm.com` block, on purpose.
const HOSTNAME = process.env.SIDECLAW_HOST ?? "127.0.0.1";
app.listen({ hostname: HOSTNAME, port: PORT });

logger.info(
  { event: "app.startup", host: HOSTNAME, port: PORT, dev: isDev },
  isDev
    ? `sideclaw API running on ${HOSTNAME}:${PORT} (dev)`
    : `sideclaw running on ${HOSTNAME}:${PORT}`,
);

// Graceful stop on SIGTERM (`make reload` → `launchctl kill SIGTERM`, or launchd itself).
// Worker sessions have no checkpoint — a `claude -p` run is atomic from the job's point of
// view — so this only buys a job that is seconds from finishing its result. Whatever is
// still running after the grace period is SIGTERMed and exits with the process; boot
// recovery then re-queues check/overview/narrative/review once (store.ts `recover`) and
// marks the rest `interrupted`. KeepAlive brings the server straight back.
const SHUTDOWN_GRACE_MS = 20_000;
let shuttingDown = false;
process.on("SIGTERM", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  setDraining();
  const { running } = queueStats();
  logger.info(
    { event: "app.shutdown", running, workers: activeSessionCount(), graceMs: SHUTDOWN_GRACE_MS },
    "SIGTERM — draining running jobs",
  );
  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  const tick = setInterval(() => {
    const left = queueStats().running;
    if (left > 0 && Date.now() < deadline) return;
    clearInterval(tick);
    const killed = terminateActiveSessions();
    logger.info(
      { event: "app.shutdown", running: left, killedWorkers: killed },
      left > 0 ? "grace period over — exiting with jobs still running" : "drained — exiting",
    );
    process.exit(0);
  }, 500);
});

export type App = typeof app;
