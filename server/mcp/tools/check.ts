import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CHECK_INPUT } from "../../jobs/handlers/check.ts";
import { registerJobSubmitTool } from "./_job-tool.ts";

export function registerCheckTool(server: McpServer): void {
  registerJobSubmitTool(server, {
    name: "check",
    title: "Code Quality Check",
    tool: "check",
    inputSchema: CHECK_INPUT.shape,
    annotations: { readOnlyHint: true, idempotentHint: false },
    description: `Run all available validation steps (format, lint, typecheck, test, fallow) in a git repo. Runs as a BACKGROUND JOB: this call returns a jobId immediately — it does NOT return the pass/fail result.

WHEN TO CALL: before committing, before a PR, or when validating code quality.
ASYNC: returns { jobId }. Then call job_wait({ jobId }) to block until it finishes and read the result, or job_status for a one-shot poll. The result object has \`passed\` (check first) and \`steps[n].errors\`.
READ-ONLY: the underlying validation never modifies files.
CWD: absolute path of the repo to validate — not necessarily this session's CWD.`,
  });
}
