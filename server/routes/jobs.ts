import { Elysia, t } from "elysia";
import {
  backendFallbacksLastHour,
  ROUTE_STREAK_LIMIT,
  routeFailureStreaks,
} from "../mcp/session-runner.ts";
import { createJob, getJob, jobHealth, listJobs, queueStats } from "../jobs/store.ts";
import { isJobTool } from "../jobs/types.ts";
import { DEFAULT_DISPATCH_TIER, resolveDispatchTarget } from "../lib/dispatch-policy.ts";

// HTTP surface for the async job system. The MCP tools are thin clients of these
// routes (server/mcp/job-client.ts). Hosted in the always-on HTTP server so jobs
// outlive the ephemeral MCP process. See server/jobs/store.ts.

export const jobsRoutes = new Elysia({ prefix: "/api/jobs" })
  // Submit a job — returns immediately with the job id. Execution starts when a
  // concurrency slot is free; poll GET /:id (or the MCP job_wait) for the result.
  .post(
    "/",
    ({ body, set }) => {
      if (!isJobTool(body.tool)) {
        set.status = 400;
        return { ok: false as const, error: `unknown tool: ${body.tool}` };
      }
      // Same check `runDispatch` runs (server/jobs/handlers/dispatch.ts), applied here too so
      // a refused repo/tier never even creates a job row. The handler's copy stays regardless —
      // the MCP client, and any future submitter, must not be able to reach execution by
      // skipping this route. Only engages for `dispatch`, and only when `cwd`/`tier` parse as
      // plain strings — anything else falls through to the handler's own zod validation, whose
      // "invalid params" error shape is out of scope here.
      if (body.tool === "dispatch") {
        const params = body.params ?? {};
        const cwd = params.cwd;
        const tierRaw = "tier" in params ? params.tier : DEFAULT_DISPATCH_TIER;
        if (typeof cwd === "string" && typeof tierRaw === "string") {
          const decision = resolveDispatchTarget({ cwd, tier: tierRaw });
          if (!decision.ok) {
            set.status = 400;
            return { ok: false as const, error: `dispatch refused: ${decision.reason}` };
          }
        }
      }
      const job = createJob(body.tool, body.params ?? {});
      return { ok: true as const, job };
    },
    {
      body: t.Object({
        tool: t.String(),
        params: t.Optional(t.Record(t.String(), t.Unknown())),
      }),
    },
  )

  // List recent jobs + queue depth (for monitoring / a future dashboard panel).
  .get("/", () => ({ ok: true as const, jobs: listJobs(), stats: queueStats() }))

  // Queue health for the devhost heartbeat: `ok` is false when ≥3 jobs failed in the last
  // hour or the oldest pending job has waited >15 min. Static route, so it is registered
  // before `/:id` — never resolved as a job named "health".
  //
  // `routeStreaks`/`degradedRoutes`/`warnings` are reported, never enforced, same as
  // `backendFallbacks` above them — a route stuck on consecutive failures (e.g. the IU
  // gateway refusing every `check@iu/glm-5.3-flash` attempt) is a WARN a human should look
  // at, not a page. `ok` above stays computed from `evaluateJobHealth` alone.
  .get("/health", () => {
    const health = jobHealth();
    const backendFallbacks = backendFallbacksLastHour();
    const streaks = routeFailureStreaks();
    const degradedRoutes = Object.entries(streaks)
      .filter(([, count]) => count >= ROUTE_STREAK_LIMIT)
      .map(([route]) => route);
    const warnings: string[] = degradedRoutes.map(
      (route) => `route ${route} failed ${streaks[route]} in a row`,
    );
    if (backendFallbacks.count > 0) {
      const reasons = Object.entries(backendFallbacks.reasons)
        .map(([reason, count]) => `${reason}×${count}`)
        .join(", ");
      warnings.push(`${backendFallbacks.count} backend fallback(s) in the last hour: ${reasons}`);
    }
    return {
      ...health,
      backendFallbacks,
      routeStreaks: streaks,
      degradedRoutes,
      warnings,
    };
  })

  // Poll a single job's state. `job.status` terminal ⇒ `result` or `error` is set.
  .get("/:id", ({ params, set }) => {
    const job = getJob(params.id);
    if (!job) {
      set.status = 404;
      return { ok: false as const, error: "job not found" };
    }
    return { ok: true as const, job };
  });
