import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isTerminal, type JobStatus, type JobView } from "../../jobs/types.ts";
import { getJobStatus, httpReachable, HTTP_DOWN_MESSAGE } from "../job-client.ts";
import { mcpProgressCallback } from "../session-runner.ts";

// Polling tools for the async job system. The four long tools return a jobId;
// these retrieve the eventual result. `job_wait` is the primary primitive — a
// server-friendly long-poll that blocks (with progress heartbeats) until the job
// finishes or the wait window elapses, so the agent never tight-loops and the
// MCP client timeout never trips.

const POLL_INTERVAL_MS = 2000;
// Default stays under the MCP client's 60 s out-of-the-box request timeout, so a caller that
// passes nothing behaves exactly as before and never eats a hard transport abort.
export const DEFAULT_WAIT_MS = 50_000;
// The ceiling an explicit `maxWaitMs` may reach. Raising it only pays off when this server's
// entry in `~/.claude.json` carries a matching `timeout` — the client aborts the request on
// its own clock, and an abort is a hard failure where the 50 s default would have returned a
// clean `stillRunning`. The two numbers are one setting in two files; move them together.
// Worth moving: measured over 91 jobs, a `review` (p50 345 s, max 685 s) costs nine wait
// rounds at 50 s — nine model turns spent asking "done yet?" — against one at this ceiling.
// 29 min leaves a minute of headroom under a 30 min client timeout, matching `dispatch`'s own
// longest job timeout.
export const MAX_WAIT_MS = 29 * 60 * 1000;

/** Pure clamp for the `maxWaitMs` input: missing → `DEFAULT_WAIT_MS`, floored at 1000 ms (a
 *  sub-second budget would just thrash the poll loop below for no benefit), ceiled at
 *  `MAX_WAIT_MS`. Exported so the boundary — raised from 55 s to 29 min in the same change —
 *  is tested directly instead of only through a live MCP call. */
export function clampMaxWaitMs(maxWaitMs: number | undefined): number {
  return Math.min(Math.max(maxWaitMs ?? DEFAULT_WAIT_MS, 1000), MAX_WAIT_MS);
}

const JOB_STATE_OUTPUT = z.object({
  jobId: z.string(),
  tool: z.string(),
  status: z
    .enum(["pending", "running", "done", "failed", "interrupted", "cancelled"])
    .describe(
      "pending=queued, running=executing, done/failed/interrupted/cancelled=terminal. cancelled means POST /api/jobs/:id/cancel was called — not a failure.",
    ),
  stillRunning: z
    .boolean()
    .describe(
      "True while not terminal. If true after job_wait, call job_wait again with the same jobId.",
    ),
  elapsedMs: z.number().describe("Wall time so far (running) or total (terminal)."),
  idleMs: z
    .number()
    .nullable()
    .describe(
      "ms since the worker's last activity (stream event), while running; null otherwise. THE wedge signal: a large/growing idleMs during 'running' means the session may be stuck rather than working — peek at the repo (git status) instead of waiting indefinitely. A long single tool call (e.g. a slow test run) can briefly raise it legitimately, so judge by trend.",
    ),
  turns: z
    .number()
    .nullable()
    .describe("Assistant turns the worker has taken so far. Null before the first event."),
  lastAction: z
    .string()
    .nullable()
    .describe(
      "Most recent worker action, e.g. 'Edit store.ts' or 'Bash: bun test'. Null before the first event.",
    ),
  result: z
    .unknown()
    .nullable()
    .describe("The tool's structured output. Present only when status is 'done'."),
  error: z
    .string()
    .nullable()
    .describe(
      "Failure reason. Present when status is 'failed' or 'interrupted'; also set to 'cancelled by request' when status is 'cancelled'.",
    ),
});

type JobState = z.infer<typeof JOB_STATE_OUTPUT>;

function toState(view: JobView): JobState {
  return {
    jobId: view.id,
    tool: view.tool,
    status: view.status,
    stillRunning: !isTerminal(view.status),
    elapsedMs: view.elapsedMs,
    idleMs: view.idleMs,
    turns: view.progress?.turns ?? null,
    lastAction: view.progress?.lastAction ?? null,
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
      description: `Return the current state of a background job by id, without waiting. Prefer job_wait when you actually want the result — this is for a quick non-blocking peek (e.g. checking on a long review while doing other work).

OUTPUT: \`status\` (pending/running/done/failed/interrupted/cancelled) and \`stillRunning\`. While running, \`turns\`/\`lastAction\` show live worker activity and \`idleMs\` is ms since its last event — a large/growing \`idleMs\` is the wedge signal (peek at git status rather than waiting forever). When status is "done", \`result\` holds the tool's structured output; when "failed"/"interrupted"/"cancelled", \`error\` explains why. There is no MCP tool to cancel a job — that is \`POST /api/jobs/:id/cancel\` over HTTP.`,
      inputSchema: {
        jobId: z.string().describe("The job id returned by check/review."),
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
      description: `Block until a background job finishes (or the wait window elapses), then return its state. This is the normal way to consume check/review: submit → job_wait → use result.

BEHAVIOR: polls internally and sends progress heartbeats, so it is safe for long jobs. Waits ~50s per call by default; if the job is still running when the window elapses it returns \`stillRunning: true\` — call job_wait again with the same jobId (loop until stillRunning is false). You may also do other work between calls.
LONG JOBS: pass an explicit \`maxWaitMs\` to wait in ONE call instead of looping — a review (typically 5-11 min) otherwise costs ~9 round trips. Only do this if this server's \`~/.claude.json\` entry sets a \`timeout\` at least as large; without it the client aborts at 60s and the abort is a hard error, unlike the clean \`stillRunning\` the default returns.
OUTPUT: when \`status\` is "done", \`result\` holds the tool's structured output; "failed"/"interrupted"/"cancelled" set \`error\`. There is no MCP tool to cancel a job — that is \`POST /api/jobs/:id/cancel\` over HTTP.`,
      inputSchema: {
        jobId: z.string().describe("The job id returned by check/review."),
        maxWaitMs: z
          .number()
          .optional()
          .describe(
            `Max time to block this call, in ms. Default ${DEFAULT_WAIT_MS} (safe with any client), capped at ${MAX_WAIT_MS}. Values above the default require a matching \`timeout\` on this server's ~/.claude.json entry.`,
          ),
      },
      outputSchema: JOB_STATE_OUTPUT.shape,
      annotations: { readOnlyHint: true, idempotentHint: false },
    },
    async ({ jobId, maxWaitMs }, extra) => {
      if (!(await httpReachable())) return down();

      const budget = clampMaxWaitMs(maxWaitMs);
      const deadline = Date.now() + budget;
      const onProgress = mcpProgressCallback(extra);

      try {
        let view = await getJobStatus(jobId);
        if (!view) return notFound(jobId);

        let tick = 0;
        while (!isTerminal(view.status as JobStatus) && Date.now() < deadline) {
          await sleep(POLL_INTERVAL_MS);
          tick++;
          const action = view.progress?.lastAction ? ` — ${view.progress.lastAction}` : "";
          onProgress?.(
            tick,
            0,
            `Job ${view.tool} ${view.status} (${Math.round(view.elapsedMs / 1000)}s elapsed)${action}`,
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
