import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isTerminal, type JobStatus, type JobView } from "../../jobs/types.ts";
import { getJobStatus, httpReachable, HTTP_DOWN_MESSAGE } from "../job-client.ts";
import { mcpProgressCallback } from "../session-runner.ts";

// Polling tools for the async job system. The four long tools return a jobId;
// these retrieve the eventual result. `job_wait` is the primary primitive — a
// server-friendly long-poll that blocks (with progress heartbeats) until the job
// finishes or the wait window elapses, so the agent never tight-loops and the
// 60s MCP client timeout never trips.

const POLL_INTERVAL_MS = 2000;
const DEFAULT_WAIT_MS = 50_000;
const MAX_WAIT_MS = 55_000; // stay under the MCP client's 60s request timeout

const JOB_STATE_OUTPUT = z.object({
  jobId: z.string(),
  tool: z.string(),
  status: z
    .enum(["pending", "running", "done", "failed", "interrupted"])
    .describe("pending=queued, running=executing, done/failed/interrupted=terminal."),
  stillRunning: z
    .boolean()
    .describe(
      "True while not terminal. If true after job_wait, call job_wait again with the same jobId.",
    ),
  elapsedMs: z.number().describe("Wall time so far (running) or total (terminal)."),
  result: z
    .unknown()
    .nullable()
    .describe("The tool's structured output. Present only when status is 'done'."),
  error: z
    .string()
    .nullable()
    .describe("Failure reason. Present when status is 'failed' or 'interrupted'."),
});

type JobState = z.infer<typeof JOB_STATE_OUTPUT>;

function toState(view: JobView): JobState {
  return {
    jobId: view.id,
    tool: view.tool,
    status: view.status,
    stillRunning: !isTerminal(view.status),
    elapsedMs: view.elapsedMs,
    result: view.result,
    error: view.error,
  };
}

function notFound(jobId: string) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ error: `Job not found: ${jobId}` }) },
    ],
    isError: true as const,
  };
}

function down() {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: HTTP_DOWN_MESSAGE }) }],
    isError: true as const,
  };
}

function ok(state: JobState) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(state) }],
    structuredContent: state as unknown as Record<string, unknown>,
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function registerJobTools(server: McpServer): void {
  // ── job_status — one-shot poll ───────────────────────────────────────────────
  server.registerTool(
    "job_status",
    {
      title: "Job Status (one-shot)",
      description: `Return the current state of a background job by id, without waiting. Prefer job_wait when you actually want the result — this is for a quick non-blocking peek (e.g. checking on a long implement while doing other work).

OUTPUT: \`status\` (pending/running/done/failed/interrupted) and \`stillRunning\`. When status is "done", \`result\` holds the tool's structured output; when "failed"/"interrupted", \`error\` explains why.`,
      inputSchema: {
        jobId: z.string().describe("The job id returned by check/research/implement/review."),
      },
      outputSchema: JOB_STATE_OUTPUT.shape,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ jobId }) => {
      if (!(await httpReachable())) return down();
      try {
        const view = await getJobStatus(jobId);
        return view ? ok(toState(view)) : notFound(jobId);
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        };
      }
    },
  );

  // ── job_wait — long-poll until terminal or window elapses ────────────────────
  server.registerTool(
    "job_wait",
    {
      title: "Wait for Job",
      description: `Block until a background job finishes (or the wait window elapses), then return its state. This is the normal way to consume check/research/implement/review: submit → job_wait → use result.

BEHAVIOR: polls internally and sends progress heartbeats, so it is safe for long jobs and won't trip the MCP timeout. Waits up to ~50s per call. If the job is still running when the window elapses, it returns with \`stillRunning: true\` — simply call job_wait again with the same jobId to keep waiting (loop until stillRunning is false). You may also do other work between calls.
OUTPUT: when \`status\` is "done", \`result\` holds the tool's structured output; "failed"/"interrupted" set \`error\`.`,
      inputSchema: {
        jobId: z.string().describe("The job id returned by check/research/implement/review."),
        maxWaitMs: z
          .number()
          .optional()
          .describe(
            `Max time to block this call, in ms. Default ${DEFAULT_WAIT_MS}, capped at ${MAX_WAIT_MS}.`,
          ),
      },
      outputSchema: JOB_STATE_OUTPUT.shape,
      annotations: { readOnlyHint: true, idempotentHint: false },
    },
    async ({ jobId, maxWaitMs }, extra) => {
      if (!(await httpReachable())) return down();

      const budget = Math.min(Math.max(maxWaitMs ?? DEFAULT_WAIT_MS, 1000), MAX_WAIT_MS);
      const deadline = Date.now() + budget;
      const onProgress = mcpProgressCallback(extra);

      try {
        let view = await getJobStatus(jobId);
        if (!view) return notFound(jobId);

        let tick = 0;
        while (!isTerminal(view.status as JobStatus) && Date.now() < deadline) {
          await sleep(POLL_INTERVAL_MS);
          tick++;
          onProgress?.(
            tick,
            0,
            `Job ${view.tool} ${view.status} (${Math.round(view.elapsedMs / 1000)}s elapsed)`,
          );
          view = (await getJobStatus(jobId)) ?? view;
        }
        return ok(toState(view));
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        };
      }
    },
  );
}
