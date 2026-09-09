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
import { dispatchPolicyRoutes } from "./routes/dispatch-policy";
import { dispatchSchemaRoutes } from "./routes/dispatch-schema";
import { shutdownRoutes } from "./routes/shutdown";
import { sweepStaleWorktrees } from "./jobs/handlers/dispatch-git.ts";
import { jobsRoutes } from "./routes/jobs";
import {
  initJobStore,
  markDrainCompleted,
  markDrainKilled,
  queueStats,
  setDraining,
} from "./jobs/store";
import { executeJob } from "./jobs/executor";
import { pushOverviewToArgo } from "./lib/argo-push.ts";
import { activeSessionCount, terminateActiveSessions } from "./mcp/session-runner.ts";
import { setProcessKind } from "./lib/process-context.ts";
import { logRoutingOverrides, logStaleQuotaEnvVars } from "./lib/routing.ts";
import { logDispatchPolicy } from "./lib/dispatch-policy.ts";
import {
  createShutdownController,
  httpShutdownParams,
  registerShutdownTrigger,
  SIGNAL_DRAIN_GRACE_MS,
  type ShutdownMode,
  type ShutdownOrigin,
} from "./lib/shutdown.ts";

// Must run before any job handler launches a session — session-runner.ts reads this per
// call (see process-context.ts) to tag its logs `source: "app"` instead of the "mcp" default,
// since every job (check/review/dispatch/overview/narrative) actually runs its worker sessions
// in THIS process, not the MCP one.
setProcessKind("app");
logRoutingOverrides(logger);
logStaleQuotaEnvVars(logger);
logDispatchPolicy(logger);

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
  .use(routingRoutes)
  .use(dispatchPolicyRoutes)
  .use(dispatchSchemaRoutes)
  .use(shutdownRoutes);

// The filesystem half of startup recovery, and it has to finish before initJobStore below
// re-promotes a surviving `pending` job — sweepStaleWorktrees()'s own safety argument is
// "no episode of this process is in flight yet", which the previous unawaited fire-and-forget
// no longer guaranteed once job promotion could win the race. A dispatch episode killed with
// the process never runs its teardown, and what it leaves behind is not confined to
// sideclaw's own state dir — the worktree is registered, and its branch created, inside the
// LIVE repo.
await sweepStaleWorktrees().catch((err: unknown) => {
  logger.warn({ event: "dispatch.worktree_sweep_failed", error: String(err) }, "sweep failed");
});

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

// One drain state machine, two triggers, each with its own window (see lib/shutdown.ts's
// two-window note for the "why"):
//
//   - HTTP-initiated: `POST /api/shutdown` (server/routes/shutdown.ts, wired below via
//     registerShutdownTrigger) is what `make reload` actually calls now. The process asks
//     itself to exit, so launchd's ExitTimeOut never engages — this path gets the long
//     `HTTP_DRAIN_GRACE_MS` window.
//   - Signal-initiated: a real SIGTERM (reboot, logout, launchd itself, or `make reload`'s own
//     fallback when the HTTP endpoint doesn't answer) or SIGINT (a real forced-abort signal).
//     Here launchd IS waiting, hard-capped at 60s regardless of the plist, so a real signal gets
//     the short `SIGNAL_DRAIN_GRACE_MS` window instead. `POST /api/shutdown?force=1`'s
//     in-process equivalent is NOT a real signal — it's `origin: "http"`, `mode: "forced"` (see
//     below and lib/shutdown.ts's `ShutdownOrigin`/`ShutdownMode` types) — it only shares
//     `mode: "forced"`'s immediate-abort behavior with a real SIGINT, never its origin, so the
//     shutdown log and the escalation logic can each tell which one actually happened.
//
// Worker sessions have no checkpoint — a `claude -p` run is atomic from the job's point of view
// — so a drain buys a job time to actually finish, not just "seconds from finishing". Whatever
// is still running after the grace period is terminated and exits with the process; a
// drain-killed job's row is left `running` for the next boot's ordinary crash-recovery to
// reconcile (store.ts `execute()`/`recover()`) rather than written `failed` here. KeepAlive
// brings the server straight back. The two grace constants, `SHUTDOWN_FLUSH_MS`, their sizing
// rationale, and the drain state machine itself live in lib/shutdown.ts (kept out of this
// module so they're importable — and unit-testable with fake deps/clock — without pulling in
// this file's own `app.listen()` side effect).
//
// A forced request (`mode: "forced"` — `force=1`/`force=true` over HTTP, or a real SIGINT), not
// the graceful default, carries "abandon now": on the real-signal path, SIGKILL is not
// catchable, so it would skip this very handler and `terminateActiveSessions()` would never run
// — the `claude -p` children have no process group detachment and no parent-death signal, so
// they'd become orphans that keep writing/committing in their worktree after the reload believed
// it had stopped them. SIGINT hits the same handler instead, just with a zero-length grace
// period. SIGINT is not otherwise wired in this process (no readline/TTY prompt to interrupt), so
// reusing it here doesn't shadow anything.
const shutdownController = createShutdownController({
  terminateActiveSessions,
  activeSessionCount,
  queueStats: () => ({ running: queueStats().running }),
  setDraining,
  markDrainKilled,
  markDrainCompleted,
  log: (level, fields, msg) => logger[level](fields, msg),
  exit: (code) => process.exit(code),
  now: () => Date.now(),
  scheduleFlush: (cb, ms) => setTimeout(cb, ms),
});

// The controller decides WHEN a drain is over; this interval only decides HOW OFTEN to ask.
// Started lazily (only once a drain is actually in progress, never for an immediate
// finish/forced-abort) and torn down as soon as `isActive()` goes false. Two different call
// sites can observe that: a normal `tick()` inside the interval (the common case — the drain
// either empties the queue or hits its deadline while polling), OR `onSignal` itself right
// after `begin()` returns, for the case `tick()` never gets a chance to run at all — a SIGINT
// arriving mid-drain finishes the controller SYNCHRONOUSLY inside `begin()` (escalation, see
// `createShutdownController`'s doc comment), so without this second check the existing interval
// would sit until its own next 500ms tick to notice `isActive()` had already gone false and
// clear itself — one harmless but avoidable empty tick.
let drainPoll: ReturnType<typeof setInterval> | null = null;
function onSignal(origin: ShutdownOrigin, mode: ShutdownMode, graceMs: number): void {
  shutdownController.begin(origin, mode, graceMs);
  if (shutdownController.isActive()) {
    if (drainPoll === null) {
      drainPoll = setInterval(() => {
        shutdownController.tick();
        if (!shutdownController.isActive() && drainPoll !== null) {
          clearInterval(drainPoll);
          drainPoll = null;
        }
      }, 500);
    }
  } else if (drainPoll !== null) {
    clearInterval(drainPoll);
    drainPoll = null;
  }
}

process.on("SIGTERM", () => onSignal("signal", "graceful", SIGNAL_DRAIN_GRACE_MS));
process.on("SIGINT", () => onSignal("signal", "forced", 0));

// The HTTP half of the same drain: POST /api/shutdown (server/routes/shutdown.ts) calls this
// through server/lib/shutdown.ts's registration slot rather than importing anything from this
// module directly — see that file's "HTTP-triggered self-shutdown" section for why a route
// can't just hold `onSignal`/`shutdownController` itself. `running` is read BEFORE `onSignal`
// runs so the response reports the queue depth at the moment the request arrived, not after the
// (synchronous, but still control-flow-shifting) drain decision. The `force` → `{ origin, mode,
// graceMs }` mapping itself lives in `httpShutdownParams` (lib/shutdown.ts), not inline here, so
// it's unit-testable independent of this file's module-scope side effects.
registerShutdownTrigger((force) => {
  const { running } = queueStats();
  const { origin, mode, graceMs } = httpShutdownParams(force);
  onSignal(origin, mode, graceMs);
  return { running };
});

export type App = typeof app;
