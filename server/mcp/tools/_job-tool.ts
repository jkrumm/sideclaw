import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JobTool } from "../../jobs/types.ts";
import { submitJob, httpReachable, HTTP_DOWN_MESSAGE } from "../job-client.ts";
import { logger } from "../logger.ts";

// Shared registration for the long-running tools (check/review).
// Each no longer executes inline — it submits a job to the HTTP server
// and returns a handle immediately. The caller then polls `job_wait`/`job_status`.
// This is what keeps a 13-minute worker run from blocking (and destabilizing) the
// MCP transport.

export const JOB_HANDLE_OUTPUT = z.object({
  jobId: z
    .string()
    .describe("Opaque job id. Pass to job_wait / job_status to retrieve the eventual result."),
  tool: z.string().describe("The tool now running as a background job."),
  status: z
    .string()
    .describe('Initial status — "pending" (queued behind the concurrency limit) or "running".'),
  message: z.string().describe("Next step for the caller."),
});

type JobHandle = z.infer<typeof JOB_HANDLE_OUTPUT>;

interface JobToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  tool: JobTool;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
}

export function registerJobSubmitTool(server: McpServer, spec: JobToolSpec): void {
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      outputSchema: JOB_HANDLE_OUTPUT.shape,
      annotations: spec.annotations ?? {},
    },
    async (args) => {
      if (!(await httpReachable())) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: HTTP_DOWN_MESSAGE }) }],
          isError: true,
        };
      }
      try {
        const job = await submitJob(spec.tool, args as Record<string, unknown>);
        const data: JobHandle = {
          jobId: job.id,
          tool: spec.tool,
          status: job.status,
          message: `Submitted as background job. Call job_wait({ jobId: "${job.id}" }) to block until it finishes and get the result, or job_status({ jobId: "${job.id}" }) for a one-shot check. This call did NOT return the result — do not treat it as the answer.`,
        };
        logger.info(
          { event: "mcp.tool.submit", tool: spec.tool, jobId: job.id, status: job.status },
          `${spec.tool} submitted`,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
          structuredContent: data,
        };
      } catch (err) {
        logger.error(
          { event: "mcp.tool.submit", tool: spec.tool, error: String(err) },
          `${spec.tool} submit failed`,
        );
        return {
          content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        };
      }
    },
  );
}
