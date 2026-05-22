import { Elysia, t } from "elysia";
import { createJob, getJob, listJobs, queueStats } from "../jobs/store.ts";
import { isJobTool } from "../jobs/types.ts";

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

  // Poll a single job's state. `job.status` terminal ⇒ `result` or `error` is set.
  .get("/:id", ({ params, set }) => {
    const job = getJob(params.id);
    if (!job) {
      set.status = 404;
      return { ok: false as const, error: "job not found" };
    }
    return { ok: true as const, job };
  });
